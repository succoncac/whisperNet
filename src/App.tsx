import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield,
  Copy,
  Check,
  Send,
  Flame,
  Clock,
  Lock,
  ArrowRight,
  Trash2,
  AlertTriangle,
  X,
  MessageSquareOff,
  Globe,
  Search,
  Users,
  Bell,
  MessageSquareLock,
  SlidersHorizontal,
  Smile,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  getOrCreateMyEcdhIdentity,
  resetMyEcdhIdentity,
  registerPeerPublicKey,
  encryptMessageContent,
  decryptMessageContent,
} from './crypto';

export type ReactionMap = Record<string, string[]>;

interface ChatMessage {
  id: string;
  room_id: string;
  sender_id: string;
  content: string;
  timestamp: number;
  reactions?: ReactionMap;
}

interface RoomMetadata {
  room_id: string;
  created_at: number;
  expires_at: number;
  peer_id: string;
  peer_public_key?: string | null;
}

interface PrivateConversationSummary {
  room_id: string;
  peer_id: string;
  peer_public_key?: string | null;
  created_at: number;
  expires_at: number;
  message_count: number;
  last_message: {
    id: string;
    sender_id: string;
    content: string;
    timestamp: number;
  } | null;
  updated_at: number;
}

interface IncomingNotificationToast {
  id: string;
  fromUserId: string;
  roomId: string;
  headline: string;
  preview: string;
  timestamp: number;
}

interface EmojiCategory {
  id: string;
  name: string;
  icon: string;
  emojis: string[];
}

const TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_IDENTITY_KEY = 'whispernet_immutable_session_id_v1';
const SESSION_IDENTITY_META_KEY = 'whispernet_identity_meta_v1';
const SOUND_ENABLED_KEY = 'whispernet_sound_enabled_v1';

interface StoredSessionIdentity {
  id: string;
  createdAt: number;
  expiresAt: number;
}

// Comprehensive Categorized Emoji Library (Emoji-Only)
const EMOJI_LIBRARY_CATEGORIES: EmojiCategory[] = [
  {
    id: 'faces',
    name: 'Faces & Expressions',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
      '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
      '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸',
      '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️',
      '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡',
      '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓',
      '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄',
      '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵',
      '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠',
    ],
  },
  {
    id: 'hands',
    name: 'Hands & Gestures',
    icon: '🤟',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
      '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
      '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
      '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦵', '🦿', '🦶', '👀',
    ],
  },
  {
    id: 'creatures',
    name: 'Creatures & Stealth',
    icon: '👻',
    emojis: [
      '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽',
      '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀',
      '😿', '😾', '🙈', '🙉', '🙊', '🦊', '🐺', '🦁', '🐯', '🐍',
      '🦂', '🕷️', '🦇', '🦉', '🦅', '🦈', '🐙', '🐉', '🦖', '🦄',
    ],
  },
  {
    id: 'symbols',
    name: 'Cyber & Symbols',
    icon: '⚡',
    emojis: [
      '🔥', '⚡', '💥', '✨', '💫', '💦', '💨', '🕳️', '💣', '💬',
      '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤', '🔒', '🔓', '🔏', '🔐', '🔑',
      '🗝️', '🛡️', '⚔️', '🗡️', '🔫', '🧨', '🔮', '🧿', '🪬', '☢️',
      '☣️', '⚠️', '🚫', '✅', '❌', '❓', '❗', '💯', '🚀', '🛸',
    ],
  },
  {
    id: 'hearts',
    name: 'Hearts & Feelings',
    icon: '❤️',
    emojis: [
      '❤️', '🤍', '💖', '💝', '💓', '💞', '💙', '💛', '💜', '🤎',
    ],
  },
];

// Rich Reaction Bar Emojis for Long-Press / Right-Click Context Menu
const REACTION_BAR_EMOJIS = [
  '❤️', '💖', '😂', '🤣', '🥵', '🥰', '😭',
  '😱', '🤯', '🤬', '🤡', '💩', '👻', '⚡',
  '💥', '🤟', '🤌', '✌️', '🤝', '👌', '☠️',
];

function generateFreshClientSideIdentity(): StoredSessionIdentity {
  const now = Date.now();
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let randomPart = '';
  const array = new Uint32Array(4);
  window.crypto.getRandomValues(array);
  for (let i = 0; i < 4; i++) {
    randomPart += chars[array[i] % chars.length];
  }
  const newId = `USER-${randomPart}`;
  const record: StoredSessionIdentity = {
    id: newId,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  try {
    const serialized = JSON.stringify(record);
    localStorage.setItem(SESSION_IDENTITY_META_KEY, serialized);
    sessionStorage.setItem(SESSION_IDENTITY_META_KEY, serialized);
    localStorage.setItem(SESSION_IDENTITY_KEY, newId);
    sessionStorage.setItem(SESSION_IDENTITY_KEY, newId);
  } catch {
    // ignore storage errors
  }
  return record;
}

function getInitialSessionIdentity(): {
  id: string;
  createdAt: number;
  expiresAt: number;
  isExisting: boolean;
} {
  const now = Date.now();
  try {
    const rawMeta =
      localStorage.getItem(SESSION_IDENTITY_META_KEY) ||
      sessionStorage.getItem(SESSION_IDENTITY_META_KEY);
    if (rawMeta) {
      const parsed = JSON.parse(rawMeta) as StoredSessionIdentity;
      if (
        parsed &&
        typeof parsed.id === 'string' &&
        /^USER-[A-Z0-9]{4,6}$/.test(parsed.id) &&
        typeof parsed.expiresAt === 'number' &&
        parsed.expiresAt > now
      ) {
        return {
          id: parsed.id,
          createdAt: parsed.createdAt || parsed.expiresAt - TTL_MS,
          expiresAt: parsed.expiresAt,
          isExisting: true,
        };
      }
    }

    const fresh = generateFreshClientSideIdentity();
    return { ...fresh, isExisting: false };
  } catch {
    const fallback = `USER-${Math.floor(1000 + Math.random() * 9000)}`;
    return {
      id: fallback,
      createdAt: now,
      expiresAt: now + TTL_MS,
      isExisting: false,
    };
  }
}

function normalizeUserCode(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!cleaned) return '';
  if (/^[0-9A-Z]{4,6}$/.test(cleaned)) {
    return `USER-${cleaned}`;
  }
  return cleaned;
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00:00';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((val) => String(val).padStart(2, '0'))
    .join(':');
}

async function decryptMessageBatch(
  messages: ChatMessage[],
  roomId: string,
  peerId?: string
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (m) => ({
      ...m,
      content: await decryptMessageContent(m.content, roomId, peerId),
    }))
  );
}

