/**
 * Execute Amp inside a Sprite sandbox.
 *
 * This provides per-thread isolation by running the amp CLI
 * inside a dedicated Sprite VM for each Slack thread.
 *
 * Security note: AMP_API_KEY is passed to the Sprite. This is a trade-off
 * for simplicity - the Sprite could theoretically access Amp APIs directly.
 * Future iteration could proxy the LLM API to keep the key local.
 */

import { SpritesClient } from "./sprites.js"
import { config } from "./config.js"
import * as log from "./logger.js"
import * as sessions from "./sessions.js"
import * as pool from "./sprite-pool.js"

// Track sprites that failed health checks (avoid retrying bad sprites)
const unhealthySprites = new Set<string>()

// Enable debug logging with DEBUG_AMP_OUTPUT=1
const DEBUG_AMP_OUTPUT = process.env.DEBUG_AMP_OUTPUT === "1"

// Timeout for amp execution (default 10 minutes, configurable via SPRITE_EXEC_TIMEOUT_MS)
const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SPRITE_EXEC_TIMEOUT_MS || "", 10)
const EXEC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0 
  ? parsedTimeout 
  : DEFAULT_EXEC_TIMEOUT_MS

// Cache of sprites that have amp installed (in-memory, rebuilt on restart)
const ampInstalledSprites = new Set<string>()

const AMP_BIN = "/home/sprite/.amp/bin/amp"

/**
 * JSON message from amp --stream-json output.
 */
interface AmpStreamMessage {
  type: "system" | "assistant" | "user" | "result"
  session_id: string
  subtype?: "init" | "success" | "error_during_execution" | "error_max_turns"
  result?: string
  error?: string
  is_error?: boolean
}

/**
 * Ensure amp CLI is installed in a Sprite.
 */
async function ensureAmpInstalled(
  client: SpritesClient,
  spriteName: string
): Promise<void> {
  if (ampInstalledSprites.has(spriteName)) {
    return
  }

  log.info("Checking amp installation", { sprite: spriteName })

  const check = await client.exec(spriteName, [
    "bash",
    "-c",
    `${AMP_BIN} --version 2>/dev/null || echo "NOT_INSTALLED"`,
  ], { timeoutMs: 30000 }) // 30s timeout for version check

  if (!check.stdout.includes("NOT_INSTALLED")) {
    ampInstalledSprites.add(spriteName)
    log.info("Amp CLI already installed", { sprite: spriteName })
    return
  }

  log.info("Installing amp CLI in sprite", { sprite: spriteName })
  await client.exec(spriteName, [
    "bash",
    "-c",
    "curl -fsSL https://ampcode.com/install.sh | bash",
  ], { timeoutMs: 120000 }) // 2 minute timeout for install

  ampInstalledSprites.add(spriteName)
  log.info("Amp CLI installed", { sprite: spriteName })
}

export interface SpriteExecutorOptions {
  channelId: string
  threadTs: string
  userId: string
  prompt: string
  systemPrompt?: string
}

export interface GeneratedFile {
  path: string
  filename: string
  data?: Buffer  // Base64-decoded image data (if available from amp output)
}

export interface SpriteExecutorResult {
  content: string
  threadId: string | undefined
  spriteName: string
  generatedFiles: GeneratedFile[]
}

/**
 * Parse amp --stream-json output to extract session_id, result, and generated files.
 */
