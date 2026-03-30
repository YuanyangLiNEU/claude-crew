import { Bot } from "grammy";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

// ── Load Config ─────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const AGENT_NAME = process.env.AGENT_NAME || "agent";
const AGENT_ID = process.env.AGENT_ID || "agent";
const AGENT_DIR = process.env.AGENT_DIR
  ? path.resolve(process.env.AGENT_DIR)
  : ROOT;

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .filter(Boolean);

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

const EXTRA_DISALLOWED = (process.env.EXTRA_DISALLOWED_TOOLS || "")
  .split(",")
  .filter(Boolean);

// Only one agent writes to group-history.jsonl AND handles routing
const ROUTER_AGENT = process.env.ROUTER_AGENT || "";
const IS_ROUTER = AGENT_ID === ROUTER_AGENT;

// ── Load agents.yaml ────────────────────────────────────────

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, "agents.yaml");

let agentMentions: Record<string, string[]> = {};
let agentDescriptions = "";
let founderName = process.env.FOUNDER_NAME || "Founder";

try {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = parseYaml(raw);

  if (config.founder && config.founder.trim()) {
    founderName = config.founder.trim();
  }

  for (const agent of config.agents || []) {
    agentMentions[agent.id] = [`@${agent.id}`, `@${agent.name.toLowerCase()}`];
  }

  agentDescriptions = (config.agents || [])
    .map((a: any) => `${a.id} (${a.name}): ${a.role || a.id}`)
    .join("\n");
} catch {
  console.warn("Could not load agents.yaml — cross-agent messaging and routing disabled");
}

// ── Shared Directories ──────────────────────────────────────

const SHARED_DIR = path.resolve(ROOT, "agents/shared");
const INBOX_DIR = path.join(SHARED_DIR, "inbox");
const HISTORY_FILE = path.join(SHARED_DIR, "group-history.jsonl");
const MAX_HISTORY = 20;

// ── Group Chat History ──────────────────────────────────────

interface HistoryEntry {
  ts: number;
  from: string;
  text: string;
}

function appendHistory(from: string, text: string) {
  const entry: HistoryEntry = { ts: Date.now(), from, text };
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
    const lines = fs.readFileSync(HISTORY_FILE, "utf-8").trim().split("\n");
    if (lines.length > MAX_HISTORY * 2) {
      fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_HISTORY).join("\n") + "\n");
    }
  } catch {}
}

function getRecentHistory(): string {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8").trim();
    if (!raw) return "";
    const lines = raw.split("\n").slice(-MAX_HISTORY);
    const entries: HistoryEntry[] = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (entries.length === 0) return "";
    const formatted = entries
      .map((e) => `${e.from}: ${e.text.slice(0, 300)}`)
      .join("\n");
    return `[Recent group chat — for context only, respond to the last message]\n${formatted}\n---\n`;
  } catch {
    return "";
  }
}

// ── Telegram Bot ────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);
let botUsername = "";

let busy = false;
const queue: Array<{
  chatId: number;
  text: string;
  fromUser: string;
  fromAgent?: string;
  isGroup: boolean;
  mustRespond?: boolean;
}> = [];

bot.on("message:text", (ctx) => {
  const userId = String(ctx.from.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const fromName = ctx.from.first_name || userId;
  const isBot = ctx.from?.is_bot === true;

  // Log ALL group messages to history (router agent only — both human and bot)
  if (isGroup && IS_ROUTER) {
    appendHistory(fromName, ctx.message.text);
  }

  // Bot messages: log to history but don't process or route — prevents infinite loops
  // Bot-to-bot handoff happens through @mentions in responses, not the routing layer
  if (isBot) {
    return;
  }

  // Access control
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    return;
  }

  // Check if directly tagged
  const textLower = ctx.message.text.toLowerCase();
  const directlyTagged = isGroup && botUsername && textLower.includes(`@${botUsername.toLowerCase()}`);
  const repliedTo = isGroup && ctx.message.reply_to_message?.from?.id === bot.botInfo.id;

  // Strip bot @mention from message
  let text = ctx.message.text;
  if (botUsername) {
    text = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
  }

  if (!isGroup || directlyTagged || repliedTo) {
    // DM or directly tagged — this agent must respond
    queue.push({ chatId: ctx.chat.id, text, fromUser: fromName, isGroup, mustRespond: true });
    drain();
  } else if (IS_ROUTER) {
    // Non-tagged group message — schedule the routing layer
    scheduleLayerCheck(ctx.chat.id);
  }
});

// ── Conversation-Aware Routing Layer (router agent only) ────

let lastLayerCheckTs = 0;
let pendingGroupChatId: number | null = null;
const LAYER_DEBOUNCE_MS = 1_000;
let layerTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLayerCheck(chatId: number) {
  pendingGroupChatId = chatId;
  if (layerTimer) clearTimeout(layerTimer);
  layerTimer = setTimeout(() => runLayer(), LAYER_DEBOUNCE_MS);
}

