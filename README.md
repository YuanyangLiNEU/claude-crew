# Claude Crew

Run a team of AI agents on Telegram, powered by [Claude Code](https://claude.ai/code).

Each agent is a Claude Code instance with a defined role (engineer, PM, UX designer, etc.) that collaborates in a Telegram group chat. Agents can @mention each other, share context, and work together — with you as the decision-maker.

## Why?

Claude Code's built-in [Telegram channel plugin has reliability issues](https://github.com/anthropics/claude-code/issues/36477) — it stops processing messages after the first response. Claude Crew bypasses this entirely with a lightweight coordinator (grammy + `claude -p`) that's fully reliable.

## The Default Team

| Agent | Role | Capabilities |
|-------|------|-------------|
| **Devin** (`@engineer_devin`) | Software Engineer | Full code access, tests, deploys (with approval) |
| **Lark** (`@engineer_lark`) | Software Engineer | Same as Devin — peer code review with each other |
| **Sage** (`@pm_sage`) | Product Manager | Web research, dashboard access, no code editing |
| **Aria** (`@ux_aria`) | UX Designer | Live product evaluation only, no file access |

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
git clone https://github.com/YuanyangLiNEU/claude-crew.git
cd claude-crew
npm install

cp .env.example .env
# Paste your bot tokens in .env
# Add your Telegram user ID to ALLOWED_USERS (message @userinfobot to find it)
```

### 4. Set up your project

Optionally, create a `CLAUDE.md` in the root directory with your project context (architecture, key files, commands). All agents will auto-load it. Then customize `agents.yaml` and the role CLAUDE.md files for your project.

### 5. Start

```bash
npm run start:all     # Start all agents in background
npm run status        # Check who's running
npm run stop          # Stop all agents
```

### 6. Chat

In the Telegram group, @mention the bot you want to talk to. In DMs, each bot responds directly.

## How It Works

### Tagged messages (direct)
```
"@engineer_devin fix the login bug"
  → Goes directly to Devin's process → claude -p --continue → responds
```

### Non-tagged messages (smart routing)
```
"the email layout looks weird"
  → Router agent (first in agents.yaml) logs to group-history.jsonl
  → After 1s debounce, router calls Claude Sonnet:
    "Read this conversation. Who should respond?"
  → Sonnet returns "ux_aria"
  → Router writes to shared/inbox/router-to-ux_aria-*.json
  → Aria's process picks it up (polls every 1s) → responds
```

### Bot-to-bot handoff
```
Devin's response mentions @ux_aria
  → Coordinator writes to shared/inbox/
  → Aria picks it up and responds
```

## Configuration

### agents.yaml

Define your team. Each agent needs a name, ID, directory, and bot token:

```yaml
agents:
  - name: Devin
    id: engineer_devin         # Unique ID (role + name), used for @mentions
    role: engineer             # Shared profile: agents/shared/engineer-base.md
    dir: ./agents/engineer_devin
    bot_token_env: ENGINEER_DEVIN_BOT_TOKEN
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
    engineer_devin/CLAUDE.md  # Devin's role
    engineer_lark/CLAUDE.md   # Lark's role
    pm_sage/CLAUDE.md         # Sage's role
    ux_aria/CLAUDE.md         # Aria's role
    shared/
      team-base.md         # Shared team profile
      engineer-base.md     # Shared engineer profile
      chatlog.md           # Cross-agent work log
      inbox/               # Cross-agent message queue
      group-history.jsonl  # Rolling group chat history
```

## Adding a New Agent

Example: adding a QA engineer named "Ember".

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather):
```
/newbot → "Ember" → ember_qa_bot
```
Go to **Bot Settings → Group Privacy → Turn off**, then add the bot to your group.

### 2. Add the bot token

Add to `.env`:
```
QA_BOT_TOKEN=<paste token from BotFather>
```

### 3. Create the role

```bash
mkdir -p agents/qa_ember
```

Create `agents/qa_ember/CLAUDE.md`:
```markdown
# Role: Ember — QA Engineer

You are **Ember**, the QA Engineer. Always introduce yourself as "Ember".

## Identity
- **Name**: Ember
- **ID**: `@qa`
- **Role**: QA Engineer
- **Reports to**: the project founder

## Shared Profile
Read `agents/shared/team-base.md` — team-wide info, communication, escalation.

## What You Do
1. **Test features end-to-end** — verify new changes work as expected
2. **Find edge cases** — empty states, error states, boundary conditions
3. **Report bugs clearly** — steps to reproduce, expected vs actual, severity
...

## Feedback from Founder
(Append feedback here.)
```

### 4. Add to `agents.yaml`

```yaml
  - name: Ember
    id: qa_ember
    role: qa             # Optional — create agents/shared/qa-base.md if needed
    dir: ./agents/qa_ember
    bot_token_env: QA_BOT_TOKEN
    extra_disallowed: ""
```

### 5. Update the team roster

Add Ember to `agents/shared/team-base.md`:
```
| **Ember** | QA Engineer | `@qa` |
```

Also update other agents' CLAUDE.md files if they should know when to tag Ember.

### 6. Start

```bash
npm run start:all
```

The new agent is live. Message `@ember_qa_bot` in the group to test.

## Features

- **Smart routing** — conversation-aware layer reads recent chat and decides who should respond (1 Sonnet call, not 4)
- **Group chat context** — all agents see the last 20 messages for context
- **Cross-agent messaging** — agents @mention each other and messages route automatically
- **Bot-to-bot handoff** — when one agent responds, the router evaluates if another should follow up
- **Markdown rendering** — responses auto-converted to Telegram HTML (bold, code, links, etc.)
- **"Still working" notices** — sent after 2 min of processing
- **Per-role permissions** — control what each agent can/can't do via `extra_disallowed` in agents.yaml
- **Response flexibility** — routed agents can stay silent if they have nothing to add
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
