# Security & Isolation Model

This document describes the threat model and isolation strategies for janebot's multi-user environment.

## Execution Model

Jane runs inside [Sprites](https://sprites.dev) — persistent, hardware-isolated Linux VMs (Firecracker microVMs). A pool of runner sprites is maintained with checkpoint/restore for clean state between requests.

```
Request → Acquire runner → Execute amp → Restore checkpoint → Release runner
```

Each request gets a clean filesystem via checkpoint restore. No state persists between requests.

## Runner Pool Architecture

```
┌─────────────────────────────────────────────────┐
│                 Runner Pool                      │
├─────────────────────────────────────────────────┤
│                                                  │
│  Startup:                                        │
│    1. Create N sprites (jane-runner-0, etc.)     │
│    2. Install amp CLI                            │
│    3. Checkpoint clean state                     │
│                                                  │
│  Per request:                                    │
│    1. Acquire an idle runner (or queue)           │
│    2. Health check (rebuild if unhealthy)         │
│    3. Write settings, execute amp                │
│    4. Restore to clean checkpoint                │
│    5. Release runner back to pool                │
│                                                  │
└─────────────────────────────────────────────────┘
```

## Threat Model

### Cross-User Risks

| Attack Vector | Mitigation |
|---------------|------------|
| Filesystem access across requests | Checkpoint restore wipes state between requests |
| Prompt injection to bypass rules | Defence in depth via system prompt |
| Network exfiltration | Network policy restricts egress to allowlisted domains |

### Tool Risks

| Tool | Risk Level | Notes |
|------|------------|-------|
| `Bash` | 🔴 High | Shell access, contained by Sprite isolation |
| `Read`, `glob`, `Grep` | 🟡 Medium | Scoped to Sprite filesystem (clean each request) |
| `create_file`, `edit_file` | 🟡 Medium | Scoped to Sprite filesystem (clean each request) |
| `find_thread`, `read_thread` | 🟡 Medium | Cross-thread search via Amp API |

## Network Policy

Runner sprites are restricted to necessary egress only:

```
ampcode.com, *.ampcode.com       — Amp CLI and API
storage.googleapis.com           — Amp artifact storage
api.anthropic.com                — LLM API
api.openai.com                   — LLM API
*.cloudflare.com, *.googleapis.com — CDN/infrastructure
```

All other outbound traffic is denied.

## Security Trade-offs

### AMP_API_KEY in Sprites

The `AMP_API_KEY` is passed to Sprite VMs via the exec API. This means:
- The key is visible inside the Sprite during execution
- A malicious prompt could theoretically extract it

Mitigations:
- Use a dedicated, least-privileged API key
- Network policy limits where extracted keys could be sent
- Future: proxy LLM API calls locally to keep the key out of Sprites entirely

## Configuration

One execution environment must be configured:

```bash
# Option 1: Sprites sandbox (recommended)
SPRITES_TOKEN=your-sprites-token

# Option 2: Local execution (unsandboxed, for trusted single-user setups only)
ALLOW_LOCAL_EXECUTION=true
```

When `SPRITES_TOKEN` is set, requests execute in isolated Sprite VMs with checkpoint/restore. Local execution requires explicit opt-in and provides no isolation.
