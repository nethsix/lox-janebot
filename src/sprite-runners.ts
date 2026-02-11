import { SpritesClient } from "./sprites.js"
import * as log from "./logger.js"

const AMP_BIN = "/home/sprite/.amp/bin/amp"
const RUNNER_PREFIX = "jane-runner-"

const NETWORK_POLICY = [
  { action: "allow" as const, domain: "ampcode.com" },
  { action: "allow" as const, domain: "*.ampcode.com" },
  { action: "allow" as const, domain: "storage.googleapis.com" },
  { action: "allow" as const, domain: "*.storage.googleapis.com" },
  { action: "allow" as const, domain: "api.anthropic.com" },
  { action: "allow" as const, domain: "api.openai.com" },
  { action: "allow" as const, domain: "*.cloudflare.com" },
  { action: "allow" as const, domain: "*.googleapis.com" },
  // GitHub API and web access
  { action: "allow" as const, domain: "github.com" },
  { action: "allow" as const, domain: "*.github.com" },
  { action: "allow" as const, domain: "api.github.com" },
  { action: "allow" as const, domain: "raw.githubusercontent.com" },
  { action: "allow" as const, domain: "objects.githubusercontent.com" },
]

const CLEAN_CHECKPOINT = "clean-v2"

interface Runner {
  name: string
  locked: boolean
}

let client: SpritesClient
const runners: Runner[] = []
const waitQueue: Array<(runner: Runner) => void> = []

export async function initRunners(
  spritesClient: SpritesClient,
  count = 2
): Promise<void> {
  client = spritesClient
  log.info("Initializing sprite runners", { count })

  const initPromises: Promise<void>[] = []
  for (let i = 0; i < count; i++) {
    initPromises.push(initRunner(i))
  }
  await Promise.all(initPromises)

  log.info("Sprite runners ready", getRunnerStats())
}

async function initRunner(index: number): Promise<void> {
  const name = `${RUNNER_PREFIX}${index}`
  const runner: Runner = { name, locked: false }
  runners.push(runner)

  const existing = await client.get(name)
  if (existing) {
    const checkpoints = await client.listCheckpoints(name)
    const hasClean = checkpoints.some((c) => c.comment === CLEAN_CHECKPOINT)
    if (hasClean) {
      log.info("Runner already set up with checkpoint", { name })
      try {
        await client.restoreCheckpoint(name, CLEAN_CHECKPOINT)
        return
      } catch (err) {
        log.warn("Checkpoint restore failed, will rebuild", { name, error: err })
      }
    } else {
      log.info("Runner exists but no clean checkpoint, rebuilding", { name })
    }
    await client.delete(name)
  }

  await buildRunner(name)
}

async function buildRunner(name: string): Promise<void> {
  log.info("Building runner", { name })
  await client.create(name)

  await client.exec(name, [
    "bash", "-c",
    "curl -fsSL https://ampcode.com/install.sh | bash",
  ], { timeoutMs: 120000 })

  await client.exec(name, [
    "bash", "-c",
    [
      "set -o pipefail",
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
      "sudo apt-get update -qq",
      "sudo apt-get install -y -qq gh",
    ].join(" && "),
  ], { timeoutMs: 120000 })

  const ver = await client.exec(name, [AMP_BIN, "--version"], { timeoutMs: 15000 })
  log.info("Runner amp installed", { name, version: ver.stdout.trim() })

  const ghVer = await client.exec(name, ["gh", "--version"], { timeoutMs: 15000 })
  log.info("Runner gh installed", { name, version: ghVer.stdout.split("\n")[0]?.trim() })

  await client.setNetworkPolicy(name, NETWORK_POLICY)
  await client.createCheckpoint(name, CLEAN_CHECKPOINT)
  log.info("Runner ready", { name })
}

async function rebuildRunner(runner: Runner): Promise<void> {
  log.warn("Rebuilding unhealthy runner", { name: runner.name })
  try {
    await client.delete(runner.name)
  } catch {
    // may already be gone
  }
  await buildRunner(runner.name)
}

async function healthCheck(name: string): Promise<boolean> {
  try {
    const result = await client.exec(name, ["echo", "ok"], { timeoutMs: 10000 })
    return result.exitCode === 0 && result.stdout.includes("ok")
  } catch {
    return false
  }
}

export async function acquireRunner(): Promise<{ name: string; release: () => Promise<void> }> {
  const runner = runners.find((r) => !r.locked)

  if (runner) {
    return lockRunner(runner)
  }

  return new Promise((resolve) => {
    waitQueue.push((r) => {
      lockRunner(r).then(resolve)
    })
  })
}

async function lockRunner(
  runner: Runner
): Promise<{ name: string; release: () => Promise<void> }> {
  runner.locked = true

  try {
    const healthy = await healthCheck(runner.name)
    if (!healthy) {
      await rebuildRunner(runner)
    }
  } catch (err) {
    runner.locked = false
    const next = waitQueue.shift()
    if (next) next(runner)
    throw err
  }

  const release = async () => {
    try {
      await client.restoreCheckpoint(runner.name, CLEAN_CHECKPOINT)
    } catch (err) {
      log.error("Failed to restore checkpoint, rebuilding", err)
      await rebuildRunner(runner)
    }
    runner.locked = false

    const next = waitQueue.shift()
    if (next) {
      next(runner)
    }
  }

  return { name: runner.name, release }
}

export function getRunnerStats(): { total: number; available: number } {
  return {
    total: runners.length,
    available: runners.filter((r) => !r.locked).length,
  }
}
