#!/bin/bash
# Show agent cost summary
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COST_FILE="$SCRIPT_DIR/../agents/shared/costs.jsonl"

if [ ! -f "$COST_FILE" ]; then
  echo "No cost data yet."
  exit 0
fi

cat "$COST_FILE" | python3 -c "
import sys, json
from collections import defaultdict

entries = []
for line in sys.stdin:
    try:
        entries.append(json.loads(line))
    except:
        pass

if not entries:
    print('No cost data.')
    sys.exit()

# Separate router and agent entries
router = [e for e in entries if e.get('type') == 'router']
agents = defaultdict(list)
for e in entries:
    if e.get('type') == 'agent':
        agents[e['agent']].append(e)

# Print per-agent breakdown
for agent in sorted(agents.keys()):
    msgs = agents[agent]
    total = sum(m['cost'] for m in msgs)
    print(f'{agent}:')
    for m in msgs:
        preview = ' '.join(m.get('message', '').split()[:10])
        tokens_in = m.get('cacheReadTokens', 0) + m.get('cacheCreationTokens', 0) + m.get('inputTokens', 0)
        tokens_out = m.get('outputTokens', 0)
        print(f'  \${m[\"cost\"]:.4f}  {tokens_in:>7,} in / {tokens_out:>6,} out  {preview}')
    print(f'  Total: \${total:.4f} ({len(msgs)} calls)')
    print()

# Router summary
if router:
    rtotal = sum(r['cost'] for r in router)
    print(f'Router:')
    for r in router:
        preview = ' '.join(r.get('message', '').split()[:10])
        print(f'  \${r[\"cost\"]:.4f}  {preview}')
    print(f'  Total: \${rtotal:.4f} ({len(router)} calls)')
    print()

# Grand total
grand = sum(e['cost'] for e in entries)
print(f'Grand total: \${grand:.4f} ({len(entries)} calls)')
"
