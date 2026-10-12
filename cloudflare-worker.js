// Cloudflare Worker + Durable Object (Ephemeral Public Board - 30-Minute TTL Zero-Trace Architecture)
// Strictly Anonymous, Pure-Text Single Global Stream, Blank Title ("ㅤ"), Installable PWA, Forced HTTPS

const TTL_MS = 30 * 60 * 1000; // Strict 30-Minute Ephemeral Message Lifetime
const MAX_MESSAGES_IN_RAM = 500;
const STORAGE_KEY_MESSAGES = 'ephemeral_public_messages_v1';

// 1x1 Solid Dark (#09090b) PNG Base64 for Lightweight Edge Fallback Icon Serving
const SOLID_DARK_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SOLID_DARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#09090b"/></svg>`;

const WEB_MANIFEST = {
  id: '/',
  name: 'ㅤ',
  short_name: 'ㅤ',
  description: 'ㅤ',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#09090b',
  theme_color: '#09090b',
  icons: [
    {
      src: '/icon.svg',
      sizes: '192x192 512x512',
      type: 'image/svg+xml',
      purpose: 'any',
    },
    {
      src: '/pwa-192x192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/pwa-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/pwa-maskable-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};

const SERVICE_WORKER_JS = `
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
`;

function getCorsHeaders(request, env) {
  const allowedRaw = (env && env.ALLOWED_ORIGINS) || '*';
  const origin = request ? request.headers.get('Origin') : '*';
  let allowOrigin = '*';
  if (allowedRaw !== '*') {
    const allowedList = allowedRaw.split(',').map((s) => s.trim());
    if (origin && allowedList.includes(origin)) {
      allowOrigin = origin;
    } else if (allowedList.length > 0) {
      allowOrigin = allowedList[0];
    }
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  };
}

function jsonResponse(data, status = 200, request = null, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...getCorsHeaders(request, env),
    },
  });
}

// Embedded Self-Contained Single-File HTML/Tailwind/JS Frontend (Fallback if ASSETS binding is not used)
const EMBEDDED_HTML = `<!doctype html>
<html lang="en" class="dark h-dvh w-full max-w-full overflow-hidden">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>ㅤ</title>
  <meta name="description" content="ㅤ" />
  <meta property="og:title" content="ㅤ" />
  <meta property="og:description" content="ㅤ" />
  <meta name="theme-color" content="#09090b" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="ㅤ" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  <script>
    (function () {
      var h = window.location.hostname;
      var isLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
      if (!isLocal && window.location.protocol === 'http:') {
        window.location.replace('https://' + window.location.host + window.location.pathname + window.location.search + window.location.hash);
      }
    })();
  </script>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-dvh w-full max-w-full overflow-hidden bg-zinc-950 text-zinc-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
  <div id="app-shell" class="h-dvh w-full max-w-full flex flex-col items-center overflow-hidden bg-zinc-950">
    <div id="messages" class="flex-1 min-h-0 w-full max-w-4xl overflow-y-auto overflow-x-hidden px-3 py-3 sm:px-6 sm:py-5 space-y-2"></div>
    <div class="shrink-0 w-full border-t border-zinc-900/90 bg-zinc-950/95 backdrop-blur-md flex justify-center pb-[env(safe-area-inset-bottom)]">
      <form id="composer" class="w-full max-w-4xl px-2.5 py-2.5 sm:px-6 sm:py-3.5 flex items-end gap-2">
        <textarea id="input" rows="1" maxlength="2000" placeholder="Write a message..." class="min-w-0 flex-1 max-h-36 resize-none overflow-y-auto px-3.5 py-2.5 text-base sm:text-sm leading-relaxed bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-700"></textarea>
        <button type="submit" class="h-[42px] sm:h-[40px] px-4 sm:px-5 text-sm font-medium bg-zinc-100 hover:bg-white active:scale-[0.98] text-zinc-950 rounded-xl transition-all shrink-0 cursor-pointer select-none">Send</button>
      </form>
    </div>
  </div>
  <script>
    document.title = 'ㅤ';
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const TTL_MS = 30 * 60 * 1000;
    const appShell = document.getElementById('app-shell');
    const messagesEl = document.getElementById('messages');
    const formEl = document.getElementById('composer');
    const inputEl = document.getElementById('input');
    let messages = [];
    let isNearBottom = true;
    let activeWs = null;

    if (window.visualViewport) {
      const syncViewport = () => {
        appShell.style.height = window.visualViewport.height + 'px';
        if (isNearBottom) {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      };
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }

    messagesEl.addEventListener('scroll', () => {
      const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      isNearBottom = dist <= 120;
    }, { passive: true });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 144) + 'px';
    });

    function formatRemaining(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      return m + ':' + sec;
    }

    function upsertMessage(msg) {
      if (!msg || !msg.id) return;
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) {
        messages[idx] = msg;
      } else {
        messages.push(msg);
      }
      messages.sort((a, b) => a.timestamp - b.timestamp);
      render();
    }

    function render() {
      const now = Date.now();
      messages = messages.filter(m => now - m.timestamp < TTL_MS);
      messagesEl.innerHTML = '';
      for (const msg of messages) {
        const row = document.createElement('div');
        row.className = 'px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-zinc-900/90 border border-zinc-800/80 text-[15px] sm:text-sm text-zinc-100 break-words whitespace-pre-wrap flex items-start justify-between gap-3';
        const textSpan = document.createElement('div');
        textSpan.className = 'min-w-0 flex-1 leading-relaxed break-words';
        textSpan.textContent = msg.content;
        const ttlSpan = document.createElement('span');
        ttlSpan.className = 'text-[11px] font-mono text-zinc-500 shrink-0 tabular-nums pt-0.5 select-none';
        ttlSpan.textContent = formatRemaining(msg.timestamp + TTL_MS - now);
        row.appendChild(textSpan);
        row.appendChild(ttlSpan);
        messagesEl.appendChild(row);
      }
      if (isNearBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    async function loadMessages() {
      try {
        const res = await fetch('/api/messages');
        const data = await res.json();
        if (data && Array.isArray(data.messages)) {
          messages = data.messages;
          render();
        }
      } catch {}
    }

    function connectWs() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws');
      activeWs = ws;
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if ((data.type === 'message:created' || data.type === 'message:ack') && data.message) {
            upsertMessage(data.message);
          } else if (data.type === 'messages:sync' && Array.isArray(data.messages)) {
            messages = data.messages;
            render();
          }
        } catch {}
      };
      ws.onclose = () => {
        activeWs = null;
        setTimeout(connectWs, 1000);
      };
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      isNearBottom = true;
      const now = Date.now();
      const msgId = 'MSG-' + now + '-' + Math.random().toString(36).substring(2, 9).toUpperCase();
      upsertMessage({ id: msgId, content: text, timestamp: now, expiresAt: now + TTL_MS });

      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        try {
          activeWs.send(JSON.stringify({ type: 'message:send', id: msgId, content: text }));
          return;
        } catch {}
      }

      try {
        await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: msgId, content: text })
        });
      } catch {}
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        formEl.requestSubmit();
      }
    });

    loadMessages();
    connectWs();
    setInterval(render, 1000);
  </script>
</body>
</html>`;

