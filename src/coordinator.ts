import { Bot } from "grammy";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

// ── Config ──────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, "agents.yaml");
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .filter(Boolean);

// ── Load agents.yaml ────────────────────────────────────────

interface AgentConfig {
  name: string;
  id: string;
  role: string;
  dir: string;
  botTokenEnv: string;
  model: string;
  extraDisallowed: string;
  botToken: string;
}

let agentMentions: Record<string, string[]> = {};
let agentDescriptions = "";
let founderName = process.env.FOUNDER_NAME || "Founder";
const agents: AgentConfig[] = [];

try {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = parseYaml(raw);

  if (config.founder && config.founder.trim()) {
    founderName = config.founder.trim();
  }

  for (const a of config.agents || []) {
    const token = process.env[a.bot_token_env] || "";
    if (!token) {
      console.log(`  SKIP ${a.name} — ${a.bot_token_env} not set`);
      continue;
    }
    agents.push({
      name: a.name,
      id: a.id,
      role: a.role || a.id,
      dir: path.resolve(ROOT, a.dir),
      botTokenEnv: a.bot_token_env,
      model: a.model || "sonnet",
      extraDisallowed: a.extra_disallowed || "",
      botToken: token,
    });
    agentMentions[a.id] = [`@${a.id}`, `@${a.name.toLowerCase()}`];
  }

  agentDescriptions = agents
    .map(a => `${a.id} (${a.name}): ${a.role}`)
    .join("\n");
} catch (err: any) {
  console.error("Failed to load agents.yaml:", err.message);
  process.exit(1);
}

if (agents.length === 0) {
  console.error("No agents configured (check bot tokens in .env)");
  process.exit(1);
}

const routerAgent = agents[0]!;
console.log(`Router: ${routerAgent.name} (${routerAgent.id})`);

// ── Shared Directories ──────────────────────────────────────

const SHARED_DIR = path.resolve(ROOT, "agents/shared");
const INBOX_DIR = path.join(SHARED_DIR, "inbox");
const HISTORY_FILE = path.join(SHARED_DIR, "group-history.jsonl");
const COST_FILE = path.join(SHARED_DIR, "costs.jsonl");
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

// ── Cost Tracking ───────────────────────────────────────────

