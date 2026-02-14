<img src="assets/icon.png" width="128" alt="Jane" />

# janebot

Jane is a Slack bot powered by the [Amp SDK](https://ampcode.com/manual/sdk). She has opinions and won't say "Great question!".

[SOUL.md](./SOUL.md) defines her personality. [docs/threads.md](./docs/threads.md) explains the thread model. [docs/security-model.md](./docs/security-model.md) covers isolation, credentials, and what Jane can and can't do.

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) using `slack-manifest.yaml`
2. Generate an App-Level Token with `connections:write` scope
3. Install to your workspace

```bash
cp .env.example .env
# Add your tokens

pnpm install
pnpm dev
```

Mention `@janebot` in a channel or DM her.

## Config

| Variable | What it does |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-...`) |
| `AMP_API_KEY` | From [ampcode.com/settings](https://ampcode.com/settings) |
| `WORKSPACE_DIR` | Where Jane works |
| `AGENT_MODE` | `smart`, `rush`, or `deep` |
| `ALLOWED_USER_IDS` | Who can talk to her |
| `ALLOWED_CHANNEL_IDS` | Where she listens |

Empty allowlists mean no restrictions.

## Run locally

In `.env`:

* Enable local execution:
  * `ALLOW_LOCAL_EXECUTION=true`

* Define any additional mcp servers in:
  * `MCP_SERVERS`

In `src/index.ts`:

* Explicitly add the name of any defined mcp servers in:
  * `LOCAL_ENABLED_TOOLS`


```bash
pnpm dev
```

Logs show requests and response times. Restart to pick up changes.

## Deploy

```bash
fly launch --copy-config
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... AMP_API_KEY=...
fly deploy
```