export class WhisperNetHub {
  constructor(state, env) {
    this.state = state;
    this.ctx = state;
    this.env = env;
    this.clients = new Set();
    this.messages = [];
    this.initialized = false;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const stored = await this.state.storage.get(STORAGE_KEY_MESSAGES);
      if (Array.isArray(stored)) {
        this.messages = stored;
      }
    } catch {
      this.messages = [];
    }
    this.purgeExpiredMessagesInMemory();
    this.persistAndScheduleAsync();
  }

  purgeExpiredMessagesInMemory() {
    const cutoff = Date.now() - TTL_MS;
    const beforeCount = this.messages.length;
    this.messages = this.messages.filter(
      (msg) => msg && typeof msg.timestamp === 'number' && msg.timestamp >= cutoff
    );
    return beforeCount - this.messages.length;
  }

  persistAndScheduleAsync() {
    const snapshot = [...this.messages];
    const task = (async () => {
      try {
        if (snapshot.length === 0) {
          await this.state.storage.deleteAll();
          return;
        }
        await this.state.storage.put(STORAGE_KEY_MESSAGES, snapshot);
        const oldestTimestamp = snapshot[0].timestamp;
        const nextExpiryAt = Math.max(Date.now() + 5000, oldestTimestamp + TTL_MS);
        await this.state.storage.setAlarm(nextExpiryAt);
      } catch {
        // Ignore background storage/alarm errors
      }
    })();

    if (this.state && typeof this.state.waitUntil === 'function') {
      this.state.waitUntil(task);
    }
    return task;
  }

  // Durable Object Alarm handler for automatic server-side 30-minute message purging
  async alarm() {
    await this.ensureInitialized();
    const purged = this.purgeExpiredMessagesInMemory();
    await this.persistAndScheduleAsync();
    if (purged > 0) {
      this.broadcast({
        type: 'messages:sync',
        messages: this.messages,
        ttlMs: TTL_MS,
      });
    }
  }

  broadcast(payload) {
    const serialized = JSON.stringify(payload);
    for (const ws of this.clients) {
      try {
        ws.send(serialized);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  // Zero-Latency Append: Broadcasts to all connected sockets BEFORE disk storage write completes
  appendMessageFast(rawContent, rawClientId) {
    this.purgeExpiredMessagesInMemory();
    const content = String(rawContent || '').trim();
    if (!content) return null;
    const truncated = content.slice(0, 2000);
    const now = Date.now();
    const id =
      rawClientId && typeof rawClientId === 'string' && rawClientId.trim().length > 0
        ? rawClientId.trim().slice(0, 64)
        : `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    const existing = this.messages.find((m) => m.id === id);
    if (existing) return existing;

    const record = {
      id,
      content: truncated,
      timestamp: now,
      expiresAt: now + TTL_MS,
    };

    this.messages.push(record);
    if (this.messages.length > MAX_MESSAGES_IN_RAM) {
      this.messages = this.messages.slice(-MAX_MESSAGES_IN_RAM);
    }

    // 1. Broadcast IMMEDIATELY in-memory to all connected peers (0ms I/O wait)
    this.broadcast({
      type: 'message:created',
      message: record,
      ttlMs: TTL_MS,
    });

    // 2. Persist to Durable Object disk & schedule TTL alarm asynchronously in background
    this.persistAndScheduleAsync();

    return record;
  }

  async handleWebSocket(request) {
    await this.ensureInitialized();
    this.purgeExpiredMessagesInMemory();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.clients.add(server);

    // Immediately send active messages (< 30 mins old) on connection
    try {
      server.send(
        JSON.stringify({
          type: 'messages:sync',
          messages: this.messages,
          ttlMs: TTL_MS,
        })
      );
    } catch {
      // Ignore initial send error
    }

    server.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data || '{}'));
        if (data.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        } else if (data.type === 'message:send' && data.content) {
          const record = this.appendMessageFast(data.content, data.id);
          if (record) {
            server.send(
              JSON.stringify({
                type: 'message:ack',
                id: record.id,
                message: record,
                ttlMs: TTL_MS,
              })
            );
          }
        }
      } catch {
        // Ignore malformed WebSocket frames
      }
    });

    const cleanupSocket = () => {
      this.clients.delete(server);
    };

    server.addEventListener('close', cleanupSocket);
    server.addEventListener('error', cleanupSocket);

    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request) {
    await this.ensureInitialized();
    const purged = this.purgeExpiredMessagesInMemory();
    if (purged > 0) {
      this.persistAndScheduleAsync();
    }

    if (request.method === 'OPTIONS') {
      return jsonResponse({ ok: true }, 200, request, this.env);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (
      pathname === '/ws' ||
      (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket'
    ) {
      return this.handleWebSocket(request);
    }

    // GET /api/messages (or legacy /api/global/messages)
    if (
      (pathname === '/api/messages' || pathname === '/api/global/messages') &&
      request.method === 'GET'
    ) {
      return jsonResponse(
        {
          ok: true,
          ttlMs: TTL_MS,
          messages: this.messages,
          timestamp: Date.now(),
        },
        200,
        request,
        this.env
      );
    }

    // POST /api/messages (or legacy /api/global/messages)
    if (
      (pathname === '/api/messages' || pathname === '/api/global/messages') &&
      request.method === 'POST'
    ) {
      const body = await request.json().catch(() => ({}));
      const content = String(body.content || '').trim();
      if (!content) {
        return jsonResponse(
          { ok: false, error: 'Message content cannot be empty.' },
          400,
          request,
          this.env
        );
      }
      if (content.length > 2000) {
        return jsonResponse(
          { ok: false, error: 'Message exceeds maximum length of 2000 characters.' },
          400,
          request,
          this.env
        );
      }

      const record = this.appendMessageFast(content, body.id);
      return jsonResponse(
        {
          ok: true,
          message: record,
          ttlMs: TTL_MS,
          timestamp: Date.now(),
        },
        200,
        request,
        this.env
      );
    }

    return jsonResponse({ ok: false, error: 'Not found.' }, 404, request, this.env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Forced HTTP-to-HTTPS 301 Permanent Redirect on Edge (except localhost)
    const forwardedProto = (request.headers.get('X-Forwarded-Proto') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const cfVisitorRaw = request.headers.get('CF-Visitor') || '';
    const isCfHttp = cfVisitorRaw.includes('"scheme":"http"');
    const isLocalhost =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname.endsWith('.local');

    if (!isLocalhost && (url.protocol === 'http:' || forwardedProto === 'http' || isCfHttp)) {
      url.protocol = 'https:';
      return new Response(null, {
        status: 301,
        headers: {
          Location: url.toString(),
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        },
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.WHISPERNET_HUB.idFromName('GLOBAL_EPHEMERAL_PUBLIC_BOARD');
      const stub = env.WHISPERNET_HUB.get(id);
      return stub.fetch(request);
    }

    // Serve static assets from Vite build if ASSETS binding is configured
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Embedded fallback PWA manifest, Service Worker & solid dark icons
    if (url.pathname === '/manifest.webmanifest' || url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(WEB_MANIFEST), {
        status: 200,
        headers: {
          'Content-Type': 'application/manifest+json; charset=utf-8',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        },
      });
    }

    if (url.pathname === '/sw.js') {
      return new Response(SERVICE_WORKER_JS, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        },
      });
    }

    if (url.pathname === '/icon.svg') {
      return new Response(SOLID_DARK_SVG, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (
      url.pathname === '/pwa-192x192.png' ||
      url.pathname === '/pwa-512x512.png' ||
      url.pathname === '/pwa-maskable-512x512.png' ||
      url.pathname === '/apple-touch-icon.png' ||
      url.pathname === '/favicon.ico'
    ) {
      const binaryStr = atob(SOLID_DARK_PNG_B64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return new Response(bytes.buffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    return new Response(EMBEDDED_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      },
    });
  },
};
