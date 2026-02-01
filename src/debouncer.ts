/**
 * Message debouncer - combines rapid messages from the same user/thread
 * into a single prompt to avoid multiple agent executions.
 */

interface PendingMessage {
  texts: string[]
  timer: ReturnType<typeof setTimeout>
  resolve: (combined: string) => void
}

const pending = new Map<string, PendingMessage>()

const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS ?? "1500", 10)

/**
 * Queue a message for debouncing. Returns a promise that resolves
 * with the combined message text after the debounce window.
 *
 * @param key - Unique key for the conversation (e.g., "channel:thread:user")
 * @param text - The message text to queue
 * @returns Promise that resolves with combined message text
 */
export function debounce(key: string, text: string): Promise<string> {
  const existing = pending.get(key)

  if (existing) {
    // Add to existing queue
    existing.texts.push(text)
    clearTimeout(existing.timer)

    // Reset timer
    existing.timer = setTimeout(() => flush(key), DEBOUNCE_MS)

    // Return the same promise
    return new Promise((resolve) => {
      const original = existing.resolve
      existing.resolve = (combined) => {
        original(combined)
        resolve(combined)
      }
    })
  }

  // Create new queue
  return new Promise((resolve) => {
    const timer = setTimeout(() => flush(key), DEBOUNCE_MS)
    pending.set(key, {
      texts: [text],
      timer,
      resolve,
    })
  })
}

/**
 * Flush the pending messages for a key and resolve the promise.
 */
function flush(key: string): void {
  const entry = pending.get(key)
  if (!entry) return

  pending.delete(key)
  const combined = entry.texts.join("\n\n")
  entry.resolve(combined)
}

/**
 * Check if there are pending messages for a key.
 */
export function hasPending(key: string): boolean {
  return pending.has(key)
}

/**
 * Cancel pending messages for a key (e.g., on error).
 */
export function cancel(key: string): void {
  const entry = pending.get(key)
  if (entry) {
    clearTimeout(entry.timer)
    pending.delete(key)
  }
}
