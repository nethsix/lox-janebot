/**
 * Sprite pool for faster first-message latency.
 *
 * Problem: First message in a new thread takes ~20s (create sprite + install amp).
 * Solution: Maintain a pool of warm sprites with amp pre-installed.
 *
 * Strategy:
 * 1. On startup, find/create pool sprites with amp installed
 * 2. When a new thread starts, claim a pool sprite for it
 * 3. Track the mapping: thread -> pool sprite name
 * 4. Replenish pool in background as sprites are claimed
 *
 * This reduces first-message latency from ~20s to ~2s.
 */

import { SpritesClient } from "./sprites.js"
import * as log from "./logger.js"

const POOL_PREFIX = "jane-pool-"
const AMP_BIN = "/home/sprite/.amp/bin/amp"

interface PooledSprite {
  name: string
  ready: boolean
}

// In-memory pool state
const pool: Map<string, PooledSprite> = new Map()
let clientRef: SpritesClient | null = null
let targetPoolSize = 2

/**
 * Initialize the sprite pool.
 * Finds existing pool sprites and warms new ones if needed.
 */
export async function initPool(
  client: SpritesClient,
  size: number = 2
): Promise<void> {
  clientRef = client
  targetPoolSize = size

  log.info("Initializing sprite pool", { targetSize: size })

  // Find existing pool sprites
  try {
    const existing = await client.list(POOL_PREFIX)

    for (const sprite of existing) {
      // Check if amp is installed
      try {
        const check = await client.exec(sprite.name, [
          "bash",
          "-c",
          `${AMP_BIN} --version 2>/dev/null || echo "NOT_INSTALLED"`,
        ])

        const ready = !check.stdout.includes("NOT_INSTALLED")
        pool.set(sprite.name, { name: sprite.name, ready })

        log.info("Found pool sprite", { name: sprite.name, ready })
      } catch (e) {
        log.error("Failed to check pool sprite", e)
      }
    }
  } catch (e) {
    log.error("Failed to list pool sprites", e)
  }

  // Create more if needed
  const readyCount = getPoolStats().ready
  const needed = size - readyCount

  if (needed > 0) {
    log.info("Pre-warming pool sprites", { count: needed })
    // Wait for at least one sprite to be ready before returning
    await warmPoolSprites(needed)
  }

  log.info("Sprite pool initialized", getPoolStats())
}

/**
 * Create and prepare pool sprites.
 */
async function warmPoolSprites(count: number): Promise<void> {
  if (!clientRef) return

  const promises: Promise<void>[] = []

  for (let i = 0; i < count; i++) {
    const name = `${POOL_PREFIX}${Date.now()}-${i}`
    promises.push(createWarmSprite(clientRef, name))
  }

  await Promise.allSettled(promises)
}

/**
 * Create a warm sprite with amp installed.
 */
async function createWarmSprite(
  client: SpritesClient,
  name: string
): Promise<void> {
  log.info("Creating warm pool sprite", { name })

  try {
    // Create sprite
    await client.create(name)

    // Apply network policy - amp needs access to its API and LLM providers
    await client.setNetworkPolicy(name, [
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

    // Install amp
    await client.exec(name, [
      "bash",
      "-c",
      "curl -fsSL https://ampcode.com/install.sh | bash",
    ])

    // Verify
    const check = await client.exec(name, [AMP_BIN, "--version"])
    if (check.exitCode !== 0) {
      throw new Error("Amp installation failed")
    }

    pool.set(name, { name, ready: true })
    log.info("Pool sprite ready", { name })
  } catch (e) {
    log.error("Failed to create pool sprite", e)
    // Try to clean up
    try {
      await client.delete(name)
    } catch {
      // Ignore
    }
  }
}

/**
 * Claim a ready sprite from the pool for a thread.
 * Returns the sprite name, or null if none available.
 * 
 * Once claimed, the sprite is removed from the pool entirely.
 * The session store will track it going forward.
 */
export function claimSprite(threadKey: string): string | null {
  for (const [name, sprite] of pool.entries()) {
    if (sprite.ready) {
      // Remove from pool - session store will track it now
      pool.delete(name)
      log.info("Claimed pool sprite", { name, thread: threadKey, remaining: pool.size })

      // Trigger background replenishment
      replenishInBackground()

      return name
    }
  }
  return null
}

/**
 * Verify a sprite is healthy by running a quick command.
 * Returns true if healthy, false if unresponsive.
 */
export async function healthCheck(
  client: SpritesClient,
  spriteName: string
): Promise<boolean> {
  try {
    log.info("Health check", { sprite: spriteName })
    const result = await client.exec(spriteName, ["echo", "ok"], { timeoutMs: 10000 })
    const healthy = result.exitCode === 0 && result.stdout.includes("ok")
    log.info("Health check result", { sprite: spriteName, healthy })
    return healthy
  } catch (e) {
    log.error("Health check failed", { sprite: spriteName, error: e })
    return false
  }
}

/**
 * Replenish pool in background.
 */
function replenishInBackground(): void {
  if (!clientRef) return

  const stats = getPoolStats()
  const needed = targetPoolSize - stats.ready

  if (needed > 0) {
    warmPoolSprites(needed).catch((e) =>
      log.error("Failed to replenish pool", e)
    )
  }
}

/**
 * Get pool statistics.
 */
export function getPoolStats(): {
  total: number
  ready: number
} {
  let ready = 0

  for (const sprite of pool.values()) {
    if (sprite.ready) {
      ready++
    }
  }

  return { total: pool.size, ready }
}
