import React, { useState, useEffect, useRef, useCallback, memo } from 'react';

// Strict 30-Minute Ephemeral Message Lifetime (1,800,000 ms)
const TTL_MS = 30 * 60 * 1000;
const BROADCAST_CHANNEL_NAME = 'ephemeral_public_board_sync_v1';

export interface PublicMessage {
  id: string;
  content: string;
  timestamp: number;
  expiresAt?: number;
  pending?: boolean;
}

// Low-overhead remaining time formatter with zero memory reallocations
function formatRemainingTtl(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const sStr = seconds < 10 ? `0${seconds}` : `${seconds}`;
  return `${mStr}:${sStr}`;
}

// Memory-efficient deduplicator & TTL filter
function filterValidMessages(list: PublicMessage[], now: number): PublicMessage[] {
  const cutoff = now - TTL_MS;
  const byId = new Map<string, PublicMessage>();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
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

// High-performance micro-ticker that pauses when page is backgrounded to save CPU and battery on older hardware
type TickListener = (now: number) => void;
class MicroTicker {
  private listeners = new Set<TickListener>();
  private intervalId: number | null = null;

  subscribe(listener: TickListener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  private start() {
    if (this.intervalId !== null || typeof window === 'undefined') return;
    this.intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return; // Suspend ticking while phone screen is off or tab is in background
      }
      const now = Date.now();
      this.listeners.forEach((fn) => fn(now));
    }, 1000);
  }

  private stop() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
const globalTicker = new MicroTicker();

// Isolated Countdown Badge: Only updates this isolated span every second, preventing the entire message bubble or parent list from re-rendering
interface CountdownBadgeProps {
  timestamp: number;
  pending?: boolean;
}

const CountdownBadge = memo(function CountdownBadge({ timestamp, pending }: CountdownBadgeProps) {
  const [displayTtl, setDisplayTtl] = useState<string>(() =>
    formatRemainingTtl(Math.max(0, timestamp + TTL_MS - Date.now()))
  );

  useEffect(() => {
    const updateCountdown = (now: number) => {
      const remainingMs = Math.max(0, timestamp + TTL_MS - now);
      const formatted = formatRemainingTtl(remainingMs);
      setDisplayTtl((prev) => (prev === formatted ? prev : formatted));
    };

    updateCountdown(Date.now());
    const unsubscribe = globalTicker.subscribe(updateCountdown);
    return unsubscribe;
  }, [timestamp]);

  return (
    <span
      className={`text-[11px] font-mono shrink-0 tabular-nums pt-0.5 select-none ${
        pending ? 'text-zinc-600' : 'text-zinc-500'
      }`}
    >
      {displayTtl}
    </span>
  );
});

