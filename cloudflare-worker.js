// Cloudflare Worker + Durable Object (Zero-Trace Blind Relay + Real-time WebSockets)
// WhisperNet Zero-Trace Backend: Collision-Safe Identity Engine (4 -> 5 -> 6 chars), 24h TTL Purge, & Bilateral Nuke

const TTL_MS = 24 * 60 * 60 * 1000;
const GLOBAL_ROOM_ID = 'GLOBAL';
const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function generateRandomUserId(length) {
  let suffix = '';
  const randomBytes = new Uint32Array(length);
  crypto.getRandomValues(randomBytes);
  for (let i = 0; i < length; i++) {
    suffix += ID_CHARS[randomBytes[i] % ID_CHARS.length];
  }
  return `USER-${suffix}`;
}

function buildRoomId(userA, userB) {
  const sorted = [normalizeCode(userA), normalizeCode(userB)].sort();
  return `${sorted[0]}__${sorted[1]}`;
}

function extractPeerFromRoomId(roomId, myId) {
  const parts = String(roomId).split('__');
  if (parts.length !== 2) return null;
  const cleanMyId = normalizeCode(myId);
  if (parts[0] === cleanMyId) return parts[1];
  if (parts[1] === cleanMyId) return parts[0];
  return null;
}

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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200, request = null, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    },
  });
}

