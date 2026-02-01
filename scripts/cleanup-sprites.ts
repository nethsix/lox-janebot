#!/usr/bin/env npx tsx
/**
 * Clean up test sprites.
 * Run with: npx tsx scripts/cleanup-sprites.ts
 */

import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"

const token = process.env.SPRITES_TOKEN
if (!token) {
  console.error("❌ SPRITES_TOKEN not set")
  process.exit(1)
}

const client = new SpritesClient(token)

async function main() {
  const prefix = process.argv[2] || "jane-test-"
  const sprites = await client.list(prefix)
  console.log(`Found ${sprites.length} sprites with prefix "${prefix}" to clean up`)

  for (const s of sprites) {
    await client.delete(s.name)
    console.log(`Deleted ${s.name}`)
  }

  console.log("Done")
}

main().catch(console.error)
