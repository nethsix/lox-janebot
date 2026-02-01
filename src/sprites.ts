/**
 * Minimal Sprites API client for janebot.
 *
 * This is a lightweight REST client since the official @fly/sprites SDK
 * requires Node.js 24+. We only need create, exec, delete, and policy APIs.
 *
 * Uses WebSocket exec API for long-running commands (amp execution can take minutes).
 *
 * @see https://sprites.dev/api
 * @see https://sprites.dev/api/sprites/exec
 */

import { createHash } from "crypto"
import WebSocket from "ws"
import * as log from "./logger.js"

const API_BASE = "https://api.sprites.dev"
const WS_BASE = "wss://api.sprites.dev"

export interface SpriteInfo {
  id: string
  name: string
  organization: string
  url: string
  status: "cold" | "warm" | "running"
  created_at: string
  updated_at: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface NetworkPolicyRule {
  action: "allow" | "deny"
  domain: string
}

export interface Checkpoint {
  id: string
  create_time: string
  source_id?: string
  comment?: string
}

export class SpritesClient {
  private token: string
  private baseUrl: string

  constructor(token: string, baseUrl = API_BASE) {
    this.token = token
    this.baseUrl = baseUrl
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Sprites API error ${response.status}: ${text}`)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return response.json() as Promise<T>
  }

  /**
   * Generate a deterministic sprite name from a Slack thread.
   */
  static getSpriteName(channelId: string, threadTs: string): string {
    const hash = createHash("sha256")
      .update(`${channelId}:${threadTs}`)
      .digest("hex")
      .slice(0, 12)
    return `jane-${hash}`
  }

  /**
   * Get sprite info. Returns null if not found.
   */
  async get(name: string): Promise<SpriteInfo | null> {
    try {
      return await this.request<SpriteInfo>("GET", `/v1/sprites/${name}`)
    } catch (e) {
      if (e instanceof Error) {
        // 404 = sprite doesn't exist
        if (e.message.includes("404")) {
          return null
        }
        // 500 with "failed to retrieve" = sprite doesn't exist (API quirk)
        if (e.message.includes("500") && e.message.includes("failed to retrieve")) {
          return null
        }
      }
      throw e
    }
  }

  /**
   * Create a new sprite.
   */
  async create(name: string): Promise<SpriteInfo> {
    log.info("Creating sprite", { name })
    return this.request<SpriteInfo>("POST", "/v1/sprites", { name })
  }

  /**
   * Delete a sprite.
   */
  async delete(name: string): Promise<void> {
    log.info("Deleting sprite", { name })
    await this.request<void>("DELETE", `/v1/sprites/${name}`)
  }

  /**
   * Get or create a sprite for a Slack thread.
   */
  async getOrCreate(channelId: string, threadTs: string): Promise<SpriteInfo> {
    const name = SpritesClient.getSpriteName(channelId, threadTs)
    const existing = await this.get(name)
    if (existing) {
      return existing
    }

    const sprite = await this.create(name)

    // Apply default network policy - amp needs access to its API and LLM providers
    await this.setNetworkPolicy(name, [
      // Amp CLI and API
      { action: "allow", domain: "ampcode.com" },
      { action: "allow", domain: "*.ampcode.com" },
      { action: "allow", domain: "storage.googleapis.com" },
      { action: "allow", domain: "*.storage.googleapis.com" },
      // LLM APIs (direct and via Amp proxy)
      { action: "allow", domain: "api.anthropic.com" },
      { action: "allow", domain: "api.openai.com" },
      // CDN/infrastructure that amp might use
      { action: "allow", domain: "*.cloudflare.com" },
      { action: "allow", domain: "*.googleapis.com" },
    ])

    return sprite
  }

  /**
   * Execute a command in a sprite via WebSocket.
   *
   * Uses the WebSocket exec API which supports long-running commands.
   * Binary protocol: stream ID byte prefix (0=stdin, 1=stdout, 2=stderr, 3=exit, 4=stdin_eof)
   *
   * @see https://sprites.dev/api/sprites/exec
   */
  async exec(
    name: string,
    command: string[],
    options: { env?: Record<string, string>; dir?: string; stdin?: string; timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const params = new URLSearchParams()

    for (const cmd of command) {
      params.append("cmd", cmd)
    }

    // Enable stdin if we have input to send
    if (options.stdin) {
      params.append("stdin", "true")
    }

    if (options.dir) {
      params.append("dir", options.dir)
    }

    // Non-TTY mode, let it run after disconnect
    params.append("tty", "false")
    params.append("max_run_after_disconnect", "5m")

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        params.append("env", `${key}=${value}`)
      }
    }

    const url = `${WS_BASE}/v1/sprites/${name}/exec?${params.toString()}`
    
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 300000 // 5 minute default
      let stdout = ""
      let stderr = ""
      let exitCode = 0
      let resolved = false

      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      })

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          ws.close()
          // Include partial output info for debugging
          const debugInfo = {
            stdoutLen: stdout.length,
            stderrLen: stderr.length,
            stdoutPreview: stdout.slice(0, 1000),
            stderrPreview: stderr.slice(0, 500),
          }
          log.error("Sprites exec timeout", { name, timeoutMs, ...debugInfo })
          reject(new Error(`Sprites exec timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      ws.on("open", () => {
        // Send stdin if provided
        if (options.stdin) {
          // Binary frame: stream ID 0 (stdin) + data
          const stdinData = Buffer.from(options.stdin, "utf-8")
          const frame = Buffer.alloc(1 + stdinData.length)
          frame[0] = 0 // stdin stream ID
          stdinData.copy(frame, 1)
          ws.send(frame)
          
          // Send stdin EOF (stream ID 4)
          ws.send(Buffer.from([4]))
        }
      })

      ws.on("message", (data: Buffer) => {
        // Check if it's JSON (text message) or binary
        if (data[0] === 0x7b) { // '{' - JSON message
          try {
            const msg = JSON.parse(data.toString())
            if (msg.type === "exit") {
              exitCode = msg.exit_code ?? 0
            }
          } catch {
            // Not JSON, treat as binary
          }
          return
        }

        // Binary protocol: first byte is stream ID
        const streamId = data[0]
        const payload = data.subarray(1)

        switch (streamId) {
          case 1: // stdout
            stdout += payload.toString("utf-8")
            break
          case 2: // stderr
            stderr += payload.toString("utf-8")
            break
          case 3: // exit (payload is exit code byte)
            exitCode = payload[0] ?? 0
            break
        }
      })

      ws.on("close", () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve({ stdout, stderr, exitCode })
        }
      })

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(new Error(`Sprites WebSocket error: ${err.message}`))
        }
      })
    })
  }

  /**
   * Set network policy for a sprite.
   */
  async setNetworkPolicy(
    name: string,
    rules: NetworkPolicyRule[]
  ): Promise<void> {
    log.info("Setting network policy", { name, ruleCount: rules.length })
    await this.request("POST", `/v1/sprites/${name}/policy/network`, { rules })
  }

  /**
   * List all sprites with a given prefix.
   */
  async list(prefix?: string): Promise<SpriteInfo[]> {
    const params = new URLSearchParams()
    if (prefix) {
      params.append("prefix", prefix)
    }

    const result = await this.request<{ sprites: SpriteInfo[] }>(
      "GET",
      `/v1/sprites?${params.toString()}`
    )
    return result.sprites
  }

  /**
   * Download a file from a sprite as a Buffer.
   * Uses base64 encoding via cat to handle binary files.
   */
  async downloadFile(name: string, path: string): Promise<Buffer> {
    const result = await this.exec(name, [
      "bash",
      "-c",
      `base64 "${path}"`,
    ])

    if (result.exitCode !== 0) {
      throw new Error(`Failed to download file ${path}: ${result.stderr}`)
    }

    return Buffer.from(result.stdout.trim(), "base64")
  }

  /**
   * Clean up old sprites (inactive for more than maxAgeDays).
   */
  async cleanup(maxAgeDays = 7): Promise<number> {
    const sprites = await this.list("jane-")
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    let deleted = 0

    for (const sprite of sprites) {
      const updatedAt = new Date(sprite.updated_at).getTime()
      if (updatedAt < cutoff) {
        try {
          await this.delete(sprite.name)
          deleted++
        } catch (e) {
          log.error("Failed to delete sprite", e)
        }
      }
    }

    return deleted
  }

  /**
   * List checkpoints for a sprite.
   */
  async listCheckpoints(name: string): Promise<Checkpoint[]> {
    return this.request<Checkpoint[]>("GET", `/v1/sprites/${name}/checkpoints`)
  }

  /**
   * Create a checkpoint of the current sprite state.
   * Returns when complete (consumes the NDJSON stream).
   */
  async createCheckpoint(name: string, comment?: string): Promise<string> {
    log.info("Creating checkpoint", { name, comment })

    const url = `${this.baseUrl}/v1/sprites/${name}/checkpoint`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Checkpoint failed: ${response.status}: ${text}`)
    }

    // Parse NDJSON stream to find completion
    const text = await response.text()
    const lines = text.split("\n").filter((l) => l.trim())
    let checkpointId = ""

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (msg.type === "complete" && msg.data) {
          // Extract checkpoint ID from "Checkpoint v3 created successfully"
          const match = msg.data.match(/Checkpoint\s+(v\d+)/i)
          if (match) {
            checkpointId = match[1]
          }
        }
        if (msg.type === "error") {
          throw new Error(msg.error)
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }

    log.info("Checkpoint created", { name, checkpointId })
    return checkpointId
  }

  /**
   * Restore a sprite to a checkpoint.
   * Returns when complete (consumes the NDJSON stream).
   */
  async restoreCheckpoint(name: string, checkpointId: string): Promise<void> {
    log.info("Restoring checkpoint", { name, checkpointId })

    const url = `${this.baseUrl}/v1/sprites/${name}/checkpoints/${checkpointId}/restore`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Restore failed: ${response.status}: ${text}`)
    }

    // Consume NDJSON stream
    const text = await response.text()
    const lines = text.split("\n").filter((l) => l.trim())

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (msg.type === "error") {
          throw new Error(msg.error)
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }

    log.info("Checkpoint restored", { name, checkpointId })
  }

  /**
   * Copy a sprite's checkpoint to a new sprite.
   * Creates the new sprite and restores from the source's checkpoint.
   */
  async cloneFromCheckpoint(
    sourceName: string,
    checkpointId: string,
    newName: string
  ): Promise<SpriteInfo> {
    log.info("Cloning sprite from checkpoint", {
      source: sourceName,
      checkpoint: checkpointId,
      target: newName,
    })

    // Create new sprite
    const sprite = await this.create(newName)

    // Restore checkpoint from source
    // Note: This requires the checkpoint to be from the SAME sprite
    // The API doesn't support cross-sprite checkpoint restore directly
    // So we need a different approach - see ensureGoldenSprite

    return sprite
  }
}
