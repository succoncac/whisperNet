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

// 1-Hour Ephemeral TTL in milliseconds (Pure In-Memory Ephemeral RAM Storage Only)
const TTL_MS = 60 * 60 * 1000;
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

interface InMemoryRoom {
  room_id: string;
  created_at: number;
}

interface InMemoryMessage {
  id: string;
  room_id: string;
  sender_id: string;
  content: string;
  timestamp: number;
}

interface InMemoryActiveUser {
  user_id: string;
  last_seen: number;
  public_key: string | null;
}

interface InMemoryReactionRecord {
  roomId: string;
  timestamp: number;
  reactions: Map<string, Set<string>>;
}

// Pure In-Memory Ephemeral RAM Storage (Zero Persistent Disk Writes)
const memoryRooms = new Map<string, InMemoryRoom>();
const memoryMessages = new Map<string, InMemoryMessage[]>();
const memoryActiveUsers = new Map<string, InMemoryActiveUser>();
const memoryMessageReactions = new Map<string, InMemoryReactionRecord>();

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

function ensureGlobalRoomExists(): void {
  if (!memoryRooms.has(GLOBAL_ROOM_ID)) {
    memoryRooms.set(GLOBAL_ROOM_ID, {
      room_id: GLOBAL_ROOM_ID,
      created_at: Date.now(),
    });
  }
  if (!memoryMessages.has(GLOBAL_ROOM_ID)) {
    memoryMessages.set(GLOBAL_ROOM_ID, []);
  }
}

function registerActiveIdentity(userId: string, publicKey?: string): void {
  const cleanId = normalizeCode(userId);
  if (!cleanId || cleanId.length < 4) return;
  const now = Date.now();
  const existing = memoryActiveUsers.get(cleanId);
  memoryActiveUsers.set(cleanId, {
    user_id: cleanId,
    last_seen: now,
    public_key:
      publicKey && typeof publicKey === 'string'
        ? publicKey
        : existing?.public_key || null,
  });
}

function getPeerPublicKey(userId: string): string | null {
  const cleanId = normalizeCode(userId);
  if (!cleanId) return null;
  const record = memoryActiveUsers.get(cleanId);
  return record?.public_key ? String(record.public_key) : null;
}

function getReactionsForMessage(messageId: string): ReactionMap {
  const reactionMap: ReactionMap = {};
  const entry = memoryMessageReactions.get(messageId);
  if (!entry) return reactionMap;
  for (const [emoji, usersSet] of entry.reactions.entries()) {
    const arr = Array.from(usersSet);
    if (arr.length > 0) {
      reactionMap[emoji] = arr;
    }
  }
  return reactionMap;
}

function getReactionsForRoom(roomId: string, cutoff: number): Record<string, ReactionMap> {
  const mapByMessage: Record<string, ReactionMap> = {};
  for (const [msgId, entry] of memoryMessageReactions.entries()) {
    if (entry.roomId === roomId && entry.timestamp >= cutoff) {
      mapByMessage[msgId] = getReactionsForMessage(msgId);
    }
  }
  return mapByMessage;
}

interface WsClient extends WebSocket {
  roomId?: string;
  userId?: string;
}

