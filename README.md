# janebot

A Slack bot powered by the [Amp SDK](https://ampcode.com/manual/sdk). Talk to an AI agent in Slack with full tool execution capabilities.

## Quick Start

1. **Create a Slack App**
   - Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
   - Enable **Socket Mode** (Settings → Socket Mode)
   - Add **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`
   - Install to your workspace

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your tokens
   ```

3. **Install & Run**
   ```bash
   pnpm install
   pnpm dev
   ```

4. **Talk to the Bot**
   - Mention `@janebot` in any channel it's invited to
   - Or send a direct message

## Configuration

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) from OAuth & Permissions |
| `SLACK_APP_TOKEN` | App-level token (`xapp-...`) from Basic Information |
| `SLACK_SIGNING_SECRET` | Signing secret from Basic Information |
| `AMP_ACCESS_TOKEN` | Your Amp access token from [ampcode.com/settings](https://ampcode.com/settings) |
| `WORKSPACE_DIR` | Directory the agent operates in |
| `AGENT_MODE` | `smart` (default), `rush`, or `deep` |
| `DEBOUNCE_MS` | Delay to combine rapid messages (default: `1500`) |
| `ALLOWED_USER_IDS` | Comma-separated user IDs to allow (empty = all) |
| `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs to allow (empty = all) |
| `MCP_SERVERS` | Custom MCP servers (see below) |

## Features

- **Thread Continuity** - Conversations in Slack threads maintain context
- **Tool Execution** - The agent can use tools to complete tasks
- **Message Debouncing** - Combines rapid messages into a single prompt
- **Chunked Responses** - Long responses are split for Slack's message limit
- **Visual Feedback** - 👀 while processing, ✅ when done, ❌ on error
- **Authorization** - Restrict access by user or channel
- **MCP Servers** - Connect custom tool servers

## MCP Servers

Add custom tools via MCP servers:

```bash
# Format: "name:command:arg1,arg2;name2:command2"
MCP_SERVERS="github:npx:-y,@anthropic/mcp-server-github;filesystem:npx:-y,@anthropic/mcp-server-filesystem,/workspace"
```

## Development

```bash
pnpm dev          # Run with hot reload
pnpm build        # Build for production
pnpm typecheck    # Type check
```

## Deployment

### Fly.io

```bash
# First time
fly launch --copy-config
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... AMP_ACCESS_TOKEN=...

# Deploy
fly deploy

# View logs
fly logs
```

### Sprites.dev

```bash
# Create a sprite
sprite create janebot

# Clone and setup
sprite exec -s janebot -- git clone https://github.com/you/janebot /app
sprite exec -s janebot -- bash /app/scripts/sprites-setup.sh

# Add secrets
sprite exec -s janebot -- bash -c 'cat > /app/.env << EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
AMP_ACCESS_TOKEN=...
WORKSPACE_DIR=/workspace
EOF'

# Start and checkpoint
sprite exec -s janebot -- systemctl --user start janebot
sprite checkpoint -s janebot

# View logs
sprite exec -s janebot -- journalctl --user -u janebot -f
```

The sprite will hibernate when idle and wake up automatically when Slack sends events.

See [PLAN.md](./PLAN.md) for the full roadmap.
