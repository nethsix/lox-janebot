# Thread Model

Jane uses a **stateless execution model** — each message gets a fresh Amp session with Slack thread history as context.

## How It Works

```
Slack Thread (thread_ts)  →  Fresh Amp Session
         ↓                          ↓
   User messages              Slack history fetched
   + Jane's replies           and included in prompt
```

When a user sends a message in a Slack thread, Jane:
1. Fetches the full thread history from Slack (including her own previous replies)
2. Formats it as a conversation transcript
3. Sends it as context with the new message to a fresh Amp session

There is no Amp thread continuation — Slack is the source of truth for conversation context.

## Why Stateless?

The previous model mapped each Slack thread to a persistent Amp thread. This caused issues:
- Amp threads accumulated error history that confused the LLM
- Sprites (sandboxed VMs) referenced by sessions would die, causing 404 errors
- Stale amp binaries in long-lived sprites lacked new features
- Session state drifted between components

The stateless model eliminates all of these problems. Each request gets a clean environment with fresh context from Slack.

## Thread Context Format

Messages are formatted as:
```
Previous messages in this Slack thread:
[U0A3UC8JALF]: what can you tell me about our API?
[Jane]: The API uses REST with JSON responses...
[U0A3UC8JALF]: what about authentication?

Latest message: how do we handle token refresh?
```

Jane's own replies are labelled `[Jane]` and user messages use their Slack user ID.

## Tools Available

Jane can use these Amp tools for thread operations:

- **`find_thread`** — Search threads by keywords or file changes
- **`read_thread`** — Read content from a thread by ID

Example queries Jane can handle:
- "Find my threads about the database migration"
- "What did we discuss last time about auth?"
