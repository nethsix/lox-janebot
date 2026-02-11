import "dotenv/config"

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface JanebotConfig {
  // Amp settings
  workspaceDir: string
  agentMode: "smart" | "rush" | "deep"

  // Behavior
  debounceMs: number
  maxResponseLength: number

  // Authorization (empty arrays = allow all)
  allowedUserIds: string[]
  allowedChannelIds: string[]

  // MCP servers
  mcpServers: Record<string, McpServerConfig>

  // Sprites (required for sandboxed execution)
  spritesToken: string | undefined

  // Git identity for commits made in sprites
  gitAuthorName: string | undefined
  gitAuthorEmail: string | undefined

  // Local execution (requires explicit opt-in, no sandbox)
  allowLocalExecution: boolean
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseMcpServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  const mcpConfig = process.env.MCP_SERVERS

  if (!mcpConfig) return servers

  // Format: "name1:command1:arg1,arg2;name2:command2:arg1"
  for (const entry of mcpConfig.split(";")) {
    const [name, command, ...args] = entry.split(":")
    if (name && command) {
      servers[name.trim()] = {
        command: command.trim(),
        args: args.length > 0 ? args[0].split(",").map((a) => a.trim()) : undefined,
      }
    }
  }

  return servers
}

export const config: JanebotConfig = {
  workspaceDir: process.env.WORKSPACE_DIR ?? process.cwd(),
  agentMode: (process.env.AGENT_MODE ?? "smart") as "smart" | "rush" | "deep",
  debounceMs: parseInt(process.env.DEBOUNCE_MS ?? "1500", 10),
  maxResponseLength: parseInt(process.env.MAX_RESPONSE_LENGTH ?? "10000", 10),
  allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
  allowedChannelIds: parseList(process.env.ALLOWED_CHANNEL_IDS),
  mcpServers: parseMcpServers(),
  spritesToken: process.env.SPRITES_TOKEN,
  gitAuthorName: process.env.GIT_AUTHOR_NAME,
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL,
  allowLocalExecution: process.env.ALLOW_LOCAL_EXECUTION === "true",
}

/**
 * Check if a user is authorized to use the bot.
 */
export function isUserAllowed(userId: string): boolean {
  if (config.allowedUserIds.length === 0) return true
  return config.allowedUserIds.includes(userId)
}

/**
 * Check if a channel is authorized for bot usage.
 */
export function isChannelAllowed(channelId: string): boolean {
  if (config.allowedChannelIds.length === 0) return true
  return config.allowedChannelIds.includes(channelId)
}
