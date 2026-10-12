// Cloudflare Worker + Durable Object (Ephemeral Public Board - 30-Minute TTL Zero-Trace Architecture)
// Strictly Anonymous, Pure-Text Single Global Stream, Zero User IDs, Zero Headers, Auto-Purging Every 30 Minutes

const TTL_MS = 30 * 60 * 1000; // Strict 30-Minute Ephemeral Message Lifetime
const MAX_MESSAGES_IN_RAM = 500;
const STORAGE_KEY_MESSAGES = 'ephemeral_public_messages_v1';

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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <title>Ephemeral Public Board</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-dvh w-full max-w-full overflow-hidden bg-zinc-950 text-zinc-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
  <div class="h-dvh w-full max-w-full flex flex-col overflow-hidden bg-zinc-950">
    <div id="messages" class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 sm:p-5 space-y-2.5"></div>
    <form id="composer" class="shrink-0 p-2.5 sm:p-3.5 border-t border-zinc-900 bg-zinc-950 flex items-end gap-2 w-full">
      <textarea id="input" rows="1" maxlength="2000" placeholder="Write a message..." class="min-w-0 flex-1 max-h-32 resize-none overflow-y-auto px-3.5 py-2.5 text-sm bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-700"></textarea>
      <button type="submit" class="px-4 py-2.5 text-sm font-medium bg-zinc-100 hover:bg-white text-zinc-950 rounded-xl transition-colors shrink-0 cursor-pointer">Send</button>
    </form>
  </div>
  <script>
    const TTL_MS = 30 * 60 * 1000;
    const messagesEl = document.getElementById('messages');
    const formEl = document.getElementById('composer');
    const inputEl = document.getElementById('input');
    let messages = [];
    let isNearBottom = true;

    messagesEl.addEventListener('scroll', () => {
      const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      isNearBottom = dist <= 120;
    });

    function formatRemaining(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      return m + ':' + sec;
    }

    function render() {
      const now = Date.now();
      messages = messages.filter(m => now - m.timestamp < TTL_MS);
      messagesEl.innerHTML = '';
      for (const msg of messages) {
        const row = document.createElement('div');
        row.className = 'px-3.5 py-2.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 text-sm text-zinc-100 break-words whitespace-pre-wrap flex items-start justify-between gap-3';
        const textSpan = document.createElement('div');
        textSpan.className = 'min-w-0 flex-1 leading-relaxed';
        textSpan.textContent = msg.content;
        const ttlSpan = document.createElement('span');
        ttlSpan.className = 'text-[11px] font-mono text-zinc-500 shrink-0 tabular-nums pt-0.5';
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
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'message:created' && data.message) {
            if (!messages.some(m => m.id === data.message.id)) {
              messages.push(data.message);
              render();
            }
          } else if (data.type === 'messages:sync' && Array.isArray(data.messages)) {
            messages = data.messages;
            render();
          }
        } catch {}
      };
      ws.onclose = () => setTimeout(connectWs, 2000);
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      isNearBottom = true;
      try {
        await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text })
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
    await this.purgeExpiredMessages();
  }

  async scheduleNextPurgeAlarm() {
    try {
      if (this.messages.length === 0) {
        await this.state.storage.deleteAll();
        return;
      }
      const oldestTimestamp = this.messages[0].timestamp;
      const nextExpiryAt = Math.max(Date.now() + 5000, oldestTimestamp + TTL_MS);
      await this.state.storage.setAlarm(nextExpiryAt);
    } catch {
      // Ignore alarm scheduling errors if unsupported
    }
  }

  async purgeExpiredMessages() {
    const now = Date.now();
    const cutoff = now - TTL_MS;
    const beforeCount = this.messages.length;

    this.messages = this.messages.filter(
      (msg) => msg && typeof msg.timestamp === 'number' && msg.timestamp >= cutoff
    );

    const purgedCount = beforeCount - this.messages.length;

    try {
      if (this.messages.length === 0) {
        await this.state.storage.deleteAll();
      } else if (purgedCount > 0) {
        await this.state.storage.put(STORAGE_KEY_MESSAGES, this.messages);
      }
    } catch {
      // Ignore storage errors
    }

    await this.scheduleNextPurgeAlarm();
    return purgedCount;
  }

  // Durable Object Alarm handler for automatic server-side 30-minute message purging
  async alarm() {
    await this.ensureInitialized();
    const purged = await this.purgeExpiredMessages();
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
    for (const ws of Array.from(this.clients)) {
      try {
        ws.send(serialized);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  async appendMessage(rawContent, rawClientId) {
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

    try {
      await this.state.storage.put(STORAGE_KEY_MESSAGES, this.messages);
    } catch {
      // Ignore storage write error
    }

    await this.scheduleNextPurgeAlarm();

    this.broadcast({
      type: 'message:created',
      message: record,
      ttlMs: TTL_MS,
    });

    return record;
  }

  async handleWebSocket(request) {
    await this.ensureInitialized();
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

    server.addEventListener('message', async (event) => {
      try {
        await this.purgeExpiredMessages();
        const data = JSON.parse(String(event.data || '{}'));
        if (data.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        } else if (data.type === 'message:send' && data.content) {
          await this.appendMessage(data.content, data.id);
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
    await this.purgeExpiredMessages();

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

      const record = await this.appendMessage(content, body.id);
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

    // Automatic HTTP-to-HTTPS 301 Redirect on Edge (except localhost)
    const forwardedProto = request.headers.get('X-Forwarded-Proto');
    const isLocalhost =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.endsWith('.local');

    if (!isLocalhost && (url.protocol === 'http:' || forwardedProto === 'http')) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.WHISPERNET_HUB.idFromName('GLOBAL_EPHEMERAL_PUBLIC_BOARD');
      const stub = env.WHISPERNET_HUB.get(id);
      return stub.fetch(request);
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(EMBEDDED_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    });
  },
};
