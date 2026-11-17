import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from 'react';

// Strict 30-Minute Ephemeral Message Lifetime (1,800,000 ms)
const TTL_MS = 30 * 60 * 1000;
const BROADCAST_CHANNEL_NAME = 'ephemeral_public_board_sync_v1';
const WINDOW_STEP = 80;

export interface PublicMessage {
  id: string;
  content: string;
  timestamp: number;
  expiresAt?: number;
  pending?: boolean;
}

// Low-overhead remaining time formatter with zero unnecessary allocations
function formatRemainingTtl(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const sStr = seconds < 10 ? `0${seconds}` : `${seconds}`;
  return `${mStr}:${sStr}`;
}

// Memory-efficient O(N) deduplicator & TTL filter
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

// O(N) reconciliation helper keeping unconfirmed optimistic messages not yet on server
function mergeServerMessages(
  prev: PublicMessage[],
  serverMessages: PublicMessage[],
  now: number
): PublicMessage[] {
  const serverIds = new Set<string>();
  for (let i = 0; i < serverMessages.length; i++) {
    const srv = serverMessages[i];
    if (srv && typeof srv.id === 'string') {
      serverIds.add(srv.id);
    }
  }

  const pendingOnly: PublicMessage[] = [];
  for (let i = 0; i < prev.length; i++) {
    const m = prev[i];
    if (m.pending && !serverIds.has(m.id)) {
      pendingOnly.push(m);
    }
  }

  return filterValidMessages([...serverMessages, ...pendingOnly], now);
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
        return; // Suspend ticking while screen is off or tab is backgrounded
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

// Isolated Countdown Badge: Only updates this isolated span every second, preventing parent list re-renders
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
    return globalTicker.subscribe(updateCountdown);
  }, [timestamp]);

  return (
    <span
      className={`text-[11px] font-mono shrink-0 tabular-nums pt-[3px] select-none transition-colors duration-150 ${
        pending ? 'text-zinc-500' : 'text-zinc-500/90'
      }`}
    >
      {pending ? `Sending · ${displayTtl}` : displayTtl}
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
  const lower = text.toLowerCase();
  if (!lower.includes('http') && !lower.includes('www.')) {
    return text;
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(URL_REGEX);

  while ((match = regex.exec(text)) !== null) {
    const fullMatch = match[0];
    const matchIndex = match.index;

    if (matchIndex > lastIndex) {
      parts.push(text.slice(lastIndex, matchIndex));
    }

    let linkUrl = fullMatch;
    let trailingPunctuation = '';
    while (linkUrl.length > 0 && /[,.!?;:)]$/.test(linkUrl)) {
      trailingPunctuation = linkUrl.slice(-1) + trailingPunctuation;
      linkUrl = linkUrl.slice(0, -1);
    }

    const lowerLink = linkUrl.toLowerCase();
    const targetUrl =
      lowerLink.startsWith('http://') || lowerLink.startsWith('https://')
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
        className="text-sky-400 hover:text-sky-300 active:text-sky-200 underline decoration-sky-400/50 hover:decoration-sky-300 underline-offset-[3px] break-all font-medium transition-colors duration-150 cursor-pointer inline text-left p-0 bg-transparent border-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 rounded-sm"
      >
        {linkUrl}
      </button>
    );

    if (trailingPunctuation) {
      parts.push(trailingPunctuation);
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

// Memoized Message Row with CSS containment and optical dark-mode typography
interface MessageRowProps {
  msg: PublicMessage;
  onUrlClick: (url: string) => void;
}

const MessageRow = memo(
  function MessageRow({ msg, onUrlClick }: MessageRowProps) {
    return (
      <div
        className={`message-bubble-contain animate-msg-enter px-4 py-3 rounded-2xl bg-zinc-900/75 border border-white/[0.06] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.035)] text-[15px] sm:text-[14.5px] text-zinc-100 break-words whitespace-pre-wrap flex items-start justify-between gap-3.5 transition-opacity duration-150 ${
          msg.pending ? 'opacity-80' : 'opacity-100'
        }`}
      >
        <div className="min-w-0 flex-1 leading-[1.6] tracking-[0.005em] break-words select-text">
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
  const [hasLoadedOnce, setHasLoadedOnce] = useState<boolean>(false);
  const [visibleCount, setVisibleCount] = useState<number>(WINDOW_STEP);
  const [draft, setDraft] = useState<string>('');
  const [viewportStyle, setViewportStyle] = useState<React.CSSProperties>({});
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isOffline, setIsOffline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine === false : false
  );

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

  // Performance refs to avoid redundant reflows and O(N^2) queue scans
  const scrollRafRef = useRef<number | null>(null);
  const vpRafRef = useRef<number | null>(null);
  const prevDraftLenRef = useRef<number>(0);
  const scrollRestoreRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const messagesCountRef = useRef<number>(0);
  const visibleCountRef = useRef<number>(WINDOW_STEP);

  messagesCountRef.current = messages.length;
  visibleCountRef.current = visibleCount;

  // Enforce blank title ("ㅤ")
  useEffect(() => {
    document.title = 'ㅤ';
  }, []);

  // Deduplicated offline queue insertion
  const enqueueOfflineMessage = useCallback((msg: PublicMessage) => {
    const q = offlineQueueRef.current;
    for (let i = 0; i < q.length; i++) {
      if (q[i].id === msg.id) return;
    }
    q.push(msg);
  }, []);

  // Instant scroll to bottom helper (avoids smooth-scroll animation queues on rapid bursts)
  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Smooth scroll to bottom when user clicks the floating jump button
  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = true;
    setShowScrollBottom(false);
    setUnreadCount(0);
    try {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth',
      });
    } catch {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Expand visible DOM window upward while preserving exact scroll position
  const loadEarlierMessages = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) {
      scrollRestoreRef.current = {
        prevHeight: el.scrollHeight,
        prevTop: el.scrollTop,
      };
    }
    setVisibleCount((prev) => prev + WINDOW_STEP);
  }, []);

  useLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    if (!restore) return;
    scrollRestoreRef.current = null;
    const el = scrollContainerRef.current;
    if (!el) return;
    const heightDelta = el.scrollHeight - restore.prevHeight;
    if (heightDelta > 0) {
      el.scrollTop = restore.prevTop + heightDelta;
    }
  }, [visibleCount]);

  // Track scroll position throttled by requestAnimationFrame for 60fps scrolling
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;

      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const isNear = distanceFromBottom <= 120;
      isNearBottomRef.current = isNear;

      const shouldShow = distanceFromBottom > 160;
      setShowScrollBottom((prev) => (prev !== shouldShow ? shouldShow : prev));
      if (isNear) {
        setUnreadCount((prev) => (prev !== 0 ? 0 : 0));
      }

      // Automatically reveal earlier messages when scrolling near the top
      if (el.scrollTop <= 80 && messagesCountRef.current > visibleCountRef.current) {
        loadEarlierMessages();
      }
    });
  }, [loadEarlierMessages]);

  // Adapt dynamically to mobile browser bottom bars & virtual keyboards throttled with requestAnimationFrame
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const performViewportUpdate = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }

      const vv = window.visualViewport;
      const fallbackHeight =
        window.innerHeight || document.documentElement?.clientHeight || 600;

      const rawHeight =
        vv && typeof vv.height === 'number' && !Number.isNaN(vv.height) && vv.height > 0
          ? vv.height
          : fallbackHeight;
      const safeHeight = Math.max(160, Math.round(rawHeight));

      const rawTop =
        vv && typeof vv.offsetTop === 'number' && !Number.isNaN(vv.offsetTop)
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

    const syncDelays = [50, 180, 450, 1000];
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
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (vpRafRef.current !== null) cancelAnimationFrame(vpRafRef.current);
      if (vv) {
        vv.removeEventListener('resize', updateViewportBounds);
        vv.removeEventListener('scroll', updateViewportBounds);
      }
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', updateViewportBounds);
      window.removeEventListener('orientationchange', updateViewportBounds);
      window.removeEventListener('pageshow', updateViewportBounds);
      window.removeEventListener('focus', updateViewportBounds);
      document.removeEventListener('focusin', updateViewportBounds);
      document.removeEventListener('focusout', updateViewportBounds);
    };
  }, [scrollToBottomInstant]);

  // Layout-thrash-free textarea auto-resize (skips forced height='auto' reflow while growing)
  const syncTextareaHeight = useCallback(
    (el: HTMLTextAreaElement | null, currentText: string) => {
      if (!el) return;
      const len = currentText.length;
      if (len === 0) {
        if (el.style.height !== '40px') {
          el.style.height = '40px';
        }
        prevDraftLenRef.current = 0;
        return;
      }

      if (len < prevDraftLenRef.current) {
        el.style.height = 'auto';
      }
      const nextHeight = Math.min(el.scrollHeight, 144);
      const clamped = `${Math.max(40, nextHeight)}px`;
      if (el.style.height !== clamped) {
        el.style.height = clamped;
      }
      prevDraftLenRef.current = len;
    },
    []
  );

  useEffect(() => {
    syncTextareaHeight(inputRef.current, draft);
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
        setMessages((prev) => mergeServerMessages(prev, data.messages, now));
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setHasLoadedOnce(true);
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
          try {
            broadcastChannelRef.current?.postMessage({
              type: 'message:created',
              message: confirmed,
            });
          } catch {
            // Ignore BroadcastChannel errors
          }
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
          setIsOffline(false);
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
              setHasLoadedOnce(true);
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
              setMessages((prev) => mergeServerMessages(prev, data.messages, now));
              setHasLoadedOnce(true);
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
          // Handled cleanly by onclose
        };
      } catch {
        if (!isMounted) return;
        const delay = Math.min(5000, 1000 * Math.pow(1.5, retryAttempt));
        retryAttempt += 1;
        reconnectTimer = window.setTimeout(connectWebSocket, delay);
      }
    };

    fetchMessages();
    connectWebSocket();

    const onOnline = () => {
      setIsOffline(false);
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
      fetchMessages();
      flushOfflineQueue();
    };

    const onOffline = () => {
      setIsOffline(true);
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
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isMounted = false;
      clearHeartbeat();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [clearAckTimer, fetchMessages, flushOfflineQueue]);

  // Low-frequency TTL expiration cleaner (runs every 10s, skips when hidden or empty)
  useEffect(() => {
    const purgeInterval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const cutoff = Date.now() - TTL_MS;
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        let hasExpired = false;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].timestamp < cutoff) {
            hasExpired = true;
            break;
          }
        }
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

  // Auto-scroll when new messages arrive or track unread count when scrolled up
  const prevLenRef = useRef<number>(0);
  useEffect(() => {
    if (messages.length > prevLenRef.current) {
      if (isNearBottomRef.current) {
        requestAnimationFrame(() => {
          scrollToBottomInstant();
        });
        setUnreadCount(0);
      } else {
        const added = messages.length - prevLenRef.current;
        setUnreadCount((prev) => prev + added);
      }
    }
    prevLenRef.current = messages.length;
  }, [messages.length, scrollToBottomInstant]);

  // Zero-Latency Non-Blocking Message Dispatch (WebSocket-First with HTTP fallback)
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
      setShowScrollBottom(false);
      setUnreadCount(0);
      setMessages((prev) => filterValidMessages([...prev, optimisticMsg], now));
      requestAnimationFrame(() => {
        scrollToBottomInstant();
      });

      try {
        broadcastChannelRef.current?.postMessage({
          type: 'message:created',
          message: optimisticMsg,
        });
      } catch {
        // Ignore BroadcastChannel errors
      }

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(
            JSON.stringify({
              type: 'message:send',
              id: msgId,
              content: text,
            })
          );

          const fallbackTimer = window.setTimeout(async () => {
            ackTimeoutsRef.current.delete(msgId);
            const ok = await postMessageHttp(optimisticMsg);
            if (!ok) {
              enqueueOfflineMessage(optimisticMsg);
            }
          }, 1500);
          ackTimeoutsRef.current.set(msgId, fallbackTimer);
          return;
        } catch {
          // Fall through to HTTP POST
        }
      }

      void (async () => {
        const ok = await postMessageHttp(optimisticMsg);
        if (!ok) {
          enqueueOfflineMessage(optimisticMsg);
        }
      })();
    },
    [enqueueOfflineMessage, postMessageHttp, scrollToBottomInstant]
  );

  const submitCurrentDraft = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (inputRef.current) {
      inputRef.current.style.height = '40px';
      inputRef.current.focus();
    }
    dispatchMessage(text);
  }, [draft, dispatchMessage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitCurrentDraft();
  };

  // Progressive DOM windowing: keeps DOM lightweight on older devices while retaining full RAM history
  const hiddenEarlierCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages =
    hiddenEarlierCount > 0 ? messages.slice(hiddenEarlierCount) : messages;

  return (
    <div
      style={viewportStyle}
      className="fixed inset-x-0 top-0 bottom-0 w-full max-w-full flex flex-col items-center overflow-hidden bg-zinc-950 text-zinc-100 select-text gpu-accelerated relative"
    >
      {/* Subtle GPU-free top ambient surface sheen */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-44 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.03),transparent_70%)]"
      />

      {/* Shared Public Anonymous Stream */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="relative z-10 flex-1 min-h-0 w-full max-w-3xl overflow-y-auto overflow-x-hidden touch-scroll px-3.5 py-4 sm:px-6 sm:py-6 space-y-2.5 flex flex-col"
      >
        {hiddenEarlierCount > 0 && (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              onClick={loadEarlierMessages}
              className="min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/80 transition-colors cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-zinc-500"
            >
              Load earlier ({hiddenEarlierCount} older)
            </button>
          </div>
        )}

        {hasLoadedOnce && messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 select-none">
            <p className="text-sm font-medium text-zinc-400">
              Messages disappear after 30 minutes
            </p>
            <p className="text-xs text-zinc-600 mt-1">
              Write anonymously below
            </p>
          </div>
        ) : (
          visibleMessages.map((msg) => (
            <MessageRow key={msg.id} msg={msg} onUrlClick={handleUrlClick} />
          ))
        )}
      </div>

      {/* Floating Quick Scroll to Bottom Button (Compositor-only, zero backdrop-blur lag) */}
      <div
        className={`absolute right-3.5 sm:right-6 bottom-[78px] sm:bottom-[86px] z-40 transition-all duration-150 ease-out transform ${
          showScrollBottom
            ? 'opacity-100 translate-y-0 pointer-events-auto scale-100'
            : 'opacity-0 translate-y-2.5 pointer-events-none scale-95'
        }`}
      >
        <button
          type="button"
          onClick={scrollToBottomSmooth}
          aria-label="Scroll to newest messages"
          className="min-h-[40px] flex items-center gap-2 px-3.5 py-2 rounded-full bg-zinc-900/95 hover:bg-zinc-800 active:scale-[0.97] border border-white/[0.1] text-zinc-200 shadow-2xl transition-all duration-150 text-xs font-medium cursor-pointer select-none group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
        >
          {unreadCount > 0 ? (
            <span className="font-mono tabular-nums font-semibold text-sky-400">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
          <span className="text-zinc-200 group-hover:text-white transition-colors">
            {unreadCount > 0 ? 'New' : 'Latest'}
          </span>
          <svg
            aria-hidden="true"
            className="w-3.5 h-3.5 text-zinc-400 group-hover:text-zinc-100 transition-transform duration-150 group-hover:translate-y-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.25}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      </div>

      {/* Minimal Bottom Composer Dock */}
      <div className="shrink-0 w-full bg-gradient-to-t from-zinc-950 via-zinc-950/95 to-transparent flex flex-col items-center pt-1.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] relative z-30">
        {isOffline && (
          <p className="text-[11px] text-zinc-500 pb-1.5 select-none">
            Offline — queued messages will send automatically
          </p>
        )}
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-3xl px-3 sm:px-6"
        >
          <div className="flex items-end gap-2 p-1.5 pl-3.5 rounded-2xl bg-zinc-900/85 border border-white/[0.08] focus-within:border-white/[0.2] shadow-[0_8px_32px_rgba(0,0,0,0.45)] transition-colors duration-150">
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
              className="min-w-0 flex-1 min-h-[40px] max-h-36 resize-none overflow-y-auto py-2 text-base sm:text-[14.5px] leading-relaxed bg-transparent text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              onMouseDown={(e) => e.preventDefault()}
              className="min-h-[40px] min-w-[68px] px-4 text-[13.5px] font-semibold bg-zinc-100 hover:bg-white active:scale-[0.97] disabled:bg-zinc-800/80 disabled:text-zinc-500 text-zinc-950 rounded-xl transition-all duration-150 whitespace-nowrap shrink-0 cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
            >
              Send
            </button>
          </div>
        </form>
      </div>

      {/* 100% English External Link Confirmation Modal */}
      {pendingLink && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="external-link-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 select-none"
          onClick={() => setPendingLink(null)}
        >
          <div
            className="w-full max-w-md bg-zinc-900 border border-white/[0.09] rounded-2xl p-5 sm:p-6 shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3.5">
              <div className="w-10 h-10 rounded-full bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
                <svg
                  aria-hidden="true"
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
                <p className="text-xs text-zinc-400 mt-0.5">
                  You are about to leave this page
                </p>
              </div>
            </div>

            <p className="text-xs sm:text-sm text-zinc-300 mb-2.5 leading-relaxed">
              Do you want to proceed and open this external website?
            </p>

            {/* Destination URL Display */}
            <div className="p-3 mb-3 rounded-xl bg-zinc-950 border border-white/[0.07] font-mono text-xs text-sky-400 break-all select-all">
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
                className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl border border-white/[0.1] bg-zinc-800 hover:bg-zinc-700 active:scale-[0.98] text-sm font-medium text-zinc-200 transition-all duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
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
                className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 active:scale-[0.98] text-sm font-medium text-white shadow-lg shadow-sky-950/50 transition-all duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-400"
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
