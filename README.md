# janebot

A Slack bot powered by the [Amp SDK](https://ampcode.com/manual/sdk).

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) using `slack-manifest.yaml`
2. Generate an App-Level Token with `connections:write` scope
3. Install the app to your workspace

```bash
cp .env.example .env
# Fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, AMP_ACCESS_TOKEN

pnpm install
pnpm dev
```

Mention `@janebot` in a channel or send a DM.

## Configuration

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-...`) |
| `AMP_ACCESS_TOKEN` | From [ampcode.com/settings](https://ampcode.com/settings) |
| `WORKSPACE_DIR` | Directory the agent operates in |
| `AGENT_MODE` | `smart`, `rush`, or `deep` |
| `ALLOWED_USER_IDS` | Comma-separated allowlist (empty = all) |
| `ALLOWED_CHANNEL_IDS` | Comma-separated allowlist (empty = all) |

## Deploy

```bash
# Fly.io
fly launch --copy-config
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... AMP_ACCESS_TOKEN=...
fly deploy
```