export default function App() {
  const [initialIdentity] = useState(() => getInitialSessionIdentity());
  const [myId, setMyId] = useState<string>(initialIdentity.id);
  const [myIdExpiresAt, setMyIdExpiresAt] = useState<number>(initialIdentity.expiresAt);
  const isExistingSessionRef = useRef<boolean>(initialIdentity.isExisting);

  // Navigation Tabs: 'global' (Global Chat) | 'private' (Private Chats)
  const [activeTab, setActiveTab] = useState<'global' | 'private'>('global');
  const [showMobileDrawer, setShowMobileDrawer] = useState<boolean>(false);

  // Global Public Room State
  const [globalMessages, setGlobalMessages] = useState<ChatMessage[]>([]);
  const [globalDraft, setGlobalDraft] = useState<string>('');
  const [isSendingGlobal, setIsSendingGlobal] = useState<boolean>(false);
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);

  // Private 1-on-1 Room & Active Conversations State
  const [peerInput, setPeerInput] = useState<string>('');
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<RoomMetadata | null>(null);
  const [privateMessages, setPrivateMessages] = useState<ChatMessage[]>([]);
  const [privateDraft, setPrivateDraft] = useState<string>('');
  const [conversations, setConversations] = useState<PrivateConversationSummary[]>([]);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [toastQueue, setToastQueue] = useState<IncomingNotificationToast[]>([]);

  // Web Audio API Sound Notification State
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SOUND_ENABLED_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  // Extensive Emoji Picker State (Emoji-Only)
  const [pickerOpenFor, setPickerOpenFor] = useState<'global' | 'private' | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('faces');

  // Reaction Context Bar State (Long-Press / Right-Click) & Double-Tap Heart Animation
  const [reactionMenuMsg, setReactionMenuMsg] = useState<{
    messageId: string;
    roomId: string;
  } | null>(null);
  const [heartBurstMsgId, setHeartBurstMsgId] = useState<string | null>(null);
  const [showFirstTimeReactionTip, setShowFirstTimeReactionTip] = useState<boolean>(false);
  const hasShownReactionTipRef = useRef<boolean>(false);

  // UI & Action States
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isSendingPrivate, setIsSendingPrivate] = useState<boolean>(false);
  const [isNuking, setIsNuking] = useState<boolean>(false);
  const [showNukeModal, setShowNukeModal] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [nukeAlert, setNukeAlert] = useState<string | null>(null);

  // Real-time States
  const [peerOnline, setPeerOnline] = useState<boolean>(false);
  const [peerTyping, setPeerTyping] = useState<boolean>(false);
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const soundEnabledRef = useRef<boolean>(soundEnabled);
  const initialConvsSyncedRef = useRef<boolean>(false);
  const globalEndRef = useRef<HTMLDivElement | null>(null);
  const privateEndRef = useRef<HTMLDivElement | null>(null);
  const globalInputRef = useRef<HTMLInputElement | null>(null);
  const privateInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ msgId: string; time: number }>({ msgId: '', time: 0 });
  const activeRoomIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<'global' | 'private'>('global');
  const activePeerIdRef = useRef<string | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  activeRoomIdRef.current = activeRoom?.room_id || null;
  activeTabRef.current = activeTab;
  activePeerIdRef.current = activePeerId;
  soundEnabledRef.current = soundEnabled;

  // Lightweight Web Audio API Synthesizer for Subtle Notification Ping
  const playNotificationPing = useCallback((variant: 'message' | 'request' = 'message') => {
    if (!soundEnabledRef.current) return;
    try {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtxClass();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      if (variant === 'request') {
        osc.frequency.setValueAtTime(784, now);
        osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.11);
      } else {
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1318.51, now + 0.08);
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.085, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.25);
    } catch {
      // Ignore Web Audio autoplay restriction prior to first user interaction
    }
  }, []);

  // Unlock Web Audio Context on first user pointer interaction
  useEffect(() => {
    const unlockAudio = () => {
      try {
        const AudioCtxClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtxClass) return;
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioCtxClass();
        }
        if (audioCtxRef.current.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, []);

  const toggleSoundEnabled = () => {
    setSoundEnabled((prev) => {
      const next = !prev;
      soundEnabledRef.current = next;
      try {
        sessionStorage.setItem(SOUND_ENABLED_KEY, String(next));
      } catch {
        // ignore
      }
      if (next) {
        playNotificationPing('message');
      }
      return next;
    });
  };

  const pushNotificationToast = useCallback(
    (fromUserId: string, roomId: string, headline: string, preview: string) => {
      const toastId = `TOAST-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      const newToast: IncomingNotificationToast = {
        id: toastId,
        fromUserId,
        roomId,
        headline,
        preview,
        timestamp: Date.now(),
      };
      setToastQueue((prev) =>
        [newToast, ...prev.filter((t) => t.fromUserId !== fromUserId)].slice(0, 2)
      );

      window.setTimeout(() => {
        setToastQueue((prev) => prev.filter((t) => t.id !== toastId));
      }, 9000);
    },
    []
  );

  // Initialize Client-Side KeyPair & Register Identity with Backend Collision Check (4 -> 5 -> 6 chars)
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { publicKeyJwkString } = await getOrCreateMyEcdhIdentity();
        if (!active) return;
        const res = await fetch('/api/users/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: myId,
            isExistingSession: isExistingSessionRef.current,
            publicKey: publicKeyJwkString,
          }),
        });
        const data = await res.json();
        if (active && data?.ok && data.userId && data.userId !== myId) {
          const now = Date.now();
          const newExpiresAt = now + TTL_MS;
          setMyId(data.userId);
          setMyIdExpiresAt(newExpiresAt);
          isExistingSessionRef.current = true;
          try {
            const record: StoredSessionIdentity = {
              id: data.userId,
              createdAt: now,
              expiresAt: newExpiresAt,
            };
            const serialized = JSON.stringify(record);
            localStorage.setItem(SESSION_IDENTITY_META_KEY, serialized);
            sessionStorage.setItem(SESSION_IDENTITY_META_KEY, serialized);
            localStorage.setItem(SESSION_IDENTITY_KEY, data.userId);
            sessionStorage.setItem(SESSION_IDENTITY_KEY, data.userId);
          } catch {
            // ignore storage errors
          }
        } else if (active && data?.ok) {
          isExistingSessionRef.current = true;
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, [myId]);

  // Fetch & Decrypt Global Public Chat Messages
  const fetchGlobalMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/global/messages');
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.messages)) {
        const decrypted = await decryptMessageBatch(data.messages, 'GLOBAL');
        setGlobalMessages(decrypted);
      }
    } catch {
      // Ignore transient error
    }
  }, []);

  // Fetch & Decrypt All Active 1-on-1 Private Conversations
  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(myId)}/conversations`);
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.conversations)) {
        const rawList: PrivateConversationSummary[] = data.conversations;
        let hasNewIncomingMessage = false;

        const decryptedList: PrivateConversationSummary[] = await Promise.all(
          rawList.map(async (conv) => {
            if (conv.peer_public_key) {
              registerPeerPublicKey(conv.peer_id, conv.peer_public_key);
            }
            if (!conv.last_message) return conv;

            const plainPreview = await decryptMessageContent(
              conv.last_message.content,
              conv.room_id,
              conv.peer_id
            );

            if (
              conv.last_message.sender_id !== myId &&
              !seenMessageIdsRef.current.has(conv.last_message.id)
            ) {
              seenMessageIdsRef.current.add(conv.last_message.id);
              const isCurrentlyViewingThisRoom =
                activeTabRef.current === 'private' && activePeerIdRef.current === conv.peer_id;
              if (!isCurrentlyViewingThisRoom) {
                setUnreadByPeer((prev) => ({
                  ...prev,
                  [conv.peer_id]: (prev[conv.peer_id] || 0) + 1,
                }));
                if (initialConvsSyncedRef.current) {
                  hasNewIncomingMessage = true;
                }
              }
            } else {
              seenMessageIdsRef.current.add(conv.last_message.id);
            }

            return {
              ...conv,
              last_message: {
                ...conv.last_message,
                content: plainPreview,
              },
            };
          })
        );

        if (hasNewIncomingMessage) {
          playNotificationPing('message');
        }
        initialConvsSyncedRef.current = true;
        setConversations(decryptedList);
      }
    } catch {
      // Ignore transient error
    }
  }, [myId, playNotificationPing]);

  useEffect(() => {
    fetchGlobalMessages();
    fetchConversations();
  }, [fetchGlobalMessages, fetchConversations]);

  // 1-second ticker for TTL Countdown & 24-Hour User Identity Expiration
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowTick(now);
      if (now >= myIdExpiresAt) {
        resetMyEcdhIdentity();
        const rotated = generateFreshClientSideIdentity();
        isExistingSessionRef.current = false;
        setMyId(rotated.id);
        setMyIdExpiresAt(rotated.expiresAt);
        setActiveRoom(null);
        setActivePeerId(null);
        setPrivateMessages([]);
        setConversations([]);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [myIdExpiresAt]);

  // Auto-scroll Global Chat
  useEffect(() => {
    if (activeTab === 'global') {
      globalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [globalMessages, activeTab]);

  // Auto-scroll Private Chat
  useEffect(() => {
    if (activeTab === 'private') {
      privateEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [privateMessages, peerTyping, activeTab]);

  // Emoji Insertion Helper for Both Global and Private Chat
  const handleInsertEmoji = (emoji: string) => {
    if (pickerOpenFor === 'global') {
      setGlobalDraft((prev) => `${prev}${emoji}`);
      globalInputRef.current?.focus();
    } else if (pickerOpenFor === 'private') {
      setPrivateDraft((prev) => `${prev}${emoji}`);
      privateInputRef.current?.focus();
    }
  };

  // Connect to 1-on-1 Private Chat with Strict User Existence Validation & Public Key Exchange
  const connectToPeerChannel = useCallback(
    async (targetPeerRaw: string, notifyPeer = true) => {
      const targetPeer = normalizeUserCode(targetPeerRaw);
      if (!targetPeer || !/^USER-[A-Z0-9]{4,8}$/.test(targetPeer)) {
        setErrorBanner('User not found. Please check the ID and try again.');
        return;
      }
      if (targetPeer === myId) {
        setErrorBanner('User not found. Please check the ID and try again.');
        return;
      }

      setErrorBanner(null);
      setNukeAlert(null);
      setIsConnecting(true);

      try {
        const { publicKeyJwkString } = await getOrCreateMyEcdhIdentity();
        const res = await fetch('/api/rooms/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            myId,
            peerId: targetPeer,
            publicKey: publicKeyJwkString,
            notifyPeer,
          }),
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          setErrorBanner(data.error || 'User not found. Please check the ID and try again.');
          setIsConnecting(false);
          return;
        }

        if (data.room?.peer_public_key) {
          registerPeerPublicKey(targetPeer, data.room.peer_public_key);
        }

        const rawMessages: ChatMessage[] = Array.isArray(data.messages) ? data.messages : [];
        rawMessages.forEach((m) => seenMessageIdsRef.current.add(m.id));

        const decryptedMessages = await decryptMessageBatch(
          rawMessages,
          data.room.room_id,
          targetPeer
        );

        setActivePeerId(targetPeer);
        setActiveRoom(data.room);
        setPrivateMessages(decryptedMessages);
        setActiveTab('private');
        setPeerInput(targetPeer);
        setShowMobileDrawer(false);
        setPickerOpenFor(null);

        setUnreadByPeer((prev) => {
          if (!prev[targetPeer]) return prev;
          const next = { ...prev };
          delete next[targetPeer];
          return next;
        });

        setToastQueue((prev) => prev.filter((t) => t.fromUserId !== targetPeer));

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'room:join',
              roomId: data.room.room_id,
              userId: myId,
              publicKey: publicKeyJwkString,
            })
          );
        }

        fetchConversations();
      } catch {
        setErrorBanner('User not found. Please check the ID and try again.');
      } finally {
        setIsConnecting(false);
      }
    },
    [myId, fetchConversations]
  );

  // Persistent WebSocket Connection for Real-Time Chat, Reactions & Notifications
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: number | null = null;

    function connectWebSocket() {
      if (!isMounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        if (!isMounted) return;
        const { publicKeyJwkString } = await getOrCreateMyEcdhIdentity();
        ws.send(
          JSON.stringify({
            type: 'user:identify',
            userId: myId,
            publicKey: publicKeyJwkString,
          })
        );
        if (activeRoomIdRef.current) {
          ws.send(
            JSON.stringify({
              type: 'room:join',
              roomId: activeRoomIdRef.current,
              userId: myId,
              publicKey: publicKeyJwkString,
            })
          );
        }
      };

      ws.onmessage = async (event) => {
        if (!isMounted) return;
        try {
          const payload = JSON.parse(event.data);

          // 1. Global Presence Update
          if (payload.type === 'global:presence' && Array.isArray(payload.users)) {
            setOnlineUsers(payload.users);
          }

          // 2. Global Public Message Created
          else if (payload.type === 'global:message:created' && payload.message) {
            const incomingRaw: ChatMessage = payload.message;
            const plainText = await decryptMessageContent(incomingRaw.content, 'GLOBAL');
            const incoming: ChatMessage = { ...incomingRaw, content: plainText };

            setGlobalMessages((prev) => {
              if (prev.some((m) => m.id === incoming.id)) return prev;
              return [...prev, incoming];
            });
          }

          // 3. Emoji Reaction Updated in Real-Time
          else if (
            payload.type === 'message:reaction_updated' &&
            payload.messageId &&
            payload.reactions
          ) {
            const updatedMsgId = String(payload.messageId);
            const updatedRoomId = String(payload.roomId);
            const updatedReactions: ReactionMap = payload.reactions;

            if (updatedRoomId === 'GLOBAL') {
              setGlobalMessages((prev) =>
                prev.map((m) =>
                  m.id === updatedMsgId ? { ...m, reactions: updatedReactions } : m
                )
              );
            } else {
              setPrivateMessages((prev) =>
                prev.map((m) =>
                  m.id === updatedMsgId ? { ...m, reactions: updatedReactions } : m
                )
              );
            }
          }

          // 4. Incoming Private Chat Request Notification
          else if (payload.type === 'private:chat_request' && payload.fromUserId) {
            const senderId = String(payload.fromUserId);
            if (payload.fromPublicKey) {
              registerPeerPublicKey(senderId, String(payload.fromPublicKey));
            }
            const roomId = String(payload.roomId);
            fetchConversations();

            const isAlreadyViewingThisPeer =
              activeTabRef.current === 'private' && activePeerIdRef.current === senderId;

            if (!isAlreadyViewingThisPeer) {
              setUnreadByPeer((prev) => ({
                ...prev,
                [senderId]: (prev[senderId] || 0) + 1,
              }));
              playNotificationPing('request');
              pushNotificationToast(
                senderId,
                roomId,
                `${senderId} opened a 1-on-1 chat with you`,
                'Click "Open Chat" to enter the private tunnel.'
              );
            }
          }

          // 5. Incoming Direct Private Message Notification
          else if (
            payload.type === 'private:message_notification' &&
            payload.message &&
            payload.fromUserId
          ) {
            const senderId = String(payload.fromUserId);
            if (payload.fromPublicKey) {
              registerPeerPublicKey(senderId, String(payload.fromPublicKey));
            }
            const roomId = String(payload.roomId);
            const incomingMsgRaw: ChatMessage = payload.message;
            seenMessageIdsRef.current.add(incomingMsgRaw.id);

            const decryptedText = await decryptMessageContent(
              incomingMsgRaw.content,
              roomId,
              senderId
            );
            const incomingMsg: ChatMessage = {
              ...incomingMsgRaw,
              content: decryptedText,
            };

            fetchConversations();

            if (activeRoomIdRef.current === roomId) {
              setPrivateMessages((prev) => {
                if (prev.some((m) => m.id === incomingMsg.id)) return prev;
                return [...prev, incomingMsg];
              });
            }

            const isCurrentlyViewingThisRoom =
              activeTabRef.current === 'private' && activeRoomIdRef.current === roomId;

            if (!isCurrentlyViewingThisRoom) {
              setUnreadByPeer((prev) => ({
                ...prev,
                [senderId]: (prev[senderId] || 0) + 1,
              }));
              playNotificationPing('message');
              pushNotificationToast(
                senderId,
                roomId,
                `New private message from ${senderId}`,
                decryptedText
              );
            } else {
              playNotificationPing('message');
            }
          }

          // 6. Active Private Room Presence
          else if (
            payload.type === 'room:presence' &&
            payload.roomId === activeRoomIdRef.current
          ) {
            const participants: string[] = payload.participants || [];
            const otherOnline = participants.some((u) => u !== myId);
            setPeerOnline(otherOnline);
          }

          // 7. Active Private Room Message Broadcast
          else if (
            payload.type === 'message:created' &&
            payload.roomId === activeRoomIdRef.current &&
            payload.message
          ) {
            const incomingRaw: ChatMessage = payload.message;
            seenMessageIdsRef.current.add(incomingRaw.id);

            const plainText = await decryptMessageContent(
              incomingRaw.content,
              incomingRaw.room_id,
              activePeerIdRef.current || incomingRaw.sender_id
            );
            const incoming: ChatMessage = { ...incomingRaw, content: plainText };

            setPrivateMessages((prev) => {
              if (prev.some((m) => m.id === incoming.id)) return prev;
              return [...prev, incoming];
            });
            if (incoming.sender_id !== myId) {
              setPeerTyping(false);
            }
          }

          // 8. Typing Indicator
          else if (
            payload.type === 'room:typing' &&
            payload.roomId === activeRoomIdRef.current &&
            payload.userId !== myId
          ) {
            setPeerTyping(Boolean(payload.isTyping));
          }

          // 9. Instant Room Nuke Event
          else if (payload.type === 'room:nuked' && payload.roomId) {
            const nukedId = String(payload.roomId);
            fetchConversations();

            if (nukedId === activeRoomIdRef.current) {
              setPrivateMessages([]);
              setActiveRoom(null);
              setActivePeerId(null);
              setShowNukeModal(false);
              setNukeAlert(
                `NUKE EXECUTED: Room ${nukedId} and all messages were permanently wiped by ${payload.triggeredBy || 'peer'}.`
              );
            }
          }
        } catch {
          // Ignore malformed WS packets
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setPeerOnline(false);
        reconnectTimer = window.setTimeout(connectWebSocket, 2500);
      };
    }

    connectWebSocket();

    return () => {
      isMounted = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [myId, fetchConversations, pushNotificationToast, playNotificationPing]);

  // Fallback Polling for Global, Conversations & Private Chat (every 3.5s)
  useEffect(() => {
    const pollInterval = window.setInterval(async () => {
      fetchGlobalMessages();
      fetchConversations();

      if (activeRoom?.room_id) {
        try {
          const res = await fetch(
            `/api/rooms/${encodeURIComponent(activeRoom.room_id)}/messages`
          );
          const data = await res.json();
          if (!data.ok) return;

          if (data.roomExists === false) {
            setPrivateMessages([]);
            setActiveRoom(null);
            setActivePeerId(null);
            setNukeAlert(
              'CHANNEL TERMINATED: Private room and all messages were permanently purged.'
            );
            fetchConversations();
            return;
          }

          if (Array.isArray(data.messages)) {
            const decrypted = await decryptMessageBatch(
              data.messages,
              activeRoom.room_id,
              activePeerIdRef.current || undefined
            );
            setPrivateMessages(decrypted);
          }
        } catch {
          // Ignore transient network errors
        }
      }
    }, 3500);

    return () => window.clearInterval(pollInterval);
  }, [activeRoom?.room_id, fetchGlobalMessages, fetchConversations]);

  const handleManualSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    connectToPeerChannel(peerInput, true);
  };

  // Reaction API Call (Optimistic update + server sync)
  const triggerMessageReaction = useCallback(
    async (messageId: string, roomId: string, emoji: string, mode: 'toggle' | 'add' = 'toggle') => {
      const updateList = (list: ChatMessage[]): ChatMessage[] =>
        list.map((msg) => {
          if (msg.id !== messageId) return msg;
          const currentMap: ReactionMap = { ...(msg.reactions || {}) };
          const currentUsers = currentMap[emoji] ? [...currentMap[emoji]] : [];
          const hasMine = currentUsers.includes(myId);

          if (hasMine && mode === 'toggle') {
            const filtered = currentUsers.filter((u) => u !== myId);
            if (filtered.length === 0) {
              delete currentMap[emoji];
            } else {
              currentMap[emoji] = filtered;
            }
          } else if (!hasMine) {
            currentMap[emoji] = [...currentUsers, myId];
          }
          return { ...msg, reactions: currentMap };
        });

      if (roomId === 'GLOBAL') {
        setGlobalMessages(updateList);
      } else {
        setPrivateMessages(updateList);
      }

      if (emoji === '❤️' && mode === 'add') {
        setHeartBurstMsgId(messageId);
        window.setTimeout(() => {
          setHeartBurstMsgId((prev) => (prev === messageId ? null : prev));
        }, 650);
      }

      setReactionMenuMsg(null);

      try {
        await fetch(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomId,
            userId: myId,
            emoji,
            mode,
          }),
        });
      } catch {
        // Ignore transient network failure
      }
    },
    [myId]
  );

  // Touch & Mouse Handlers for Double-Tap (❤️) and Long-Press / Right-Click Reaction Bar
  const openReactionMenuForMessage = (msgId: string, roomId: string) => {
    if (!hasShownReactionTipRef.current) {
      hasShownReactionTipRef.current = true;
      setShowFirstTimeReactionTip(true);
    } else {
      setShowFirstTimeReactionTip(false);
    }
    setReactionMenuMsg({ messageId: msgId, roomId });
  };

  const handleBubblePointerDown = (msgId: string, roomId: string) => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = window.setTimeout(() => {
      openReactionMenuForMessage(msgId, roomId);
    }, 460);
  };

  const handleBubblePointerUpOrLeave = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleBubbleTap = (msgId: string, roomId: string) => {
    const now = Date.now();
    if (lastTapRef.current.msgId === msgId && now - lastTapRef.current.time < 320) {
      triggerMessageReaction(msgId, roomId, '❤️', 'add');
      lastTapRef.current = { msgId: '', time: 0 };
    } else {
      lastTapRef.current = { msgId, time: now };
    }
  };

  // Transmit Global Public Content
  const sendGlobalContent = async (rawContent: string) => {
    const text = rawContent.trim();
    if (!text || isSendingGlobal) return;

    const tempId = `GLB-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const optimisticMsg: ChatMessage = {
      id: tempId,
      room_id: 'GLOBAL',
      sender_id: myId,
      content: text,
      timestamp: Date.now(),
      reactions: {},
    };

    setGlobalMessages((prev) => [...prev, optimisticMsg]);
    setIsSendingGlobal(true);

    try {
      const encryptedCiphertext = await encryptMessageContent(text, 'GLOBAL');

      const res = await fetch('/api/global/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: tempId,
          senderId: myId,
          content: encryptedCiphertext,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setGlobalMessages((prev) => prev.filter((m) => m.id !== tempId));
        setErrorBanner(data.error || 'Failed to post to Global Chat.');
      }
    } catch {
      setGlobalMessages((prev) => prev.filter((m) => m.id !== tempId));
      setErrorBanner('Network error: global message could not be delivered.');
    } finally {
      setIsSendingGlobal(false);
    }
  };

  const handleSendGlobalMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!globalDraft.trim()) return;
    const text = globalDraft;
    setGlobalDraft('');
    setPickerOpenFor(null);
    await sendGlobalContent(text);
  };

  // Transmit Private 1-on-1 Content (Encrypted Under the Hood)
  const sendPrivateContent = async (rawContent: string) => {
    if (!activeRoom || isSendingPrivate) return;
    const text = rawContent.trim();
    if (!text) return;

    const tempId = `MSG-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const optimisticMsg: ChatMessage = {
      id: tempId,
      room_id: activeRoom.room_id,
      sender_id: myId,
      content: text,
      timestamp: Date.now(),
      reactions: {},
    };

    seenMessageIdsRef.current.add(tempId);
    setPrivateMessages((prev) => [...prev, optimisticMsg]);
    setIsSendingPrivate(true);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'room:typing',
          roomId: activeRoom.room_id,
          userId: myId,
          isTyping: false,
        })
      );
    }

    try {
      const encryptedCiphertext = await encryptMessageContent(
        text,
        activeRoom.room_id,
        activePeerId || undefined
      );

      const res = await fetch(`/api/rooms/${encodeURIComponent(activeRoom.room_id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: tempId,
          senderId: myId,
          content: encryptedCiphertext,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPrivateMessages((prev) => prev.filter((m) => m.id !== tempId));
        setErrorBanner(data.error || 'Failed to send private message.');
      } else {
        fetchConversations();
      }
    } catch {
      setPrivateMessages((prev) => prev.filter((m) => m.id !== tempId));
      setErrorBanner('Network error: private message could not be delivered.');
    } finally {
      setIsSendingPrivate(false);
    }
  };

  const handleSendPrivateMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!privateDraft.trim()) return;
    const text = privateDraft;
    setPrivateDraft('');
    setPickerOpenFor(null);
    await sendPrivateContent(text);
  };

  const handlePrivateDraftChange = (val: string) => {
    setPrivateDraft(val);
    if (!activeRoom || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(
      JSON.stringify({
        type: 'room:typing',
        roomId: activeRoom.room_id,
        userId: myId,
        isTyping: val.trim().length > 0,
      })
    );

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && activeRoom) {
        wsRef.current.send(
          JSON.stringify({
            type: 'room:typing',
            roomId: activeRoom.room_id,
            userId: myId,
            isTyping: false,
          })
        );
      }
    }, 2000);
  };

  // Execute "Nuke Chat"
  const handleConfirmNuke = async () => {
    if (!activeRoom || isNuking) return;
    setIsNuking(true);
    setErrorBanner(null);

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(activeRoom.room_id)}/nuke`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggeredBy: myId }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setErrorBanner(data.error || 'Failed to execute Nuke command.');
        setIsNuking(false);
        return;
      }

      if (activePeerId) {
        setUnreadByPeer((prev) => {
          const next = { ...prev };
          delete next[activePeerId];
          return next;
        });
      }

      setPrivateMessages([]);
      setActiveRoom(null);
      setActivePeerId(null);
      setShowNukeModal(false);
      setNukeAlert(
        `NUKE COMPLETE: Permanently wiped ${data.deletedMessages} messages and room history (${data.nukedRoomId}) for both participants.`
      );
      fetchConversations();
    } catch {
      setErrorBanner('Failed to reach server for Nuke command.');
    } finally {
      setIsNuking(false);
    }
  };

  const copyMyId = () => {
    navigator.clipboard.writeText(myId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1800);
  };

  const totalUnreadCount: number = (Object.values(unreadByPeer) as number[]).reduce(
    (acc, count) => acc + count,
    0
  );

  const roomRemainingMs = activeRoom
    ? Math.max(0, activeRoom.created_at + TTL_MS - nowTick)
    : TTL_MS;
  const myIdRemainingMs = Math.max(0, myIdExpiresAt - nowTick);

  const activeEmojiCategory =
    EMOJI_LIBRARY_CATEGORIES.find((c) => c.id === selectedCategoryId) ||
    EMOJI_LIBRARY_CATEGORIES[0];

  // Render an Individual Message Item with Double-Tap ❤️, Long-Press Reaction Bar, Anti-Copy Lock, and TTL-Only Metadata
  const renderMessageItem = (msg: ChatMessage, isGlobal: boolean) => {
    const isMine = msg.sender_id === myId;
    const msgRemainingMs = Math.max(0, msg.timestamp + TTL_MS - nowTick);
    const reactionsMap: ReactionMap = msg.reactions || {};

    // Group identical emojis and deduplicate user list per emoji
    const groupedReactions = Object.entries(reactionsMap)
      .map(([emoji, users]) => {
        const uniqueUsers = Array.isArray(users) ? Array.from(new Set(users)) : [];
        return {
          emoji,
          users: uniqueUsers,
          count: uniqueUsers.length,
        };
      })
      .filter((item) => item.count > 0);
    const isHeartBursting = heartBurstMsgId === msg.id;

    return (
      <div
        key={msg.id}
        className={`flex flex-col w-full select-none ${
          isMine ? 'items-end' : 'items-start'
        }`}
      >
        {/* Metadata Row: Sender ID + TTL Countdown ONLY (No HH:MM:SS Send Timestamps) */}
        <div className="flex flex-wrap items-center gap-1.5 mb-1 px-1 text-[10px] sm:text-[11px] text-zinc-400 font-mono tabular-nums max-w-full select-none">
          {isMine ? (
            <span className="text-emerald-400 font-semibold">{myId} (You)</span>
          ) : isGlobal ? (
            <button
              type="button"
              onClick={() => connectToPeerChannel(msg.sender_id, true)}
              className="text-emerald-400 hover:text-emerald-300 font-semibold underline decoration-emerald-500/50 underline-offset-2 cursor-pointer flex items-center gap-1 select-none"
              title={`Open 1-on-1 private chat with ${msg.sender_id}`}
            >
              <span>{msg.sender_id}</span>
              <span className="text-[10px] text-zinc-400 no-underline">
                [Chat 1-on-1 →]
              </span>
            </button>
          ) : (
            <span className="text-zinc-300 font-semibold">{msg.sender_id}</span>
          )}
          <span>·</span>
          <span className="text-zinc-500" title="Time remaining before 24-hour auto-destruct">
            TTL: {formatCountdown(msgRemainingMs)}
          </span>
        </div>

        {/* Message Bubble with Strict Selection Lock (Decoupled from reaction row width) */}
        <div
          className={`flex flex-col max-w-[88%] sm:max-w-xl select-none ${
            isMine ? 'items-end' : 'items-start'
          }`}
        >
          <div className="relative group w-fit max-w-full select-none">
            <div
              onClick={() => handleBubbleTap(msg.id, msg.room_id)}
              onDoubleClick={() => triggerMessageReaction(msg.id, msg.room_id, '❤️', 'add')}
              onContextMenu={(e) => {
                e.preventDefault();
                openReactionMenuForMessage(msg.id, msg.room_id);
              }}
              onPointerDown={() => handleBubblePointerDown(msg.id, msg.room_id)}
              onPointerUp={handleBubblePointerUpOrLeave}
              onPointerLeave={handleBubblePointerUpOrLeave}
              onPointerCancel={handleBubblePointerUpOrLeave}
              className={`relative cursor-pointer select-none transition-transform active:scale-[0.99] px-3.5 py-2.5 rounded-xl text-xs sm:text-sm leading-relaxed break-words overflow-hidden border ${
                isMine
                  ? 'bg-emerald-950/75 border-emerald-800/70 text-zinc-100'
                  : 'bg-zinc-900/90 border-zinc-800 text-zinc-100'
              }`}
            >
              {msg.content}

              {/* Quick Hover Reaction Trigger on Desktop */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openReactionMenuForMessage(msg.id, msg.room_id);
                }}
                className={`opacity-0 group-hover:opacity-100 transition-opacity absolute top-1 ${
                  isMine ? '-left-7' : '-right-7'
                } p-1 rounded-md bg-zinc-900/90 border border-zinc-800 text-zinc-400 hover:text-emerald-400 hidden sm:flex items-center justify-center cursor-pointer select-none`}
                aria-label="Add reaction"
              >
                <Smile className="w-3.5 h-3.5" />
              </button>

              {/* Double-Tap Heart Burst Visual Indicator */}
              {isHeartBursting && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center animate-ping text-2xl select-none">
                  ❤️
                </div>
              )}
            </div>
          </div>

          {/* Active Grouped Reaction Pills (Strictly constrained to max-w-[250px] without stretching bubble) */}
          {groupedReactions.length > 0 && (
            <div
              className={`flex flex-wrap items-center gap-1 mt-1 max-w-[250px] w-fit overflow-x-auto scrollbar-none select-none ${
                isMine ? 'justify-end' : 'justify-start'
              }`}
            >
              {groupedReactions.map(({ emoji, users, count }) => {
                const iReacted = users.includes(myId);
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => triggerMessageReaction(msg.id, msg.room_id, emoji, 'toggle')}
                    className={`px-2 py-0.5 rounded-full text-[11px] leading-tight font-mono tabular-nums inline-flex items-center gap-1 shrink-0 backdrop-blur-md border transition-colors cursor-pointer select-none ${
                      iReacted
                        ? 'bg-emerald-950/85 border-emerald-500/70 text-emerald-300 font-semibold shadow-sm'
                        : 'bg-zinc-900/80 border-zinc-800/90 text-zinc-300 hover:border-zinc-700'
                    }`}
                  >
                    <span className="text-xs leading-none">{emoji}</span>
                    <span className="text-[10px] leading-none">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Render Comprehensive Emoji Library Popover (Emoji-Only)
  const renderEmojiPicker = () => {
    if (!pickerOpenFor) return null;

    return (
      <div className="absolute bottom-14 left-2 right-2 sm:left-6 sm:right-auto z-30 bg-zinc-950/95 backdrop-blur-xl border border-zinc-800 rounded-2xl shadow-2xl sm:w-[410px] max-h-[340px] flex flex-col overflow-hidden select-none">
        {/* Top Header */}
        <div className="px-3 py-2 border-b border-zinc-800/80 flex items-center justify-between gap-2 shrink-0 bg-zinc-900/50">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
            <Smile className="w-4 h-4 shrink-0" />
            <span>Emoji Library</span>
          </div>

          <button
            type="button"
            onClick={() => setPickerOpenFor(null)}
            className="p-1 text-zinc-400 hover:text-zinc-100 rounded-md cursor-pointer"
            aria-label="Close emoji picker"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Category Tabs for Emojis */}
        <div className="px-2.5 py-1.5 border-b border-zinc-800/60 flex items-center gap-1 overflow-x-auto scrollbar-none shrink-0 bg-zinc-950">
          {EMOJI_LIBRARY_CATEGORIES.map((cat) => {
            const active = cat.id === selectedCategoryId;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 flex items-center gap-1 transition-colors cursor-pointer ${
                  active
                    ? 'bg-zinc-800 text-emerald-400 border border-zinc-700'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <span>{cat.icon}</span>
                <span>{cat.name}</span>
              </button>
            );
          })}
        </div>

        {/* Scrollable Emoji Grid Body */}
        <div className="flex-1 overflow-y-auto touch-scroll p-2.5">
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-zinc-400 px-1">
              {activeEmojiCategory.name} ({activeEmojiCategory.emojis.length})
            </div>
            <div className="grid grid-cols-7 sm:grid-cols-8 gap-1">
              {activeEmojiCategory.emojis.map((emj, idx) => (
                <button
                  key={`${activeEmojiCategory.id}-${idx}`}
                  type="button"
                  onClick={() => handleInsertEmoji(emj)}
                  className="p-1.5 text-xl hover:bg-zinc-800 active:scale-110 rounded-lg transition-all flex items-center justify-center cursor-pointer select-none"
                >
                  {emj}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col justify-between h-full gap-5 select-none">
      <div className="space-y-5">
        {/* 1. Immutable Random Identity Card (24-Hour Active Lifecycle) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Your Identity</span>
            <span className="font-mono text-[11px] text-emerald-400 tabular-nums">
              TTL: {formatCountdown(myIdRemainingMs)}
            </span>
          </div>
          <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl flex items-center justify-between gap-2 backdrop-blur-sm">
            <span className="text-base sm:text-lg font-mono font-semibold tracking-wider text-zinc-100 tabular-nums truncate">
              {myId}
            </span>
            <button
              type="button"
              onClick={copyMyId}
              className="px-2.5 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
            >
              {copiedId ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy ID</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 2. Manual ID Search */}
        <form onSubmit={handleManualSearchSubmit} className="space-y-2">
          <label
            htmlFor="manual-id-search"
            className="block text-xs font-medium text-zinc-300 flex items-center gap-1.5"
          >
            <Search className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Connect Peer ID</span>
          </label>
          <div className="flex gap-2 w-full">
            <input
              id="manual-id-search"
              type="text"
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value.toUpperCase())}
              placeholder="USER-5LPT"
              maxLength={16}
              className="select-text min-w-0 flex-1 px-3 py-2 text-xs sm:text-sm font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500 transition-colors uppercase"
            />
            <button
              type="submit"
              disabled={isConnecting}
              className="px-3.5 py-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 cursor-pointer"
            >
              <span>{isConnecting ? '...' : 'Chat'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>

        {/* 3. Active Private Chats & Incoming Requests Section */}
        <div className="space-y-2 pt-2 border-t border-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span className="flex items-center gap-1.5 font-medium text-zinc-300">
              <MessageSquareLock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Private Chats</span>
            </span>
            <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
              {totalUnreadCount > 0 && (
                <span className="text-amber-400 font-semibold">
                  {totalUnreadCount} unread ·
                </span>
              )}
              <span>{conversations.length} active</span>
            </div>
          </div>

          <div className="max-h-44 overflow-y-auto touch-scroll space-y-1.5 pr-1">
            {conversations.length === 0 ? (
              <p className="text-xs text-zinc-600 py-1">
                No active private chats yet.
              </p>
            ) : (
              conversations.map((conv) => {
                const isSelected =
                  activeTab === 'private' && activePeerId === conv.peer_id;
                const unreadCount = unreadByPeer[conv.peer_id] || 0;
                const isPeerOnlineNow = onlineUsers.includes(conv.peer_id);

                return (
                  <button
                    key={conv.room_id}
                    type="button"
                    onClick={() => connectToPeerChannel(conv.peer_id, false)}
                    className={`w-full p-2.5 text-left rounded-lg transition-colors flex flex-col gap-1 cursor-pointer border select-none ${
                      isSelected
                        ? 'bg-zinc-800/90 border-zinc-700'
                        : unreadCount > 0
                        ? 'bg-emerald-950/30 border-emerald-700/70 hover:bg-emerald-950/50'
                        : 'bg-zinc-900/40 hover:bg-zinc-900 border-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-zinc-200 truncate">
                        <span className={isSelected ? 'text-emerald-400' : ''}>
                          {conv.peer_id}
                        </span>
                        <span className="text-zinc-600">·</span>
                        <span className="text-[10px] font-normal text-zinc-400">
                          {isPeerOnlineNow ? 'Online' : 'Offline'}
                        </span>
                      </div>
                      {unreadCount > 0 ? (
                        <span className="font-mono text-[11px] font-bold text-amber-400 tabular-nums shrink-0">
                          {unreadCount} new
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-zinc-500 tabular-nums shrink-0">
                          {conv.message_count} msgs
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-400 truncate">
                      {conv.last_message
                        ? `${conv.last_message.sender_id === myId ? 'You: ' : ''}${conv.last_message.content}`
                        : 'Private channel ready — tap to open'}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 4. Online Users in Global Session */}
        <div className="space-y-2 pt-2 border-t border-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Online Peers</span>
            </span>
            <span className="font-mono text-[11px] tabular-nums">{onlineUsers.length} online</span>
          </div>
          <div className="max-h-32 overflow-y-auto touch-scroll space-y-1 pr-1">
            {onlineUsers.length === 0 ? (
              <p className="text-xs text-zinc-600 py-1">Synchronizing active peers...</p>
            ) : (
              onlineUsers.map((uid) => {
                const isMe = uid === myId;
                return (
                  <button
                    key={uid}
                    type="button"
                    disabled={isMe}
                    onClick={() => !isMe && connectToPeerChannel(uid, true)}
                    className={`w-full px-3 py-1.5 text-left text-xs font-mono rounded-lg transition-colors flex items-center justify-between select-none ${
                      isMe
                        ? 'bg-zinc-900/40 text-zinc-500 cursor-default'
                        : 'text-zinc-300 hover:bg-zinc-900 hover:text-emerald-400 cursor-pointer'
                    }`}
                  >
                    <span className="truncate">{uid}</span>
                    <span className="text-[11px] text-zinc-500 shrink-0">
                      {isMe ? 'You' : 'Chat 1-on-1 →'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Minimalist TTL Indicator & Compact Sound Icon Toggle */}
      <div className="pt-2.5 border-t border-zinc-800/80 flex items-center justify-between gap-2 text-xs text-zinc-400 shrink-0">
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
          <Clock className="w-3 h-3 text-emerald-400 shrink-0" />
          <span>24h Auto-Destruct</span>
        </span>
        <button
          type="button"
          onClick={toggleSoundEnabled}
          className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] font-mono flex items-center gap-1 transition-colors cursor-pointer shrink-0"
          title="Toggle notification sound"
          aria-label="Toggle notification sound"
        >
          {soundEnabled ? (
            <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          ) : (
            <VolumeX className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          )}
          <span className={soundEnabled ? 'text-emerald-400' : 'text-zinc-500'}>
            {soundEnabled ? 'ON' : 'OFF'}
          </span>
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="h-dvh w-full max-w-full overflow-hidden bg-black text-zinc-100 flex flex-col select-none"
      onContextMenu={(e) => {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
      }}
    >
      {/* Streamlined Top Header: App Title ("WhisperNet"), Tiny Sound Icon Toggle, and User ID Copy Button */}
      <header className="shrink-0 w-full max-w-full flex items-center justify-between gap-3 px-3.5 sm:px-6 py-2.5 sm:py-3 border-b border-zinc-800/80 bg-black/95 backdrop-blur-md z-30 select-none">
        <a
          href="#global"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('global');
            setShowMobileDrawer(false);
          }}
          className="text-sm sm:text-base font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0 select-none"
        >
          WhisperNet
        </a>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleSoundEnabled}
            className="px-2 py-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-900 border border-zinc-800 text-[11px] font-mono flex items-center gap-1 transition-colors cursor-pointer shrink-0"
            title={soundEnabled ? 'Sound notifications ON' : 'Sound notifications OFF'}
            aria-label="Toggle notification sound"
          >
            {soundEnabled ? (
              <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <VolumeX className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            )}
            <span className={`text-[10px] ${soundEnabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {soundEnabled ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={copyMyId}
            className="px-2.5 sm:px-3.5 py-1.5 text-xs font-mono font-medium text-zinc-200 bg-zinc-900/90 border border-zinc-800 rounded-lg hover:border-emerald-500/50 hover:bg-zinc-900 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer select-none"
            title="Click to copy your ID"
          >
            <span>{myId}</span>
            {copiedId ? (
              <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            )}
          </button>
        </div>
      </header>

      {/* Real-Time In-App Notification Banner / Toast Stack */}
      {toastQueue.length > 0 && (
        <div className="fixed top-14 sm:top-auto sm:bottom-5 left-3 right-3 sm:left-auto sm:right-5 z-40 flex flex-col gap-2 sm:max-w-sm pointer-events-none select-none">
          {toastQueue.map((toast) => (
            <div
              key={toast.id}
              className="pointer-events-auto bg-zinc-950/95 backdrop-blur-xl border border-emerald-500/80 rounded-xl p-3 sm:p-4 shadow-2xl flex flex-col gap-2 select-none"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 min-w-0">
                  <Bell className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{toast.headline}</span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setToastQueue((prev) => prev.filter((item) => item.id !== toast.id))
                  }
                  className="text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
                  aria-label="Dismiss notification"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-zinc-300 leading-snug break-words line-clamp-2">
                {toast.preview}
              </p>
              <div className="flex items-center justify-between pt-0.5">
                <span className="text-[11px] font-mono text-zinc-400 truncate">
                  From: {toast.fromUserId}
                </span>
                <button
                  type="button"
                  onClick={() => connectToPeerChannel(toast.fromUserId, false)}
                  className="px-2.5 py-1 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-md transition-colors flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <span>Open Chat</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main Content Container: Fixed to remaining viewport height, zero horizontal scroll */}
      <main className="flex-1 min-h-0 w-full max-w-[1440px] mx-auto flex overflow-hidden relative select-none">
        {/* Desktop Sidebar (Visible on lg+) */}
        <aside className="hidden lg:flex lg:w-80 xl:w-88 border-r border-zinc-800/80 bg-black p-5 flex-col justify-between shrink-0 h-full overflow-y-auto touch-scroll">
          {sidebarContent}
        </aside>

        {/* Mobile Slide-Over Directory / Search Drawer */}
        {showMobileDrawer && (
          <div className="fixed inset-0 z-40 lg:hidden flex select-none">
            <div
              className="fixed inset-0 bg-black/80 backdrop-blur-xs"
              onClick={() => setShowMobileDrawer(false)}
            />
            <div className="relative z-10 w-full max-w-xs bg-zinc-950 border-r border-zinc-800 h-full flex flex-col p-4 overflow-y-auto touch-scroll shadow-2xl">
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800 shrink-0">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                  Peer Directory
                </span>
                <button
                  type="button"
                  onClick={() => setShowMobileDrawer(false)}
                  className="p-1 text-zinc-400 hover:text-zinc-100 cursor-pointer"
                  aria-label="Close drawer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto touch-scroll">{sidebarContent}</div>
            </div>
          </div>
        )}

        {/* Right / Main Chat Viewport */}
        <section className="flex-1 min-w-0 max-w-full h-full flex flex-col bg-black overflow-hidden">
          {/* Sub-Header Navigation Bar: Clean non-overlapping layout */}
          <div className="shrink-0 px-2.5 sm:px-6 py-2 border-b border-zinc-800/80 bg-zinc-950/70 flex items-center justify-between gap-1.5 sm:gap-3 w-full max-w-full overflow-hidden">
            <div className="flex items-center gap-1 sm:gap-2 min-w-0 flex-1 overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('global');
                  setPickerOpenFor(null);
                }}
                className={`px-2.5 sm:px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer shrink-0 ${
                  activeTab === 'global'
                    ? 'bg-zinc-800 text-emerald-400 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                }`}
              >
                <Globe className="w-3.5 h-3.5 shrink-0" />
                <span>Global Chat</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActiveTab('private');
                  setPickerOpenFor(null);
                }}
                className={`px-2.5 sm:px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer min-w-0 ${
                  activeTab === 'private'
                    ? 'bg-zinc-800 text-emerald-400 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                }`}
              >
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Private Chats</span>
                {totalUnreadCount > 0 ? (
                  <span className="font-mono text-[11px] font-bold text-amber-400 tabular-nums shrink-0">
                    ({totalUnreadCount})
                  </span>
                ) : activePeerId ? (
                  <span className="hidden md:inline font-mono text-[11px] text-emerald-400 truncate max-w-[110px]">
                    ({activePeerId})
                  </span>
                ) : null}
              </button>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
              <span className="hidden md:inline text-[11px] font-mono text-zinc-400">
                {onlineUsers.length} online · TTL: 24h
              </span>
              <button
                type="button"
                onClick={() => setShowMobileDrawer(true)}
                className="lg:hidden px-2.5 py-1.5 text-xs font-medium text-zinc-200 bg-zinc-900 border border-zinc-800 rounded-lg hover:bg-zinc-800 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0"
                aria-label="Open ID search and peer directory"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>ID Search</span>
              </button>
            </div>
          </div>

          {/* Alert Banners for Nuke or Invalid User ID Validation */}
          {(nukeAlert || errorBanner) && (
            <div className="shrink-0 px-3 sm:px-6 pt-2.5 space-y-2 w-full max-w-full">
              {nukeAlert && (
                <div className="p-2.5 sm:p-3 bg-rose-950/50 border border-rose-800/80 rounded-lg flex items-center justify-between gap-2 text-xs text-rose-200">
                  <div className="flex items-center gap-2 min-w-0">
                    <Flame className="w-4 h-4 text-rose-400 shrink-0" />
                    <span className="truncate">{nukeAlert}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setNukeAlert(null)}
                    className="text-rose-400 hover:text-rose-200 shrink-0 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {errorBanner && (
                <div
                  role="alert"
                  className="p-2.5 sm:p-3 bg-amber-950/60 border border-amber-700/80 rounded-lg flex items-center justify-between gap-2 text-xs text-amber-200"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span className="break-words">{errorBanner}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setErrorBanner(null)}
                    className="text-amber-400 hover:text-amber-200 shrink-0 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 1: GLOBAL PUBLIC ROOM (GLOBAL CHAT) */}
          {activeTab === 'global' && (
            <div className="flex-1 min-h-0 flex flex-col w-full max-w-full overflow-hidden relative">
              {/* Mobile Quick-Connect Bar */}
              <div className="lg:hidden shrink-0 px-3 py-2 border-b border-zinc-900 bg-zinc-950/40 flex items-center justify-between gap-2">
                <form
                  onSubmit={handleManualSearchSubmit}
                  className="flex items-center gap-1.5 flex-1 min-w-0"
                >
                  <input
                    type="text"
                    value={peerInput}
                    onChange={(e) => setPeerInput(e.target.value.toUpperCase())}
                    placeholder="Connect Peer ID (e.g. USER-5LPT)"
                    maxLength={16}
                    className="select-text min-w-0 flex-1 px-2.5 py-1.5 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-md text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 uppercase"
                  />
                  <button
                    type="submit"
                    disabled={isConnecting}
                    className="px-2.5 py-1.5 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Chat 1v1
                  </button>
                </form>
              </div>

              {/* Scrollable Global Messages List (Minimal Empty State without helper text) */}
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden touch-scroll p-3 sm:p-6 space-y-3.5 select-none">
                {globalMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4 space-y-2 text-zinc-500">
                    <Globe className="w-7 h-7 text-zinc-600" />
                    <p className="text-sm text-zinc-300 font-medium">
                      Global Public Feed Active
                    </p>
                  </div>
                ) : (
                  globalMessages.map((msg) => renderMessageItem(msg, true))
                )}
                <div ref={globalEndRef} />
              </div>

              {/* Extensive Emoji Library Popover */}
              {pickerOpenFor === 'global' && renderEmojiPicker()}

              {/* Fixed Bottom Global Message Composer */}
              <form
                onSubmit={handleSendGlobalMessage}
                className="shrink-0 p-2.5 sm:p-3.5 border-t border-zinc-800/80 bg-zinc-950/90 flex items-center gap-2 w-full max-w-full"
              >
                <button
                  type="button"
                  onClick={() =>
                    setPickerOpenFor((prev) => (prev === 'global' ? null : 'global'))
                  }
                  className={`p-2 sm:p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer flex items-center gap-1 ${
                    pickerOpenFor === 'global'
                      ? 'bg-zinc-800 border-emerald-500/60 text-emerald-400'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Open Emoji Picker"
                  aria-label="Open Emoji Picker"
                >
                  <Smile className="w-4 h-4" />
                </button>
                <input
                  ref={globalInputRef}
                  type="text"
                  value={globalDraft}
                  onChange={(e) => setGlobalDraft(e.target.value)}
                  placeholder={`Broadcast publicly as ${myId}...`}
                  maxLength={2000}
                  className="select-text min-w-0 flex-1 px-3 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 transition-colors"
                />
                <button
                  type="submit"
                  disabled={!globalDraft.trim() || isSendingGlobal}
                  className="px-3.5 sm:px-5 py-2 sm:py-2.5 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-950 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>Send</span>
                  <Send className="w-3.5 h-3.5 shrink-0" />
                </button>
              </form>
            </div>
          )}

          {/* TAB 2: PRIVATE 1-ON-1 CHAT & NUKE BUTTON */}
          {activeTab === 'private' && (
            <div className="flex-1 min-h-0 flex flex-col w-full max-w-full overflow-hidden relative">
              {!activeRoom ? (
                /* Scrollable Private Chat Hub when no specific room is open */
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden touch-scroll p-4 sm:p-8 select-none">
                  <div className="max-w-xl mx-auto flex flex-col items-center text-center space-y-5 py-4">
                    <div className="w-11 h-11 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-emerald-400 shrink-0">
                      <Shield className="w-5 h-5" />
                    </div>
                    <div className="space-y-1.5">
                      <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-zinc-100">
                        Private 1-on-1 Channels
                      </h2>
                      <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
                        Enter an active peer ID below, select an ongoing conversation, or tap any user ID in <strong className="text-zinc-200">Global Chat</strong>.
                      </p>
                    </div>

                    {/* Inline Manual ID Search Form */}
                    <form
                      onSubmit={handleManualSearchSubmit}
                      className="w-full max-w-sm flex gap-2"
                    >
                      <input
                        type="text"
                        value={peerInput}
                        onChange={(e) => setPeerInput(e.target.value.toUpperCase())}
                        placeholder="Enter Peer ID (e.g. USER-5LPT)"
                        maxLength={16}
                        className="select-text min-w-0 flex-1 px-3 py-2 text-xs sm:text-sm font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500 uppercase"
                      />
                      <button
                        type="submit"
                        disabled={isConnecting}
                        className="px-3.5 py-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                      >
                        <span>Connect</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </form>

                    {/* Active Private Chat Requests / Conversations Directory */}
                    {conversations.length > 0 && (
                      <div className="w-full text-left space-y-2 pt-2">
                        <div className="flex items-center justify-between text-xs text-zinc-400">
                          <span className="font-semibold text-zinc-200">
                            Active Private Conversations
                          </span>
                          <span className="font-mono">{conversations.length} rooms</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          {conversations.map((conv) => {
                            const unreadCount = unreadByPeer[conv.peer_id] || 0;

                            return (
                              <button
                                key={conv.room_id}
                                type="button"
                                onClick={() => connectToPeerChannel(conv.peer_id, false)}
                                className={`p-3 rounded-xl border text-left transition-colors flex flex-col justify-between gap-1.5 cursor-pointer min-w-0 select-none ${
                                  unreadCount > 0
                                    ? 'bg-emerald-950/30 border-emerald-600/80 hover:bg-emerald-950/50'
                                    : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-700'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2 min-w-0">
                                  <span className="font-mono text-xs sm:text-sm font-semibold text-emerald-400 truncate">
                                    {conv.peer_id}
                                  </span>
                                  {unreadCount > 0 ? (
                                    <span className="font-mono text-xs font-bold text-amber-400 shrink-0">
                                      {unreadCount} new
                                    </span>
                                  ) : (
                                    <span className="font-mono text-xs text-zinc-500 shrink-0">
                                      Open →
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-zinc-300 truncate">
                                  {conv.last_message
                                    ? conv.last_message.content
                                    : `${conv.peer_id} initiated a private session`}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-center flex-wrap gap-2 pt-1">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-900/70 border border-zinc-800 text-xs text-zinc-300">
                        <Flame className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        <span>Instant Nuke</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-900/70 border border-zinc-800 text-xs text-zinc-300">
                        <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span>24h TTL</span>
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                /* Active Private 1-on-1 Room: Fixed Room Header + Scrollable Messages + Fixed Input */
                <>
                  {/* Compact Private Room Header Bar with Switch Room & Nuke Chat Button */}
                  <div className="shrink-0 px-3 sm:px-6 py-2 border-b border-zinc-800/80 bg-zinc-950/80 flex items-center justify-between gap-2 w-full max-w-full select-none">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-zinc-100 min-w-0">
                        <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="font-mono text-emerald-400 truncate">
                          {activePeerId}
                        </span>
                        <span className="text-zinc-600 shrink-0">·</span>
                        <span className="text-[11px] font-normal text-zinc-400 shrink-0">
                          {peerOnline ? 'Online' : 'Offline'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] sm:text-xs text-zinc-400 font-mono tabular-nums truncate">
                        <Clock className="w-3 h-3 text-amber-400 shrink-0" />
                        <span>TTL: {formatCountdown(roomRemainingMs)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveRoom(null);
                          setActivePeerId(null);
                          setPickerOpenFor(null);
                        }}
                        className="px-2.5 py-1.5 text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Rooms
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowNukeModal(true)}
                        className="px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer shadow-xs"
                      >
                        <Flame className="w-3.5 h-3.5 shrink-0" />
                        <span>Nuke Chat</span>
                      </button>
                    </div>
                  </div>

                  {/* Scrollable Private Messages List (Minimal Empty State without helper text) */}
                  <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden touch-scroll p-3 sm:p-6 space-y-3.5 select-none">
                    {privateMessages.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center p-4 space-y-2 text-zinc-500">
                        <MessageSquareOff className="w-7 h-7 text-zinc-600" />
                        <p className="text-sm text-zinc-300 font-medium">
                          Private 1-on-1 Channel Established
                        </p>
                      </div>
                    ) : (
                      privateMessages.map((msg) => renderMessageItem(msg, false))
                    )}

                    {peerTyping && (
                      <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                        <span>{activePeerId} is typing...</span>
                      </div>
                    )}
                    <div ref={privateEndRef} />
                  </div>

                  {/* Extensive Emoji Library Popover */}
                  {pickerOpenFor === 'private' && renderEmojiPicker()}

                  {/* Fixed Bottom Private Message Input Composer */}
                  <form
                    onSubmit={handleSendPrivateMessage}
                    className="shrink-0 p-2.5 sm:p-3.5 border-t border-zinc-800/80 bg-zinc-950/90 flex items-center gap-2 w-full max-w-full"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setPickerOpenFor((prev) => (prev === 'private' ? null : 'private'))
                      }
                      className={`p-2 sm:p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer flex items-center gap-1 ${
                        pickerOpenFor === 'private'
                          ? 'bg-zinc-800 border-emerald-500/60 text-emerald-400'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="Open Emoji Picker"
                      aria-label="Open Emoji Picker"
                    >
                      <Smile className="w-4 h-4" />
                    </button>
                    <input
                      ref={privateInputRef}
                      type="text"
                      value={privateDraft}
                      onChange={(e) => handlePrivateDraftChange(e.target.value)}
                      placeholder={`Message ${activePeerId}...`}
                      maxLength={4000}
                      className="select-text min-w-0 flex-1 px-3 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                    <button
                      type="submit"
                      disabled={!privateDraft.trim() || isSendingPrivate}
                      className="px-3.5 sm:px-5 py-2 sm:py-2.5 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-950 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <span>Send</span>
                      <Send className="w-3.5 h-3.5 shrink-0" />
                    </button>
                  </form>
                </>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Long-Press / Right-Click Message Reaction Bar Modal (Tip shown only on first interaction) */}
      {reactionMenuMsg && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 select-none"
          onClick={() => setReactionMenuMsg(null)}
        >
          <div
            className="max-w-sm w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 shadow-2xl space-y-3 select-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-zinc-800/80 pb-2">
              <span className="font-semibold text-zinc-200">React to Message</span>
              <button
                type="button"
                onClick={() => setReactionMenuMsg(null)}
                className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {REACTION_BAR_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() =>
                    triggerMessageReaction(
                      reactionMenuMsg.messageId,
                      reactionMenuMsg.roomId,
                      emoji,
                      'toggle'
                    )
                  }
                  className="p-2 text-xl hover:bg-zinc-800 active:scale-110 rounded-xl transition-all flex items-center justify-center cursor-pointer select-none"
                >
                  {emoji}
                </button>
              ))}
            </div>
            {showFirstTimeReactionTip && (
              <p className="text-[11px] text-zinc-500 text-center">
                Double-tap any message bubble for a quick ❤️ reaction
              </p>
            )}
          </div>
        </div>
      )}

      {/* Confirmation Modal for "Nuke Chat" */}
      {showNukeModal && activeRoom && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 select-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nuke-modal-title"
        >
          <div className="max-w-md w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-5 sm:p-6 space-y-4 shadow-2xl select-none">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-rose-950 border border-rose-800/80 flex items-center justify-center text-rose-400 shrink-0">
                  <Trash2 className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h2 id="nuke-modal-title" className="text-sm sm:text-base font-bold text-zinc-100">
                    Confirm Nuke Chat?
                  </h2>
                  <p className="text-xs font-mono text-zinc-400 truncate">{activeRoom.room_id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNukeModal(false)}
                className="text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              This action will <strong className="text-rose-400">permanently and irreversibly delete</strong> all private chat history, reactions, and room records for both you (<code className="font-mono">{myId}</code>) and your peer (<code className="font-mono">{activePeerId}</code>) in real time.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowNukeModal(false)}
                disabled={isNuking}
                className="px-3.5 py-2 text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmNuke}
                disabled={isNuking}
                className="px-3.5 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Flame className="w-3.5 h-3.5 shrink-0" />
                <span>{isNuking ? 'Nuking...' : 'Confirm Nuke Chat'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
