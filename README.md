# WhisperNet

A fast, minimalist, zero-account anonymous messaging board where all messages automatically expire after 30 minutes.

WhisperNet is built for instant real-time delivery over WebSockets with automatic HTTP fallback, pure in-memory ephemeral storage, and smooth 60fps performance even on older mobile devices and slow connections.

---

## Features

- **Pure Anonymous Messaging**: No sign-up, accounts, profiles, or tracking cookies.
- **30-Minute Auto-Destruct**: Every message is kept only in server RAM (capped at 500 active messages) and automatically purged after 30 minutes (`TTL_MS = 1,800,000 ms`).
- **Low-Latency WebSockets + Fallback**:
  - Real-time `/ws` stream with `perMessageDeflate: false`, `TCP_NODELAY`, and TCP keep-alive.
  - Client-side `ping`/`pong` watchdog (3.5s) to detect half-open mobile sockets and reconnect immediately.
  - Automatic HTTP fallback (`POST /api/messages`) and offline message queue with automatic flush on reconnect.
  - Multi-tab synchronization via `BroadcastChannel`.
- **Safe External Link Guard**: Detects `http://`, `https://`, and `www.` links inline and prompts an English confirmation modal before opening third-party URLs (`noopener,noreferrer`).
- **Low-End Device & Mobile Optimizations**:
  - Progressive DOM windowing (renders the latest 80 messages by default and loads older ones on scroll/demand).
  - Non-blocking Google Fonts loading and `content-visibility: auto` containment.
  - Dynamic `visualViewport` adaptation for mobile virtual keyboards and safe-area insets.
  - Installable PWA support (`vite-plugin-pwa`).

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS v4, `vite-plugin-pwa`
- **Backend**: Node.js, Express, `ws` (`tsx` runtime)
- **Edge Alternative**: Optional Cloudflare Workers + Durable Objects configuration (`cloudflare-worker.js`, `wrangler.toml`, see `DEPLOYMENT.md`)

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
npm install
```

### Development

Start the combined Express + WebSocket + Vite development server on port `3000`:

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

### Production Build & Run

Build the frontend bundle into `./dist` and run the server in production mode:

```bash
npm run build
NODE_ENV=production npm run start
```

### Type Checking

```bash
npm run lint
```

---

## Configuration

Create a `.env` file if you need to override defaults (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket server port |
| `ALLOWED_ORIGINS` | `*` | Comma-separated allowed CORS origins (or `*`) |
| `NODE_ENV` | `development` | Set to `production` to serve static files from `./dist` |

---

## API & WebSocket Reference

### WebSocket (`/ws`)

- **Server → Client**:
  - `messages:sync`: Initial or periodic sync of active messages
  - `message:created`: Broadcast when another client posts a message
  - `message:ack`: Confirmation sent back to the sender
  - `pong`: Heartbeat response
- **Client → Server**:
  - `message:send`: `{ type: "message:send", id, content }` (max 2,000 characters)
  - `ping`: `{ type: "ping" }`

### REST Endpoints

- `GET /api/messages` — Returns all active messages created within the last 30 minutes.
- `POST /api/messages` — Posts a message (`{ id?, content }`) when using HTTP fallback.

---

## Project Structure

- `server.ts` — Express + WebSocket server and in-memory 30-minute TTL store
- `src/App.tsx` — Message stream UI, WebSocket client, link guard modal, and mobile viewport handling
- `src/index.css` — Tailwind v4 base styles, touch scroll rules, and reduced-motion support
- `src/ErrorBoundary.tsx` — Runtime error recovery and stale service-worker cleanup
- `index.html` — Dark-canvas HTML entry point with async font loading
- `vite.config.ts` — Vite + Tailwind + PWA build configuration