async function runLayer() {
  layerTimer = null;
  if (!pendingGroupChatId) return;

  const chatId = pendingGroupChatId;

  let recentMessages = "";
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8").trim();
    if (!raw) return;
    const lines = raw.split("\n").slice(-15);
    const entries: HistoryEntry[] = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (entries.length === 0) return;

    const newEntries = lastLayerCheckTs > 0
      ? entries.filter(e => e.ts > lastLayerCheckTs)
      : entries.slice(-5);

    if (newEntries.length === 0) return;

    recentMessages = entries
      .map((e) => `${e.from}: ${e.text.slice(0, 200)}`)
      .join("\n");
  } catch {
    return;
  }

  lastLayerCheckTs = Date.now();

  const agents = await evaluateConversation(recentMessages);

  if (agents.length === 0) {
    console.log(`  [ROUTER] No action needed`);
    return;
  }

  // Get the last human message
  let lastHumanMsg = "";
  let lastHumanFrom = "";
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8").trim();
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!entry.from.includes("(")) {
          lastHumanMsg = entry.text;
          lastHumanFrom = entry.from;
          break;
        }
      } catch {}
    }
  } catch {}

  if (!lastHumanMsg) return;

  for (const agentId of agents) {
    if (agentId === AGENT_ID) {
      queue.push({ chatId, text: lastHumanMsg, fromUser: lastHumanFrom, isGroup: true, mustRespond: true });
      drain();
    } else {
      const message = {
        from: lastHumanFrom,
        fromAgentId: "router",
        text: lastHumanMsg,
        chatId,
        timestamp: Date.now(),
      };
      const filename = `router-to-${agentId}-${Date.now()}.json`;
      const filepath = path.join(INBOX_DIR, filename);
      try {
        fs.mkdirSync(INBOX_DIR, { recursive: true });
        fs.writeFileSync(filepath, JSON.stringify(message, null, 2));
        console.log(`  [ROUTER] Routed to ${agentId}`);
      } catch (err: any) {
        console.error(`  [ROUTER] Failed to route to ${agentId}:`, err.message);
      }
    }
  }
}

