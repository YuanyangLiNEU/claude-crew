#!/usr/bin/env tsx
/**
 * Agent Cost Dashboard — lightweight local web server for viewing agent costs.
 * Usage: npx tsx scripts/costs-server.ts [port]
 *   or:  npm run costs:dashboard
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

function getTodayPST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function filterByDate(entries: CostEntry[], date: string): CostEntry[] {
  if (!date) return entries;
  return entries.filter(e => {
    const entryDate = new Date(e.ts).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    return entryDate === date;
  });
}

function buildPage(dateParam: string): string {
  const selectedDate = dateParam || getTodayPST();
  const allEntries = loadCosts();
  const entries = filterByDate(allEntries, selectedDate);

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

  const VISIBLE_ROWS = 10;
  let sectionIdx = 0;

  function buildRows(entries: CostEntry[], id: string): string {
    const reversed = entries.slice().reverse();
    const rows = reversed.map((m, i) => {
      const time = new Date(m.ts).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const hidden = i >= VISIBLE_ROWS ? ` class="hidden-row" data-section="${id}" style="display:none"` : "";
      return `<tr${hidden}>
        <td class="time">${time}</td>
        <td class="model">${shortModel(m.model)}</td>
        <td class="msg">${escHtml(m.message)}</td>
        <td class="tokens">${formatInput(m)}</td>
        <td class="tokens">${(m.outputTokens || 0).toLocaleString()}</td>
        <td class="cost">$${m.cost.toFixed(4)}</td>
      </tr>`;
    }).join("");
    const moreBtn = reversed.length > VISIBLE_ROWS
      ? `<tr class="more-row" data-section="${id}"><td colspan="6" class="more-cell"><a href="#" onclick="toggleSection('${id}');return false" id="btn-${id}">Show ${reversed.length - VISIBLE_ROWS} more</a></td></tr>`
      : "";
    return rows + moreBtn;
  }

  const agentSections = Object.entries(byAgent)
    .sort((a, b) => b[1].reduce((s, e) => s + e.cost, 0) - a[1].reduce((s, e) => s + e.cost, 0))
    .map(([agent, msgs]) => {
      const total = msgs.reduce((s, e) => s + e.cost, 0);
      const id = `agent-${sectionIdx++}`;
      return `
        <div class="agent-section">
          <h3>${escHtml(agent)} <span class="agent-total">$${total.toFixed(4)} · ${msgs.length} calls</span></h3>
          <table>
            <thead><tr><th>Time</th><th>Model</th><th>Message</th><th>In tokens</th><th>Out tokens</th><th>Cost</th></tr></thead>
            <tbody>${buildRows(msgs, id)}</tbody>
          </table>
        </div>`;
    })
    .join("");

  const routerRows = buildRows(routerEntries, "router");

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Costs — Claude Crew</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #1a1a1a; padding: 32px; max-width: 1200px; margin: 0 auto; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .header-left h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .header-right input[type="date"] { font-size: 0.9rem; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; }
  .header-right .refresh { color: #2563eb; text-decoration: none; font-size: 0.9rem; padding: 8px 14px; border: 1px solid #ddd; border-radius: 8px; background: #fff; }
  .header-right .refresh:hover { background: #f0f4ff; }
  .header-meta { color: #888; font-size: 0.82rem; }

  /* Summary cards */
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
  .summary-card { background: #fff; border-radius: 12px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .summary-card .label { font-size: 0.7rem; color: #999; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
  .summary-card .value { font-size: 1.6rem; font-weight: 700; margin-top: 6px; }
  .summary-card .value.green { color: #16a34a; }
  .summary-card .value.blue { color: #2563eb; }
  .summary-card .value.orange { color: #ea580c; }

  /* Legend */
  .legend { color: #999; font-size: 0.75rem; margin-bottom: 28px; }
  .legend .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
  .legend .dot-read { background: #16a34a; }
  .legend .dot-write { background: #ea580c; }
  .legend .dot-new { background: #2563eb; }

  /* Token colors */
  .t-read { color: #16a34a; font-weight: 600; }
  .t-write { color: #ea580c; font-weight: 600; }
  .t-new { color: #2563eb; font-weight: 600; }
  .t-sep { color: #ccc; }

  /* Agent sections */
  .agent-section { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .agent-section h3 { font-size: 0.95rem; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
  .agent-total { font-weight: 400; color: #999; font-size: 0.82rem; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  th { text-align: left; color: #999; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid #eee; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 8px 10px; border-bottom: 1px solid #f5f5f5; }
  tr:hover td { background: #fafbfc; }
  .time { white-space: nowrap; color: #999; width: 130px; }
  .msg { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model { color: #999; width: 60px; font-size: 0.78rem; }
  .tokens { text-align: right; color: #666; width: 160px; white-space: nowrap; }
  .cost { text-align: right; font-weight: 600; width: 80px; }

  .empty { text-align: center; color: #888; padding: 64px 24px; }
  .more-cell { text-align: center; padding: 10px; }
  .more-cell a { color: #2563eb; text-decoration: none; font-size: 0.82rem; font-weight: 500; }
  .more-cell a:hover { text-decoration: underline; }
  @media (max-width: 700px) { body { padding: 14px; } .summary { grid-template-columns: repeat(2, 1fr); } .header { flex-direction: column; align-items: flex-start; gap: 12px; } }
</style>
<script>
function toggleSection(id) {
  const rows = document.querySelectorAll('tr[data-section="' + id + '"].hidden-row');
  const btn = document.getElementById('btn-' + id);
  const moreRow = document.querySelector('tr.more-row[data-section="' + id + '"]');
  const visible = rows[0] && rows[0].style.display !== 'none';
  rows.forEach(function(r) { r.style.display = visible ? 'none' : ''; });
  if (btn) btn.textContent = visible ? 'Show ' + rows.length + ' more' : 'Show less';
}
</script>
</head><body>
<div class="header">
  <div class="header-left">
    <h1>Agent Costs</h1>
    <span class="header-meta">${entries.length} calls on ${selectedDate}${allEntries.length !== entries.length ? ` &middot; ${allEntries.length} all time` : ""}</span>
  </div>
  <div class="header-right">
    <input type="date" id="datePicker" value="${selectedDate}" onchange="window.location='/?date='+this.value">
    <a class="refresh" href="/?date=${selectedDate}">Refresh</a>
  </div>
</div>

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

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const dateParam = url.searchParams.get("date") || "";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildPage(dateParam));
}

const server = createServer(handleRequest);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent cost dashboard: http://localhost:${PORT}`);
});
