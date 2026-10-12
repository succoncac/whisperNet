import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { PWAInstallButton } from './PWAInstallButton';

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
  const byId = new Map<string, PublicMessage>();

  for (const item of list) {
    if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') continue;
    if (item.timestamp < cutoff) continue;
    const existing = byId.get(item.id);
    // Prefer confirmed server copy over optimistic pending copy
    if (!existing || (existing.pending && !item.pending)) {
      byId.set(item.id, item);
    }
  }

  const valid = Array.from(byId.values());
  valid.sort((a, b) => a.timestamp - b.timestamp);
  return valid;
}

interface MessageRowProps {
  msg: PublicMessage;
  nowTick: number;
}

const MessageRow = memo(function MessageRow({ msg, nowTick }: MessageRowProps) {
  const remainingMs = Math.max(0, msg.timestamp + TTL_MS - nowTick);
  return (
    <div className="px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-zinc-900/90 border border-zinc-800/80 text-[15px] sm:text-sm text-zinc-100 break-words whitespace-pre-wrap flex items-start justify-between gap-3 transition-opacity duration-150">
      <div className="min-w-0 flex-1 leading-relaxed break-words select-text">{msg.content}</div>
      <span
        className={`text-[11px] font-mono shrink-0 tabular-nums pt-0.5 select-none ${
          msg.pending ? 'text-zinc-600' : 'text-zinc-500'
        }`}
      >
        {formatRemainingTtl(remainingMs)}
      </span>
    </div>
  );
});

