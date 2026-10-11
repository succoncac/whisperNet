// Cloudflare Worker + Durable Object (Pure In-Memory Ephemeral RAM + Hard Wipe Protocol + WebRTC P2P Signaling)
// WhisperNet Zero-Trace Backend:
// 1. In-Memory Ephemeral RAM Storage Only (Map/Set structures in Durable Object memory, zero disk writes)
// 2. Hard Wiping Protocol (`await this.ctx.storage.deleteAll()` / `await this.state.storage.deleteAll()`) on 1h TTL & Nuke
// 3. Hybrid WebRTC P2P Signaling Relay + WebSocket Fallback
// 4. Collision-Safe Identity Engine (4 -> 5 -> 6 chars), Stale Session Severing (Anti-Ghost Chat), Global CORS

const TTL_MS = 60 * 60 * 1000; // 1 Hour Ephemeral TTL in milliseconds
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
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...getCorsHeaders(request, env),
    },
  });
}

export class WhisperNetHub {
  constructor(state, env) {
    this.state = state;
    this.ctx = state;
    this.env = env;

    // Pure In-Memory Ephemeral RAM Storage Only (Zero Persistent Disk Storage)
    this.clients = new Set(); // Set<{ ws, userId, roomId }>
    this.rooms = new Map(); // Map<roomId, { room_id, created_at, updated_at }>
    this.messages = new Map(); // Map<roomId, Array<{ id, room_id, sender_id, content, timestamp }>>
    this.activeUsers = new Map(); // Map<userId, { user_id, last_seen, public_key }>
    this.messageReactions = new Map(); // Map<messageId, { roomId, timestamp, reactions: Map<emoji, Set<userId>> }>
    this.nukedRooms = new Map(); // Map<roomId, number>

    this.ensureGlobalRoomExists();
  }

  ensureGlobalRoomExists() {
    if (!this.rooms.has(GLOBAL_ROOM_ID)) {
      this.rooms.set(GLOBAL_ROOM_ID, {
        room_id: GLOBAL_ROOM_ID,
        created_at: Date.now(),
      });
    }
    if (!this.messages.has(GLOBAL_ROOM_ID)) {
      this.messages.set(GLOBAL_ROOM_ID, []);
    }
  }

  // Hard Wiping Protocol (`await state.storage.deleteAll()`) to destroy all references & storage fragments
  async executeHardStorageWipe() {
    try {
      if (this.state && this.state.storage && typeof this.state.storage.deleteAll === 'function') {
        await this.state.storage.deleteAll();
      } else if (this.ctx && this.ctx.storage && typeof this.ctx.storage.deleteAll === 'function') {
        await this.ctx.storage.deleteAll();
      }
    } catch {
      // Ignore if storage engine is already empty
    }
  }

  async cleanupExpiredData() {
    const now = Date.now();
    const cutoff = now - TTL_MS;
    let expiredDetected = false;
    let deletedMessages = 0;
    let deletedRooms = 0;

    // 1. Purge expired messages from in-memory RAM Map
    for (const [roomId, msgList] of this.messages.entries()) {
      const validMsgs = [];
      for (const msg of msgList) {
        if (msg.timestamp >= cutoff) {
          validMsgs.push(msg);
        } else {
          expiredDetected = true;
          deletedMessages++;
          this.messageReactions.delete(msg.id);
        }
      }
      if (validMsgs.length !== msgList.length) {
        this.messages.set(roomId, validMsgs);
      }
    }

    // 2. Purge expired private rooms from in-memory RAM Map only when inactive for 1h and empty
    for (const [roomId, roomObj] of this.rooms.entries()) {
      const lastActive = roomObj.updated_at || roomObj.created_at;
      const roomMsgs = this.messages.get(roomId) || [];
      if (roomId !== GLOBAL_ROOM_ID && lastActive < cutoff && roomMsgs.length === 0) {
        expiredDetected = true;
        deletedRooms++;
        this.rooms.delete(roomId);
        for (const m of roomMsgs) {
          this.messageReactions.delete(m.id);
        }
        this.messages.delete(roomId);
      }
    }

    for (const [roomId, nukedAt] of this.nukedRooms.entries()) {
      if (nukedAt < cutoff) {
        this.nukedRooms.delete(roomId);
      }
    }

    // 3. Purge expired user identities (releases ID back into pool after 1-hour TTL)
    for (const [userId, userObj] of this.activeUsers.entries()) {
      if (userObj.last_seen < cutoff && !this.isUserCurrentlyOnline(userId)) {
        expiredDetected = true;
        this.activeUsers.delete(userId);
      }
    }

    // 4. Purge expired reaction entries
    for (const [msgId, reactEntry] of this.messageReactions.entries()) {
      if (reactEntry.timestamp < cutoff) {
        expiredDetected = true;
        this.messageReactions.delete(msgId);
      }
    }

    this.ensureGlobalRoomExists();

    // Execute Hard Wiping Protocol if any 1-hour TTL expiration occurred
    if (expiredDetected) {
      await this.executeHardStorageWipe();
    }

    return { deletedMessages, deletedRooms };
  }

