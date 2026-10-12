import React, { useState, useEffect, useRef, useCallback } from 'react';

// Strict 30-Minute Ephemeral Message Lifetime (1,800,000 ms)
const TTL_MS = 30 * 60 * 1000;
const BROADCAST_CHANNEL_NAME = 'ephemeral_public_board_sync_v1';

interface PublicMessage {
  id: string;
  content: string;
  timestamp: number;
  expiresAt?: number;
  pending?: boolean;
}

function formatRemainingTtl(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function filterValidMessages(list: PublicMessage[], now: number): PublicMessage[] {
  const cutoff = now - TTL_MS;
  const seen = new Set<string>();
  const valid: PublicMessage[] = [];
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') continue;
    if (item.timestamp < cutoff) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    valid.push(item);
  }
  valid.sort((a, b) => a.timestamp - b.timestamp);
  return valid;
}

export default function App() {
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const wsRef = useRef<WebSocket | null>(null);
  const offlineQueueRef = useRef<PublicMessage[]>([]);
  const isFlushingRef = useRef<boolean>(false);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  // Smart scroll tracking to keep view anchored when near bottom
  const handleScroll = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= 120;
  }, []);

  // Auto-resize textarea cleanly for mobile & desktop
  const syncTextareaHeight = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, 128);
    el.style.height = `${Math.max(40, nextHeight)}px`;
  }, []);

  useEffect(() => {
    syncTextareaHeight(inputRef.current);
  }, [draft, syncTextareaHeight]);

  // Fetch active public messages (< 30 minutes old)
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/messages');
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.messages)) {
        const now = Date.now();
        setNowTick(now);
        setMessages((prev) => {
          const pendingOnly = prev.filter(
            (m) => m.pending && !data.messages.some((srv: PublicMessage) => srv.id === m.id)
          );
          return filterValidMessages([...data.messages, ...pendingOnly], now);
        });
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  // Flush queued messages automatically on reconnection
  const flushOfflineQueue = useCallback(async () => {
    if (isFlushingRef.current || offlineQueueRef.current.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    isFlushingRef.current = true;
    const queueSnapshot = [...offlineQueueRef.current];
    const remaining: PublicMessage[] = [];

    for (const item of queueSnapshot) {
      if (Date.now() - item.timestamp >= TTL_MS) continue;
      try {
        const res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, content: item.content }),
        });
        const data = await res.json();
        if (res.ok && data && data.ok && data.message) {
          setMessages((prev) =>
            filterValidMessages(
              prev.map((m) => (m.id === item.id ? { ...data.message, pending: false } : m)),
              Date.now()
            )
          );
        } else {
          remaining.push(item);
        }
      } catch {
        remaining.push(item);
      }
    }

    offlineQueueRef.current = remaining;
    isFlushingRef.current = false;
  }, []);

  // Multi-tab instant synchronization via BroadcastChannel
  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    broadcastChannelRef.current = bc;

    bc.onmessage = (event) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'message:created' && payload.message) {
        const now = Date.now();
        setMessages((prev) => filterValidMessages([...prev, payload.message], now));
      }
    };

    return () => {
      bc.close();
      broadcastChannelRef.current = null;
    };
  }, []);

  // Real-time WebSocket stream with exponential backoff reconnection
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let retryAttempt = 0;

    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const connectWebSocket = () => {
      if (!isMounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retryAttempt = 0;
        clearHeartbeat();
        flushOfflineQueue();
        heartbeatTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 20000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));
          const now = Date.now();
          setNowTick(now);

          if (data.type === 'message:created' && data.message) {
            const incoming: PublicMessage = { ...data.message, pending: false };
            setMessages((prev) => {
              const replaced = prev.some((m) => m.id === incoming.id)
                ? prev.map((m) => (m.id === incoming.id ? incoming : m))
                : [...prev, incoming];
              return filterValidMessages(replaced, now);
            });
          } else if (data.type === 'messages:sync' && Array.isArray(data.messages)) {
            setMessages((prev) => {
              const pendingOnly = prev.filter(
                (m) => m.pending && !data.messages.some((srv: PublicMessage) => srv.id === m.id)
              );
              return filterValidMessages([...data.messages, ...pendingOnly], now);
            });
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        clearHeartbeat();
        if (!isMounted) return;
        const delay = Math.min(10000, 1000 * Math.pow(2, retryAttempt)) + Math.floor(Math.random() * 300);
        retryAttempt += 1;
        reconnectTimer = window.setTimeout(connectWebSocket, delay);
      };
    };

    fetchMessages();
    connectWebSocket();

    const onOnline = () => {
      fetchMessages();
      flushOfflineQueue();
    };
    window.addEventListener('online', onOnline);

    return () => {
      isMounted = false;
      clearHeartbeat();
      window.removeEventListener('online', onOnline);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [fetchMessages, flushOfflineQueue]);

  // 1-second ticker to enforce strict 30-minute client-side TTL expiration & countdown updates
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      setNowTick(now);
      setMessages((prev) => {
        const cutoff = now - TTL_MS;
        const hasExpired = prev.some((m) => m.timestamp < cutoff);
        if (!hasExpired) return prev;
        return prev.filter((m) => m.timestamp >= cutoff);
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Periodic fallback sync every 10 seconds
  useEffect(() => {
    const syncTimer = window.setInterval(() => {
      fetchMessages();
    }, 10000);
    return () => window.clearInterval(syncTimer);
  }, [fetchMessages]);

  // Smart auto-scroll when new messages arrive
  const prevLenRef = useRef<number>(0);
  useEffect(() => {
    if (messages.length > prevLenRef.current && isNearBottomRef.current) {
      bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevLenRef.current = messages.length;
  }, [messages.length]);

  const sendMessage = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || isSending) return;

    const now = Date.now();
    const msgId = `MSG-${now}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
    const optimisticMsg: PublicMessage = {
      id: msgId,
      content: text,
      timestamp: now,
      expiresAt: now + TTL_MS,
      pending: true,
    };

    isNearBottomRef.current = true;
    setMessages((prev) => filterValidMessages([...prev, optimisticMsg], now));
    broadcastChannelRef.current?.postMessage({
      type: 'message:created',
      message: optimisticMsg,
    });
    setIsSending(true);

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: msgId,
          content: text,
        }),
      });
      const data = await res.json();
      if (res.ok && data && data.ok && data.message) {
        const confirmed: PublicMessage = { ...data.message, pending: false };
        setMessages((prev) =>
          filterValidMessages(
            prev.map((m) => (m.id === msgId ? confirmed : m)),
            Date.now()
          )
        );
        broadcastChannelRef.current?.postMessage({
          type: 'message:created',
          message: confirmed,
        });
      } else {
        offlineQueueRef.current.push(optimisticMsg);
      }
    } catch {
      offlineQueueRef.current.push(optimisticMsg);
    } finally {
      setIsSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    const currentText = draft;
    setDraft('');
    if (inputRef.current) {
      inputRef.current.style.height = '40px';
    }
    await sendMessage(currentText);
  };

  return (
    <div className="h-dvh w-full max-w-full flex flex-col overflow-hidden bg-zinc-950 text-zinc-100 select-text">
      {/* Single Shared Public Message Stream (Zero Header, Zero User IDs, Strict 30-Minute Ephemerality) */}
      <div
        ref={scrollContainerRef}
        onScroll={(e) => handleScroll(e.currentTarget)}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 sm:p-5 space-y-2"
      >
        {messages.map((msg) => {
          const remainingMs = Math.max(0, msg.timestamp + TTL_MS - nowTick);
          return (
            <div
              key={msg.id}
              className="px-3.5 py-2.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 text-sm text-zinc-100 break-words whitespace-pre-wrap flex items-start justify-between gap-3"
            >
              <div className="min-w-0 flex-1 leading-relaxed">{msg.content}</div>
              <span className="text-[11px] font-mono text-zinc-500 shrink-0 tabular-nums pt-0.5 select-none">
                {formatRemainingTtl(remainingMs)}
              </span>
            </div>
          );
        })}
        <div ref={bottomAnchorRef} />
      </div>

      {/* Minimal Bottom Text Input & Send Action */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 p-2.5 sm:p-3.5 border-t border-zinc-900 bg-zinc-950 flex items-end gap-2 w-full max-w-full"
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim() && !isSending) {
                const currentText = draft;
                setDraft('');
                if (inputRef.current) {
                  inputRef.current.style.height = '40px';
                }
                sendMessage(currentText);
              }
            }
          }}
          placeholder="Write a message..."
          maxLength={2000}
          autoComplete="off"
          className="min-w-0 flex-1 max-h-32 resize-none overflow-y-auto px-3.5 py-2 text-sm leading-relaxed bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
        />
        <button
          type="submit"
          disabled={!draft.trim() || isSending}
          className="px-4 py-2 text-sm font-medium bg-zinc-100 hover:bg-white disabled:opacity-40 text-zinc-950 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer select-none"
        >
          Send
        </button>
      </form>
    </div>
  );
}
