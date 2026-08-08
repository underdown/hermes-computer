# Hermes Computer

Execute Hermes agent tools in sandboxed Cloudflare Computer workspaces instead of directly on the host. No untrusted code ever touches your server.

```
Lennox (Hermes brain)          Cloudflare (sandbox)
┌─────────────────┐           ┌──────────────────────────┐
│  Hermes Gateway  │──HTTP──▶│  hermes-computer Worker   │
│  - LLM calls     │         │  ┌──────────────────────┐ │
│  - Skill routing │         │  │  Tool Optimizer DO    │ │
│  - Session mgmt  │         │  │  (backend selection)  │ │
└─────────────────┘         │  └──────────┬───────────┘ │
                             │             │ route       │
                             │  ┌──────────▼───────────┐ │
                             │  │  Computer Workspace   │ │
                             │  │  Container: npm, pip, │ │
                             │  │    git, clang, PW     │ │
                             │  │  Isolate JS: safe eval│ │
                             │  │  Isolate Shell: grep, │ │
                             │  │    awk, jq, git       │ │
                             │  │  DOFS: SQLite VFS     │ │
                             │  └──────────────────────┘ │
                             └──────────────────────────┘
```

## Installation

```bash
git clone https://github.com/underdown/hermes-computer
cd hermes-computer/packages/bridge
npm install
npx wrangler deploy
```

## Tool endpoints

All endpoints accept `POST` with JSON body `{ args: {...}, userRequest: "..." }`.

| Tool | Endpoint | Backend | Description |
|---|---|---|---|
| `terminal` | `/tools/terminal` | Shell / Container | Execute shell commands |
| `read_file` | `/tools/read_file` | DOFS | Read workspace files |
| `write_file` | `/tools/write_file` | DOFS | Write workspace files |
| `execute_code` | `/tools/execute_code` | Isolate JS | Sandboxed JavaScript |
| `browser_*` | `/tools/browser_*` | Container + Playwright | Browser automation (coming) |

## Hermes plugin

Install the plugin to route all Hermes tool calls through the bridge:

```bash
cp -r packages/plugin ~/.hermes/plugins/hermes-computer
hermes plugins enable hermes-computer
hermes gateway restart
```

## Tool Optimizer

The DO at `tools.arapaholabs.com` learns which Computer backend to use for each request type. Container is slow to start but powerful. Isolate JS is fast and safe. The optimizer learns over time.

## Requirements

- Cloudflare Workers Paid plan
- Workers AI enabled
- Worker Loaders enabled
- Docker (for container backend)

## License

MIT
