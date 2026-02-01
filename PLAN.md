# janebot - Slack Agent powered by Amp SDK

A minimal long-running Slack bot that uses the [Amp SDK](https://ampcode.com/manual/sdk) as its agent runtime, giving you a conversational AI assistant with tool execution capabilities.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Slack Workspace                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                          │
│  │ #channel │  │   DM     │  │ @mention │                          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                          │
└───────┼─────────────┼─────────────┼─────────────────────────────────┘
        │             │             │
        └─────────────┼─────────────┘
                      ▼
        ┌─────────────────────────────┐
        │   Slack Bolt (Socket Mode)  │
        │   - Event listener          │
        │   - Message debouncing      │
        │   - Thread resolution       │
        └─────────────┬───────────────┘
                      │
                      ▼
        ┌─────────────────────────────┐
        │      Session Manager        │
        │   - Slack→Amp thread map    │
        │   - Conversation state      │
        │   - User context            │
        └─────────────┬───────────────┘
                      │
                      ▼
        ┌─────────────────────────────┐
        │        Amp SDK              │
        │   execute({                 │
        │     prompt,                 │
        │     threadId,               │
        │     mcpServers,             │
        │     skills,                 │
        │   })                        │
        └─────────────┬───────────────┘
                      │
        ┌─────────────┴───────────────┐
        │                             │
        ▼                             ▼
┌───────────────┐           ┌───────────────┐
│  MCP Servers  │           │    Skills     │
│  - Your tools │           │  - Custom     │
│  - APIs       │           │    behaviors  │
└───────────────┘           └───────────────┘
```

## Learnings from openclaw & pi-mono

### What openclaw taught us

1. **Message debouncing** - Users often send multiple messages in quick succession. Queue messages by `(channel, thread, sender)` and flush after a short delay (500ms-2s) to combine them into a single prompt.

2. **Thread resolution** - Maintain a mapping between Slack threads and agent conversation threads. This enables multi-turn conversations where the agent remembers context.

3. **Steering & follow-up queues** - openclaw implements two message queues:
   - **Steering**: Interrupts tool execution mid-flight (user sends "stop" or changes direction)
   - **Follow-up**: Queues work after the agent would naturally stop
   
   For a minimal implementation, we can simplify: just queue new messages and start a new turn.

4. **Authorization layers** - openclaw checks DM allowlists, channel access, and user permissions. Start simple (allowlist of user IDs) and expand as needed.

5. **Typing indicators** - Show "is typing..." in Slack while the agent works. Clear it when done or on error.

### What pi-mono taught us

1. **Event-driven architecture** - The agent loop emits granular events (`message_start`, `tool_execution_start`, `tool_execution_end`, etc.) that can be used for UI updates. The Amp SDK abstracts this, but we can stream responses.

2. **Message type separation** - Keep "app messages" (notifications, artifacts) separate from "LLM messages" (user/assistant/tool_result). The Amp SDK handles this internally.

3. **Tool isolation** - Individual tool failures shouldn't crash the loop. Errors become tool result messages that the LLM can reason about.

4. **Session state** - Store minimal session metadata (thread mappings, user preferences) rather than full conversation history. Let the agent runtime (Amp) manage the conversation.

### What Amp SDK gives us for free

- ✅ Agent loop with tool execution
- ✅ Streaming responses  
- ✅ Thread continuity (conversation memory)
- ✅ MCP server integration
- ✅ Skills support
- ✅ Model selection (smart/rush/deep)
- ✅ Permission management
- ✅ Cancellation/timeouts

## Implementation Plan

### Phase 1: Minimal Viable Bot ✅

**Goal**: Respond to @mentions with Amp-powered replies, maintaining thread context.

**Deliverables**:
- [x] Slack Bolt app with socket mode
- [x] Basic session manager (in-memory Map)
- [x] Amp SDK integration
- [x] Error handling and logging

### Phase 2: Enhanced UX ✅

**Goal**: Better user experience with typing indicators, streaming, and message debouncing.

**Deliverables**:
- [x] Typing indicator while agent works
- [x] Message debouncing (combine rapid messages)
- [x] Stream long responses in chunks (Slack 4000 char limit)
- [x] React with 👀 when processing, ✅ when done

### Phase 3: Tool Integration ✅

**Goal**: Connect custom MCP servers for domain-specific capabilities.

**Deliverables**:
- [x] MCP server configuration (via `MCP_SERVERS` env var)
- [x] Tool permission management (auto-approve all by default)
- [ ] Tool output formatting for Slack

### Phase 4: Persistence & Reliability

**Goal**: Survive restarts, handle edge cases.

**Deliverables**:
- [ ] Persist session mappings (SQLite or JSON file)
- [ ] Graceful shutdown (finish current request)
- [ ] Rate limiting per user
- [ ] Error recovery and retry logic

### Phase 5: Multi-channel & Authorization ✅

**Goal**: Deploy to multiple channels with proper access control.

**Deliverables**:
- [x] Channel allowlist configuration
- [x] User authorization (who can talk to the bot)
- [ ] Per-channel skills/tools configuration
- [ ] Admin commands (/status, /clear, etc.)

## Configuration

```typescript
interface JanebotConfig {
  // Slack
  slackBotToken: string
  slackAppToken: string
  slackSigningSecret: string
  
  // Amp
  ampAccessToken: string
  workspaceDir: string
  agentMode: "smart" | "rush" | "deep"
  
  // Behavior
  debounceMs: number           // Message debounce delay
  typingIndicator: boolean     // Show typing in Slack
  maxResponseLength: number    // Truncate long responses
  
  // Authorization
  allowedUserIds: string[]     // Empty = allow all
  allowedChannelIds: string[]  // Empty = allow all
  
  // MCP
  mcpServers: Record<string, McpServerConfig>
  
  // Skills
  skillsDir?: string
}
```

## File Structure

```
janebot/
├── src/
│   ├── index.ts           # Entry point, Slack app setup
│   ├── config.ts          # Configuration loading
│   ├── sessions.ts        # Thread mapping & state
│   ├── debouncer.ts       # Message debouncing
│   ├── slack/
│   │   ├── events.ts      # Event handlers
│   │   ├── typing.ts      # Typing indicator
│   │   └── replies.ts     # Response formatting & chunking
│   └── amp/
│       └── executor.ts    # Amp SDK wrapper
├── skills/                # Custom skills (optional)
│   └── example/
│       └── SKILL.md
├── .env                   # Secrets
├── .env.example
├── package.json
├── tsconfig.json
├── AGENTS.md              # Instructions for the bot
├── PLAN.md                # This file
└── README.md
```

## Deployment

### Local Development

```bash
pnpm install
cp .env.example .env
# Edit .env with your tokens
pnpm dev
```

### Production (Docker)

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
CMD ["node", "dist/index.js"]
```

### Production (systemd)

```ini
[Unit]
Description=janebot Slack Agent
After=network.target

[Service]
Type=simple
User=janebot
WorkingDirectory=/opt/janebot
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/opt/janebot/.env

[Install]
WantedBy=multi-user.target
```

## Security Considerations

1. **Token management** - Store Slack and Amp tokens securely (environment variables, not in code)
2. **User authorization** - Validate who can interact with the bot
3. **Tool permissions** - Be explicit about what tools the agent can use
4. **Rate limiting** - Prevent abuse by limiting requests per user
5. **Audit logging** - Log all interactions for debugging and compliance

## Future Enhancements

- **Scheduled tasks** - Let users schedule reminders or recurring tasks
- **Reactions as commands** - React with 🔄 to retry, ❌ to cancel
- **File handling** - Process uploaded files (PDFs, images)
- **Multi-workspace** - Support multiple Slack workspaces
- **Web dashboard** - View conversation history and analytics
- **Voice messages** - Transcribe and respond to voice notes
