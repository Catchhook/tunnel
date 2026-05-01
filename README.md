# @catchhook/tunnel

CatchHook CLI for tunneling webhooks from CatchHook to your localhost.

## Installation

Zero-install:

```bash
npx @catchhook/tunnel --help
```

Global:

```bash
npm install -g @catchhook/tunnel
```

## Quick Start

### Permanent endpoint

```bash
npx @catchhook/tunnel start --endpoint ep_abc123 --port 3000
```

If no valid token is stored, the CLI launches browser auth automatically.

Headless options:

```bash
npx @catchhook/tunnel start --endpoint ep_abc123 --token chk_dev_xxx --port 3000
# or
CATCHHOOK_TOKEN=chk_dev_xxx npx @catchhook/tunnel start --endpoint ep_abc123 --port 3000
```

### Temporary endpoint

```bash
npx @catchhook/tunnel ep_abc123 --key tkey_abc123 --port 3000
```

## Commands

| Command | Description |
|---------|-------------|
| `catchhook-tunnel start ...` | Start tunnel (auto-auth for permanent endpoints) |
| `catchhook-tunnel endpoints` | List endpoints |
| `catchhook-tunnel auth login` | Explicit browser auth flow |
| `catchhook-tunnel auth whoami` | Verify token and account identity |
| `catchhook-tunnel auth token set/show/clear` | Manage stored token |

## `start` options

| Flag | Description | Default |
|------|-------------|---------|
| `--endpoint <id>` | Endpoint ID(s) to tunnel (repeatable) | — |
| `--all` | Tunnel all endpoints | `false` |
| `--new` | Create a new endpoint and tunnel it | `false` |
| `--port <n>` | Local port | `3000` |
| `--token <token>` | API token (also stored locally) | — |
| `--auth-code <code>` | One-time auth code from browser flow | — |
| `--no-browser` | Don’t auto-open browser for auth | `false` |
| `--host <host>` | CatchHook host | `catchhook.app` |
| `--key <tunnel_key>` | Anonymous tunnel mode | — |

## Development

```bash
cd packages/catchhook-tunnel
npm install
npm run dev -- --help
npm test
```