  isUserCurrentlyOnline(userId) {
    const clean = normalizeCode(userId);
    if (!clean) return false;
    for (const c of this.clients) {
      if (c.userId === clean) return true;
    }
    return false;
  }

  isUserIdTaken(candidateId) {
    const clean = normalizeCode(candidateId);
    if (!clean) return false;
    if (this.isUserCurrentlyOnline(clean)) return true;
    const cutoff = Date.now() - TTL_MS;
    const record = this.activeUsers.get(clean);
    return Boolean(record && record.last_seen >= cutoff);
  }

  severStaleIdentity(staleUserId) {
    const cleanStale = normalizeCode(staleUserId);
    if (!cleanStale) return;

    // 1. Sever any open WebSockets still attached to the old/deleted identity
    for (const c of Array.from(this.clients)) {
      if (c.userId === cleanStale) {
        try {
          c.ws.close(4001, 'Identity superseded or cleared');
        } catch {
          // ignore
        }
        this.clients.delete(c);
      }
    }

    // 2. Delete old identity from in-memory activeUsers map immediately
    this.activeUsers.delete(cleanStale);

    // 3. Broadcast USER_LEFT / USER_DISCONNECTED to any active 1-on-1 room partners
    const cutoff = Date.now() - TTL_MS;
    for (const [roomId, roomObj] of this.rooms.entries()) {
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
        this.broadcastToRoom(roomId, payload);
        if (peerId) {
          this.sendToUser(peerId, payload);
        }
      }
    }

