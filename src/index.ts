import "dotenv/config"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { App, LogLevel } from "@slack/bolt"
import {
  execute,
  type StreamMessage,
  type ResultMessage,
  type ErrorResultMessage,
} from "@sourcegraph/amp-sdk"
import { config, isUserAllowed, isChannelAllowed } from "./config.js"
import { debounce, cancel } from "./debouncer.js"
import { markdownToSlack } from "md-to-slack"
import * as log from "./logger.js"

// Load SOUL.md for Jane's personality
const __dirname = dirname(fileURLToPath(import.meta.url))
const soulPath = join(__dirname, "..", "SOUL.md")
let soulPrompt = ""
try {
  soulPrompt = readFileSync(soulPath, "utf-8")
} catch {
  // SOUL.md is optional
}

// Session manager: maps Slack thread_ts → Amp thread ID
const sessions = new Map<string, string>()

// Track in-flight requests to prevent duplicate processing
const inFlight = new Set<string>()

/**
 * Format errors for user-friendly display.
 * Hides technical details and provides actionable messages.
 */
function formatErrorForUser(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  // Authentication/configuration issues
  if (message.includes("No API key") || message.includes("login flow")) {
    return "I'm not configured properly. Please check the AMP_API_KEY."
  }
  if (message.includes("invalid_auth") || message.includes("token")) {
    return "Authentication failed. Please check the bot configuration."
  }

  // Rate limiting
  if (message.includes("rate limit") || message.includes("too many")) {
    return "I'm being rate limited. Please try again in a moment."
  }

  // Timeout
  if (message.includes("timeout") || message.includes("timed out")) {
    return "The request timed out. Try a simpler task or try again."
  }

  // Generic fallback - don't expose raw error details
  return "Something went wrong. Please try again."
}

// Initialize Slack app in Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
})

/**
 * Fetch Slack thread history as fallback context when no Amp thread exists.
 * Returns formatted string of previous messages, excluding bot's own messages.
 */
async function fetchThreadContext(
  client: typeof app.client,
  channel: string,
  threadTs: string,
  botUserId: string | undefined
): Promise<string | null> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20, // Last 20 messages should be enough context
    })

    if (!result.messages || result.messages.length <= 1) {
      return null // No history or just the current message
    }

    // Format messages, skip bot's own messages to avoid confusion
    const formatted = result.messages
      .slice(0, -1) // Exclude the latest message (we already have it)
      .filter((m) => m.user !== botUserId) // Skip bot's messages
      .map((m) => {
        const text = m.text?.replace(/<@[A-Z0-9]+>/g, "").trim() || ""
        return `[${m.user}]: ${text}`
      })
      .filter((line) => line.includes(": ") && line.split(": ")[1]) // Skip empty
      .join("\n")

    return formatted || null
  } catch (error) {
    log.error("Failed to fetch thread history", error)
    return null
  }
}

/**
 * Build context-aware system prompt with user info for privacy.
 */
function buildSystemPrompt(userId: string): string {
  const privacyContext = `
## Current Context
- Slack User ID: ${userId}

## Thread Privacy Rules
When using find_thread or read_thread:
- For "my threads" or "my previous conversations": filter with "label:slack-user-${userId}"
- Public and workspace-visible threads are fine to search and reference
- DM conversations with other users are private — don't access threads labeled with other user IDs
`
  return soulPrompt ? `${soulPrompt}\n${privacyContext}` : privacyContext
}

/**
 * Execute Amp and return the result content and thread ID.
 */
async function runAmp(
  prompt: string,
  existingThreadId: string | undefined,
  userId: string
): Promise<{ content: string; threadId: string | undefined }> {
  const messages = execute({
    prompt,
    options: {
      cwd: config.workspaceDir,
      mode: config.agentMode,
      mcpConfig:
        Object.keys(config.mcpServers).length > 0 ? config.mcpServers : undefined,
      dangerouslyAllowAll: true,
      continue: existingThreadId ?? false,
      systemPrompt: buildSystemPrompt(userId),
      labels: [`slack-user-${userId}`],
      logLevel: "warn",
    },
  })

  let threadId: string | undefined
  let content = ""

  for await (const message of messages) {
    // Capture thread ID from any message
    if ("session_id" in message && message.session_id) {
      threadId = message.session_id
    }

    // Extract final result
    if (message.type === "result") {
      if ((message as ResultMessage).subtype === "success") {
        content = (message as ResultMessage).result
      } else {
        const errorMsg = message as ErrorResultMessage
        throw new Error(errorMsg.error ?? "Execution failed")
      }
    }
  }

  return { content, threadId }
}

