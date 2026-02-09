/**
 * Persistent session store for Slack thread → Amp thread mapping.
 *
 * Stores mappings in a JSON file so they survive restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import * as log from "./logger.js"

export interface Session {
  ampThreadId: string
  spriteName?: string
  userId: string
  createdAt: string
  updatedAt: string
  lastSlackContextTs?: string
}

export interface SessionStore {
  sessions: Record<string, Session>
}

const DEFAULT_STORE_PATH = join(
  process.env.HOME ?? "/tmp",
  ".janebot",
  "sessions.json"
)

let storePath = process.env.SESSIONS_FILE ?? DEFAULT_STORE_PATH
let store: SessionStore = { sessions: {} }
let dirty = false

/**
 * Load sessions from disk.
 */
export function load(path?: string): void {
  if (path) {
    storePath = path
  }

  if (!existsSync(storePath)) {
    log.info("No existing sessions file, starting fresh", { path: storePath })
    store = { sessions: {} }
    return
  }

  try {
    const data = readFileSync(storePath, "utf-8")
    store = JSON.parse(data)
    log.info("Loaded sessions", {
      path: storePath,
      count: Object.keys(store.sessions).length,
    })
  } catch (e) {
    log.error("Failed to load sessions, starting fresh", e)
    store = { sessions: {} }
  }
}

/**
 * Save sessions to disk.
 */
export function save(): void {
  if (!dirty) return

  try {
    const dir = dirname(storePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(storePath, JSON.stringify(store, null, 2))
    dirty = false
  } catch (e) {
    log.error("Failed to save sessions", e)
  }
}

/**
 * Get session key from channel and thread.
 */
function getKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`
}

/**
 * Get session for a Slack thread.
 */
export function get(channelId: string, threadTs: string): Session | undefined {
  return store.sessions[getKey(channelId, threadTs)]
}

/**
 * Set session for a Slack thread.
 */
export function set(
  channelId: string,
  threadTs: string,
  ampThreadId: string,
  userId: string,
  spriteName?: string
): void {
  const key = getKey(channelId, threadTs)
  const existing = store.sessions[key]
  const now = new Date().toISOString()

  store.sessions[key] = {
    ampThreadId,
    spriteName,
    userId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  dirty = true
  // Debounce saves - don't write on every update
  scheduleSave()
}

/**
 * Update just the Amp thread ID for an existing session.
 */
export function updateAmpThreadId(
  channelId: string,
  threadTs: string,
  ampThreadId: string
): void {
  const key = getKey(channelId, threadTs)
  const existing = store.sessions[key]
  if (existing) {
    existing.ampThreadId = ampThreadId
    existing.updatedAt = new Date().toISOString()
    dirty = true
    scheduleSave()
  }
}

/**
 * Update the last Slack context timestamp for a session.
 */
export function updateLastSlackContextTs(
  channelId: string,
  threadTs: string,
  ts: string
): void {
  const key = getKey(channelId, threadTs)
  const existing = store.sessions[key]
  if (existing) {
    existing.lastSlackContextTs = ts
    existing.updatedAt = new Date().toISOString()
    dirty = true
    scheduleSave()
  }
}

/**
 * Get all sessions (for debugging/admin).
 */
export function getAll(): Record<string, Session> {
  return { ...store.sessions }
}

/**
 * Clear old sessions (older than maxAgeDays).
 */
export function cleanup(maxAgeDays = 30): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let removed = 0

  for (const [key, session] of Object.entries(store.sessions)) {
    const updatedAt = new Date(session.updatedAt).getTime()
    if (updatedAt < cutoff) {
      delete store.sessions[key]
      removed++
    }
  }

  if (removed > 0) {
    dirty = true
    save()
    log.info("Cleaned up old sessions", { removed })
  }

  return removed
}

// Debounced save
let saveTimeout: ReturnType<typeof setTimeout> | null = null

function scheduleSave(): void {
  if (saveTimeout) return
  saveTimeout = setTimeout(() => {
    save()
    saveTimeout = null
  }, 1000)
}

// Save on exit
process.on("beforeExit", save)
process.on("SIGINT", () => {
  save()
  process.exit(0)
})
process.on("SIGTERM", () => {
  save()
  process.exit(0)
})