function parseAmpOutput(stdout: string): {
  threadId: string | undefined
  content: string
  generatedFiles: GeneratedFile[]
} {
  if (DEBUG_AMP_OUTPUT) {
    log.info("Raw amp stdout", { length: stdout.length, preview: stdout.slice(0, 2000) })
  }

  let threadId: string | undefined
  let content = ""
  let errorMsg: string | undefined
  const generatedFiles: GeneratedFile[] = []

  const lines = stdout.split("\n").filter((line) => line.trim())

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>

      if (msg.session_id) {
        threadId = msg.session_id as string
      }

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.result) {
          content = msg.result as string
        } else if (msg.is_error && msg.error) {
          errorMsg = msg.error as string
        }
      }

      // Look for tool_use blocks with painter tool calls that have savePath
      if (msg.type === "assistant") {
        const message = msg.message as Record<string, unknown> | undefined
        const messageContent = message?.content as Array<Record<string, unknown>> | undefined
        if (messageContent) {
          for (const block of messageContent) {
            // Check for painter tool_use with savePath argument
            if (block.type === "tool_use" && block.name === "painter") {
              const input = block.input as Record<string, unknown> | undefined
              if (input?.savePath) {
                const filePath = String(input.savePath).replace(/^file:\/\//, "")
                const filename = filePath.split("/").pop() ?? "generated-image.png"
                if (!generatedFiles.some(f => f.path === filePath)) {
                  generatedFiles.push({ path: filePath, filename })
                  if (DEBUG_AMP_OUTPUT) {
                    log.info("Found painter tool_use with savePath", { filePath })
                  }
                }
              }
            }
          }
        }
      }

      // Look for tool_result blocks that contain savedPath (from painter tool)
      if (msg.type === "user") {
        const message = msg.message as Record<string, unknown> | undefined
        const messageContent = message?.content as Array<Record<string, unknown>> | undefined
        if (messageContent) {
          for (const block of messageContent) {
            if (block.type === "tool_result") {
              // Content is a JSON string: "[{\"type\":\"image\",\"data\":\"...\",\"savedPath\":\"...\"}]"
              let items: Array<Record<string, unknown>> = []
              
              if (typeof block.content === "string") {
                try {
                  const parsed = JSON.parse(block.content)
                  items = Array.isArray(parsed) ? parsed : [parsed]
                } catch {
                  // Not JSON, skip
                }
              } else if (Array.isArray(block.content)) {
                items = block.content as Array<Record<string, unknown>>
              }

              // Extract images: {type:"image", data:"base64...", savedPath:"file:///..."}
              for (const item of items) {
                if (item?.type === "image" && item.savedPath) {
                  const filePath = String(item.savedPath).replace(/^file:\/\//, "")
                  const filename = filePath.split("/").pop() ?? "generated-image.png"
                  
                  let imageData: Buffer | undefined
                  if (item.data && typeof item.data === "string") {
                    try {
                      imageData = Buffer.from(String(item.data), "base64")
                    } catch {
                      // Invalid base64
                    }
                  }
                  
                  // Update existing entry with data, or add new entry
                  const existing = generatedFiles.find(f => f.path === filePath)
                  if (existing) {
                    // tool_use added entry without data, now we have the actual image data
                    if (imageData && !existing.data) {
                      existing.data = imageData
                      if (DEBUG_AMP_OUTPUT) {
                        log.info("Updated image with data", { filePath, dataSize: imageData.length })
                      }
                    }
                  } else {
                    generatedFiles.push({ path: filePath, filename, data: imageData })
                    if (DEBUG_AMP_OUTPUT) {
                      log.info("Found image", { filePath, hasData: !!imageData, dataSize: imageData?.length })
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Non-JSON line - skip
    }
  }

  if (errorMsg && !content) {
    throw new Error(errorMsg)
  }

  return { threadId, content, generatedFiles }
}

/**
 * Execute an Amp prompt inside a Sprite sandbox.
 */
export async function executeInSprite(
  options: SpriteExecutorOptions
): Promise<SpriteExecutorResult> {
  const token = config.spritesToken
  if (!token) {
    throw new Error("SPRITES_TOKEN not configured")
  }

  const client = new SpritesClient(token)
  const threadKey = `${options.channelId}:${options.threadTs}`

  // Check if this thread already has a sprite (from session or pool)
  const existingSession = sessions.get(options.channelId, options.threadTs)
  let spriteName: string

  if (existingSession?.spriteName) {
    // Reuse existing sprite for this thread
    spriteName = existingSession.spriteName
    const sprite = await client.get(spriteName)
    log.info("Using existing sprite", { sprite: spriteName, status: sprite?.status ?? "unknown" })
  } else {
    // Try to claim a pre-warmed sprite from the pool
    const poolSprite = pool.claimSprite(threadKey)

    if (poolSprite) {
      // Use pool sprite - amp is already installed
      spriteName = poolSprite
      ampInstalledSprites.add(spriteName)
      log.info("Using pool sprite", { sprite: spriteName })
    } else {
      // Fall back to creating a new sprite
      const sprite = await client.getOrCreate(options.channelId, options.threadTs)
      spriteName = sprite.name
      log.info("Created new sprite", { sprite: spriteName, status: sprite.status })
    }
  }

  // Health check before proceeding (catches frozen/unresponsive sprites)
  const healthy = await pool.healthCheck(client, spriteName)
  if (!healthy) {
    unhealthySprites.add(spriteName)
    throw new Error(`Sprite ${spriteName} failed health check - may be frozen or unresponsive`)
  }

  // Ensure amp is installed (no-op if already installed or from pool)
  await ensureAmpInstalled(client, spriteName)

  // Write settings file with system prompt if provided (same pattern as SDK)
  const settingsFile = "/tmp/amp-settings.json"
  if (options.systemPrompt) {
    log.info("Writing settings file", { sprite: spriteName })
    const settings = {
      "amp.systemPrompt": options.systemPrompt,
    }
    // Use printf instead of stdin to avoid potential websocket stdin issues
    const jsonContent = JSON.stringify(settings).replace(/'/g, "'\\''")
    await client.exec(spriteName, [
      "bash",
      "-c",
      `printf '%s' '${jsonContent}' > ${settingsFile}`,
    ], { timeoutMs: 30000 })
    log.info("Settings file written", { sprite: spriteName })
  }

  // Build CLI args: amp [threads continue <id>] --execute --stream-json [options]
  const args: string[] = [AMP_BIN]

  if (existingSession?.ampThreadId) {
    args.push("threads", "continue", existingSession.ampThreadId)
  }

  args.push("--execute", "--stream-json")
  args.push("--dangerously-allow-all")
  args.push("--mode", config.agentMode)
  args.push("--log-level", "warn")

  if (options.systemPrompt) {
    args.push("--settings-file", settingsFile)
  }

  // Environment for amp
  const env: Record<string, string> = {
    PATH: `/home/sprite/.amp/bin:/home/sprite/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/home/sprite",
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "true",
  }

  const ampApiKey = process.env.AMP_API_KEY
  if (!ampApiKey) {
    throw new Error("AMP_API_KEY environment variable not set")
  }
  // SECURITY NOTE: AMP_API_KEY is passed via Sprites exec API query params.
  // This may be logged by infrastructure. Use a dedicated, least-privileged key.
  // Future: proxy LLM API calls locally to avoid exposing the key to sprites.
  env.AMP_API_KEY = ampApiKey

  log.info("Executing amp in sprite", {
    sprite: spriteName,
    hasExistingThread: !!existingSession?.ampThreadId,
    timeoutMs: EXEC_TIMEOUT_MS,
    args: args.join(" "),
  })

  // Execute via WebSocket, send prompt on stdin
  const result = await client.exec(spriteName, args, {
    env,
    stdin: options.prompt + "\n",
    timeoutMs: EXEC_TIMEOUT_MS,
  })

  if (DEBUG_AMP_OUTPUT) {
    log.info("Amp exec result", {
      exitCode: result.exitCode,
      stdoutLen: result.stdout.length,
      stderrLen: result.stderr.length,
      stderrPreview: result.stderr.slice(0, 500),
    })
  }

  // Parse JSON output
  const { threadId, content, generatedFiles } = parseAmpOutput(result.stdout)

  if (generatedFiles.length > 0) {
    // Log file info without the binary data
    const fileSummary = generatedFiles.map(f => ({
      path: f.path,
      filename: f.filename,
      hasData: !!f.data,
      dataSize: f.data?.length,
    }))
    log.info("Found generated files", { count: generatedFiles.length, files: fileSummary })
  }

  // Store session for thread continuity
  if (threadId) {
    sessions.set(
      options.channelId,
      options.threadTs,
      threadId,
      options.userId,
      spriteName
    )
    log.info("Session stored", {
      slack: `${options.channelId}:${options.threadTs}`,
      ampThread: threadId,
    })
  }

  return {
    content: content || "Done.",
    threadId,
    spriteName,
    generatedFiles,
  }
}