function logCost(agent: string, type: string, cost: number, usage: any, message: string, model: string) {
  const entry = {
    ts: Date.now(),
    agent,
    type,
    cost,
    model,
    inputTokens: usage.input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    message: message.split(/\s+/).slice(0, 10).join(" "),
  };
  try {
    fs.mkdirSync(path.dirname(COST_FILE), { recursive: true });
    fs.appendFileSync(COST_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

// ── Claude Raw (routing only) ───────────────────────────────

const claudeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.includes("BOT_TOKEN"))
);

function callClaudeRaw(
  message: string,
  cwd: string,
  model: string = "sonnet",
  opts: { costType?: string; costLabel?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", model,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--",
      message,
    ];

    const proc = spawn(CLAUDE_PATH, args, {
      cwd,
      env: claudeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => { killed = true; proc.kill("SIGTERM"); }, opts.timeoutMs)
      : null;

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) { resolve(""); return; }

      if (code === 0) {
        try {
          const json = JSON.parse(stdout.trim());
          if (opts.costType) {
            const cost = json.total_cost_usd || 0;
            const m = Object.keys(json.modelUsage || {})[0] || "unknown";
            logCost(routerAgent.name, opts.costType, cost, json.usage || {}, opts.costLabel || "", m);
          }
          resolve(json.result || "");
        } catch {
          resolve(stdout.trim());
        }
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Worker Dispatch ─────────────────────────────────────────

interface WorkerResult {
  response: string;
  tools: string[];
  cost: number;
  model: string;
}

function dispatchToWorker(agent: AgentConfig, prompt: string, rawMessage: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const workerInput = JSON.stringify({
      prompt,
      rawMessage,
      agentName: agent.name,
      agentId: agent.id,
      agentDir: agent.dir,
      agentModel: agent.model,
      disallowedTools: ["Bash(rm -rf *)", ...(agent.extraDisallowed ? agent.extraDisallowed.split(",").filter(Boolean) : [])],
      claudePath: CLAUDE_PATH,
      costFile: COST_FILE,
    });

    const proc = spawn("npx", ["tsx", path.join(__dirname, "worker.ts")], {
      cwd: ROOT,
      env: claudeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(workerInput);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch {
          resolve({ response: stdout.trim(), tools: [], cost: 0, model: "unknown" });
        }
      } else {
        reject(new Error(stderr.trim() || `worker exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

// ── Telegram Bots ───────────────────────────────────────────

interface BotInstance {
  bot: Bot;
  agent: AgentConfig;
  username: string;
  busy: boolean;
  queue: QueueItem[];
}

interface QueueItem {
  chatId: number;
  text: string;
  fromUser: string;
  fromAgent?: string;
  isGroup: boolean;
  mustRespond?: boolean;
}

const bots: Map<string, BotInstance> = new Map();

// ── Message Handler (shared by all bots) ────────────────────

function setupBot(agent: AgentConfig): BotInstance {
  const bot = new Bot(agent.botToken);
  const instance: BotInstance = {
    bot,
    agent,
    username: "",
    busy: false,
    queue: [],
  };

  bot.on("message:text", (ctx) => {
    const userId = String(ctx.from.id);
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    const fromName = ctx.from.first_name || userId;
    const isBot = ctx.from?.is_bot === true;

    if (isBot) return;

    // Access control before history
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) return;

    // Only router writes to history
    if (isGroup && agent.id === routerAgent.id) {
      appendHistory(fromName, ctx.message.text);
    }

    const textLower = ctx.message.text.toLowerCase();
    const directlyTagged = isGroup && instance.username && textLower.includes(`@${instance.username.toLowerCase()}`);
    const repliedTo = isGroup && ctx.message.reply_to_message?.from?.id === bot.botInfo.id;

    // Skip routing if another bot is targeted
    const targetsAnotherBot = isGroup && Object.values(agentMentions).some(mentions =>
      mentions.some(m => textLower.includes(m.toLowerCase()))
    ) && !directlyTagged;

    let text = ctx.message.text;
    if (instance.username) {
      text = text.replace(new RegExp(`@${instance.username}`, "gi"), "").trim();
    }

    if (!isGroup || directlyTagged || repliedTo) {
      instance.queue.push({ chatId: ctx.chat.id, text, fromUser: fromName, isGroup, mustRespond: true });
      drain(instance);
    } else if (agent.id === routerAgent.id && !targetsAnotherBot) {
      scheduleLayerCheck(ctx.chat.id);
    }
  });

  return instance;
}

// ── Routing Layer ───────────────────────────────────────────

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

  const agentIds = await evaluateConversation(recentMessages);

  if (agentIds.length === 0) {
    console.log(`  [ROUTER] No action needed`);
    return;
  }

  // Find last human message
  const agentNames = new Set(Object.values(agentMentions).flat().map(m => m.replace("@", ""))
    .concat(Object.keys(agentMentions)));
  try {
    const raw2 = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config2 = parseYaml(raw2);
    for (const a of config2.agents || []) {
      agentNames.add(a.name);
    }
  } catch {}

  let lastHumanMsg = "";
  let lastHumanFrom = "";
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8").trim();
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!agentNames.has(entry.from)) {
          lastHumanMsg = entry.text;
          lastHumanFrom = entry.from;
          break;
        }
      } catch {}
    }
  } catch {}

  if (!lastHumanMsg) return;

  for (const agentId of agentIds) {
    const instance = bots.get(agentId);
    if (instance) {
      // Direct dispatch to this bot's queue
      instance.queue.push({ chatId, text: lastHumanMsg, fromUser: lastHumanFrom, isGroup: true, mustRespond: true });
      drain(instance);
    } else {
      // Write to inbox for agents we don't manage (shouldn't happen)
      const message = { from: lastHumanFrom, fromAgentId: "router", text: lastHumanMsg, chatId, timestamp: Date.now() };
      const filename = `router-to-${agentId}-${Date.now()}.json`;
      try {
        fs.mkdirSync(INBOX_DIR, { recursive: true });
        fs.writeFileSync(path.join(INBOX_DIR, filename), JSON.stringify(message, null, 2));
        console.log(`  [ROUTER] Routed to ${agentId} (via inbox)`);
      } catch {}
    }
  }
}

async function evaluateConversation(recentMessages: string): Promise<string[]> {
  const prompt = `You are a team coordinator. The team is led by ${founderName}. Read this recent group chat and decide if any team member needs to respond.

Team members:
${agentDescriptions}

Recent conversation:
${recentMessages}

Rules:
- Reply with ONLY agent IDs (comma-separated), e.g. "engineer_devin" or "pm_sage,ux_aria"
- Reply "NONE" if the conversation is resolved or someone already answered adequately
- If the message addresses "everyone" or the whole team, route to ALL agents
- If the message asks a specific role by name (e.g. "Sage"), route to that agent
- Route to multiple agents when genuinely different expertise is needed
- When in doubt, route — it's better to give agents a chance to respond than to miss a message`;

  console.log(`  [ROUTER] Evaluating conversation (sonnet)...`);

  try {
    const response = await callClaudeRaw(prompt, routerAgent.dir, "sonnet", {
      costType: "router",
      costLabel: recentMessages.split("\n").pop() || "",
      timeoutMs: 30_000,
    });
    const lower = response.toLowerCase();
    console.log(`  [ROUTER] Raw: ${response.replace(/\n/g, " ").slice(0, 120)}`);

    const firstWord = lower.split(/[\s,]/)[0];
    if (!lower || firstWord === "none") {
      console.log(`  [ROUTER] Decision: NONE`);
      return [];
    }

    const validIds = Object.keys(agentMentions);
    const matched = validIds.filter(id => {
      const regex = new RegExp(`\\b${id.replace(/_/g, "[_ ]")}\\b`);
      return regex.test(lower);
    });
    console.log(`  [ROUTER] Decision: ${matched.join(", ") || "NONE"}`);
    return matched;
  } catch (err: any) {
    console.error(`  [ROUTER] Evaluation failed:`, err.message);
    return [];
  }
}

// ── Queue Processor ─────────────────────────────────────────

async function drain(instance: BotInstance) {
  if (instance.busy || instance.queue.length === 0) return;
  instance.busy = true;

  const msg = instance.queue.shift()!;
  const { agent, bot } = instance;
  const source = msg.fromAgent || msg.fromUser;
  console.log(`[${agent.name}] Processing: "${msg.text.slice(0, 80)}..." from ${source}`);

  const startTime = Date.now();
  let notified = false;
  const typingInterval = setInterval(() => {
    bot.api.sendChatAction(msg.chatId, "typing").catch(() => {});
    if (!notified && Date.now() - startTime > 120_000) {
      notified = true;
      bot.api.sendMessage(msg.chatId, "\u23f3 Still working on this \u2014 will reply when ready.").catch(() => {});
    }
  }, 4_000);
  bot.api.sendChatAction(msg.chatId, "typing").catch(() => {});

  try {
    const history = msg.isGroup ? getRecentHistory() : "";
    const prompt = msg.fromAgent
      ? `${history}[Message from ${msg.fromAgent} in the team chat]\n${msg.text}`
      : `${history}${msg.fromUser}: ${msg.text}`;

    // Dispatch to worker
    const result = await dispatchToWorker(agent, prompt, msg.text);
    clearInterval(typingInterval);

    const { response } = result;

    if (!response.trim() || (!msg.mustRespond && /^(SKIP|PASS|N\/A|nothing to add)/i.test(response.trim()))) {
      if (msg.mustRespond && !response.trim()) {
        await bot.api.sendMessage(msg.chatId, "(no response)");
      } else {
        console.log(`  \u2192 No response needed`);
      }
    } else {
      appendHistory(agent.name, response.slice(0, 500));

      for (const chunk of splitMessage(response)) {
        const html = markdownToTelegramHtml(chunk);
        try {
          await bot.api.sendMessage(msg.chatId, html, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(msg.chatId, chunk);
        }
      }

      // Forward @mentions to other agents
      forwardToMentionedAgents(instance, response, msg.chatId);
    }
  } catch (err: any) {
    clearInterval(typingInterval);
    const errMsg = err.message?.slice(0, 500) || "Unknown error";
    await bot.api.sendMessage(msg.chatId, `Error: ${errMsg}`);
    console.error(`[${agent.name}] Error:`, err.message);
  }

  instance.busy = false;
  drain(instance);
}

// ── Cross-Agent Messaging ───────────────────────────────────

function forwardToMentionedAgents(source: BotInstance, response: string, chatId: number) {
  const lower = response.toLowerCase();

  for (const [agentId, mentions] of Object.entries(agentMentions)) {
    if (agentId === source.agent.id) continue;
    if (!mentions.some((m) => lower.includes(m))) continue;

    const target = bots.get(agentId);
    if (target) {
      // Direct dispatch — no inbox needed
      target.queue.push({
        chatId,
        text: response,
        fromUser: source.agent.name,
        fromAgent: source.agent.name,
        isGroup: true,
        mustRespond: true,
      });
      drain(target);
      console.log(`  \u2192 Forwarded to ${agentId} (direct)`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

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
    .replace(/^-{3,}$/gm, "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500")
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

console.log(`Claude Crew Coordinator`);
console.log(`  Agents: ${agents.map(a => `${a.name} (${a.id})`).join(", ")}`);
console.log(`  Router: ${routerAgent.name} (${routerAgent.id})`);
console.log(`  Allowed users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "all"}`);
console.log("");

// Start all bots
for (const agent of agents) {
  const instance = setupBot(agent);
  bots.set(agent.id, instance);

  await instance.bot.api.deleteWebhook({ drop_pending_updates: true });
  await instance.bot.api.raw.getUpdates({ offset: -1, limit: 1, timeout: 0 }).catch(() => {});

  const me = await instance.bot.api.getMe();
  instance.username = me.username || "";
  console.log(`  ${agent.name}: @${instance.username} [${agent.model}]`);

  instance.bot.start({
    onStart: () => console.log(`  ${agent.name} listening...`),
  });
}

console.log("");
console.log("All agents online.");
