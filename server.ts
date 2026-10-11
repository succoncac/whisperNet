import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@libsql/client';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TURSO_URL =
  process.env.TURSO_DATABASE_URL || 'libsql://chat-fyfg.aws-ap-northeast-1.turso.io';
const TURSO_TOKEN =
  process.env.TURSO_AUTH_TOKEN ||
  'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTE2ODU4NzcsImlkIjoiMDFhMTI4Y2MtNTYwMS03NTZmLWE2MDctYWUwYjdlYzEzYmQ2Iiwia2lkIjoiMW5DMG9zdWs0b3B6aTRIVnB4aHVOSjVtaklGdUFuVnRXU1NmQXhhbmJlbyIsInJpZCI6ImQ1YWU1YmJmLThmZDItNGMzOC04Y2I2LTAyZDhmODQ2MDEyYSJ9.kVim6rlvy-fHa1PdwK2Hvqw6Pv_j244Ujp587dYJtwM0-QEgSaR6Fbpxv-tY7ZejVDHAmLH6eVeYC73LnUSMCQ';

const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

const TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds
const GLOBAL_ROOM_ID = 'GLOBAL';

export type ReactionMap = Record<string, string[]>;

export interface MessageRowFormatted {
  id: string;
  room_id: string;
  sender_id: string;
  content: string;
  timestamp: number;
  reactions: ReactionMap;
}

export function normalizeCode(code: string): string {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

export function buildRoomId(userA: string, userB: string): string {
  const sorted = [normalizeCode(userA), normalizeCode(userB)].sort();
  return `${sorted[0]}__${sorted[1]}`;
}

export function extractPeerFromRoomId(roomId: string, myId: string): string | null {
  const parts = String(roomId).split('__');
  if (parts.length !== 2) return null;
  const cleanMyId = normalizeCode(myId);
  if (parts[0] === cleanMyId) return parts[1];
  if (parts[1] === cleanMyId) return parts[0];
  return null;
}

async function ensureGlobalRoomExists(): Promise<void> {
  const now = Date.now();
  const check = await db.execute({
    sql: 'SELECT room_id FROM rooms WHERE room_id = ?',
    args: [GLOBAL_ROOM_ID],
  });
  if (check.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO rooms (room_id, created_at) VALUES (?, ?)',
      args: [GLOBAL_ROOM_ID, now],
    });
  }
}

async function registerActiveIdentity(userId: string, publicKey?: string): Promise<void> {
  const cleanId = normalizeCode(userId);
  if (!cleanId || cleanId.length < 4) return;
  const now = Date.now();
  try {
    if (publicKey && typeof publicKey === 'string') {
      await db.execute({
        sql: `
          INSERT INTO active_users (user_id, last_seen, public_key)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            last_seen = excluded.last_seen,
            public_key = COALESCE(excluded.public_key, active_users.public_key)
        `,
        args: [cleanId, now, publicKey],
      });
    } else {
      await db.execute({
        sql: `
          INSERT INTO active_users (user_id, last_seen)
          VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen
        `,
        args: [cleanId, now],
      });
    }
  } catch (err) {
    console.error('Error registering active identity:', err);
  }
}

async function getPeerPublicKey(userId: string): Promise<string | null> {
  const cleanId = normalizeCode(userId);
  if (!cleanId) return null;
  try {
    const res = await db.execute({
      sql: 'SELECT public_key FROM active_users WHERE user_id = ? LIMIT 1',
      args: [cleanId],
    });
    const val = res.rows[0]?.public_key;
    return val ? String(val) : null;
  } catch {
    return null;
  }
}

async function initializeDatabase(): Promise<void> {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS active_users (
        user_id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL,
        public_key TEXT
      )
    `);

    try {
      await db.execute(`ALTER TABLE active_users ADD COLUMN public_key TEXT`);
    } catch {
      // Column already exists
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      )
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_messages_room_timestamp ON messages (room_id, timestamp ASC)
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_reactions_room ON message_reactions (room_id, message_id)
    `);

    await ensureGlobalRoomExists();
    await cleanupExpiredData();
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

