import { SpritesClient } from "./sprites.js"
import { config } from "./config.js"
import * as log from "./logger.js"
import { acquireRunner } from "./sprite-runners.js"
import { getGitHubToken } from "./github-app.js"

const DEBUG_AMP_OUTPUT = process.env.DEBUG_AMP_OUTPUT === "1"

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SPRITE_EXEC_TIMEOUT_MS || "", 10)
const EXEC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : DEFAULT_EXEC_TIMEOUT_MS

const AMP_BIN = "/home/sprite/.amp/bin/amp"

interface AmpStreamMessage {
  type: "system" | "assistant" | "user" | "result"
  session_id: string
  subtype?: "init" | "success" | "error_during_execution" | "error_max_turns"
  result?: string
  error?: string
  is_error?: boolean
}

export interface SpriteExecutorOptions {
  prompt: string
  systemPrompt?: string
  userId: string
}

export interface GeneratedFile {
  path: string
  filename: string
  data?: Buffer
}

export interface SpriteExecutorResult {
  content: string
  threadId: string | undefined
  spriteName: string
  generatedFiles: GeneratedFile[]
}

export function parseAmpOutput(stdout: string): {
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

      if (msg.type === "assistant") {
        const message = msg.message as Record<string, unknown> | undefined
        const messageContent = message?.content as Array<Record<string, unknown>> | undefined
        if (messageContent) {
          for (const block of messageContent) {
            if (block.type === "tool_use" && block.name === "painter") {
              const input = block.input as Record<string, unknown> | undefined
              if (input?.savePath) {
                const filePath = String(input.savePath).replace(/^file:\/\//, "")
                const filename = filePath.split("/").pop() ?? "generated-image.png"
                if (!generatedFiles.some(f => f.path === filePath)) {
                  generatedFiles.push({ path: filePath, filename })
                }
              }
            }
          }
        }
      }

      if (msg.type === "user") {
        const message = msg.message as Record<string, unknown> | undefined
        const messageContent = message?.content as Array<Record<string, unknown>> | undefined
        if (messageContent) {
          for (const block of messageContent) {
            if (block.type === "tool_result") {
              let items: Array<Record<string, unknown>> = []

              if (typeof block.content === "string") {
                try {
                  const parsed = JSON.parse(block.content)
                  items = Array.isArray(parsed) ? parsed : [parsed]
                } catch {
                  // Not JSON
                }
              } else if (Array.isArray(block.content)) {
                items = block.content as Array<Record<string, unknown>>
              }

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

                  const existing = generatedFiles.find(f => f.path === filePath)
                  if (existing) {
                    if (imageData && !existing.data) {
                      existing.data = imageData
                    }
                  } else {
                    generatedFiles.push({ path: filePath, filename, data: imageData })
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Non-JSON line
    }
  }

  if (errorMsg && !content) {
    throw new Error(errorMsg)
  }

  return { threadId, content, generatedFiles }
}

export async function executeInSprite(
  options: SpriteExecutorOptions
): Promise<SpriteExecutorResult> {
  const token = config.spritesToken
  if (!token) {
    throw new Error("SPRITES_TOKEN not configured")
  }

  const spritesClient = new SpritesClient(token)
  const { name: spriteName, release } = await acquireRunner()

  try {
    log.info("Acquired runner", { sprite: spriteName })

    const settingsFile = "/tmp/amp-settings.json"
    const settings: Record<string, unknown> = {
      "amp.permissions": [{ tool: "*", action: "allow" }],
      "amp.git.commit.coauthor.enabled": false,
    }
    if (options.systemPrompt) {
      settings["amp.systemPrompt"] = options.systemPrompt
    }
    const jsonContent = JSON.stringify(settings).replace(/'/g, "'\\''")
    await spritesClient.exec(spriteName, [
      "bash", "-c",
      `printf '%s' '${jsonContent}' > ${settingsFile}`,
    ], { timeoutMs: 30000 })

    const args: string[] = [
      AMP_BIN,
      "--execute", "--stream-json",
      "--dangerously-allow-all",
      "--mode", config.agentMode,
      "--log-level", "warn",
      "--settings-file", settingsFile,
    ]

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
    env.AMP_API_KEY = ampApiKey

    let githubToken: string | undefined
    try {
      githubToken = await getGitHubToken()
    } catch (err) {
      log.warn("Failed to mint GitHub token, continuing without GitHub access", { error: err })
    }
    if (githubToken) {
      env.GH_TOKEN = githubToken
      await spritesClient.exec(spriteName, [
        "gh", "auth", "login", "--with-token",
      ], { env, stdin: githubToken, timeoutMs: 30000 })
      if (config.gitAuthorName) {
        const nameResult = await spritesClient.exec(spriteName, [
          "git", "config", "--global", "user.name", config.gitAuthorName,
        ], { timeoutMs: 10000 })
        if (nameResult.exitCode !== 0) {
          log.warn("Failed to set git user.name", { exitCode: nameResult.exitCode, stderr: nameResult.stderr })
        }
      }
      if (config.gitAuthorEmail) {
        const emailResult = await spritesClient.exec(spriteName, [
          "git", "config", "--global", "user.email", config.gitAuthorEmail,
        ], { timeoutMs: 10000 })
        if (emailResult.exitCode !== 0) {
          log.warn("Failed to set git user.email", { exitCode: emailResult.exitCode, stderr: emailResult.stderr })
        }
      }
      log.info("GitHub CLI and git identity configured in sprite", { sprite: spriteName })
    }

    log.info("Executing amp in sprite", {
      sprite: spriteName,
      timeoutMs: EXEC_TIMEOUT_MS,
    })

    const result = await spritesClient.exec(spriteName, args, {
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

    const { threadId, content, generatedFiles } = parseAmpOutput(result.stdout)

    if (generatedFiles.length > 0) {
      const fileSummary = generatedFiles.map(f => ({
        path: f.path,
        filename: f.filename,
        hasData: !!f.data,
        dataSize: f.data?.length,
      }))
      log.info("Found generated files", { count: generatedFiles.length, files: fileSummary })
    }

    return {
      content: content || "Done.",
      threadId,
      spriteName,
      generatedFiles,
    }
  } finally {
    await release()
    log.info("Released runner", { sprite: spriteName })
  }
}
