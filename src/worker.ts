/**
 * Worker — handles a single agent request.
 * Spawned by the coordinator per message. Reads input from stdin, writes result to stdout.
 *
 * Input (JSON on stdin):
 *   { prompt, rawMessage, agentName, agentId, agentDir, agentModel, disallowedTools, claudePath, costFile }
 *
 * Output (JSON on stdout):
 *   { response, tools, cost, model }
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── Read input from stdin ───────────────────────────────────

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
const {
  prompt,
  rawMessage,
  agentName,
  agentId,
  agentDir,
  agentModel,
  disallowedTools,
  claudePath,
  costFile,
} = input;

// ── Per-Agent Memory ────────────────────────────────────────

const MEMORY_FILE = path.join(agentDir, "memory.md");
const MEMORY_LOG = path.join(agentDir, "memory.log");
const COMPACT_TRIGGER_BYTES = 16_000;
const MEMORY_MD_CAP_BYTES = 32_000;
const MEMORY_LOG_CAP_BYTES = 32_000;

function tryReadFile(p: string): string {
  try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}

function tryGetFileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function readMemory(): string {
  const memory = tryReadFile(MEMORY_FILE).trim();
  if (memory) {
    return `[Your prior work — use as context, re-read files if you need current contents]\n${memory}\n---\n`;
  }

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
    fs.mkdirSync(path.dirname(costFile), { recursive: true });
    fs.appendFileSync(costFile, JSON.stringify(entry) + "\n");
  } catch {}
}

// ── Claude Call ─────────────────────────────────────────────

function callClaudeRaw(message: string, cwd: string, model: string): Promise<string> {
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

    const proc = spawn(claudePath, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim()).result || ""); } catch { resolve(stdout.trim()); }
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

async function compactMemoryIfNeeded(): Promise<void> {
  const logSize = tryGetFileSize(MEMORY_LOG);
  if (logSize < COMPACT_TRIGGER_BYTES) return;

  const logRaw = tryReadFile(MEMORY_LOG).trim();
  if (!logRaw) return;

  const lines = logRaw.split("\n");
  const existingMemory = tryReadFile(MEMORY_FILE).trim();

  const compactPrompt = `You are summarizing an AI agent's recent work for future context. Be concise but preserve important details.

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
    const summary = await callClaudeRaw(compactPrompt, agentDir, "haiku");
    if (summary.trim()) {
      let finalMemory = summary.trim();
      if (finalMemory.length > MEMORY_MD_CAP_BYTES) {
        finalMemory = finalMemory.slice(-MEMORY_MD_CAP_BYTES);
      }
      fs.writeFileSync(MEMORY_FILE, finalMemory + "\n");

      const currentLog = tryReadFile(MEMORY_LOG).trim();
      const currentLines = currentLog ? currentLog.split("\n") : [];
      const remaining = currentLines.slice(lines.length);
      fs.writeFileSync(MEMORY_LOG, remaining.length ? remaining.join("\n") + "\n" : "");
    }
  } catch {
    if (logSize > MEMORY_LOG_CAP_BYTES) {
      const trimmed = logRaw.slice(-MEMORY_LOG_CAP_BYTES);
      const firstNewline = trimmed.indexOf("\n");
      fs.writeFileSync(MEMORY_LOG, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed);
    }
  }
}

// ── Main: Call Claude with memory ───────────────────────────

const memory = readMemory();
const fullPrompt = `${memory}${prompt}`;

const args = [
  "-p",
  "--verbose",
  "--model", agentModel,
  "--output-format", "json",
  "--dangerously-skip-permissions",
  "--strict-mcp-config",
  ...(disallowedTools.length ? ["--disallowedTools", ...disallowedTools] : []),
  "--",
  fullPrompt,
];

const proc = spawn(claudePath, args, {
  cwd: agentDir,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

proc.on("close", async (code) => {
  if (code !== 0) {
    process.stderr.write(stderr || `claude exited with code ${code}`);
    process.exit(1);
  }

  try {
    const msgs = JSON.parse(stdout.trim());

    // Extract tool actions and response
    const tools: string[] = [];
    let response = "";
    let cost = 0;
    let model = "unknown";

    for (const m of msgs) {
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === "tool_use") {
            const inp = c.input || {};
            const arg = inp.file_path || inp.command?.slice(0, 80) || inp.pattern || inp.query || "";
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

    // Log cost
    logCost(agentName, "agent", cost, msgs.find((m: any) => m.type === "result")?.usage || {}, rawMessage, model);

    // Update memory
    appendToMemoryLog(tools);
    await compactMemoryIfNeeded();

    // Write result to stdout
    const result = JSON.stringify({ response, tools, cost, model });
    process.stdout.write(result);
  } catch {
    process.stdout.write(JSON.stringify({ response: stdout.trim(), tools: [], cost: 0, model: "unknown" }));
  }
});
