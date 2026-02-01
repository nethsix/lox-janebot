import "dotenv/config"
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

// Session manager: maps Slack thread_ts → Amp thread ID
const sessions = new Map<string, string>()

// Track in-flight requests to prevent duplicate processing
const inFlight = new Set<string>()

// Initialize Slack app in Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
})

/**
 * Execute Amp and return the result content and thread ID.
 */
async function runAmp(
  prompt: string,
  existingThreadId: string | undefined
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
    console.log(`Unauthorized user: ${userId}`)
    return
  }
  if (!isChannelAllowed(channelId)) {
    console.log(`Unauthorized channel: ${channelId}`)
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

  try {
    inFlight.add(sessionKey)

    // Wait for debounce to collect any rapid follow-up messages
    const prompt = await debounce(debounceKey, rawText)

    const existingThreadId = sessions.get(sessionKey)

    // Execute with Amp SDK
    const result = await runAmp(prompt, existingThreadId)

    // Store thread mapping for future messages
    if (result.threadId) {
      sessions.set(sessionKey, result.threadId)
    }

    // Send response (chunked if needed for Slack's 4000 char limit)
    const content =
      result.content || "I completed the task but have no response to share."
    await sendChunkedResponse(say, markdownToSlack(content), slackThreadTs)

    // Mark as complete
    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    console.error("Error processing message:", error)
    cancel(debounceKey)

    await say({
      text: `Sorry, I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`,
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
    console.log(`Unauthorized DM user: ${userId}`)
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

  try {
    inFlight.add(sessionKey)

    const prompt = await debounce(debounceKey, rawText)
    const existingThreadId = sessions.get(sessionKey)

    const result = await runAmp(prompt, existingThreadId)

    if (result.threadId) {
      sessions.set(sessionKey, result.threadId)
    }

    const content = result.content || "Done."
    await sendChunkedResponse(say, markdownToSlack(content), slackThreadTs)

    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    console.error("Error processing DM:", error)
    cancel(debounceKey)

    await say({
      text: `Sorry, I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`,
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
  console.log("⚡️ janebot is running!")
  console.log(`   Workspace: ${config.workspaceDir}`)
  console.log(`   Agent mode: ${config.agentMode}`)
  console.log(`   Debounce: ${config.debounceMs}ms`)
  if (config.allowedUserIds.length > 0) {
    console.log(`   Allowed users: ${config.allowedUserIds.length}`)
  }
  if (config.allowedChannelIds.length > 0) {
    console.log(`   Allowed channels: ${config.allowedChannelIds.length}`)
  }
  if (Object.keys(config.mcpServers).length > 0) {
    console.log(`   MCP servers: ${Object.keys(config.mcpServers).join(", ")}`)
  }
}

main().catch(console.error)