async function cleanupExpiredData(): Promise<{ deletedMessages: number; deletedRooms: number }> {
  const cutoff = Date.now() - TTL_MS;
  try {
    const msgRes = await db.execute({
      sql: 'DELETE FROM messages WHERE timestamp < ?',
      args: [cutoff],
    });
    const roomRes = await db.execute({
      sql: 'DELETE FROM rooms WHERE created_at < ? AND room_id != ?',
      args: [cutoff, GLOBAL_ROOM_ID],
    });
    await db.execute({
      sql: 'DELETE FROM active_users WHERE last_seen < ?',
      args: [cutoff],
    });
    await db.execute({
      sql: 'DELETE FROM message_reactions WHERE timestamp < ?',
      args: [cutoff],
    });
    return {
      deletedMessages: msgRes.rowsAffected || 0,
      deletedRooms: roomRes.rowsAffected || 0,
    };
  } catch (err) {
    console.error('TTL cleanup error:', err);
    return { deletedMessages: 0, deletedRooms: 0 };
  }
}

async function getReactionsForRoom(roomId: string, cutoff: number): Promise<Record<string, ReactionMap>> {
  const mapByMessage: Record<string, ReactionMap> = {};
  try {
    const res = await db.execute({
      sql: 'SELECT message_id, user_id, emoji FROM message_reactions WHERE room_id = ? AND timestamp >= ?',
      args: [roomId, cutoff],
    });
    for (const row of res.rows) {
      const msgId = String(row.message_id);
      const userId = String(row.user_id);
      const emoji = String(row.emoji);
      if (!mapByMessage[msgId]) {
        mapByMessage[msgId] = {};
      }
      if (!mapByMessage[msgId][emoji]) {
        mapByMessage[msgId][emoji] = [];
      }
      if (!mapByMessage[msgId][emoji].includes(userId)) {
        mapByMessage[msgId][emoji].push(userId);
      }
    }
  } catch (err) {
    console.error('Error loading room reactions:', err);
  }
  return mapByMessage;
}

async function getReactionsForMessage(messageId: string): Promise<ReactionMap> {
  const reactionMap: ReactionMap = {};
  try {
    const res = await db.execute({
      sql: 'SELECT user_id, emoji FROM message_reactions WHERE message_id = ?',
      args: [messageId],
    });
    for (const row of res.rows) {
      const userId = String(row.user_id);
      const emoji = String(row.emoji);
      if (!reactionMap[emoji]) {
        reactionMap[emoji] = [];
      }
      if (!reactionMap[emoji].includes(userId)) {
        reactionMap[emoji].push(userId);
      }
    }
  } catch (err) {
    console.error('Error loading message reactions:', err);
  }
  return reactionMap;
}

interface WsClient extends WebSocket {
  roomId?: string;
  userId?: string;
}

