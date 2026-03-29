# Claude Crew

Run a team of AI agents on Telegram, powered by [Claude Code](https://claude.ai/code).

Each agent is a Claude Code instance with a defined role (engineer, PM, UX designer, etc.) that collaborates in a Telegram group chat. Agents can @mention each other, share context, and work together — with you as the decision-maker.

## Why?

Claude Code's built-in [Telegram channel plugin has reliability issues](https://github.com/anthropics/claude-code/issues/36477) — it stops processing messages after the first response. Claude Crew bypasses this entirely with a lightweight coordinator (grammy + `claude -p`) that's fully reliable.

## The Default Team

| Agent | Role | Capabilities |
|-------|------|-------------|
| **Devin** (`@engineer`) | Software Engineer | Full code access, tests, deploys (with approval) |
| **Lark** (`@engineer2`) | Software Engineer | Same as Devin — peer code review with each other |
| **Sage** (`@pm`) | Product Manager | Web research, dashboard access, no code editing |
| **Aria** (`@ux`) | UX Designer | Live product evaluation only, no file access |

## Quick Start

### 1. Create Telegram bots

Message [@BotFather](https://t.me/BotFather) on Telegram and create one bot per agent:

```
/newbot → "Devin" → devin_engineer_bot
/newbot → "Lark" → lark_engineer_bot
/newbot → "Sage" → sage_pm_bot
/newbot → "Aria" → aria_ux_bot
```

For each bot, go to **Bot Settings → Group Privacy → Turn off** so they can see group messages.

### 2. Create a Telegram group

Create a group, add all 4 bots as members, and add yourself.

### 3. Configure

```bash
git clone https://github.com/anthropics/claude-crew.git
cd claude-crew
npm install

cp .env.example .env
# Paste your bot tokens and Telegram user ID in .env
```

### 4. Set up your project

Put your project's `CLAUDE.md` in the root directory so all agents have project context. Then customize `agents.yaml` and the role CLAUDE.md files for your project.

### 5. Start

```bash
npm run start:all     # Start all agents in background
npm run status        # Check who's running
npm run stop          # Stop all agents
```

### 6. Chat

In the Telegram group, @mention the bot you want to talk to. In DMs, each bot responds directly.

## How It Works

```
You send "@devin fix the login bug" in Telegram group
         ↓
All 4 bot processes receive the message (grammy polls Telegram)
         ↓
All 4 write it to shared/group-history.jsonl (shared context)
         ↓
Only Devin's process responds (checks @mention match)
         ↓
Coordinator reads last 50 messages from group history
         ↓
Spawns: claude -p --continue (from agents/engineer/ directory)
  → Claude Code loads CLAUDE.md (role) + root CLAUDE.md (project)
  → Does the work, returns response
         ↓
Response sent to Telegram as HTML (markdown auto-converted)
         ↓
If response mentions @lark → written to shared/inbox/
  → Lark's process picks it up, processes, replies
```

## Configuration

### agents.yaml

Define your team. Each agent needs a name, ID, directory, and bot token:

```yaml
agents:
  - name: Devin
    id: engineer
    role: engineer
    dir: ./agents/engineer
    bot_token_env: ENGINEER_BOT_TOKEN
    extra_disallowed: ""
```

### Role CLAUDE.md files

Each agent's directory has a `CLAUDE.md` that defines their role, responsibilities, and boundaries. Customize these for your project.

### Shared profiles

- `agents/shared/team-base.md` — applies to ALL agents (team roster, communication rules, escalation)
- `agents/shared/engineer-base.md` — applies to all engineers (shared responsibilities, review protocol)

## Directory Structure

```
claude-crew/
  agents.yaml              # Agent configuration
  .env                     # Bot tokens (not in git)
  src/index.ts             # Coordinator (grammy + claude CLI)
  scripts/
    restart-all.sh         # Start/restart all agents
    stop-all.sh            # Stop all agents
    status.sh              # Check agent status
  agents/
    engineer/CLAUDE.md     # Devin's role
    engineer2/CLAUDE.md    # Lark's role
    pm/CLAUDE.md           # Sage's role
    ux/CLAUDE.md           # Aria's role
    shared/
      team-base.md         # Shared team profile
      engineer-base.md     # Shared engineer profile
      chatlog.md           # Cross-agent work log
      inbox/               # Cross-agent message queue
      group-history.jsonl  # Rolling group chat history
```

## Adding a New Agent

1. Create a bot via BotFather, add token to `.env`
2. Create `agents/<role>/CLAUDE.md` with role definition
3. Add entry to `agents.yaml`
4. Update team roster in `agents/shared/team-base.md`
5. Restart: `npm run start:all`

## Features

- **Group chat context** — all agents see the full conversation history (last 50 messages)
- **Cross-agent messaging** — agents @mention each other and messages route automatically
- **Markdown rendering** — responses auto-converted to Telegram HTML (bold, code, links, etc.)
- **"Still working" notices** — sent after 2 min of processing so you know the agent is alive
- **Per-role permissions** — control what each agent can/can't do via `extra_disallowed` in agents.yaml
- **DM support** — message any bot directly for private conversations
- **Session continuity** — agents remember prior conversations via `--continue`

## Requirements

- [Claude Code](https://claude.ai/code) installed and authenticated (`claude --version`)
- Node.js 18+
- Telegram account

## Known Limitations

- Agents process messages sequentially (one at a time per agent) — complex tasks block the queue
- Cross-agent messaging uses file-based polling (3s interval) — not instant
- `rm -rf` is the only hard-blocked command; other restrictions are policy-based (CLAUDE.md instructions)
- Group chat history resets on file deletion (but session memory persists via `--continue`)

## License

MIT