async function startServer() {
  ensureGlobalRoomExists();

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

  const roomClients = new Map<string, Set<WsClient>>();
  const userClients = new Map<string, Set<WsClient>>();
  const allClients = new Set<WsClient>();

  function isUserCurrentlyOnline(userId: string): boolean {
    const cleanUserId = normalizeCode(userId);
    const set = userClients.get(cleanUserId);
    if (!set) return false;
    for (const c of set) {
      if (c.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  function cleanupExpiredData(): { deletedMessages: number; deletedRooms: number } {
    const cutoff = Date.now() - TTL_MS;
    let deletedMessages = 0;
    let deletedRooms = 0;

    for (const [roomId, msgList] of memoryMessages.entries()) {
      const validMsgs: InMemoryMessage[] = [];
      for (const msg of msgList) {
        if (msg.timestamp >= cutoff) {
          validMsgs.push(msg);
        } else {
          deletedMessages++;
          memoryMessageReactions.delete(msg.id);
        }
      }
      if (validMsgs.length !== msgList.length) {
        memoryMessages.set(roomId, validMsgs);
      }
    }

    for (const [roomId, roomObj] of memoryRooms.entries()) {
      if (roomId !== GLOBAL_ROOM_ID && roomObj.created_at < cutoff) {
        deletedRooms++;
        memoryRooms.delete(roomId);
        const roomMsgs = memoryMessages.get(roomId) || [];
        for (const m of roomMsgs) {
          memoryMessageReactions.delete(m.id);
        }
        memoryMessages.delete(roomId);
      }
    }

    for (const [userId, userObj] of memoryActiveUsers.entries()) {
      if (userObj.last_seen < cutoff && !isUserCurrentlyOnline(userId)) {
        memoryActiveUsers.delete(userId);
      }
    }

    for (const [msgId, reactEntry] of memoryMessageReactions.entries()) {
      if (reactEntry.timestamp < cutoff) {
        memoryMessageReactions.delete(msgId);
      }
    }

    ensureGlobalRoomExists();
    return { deletedMessages, deletedRooms };
  }

  // Periodic 1-hour TTL in-memory auto-cleanup every 30 seconds
  setInterval(() => {
    cleanupExpiredData();
  }, 30 * 1000);

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

  function doesUserExistOrOnline(targetUserId: string): boolean {
    const cleanTarget = normalizeCode(targetUserId);
    if (!cleanTarget || cleanTarget.length < 4) return false;
    if (isUserCurrentlyOnline(cleanTarget)) return true;
    const cutoff = Date.now() - TTL_MS;
    const record = memoryActiveUsers.get(cleanTarget);
    return Boolean(record && record.last_seen >= cutoff);
  }

  function severStaleIdentity(staleUserId: string) {
    const cleanStale = normalizeCode(staleUserId);
    if (!cleanStale) return;

    // 1. Sever any open WebSockets still attached to the old/deleted identity
    const oldSet = userClients.get(cleanStale);
    if (oldSet) {
      for (const client of Array.from(oldSet)) {
        try {
          client.close(4001, 'Identity superseded or cleared');
        } catch {
          // ignore
        }
        allClients.delete(client);
      }
      userClients.delete(cleanStale);
    }

    // 2. Delete old identity from in-memory active users immediately
    memoryActiveUsers.delete(cleanStale);

    // 3. Notify all active 1-on-1 private rooms involving the old identity
    const cutoff = Date.now() - TTL_MS;
    for (const [roomId, roomObj] of memoryRooms.entries()) {
      if (roomId === GLOBAL_ROOM_ID || roomObj.created_at < cutoff) continue;
      if (roomId.startsWith(`${cleanStale}__`) || roomId.endsWith(`__${cleanStale}`)) {
        const peerId = extractPeerFromRoomId(roomId, cleanStale);
        const payload = {
          type: 'USER_LEFT',
          event: 'USER_DISCONNECTED',
          roomId,
          userId: cleanStale,
          peerAlive: false,
          reason: 'Partner disconnected / left the channel',
          timestamp: Date.now(),
        };
        broadcastToRoom(roomId, payload);
        if (peerId) {
          sendToUser(peerId, payload);
        }
      }
    }

    broadcastGlobalPresence();
  }

  function registerUserSocket(ws: WsClient, rawUserId: string, publicKey?: string) {
    const cleanUserId = normalizeCode(rawUserId);
    if (!cleanUserId) return;

    if (ws.userId && ws.userId !== cleanUserId) {
      const previousId = ws.userId;
      if (userClients.has(previousId)) {
        userClients.get(previousId)?.delete(ws);
      }
      severStaleIdentity(previousId);
    }

    ws.userId = cleanUserId;
    if (!userClients.has(cleanUserId)) {
      userClients.set(cleanUserId, new Set());
    }
    userClients.get(cleanUserId)!.add(ws);
    registerActiveIdentity(cleanUserId, publicKey);
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

        if (data.type === 'ping') {
          if (ws.userId) {
            registerActiveIdentity(ws.userId);
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } else if (data.type === 'user:identify' && data.userId) {
          registerUserSocket(ws, data.userId, data.publicKey);
          broadcastGlobalPresence();
        } else if (data.type === 'room:join' && data.roomId && data.userId) {
          if (ws.roomId && roomClients.has(ws.roomId)) {
            roomClients.get(ws.roomId)?.delete(ws);
            broadcastRoomPresence(ws.roomId);
          }
          const cleanRoomId = String(data.roomId);
          registerUserSocket(ws, data.userId, data.publicKey);
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
        } else if (data.type === 'webrtc:signal' && data.targetUserId && ws.userId) {
          // Non-Intrusive Hybrid WebRTC P2P Signaling Relay (Offer / Answer / ICE Candidate)
          const targetPeer = normalizeCode(String(data.targetUserId));
          sendToUser(targetPeer, {
            type: 'webrtc:signal',
            roomId: String(data.roomId || ''),
            fromUserId: ws.userId,
            targetUserId: targetPeer,
            signalType: String(data.signalType || ''),
            sdp: data.sdp || null,
            candidate: data.candidate || null,
            timestamp: Date.now(),
          });
        }
      } catch {
        // Ignore malformed WS packets
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      const closedUserId = ws.userId;
      const closedRoomId = ws.roomId;
      let userStillHasOpenSockets = false;

      if (closedUserId && userClients.has(closedUserId)) {
        const uSet = userClients.get(closedUserId)!;
        uSet.delete(ws);
        if (uSet.size === 0) {
          userClients.delete(closedUserId);
        } else {
          userStillHasOpenSockets = true;
        }
      }

      if (closedRoomId && roomClients.has(closedRoomId)) {
        const set = roomClients.get(closedRoomId)!;
        set.delete(ws);
        if (set.size === 0) {
          roomClients.delete(closedRoomId);
        } else {
          broadcastRoomPresence(closedRoomId);
        }
      }

      if (closedUserId && !userStillHasOpenSockets) {
        if (closedRoomId && closedRoomId !== GLOBAL_ROOM_ID) {
          const peerId = extractPeerFromRoomId(closedRoomId, closedUserId);
          const disconnectPayload = {
            type: 'USER_DISCONNECTED',
            event: 'USER_LEFT',
            roomId: closedRoomId,
            userId: closedUserId,
            peerAlive: false,
            reason: 'Partner disconnected / left the channel',
            timestamp: Date.now(),
          };
          broadcastToRoom(closedRoomId, disconnectPayload);
          if (peerId) {
            sendToUser(peerId, disconnectPayload);
          }
        }
      }

      broadcastGlobalPresence();
    });
  });

  const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  function generateRandomUserId(length: number): string {
    let suffix = '';
    for (let i = 0; i < length; i++) {
      suffix += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    }
    return `USER-${suffix}`;
  }

  function isUserIdTakenByAnotherSession(candidateId: string): boolean {
    if (isUserCurrentlyOnline(candidateId)) return true;
    const cutoff = Date.now() - TTL_MS;
    const record = memoryActiveUsers.get(candidateId);
    return Boolean(record && record.last_seen >= cutoff);
  }

  function assignUniqueUserId(
    requestedId?: string,
    isExistingSession?: boolean
  ): { userId: string; collisionResolved: boolean } {
    const cleanRequested = normalizeCode(requestedId || '');
    if (cleanRequested && /^USER-[A-Z0-9]{4,6}$/.test(cleanRequested)) {
      if (isExistingSession || !isUserIdTakenByAnotherSession(cleanRequested)) {
        return { userId: cleanRequested, collisionResolved: false };
      }
    }

    // Dynamic length scaling: 4 chars -> 5 chars -> 6 chars on collision
    const lengthsToTry = [4, 5, 6];
    for (const len of lengthsToTry) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = generateRandomUserId(len);
        if (!isUserIdTakenByAnotherSession(candidate)) {
          return {
            userId: candidate,
            collisionResolved: Boolean(cleanRequested && candidate !== cleanRequested),
          };
        }
      }
    }

    return { userId: generateRandomUserId(6), collisionResolved: true };
  }

  // Register/Heartbeat User Identity + Collision Check & Retry Scaling (4 -> 5 -> 6 chars)
  app.post('/api/users/register', (req, res) => {
    try {
      cleanupExpiredData();
      const requestedId = normalizeCode(req.body?.userId);
      const previousUserId = normalizeCode(req.body?.previousUserId);
      const isExistingSession = Boolean(req.body?.isExistingSession);
      const publicKey = req.body?.publicKey ? String(req.body.publicKey) : undefined;

      if (previousUserId && previousUserId !== requestedId) {
        severStaleIdentity(previousUserId);
      }

      const { userId, collisionResolved } = assignUniqueUserId(requestedId, isExistingSession);

      if (requestedId && userId !== requestedId) {
        severStaleIdentity(requestedId);
      }

      registerActiveIdentity(userId, publicKey);
      res.status(200).json({
        ok: true,
        userId,
        collisionResolved,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({
        ok: false,
        error: 'Failed to register user session.',
      });
    }
  });

  // Explicit Leave / Sever Identity Endpoint
  app.post('/api/users/leave', (req, res) => {
    try {
      const userId = normalizeCode(req.body?.userId);
      if (userId) {
        severStaleIdentity(userId);
      }
      res.status(200).json({ ok: true });
    } catch {
      res.status(200).json({ ok: true });
    }
  });

  // Health & Ephemeral RAM Status Endpoint
  app.get('/api/status', (_req, res) => {
    const cleanup = cleanupExpiredData();
    let totalMessages = 0;
    for (const list of memoryMessages.values()) {
      totalMessages += list.length;
    }
    res.status(200).json({
      ok: true,
      storageMode: 'in-memory-ephemeral-ram',
      ttlHours: 1,
      activeRooms: Math.max(0, memoryRooms.size - 1),
      activeMessages: totalMessages,
      cleanedUp: cleanup,
      timestamp: Date.now(),
    });
  });

  // Get All Active 1-on-1 Private Conversations for a User
  app.get('/api/users/:userId/conversations', (req, res) => {
    try {
      cleanupExpiredData();
      const myId = normalizeCode(req.params.userId);
      if (!myId) {
        res.status(400).json({ ok: false, error: 'Valid User ID is required.' });
        return;
      }

      registerActiveIdentity(myId);
      const cutoff = Date.now() - TTL_MS;
      const conversations = [];

      for (const [roomId, roomObj] of memoryRooms.entries()) {
        if (roomId === GLOBAL_ROOM_ID || roomObj.created_at < cutoff) continue;
        if (!roomId.startsWith(`${myId}__`) && !roomId.endsWith(`__${myId}`)) continue;

        const createdAt = Number(roomObj.created_at);
        const peerId = extractPeerFromRoomId(roomId, myId);
        if (!peerId) continue;

        const validMsgs = (memoryMessages.get(roomId) || []).filter(
          (m) => m.timestamp >= cutoff
        );
        const lastRaw = validMsgs.length > 0 ? validMsgs[validMsgs.length - 1] : null;
        const lastMessage = lastRaw
          ? {
              id: String(lastRaw.id),
              sender_id: String(lastRaw.sender_id),
              content: String(lastRaw.content),
              timestamp: Number(lastRaw.timestamp),
            }
          : null;

        conversations.push({
          room_id: roomId,
          peer_id: peerId,
          peer_public_key: getPeerPublicKey(peerId),
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
          message_count: validMsgs.length,
          last_message: lastMessage,
          updated_at: lastMessage ? lastMessage.timestamp : createdAt,
        });
      }

      conversations.sort((a, b) => b.updated_at - a.updated_at);
      res.status(200).json({ ok: true, conversations });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch private conversations.',
      });
    }
  });

  // Get Global Public Chat Messages (Last 1h) + Reactions
  app.get('/api/global/messages', (_req, res) => {
    try {
      cleanupExpiredData();
      ensureGlobalRoomExists();

      const cutoff = Date.now() - TTL_MS;
      const rawMsgs = (memoryMessages.get(GLOBAL_ROOM_ID) || []).filter(
        (m) => m.timestamp >= cutoff
      );
      const reactionsByMsg = getReactionsForRoom(GLOBAL_ROOM_ID, cutoff);

      const messages: MessageRowFormatted[] = rawMsgs.slice(-200).map((row) => ({
        id: String(row.id),
        room_id: String(row.room_id),
        sender_id: String(row.sender_id),
        content: String(row.content),
        timestamp: Number(row.timestamp),
        reactions: reactionsByMsg[String(row.id)] || {},
      }));

      res.status(200).json({
        ok: true,
        roomId: GLOBAL_ROOM_ID,
        messages,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch global chat messages.',
      });
    }
  });

  // Post a Message to Global Public Chat
  app.post('/api/global/messages', (req, res) => {
    try {
      cleanupExpiredData();
      ensureGlobalRoomExists();

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

      registerActiveIdentity(senderId);

      const now = Date.now();
      const messageId =
        clientMsgId || `GLB-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      const roomList = memoryMessages.get(GLOBAL_ROOM_ID) || [];
      const exists = roomList.some((m) => m.id === messageId);

      const messageRecord: MessageRowFormatted = {
        id: messageId,
        room_id: GLOBAL_ROOM_ID,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      if (!exists) {
        roomList.push({
          id: messageRecord.id,
          room_id: messageRecord.room_id,
          sender_id: messageRecord.sender_id,
          content: messageRecord.content,
          timestamp: messageRecord.timestamp,
        });
        memoryMessages.set(GLOBAL_ROOM_ID, roomList);

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
    } catch {
      res.status(500).json({
        ok: false,
        error: 'Failed to store global message.',
      });
    }
  });

  // Connect or Create 1-on-1 Private Room
  app.post('/api/rooms/connect', (req, res) => {
    try {
      cleanupExpiredData();

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
      registerActiveIdentity(myId, myPublicKey);

      if (!doesUserExistOrOnline(peerId)) {
        res.status(404).json({
          ok: false,
          error: 'User not found. Please check the ID and try again.',
        });
        return;
      }

      const roomId = buildRoomId(myId, peerId);
      const now = Date.now();
      const cutoff = now - TTL_MS;

      let roomObj = memoryRooms.get(roomId);
      const isNewRoom = !roomObj;
      if (!roomObj) {
        roomObj = { room_id: roomId, created_at: now };
        memoryRooms.set(roomId, roomObj);
        memoryMessages.set(roomId, []);
      }

      const createdAt = Number(roomObj.created_at);
      const rawMsgs = (memoryMessages.get(roomId) || []).filter((m) => m.timestamp >= cutoff);
      const reactionsByMsg = getReactionsForRoom(roomId, cutoff);
      const peerPublicKey = getPeerPublicKey(peerId);
      const senderPublicKey = getPeerPublicKey(myId);

      const messages: MessageRowFormatted[] = rawMsgs.map((row) => ({
        id: String(row.id),
        room_id: String(row.room_id),
        sender_id: String(row.sender_id),
        content: String(row.content),
        timestamp: Number(row.timestamp),
        reactions: reactionsByMsg[String(row.id)] || {},
      }));

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
          peer_alive: true,
        },
        messages,
      });
    } catch {
      res.status(500).json({
        ok: false,
        error: 'Failed to initialize private room.',
      });
    }
  });

  // Get Private Room Messages & Verify Room Existence
  app.get('/api/rooms/:roomId/messages', (req, res) => {
    try {
      cleanupExpiredData();
      const roomId = String(req.params.roomId || '').trim();
      if (!roomId) {
        res.status(400).json({ ok: false, error: 'Room ID is required.' });
        return;
      }

      const cutoff = Date.now() - TTL_MS;
      const roomObj = memoryRooms.get(roomId);
      if (!roomObj || (roomId !== GLOBAL_ROOM_ID && roomObj.created_at < cutoff)) {
        res.status(200).json({
          ok: true,
          roomExists: false,
          room: null,
          messages: [],
        });
        return;
      }

      const createdAt = Number(roomObj.created_at);
      const requesterId = normalizeCode(String(req.query.myId || ''));
      const peerId = requesterId ? extractPeerFromRoomId(roomId, requesterId) : null;
      const peerAlive = peerId ? doesUserExistOrOnline(peerId) : true;

      const rawMsgs = (memoryMessages.get(roomId) || []).filter((m) => m.timestamp >= cutoff);
      const reactionsByMsg = getReactionsForRoom(roomId, cutoff);

      const messages: MessageRowFormatted[] = rawMsgs.map((row) => ({
        id: String(row.id),
        room_id: String(row.room_id),
        sender_id: String(row.sender_id),
        content: String(row.content),
        timestamp: Number(row.timestamp),
        reactions: reactionsByMsg[String(row.id)] || {},
      }));

      res.status(200).json({
        ok: true,
        roomExists: true,
        peerAlive,
        room: {
          room_id: roomId,
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
        },
        messages,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch room messages.',
      });
    }
  });

  // Send a Private 1-on-1 Message
  app.post('/api/rooms/:roomId/messages', (req, res) => {
    try {
      cleanupExpiredData();

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

      const recipientId = extractPeerFromRoomId(roomId, senderId);
      if (recipientId && !doesUserExistOrOnline(recipientId)) {
        res.status(410).json({
          ok: false,
          peerDisconnected: true,
          error: 'Partner disconnected / left the channel',
        });
        return;
      }

      registerActiveIdentity(senderId);

      const now = Date.now();
      const messageId =
        clientMsgId || `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      if (!memoryRooms.has(roomId)) {
        memoryRooms.set(roomId, { room_id: roomId, created_at: now });
      }

      const roomList = memoryMessages.get(roomId) || [];
      const exists = roomList.some((m) => m.id === messageId);

      const messageRecord: MessageRowFormatted = {
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      if (!exists) {
        roomList.push({
          id: messageRecord.id,
          room_id: messageRecord.room_id,
          sender_id: messageRecord.sender_id,
          content: messageRecord.content,
          timestamp: messageRecord.timestamp,
        });
        memoryMessages.set(roomId, roomList);

        broadcastToRoom(roomId, {
          type: 'message:created',
          roomId,
          message: messageRecord,
        });

        if (recipientId) {
          const senderPublicKey = getPeerPublicKey(senderId);
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
    } catch {
      res.status(500).json({
        ok: false,
        error: 'Failed to store private message.',
      });
    }
  });

  // Toggle or Add Reaction on any Message (Global or Private)
  app.post('/api/messages/:messageId/reactions', (req, res) => {
    try {
      const messageId = String(req.params.messageId || '').trim();
      const roomId = String(req.body?.roomId || '').trim();
      const userId = normalizeCode(req.body?.userId);
      const emoji = String(req.body?.emoji || '').trim();
      const mode = String(req.body?.mode || 'toggle');

      if (!messageId || !roomId || !userId || !emoji) {
        res.status(400).json({ ok: false, error: 'Missing reaction parameters.' });
        return;
      }

      const now = Date.now();
      let entry = memoryMessageReactions.get(messageId);
      if (!entry) {
        entry = { roomId, timestamp: now, reactions: new Map() };
        memoryMessageReactions.set(messageId, entry);
      }
      entry.timestamp = now;

      let userSet = entry.reactions.get(emoji);
      if (!userSet) {
        userSet = new Set();
        entry.reactions.set(emoji, userSet);
      }

      if (userSet.has(userId) && mode === 'toggle') {
        userSet.delete(userId);
        if (userSet.size === 0) {
          entry.reactions.delete(emoji);
        }
      } else {
        userSet.add(userId);
      }

      const updatedReactions = getReactionsForMessage(messageId);
      const eventPayload = {
        type: 'message:reaction_updated',
        roomId,
        messageId,
        reactions: updatedReactions,
      };

      broadcastToRoom(roomId, eventPayload);

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
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to update message reaction.',
      });
    }
  });

  // The "Nuke Chat" Endpoint - Hard Wipes in-memory room messages and reactions for both users
  app.delete('/api/rooms/:roomId/nuke', (req, res) => {
    try {
      const roomId = String(req.params.roomId || '').trim();
      const triggeredBy = normalizeCode(req.body?.triggeredBy || 'UNKNOWN');

      if (!roomId || roomId === GLOBAL_ROOM_ID) {
        res.status(400).json({ ok: false, error: 'Valid private Room ID is required to execute Nuke.' });
        return;
      }

      const peerId = extractPeerFromRoomId(roomId, triggeredBy);
      const roomMsgs = memoryMessages.get(roomId) || [];
      const deletedCount = roomMsgs.length;

      for (const m of roomMsgs) {
        memoryMessageReactions.delete(m.id);
      }
      for (const [msgId, entry] of memoryMessageReactions.entries()) {
        if (entry.roomId === roomId) {
          memoryMessageReactions.delete(msgId);
        }
      }
      memoryMessages.delete(roomId);
      memoryRooms.delete(roomId);

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
        deletedMessages: deletedCount,
        deletedRooms: 1,
        hardWiped: true,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({
        ok: false,
        error: 'Failed to nuke room records.',
      });
    }
  });

  // Trigger manual 1h TTL sweep
  app.post('/api/maintenance/cleanup', (_req, res) => {
    const result = cleanupExpiredData();
    res.status(200).json({
      ok: true,
      ...result,
      timestamp: Date.now(),
    });
  });

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