    this.broadcastGlobalPresence();
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
    const existing = this.activeUsers.get(clean);
    this.activeUsers.set(clean, {
      user_id: clean,
      last_seen: now,
      public_key: publicKey && typeof publicKey === 'string' ? publicKey : existing?.public_key || null,
    });
  }

  getPeerPublicKey(userId) {
    const clean = normalizeCode(userId);
    if (!clean) return null;
    const record = this.activeUsers.get(clean);
    return record?.public_key ? String(record.public_key) : null;
  }

  getReactionsForMessage(messageId) {
    const reactionMap = {};
    const entry = this.messageReactions.get(messageId);
    if (!entry) return reactionMap;
    for (const [emoji, userSet] of entry.reactions.entries()) {
      const arr = Array.from(userSet);
      if (arr.length > 0) {
        reactionMap[emoji] = arr;
      }
    }
    return reactionMap;
  }

  getReactionsForRoom(roomId, cutoff) {
    const mapByMessage = {};
    for (const [msgId, entry] of this.messageReactions.entries()) {
      if (entry.roomId === roomId && entry.timestamp >= cutoff) {
        mapByMessage[msgId] = this.getReactionsForMessage(msgId);
      }
    }
    return mapByMessage;
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

  getActiveOnlineUserIds() {
    const cutoff = Date.now() - TTL_MS;
    const online = new Set();
    for (const c of this.clients) {
      if (c.userId) online.add(c.userId);
    }
    for (const [uid, record] of this.activeUsers.entries()) {
      if (record.last_seen >= cutoff) {
        online.add(uid);
      }
    }
    const globalMsgs = this.messages.get(GLOBAL_ROOM_ID) || [];
    for (const m of globalMsgs) {
      if (m.timestamp >= cutoff && m.sender_id) {
        online.add(normalizeCode(m.sender_id));
      }
    }
    return Array.from(online);
  }

  broadcastGlobalPresence() {
    const users = this.getActiveOnlineUserIds();
    this.broadcastToAll({
      type: 'global:presence',
      users,
      onlineCount: users.length,
    });
  }

  broadcastRoomPresence(roomId) {
    const active = new Set();
    for (const c of this.clients) {
      if (c.roomId === roomId && c.userId) {
        active.add(c.userId);
      }
    }
    const parts = String(roomId).split('__');
    if (parts.length === 2) {
      if (this.doesUserExistOrOnline(parts[0])) active.add(parts[0]);
      if (this.doesUserExistOrOnline(parts[1])) active.add(parts[1]);
    }
    this.broadcastToRoom(roomId, {
      type: 'room:presence',
      roomId,
      participants: Array.from(active),
      onlineCount: active.size,
    });
  }

  doesUserExistOrOnline(targetUserId) {
    const cleanTarget = normalizeCode(targetUserId);
    if (!cleanTarget || cleanTarget.length < 4) return false;
    if (this.isUserCurrentlyOnline(cleanTarget)) return true;
    const cutoff = Date.now() - TTL_MS;
    const record = this.activeUsers.get(cleanTarget);
    if (record && record.last_seen >= cutoff) return true;
    for (const msgList of this.messages.values()) {
      for (const m of msgList) {
        if (m.timestamp >= cutoff && normalizeCode(m.sender_id) === cleanTarget) {
          return true;
        }
      }
    }
    return false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return jsonResponse({ ok: true }, 200, request, this.env);
    }

    // WebSocket Upgrade at /ws (Handles Real-Time Chat + WebRTC P2P Signaling Relay)
    if (pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const session = { ws: server, userId: null, roomId: null };
      this.clients.add(session);

      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.type === 'ping') {
            if (session.userId) {
              this.registerIdentity(session.userId);
            }
            try {
              server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            } catch {
              // ignore
            }
          } else if (data.type === 'user:identify' && data.userId) {
            const nextUserId = normalizeCode(data.userId);
            if (session.userId && session.userId !== nextUserId) {
              this.severStaleIdentity(session.userId);
            }
            session.userId = nextUserId;
            this.registerIdentity(session.userId, data.publicKey);
            this.broadcastGlobalPresence();
          } else if (data.type === 'room:join' && data.roomId && data.userId) {
            const prevRoom = session.roomId;
            const nextUserId = normalizeCode(data.userId);
            if (session.userId && session.userId !== nextUserId) {
              this.severStaleIdentity(session.userId);
            }
            session.userId = nextUserId;
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
          } else if (data.type === 'webrtc:signal' && data.targetUserId && session.userId) {
            // Non-Intrusive Hybrid WebRTC P2P Signaling Relay (SDP Offer/Answer & ICE Candidates)
            const targetPeer = normalizeCode(data.targetUserId);
            this.sendToUser(targetPeer, {
              type: 'webrtc:signal',
              roomId: String(data.roomId || ''),
              fromUserId: session.userId,
              targetUserId: targetPeer,
              signalType: String(data.signalType || ''),
              sdp: data.sdp || null,
              candidate: data.candidate || null,
              timestamp: Date.now(),
            });
          }
        } catch {
          // ignore invalid JSON
        }
      });

      server.addEventListener('close', () => {
        this.clients.delete(session);
        const closedUserId = session.userId;
        const closedRoomId = session.roomId;

        if (closedRoomId) {
          this.broadcastRoomPresence(closedRoomId);
        }

        if (closedUserId && !this.isUserCurrentlyOnline(closedUserId)) {
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
            this.broadcastToRoom(closedRoomId, disconnectPayload);
            if (peerId) {
              this.sendToUser(peerId, disconnectPayload);
            }
          }
        }

        this.broadcastGlobalPresence();
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    await this.cleanupExpiredData();

    // POST /api/users/register (Collision Check + Dynamic 4->5->6 Character Scaling + Stale Identity Severing)
    if (pathname === '/api/users/register' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const requestedId = normalizeCode(body.userId);
      const previousUserId = normalizeCode(body.previousUserId);
      const isExistingSession = Boolean(body.isExistingSession);
      const publicKey = body.publicKey ? String(body.publicKey) : undefined;

      if (previousUserId && previousUserId !== requestedId) {
        this.severStaleIdentity(previousUserId);
      }

      const { userId, collisionResolved } = this.assignCollisionFreeIdentity(
        requestedId,
        isExistingSession
      );

      if (requestedId && userId !== requestedId) {
        this.severStaleIdentity(requestedId);
      }

      this.registerIdentity(userId, publicKey);
      this.broadcastGlobalPresence();
      return jsonResponse(
        {
          ok: true,
          userId,
          collisionResolved,
          onlineUsers: this.getActiveOnlineUserIds(),
          timestamp: Date.now(),
        },
        200,
        request,
        this.env
      );
    }

    // POST /api/users/leave (Sever stale identity immediately)
    if (pathname === '/api/users/leave' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const userId = normalizeCode(body.userId);
      if (userId) {
        this.severStaleIdentity(userId);
      }
      return jsonResponse({ ok: true }, 200, request, this.env);
    }

    // GET /api/global/messages
    if (pathname === '/api/global/messages' && request.method === 'GET') {
      const requesterId = normalizeCode(url.searchParams.get('myId') || '');
      if (requesterId && /^USER-[A-Z0-9]{4,8}$/.test(requesterId)) {
        this.registerIdentity(requesterId);
      }
      const cutoff = Date.now() - TTL_MS;
      const rawMsgs = (this.messages.get(GLOBAL_ROOM_ID) || []).filter(
        (m) => m.timestamp >= cutoff
      );
      const reactionsByMsg = this.getReactionsForRoom(GLOBAL_ROOM_ID, cutoff);
      const messages = rawMsgs.slice(-200).map((r) => ({
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
          roomId: GLOBAL_ROOM_ID,
          messages,
          onlineUsers: this.getActiveOnlineUserIds(),
        },
        200,
        request,
        this.env
      );
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
      this.ensureGlobalRoomExists();
      const roomList = this.messages.get(GLOBAL_ROOM_ID) || [];
      const exists = roomList.some((m) => m.id === messageId);

      const messageRecord = {
        id: messageId,
        room_id: GLOBAL_ROOM_ID,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      if (!exists) {
        roomList.push({
          id: messageId,
          room_id: GLOBAL_ROOM_ID,
          sender_id: senderId,
          content,
          timestamp: now,
        });
        this.messages.set(GLOBAL_ROOM_ID, roomList);
        this.broadcastToAll({
          type: 'global:message:created',
          roomId: GLOBAL_ROOM_ID,
          message: messageRecord,
        });
      }

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

      const roomId = buildRoomId(myId, peerId);
      const now = Date.now();
      const cutoff = now - TTL_MS;

      let roomObj = this.rooms.get(roomId);
      if (roomObj && (roomObj.updated_at || roomObj.created_at) < cutoff) {
        this.rooms.delete(roomId);
        this.messages.delete(roomId);
        roomObj = undefined;
      }

      this.nukedRooms.delete(roomId);
      const peerAlive = this.doesUserExistOrOnline(peerId);
      const isNewRoom = !roomObj;
      if (!roomObj) {
        roomObj = { room_id: roomId, created_at: now, updated_at: now };
        this.rooms.set(roomId, roomObj);
        this.messages.set(roomId, []);
      } else {
        roomObj.updated_at = now;
      }

      const createdAt = Number(roomObj.created_at);
      const rawMsgs = (this.messages.get(roomId) || []).filter((m) => m.timestamp >= cutoff);
      const reactionsByMsg = this.getReactionsForRoom(roomId, cutoff);
      const peerPublicKey = this.getPeerPublicKey(peerId);
      const senderPublicKey = this.getPeerPublicKey(myId);

      const messages = rawMsgs.map((r) => ({
        id: String(r.id),
        room_id: String(r.room_id),
        sender_id: String(r.sender_id),
        content: String(r.content),
        timestamp: Number(r.timestamp),
        reactions: reactionsByMsg[String(r.id)] || {},
      }));

      if (notifyPeer && peerAlive) {
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
            peer_alive: peerAlive,
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

      const conversations = [];
      for (const [roomId, roomObj] of this.rooms.entries()) {
        const lastActive = roomObj.updated_at || roomObj.created_at;
        if (roomId === GLOBAL_ROOM_ID || lastActive < cutoff) continue;
        if (!roomId.startsWith(`${myId}__`) && !roomId.endsWith(`__${myId}`)) continue;

        const createdAt = Number(roomObj.created_at);
        const peerId = extractPeerFromRoomId(roomId, myId);
        if (!peerId) continue;

        const validMsgs = (this.messages.get(roomId) || []).filter((m) => m.timestamp >= cutoff);
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
          peer_public_key: this.getPeerPublicKey(peerId),
          peer_alive: this.doesUserExistOrOnline(peerId),
          created_at: createdAt,
          expires_at: createdAt + TTL_MS,
          message_count: validMsgs.length,
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
      const now = Date.now();
      const cutoff = now - TTL_MS;
      const requesterId = normalizeCode(url.searchParams.get('myId') || '');
      if (requesterId && /^USER-[A-Z0-9]{4,8}$/.test(requesterId)) {
        this.registerIdentity(requesterId);
      }

      let roomObj = this.rooms.get(roomId);
      if (!roomObj || (roomId !== GLOBAL_ROOM_ID && (roomObj.updated_at || roomObj.created_at) < cutoff)) {
        if (this.nukedRooms.has(roomId)) {
          return jsonResponse(
            { ok: true, roomExists: false, nuked: true, messages: [] },
            200,
            request,
            this.env
          );
        }
        roomObj = { room_id: roomId, created_at: now, updated_at: now };
        this.rooms.set(roomId, roomObj);
        if (!this.messages.has(roomId)) {
          this.messages.set(roomId, []);
        }
      }

      const peerId = requesterId ? extractPeerFromRoomId(roomId, requesterId) : null;
      const peerAlive = peerId ? this.doesUserExistOrOnline(peerId) : true;

      const rawMsgs = (this.messages.get(roomId) || []).filter((m) => m.timestamp >= cutoff);
      const reactionsByMsg = this.getReactionsForRoom(roomId, cutoff);
      const messages = rawMsgs.map((r) => ({
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
          peerAlive,
          createdAt: Number(roomObj.created_at),
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

      const recipientId = extractPeerFromRoomId(roomId, senderId);

      this.registerIdentity(senderId);
      this.nukedRooms.delete(roomId);
      const existingRoom = this.rooms.get(roomId);
      if (!existingRoom) {
        this.rooms.set(roomId, { room_id: roomId, created_at: now, updated_at: now });
      } else {
        existingRoom.updated_at = now;
      }
      const roomList = this.messages.get(roomId) || [];
      const exists = roomList.some((m) => m.id === messageId);

      const messageRecord = {
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        content,
        timestamp: now,
        reactions: {},
      };

      if (!exists) {
        roomList.push({
          id: messageId,
          room_id: roomId,
          sender_id: senderId,
          content,
          timestamp: now,
        });
        this.messages.set(roomId, roomList);

        this.broadcastToRoom(roomId, {
          type: 'message:created',
          roomId,
          message: messageRecord,
        });

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

      const now = Date.now();
      let entry = this.messageReactions.get(messageId);
      if (!entry) {
        entry = { roomId, timestamp: now, reactions: new Map() };
        this.messageReactions.set(messageId, entry);
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

    // DELETE /api/rooms/:roomId/nuke (Hard Wiping Protocol + Immediate RAM Purge)
    const nukeMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/nuke$/);
    if (nukeMatch && request.method === 'DELETE') {
      const roomId = decodeURIComponent(nukeMatch[1]);
      const body = await request.json().catch(() => ({}));
      const triggeredBy = normalizeCode(body.triggeredBy || 'PEER');

      if (!roomId || roomId === GLOBAL_ROOM_ID) {
        return jsonResponse({ ok: false, error: 'Invalid room ID.' }, 400, request, this.env);
      }

      const roomMsgs = this.messages.get(roomId) || [];
      const deletedCount = roomMsgs.length;
      for (const m of roomMsgs) {
        this.messageReactions.delete(m.id);
      }
      for (const [msgId, entry] of this.messageReactions.entries()) {
        if (entry.roomId === roomId) {
          this.messageReactions.delete(msgId);
        }
      }
      this.messages.delete(roomId);
      this.rooms.delete(roomId);
      this.nukedRooms.set(roomId, Date.now());

      // Execute Hard Wiping Protocol (`await state.storage.deleteAll()`) to purge all storage fragments
      await this.executeHardStorageWipe();

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
          deletedMessages: deletedCount,
          deletedRoom: 1,
          hardWiped: true,
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