// Fast, ReDoS-safe URL pattern matching http(s):// and www. domains
const URL_REGEX = /(https?:\/\/[^\s<>"'{}|\\^`]+|www\.[^\s<>"'{}|\\^`]+)/gi;

// Highly optimized inline URL renderer for zero-lag performance on weak devices
function renderFormattedMessage(
  text: string,
  onUrlClick: (url: string) => void
): React.ReactNode {
  if (!text) return null;
  // Fast bail-out for messages without links (skips regex execution)
  if (!text.includes('http') && !text.includes('www.')) {
    return text;
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(URL_REGEX);

  while ((match = regex.exec(text)) !== null) {
    const fullMatch = match[0];
    const matchIndex = match.index;

    // Plain text before the link
    if (matchIndex > lastIndex) {
      parts.push(text.slice(lastIndex, matchIndex));
    }

    // Strip trailing punctuation like ., !, ), etc. to avoid broken links
    let linkUrl = fullMatch;
    let trailingPunctuation = '';
    while (linkUrl.length > 0 && /[,.!?;:)]$/.test(linkUrl)) {
      trailingPunctuation = linkUrl.slice(-1) + trailingPunctuation;
      linkUrl = linkUrl.slice(0, -1);
    }

    const targetUrl =
      linkUrl.startsWith('http://') || linkUrl.startsWith('https://')
        ? linkUrl
        : `https://${linkUrl}`;

    parts.push(
      <button
        key={matchIndex}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUrlClick(targetUrl);
        }}
        className="text-sky-400 hover:text-sky-300 active:text-sky-200 underline underline-offset-2 break-all font-medium transition-colors cursor-pointer inline text-left p-0 bg-transparent border-0"
      >
        {linkUrl}
      </button>
    );

    if (trailingPunctuation) {
      parts.push(trailingPunctuation);
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  // Plain text following the final link
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

// Memoized Message Row with CSS containment for 60fps scrolling on weak mobile GPUs
interface MessageRowProps {
  msg: PublicMessage;
  onUrlClick: (url: string) => void;
}

const MessageRow = memo(
  function MessageRow({ msg, onUrlClick }: MessageRowProps) {
    return (
      <div className="message-bubble-contain px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-zinc-900/90 border border-zinc-800/80 text-[15px] sm:text-sm text-zinc-100 break-words whitespace-pre-wrap flex items-start justify-between gap-3 transition-opacity duration-150">
        <div className="min-w-0 flex-1 leading-relaxed break-words select-text">
          {renderFormattedMessage(msg.content, onUrlClick)}
        </div>
        <CountdownBadge timestamp={msg.timestamp} pending={msg.pending} />
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.pending === next.msg.pending &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.onUrlClick === next.onUrlClick
);

export default function App() {
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [viewportStyle, setViewportStyle] = useState<React.CSSProperties>({});
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  const handleUrlClick = useCallback((url: string) => {
    setPendingLink(url);
  }, []);

  // Keyboard escape listener to dismiss redirect modal
  useEffect(() => {
    if (!pendingLink) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingLink(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingLink]);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const wsRef = useRef<WebSocket | null>(null);
  const offlineQueueRef = useRef<PublicMessage[]>([]);
  const isFlushingRef = useRef<boolean>(false);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const ackTimeoutsRef = useRef<Map<string, number>>(new Map());

  // Throttling references for high-rate scroll and resize events
  const scrollRafRef = useRef<number | null>(null);
  const vpRafRef = useRef<number | null>(null);

  // Enforce blank title ("ㅤ")
  useEffect(() => {
    document.title = 'ㅤ';
  }, []);

  // Instant scroll to bottom helper (avoids laggy smooth-scroll animation queues on rapid messages)
  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Track scroll position throttled by requestAnimationFrame to prevent scroll jank
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      isNearBottomRef.current = distanceFromBottom <= 120;
    });
  }, []);

  // Adapt dynamically to mobile browser bottom bars & virtual keyboards throttled with requestAnimationFrame
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const performViewportUpdate = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }

      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      const fallbackHeight =
        (typeof window !== 'undefined' ? window.innerHeight : 0) ||
        (typeof document !== 'undefined' ? document.documentElement?.clientHeight : 0) ||
        600;

      const rawHeight =
        vv && typeof vv.height === 'number' && !isNaN(vv.height) && vv.height > 0
          ? vv.height
          : fallbackHeight;
      const safeHeight = Math.max(160, Math.round(rawHeight));

      const rawTop =
        vv && typeof vv.offsetTop === 'number' && !isNaN(vv.offsetTop)
          ? vv.offsetTop
          : 0;
      const safeTop = Math.max(0, Math.round(rawTop));

      setViewportStyle((prev) => {
        const nextH = `${safeHeight}px`;
        const nextT = `${safeTop}px`;
        if (prev.height === nextH && prev.top === nextT) return prev;
        return {
          position: 'fixed',
          top: nextT,
          left: '0px',
          right: '0px',
          bottom: 'auto',
          height: nextH,
        };
      });

      if (isNearBottomRef.current) {
        requestAnimationFrame(() => {
          scrollToBottomInstant();
        });
      }
    };

    const updateViewportBounds = () => {
      if (vpRafRef.current !== null) return;
      vpRafRef.current = requestAnimationFrame(() => {
        vpRafRef.current = null;
        performViewportUpdate();
      });
    };

    updateViewportBounds();

    // Multi-stage sync during initial navigation so keyboard dismiss/keep-open transitions after URL bar Enter are always caught
    const syncDelays = [30, 100, 250, 500, 900, 1500];
    const timers = syncDelays.map((ms) => window.setTimeout(updateViewportBounds, ms));

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', updateViewportBounds, { passive: true });
      vv.addEventListener('scroll', updateViewportBounds, { passive: true });
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
      resizeObserver = new ResizeObserver(updateViewportBounds);
      resizeObserver.observe(document.documentElement);
    }

    window.addEventListener('resize', updateViewportBounds, { passive: true });
    window.addEventListener('orientationchange', updateViewportBounds, { passive: true });
    window.addEventListener('pageshow', updateViewportBounds, { passive: true });
    window.addEventListener('focus', updateViewportBounds, { passive: true });
    document.addEventListener('focusin', updateViewportBounds, { passive: true });
    document.addEventListener('focusout', updateViewportBounds, { passive: true });

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      if (vpRafRef.current !== null) {
        cancelAnimationFrame(vpRafRef.current);
      }
      if (vv) {
        vv.removeEventListener('resize', updateViewportBounds);
        vv.removeEventListener('scroll', updateViewportBounds);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      window.removeEventListener('resize', updateViewportBounds);
      window.removeEventListener('orientationchange', updateViewportBounds);
      window.removeEventListener('pageshow', updateViewportBounds);
      window.removeEventListener('focus', updateViewportBounds);
      document.removeEventListener('focusin', updateViewportBounds);
      document.removeEventListener('focusout', updateViewportBounds);
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

    for (let i = 0; i < queueSnapshot.length; i++) {
      const item = queueSnapshot[i];
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
    try {
      const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      broadcastChannelRef.current = bc;

      bc.onmessage = (event) => {
        try {
          const payload = event.data;
          if (!payload || typeof payload !== 'object') return;
          if (payload.type === 'message:created' && payload.message) {
            const now = Date.now();
            setMessages((prev) => filterValidMessages([...prev, payload.message], now));
          }
        } catch {
          // Ignore event parse errors
        }
      };

      return () => {
        try {
          bc.close();
        } catch {
          // Ignore close error
        }
        broadcastChannelRef.current = null;
      };
    } catch {
      // In-app browsers or restricted contexts may throw SecurityError
      broadcastChannelRef.current = null;
    }
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

      try {
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
              try {
                broadcastChannelRef.current?.postMessage({
                  type: 'message:created',
                  message: incoming,
                });
              } catch {
                // Ignore BroadcastChannel errors
              }
            } else if (data.type === 'messages:sync' && Array.isArray(data.messages)) {
              for (let i = 0; i < data.messages.length; i++) {
                const srvMsg = data.messages[i];
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

        ws.onerror = () => {
          // Gracefully handled by onclose fallback
        };
      } catch {
        // WebSocket constructor can throw SecurityError in restricted WebViews; fall back safely
        if (!isMounted) return;
        const delay = Math.min(5000, 1000 * Math.pow(1.5, retryAttempt));
        retryAttempt += 1;
        reconnectTimer = window.setTimeout(connectWebSocket, delay);
      }
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

  // Low-frequency TTL expiration cleaner (runs every 10 seconds, zero CPU cost, never re-renders if no message expired)
  useEffect(() => {
    const purgeInterval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const cutoff = Date.now() - TTL_MS;
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const hasExpired = prev.some((m) => m.timestamp < cutoff);
        if (!hasExpired) return prev;
        return prev.filter((m) => m.timestamp >= cutoff);
      });
    }, 10000);
    return () => window.clearInterval(purgeInterval);
  }, []);

  // Periodic background fallback sync every 20 seconds (pauses when hidden)
  useEffect(() => {
    const syncTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fetchMessages();
    }, 20000);
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
      try {
        broadcastChannelRef.current?.postMessage({
          type: 'message:created',
          message: optimisticMsg,
        });
      } catch {
        // Ignore BroadcastChannel errors in restricted contexts
      }

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
      style={viewportStyle}
      className="fixed inset-x-0 top-0 bottom-0 w-full max-w-full flex flex-col items-center overflow-hidden bg-zinc-950 text-zinc-100 select-text gpu-accelerated"
    >
      {/* Single Shared Public Message Stream with content-visibility containment */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 w-full max-w-4xl overflow-y-auto overflow-x-hidden touch-scroll px-3 py-3 sm:px-6 sm:py-5 space-y-2 will-change-scroll"
      >
        {messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} onUrlClick={handleUrlClick} />
        ))}
      </div>

      {/* Minimal Bottom Composer */}
      <div className="shrink-0 min-h-[58px] w-full border-t border-zinc-800/90 bg-zinc-950 flex justify-center pb-[max(0.5rem,env(safe-area-inset-bottom))] relative z-30">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-4xl px-2.5 pt-2.5 pb-1 sm:px-6 sm:py-3 flex items-end gap-2"
        >
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
            className="min-w-0 flex-1 max-h-36 resize-none overflow-y-auto px-3.5 py-2.5 sm:py-2 text-base sm:text-sm leading-relaxed bg-zinc-900 border border-zinc-700/90 rounded-xl text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            onMouseDown={(e) => e.preventDefault()}
            className="h-[42px] sm:h-[40px] px-4 sm:px-5 text-sm font-semibold bg-zinc-100 hover:bg-white active:scale-[0.98] disabled:bg-zinc-800 disabled:text-zinc-400 disabled:border disabled:border-zinc-700 text-zinc-950 rounded-xl transition-all whitespace-nowrap shrink-0 cursor-pointer select-none"
          >
            Send
          </button>
        </form>
      </div>

      {/* 100% English External Link Confirmation Modal */}
      {pendingLink && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="external-link-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm select-none"
          onClick={() => setPendingLink(null)}
        >
          <div
            className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </div>
              <div>
                <h3
                  id="external-link-dialog-title"
                  className="text-base sm:text-lg font-semibold text-zinc-100 leading-tight"
                >
                  External Link Warning
                </h3>
                <p className="text-xs text-zinc-400">
                  You are about to leave this page
                </p>
              </div>
            </div>

            <p className="text-xs sm:text-sm text-zinc-300 mb-2 leading-relaxed">
              Do you want to proceed and open this external website?
            </p>

            {/* Destination URL Display */}
            <div className="p-3 mb-3 rounded-xl bg-zinc-950 border border-zinc-800/90 font-mono text-xs text-sky-400 break-all select-all">
              {pendingLink}
            </div>

            <p className="text-[11px] text-zinc-500 mb-5 leading-normal">
              Always verify the URL before continuing. We are not responsible for the content or security of third-party websites.
            </p>

            {/* Action Buttons in 100% English */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPendingLink(null)}
                className="flex-1 py-2.5 px-4 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-750 active:scale-[0.98] text-sm font-medium text-zinc-200 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const urlToOpen = pendingLink;
                  setPendingLink(null);
                  if (urlToOpen) {
                    window.open(urlToOpen, '_blank', 'noopener,noreferrer');
                  }
                }}
                className="flex-1 py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 active:scale-[0.98] text-sm font-medium text-white shadow-lg shadow-sky-950/50 transition-all cursor-pointer"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
