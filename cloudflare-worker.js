// Cloudflare Worker + Durable Object (Blind Zero-Knowledge E2EE Ciphertext Relay + Real-time WebSockets)
// WhisperNet Zero-Trace Backend: Stores and forwards opaque AES-256-GCM ciphertext and ECDH public keys without access to private keys or plaintext.

const TTL_MS = 24 * 60 * 60 * 1000;
const GLOBAL_ROOM_ID = 'GLOBAL';

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    const participants = new Set();
    for (const c of this.clients) {
      if (c.roomId === roomId && c.userId) {
        participants.add(c.userId);
      }
    }
    this.broadcastToRoom(roomId, {
      type: 'room:presence',
      roomId,
      participants: Array.from(participants),
      onlineCount: participants.size,
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

    const candidateRoom = buildRoomId(cleanRequester, cleanTarget);
    const roomRows = this.sql
      .exec(
        `SELECT room_id FROM rooms WHERE room_id = ? AND created_at >= ? LIMIT 1`,
        candidateRoom,
        cutoff
      )
      .toArray();
    return roomRows.length > 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return jsonResponse({ ok: true });
    }

    // WebSocket Upgrade (/ws)
    if (pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
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

    // POST /api/users/register
    if (pathname === '/api/users/register' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const userId = normalizeCode(body.userId);
      const publicKey = body.publicKey ? String(body.publicKey) : undefined;
      if (!userId || userId.length < 4) {
        return jsonResponse({ ok: false, error: 'Invalid User ID.' }, 400);
      }
      this.registerIdentity(userId, publicKey);
      return jsonResponse({ ok: true, userId, timestamp: Date.now() });
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
      return jsonResponse({ ok: true, roomId: GLOBAL_ROOM_ID, messages });
    }

    // POST /api/global/messages (Receives and stores client-encrypted ciphertext)
    if (pathname === '/api/global/messages' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const senderId = normalizeCode(body.senderId);
      const content = String(body.content || '').trim();
      const now = Date.now();
      const messageId =
        String(body.id || '').trim() ||
        `GLB-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      if (!senderId || !content) {
        return jsonResponse({ ok: false, error: 'Missing senderId or content.' }, 400);
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
      return jsonResponse({ ok: true, message: messageRecord });
    }

    // POST /api/rooms/connect (Relays peer ECDH public key for client-side E2EE key derivation)
    if (pathname === '/api/rooms/connect' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const myId = normalizeCode(body.myId);
      const peerId = normalizeCode(body.peerId);
      const myPublicKey = body.publicKey ? String(body.publicKey) : undefined;
      const notifyPeer = body.notifyPeer !== false;

      if (!myId || myId.length < 4) {
        return jsonResponse({ ok: false, error: 'Invalid session identity code.' }, 400);
      }
      if (!peerId || !/^USER-[A-Z0-9]{4,8}$/.test(peerId) || myId === peerId) {
        return jsonResponse(
          { ok: false, error: 'User not found. Please check the ID and try again.' },
          404
        );
      }
      this.registerIdentity(myId, myPublicKey);

      if (!this.doesUserExistOrOnline(peerId, myId)) {
        return jsonResponse(
          { ok: false, error: 'User not found. Please check the ID and try again.' },
          404
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

      return jsonResponse({
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

        const lastRows = this.sql
          .exec(
            `SELECT id, sender_id, content, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1`,
            roomId,
            cutoff
          )
          .toArray();
        const countRows = this.sql
          .exec(
            `SELECT COUNT(*) as count FROM messages WHERE room_id = ? AND timestamp >= ?`,
            roomId,
            cutoff
          )
          .toArray();

        const lastMessage = lastRows[0]
          ? {
              id: String(lastRows[0].id),
              sender_id: String(lastRows[0].sender_id),
              content: String(lastRows[0].content),
              timestamp: Number(lastRows[0].timestamp),
            }
          : null;

        conversations.push({
          room_id: roomId,
          peer_id: peerId,
          peer_public_key: this.getPeerPublicKey(peerId),
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
          message_count: Number(countRows[0]?.count ?? 0),
          last_message: lastMessage,
          updated_at: lastMessage ? lastMessage.timestamp : createdAt,
        });
      }
      conversations.sort((a, b) => b.updated_at - a.updated_at);
      return jsonResponse({ ok: true, conversations });
    }

    // GET or POST /api/rooms/:roomId/messages (Blindly stores and forwards E2EE ciphertext)
    const roomMsgMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
    if (roomMsgMatch) {
      const roomId = decodeURIComponent(roomMsgMatch[1]);
      if (request.method === 'GET') {
        const roomRows = this.sql
          .exec(`SELECT room_id, created_at FROM rooms WHERE room_id = ?`, roomId)
          .toArray();
        if (roomRows.length === 0) {
          return jsonResponse({ ok: true, roomExists: false, room: null, messages: [] });
        }
        const createdAt = Number(roomRows[0].created_at);
        const cutoff = Date.now() - TTL_MS;
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
        return jsonResponse({
          ok: true,
          roomExists: true,
          room: { room_id: roomId, created_at: createdAt, expires_at: createdAt + TTL_MS },
          messages,
        });
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const senderId = normalizeCode(body.senderId);
        const content = String(body.content || '').trim();
        const now = Date.now();
        const messageId =
          String(body.id || '').trim() ||
          `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

        if (!roomId || !senderId || !content) {
          return jsonResponse({ ok: false, error: 'Missing required fields.' }, 400);
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
        if (recipientId) {
          this.sendToUser(recipientId, {
            type: 'private:message_notification',
            roomId,
            fromUserId: senderId,
            fromPublicKey: this.getPeerPublicKey(senderId),
            toUserId: recipientId,
            message: messageRecord,
            timestamp: now,
          });
        }
        return jsonResponse({ ok: true, message: messageRecord });
      }
    }

    // POST /api/messages/:messageId/reactions
    const reactMatch = pathname.match(/^\/api\/messages\/([^/]+)\/reactions$/);
    if (reactMatch && request.method === 'POST') {
      const messageId = decodeURIComponent(reactMatch[1]);
      const body = await request.json().catch(() => ({}));
      const roomId = String(body.roomId || '').trim();
      const userId = normalizeCode(body.userId);
      const emoji = String(body.emoji || '').trim();
      const mode = String(body.mode || 'toggle');

      if (!messageId || !roomId || !userId || !emoji) {
        return jsonResponse({ ok: false, error: 'Missing reaction parameters.' }, 400);
      }

      const existing = this.sql
        .exec(
          `SELECT message_id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
          messageId,
          userId,
          emoji
        )
        .toArray();

      if (existing.length > 0) {
        if (mode === 'toggle') {
          this.sql.exec(
            `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
            messageId,
            userId,
            emoji
          );
        }
      } else {
        this.sql.exec(
          `INSERT INTO message_reactions (message_id, room_id, user_id, emoji, timestamp) VALUES (?, ?, ?, ?, ?)`,
          messageId,
          roomId,
          userId,
          emoji,
          Date.now()
        );
      }

      const updatedReactions = this.getReactionsForMessage(messageId);
      const payload = {
        type: 'message:reaction_updated',
        roomId,
        messageId,
        reactions: updatedReactions,
      };
      this.broadcastToRoom(roomId, payload);
      if (roomId !== GLOBAL_ROOM_ID) {
        const peerId = extractPeerFromRoomId(roomId, userId);
        if (peerId) this.sendToUser(peerId, payload);
        this.sendToUser(userId, payload);
      }
      return jsonResponse({ ok: true, messageId, roomId, reactions: updatedReactions });
    }

    // DELETE /api/rooms/:roomId/nuke
    const nukeMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/nuke$/);
    if (nukeMatch && request.method === 'DELETE') {
      const roomId = decodeURIComponent(nukeMatch[1]);
      const body = await request.json().catch(() => ({}));
      const triggeredBy = normalizeCode(body.triggeredBy || 'UNKNOWN');

      if (!roomId || roomId === GLOBAL_ROOM_ID) {
        return jsonResponse({ ok: false, error: 'Valid private Room ID is required.' }, 400);
      }

      const peerId = extractPeerFromRoomId(roomId, triggeredBy);
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
      if (peerId) this.sendToUser(peerId, nukePayload);
      this.sendToUser(triggeredBy, nukePayload);

      return jsonResponse({
        ok: true,
        nukedRoomId: roomId,
        deletedMessages: 1,
        timestamp: Date.now(),
      });
    }

    return jsonResponse({ ok: false, error: 'API endpoint not found.' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      const id = env.WHISPERNET_HUB.idFromName('GLOBAL_ZERO_TRACE_HUB');
      const stub = env.WHISPERNET_HUB.get(id);
      return stub.fetch(request);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('WhisperNet Worker Active', { status: 200 });
  },
};