export default function App() {
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const wsRef = useRef<WebSocket | null>(null);
  const offlineQueueRef = useRef<PublicMessage[]>([]);
  const isFlushingRef = useRef<boolean>(false);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const ackTimeoutsRef = useRef<Map<string, number>>(new Map());

  // Enforce blank title ("ㅤ") and client-side HTTP -> HTTPS upgrade
  useEffect(() => {
    document.title = 'ㅤ';
    if (typeof window !== 'undefined') {
      const h = window.location.hostname;
      const isLocal =
        h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
      if (!isLocal && window.location.protocol === 'http:') {
        window.location.replace(
          `https://${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
        );
      }
    }
  }, []);

  // Instant scroll to bottom helper (avoids laggy smooth-scroll animation queues on rapid messages)
  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Track whether user is near bottom of the stream
  const handleScroll = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= 120;
  }, []);

  // Adapt dynamically to mobile virtual keyboards (iOS Safari / Android Chrome visualViewport)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;

    const handleViewportChange = () => {
      setViewportHeight(vv.height);
      if (isNearBottomRef.current) {
        requestAnimationFrame(() => {
          scrollToBottomInstant();
        });
      }
    };

    vv.addEventListener('resize', handleViewportChange);
    vv.addEventListener('scroll', handleViewportChange);
    return () => {
      vv.removeEventListener('resize', handleViewportChange);
      vv.removeEventListener('scroll', handleViewportChange);
    };
  }, [scrollToBottomInstant]);

  // Auto-resize textarea cleanly across mobile, tablet, and desktop
  const syncTextareaHeight = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, 144);
    el.style.height = `${Math.max(42, nextHeight)}px`;
  }, []);

  useEffect(() => {
    syncTextareaHeight(inputRef.current);
  }, [draft, syncTextareaHeight]);

  // Clear pending ACK fallback timer when a message is confirmed
  const clearAckTimer = useCallback((id: string) => {
    const timer = ackTimeoutsRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      ackTimeoutsRef.current.delete(id);
    }
  }, []);

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

  // Send a single message over HTTP POST fallback and reconcile state
  const postMessageHttp = useCallback(
    async (msg: PublicMessage): Promise<boolean> => {
      try {
        const res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: msg.id, content: msg.content }),
        });
        const data = await res.json();
        if (res.ok && data && data.ok && data.message) {
          clearAckTimer(msg.id);
          const confirmed: PublicMessage = { ...data.message, pending: false };
          setMessages((prev) => filterValidMessages([...prev, confirmed], Date.now()));
          broadcastChannelRef.current?.postMessage({
            type: 'message:created',
            message: confirmed,
          });
          return true;
        }
      } catch {
        // Network error
      }
      return false;
    },
    [clearAckTimer]
  );

  // Flush queued messages automatically on reconnection via active WebSocket or HTTP
  const flushOfflineQueue = useCallback(async () => {
    if (isFlushingRef.current || offlineQueueRef.current.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    isFlushingRef.current = true;
    const queueSnapshot = [...offlineQueueRef.current];
    const remaining: PublicMessage[] = [];

    for (const item of queueSnapshot) {
      if (Date.now() - item.timestamp >= TTL_MS) continue;

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(
            JSON.stringify({
              type: 'message:send',
              id: item.id,
              content: item.content,
            })
          );
          continue;
        } catch {
          // Fall through to HTTP fallback
        }
      }

      const ok = await postMessageHttp(item);
      if (!ok) {
        remaining.push(item);
      }
    }

    offlineQueueRef.current = remaining;
    isFlushingRef.current = false;
  }, [postMessageHttp]);

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

  // Real-time WebSocket stream with sub-second fast reconnect & visibility recovery
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
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

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
        }, 15000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));
          const now = Date.now();

          if (
            (data.type === 'message:created' || data.type === 'message:ack') &&
            data.message
          ) {
            clearAckTimer(data.message.id);
            const incoming: PublicMessage = { ...data.message, pending: false };
            setMessages((prev) => filterValidMessages([...prev, incoming], now));
            broadcastChannelRef.current?.postMessage({
              type: 'message:created',
              message: incoming,
            });
          } else if (data.type === 'messages:sync' && Array.isArray(data.messages)) {
            for (const srvMsg of data.messages) {
              if (srvMsg && srvMsg.id) clearAckTimer(srvMsg.id);
            }
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
        const delay =
          Math.min(4000, 300 * Math.pow(1.6, retryAttempt)) + Math.floor(Math.random() * 150);
        retryAttempt += 1;
        reconnectTimer = window.setTimeout(connectWebSocket, delay);
      };
    };

    fetchMessages();
    connectWebSocket();

    const onOnline = () => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
      fetchMessages();
      flushOfflineQueue();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connectWebSocket();
        }
        fetchMessages();
      }
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isMounted = false;
      clearHeartbeat();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [clearAckTimer, fetchMessages, flushOfflineQueue]);

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

  // Periodic background fallback sync every 15 seconds
  useEffect(() => {
    const syncTimer = window.setInterval(() => {
      fetchMessages();
    }, 15000);
    return () => window.clearInterval(syncTimer);
  }, [fetchMessages]);

  // Instant auto-scroll when new messages arrive and user is near bottom
  const prevLenRef = useRef<number>(0);
  useEffect(() => {
    if (messages.length > prevLenRef.current && isNearBottomRef.current) {
      requestAnimationFrame(() => {
        scrollToBottomInstant();
      });
    }
    prevLenRef.current = messages.length;
  }, [messages.length, scrollToBottomInstant]);

  // Zero-Latency Non-Blocking Message Dispatch (WebSocket-First with automatic HTTP fallback)
  const dispatchMessage = useCallback(
    (rawText: string) => {
      const text = rawText.trim();
      if (!text) return;

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

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          // Send immediately over pre-warmed WebSocket frame (0ms connection overhead)
          ws.send(
            JSON.stringify({
              type: 'message:send',
              id: msgId,
              content: text,
            })
          );

          // Safety fallback: if server doesn't echo/ack within 1500ms, fire HTTP POST
          const fallbackTimer = window.setTimeout(async () => {
            ackTimeoutsRef.current.delete(msgId);
            const ok = await postMessageHttp(optimisticMsg);
            if (!ok) {
              offlineQueueRef.current.push(optimisticMsg);
            }
          }, 1500);
          ackTimeoutsRef.current.set(msgId, fallbackTimer);
          return;
        } catch {
          // Fall through to immediate HTTP POST if ws.send throws
        }
      }

      // Immediate HTTP fallback if WebSocket is not currently open
      void (async () => {
        const ok = await postMessageHttp(optimisticMsg);
        if (!ok) {
          offlineQueueRef.current.push(optimisticMsg);
        }
      })();
    },
    [postMessageHttp]
  );

  const submitCurrentDraft = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (inputRef.current) {
      inputRef.current.style.height = '42px';
      inputRef.current.focus();
    }
    dispatchMessage(text);
  }, [draft, dispatchMessage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitCurrentDraft();
  };

  return (
    <div
      style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
      className="h-dvh w-full max-w-full flex flex-col items-center overflow-hidden bg-zinc-950 text-zinc-100 select-text"
    >
      {/* Single Shared Public Message Stream (Responsive across Mobile, Tablet, Desktop, Ultrawide) */}
      <div
        ref={scrollContainerRef}
        onScroll={(e) => handleScroll(e.currentTarget)}
        className="flex-1 min-h-0 w-full max-w-4xl overflow-y-auto overflow-x-hidden touch-scroll px-3 py-3 sm:px-6 sm:py-5 space-y-2"
      >
        {messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} nowTick={nowTick} />
        ))}
      </div>

      {/* Minimal Bottom Composer + PWA Install Trigger */}
      <div className="shrink-0 w-full border-t border-zinc-900/90 bg-zinc-950/95 backdrop-blur-md flex justify-center pb-[env(safe-area-inset-bottom)]">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-4xl px-2.5 py-2.5 sm:px-6 sm:py-3.5 flex items-end gap-2"
        >
          <PWAInstallButton />
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCurrentDraft();
              }
            }}
            placeholder="Write a message..."
            maxLength={2000}
            autoComplete="off"
            enterKeyHint="send"
            className="min-w-0 flex-1 max-h-36 resize-none overflow-y-auto px-3.5 py-2.5 sm:py-2 text-base sm:text-sm leading-relaxed bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-[42px] sm:h-[40px] px-4 sm:px-5 text-sm font-medium bg-zinc-100 hover:bg-white active:scale-[0.98] disabled:opacity-40 text-zinc-950 rounded-xl transition-all whitespace-nowrap shrink-0 cursor-pointer select-none"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
