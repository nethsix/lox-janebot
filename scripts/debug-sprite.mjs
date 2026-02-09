import { SpritesClient } from "../dist/sprites.js"

const token = process.env.SPRITES_TOKEN
const ampKey = process.env.AMP_API_KEY
if (!token || !ampKey) {
  console.error("SPRITES_TOKEN and AMP_API_KEY required")
  process.exit(1)
}

const AMP_BIN = "/home/sprite/.amp/bin/amp"
const client = new SpritesClient(token)
const name = "jane-debug-test"

try {
  console.log("Creating sprite...")
  await client.create(name)

  await client.setNetworkPolicy(name, [
    { action: "allow", domain: "ampcode.com" },
    { action: "allow", domain: "*.ampcode.com" },
    { action: "allow", domain: "storage.googleapis.com" },
    { action: "allow", domain: "*.storage.googleapis.com" },
    { action: "allow", domain: "api.anthropic.com" },
    { action: "allow", domain: "api.openai.com" },
    { action: "allow", domain: "*.cloudflare.com" },
    { action: "allow", domain: "*.googleapis.com" },
  ])

  console.log("Installing amp...")
  await client.exec(name, ["bash", "-c", "curl -fsSL https://ampcode.com/install.sh | bash"], { timeoutMs: 120000 })

  const ver = await client.exec(name, [AMP_BIN, "--version"])
  console.log("Amp version:", ver.stdout.trim())

  const dns = await client.exec(name, ["bash", "-c", "getent hosts api.ampcode.com 2>&1 || echo DNS_FAILED"])
  console.log("DNS api.ampcode.com:", dns.stdout.trim())

  // Write settings via heredoc to avoid quoting issues
  await client.exec(name, ["bash", "-c",
    'cat > /tmp/amp-settings.json << \'EOF\'\n{"amp.permissions":[{"tool":"*","action":"allow"}]}\nEOF'
  ])

  const cat = await client.exec(name, ["cat", "/tmp/amp-settings.json"])
  console.log("Settings:", cat.stdout.trim())

  console.log("Running librarian test...")
  const result = await client.exec(name, [
    AMP_BIN, "--execute", "--stream-json", "--dangerously-allow-all",
    "--mode", "smart", "--log-level", "warn",
    "--settings-file", "/tmp/amp-settings.json",
  ], {
    env: {
      PATH: "/home/sprite/.amp/bin:/home/sprite/.local/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/sprite",
      NO_COLOR: "1",
      TERM: "dumb",
      CI: "true",
      AMP_API_KEY: ampKey,
    },
    stdin: "use the librarian to tell me what lox/janebot is\n",
    timeoutMs: 120000,
  })

  console.log("Exit:", result.exitCode)
  if (result.stderr) console.log("Stderr:", result.stderr.slice(0, 500))

  for (const line of result.stdout.split("\n").filter(Boolean)) {
    try {
      const m = JSON.parse(line)
      if (m.type === "result") {
        console.log("Subtype:", m.subtype)
        if (m.error) console.log("Error:", m.error)
        if (m.result) console.log("Result:", m.result.slice(0, 300))
      }
    } catch {}
  }

  await client.delete(name)
  console.log("Done")
} catch (e) {
  console.error(e)
  await client.delete(name).catch(() => {})
  process.exit(1)
}
