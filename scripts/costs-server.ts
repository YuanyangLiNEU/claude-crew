#!/usr/bin/env tsx
/**
 * Cost Dashboard — lightweight local web server for viewing agent costs.
 * Usage: npx tsx scripts/costs-server.ts [port]
 *   or:  npm run costs
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COST_FILE = path.resolve(__dirname, "../agents/shared/costs.jsonl");
const PORT = parseInt(process.argv[2] || "3100", 10);

interface CostEntry {
  ts: number;
  agent: string;
  type: string;
  cost: number;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens: number;
  model?: string;
  message: string;
}

function loadCosts(): CostEntry[] {
  try {
    const raw = fs.readFileSync(COST_FILE, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortModel(model?: string): string {
  if (!model) return "?";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model.split("-").slice(1, 2)[0] || model;
}

function formatInput(e: CostEntry): string {
  const input = e.inputTokens || 0;
  const cacheRead = e.cacheReadTokens || 0;
  const cacheCreate = e.cacheCreationTokens || 0;
  const parts: string[] = [];
  if (cacheRead > 0) parts.push(`<span class="t-read">${cacheRead.toLocaleString()}</span>`);
  if (cacheCreate > 0) parts.push(`<span class="t-write">${cacheCreate.toLocaleString()}</span>`);
  if (input > 0) parts.push(`<span class="t-new">${input.toLocaleString()}</span>`);
  return parts.join('<span class="t-sep"> / </span>') || "0";
}

function buildPage(): string {
  const entries = loadCosts();

  const byAgent: Record<string, CostEntry[]> = {};
  const routerEntries: CostEntry[] = [];

  for (const e of entries) {
    if (e.type === "router") {
      routerEntries.push(e);
    } else {
      if (!byAgent[e.agent]) byAgent[e.agent] = [];
      byAgent[e.agent].push(e);
    }
  }

  const grandTotal = entries.reduce((s, e) => s + e.cost, 0);
  const agentTotal = entries.filter((e) => e.type === "agent").reduce((s, e) => s + e.cost, 0);
  const routerTotal = routerEntries.reduce((s, e) => s + e.cost, 0);

  const agentSections = Object.entries(byAgent)
    .sort((a, b) => b[1].reduce((s, e) => s + e.cost, 0) - a[1].reduce((s, e) => s + e.cost, 0))
    .map(([agent, msgs]) => {
      const total = msgs.reduce((s, e) => s + e.cost, 0);
      const rows = msgs
        .map((m) => {
          const time = new Date(m.ts).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          });
          return `<tr>
            <td class="time">${time}</td>
            <td class="model">${shortModel(m.model)}</td>
            <td class="msg">${escHtml(m.message)}</td>
            <td class="tokens">${formatInput(m)}</td>
            <td class="tokens">${(m.outputTokens || 0).toLocaleString()}</td>
            <td class="cost">$${m.cost.toFixed(4)}</td>
          </tr>`;
        })
        .join("");
      return `
        <div class="agent-section">
          <h3>${escHtml(agent)} <span class="agent-total">$${total.toFixed(4)} · ${msgs.length} calls</span></h3>
          <table>
            <thead><tr><th>Time</th><th>Model</th><th>Message</th><th>In tokens</th><th>Out tokens</th><th>Cost</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join("");

  const routerRows = routerEntries
    .map((r) => {
      const time = new Date(r.ts).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      return `<tr>
        <td class="time">${time}</td>
        <td class="model">${shortModel(r.model)}</td>
        <td class="msg">${escHtml(r.message)}</td>
        <td class="tokens">${formatInput(r)}</td>
        <td class="tokens">${(r.outputTokens || 0).toLocaleString()}</td>
        <td class="cost">$${r.cost.toFixed(4)}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Costs — Claude Crew</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #1a1a1a; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .subtitle { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
  .summary { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .legend { color: #888; font-size: 0.78rem; margin-bottom: 32px; }
  .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .legend .dot-read { background: #16a34a; }
  .legend .dot-write { background: #ea580c; }
  .legend .dot-new { background: #2563eb; }
  .t-read { color: #16a34a; font-weight: 600; }
  .t-write { color: #ea580c; font-weight: 600; }
  .t-new { color: #2563eb; font-weight: 600; }
  .t-sep { color: #ccc; }
  .summary-card { background: #fff; border-radius: 12px; padding: 16px 20px; flex: 1; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .summary-card .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
  .summary-card .value { font-size: 1.5rem; font-weight: 700; margin-top: 4px; }
  .summary-card .value.green { color: #16a34a; }
  .summary-card .value.blue { color: #2563eb; }
  .summary-card .value.orange { color: #ea580c; }
  .agent-section { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .agent-section h3 { font-size: 1rem; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
  .agent-total { font-weight: 400; color: #888; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #888; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #eee; }
  td { padding: 6px 8px; border-bottom: 1px solid #f3f3f3; }
  .time { white-space: nowrap; color: #888; width: 120px; }
  .msg { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model { color: #888; width: 60px; font-size: 0.8rem; }
  .tokens { text-align: right; color: #666; width: 160px; white-space: nowrap; }
  .cost { text-align: right; font-weight: 600; width: 80px; }
  .refresh { float: right; color: #2563eb; text-decoration: none; font-size: 0.85rem; }
  .empty { text-align: center; color: #888; padding: 64px 24px; }
  @media (max-width: 600px) { body { padding: 12px; } .summary { flex-direction: column; } }
</style>
</head><body>
<a class="refresh" href="/">&#8634; Refresh</a>
<h1>Agent Costs</h1>
<p class="subtitle">${entries.length} calls tracked${entries.length ? ` · since ${new Date(entries[0].ts).toLocaleDateString()}` : ""}</p>

${entries.length === 0 ? '<div class="empty"><p>No cost data yet.</p><p style="margin-top:8px;font-size:0.85rem">Cost tracking starts automatically when agents process messages.</p></div>' : `
<div class="summary">
  <div class="summary-card"><div class="label">Grand Total</div><div class="value">$${grandTotal.toFixed(4)}</div></div>
  <div class="summary-card"><div class="label">Agent Calls</div><div class="value blue">$${agentTotal.toFixed(4)}</div></div>
  <div class="summary-card"><div class="label">Router Calls</div><div class="value orange">$${routerTotal.toFixed(4)}</div></div>
  <div class="summary-card"><div class="label">Total Calls</div><div class="value green">${entries.length}</div></div>
</div>
<div class="legend">
  <span class="dot dot-read"></span>cache read (90% off) &nbsp;&middot;&nbsp;
  <span class="dot dot-write"></span>cache write (25% premium) &nbsp;&middot;&nbsp;
  <span class="dot dot-new"></span>new (standard)
</div>

${agentSections}

${routerEntries.length ? `
<div class="agent-section">
  <h3>Router <span class="agent-total">$${routerTotal.toFixed(4)} · ${routerEntries.length} calls</span></h3>
  <table>
    <thead><tr><th>Time</th><th>Model</th><th>Message</th><th>In tokens</th><th>Out tokens</th><th>Cost</th></tr></thead>
    <tbody>${routerRows}</tbody>
  </table>
</div>` : ""}
`}

</body></html>`;
}

function handleRequest(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildPage());
}

const server = createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Cost dashboard: http://localhost:${PORT}`);
});
