# @catchhook/tunnel

CatchHook CLI — tunnel webhooks from vendor services (Stripe, GitHub, etc.) to your localhost while CatchHook captures and displays the data in its dashboard.

## Installation

**Zero-install (recommended):**
```bash
npx @catchhook/tunnel --help
```

**Global install:**
```bash
npm install -g @catchhook/tunnel
```

## Quick Start

### Authenticated Tunnel (paid accounts)

```bash
# 1. Authenticate with your CatchHook account
catchhook-tunnel login

# 2. Start a tunnel — forwards webhooks to localhost:3000
catchhook-tunnel start --port 3000

# 3. Copy the webhook URL shown in your terminal and paste it
#    into your vendor's webhook configuration (e.g. Stripe dashboard)
```

### Anonymous Tunnel (temporary endpoints)

Visit [catchhook.app](https://catchhook.app) to create a free temporary endpoint. Copy the `npx` command shown on the page:

```bash
npx @catchhook/tunnel <endpoint_id> --key <tunnel_key> --port 3000
```

No login required — webhooks are captured for 48 hours.

## Commands

| Command | Description |
|---------|-------------|
| `catchhook-tunnel login` | Authenticate via browser (or manual token entry) |
| `catchhook-tunnel logout` | Clear stored authentication |
| `catchhook-tunnel endpoints` | List your endpoints |
| `catchhook-tunnel start [endpoint_id]` | Start a tunnel to localhost |
| `catchhook-tunnel start <id> --key <key>` | Anonymous tunnel (no login needed) |

### `start` Options

| Flag | Description | Default |
|------|-------------|---------|
| `--port <n>` | Local port to forward webhooks to | `3000` |
| `--host <h>` | CatchHook server host (for development) | `catchhook.app` |
| `--key <k>` | Anonymous tunnel key (from temp endpoint page) | — |

## How It Works

1. The CLI authenticates with CatchHook (via API token or anonymous tunnel key)
2. It opens a WebSocket connection to CatchHook's server
3. When a vendor sends a webhook to your CatchHook URL, CatchHook:
   - Captures the full request (headers, body, metadata) for the dashboard
   - Sends the raw data over WebSocket to your CLI in real-time
4. The CLI replays the webhook to your localhost, preserving:
   - Original HTTP method, headers, and body (byte-identical for signature verification)
   - Original IP address via `X-Forwarded-For` header
5. Connection drops auto-reconnect with exponential backoff

## Plan Limits

| Plan | Concurrent Tunnels |
|------|-------------------|
| Anonymous (temp) | Unlimited (per endpoint) |
| Pro | 1 |
| Business | 5 |

---

## Development Guide

This section is for developers working on the `@catchhook/tunnel` package itself.

### Prerequisites

- Node.js 18+
- Local CatchHook Rails app running (`bin/dev` on port 3100)
- Ruby 3.0+ (for the Rails backend)

### Setup

```bash
cd packages/catchhook-tunnel
npm install

# Create local dev config
cp .env.development.example .env.development
```

The `.env.development` file sets:
```
CATCHHOOK_HOST=catchhook.localhost:3100
```

This ensures the CLI talks to your local Rails instance, not production. The `.env.development` file is in `.gitignore` and never included in the published npm package.

### Running Locally

Use `npm run dev` which runs via `tsx` with the `.env.development` file loaded automatically:

```bash
# Login against local Rails
npm run dev -- login

# List endpoints
npm run dev -- endpoints

# Start authenticated tunnel
npm run dev -- start --port 4000

# Start anonymous tunnel (get the key from the local anonymous page)
npm run dev -- start ep_xxxxx --key tkey_xxxxx --port 4000
```

### Testing the Full Flow

1. **Start Rails:**
   ```bash
   bin/dev
   ```

2. **Start the CLI tunnel:**
   ```bash
   cd packages/catchhook-tunnel
   npm run dev -- start --port 4000
   ```

3. **Send a test webhook** (in another terminal):
   ```bash
   curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"event": "test", "data": {"id": 123}}' \
     http://catchhook.localhost:3100/w/<endpoint_id>
   ```

4. **Verify:**
   - The CLI terminal should show the incoming webhook
   - The CatchHook dashboard should display the captured request
   - Your local server on port 4000 should receive the forwarded request

There's also an automated smoke test script:
```bash
CATCHHOOK_API_TOKEN=chk_dev_xxx ./scripts/test-tunnel-flow.sh
```

### Building

```bash
# Build for production
npm run build

# Output goes to dist/
ls dist/
```

### Publishing to npm

The package is configured for the `@catchhook` npm org scope. To publish:

```bash
# Ensure you're logged in to npm with access to @catchhook org
npm login

# Build and publish
npm run build
npm publish --access public
```

The `files` field in `package.json` ensures only `dist/`, `README.md`, and `LICENSE` are included — no dev configs, source code, or `.env` files leak into the published package.

### Architecture

```
src/
  index.ts              # CLI entry point (commander.js)
  commands/
    login.ts            # Browser-based auth with local callback server
    logout.ts           # Clear stored credentials
    endpoints.ts        # List endpoints via API
    start.ts            # Main tunnel command
  lib/
    api-client.ts       # REST API client for CatchHook v1 API
    cable-client.ts     # ActionCable WebSocket client for tunnel data
    config.ts           # Persistent config storage (~/.catchhook/config.json)
    constants.ts        # Host/protocol helpers
    forwarder.ts        # Replay webhooks to localhost
    ui.ts               # Terminal UI helpers (banners, colors, logs)
```

### Key Design Decisions

- **WebSocket via ActionCable**: Uses Rails' ActionCable protocol for real-time webhook delivery. The `@rails/actioncable` npm package handles the protocol; `ws` provides the Node.js WebSocket implementation.
- **One-time ticket auth**: WebSocket connections authenticate via a short-lived ticket (30s, single-use) obtained from a REST endpoint. This avoids long-lived tokens in WebSocket URLs.
- **Base64 body encoding**: Webhook bodies are Base64-encoded for binary safety over JSON WebSocket frames. The CLI decodes them before replaying to localhost.
- **Fresh consumer on reconnect**: ActionCable consumers are bound to their URL at creation time. On disconnect, the CLI creates a completely new consumer with a fresh ticket rather than attempting to reuse the old one.
