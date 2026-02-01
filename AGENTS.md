# AGENTS.md - janebot

## Overview

janebot is a Slack bot powered by the Amp SDK. It responds to @mentions and DMs.

## Build & Run

```bash
mise exec node -- pnpm install      # Install dependencies
mise exec node -- pnpm dev          # Run with hot reload
mise exec node -- pnpm build        # Build for production
mise exec node -- pnpm typecheck    # Type check
```

## Architecture

- `src/index.ts` - Main entry point, Slack event handlers
- `src/config.ts` - Configuration loading from environment
- `src/debouncer.ts` - Message debouncing for rapid messages
- Sessions stored in-memory (Map of Slack thread → Amp thread ID)
- Uses Amp SDK `execute()` for agent interactions

## Key Patterns

1. **Thread mapping**: Each Slack thread maps to an Amp thread for continuity
2. **Message debouncing**: Combines rapid messages into a single prompt
3. **Chunked responses**: Split long responses for Slack's 4000 char limit
4. **Visual feedback**: React with 👀 (processing), ✅ (done), ❌ (error)
5. **Authorization**: User and channel allowlists via env vars
