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

const AGENT_MODEL = process.env.AGENT_MODEL || "sonnet";

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

// ── Per-Agent Memory ────────────────────────────────────────
//
// Each agent call has ~17K tokens of fixed overhead:
//   - Claude Code system prompt (static prefix):  ~11K tokens (cache read, cheap)
//   - Claude Code dynamic sections (env, tools):   ~6K tokens (cache creation, paid every call)
// On top of that, each call includes:
//   - Group chat history (last 20 msgs):            ~1-3K tokens (capped)
//   - Agent memory (memory.md):                     up to 8K tokens (capped below)
//   - User message:                                 ~200 tokens
// Total per call: ~20-25K tokens, leaving ~175K for actual tool use on Sonnet's 200K window.
//
// Memory sizing rationale:
//   - memory.log stores tool actions only (not chat text — that's in group-history.jsonl)
//   - One record ≈ 75 tokens for a medium investigation (~10 tool calls)
//   - Compact trigger at 16KB (~4K tokens) = ~53 medium investigations or ~20 heavy refactors
//   - memory.md capped at 32KB (~8K tokens) — enough for rich work history, small vs context window
//   - Hard cap on memory.log at 32KB if compaction fails — prevents unbounded growth
//   - Compaction uses Haiku (~$0.01/call) to summarize log into memory.md
//
// Reference: Claude Code's own SessionMemory caps at 12K tokens total with 2K per section.
// We use 8K since we only store tool actions, not full conversation context.

const MEMORY_FILE = path.join(AGENT_DIR, "memory.md");
const MEMORY_LOG = path.join(AGENT_DIR, "memory.log");
const COMPACT_TRIGGER_BYTES = 16_000;   // ~4K tokens — trigger compaction
const MEMORY_MD_CAP_BYTES = 32_000;     // ~8K tokens — max size of compacted summary
const MEMORY_LOG_CAP_BYTES = 32_000;    // ~8K tokens — hard cap if compaction fails

function readMemory(): string {
  const memory = tryReadFile(MEMORY_FILE).trim();
  if (memory) {
    return `[Your prior work — use as context, re-read files if you need current contents]\n${memory}\n---\n`;
  }

  // No compacted memory yet — fall back to raw log for early conversations
  const logRaw = tryReadFile(MEMORY_LOG).trim();
  if (!logRaw) return "";

  const lines = logRaw.split("\n");
  const formatted = lines.map(l => {
    try {
      const e = JSON.parse(l);
      return e.tools?.length ? `Tools: ${e.tools.join(", ")}` : null;
    } catch { return null; }
  }).filter(Boolean).join("\n");

  return formatted ? `[Recent actions — for context]\n${formatted}\n---\n` : "";
}

function appendToMemoryLog(tools: string[]) {
  if (tools.length === 0) return;
  const entry = { ts: Date.now(), tools };
  try {
    fs.writeFileSync(MEMORY_LOG, (tryReadFile(MEMORY_LOG) || "") + JSON.stringify(entry) + "\n");
  } catch {}
}

function tryReadFile(p: string): string {
  try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}

function tryGetFileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