function evaluateConversation(recentMessages: string): Promise<string[]> {
  return new Promise((resolve) => {
    const prompt = `You are a team coordinator. The team is led by ${founderName}. Read this recent group chat and decide if any team member needs to respond.

Team members:
${agentDescriptions}

Recent conversation:
${recentMessages}

Rules:
- Reply with ONLY agent IDs (comma-separated), e.g. "engineer_devin" or "pm_sage,ux_aria"
- Reply "NONE" if:
  - The conversation is resolved or just casual chat
  - It's a general question anyone could answer (let humans handle it)
  - Someone already answered adequately
- Only route when a message clearly needs a SPECIFIC role's expertise
- Prefer routing to ONE agent. Route to multiple only when genuinely different expertise is needed
- When in doubt, reply "NONE" — it's better to not route than to over-route`;

    const args = [
      "-p",
      "--model", "sonnet",
      "--output-format", "text",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--",
      prompt,
    ];

    console.log(`  [ROUTER] Evaluating conversation (sonnet)...`);

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: AGENT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve([]);
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const result = stdout.trim().toUpperCase();
      if (code !== 0 || result === "NONE" || !result) {
        resolve([]);
        return;
      }
      const agents = result.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      console.log(`  [ROUTER] Decision: ${agents.join(", ") || "NONE"}`);
      resolve(agents);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

// ── Queue Processor ─────────────────────────────────────────

async function drain() {
  if (busy || queue.length === 0) return;
  busy = true;

  const msg = queue.shift()!;
  const source = msg.fromAgent || msg.fromUser;
  console.log(`[AGENT] [${AGENT_NAME}] Processing: "${msg.text.slice(0, 80)}..." from ${source}`);

  const startTime = Date.now();
  let notified = false;
  const typingInterval = setInterval(() => {
    bot.api.sendChatAction(msg.chatId, "typing").catch(() => {});
    if (!notified && Date.now() - startTime > 120_000) {
      notified = true;
      bot.api.sendMessage(msg.chatId, "⏳ Still working on this — will reply when ready.").catch(() => {});
    }
  }, 4_000);
  bot.api.sendChatAction(msg.chatId, "typing").catch(() => {});

  try {
    const history = msg.isGroup ? getRecentHistory() : "";
    const prompt = msg.fromAgent
      ? `${history}[Message from ${msg.fromAgent} in the team chat]\n${msg.text}`
      : `${history}${msg.fromUser}: ${msg.text}`;

    const response = await callClaude(prompt, AGENT_DIR);
    clearInterval(typingInterval);

    // If agent has nothing to say on a non-mandatory message, stay silent
    if (!response.trim() || (!msg.mustRespond && /^(SKIP|PASS|N\/A|nothing to add)/i.test(response.trim()))) {
      if (msg.mustRespond && !response.trim()) {
        await bot.api.sendMessage(msg.chatId, "(no response)");
      } else {
        console.log(`  → No response needed`);
      }
    } else {
      for (const chunk of splitMessage(response)) {
        const html = markdownToTelegramHtml(chunk);
        try {
          await bot.api.sendMessage(msg.chatId, html, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(msg.chatId, chunk);
        }
      }

      // Only forward @mentions if human-initiated (prevents cascades)
      if (msg.mustRespond) {
        forwardToMentionedAgents(response, msg.chatId);
      }
    }
  } catch (err: any) {
    clearInterval(typingInterval);
    const errMsg = err.message?.slice(0, 500) || "Unknown error";
    await bot.api.sendMessage(msg.chatId, `Error: ${errMsg}`);
    console.error(`[AGENT] [${AGENT_NAME}] Error:`, err.message);
  }

  busy = false;
  drain();
}

// ── Cross-Agent Messaging ───────────────────────────────────

function forwardToMentionedAgents(response: string, chatId: number) {
  const lower = response.toLowerCase();

  for (const [agentId, mentions] of Object.entries(agentMentions)) {
    if (agentId === AGENT_ID) continue;
    if (!mentions.some((m) => lower.includes(m))) continue;

    const message = {
      from: AGENT_NAME,
      fromAgentId: AGENT_ID,
      text: response,
      chatId,
      timestamp: Date.now(),
    };

    const filename = `${AGENT_ID}-to-${agentId}-${Date.now()}.json`;
    const filepath = path.join(INBOX_DIR, filename);

    try {
      fs.mkdirSync(INBOX_DIR, { recursive: true });
      fs.writeFileSync(filepath, JSON.stringify(message, null, 2));
      console.log(`  → Forwarded to ${agentId}`);
    } catch (err: any) {
      console.error(`  → Failed to forward to ${agentId}:`, err.message);
    }
  }
}

function watchInbox() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });

  setInterval(() => {
    try {
      const files = fs.readdirSync(INBOX_DIR)
        .filter((f) => f.includes(`-to-${AGENT_ID}-`) && f.endsWith(".json"))
        .sort();

      for (const file of files) {
        const filepath = path.join(INBOX_DIR, file);
        try {
          const raw = fs.readFileSync(filepath, "utf-8");
          const msg = JSON.parse(raw);

          fs.unlinkSync(filepath);

          console.log(`[AGENT] [${AGENT_NAME}] Inbox: message from ${msg.from}`);

          const isFromRouter = msg.fromAgentId === "router";
          queue.push({
            chatId: msg.chatId,
            text: msg.text,
            fromUser: msg.from,
            fromAgent: isFromRouter ? undefined : msg.from,
            isGroup: true,
            mustRespond: !isFromRouter,
          });

          drain();
        } catch (err: any) {
          console.error(`  → Failed to process inbox file ${file}:`, err.message);
          try { fs.unlinkSync(filepath); } catch {}
        }
      }
    } catch {}
  }, 1_000);
}

// ── Claude Code CLI ─────────────────────────────────────────

function callClaude(message: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const disallowed = ["Bash(rm -rf *)", ...EXTRA_DISALLOWED];

    const args = [
      "-p",
      "--continue",
      "--output-format", "text",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []),
      "--",
      message,
    ];

    console.log(`  → claude -p --continue (cwd: ${path.basename(cwd)})`);

    const proc = spawn(CLAUDE_PATH, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

// ── Markdown → Telegram HTML ────────────────────────────────

function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = codeBlocks.length;
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const langAttr = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return `%%CODEBLOCK_${i}%%`;
  });

  result = result.replace(/`([^`]+)`/g, (_m, code) => {
    const i = inlineCodes.length;
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    inlineCodes.push(`<code>${escaped}</code>`);
    return `%%INLINE_${i}%%`;
  });

  result = result
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  result = result
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<i>$1</i>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^(?:&gt;) (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/<\/blockquote>\n<blockquote>/g, "\n")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^-{3,}$/gm, "────────────────")
    .replace(/^\|[-| :]+\|$/gm, "");

  result = result.replace(/%%CODEBLOCK_(\d+)%%/g, (_m, i) => codeBlocks[Number(i)]);
  result = result.replace(/%%INLINE_(\d+)%%/g, (_m, i) => inlineCodes[Number(i)]);

  return result;
}

function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── Start ───────────────────────────────────────────────────

console.log(`Claude Crew Agent: ${AGENT_NAME}`);
console.log(`  Agent ID: ${AGENT_ID}`);
console.log(`  Agent dir: ${AGENT_DIR}`);
console.log(`  Router: ${IS_ROUTER ? "YES" : "no"}`);
console.log(`  Allowed users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "all"}`);
console.log("");

await bot.api.deleteWebhook({ drop_pending_updates: true });

const me = await bot.api.getMe();
botUsername = me.username || "";
console.log(`  Bot: @${botUsername}`);

watchInbox();

bot.start({
  onStart: () => console.log(`${AGENT_NAME} listening...`),
});