async function startServer() {
  await initializeDatabase();

  // Periodic 24-hour TTL auto-cleanup every 5 minutes
  setInterval(() => {
    cleanupExpiredData().catch(() => {});
  }, 5 * 60 * 1000);

  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS || '*';
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.status(200).json({ ok: true });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  const roomClients = new Map<string, Set<WsClient>>();
  const userClients = new Map<string, Set<WsClient>>();
  const allClients = new Set<WsClient>();

  function broadcastToAll(payload: Record<string, unknown>) {
    const messageStr = JSON.stringify(payload);
    for (const client of allClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  function sendToUser(targetUserId: string, payload: Record<string, unknown>) {
    const cleanUser = normalizeCode(targetUserId);
    const clients = userClients.get(cleanUser);
    if (!clients) return;
    const messageStr = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  function broadcastToRoom(roomId: string, payload: Record<string, unknown>) {
    if (roomId === GLOBAL_ROOM_ID) {
      broadcastToAll(payload);
      return;
    }
    const clients = roomClients.get(roomId);
    if (!clients) return;
    const messageStr = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  function isUserCurrentlyOnline(userId: string): boolean {
    const cleanUserId = normalizeCode(userId);
    const set = userClients.get(cleanUserId);
    if (!set) return false;
    for (const c of set) {
      if (c.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  async function doesUserExistOrOnline(targetUserId: string, requesterId: string): Promise<boolean> {
    const cleanTarget = normalizeCode(targetUserId);
    const cleanRequester = normalizeCode(requesterId);
    if (!cleanTarget || cleanTarget.length < 4) return false;

    // 1. Check active WebSocket presence
    if (isUserCurrentlyOnline(cleanTarget)) {
      return true;
    }

    const cutoff = Date.now() - TTL_MS;

    // 2. Check active_users session table in Turso (active within 24h TTL)
    const activeCheck = await db.execute({
      sql: 'SELECT user_id FROM active_users WHERE user_id = ? AND last_seen >= ? LIMIT 1',
      args: [cleanTarget, cutoff],
    });
    if (activeCheck.rows.length > 0) return true;

    // 3. Check if user has posted any message in Turso within 24h TTL
    const msgCheck = await db.execute({
      sql: 'SELECT id FROM messages WHERE sender_id = ? AND timestamp >= ? LIMIT 1',
      args: [cleanTarget, cutoff],
    });
    if (msgCheck.rows.length > 0) return true;

    // 4. Check if a room with this peer already exists in Turso
    const candidateRoomId = buildRoomId(cleanRequester, cleanTarget);
    const roomCheck = await db.execute({
      sql: 'SELECT room_id FROM rooms WHERE room_id = ? AND created_at >= ? LIMIT 1',
      args: [candidateRoomId, cutoff],
    });
    if (roomCheck.rows.length > 0) return true;

    return false;
  }

  function registerUserSocket(ws: WsClient, rawUserId: string) {
    const cleanUserId = normalizeCode(rawUserId);
    if (!cleanUserId) return;

    if (ws.userId && ws.userId !== cleanUserId && userClients.has(ws.userId)) {
      userClients.get(ws.userId)?.delete(ws);
    }

    ws.userId = cleanUserId;
    if (!userClients.has(cleanUserId)) {
      userClients.set(cleanUserId, new Set());
    }
    userClients.get(cleanUserId)!.add(ws);
    registerActiveIdentity(cleanUserId).catch(() => {});
  }

  function broadcastGlobalPresence() {
    const onlineUsers = new Set<string>();
    for (const c of allClients) {
      if (c.readyState === WebSocket.OPEN && c.userId) {
        onlineUsers.add(c.userId);
      }
    }
    broadcastToAll({
      type: 'global:presence',
      users: Array.from(onlineUsers),
      onlineCount: onlineUsers.size,
    });
  }

  function broadcastRoomPresence(roomId: string) {
    const clients = roomClients.get(roomId);
    const activeUsers = new Set<string>();
    if (clients) {
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN && c.userId) {
          activeUsers.add(c.userId);
        }
      }
    }
    broadcastToRoom(roomId, {
      type: 'room:presence',
      roomId,
      participants: Array.from(activeUsers),
      onlineCount: activeUsers.size,
    });
  }

  wss.on('connection', (ws: WsClient) => {
    allClients.add(ws);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw));

        if (data.type === 'user:identify' && data.userId) {
          registerUserSocket(ws, data.userId);
          broadcastGlobalPresence();
        } else if (data.type === 'room:join' && data.roomId && data.userId) {
          if (ws.roomId && roomClients.has(ws.roomId)) {
            roomClients.get(ws.roomId)?.delete(ws);
            broadcastRoomPresence(ws.roomId);
          }
          const cleanRoomId = String(data.roomId);
          registerUserSocket(ws, data.userId);
          ws.roomId = cleanRoomId;

          if (!roomClients.has(cleanRoomId)) {
            roomClients.set(cleanRoomId, new Set());
          }
          roomClients.get(cleanRoomId)!.add(ws);
          broadcastRoomPresence(cleanRoomId);
          broadcastGlobalPresence();
        } else if (data.type === 'room:typing' && data.roomId && ws.userId) {
          const targetRoom = String(data.roomId);
          broadcastToRoom(targetRoom, {
            type: 'room:typing',
            roomId: targetRoom,
            userId: ws.userId,
            isTyping: Boolean(data.isTyping),
          });
        }
      } catch {
        // Ignore malformed WS packets
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      if (ws.userId && userClients.has(ws.userId)) {
        const uSet = userClients.get(ws.userId)!;
        uSet.delete(ws);
        if (uSet.size === 0) {
          userClients.delete(ws.userId);
        }
      }
      if (ws.roomId && roomClients.has(ws.roomId)) {
        const set = roomClients.get(ws.roomId)!;
        set.delete(ws);
        if (set.size === 0) {
          roomClients.delete(ws.roomId);
        } else {
          broadcastRoomPresence(ws.roomId);
        }
      }
      broadcastGlobalPresence();
    });
  });

  // Register/Heartbeat User Identity + ECDH Public Key
  app.post('/api/users/register', async (req, res) => {
    try {
      const userId = normalizeCode(req.body?.userId);
      const publicKey = req.body?.publicKey ? String(req.body.publicKey) : undefined;
      if (!userId || userId.length < 4) {
        res.status(400).json({ ok: false, error: 'Invalid User ID.' });
        return;
      }
      await registerActiveIdentity(userId, publicKey);
      res.status(200).json({ ok: true, userId, timestamp: Date.now() });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to register user session.',
      });
    }
  });

  // Health & TTL Status Endpoint
  app.get('/api/status', async (_req, res) => {
    try {
      const cleanup = await cleanupExpiredData();
      const roomsCountResult = await db.execute({
        sql: 'SELECT COUNT(*) as count FROM rooms WHERE room_id != ?',
        args: [GLOBAL_ROOM_ID],
      });
      const messagesCountResult = await db.execute('SELECT COUNT(*) as count FROM messages');
      const activeRooms = Number(roomsCountResult.rows[0]?.count ?? 0);
      const activeMessages = Number(messagesCountResult.rows[0]?.count ?? 0);

      res.status(200).json({
        ok: true,
        database: 'connected',
        ttlHours: 24,
        activeRooms,
        activeMessages,
        cleanedUp: cleanup,
        timestamp: Date.now(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        database: 'error',
        error: error instanceof Error ? error.message : 'Database connection failed',
      });
    }
  });

  // Get All Active 1-on-1 Private Conversations for a User
  app.get('/api/users/:userId/conversations', async (req, res) => {
    try {
      await cleanupExpiredData();
      const myId = normalizeCode(req.params.userId);
      if (!myId) {
        res.status(400).json({ ok: false, error: 'Valid User ID is required.' });
        return;
      }

      await registerActiveIdentity(myId);

      const prefixPattern = `${myId}__%`;
      const suffixPattern = `%__${myId}`;
      const cutoff = Date.now() - TTL_MS;

      const roomsResult = await db.execute({
        sql: `
          SELECT room_id, created_at
          FROM rooms
          WHERE (room_id LIKE ? OR room_id LIKE ?)
            AND created_at >= ?
          ORDER BY created_at DESC
        `,
        args: [prefixPattern, suffixPattern, cutoff],
      });

      const conversations = [];

      for (const row of roomsResult.rows) {
        const roomId = String(row.room_id);
        const createdAt = Number(row.created_at);
        const peerId = extractPeerFromRoomId(roomId, myId);
        if (!peerId) continue;

        const lastMsgRes = await db.execute({
          sql: `
            SELECT id, sender_id, content, timestamp
            FROM messages
            WHERE room_id = ? AND timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT 1
          `,
          args: [roomId, cutoff],
        });

        const countRes = await db.execute({
          sql: `
            SELECT COUNT(*) as count
            FROM messages
            WHERE room_id = ? AND timestamp >= ?
          `,
          args: [roomId, cutoff],
        });

        const lastMsgRow = lastMsgRes.rows[0];
        const lastMessage = lastMsgRow
          ? {
              id: String(lastMsgRow.id),
              sender_id: String(lastMsgRow.sender_id),
              content: String(lastMsgRow.content),
              timestamp: Number(lastMsgRow.timestamp),
            }
          : null;

        const peerPublicKey = await getPeerPublicKey(peerId);

        conversations.push({
          room_id: roomId,
          peer_id: peerId,
          peer_public_key: peerPublicKey,
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
          message_count: Number(countRes.rows[0]?.count ?? 0),
          last_message: lastMessage,
          updated_at: lastMessage ? lastMessage.timestamp : createdAt,
        });
      }

      conversations.sort((a, b) => b.updated_at - a.updated_at);

      res.status(200).json({
        ok: true,
        conversations,
      });
    } catch (error) {
      console.error('Error fetching user conversations:', error);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch private conversations.',
      });
    }
  });

  // Get Global Public Chat Messages (Last 24h) + Reactions
  app.get('/api/global/messages', async (_req, res) => {
    try {
      await cleanupExpiredData();
      await ensureGlobalRoomExists();

      const cutoff = Date.now() - TTL_MS;
      const [messagesResult, reactionsByMsg] = await Promise.all([
        db.execute({
          sql: 'SELECT id, room_id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 200',
          args: [GLOBAL_ROOM_ID, cutoff],
        }),
        getReactionsForRoom(GLOBAL_ROOM_ID, cutoff),
      ]);

      const messages: MessageRowFormatted[] = messagesResult.rows.map((row) => {
        const msgId = String(row.id);
        return {
          id: msgId,
          room_id: String(row.room_id),
          sender_id: String(row.sender_id),
          content: String(row.content),
          timestamp: Number(row.timestamp),
          reactions: reactionsByMsg[msgId] || {},
        };
      });

      res.status(200).json({
        ok: true,
        roomId: GLOBAL_ROOM_ID,
        messages,
      });
    } catch (error) {
      console.error('Error fetching global messages:', error);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch global chat messages.',
      });
    }
  });

  // Post a Message to Global Public Chat
  app.post('/api/global/messages', async (req, res) => {
    try {
      await cleanupExpiredData();
      await ensureGlobalRoomExists();

      const senderId = normalizeCode(req.body?.senderId);
      const content = String(req.body?.content || '').trim();
      const clientMsgId = String(req.body?.id || '').trim();

      if (!senderId || !content) {
        res.status(400).json({ ok: false, error: 'Missing senderId or content.' });
        return;
      }

      if (content.length > 2000) {
        res.status(400).json({
          ok: false,
          error: 'Global message exceeds maximum length of 2000 characters.',
        });
        return;
      }

      await registerActiveIdentity(senderId);

      const now = Date.now();
      const messageId =
        clientMsgId || `GLB-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      const existingMsg = await db.execute({
        sql: 'SELECT id FROM messages WHERE id = ?',
        args: [messageId],
      });

      const messageRecord: MessageRowFormatted = {
        id: messageId,
        room_id: GLOBAL_ROOM_ID,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      if (existingMsg.rows.length === 0) {
        await db.execute({
          sql: 'INSERT INTO messages (id, room_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
          args: [
            messageRecord.id,
            messageRecord.room_id,
            messageRecord.sender_id,
            messageRecord.content,
            messageRecord.timestamp,
          ],
        });

        broadcastToAll({
          type: 'global:message:created',
          roomId: GLOBAL_ROOM_ID,
          message: messageRecord,
        });
      }

      res.status(200).json({
        ok: true,
        message: messageRecord,
      });
    } catch (error) {
      console.error('Error posting global message:', error);
      res.status(500).json({
        ok: false,
        error: 'Failed to store global message.',
      });
    }
  });

  // Connect or Create 1-on-1 Private Room (Validates if Target User ID exists / is active)
  app.post('/api/rooms/connect', async (req, res) => {
    try {
      await cleanupExpiredData();

      const myId = normalizeCode(req.body?.myId);
      const peerId = normalizeCode(req.body?.peerId);
      const notifyPeer = req.body?.notifyPeer !== false;

      if (!myId || myId.length < 4) {
        res.status(400).json({ ok: false, error: 'Invalid session identity code.' });
        return;
      }
      if (!peerId || !/^USER-[A-Z0-9]{4,8}$/.test(peerId)) {
        res.status(404).json({
          ok: false,
          error: 'User not found. Please check the ID and try again.',
        });
        return;
      }
      if (myId === peerId) {
        res.status(400).json({
          ok: false,
          error: 'Cannot open a 1-on-1 private channel with your own ID.',
        });
        return;
      }

      const myPublicKey = req.body?.publicKey ? String(req.body.publicKey) : undefined;
      await registerActiveIdentity(myId, myPublicKey);

      // Verify target peer exists in active session or database before creating room
      const isPeerValid = await doesUserExistOrOnline(peerId, myId);
      if (!isPeerValid) {
        res.status(404).json({
          ok: false,
          error: 'User not found. Please check the ID and try again.',
        });
        return;
      }

      const roomId = buildRoomId(myId, peerId);
      const now = Date.now();
      const cutoff = now - TTL_MS;

      const existingRoom = await db.execute({
        sql: 'SELECT room_id, created_at FROM rooms WHERE room_id = ?',
        args: [roomId],
      });

      let createdAt = now;
      const isNewRoom = existingRoom.rows.length === 0;
      if (isNewRoom) {
        await db.execute({
          sql: 'INSERT INTO rooms (room_id, created_at) VALUES (?, ?)',
          args: [roomId, now],
        });
      } else {
        createdAt = Number(existingRoom.rows[0].created_at);
      }

      const [messagesResult, reactionsByMsg, peerPublicKey, senderPublicKey] = await Promise.all([
        db.execute({
          sql: 'SELECT id, room_id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp ASC',
          args: [roomId, cutoff],
        }),
        getReactionsForRoom(roomId, cutoff),
        getPeerPublicKey(peerId),
        getPeerPublicKey(myId),
      ]);

      const messages: MessageRowFormatted[] = messagesResult.rows.map((row) => {
        const msgId = String(row.id);
        return {
          id: msgId,
          room_id: String(row.room_id),
          sender_id: String(row.sender_id),
          content: String(row.content),
          timestamp: Number(row.timestamp),
          reactions: reactionsByMsg[msgId] || {},
        };
      });

      // Notify peer in real time that User A initiated a private chat session
      if (notifyPeer) {
        sendToUser(peerId, {
          type: 'private:chat_request',
          roomId,
          fromUserId: myId,
          fromPublicKey: senderPublicKey,
          toUserId: peerId,
          createdAt,
          isNewRoom,
          timestamp: now,
        });
      }

      res.status(200).json({
        ok: true,
        room: {
          room_id: roomId,
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
          peer_id: peerId,
          peer_public_key: peerPublicKey,
        },
        messages,
      });
    } catch (error) {
      console.error('Error connecting room:', error);
      res.status(500).json({
        ok: false,
        error: 'Failed to initialize private room.',
      });
    }
  });

  // Get Private Room Messages & Verify Room Existence
  app.get('/api/rooms/:roomId/messages', async (req, res) => {
    try {
      await cleanupExpiredData();
      const roomId = String(req.params.roomId || '').trim();
      if (!roomId) {
        res.status(400).json({ ok: false, error: 'Room ID is required.' });
        return;
      }

      const roomCheck = await db.execute({
        sql: 'SELECT room_id, created_at FROM rooms WHERE room_id = ?',
        args: [roomId],
      });

      if (roomCheck.rows.length === 0) {
        res.status(200).json({
          ok: true,
          roomExists: false,
          room: null,
          messages: [],
        });
        return;
      }

      const createdAt = Number(roomCheck.rows[0].created_at);
      const cutoff = Date.now() - TTL_MS;

      const [messagesResult, reactionsByMsg] = await Promise.all([
        db.execute({
          sql: 'SELECT id, room_id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp ASC',
          args: [roomId, cutoff],
        }),
        getReactionsForRoom(roomId, cutoff),
      ]);

      const messages: MessageRowFormatted[] = messagesResult.rows.map((row) => {
        const msgId = String(row.id);
        return {
          id: msgId,
          room_id: String(row.room_id),
          sender_id: String(row.sender_id),
          content: String(row.content),
          timestamp: Number(row.timestamp),
          reactions: reactionsByMsg[msgId] || {},
        };
      });

      res.status(200).json({
        ok: true,
        roomExists: true,
        room: {
          room_id: roomId,
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
        },
        messages,
      });
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch room messages.',
      });
    }
  });

  // Send a Private 1-on-1 Message
  app.post('/api/rooms/:roomId/messages', async (req, res) => {
    try {
      await cleanupExpiredData();

      const roomId = String(req.params.roomId || '').trim();
      const senderId = normalizeCode(req.body?.senderId);
      const content = String(req.body?.content || '').trim();
      const clientMsgId = String(req.body?.id || '').trim();

      if (!roomId || !senderId || !content) {
        res.status(400).json({ ok: false, error: 'Missing roomId, senderId, or content.' });
        return;
      }

      if (content.length > 4000) {
        res.status(400).json({
          ok: false,
          error: 'Message exceeds maximum length of 4000 characters.',
        });
        return;
      }

      await registerActiveIdentity(senderId);

      const now = Date.now();
      const messageId =
        clientMsgId || `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      // Ensure room exists
      const roomCheck = await db.execute({
        sql: 'SELECT room_id FROM rooms WHERE room_id = ?',
        args: [roomId],
      });

      if (roomCheck.rows.length === 0) {
        await db.execute({
          sql: 'INSERT INTO rooms (room_id, created_at) VALUES (?, ?)',
          args: [roomId, now],
        });
      }

      // Idempotency guard
      const existingMsg = await db.execute({
        sql: 'SELECT id FROM messages WHERE id = ?',
        args: [messageId],
      });

      const messageRecord: MessageRowFormatted = {
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      if (existingMsg.rows.length === 0) {
        await db.execute({
          sql: 'INSERT INTO messages (id, room_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
          args: [
            messageRecord.id,
            messageRecord.room_id,
            messageRecord.sender_id,
            messageRecord.content,
            messageRecord.timestamp,
          ],
        });

        broadcastToRoom(roomId, {
          type: 'message:created',
          roomId,
          message: messageRecord,
        });

        const recipientId = extractPeerFromRoomId(roomId, senderId);
        if (recipientId) {
          const senderPublicKey = await getPeerPublicKey(senderId);
          sendToUser(recipientId, {
            type: 'private:message_notification',
            roomId,
            fromUserId: senderId,
            fromPublicKey: senderPublicKey,
            toUserId: recipientId,
            message: messageRecord,
            timestamp: now,
          });
        }
      }

      res.status(200).json({
        ok: true,
        message: messageRecord,
      });
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({
        ok: false,
        error: 'Failed to store private message.',
      });
    }
  });

  // Toggle or Add Reaction on any Message (Global or Private)
  app.post('/api/messages/:messageId/reactions', async (req, res) => {
    try {
      const messageId = String(req.params.messageId || '').trim();
      const roomId = String(req.body?.roomId || '').trim();
      const userId = normalizeCode(req.body?.userId);
      const emoji = String(req.body?.emoji || '').trim();
      const mode = String(req.body?.mode || 'toggle'); // 'toggle' or 'add'

      if (!messageId || !roomId || !userId || !emoji) {
        res.status(400).json({ ok: false, error: 'Missing reaction parameters.' });
        return;
      }

      const existing = await db.execute({
        sql: 'SELECT message_id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        args: [messageId, userId, emoji],
      });

      if (existing.rows.length > 0) {
        if (mode === 'toggle') {
          await db.execute({
            sql: 'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
            args: [messageId, userId, emoji],
          });
        }
      } else {
        await db.execute({
          sql: 'INSERT INTO message_reactions (message_id, room_id, user_id, emoji, timestamp) VALUES (?, ?, ?, ?, ?)',
          args: [messageId, roomId, userId, emoji, Date.now()],
        });
      }

      const updatedReactions = await getReactionsForMessage(messageId);

      const eventPayload = {
        type: 'message:reaction_updated',
        roomId,
        messageId,
        reactions: updatedReactions,
      };

      broadcastToRoom(roomId, eventPayload);

      // If private room, also push to both participants directly
      if (roomId !== GLOBAL_ROOM_ID) {
        const peerId = extractPeerFromRoomId(roomId, userId);
        if (peerId) sendToUser(peerId, eventPayload);
        sendToUser(userId, eventPayload);
      }

      res.status(200).json({
        ok: true,
        messageId,
        roomId,
        reactions: updatedReactions,
      });
    } catch (error) {
      console.error('Error toggling reaction:', error);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to update message reaction.',
      });
    }
  });

  // The "Nuke Chat" Endpoint - Permanently wipes private messages, reactions, and room record for both users
  app.delete('/api/rooms/:roomId/nuke', async (req, res) => {
    try {
      const roomId = String(req.params.roomId || '').trim();
      const triggeredBy = normalizeCode(req.body?.triggeredBy || 'UNKNOWN');

      if (!roomId || roomId === GLOBAL_ROOM_ID) {
        res.status(400).json({ ok: false, error: 'Valid private Room ID is required to execute Nuke.' });
        return;
      }

      const peerId = extractPeerFromRoomId(roomId, triggeredBy);

      await db.execute({
        sql: 'DELETE FROM message_reactions WHERE room_id = ?',
        args: [roomId],
      });

      const deletedMessages = await db.execute({
        sql: 'DELETE FROM messages WHERE room_id = ?',
        args: [roomId],
      });

      const deletedRooms = await db.execute({
        sql: 'DELETE FROM rooms WHERE room_id = ?',
        args: [roomId],
      });

      const nukePayload = {
        type: 'room:nuked',
        roomId,
        triggeredBy,
        timestamp: Date.now(),
      };

      broadcastToRoom(roomId, nukePayload);
      if (peerId) {
        sendToUser(peerId, nukePayload);
      }
      sendToUser(triggeredBy, nukePayload);

      res.status(200).json({
        ok: true,
        nukedRoomId: roomId,
        deletedMessages: deletedMessages.rowsAffected || 0,
        deletedRooms: deletedRooms.rowsAffected || 0,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Error executing nuke:', error);
      res.status(500).json({
        ok: false,
        error: 'Failed to nuke room records.',
      });
    }
  });

  // Trigger manual 24h TTL sweep
  app.post('/api/maintenance/cleanup', async (_req, res) => {
    try {
      const result = await cleanupExpiredData();
      res.status(200).json({
        ok: true,
        ...result,
        timestamp: Date.now(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to run TTL cleanup.',
      });
    }
  });

  // Catch-all for unknown /api routes to always return valid JSON
  app.all('/api/*', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: 'API endpoint not found.',
    });
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
    console.log(`WhisperNet Zero-Trace Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