async function compactMemoryIfNeeded(): Promise<void> {
  const logSize = tryGetFileSize(MEMORY_LOG);
  if (logSize < COMPACT_TRIGGER_BYTES) return;

  const logRaw = tryReadFile(MEMORY_LOG).trim();
  if (!logRaw) return;

  const lines = logRaw.split("\n");
  const existingMemory = tryReadFile(MEMORY_FILE).trim();

  const prompt = `You are summarizing an AI agent's recent work for future context. Be concise but preserve important details.

${existingMemory ? `## Existing memory\n${existingMemory}\n` : ""}
## Recent tool actions (oldest first)
${lines.map(l => {
    try {
      const e = JSON.parse(l);
      return e.tools?.length ? `- ${e.tools.join(", ")}` : null;
    } catch { return null; }
  }).filter(Boolean).join("\n")}

Write an updated memory summary that merges the existing memory with recent tool actions. Include:
1. What was done — which files were read, edited, created
2. Commands run and their purpose
3. Patterns: what the agent has been working on
4. Pending work or open questions

Keep it under 1500 words. Write in past tense. No preamble — start directly with the summary.`;

  try {
    console.log(`  [MEMORY] Compacting memory for ${AGENT_NAME} (log: ${(logSize / 1024).toFixed(1)}KB)...`);
    const summary = await callClaudeRaw(prompt, AGENT_DIR, "haiku");
    if (summary.trim()) {
      // Cap memory.md — keep the tail (most recent work) if over limit
      let finalMemory = summary.trim();
      if (finalMemory.length > MEMORY_MD_CAP_BYTES) {
        finalMemory = finalMemory.slice(-MEMORY_MD_CAP_BYTES);
      }
      fs.writeFileSync(MEMORY_FILE, finalMemory + "\n");

      // Only clear the lines we actually summarized — new entries may have arrived
      const currentLog = tryReadFile(MEMORY_LOG).trim();
      const currentLines = currentLog ? currentLog.split("\n") : [];
      const remaining = currentLines.slice(lines.length);
      fs.writeFileSync(MEMORY_LOG, remaining.length ? remaining.join("\n") + "\n" : "");
      console.log(`  [MEMORY] Compacted → memory.md: ${(finalMemory.length / 1024).toFixed(1)}KB`);
    }
  } catch (err: any) {
    console.error(`  [MEMORY] Compaction failed:`, err.message);
    // Hard cap: trim log to prevent unbounded growth if compaction keeps failing
    if (logSize > MEMORY_LOG_CAP_BYTES) {
      const trimmed = logRaw.slice(-MEMORY_LOG_CAP_BYTES);
      const firstNewline = trimmed.indexOf("\n");
      fs.writeFileSync(MEMORY_LOG, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed);
      console.log(`  [MEMORY] Log trimmed to ${(MEMORY_LOG_CAP_BYTES / 1024).toFixed(0)}KB`);
    }
  }
}

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

  // Bot messages: don't process or route. Each agent logs its own response when sending.
  if (isBot) {
    return;
  }

  // Access control — check BEFORE logging to history so unauthorized users
  // don't influence routing context
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    return;
  }

  // Log human group messages to history (router agent only)
  if (isGroup && IS_ROUTER) {
    appendHistory(fromName, ctx.message.text);
  }

  // Check if directly tagged
  const textLower = ctx.message.text.toLowerCase();
  const directlyTagged = isGroup && botUsername && textLower.includes(`@${botUsername.toLowerCase()}`);
  const repliedTo = isGroup && ctx.message.reply_to_message?.from?.id === bot.botInfo.id;

  // Check if message targets a DIFFERENT bot (any @bot_username that isn't ours)
  const targetsAnotherBot = isGroup && Object.values(agentMentions).some(mentions =>
    mentions.some(m => textLower.includes(m.toLowerCase()))
  ) && !directlyTagged;

  // Strip bot @mention from message
  let text = ctx.message.text;
  if (botUsername) {
    text = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
  }

  if (!isGroup || directlyTagged || repliedTo) {
    // DM or directly tagged — this agent must respond
    queue.push({ chatId: ctx.chat.id, text, fromUser: fromName, isGroup, mustRespond: true });
    drain();
  } else if (IS_ROUTER && !targetsAnotherBot) {
    // Non-tagged group message — schedule the routing layer
    // Skip if another bot is explicitly @mentioned (that bot handles it directly)
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

  // Get the last human message (not from any agent)
  const agentNames = new Set(Object.values(agentMentions).flat().map(m => m.replace("@", ""))
    .concat(Object.keys(agentMentions)));
  // Also add display names from agents.yaml
  try {
    const raw2 = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config2 = parseYaml(raw2);
    for (const a of config2.agents || []) {
      agentNames.add(a.name);
      agentNames.add(AGENT_NAME); // current agent's display name
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
    const response = await callClaudeRaw(prompt, AGENT_DIR, "sonnet", {
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
    const memory = readMemory();
    const history = msg.isGroup ? getRecentHistory() : "";
    const prompt = msg.fromAgent
      ? `${memory}${history}[Message from ${msg.fromAgent} in the team chat]\n${msg.text}`
      : `${memory}${history}${msg.fromUser}: ${msg.text}`;

    const { response, tools } = await callClaude(prompt, AGENT_DIR, msg.text);
    clearInterval(typingInterval);

    // Log tool actions and compact memory if needed
    appendToMemoryLog(tools);
    compactMemoryIfNeeded().catch(() => {});

    // If agent has nothing to say on a non-mandatory message, stay silent
    if (!response.trim() || (!msg.mustRespond && /^(SKIP|PASS|N\/A|nothing to add)/i.test(response.trim()))) {
      if (msg.mustRespond && !response.trim()) {
        await bot.api.sendMessage(msg.chatId, "(no response)");
      } else {
        console.log(`  → No response needed`);
      }
    } else {
      // Every agent logs its own response to history (bot messages aren't visible to other bots in Telegram)
      appendHistory(AGENT_NAME, response.slice(0, 500));

      for (const chunk of splitMessage(response)) {
        const html = markdownToTelegramHtml(chunk);
        try {
          await bot.api.sendMessage(msg.chatId, html, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(msg.chatId, chunk);
        }
      }

      // Forward @mentions to other agents
      forwardToMentionedAgents(response, msg.chatId);
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

// ── Cost Tracking ───────────────────────────────────────────

const COST_FILE = path.join(SHARED_DIR, "costs.jsonl");

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

// ── Claude Code CLI ─────────────────────────────────────────

// Env for spawned Claude processes — strip bot token so Claude's Telegram MCP plugin
// doesn't start a competing getUpdates poll with the same token.
const claudeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "TELEGRAM_BOT_TOKEN")
);

/** Light Claude call — no session persistence. Used for compaction and routing. */
function callClaudeRaw(
  message: string,
  cwd: string,
  model: string = AGENT_MODEL,
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
            logCost(AGENT_NAME, opts.costType, cost, json.usage || {}, opts.costLabel || "", m);
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

interface ClaudeResult {
  response: string;
  tools: string[];
}

function callClaude(message: string, cwd: string, rawMessage?: string): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const disallowed = ["Bash(rm -rf *)", ...EXTRA_DISALLOWED];

    const args = [
      "-p",
      "--verbose",
      "--model", AGENT_MODEL,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []),
      "--",
      message,
    ];

    console.log(`  → claude -p --verbose (cwd: ${path.basename(cwd)})`);

    const proc = spawn(CLAUDE_PATH, args, {
      cwd,
      env: claudeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const msgs = JSON.parse(stdout.trim());

          // Extract tool actions from the message array
          const tools: string[] = [];
          let response = "";
          let cost = 0;
          let model = "unknown";

          for (const m of msgs) {
            if (m.type === "assistant" && Array.isArray(m.message?.content)) {
              for (const c of m.message.content) {
                if (c.type === "tool_use") {
                  const input = c.input || {};
                  // Compact representation: Tool(key_arg)
                  const arg = input.file_path || input.command?.slice(0, 80) || input.pattern || input.query || "";
                  tools.push(arg ? `${c.name}(${arg})` : c.name);
                }
              }
            }
            if (m.type === "result") {
              response = m.result || "";
              cost = m.total_cost_usd || 0;
              model = Object.keys(m.modelUsage || {})[0] || "unknown";
            }
          }

          console.log(`  → Cost: $${cost.toFixed(4)} | ${model} | ${tools.length} tool calls`);
          logCost(AGENT_NAME, "agent", cost, msgs.find((m: any) => m.type === "result")?.usage || {}, rawMessage || message, model);
          resolve({ response, tools });
        } catch {
          resolve({ response: stdout.trim(), tools: [] });
        }
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on("error", reject);
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
console.log(`  Model: ${AGENT_MODEL}`);
console.log(`  Agent dir: ${AGENT_DIR}`);
console.log(`  Router: ${IS_ROUTER ? "YES" : "no"}`);
console.log(`  Allowed users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "all"}`);
console.log("");

await bot.api.deleteWebhook({ drop_pending_updates: true });
// Flush any stale long-poll from a previous process (Telegram holds it for up to 30s)
await bot.api.raw.getUpdates({ offset: -1, limit: 1, timeout: 0 }).catch(() => {});

const me = await bot.api.getMe();
botUsername = me.username || "";
console.log(`  Bot: @${botUsername}`);

watchInbox();

bot.start({
  onStart: () => console.log(`${AGENT_NAME} listening...`),
});
