import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Strict 30-Minute Ephemeral Message Lifetime (1,800,000 ms)
const TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGES_IN_RAM = 500;

export interface EphemeralMessage {
  id: string;
  content: string;
  timestamp: number;
  expiresAt: number;
}

// Pure In-Memory Ephemeral RAM Message Store
let memoryMessages: EphemeralMessage[] = [];

function purgeExpiredMessages(): number {
  const cutoff = Date.now() - TTL_MS;
  const before = memoryMessages.length;
  memoryMessages = memoryMessages.filter((msg) => msg.timestamp >= cutoff);
  return before - memoryMessages.length;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);

  // Disable perMessageDeflate for instant sub-millisecond WebSocket frame delivery
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: false,
  });

  // Enable TCP_NODELAY (disable Nagle's algorithm) on all incoming connections for zero-latency packet push
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS || '*';
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Forced HTTP -> HTTPS 301 Redirect & HSTS + CORS Middleware
  app.use((req, res, next) => {
    const hostHeader = String(req.headers.host || '');
    const hostname = hostHeader.split(':')[0].toLowerCase();
    const isLocalhost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local');

    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();

    if (!isLocalhost && forwardedProto === 'http') {
      res.redirect(301, `https://${hostHeader}${req.originalUrl}`);
      return;
    }

    if (!isLocalhost) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }

    const origin = req.headers.origin;
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (req.method === 'OPTIONS') {
      res.status(200).json({ ok: true });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // Ensure malformed JSON body requests always return strict JSON instead of default Express HTML error
  app.use(
    (
      err: Error & { status?: number; type?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed')) {
        res.status(400).json({ ok: false, error: 'Invalid JSON payload.' });
        return;
      }
      next(err);
    }
  );

  const clients = new Set<WebSocket>();

  function broadcast(payload: Record<string, unknown>, excludeClient?: WebSocket) {
    const serialized = JSON.stringify(payload);
    for (const client of clients) {
      if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  function appendMessage(
    rawContent: string,
    rawClientId?: string,
    senderWs?: WebSocket
  ): EphemeralMessage | null {
    purgeExpiredMessages();
    const content = String(rawContent || '').trim();
    if (!content) return null;
    const truncated = content.slice(0, 2000);
    const now = Date.now();
    const id =
      rawClientId && typeof rawClientId === 'string' && rawClientId.trim().length > 0
        ? rawClientId.trim().slice(0, 64)
        : `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    const existing = memoryMessages.find((m) => m.id === id);
    if (existing) return existing;

    const record: EphemeralMessage = {
      id,
      content: truncated,
      timestamp: now,
      expiresAt: now + TTL_MS,
    };

    memoryMessages.push(record);
    if (memoryMessages.length > MAX_MESSAGES_IN_RAM) {
      memoryMessages = memoryMessages.slice(-MAX_MESSAGES_IN_RAM);
    }

    // Immediate broadcast to all other connected WebSocket clients (sender receives single message:ack)
    broadcast(
      {
        type: 'message:created',
        message: record,
        ttlMs: TTL_MS,
      },
      senderWs
    );

    return record;
  }

  // Server-side automatic 30-minute TTL sweeper every 5 seconds
  setInterval(() => {
    const purged = purgeExpiredMessages();
    if (purged > 0) {
      broadcast({
        type: 'messages:sync',
        messages: memoryMessages,
        ttlMs: TTL_MS,
      });
    }
  }, 5000);

  wss.on('connection', (ws: WebSocket) => {
    purgeExpiredMessages();
    clients.add(ws);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'messages:sync',
          messages: memoryMessages,
          ttlMs: TTL_MS,
        })
      );
    }

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } else if (data.type === 'message:send' && data.content) {
          const record = appendMessage(
            String(data.content),
            data.id ? String(data.id) : undefined,
            ws
          );
          if (record && ws.readyState === WebSocket.OPEN) {
            ws.send(
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
        // Ignore malformed WS frames
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  // GET /api/messages (and /api/global/messages alias)
  app.get(['/api/messages', '/api/global/messages'], (_req, res) => {
    purgeExpiredMessages();
    res.status(200).json({
      ok: true,
      ttlMs: TTL_MS,
      messages: memoryMessages,
      timestamp: Date.now(),
    });
  });

  // POST /api/messages (and /api/global/messages alias)
  app.post(['/api/messages', '/api/global/messages'], (req, res) => {
    try {
      const content = String(req.body?.content || '').trim();
      const clientId = req.body?.id ? String(req.body.id) : undefined;

      if (!content) {
        res.status(400).json({
          ok: false,
          error: 'Message content cannot be empty.',
        });
        return;
      }

      if (content.length > 2000) {
        res.status(400).json({
          ok: false,
          error: 'Message exceeds maximum length of 2000 characters.',
        });
        return;
      }

      const record = appendMessage(content, clientId);
      res.status(200).json({
        ok: true,
        message: record,
        ttlMs: TTL_MS,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({
        ok: false,
        error: 'Failed to post message.',
      });
    }
  });

  // Catch-all for unknown /api/* routes ensuring strict JSON response
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ ok: false, error: 'Endpoint not found.' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Ephemeral Public Board running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