// Handle @mentions
app.event("app_mention", async ({ event, client, say }) => {
  const userId = event.user
  const channelId = event.channel
  const slackThreadTs = event.thread_ts ?? event.ts

  if (!userId) return

  // Authorization check
  if (!isUserAllowed(userId)) {
    log.warn("Unauthorized user", { userId })
    return
  }
  if (!isChannelAllowed(channelId)) {
    log.warn("Unauthorized channel", { channelId })
    return
  }

  // Strip the bot mention from the message
  const rawText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim()
  if (!rawText) {
    await say({
      text: "How can I help you?",
      thread_ts: slackThreadTs,
    })
    return
  }

  // Debounce key: channel + thread + user
  const debounceKey = `${channelId}:${slackThreadTs}:${userId}`
  const sessionKey = `${channelId}:${slackThreadTs}`

  // Check if already processing this thread
  if (inFlight.has(sessionKey)) {
    // Queue message for next turn via debouncer
    debounce(debounceKey, rawText)
    return
  }

  // Show typing indicator
  await client.reactions
    .add({
      channel: channelId,
      timestamp: event.ts,
      name: "eyes",
    })
    .catch(() => {})

  const startTime = Date.now()

  try {
    inFlight.add(sessionKey)

    // Wait for debounce to collect any rapid follow-up messages
    let prompt = await debounce(debounceKey, rawText)

    const existingThreadId = sessions.get(sessionKey)

    // If no Amp thread exists but we're in a Slack thread, fetch history as context
    const isInThread = event.thread_ts !== undefined
    if (!existingThreadId && isInThread) {
      const authTest = await client.auth.test()
      const history = await fetchThreadContext(
        client,
        channelId,
        slackThreadTs,
        authTest.user_id
      )
      if (history) {
        prompt = `Previous messages in this thread:\n${history}\n\nLatest message: ${prompt}`
      }
    }

    log.request("mention", userId, channelId, prompt)

    // Execute with Amp SDK
    const result = await runAmp(prompt, existingThreadId, userId)

    // Store thread mapping for future messages
    if (result.threadId) {
      sessions.set(sessionKey, result.threadId)
    }

    // Send response (chunked if needed for Slack's 4000 char limit)
    const content =
      result.content || "I completed the task but have no response to share."
    await sendChunkedResponse(say, markdownToSlack(content), slackThreadTs)

    log.response("mention", userId, Date.now() - startTime, true)

    // Mark as complete
    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    log.error("Error processing mention", error)
    log.response("mention", userId, Date.now() - startTime, false)
    cancel(debounceKey)

    await say({
      text: formatErrorForUser(error),
      thread_ts: slackThreadTs,
    })

    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: "x",
      })
      .catch(() => {})
  } finally {
    inFlight.delete(sessionKey)

    await client.reactions
      .remove({
        channel: channelId,
        timestamp: event.ts,
        name: "eyes",
      })
      .catch(() => {})
  }
})

// Handle direct messages
app.event("message", async ({ event, client, say }) => {
  // Only handle DMs (channel type "im")
  if (event.channel_type !== "im") return

  // Ignore bot messages and message_changed events
  if ("bot_id" in event || "subtype" in event) return

  const messageEvent = event as {
    ts: string
    thread_ts?: string
    text?: string
    channel: string
    user?: string
  }

  const userId = messageEvent.user
  if (!userId) return

  // Authorization check
  if (!isUserAllowed(userId)) {
    log.warn("Unauthorized DM user", { userId })
    return
  }

  const slackThreadTs = messageEvent.thread_ts ?? messageEvent.ts
  const channelId = messageEvent.channel
  const rawText = messageEvent.text ?? ""

  if (!rawText) return

  const debounceKey = `${channelId}:${slackThreadTs}:${userId}`
  const sessionKey = `${channelId}:${slackThreadTs}`

  // Check if already processing
  if (inFlight.has(sessionKey)) {
    debounce(debounceKey, rawText)
    return
  }

  // Show typing indicator
  await client.reactions
    .add({
      channel: channelId,
      timestamp: messageEvent.ts,
      name: "eyes",
    })
    .catch(() => {})

  const startTime = Date.now()

  try {
    inFlight.add(sessionKey)

    let prompt = await debounce(debounceKey, rawText)

    const existingThreadId = sessions.get(sessionKey)

    // If no Amp thread exists but we're in a Slack thread, fetch history as context
    const isInThread = messageEvent.thread_ts !== undefined
    if (!existingThreadId && isInThread) {
      const authTest = await client.auth.test()
      const history = await fetchThreadContext(
        client,
        channelId,
        slackThreadTs,
        authTest.user_id
      )
      if (history) {
        prompt = `Previous messages in this thread:\n${history}\n\nLatest message: ${prompt}`
      }
    }

    log.request("dm", userId, channelId, prompt)

    const result = await runAmp(prompt, existingThreadId, userId)

    if (result.threadId) {
      sessions.set(sessionKey, result.threadId)
    }

    const content = result.content || "Done."
    await sendChunkedResponse(say, markdownToSlack(content), slackThreadTs)

    log.response("dm", userId, Date.now() - startTime, true)

    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    log.error("Error processing DM", error)
    log.response("dm", userId, Date.now() - startTime, false)
    cancel(debounceKey)

    await say({
      text: formatErrorForUser(error),
      thread_ts: slackThreadTs,
    })

    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: "x",
      })
      .catch(() => {})
  } finally {
    inFlight.delete(sessionKey)

    await client.reactions
      .remove({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: "eyes",
      })
      .catch(() => {})
  }
})

// Helper: Send response in chunks if it exceeds Slack's limit
async function sendChunkedResponse(
  say: (args: { text: string; thread_ts: string }) => Promise<unknown>,
  content: string,
  threadTs: string
) {
  const MAX_LENGTH = 3900

  if (content.length <= MAX_LENGTH) {
    await say({ text: content, thread_ts: threadTs })
    return
  }

  const chunks: string[] = []
  let remaining = content

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining)
      break
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH)
    if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH)
    }
    if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH)
    }
    if (splitIndex === -1) {
      splitIndex = MAX_LENGTH
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).trimStart()
  }

  for (const chunk of chunks) {
    await say({ text: chunk, thread_ts: threadTs })
  }
}

// Start the app
async function main() {
  await app.start()
  log.startup({
    workspace: config.workspaceDir,
    mode: config.agentMode,
    debounce: config.debounceMs,
    hasSoul: !!soulPrompt,
  })
}

main().catch((err) => log.error("Startup failed", err))