export class WhisperNetHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.clients = new Set();
    this.initSchema();
  }

  initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_users (
        user_id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL,
        public_key TEXT
      );
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
    `);
    try {
      this.sql.exec(`ALTER TABLE active_users ADD COLUMN public_key TEXT`);
    } catch {
      // Column already exists
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO rooms (room_id, created_at) VALUES (?, ?)`,
      GLOBAL_ROOM_ID,
      now
    );
  }

  cleanupExpiredData() {
    const cutoff = Date.now() - TTL_MS;
    this.sql.exec(`DELETE FROM messages WHERE timestamp < ?`, cutoff);
    this.sql.exec(
      `DELETE FROM rooms WHERE created_at < ? AND room_id != ?`,
      cutoff,
      GLOBAL_ROOM_ID
    );
    this.sql.exec(`DELETE FROM active_users WHERE last_seen < ?`, cutoff);
    this.sql.exec(`DELETE FROM message_reactions WHERE timestamp < ?`, cutoff);
  }

  isUserIdTaken(candidateId) {
    const clean = normalizeCode(candidateId);
    if (!clean) return false;
    for (const c of this.clients) {
      if (c.userId === clean) return true;
    }
    const cutoff = Date.now() - TTL_MS;
    const rows = this.sql
      .exec(
        `SELECT user_id FROM active_users WHERE user_id = ? AND last_seen >= ? LIMIT 1`,
        clean,
        cutoff
      )
      .toArray();
    return rows.length > 0;
  }

  assignCollisionFreeIdentity(requestedId, isExistingSession = false) {
    const cleanRequested = normalizeCode(requestedId || '');
    if (cleanRequested && /^USER-[A-Z0-9]{4,6}$/.test(cleanRequested)) {
      if (isExistingSession || !this.isUserIdTaken(cleanRequested)) {
        return { userId: cleanRequested, collisionResolved: false };
      }
    }

    // Dynamic length scaling: 4 chars -> 5 chars -> 6 chars when collisions occur
    const lengths = [4, 5, 6];
    for (const len of lengths) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = generateRandomUserId(len);
        if (!this.isUserIdTaken(candidate)) {
          return {
            userId: candidate,
            collisionResolved: Boolean(cleanRequested && candidate !== cleanRequested),
          };
        }
      }
    }

    return { userId: generateRandomUserId(6), collisionResolved: true };
  }

  registerIdentity(userId, publicKey) {
    const clean = normalizeCode(userId);
    if (!clean || clean.length < 4) return;
    const now = Date.now();
    if (publicKey && typeof publicKey === 'string') {
      this.sql.exec(
        `INSERT INTO active_users (user_id, last_seen, public_key) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           public_key = COALESCE(excluded.public_key, active_users.public_key)`,
        clean,
        now,
        publicKey
      );
    } else {
      this.sql.exec(
        `INSERT INTO active_users (user_id, last_seen) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`,
        clean,
        now
      );
    }
  }

  getPeerPublicKey(userId) {
    const clean = normalizeCode(userId);
    if (!clean) return null;
    const rows = this.sql
      .exec(`SELECT public_key FROM active_users WHERE user_id = ? LIMIT 1`, clean)
      .toArray();
    return rows[0]?.public_key ? String(rows[0].public_key) : null;
  }

  getReactionsForRoom(roomId, cutoff) {
    const mapByMessage = {};
    const rows = this.sql
      .exec(
        `SELECT message_id, user_id, emoji FROM message_reactions WHERE room_id = ? AND timestamp >= ?`,
        roomId,
        cutoff
      )
      .toArray();
    for (const row of rows) {
      const msgId = String(row.message_id);
      const userId = String(row.user_id);
      const emoji = String(row.emoji);
      if (!mapByMessage[msgId]) mapByMessage[msgId] = {};
      if (!mapByMessage[msgId][emoji]) mapByMessage[msgId][emoji] = [];
      if (!mapByMessage[msgId][emoji].includes(userId)) {
        mapByMessage[msgId][emoji].push(userId);
      }
    }
    return mapByMessage;
  }

  getReactionsForMessage(messageId) {
    const reactionMap = {};
    const rows = this.sql
      .exec(`SELECT user_id, emoji FROM message_reactions WHERE message_id = ?`, messageId)
      .toArray();
    for (const row of rows) {
      const userId = String(row.user_id);
      const emoji = String(row.emoji);
      if (!reactionMap[emoji]) reactionMap[emoji] = [];
      if (!reactionMap[emoji].includes(userId)) {
        reactionMap[emoji].push(userId);
      }
    }
    return reactionMap;
  }

  broadcastToAll(payload) {
    const str = JSON.stringify(payload);
    for (const client of this.clients) {
      try {
        client.ws.send(str);
      } catch {
        // ignore closed socket
      }
    }
  }

  sendToUser(targetUserId, payload) {
    const clean = normalizeCode(targetUserId);
    const str = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.userId === clean) {
        try {
          client.ws.send(str);
        } catch {
          // ignore
        }
      }
    }
  }

  broadcastToRoom(roomId, payload) {
    if (roomId === GLOBAL_ROOM_ID) {
      this.broadcastToAll(payload);
      return;
    }
    const str = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.roomId === roomId) {
        try {
          client.ws.send(str);
        } catch {
          // ignore
        }
      }
    }
  }

  broadcastGlobalPresence() {
    const online = new Set();
    for (const c of this.clients) {
      if (c.userId) online.add(c.userId);
    }
    this.broadcastToAll({
      type: 'global:presence',
      users: Array.from(online),
      onlineCount: online.size,
    });
  }

  broadcastRoomPresence(roomId) {
    const active = new Set();
    for (const c of this.clients) {
      if (c.roomId === roomId && c.userId) {
        active.add(c.userId);
      }
    }
    this.broadcastToRoom(roomId, {
      type: 'room:presence',
      roomId,
      participants: Array.from(active),
      onlineCount: active.size,
    });
  }

  doesUserExistOrOnline(targetUserId, requesterId) {
    const cleanTarget = normalizeCode(targetUserId);
    const cleanRequester = normalizeCode(requesterId);
    if (!cleanTarget || cleanTarget.length < 4) return false;

    for (const c of this.clients) {
      if (c.userId === cleanTarget) return true;
    }

    const cutoff = Date.now() - TTL_MS;
    const activeRows = this.sql
      .exec(
        `SELECT user_id FROM active_users WHERE user_id = ? AND last_seen >= ? LIMIT 1`,
        cleanTarget,
        cutoff
      )
      .toArray();
    if (activeRows.length > 0) return true;

    const msgRows = this.sql
      .exec(
        `SELECT id FROM messages WHERE sender_id = ? AND timestamp >= ? LIMIT 1`,
        cleanTarget,
        cutoff
      )
      .toArray();
    if (msgRows.length > 0) return true;

    const candidateRoomId = buildRoomId(cleanRequester, cleanTarget);
    const roomRows = this.sql
      .exec(
        `SELECT room_id FROM rooms WHERE room_id = ? AND created_at >= ? LIMIT 1`,
        candidateRoomId,
        cutoff
      )
      .toArray();
    return roomRows.length > 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return jsonResponse({ ok: true }, 200, request, this.env);
    }

    // WebSocket Upgrade at /ws
    if (pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const session = { ws: server, userId: null, roomId: null };
      this.clients.add(session);

      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.type === 'user:identify' && data.userId) {
            session.userId = normalizeCode(data.userId);
            this.registerIdentity(session.userId, data.publicKey);
            this.broadcastGlobalPresence();
          } else if (data.type === 'room:join' && data.roomId && data.userId) {
            const prevRoom = session.roomId;
            session.userId = normalizeCode(data.userId);
            session.roomId = String(data.roomId);
            this.registerIdentity(session.userId, data.publicKey);
            if (prevRoom && prevRoom !== session.roomId) {
              this.broadcastRoomPresence(prevRoom);
            }
            this.broadcastRoomPresence(session.roomId);
            this.broadcastGlobalPresence();
          } else if (data.type === 'room:typing' && data.roomId && session.userId) {
            this.broadcastToRoom(String(data.roomId), {
              type: 'room:typing',
              roomId: String(data.roomId),
              userId: session.userId,
              isTyping: Boolean(data.isTyping),
            });
          }
        } catch {
          // ignore invalid JSON
        }
      });

      server.addEventListener('close', () => {
        this.clients.delete(session);
        if (session.roomId) {
          this.broadcastRoomPresence(session.roomId);
        }
        this.broadcastGlobalPresence();
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    this.cleanupExpiredData();

    // POST /api/users/register (Collision Check + Dynamic 4->5->6 Character Scaling)
    if (pathname === '/api/users/register' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const requestedId = normalizeCode(body.userId);
      const isExistingSession = Boolean(body.isExistingSession);
      const publicKey = body.publicKey ? String(body.publicKey) : undefined;

      const { userId, collisionResolved } = this.assignCollisionFreeIdentity(
        requestedId,
        isExistingSession
      );

      this.registerIdentity(userId, publicKey);
      return jsonResponse(
        {
          ok: true,
          userId,
          collisionResolved,
          timestamp: Date.now(),
        },
        200,
        request,
        this.env
      );
    }

    // GET /api/global/messages
    if (pathname === '/api/global/messages' && request.method === 'GET') {
      const cutoff = Date.now() - TTL_MS;
      const rows = this.sql
        .exec(
          `SELECT id, room_id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 200`,
          GLOBAL_ROOM_ID,
          cutoff
        )
        .toArray();
      const reactionsByMsg = this.getReactionsForRoom(GLOBAL_ROOM_ID, cutoff);
      const messages = rows.map((r) => ({
        id: String(r.id),
        room_id: String(r.room_id),
        sender_id: String(r.sender_id),
        content: String(r.content),
        timestamp: Number(r.timestamp),
        reactions: reactionsByMsg[String(r.id)] || {},
      }));
      return jsonResponse({ ok: true, roomId: GLOBAL_ROOM_ID, messages }, 200, request, this.env);
    }

    // POST /api/global/messages
    if (pathname === '/api/global/messages' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const senderId = normalizeCode(body.senderId);
      const content = String(body.content || '').trim();
      const now = Date.now();
      const messageId =
        String(body.id || '').trim() ||
        `GLB-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      if (!senderId || !content) {
        return jsonResponse(
          { ok: false, error: 'Missing senderId or content.' },
          400,
          request,
          this.env
        );
      }
      this.registerIdentity(senderId);
      this.sql.exec(
        `INSERT OR IGNORE INTO messages (id, room_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
        messageId,
        GLOBAL_ROOM_ID,
        senderId,
        content,
        now
      );
      const messageRecord = {
        id: messageId,
        room_id: GLOBAL_ROOM_ID,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };
      this.broadcastToAll({
        type: 'global:message:created',
        roomId: GLOBAL_ROOM_ID,
        message: messageRecord,
      });
      return jsonResponse({ ok: true, message: messageRecord }, 200, request, this.env);
    }

    // POST /api/rooms/connect
    if (pathname === '/api/rooms/connect' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const myId = normalizeCode(body.myId);
      const peerId = normalizeCode(body.peerId);
      const myPublicKey = body.publicKey ? String(body.publicKey) : undefined;
      const notifyPeer = body.notifyPeer !== false;

      if (!myId || myId.length < 4) {
        return jsonResponse(
          { ok: false, error: 'Invalid session identity code.' },
          400,
          request,
          this.env
        );
      }
      if (!peerId || !/^USER-[A-Z0-9]{4,8}$/.test(peerId) || myId === peerId) {
        return jsonResponse(
          { ok: false, error: 'User not found. Please check the ID and try again.' },
          404,
          request,
          this.env
        );
      }
      this.registerIdentity(myId, myPublicKey);

      if (!this.doesUserExistOrOnline(peerId, myId)) {
        return jsonResponse(
          { ok: false, error: 'User not found. Please check the ID and try again.' },
          404,
          request,
          this.env
        );
      }

      const roomId = buildRoomId(myId, peerId);
      const now = Date.now();
      const cutoff = now - TTL_MS;

      const existing = this.sql
        .exec(`SELECT room_id, created_at FROM rooms WHERE room_id = ?`, roomId)
        .toArray();
      let createdAt = now;
      const isNewRoom = existing.length === 0;
      if (isNewRoom) {
        this.sql.exec(`INSERT INTO rooms (room_id, created_at) VALUES (?, ?)`, roomId, now);
      } else {
        createdAt = Number(existing[0].created_at);
      }

      const rows = this.sql
        .exec(
          `SELECT id, room_id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp ASC`,
          roomId,
          cutoff
        )
        .toArray();
      const reactionsByMsg = this.getReactionsForRoom(roomId, cutoff);
      const peerPublicKey = this.getPeerPublicKey(peerId);
      const senderPublicKey = this.getPeerPublicKey(myId);

      const messages = rows.map((r) => ({
        id: String(r.id),
        room_id: String(r.room_id),
        sender_id: String(r.sender_id),
        content: String(r.content),
        timestamp: Number(r.timestamp),
        reactions: reactionsByMsg[String(r.id)] || {},
      }));

      if (notifyPeer) {
        this.sendToUser(peerId, {
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

      return jsonResponse(
        {
          ok: true,
          room: {
            room_id: roomId,
            created_at: createdAt,
            expires_at: createdAt + TTL_MS,
            peer_id: peerId,
            peer_public_key: peerPublicKey,
          },
          messages,
        },
        200,
        request,
        this.env
      );
    }

    // GET /api/users/:userId/conversations
    const convMatch = pathname.match(/^\/api\/users\/([^/]+)\/conversations$/);
    if (convMatch && request.method === 'GET') {
      const myId = normalizeCode(decodeURIComponent(convMatch[1]));
      this.registerIdentity(myId);
      const cutoff = Date.now() - TTL_MS;
      const rooms = this.sql
        .exec(
          `SELECT room_id, created_at FROM rooms WHERE (room_id LIKE ? OR room_id LIKE ?) AND created_at >= ? ORDER BY created_at DESC`,
          `${myId}__%`,
          `%__${myId}`,
          cutoff
        )
        .toArray();

      const conversations = [];
      for (const row of rooms) {
        const roomId = String(row.room_id);
        const createdAt = Number(row.created_at);
        const peerId = extractPeerFromRoomId(roomId, myId);
        if (!peerId) continue;

        const lastMsg = this.sql
          .exec(
            `SELECT id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1`,
            roomId,
            cutoff
          )
          .toArray();
        const countRes = this.sql
          .exec(
            `SELECT COUNT(*) as count FROM messages WHERE room_id = ? AND timestamp >= ?`,
            roomId,
            cutoff
          )
          .toArray();

        const lastMessage = lastMsg[0]
          ? {
              id: String(lastMsg[0].id),
              sender_id: String(lastMsg[0].sender_id),
              content: String(lastMsg[0].content),
              timestamp: Number(lastMsg[0].timestamp),
            }
          : null;

        conversations.push({
          room_id: roomId,
          peer_id: peerId,
          peer_public_key: this.getPeerPublicKey(peerId),
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
          message_count: Number(countRes[0]?.count ?? 0),
          last_message: lastMessage,
          updated_at: lastMessage ? lastMessage.timestamp : createdAt,
        });
      }
      conversations.sort((a, b) => b.updated_at - a.updated_at);
      return jsonResponse({ ok: true, conversations }, 200, request, this.env);
    }

    // GET /api/rooms/:roomId/messages
    const roomMsgsMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
    if (roomMsgsMatch && request.method === 'GET') {
      const roomId = decodeURIComponent(roomMsgsMatch[1]);
      const cutoff = Date.now() - TTL_MS;
      const roomCheck = this.sql
        .exec(`SELECT room_id, created_at FROM rooms WHERE room_id = ?`, roomId)
        .toArray();
      if (roomCheck.length === 0) {
        return jsonResponse(
          { ok: true, roomExists: false, messages: [] },
          200,
          request,
          this.env
        );
      }
      const rows = this.sql
        .exec(
          `SELECT id, room_id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp ASC`,
          roomId,
          cutoff
        )
        .toArray();
      const reactionsByMsg = this.getReactionsForRoom(roomId, cutoff);
      const messages = rows.map((r) => ({
        id: String(r.id),
        room_id: String(r.room_id),
        sender_id: String(r.sender_id),
        content: String(r.content),
        timestamp: Number(r.timestamp),
        reactions: reactionsByMsg[String(r.id)] || {},
      }));
      return jsonResponse(
        {
          ok: true,
          roomExists: true,
          createdAt: Number(roomCheck[0].created_at),
          messages,
        },
        200,
        request,
        this.env
      );
    }

    // POST /api/rooms/:roomId/messages
    if (roomMsgsMatch && request.method === 'POST') {
      const roomId = decodeURIComponent(roomMsgsMatch[1]);
      const body = await request.json().catch(() => ({}));
      const senderId = normalizeCode(body.senderId);
      const content = String(body.content || '').trim();
      const now = Date.now();
      const messageId =
        String(body.id || '').trim() ||
        `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      if (!roomId || !senderId || !content) {
        return jsonResponse(
          { ok: false, error: 'Missing required message fields.' },
          400,
          request,
          this.env
        );
      }
      this.registerIdentity(senderId);
      this.sql.exec(
        `INSERT OR IGNORE INTO rooms (room_id, created_at) VALUES (?, ?)`,
        roomId,
        now
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO messages (id, room_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
        messageId,
        roomId,
        senderId,
        content,
        now
      );

      const messageRecord = {
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      this.broadcastToRoom(roomId, {
        type: 'message:created',
        roomId,
        message: messageRecord,
      });

      const recipientId = extractPeerFromRoomId(roomId, senderId);
      const senderPublicKey = this.getPeerPublicKey(senderId);
      if (recipientId) {
        this.sendToUser(recipientId, {
          type: 'private:message_notification',
          roomId,
          fromUserId: senderId,
          fromPublicKey: senderPublicKey,
          toUserId: recipientId,
          message: messageRecord,
        });
      }

      return jsonResponse({ ok: true, message: messageRecord }, 200, request, this.env);
    }

    // POST /api/messages/:messageId/reactions
    const reactMatch = pathname.match(/^\/api\/messages\/([^/]+)\/reactions$/);
    if (reactMatch && request.method === 'POST') {
      const messageId = decodeURIComponent(reactMatch[1]);
      const body = await request.json().catch(() => ({}));
      const roomId = String(body.roomId || '').trim();
      const userId = normalizeCode(body.userId);
      const emoji = String(body.emoji || '').trim();
      const mode = body.mode === 'add' ? 'add' : 'toggle';

      if (!messageId || !roomId || !userId || !emoji) {
        return jsonResponse(
          { ok: false, error: 'Missing reaction fields.' },
          400,
          request,
          this.env
        );
      }

      const existing = this.sql
        .exec(
          `SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? LIMIT 1`,
          messageId,
          userId,
          emoji
        )
        .toArray();

      const now = Date.now();
      if (existing.length > 0 && mode === 'toggle') {
        this.sql.exec(
          `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
          messageId,
          userId,
          emoji
        );
      } else if (existing.length === 0) {
        this.sql.exec(
          `INSERT INTO message_reactions (message_id, room_id, user_id, emoji, timestamp) VALUES (?, ?, ?, ?, ?)`,
          messageId,
          roomId,
          userId,
          emoji,
          now
        );
      }

      const reactions = this.getReactionsForMessage(messageId);
      const payload = {
        type: 'message:reaction_updated',
        roomId,
        messageId,
        reactions,
        userId,
        emoji,
      };

      if (roomId === GLOBAL_ROOM_ID) {
        this.broadcastToAll(payload);
      } else {
        this.broadcastToRoom(roomId, payload);
        const parts = roomId.split('__');
        if (parts.length === 2) {
          this.sendToUser(parts[0], payload);
          this.sendToUser(parts[1], payload);
        }
      }

      return jsonResponse(
        { ok: true, messageId, roomId, reactions },
        200,
        request,
        this.env
      );
    }

    // DELETE /api/rooms/:roomId/nuke
    const nukeMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/nuke$/);
    if (nukeMatch && request.method === 'DELETE') {
      const roomId = decodeURIComponent(nukeMatch[1]);
      const body = await request.json().catch(() => ({}));
      const triggeredBy = normalizeCode(body.triggeredBy || 'PEER');

      if (!roomId || roomId === GLOBAL_ROOM_ID) {
        return jsonResponse({ ok: false, error: 'Invalid room ID.' }, 400, request, this.env);
      }

      this.sql.exec(`DELETE FROM message_reactions WHERE room_id = ?`, roomId);
      this.sql.exec(`DELETE FROM messages WHERE room_id = ?`, roomId);
      this.sql.exec(`DELETE FROM rooms WHERE room_id = ?`, roomId);

      const nukePayload = {
        type: 'room:nuked',
        roomId,
        triggeredBy,
        timestamp: Date.now(),
      };

      this.broadcastToRoom(roomId, nukePayload);
      const parts = roomId.split('__');
      if (parts.length === 2) {
        this.sendToUser(parts[0], nukePayload);
        this.sendToUser(parts[1], nukePayload);
      }

      return jsonResponse(
        {
          ok: true,
          nukedRoomId: roomId,
          deletedMessages: 1,
          deletedRoom: 1,
          timestamp: Date.now(),
        },
        200,
        request,
        this.env
      );
    }

    return jsonResponse({ ok: false, error: 'Route not found.' }, 404, request, this.env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.WHISPERNET_HUB.idFromName('GLOBAL_WHISPERNET_HUB');
      const stub = env.WHISPERNET_HUB.get(id);
      return stub.fetch(request);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('WhisperNet Worker Active', { status: 200 });
  },
};
