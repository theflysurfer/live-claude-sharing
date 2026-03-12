/**
 * Live Claude Sharing — Content Script
 * Observes claude.ai conversation DOM and sends updates via WebSocket.
 * 
 * DOM structure (as of March 2026):
 *   div.overflow-y-auto (scroller)
 *     └ div.relative.w-full.min-h-full
 *       └ div.mx-auto.flex.size-full.max-w-3xl
 *         └ div.flex-1.flex.flex-col.px-4  ← message container
 *           ├ div > div.mb-1.mt-6.group > div.flex.flex-col.items-end  ← USER
 *           ├ div > div.group > div.contents > div.font-claude-response  ← ASSISTANT
 *           └ div.h-px (separator)
 */

(function () {
  "use strict";

  const WS_URL = "ws://localhost:3333/ws/source";
  const RECONNECT_DELAY = 3000;

  let ws = null;
  let messageCache = new Map(); // id -> { role, text }
  let observer = null;
  let containerObserver = null;
  let debounceTimer = null;
  let isStreaming = false;

  // ─── WebSocket ───

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      console.log("[LiveShare] Connected to server");
      fullSync();
    };
    ws.onclose = () => {
      console.log("[LiveShare] Disconnected, reconnecting...");
      setTimeout(connect, RECONNECT_DELAY);
    };
    ws.onerror = () => {};
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ─── DOM Parsing ───

  function getMessageContainer() {
    // Find the first user message, then walk up to find the container
    // that holds ALL messages (user + assistant) as direct or near-direct children.
    const firstUserMsg = document.querySelector("[data-testid='user-message']");
    if (!firstUserMsg) return null;

    // Walk up from the user message, looking for the container that holds
    // multiple message-like children (both user and assistant)
    let el = firstUserMsg.parentElement;
    while (el) {
      const userMsgs = el.querySelectorAll(":scope > * [data-testid='user-message']");
      const claudeMsgs = el.querySelectorAll(":scope > * [class*='font-claude-response']");
      if (userMsgs.length >= 1 && claudeMsgs.length >= 1 && el.children.length >= 3) {
        return el;
      }
      el = el.parentElement;
    }

    return null;
  }

  function parseMessageEl(el) {
    if (!el || el.nodeType !== 1) return null;

    // USER message: data-testid="user-message" on the element itself or a child
    const userMsg =
      (el.getAttribute("data-testid") === "user-message" ? el : null) ||
      el.querySelector("[data-testid='user-message']");
    if (userMsg) {
      // Get text from the items-end container, or fall back to full text
      const textContainer =
        userMsg.querySelector("[class*='items-end']") || userMsg;
      return { role: "user", text: textContainer.textContent.trim() };
    }

    // ASSISTANT message: has .font-claude-response
    const claudeResponse = el.querySelector("[class*='font-claude-response']");
    if (claudeResponse) {
      return { role: "assistant", text: claudeResponse.innerHTML };
    }

    // ASSISTANT fallback: .contents with inner content
    const contents = el.querySelector(".contents");
    if (contents) {
      const inner = contents.querySelector("[class*='font-claude']") ||
        contents.firstElementChild;
      if (inner) {
        return { role: "assistant", text: inner.innerHTML };
      }
    }

    return null;
  }

  function getAllMessages() {
    const container = getMessageContainer();
    if (!container) return [];
    const messages = [];
    let idx = 0;
    for (const child of container.children) {
      const parsed = parseMessageEl(child);
      if (parsed) {
        messages.push({
          id: `msg-${idx}`,
          role: parsed.role,
          text: parsed.text,
        });
        idx++;
      }
    }
    return messages;
  }

  // ─── Sync Logic ───

  function debugLog(key, val) {
    // Send debug info through the WS connection (server will log it)
    send({ type: "__debug", key, val });
  }

  function fullSync() {
    const container = getMessageContainer();
    debugLog("container", {
      found: !!container,
      classes: container?.className?.slice(0, 80) || null,
      children: container?.children?.length || 0,
      firstUserMsg: !!document.querySelector("[data-testid='user-message']"),
      time: new Date().toISOString(),
    });
    const messages = getAllMessages();
    messageCache.clear();
    for (const m of messages) {
      messageCache.set(m.id, { role: m.role, text: m.text });
    }
    send({ type: "full_sync", messages });
    debugLog("lastSync", { count: messages.length, time: new Date().toISOString() });
    console.log(`[LiveShare] Full sync: ${messages.length} messages`);
  }

  function checkForChanges() {
    const current = getAllMessages();
    const prevSize = messageCache.size;

    // Check if any message is new or changed
    let changed = current.length !== prevSize;
    if (!changed) {
      for (const m of current) {
        const cached = messageCache.get(m.id);
        if (!cached || cached.text !== m.text) {
          changed = true;
          break;
        }
      }
    }

    if (!changed) return;

    // Find what changed
    for (const m of current) {
      const cached = messageCache.get(m.id);

      if (!cached) {
        // New message
        send({ type: "message_start", id: m.id, role: m.role });
        send({ type: "delta", id: m.id, text: m.text });
        messageCache.set(m.id, { role: m.role, text: m.text });
      } else if (cached.text !== m.text) {
        // Content changed (streaming)
        isStreaming = true;
        send({ type: "delta_replace", id: m.id, text: m.text });
        cached.text = m.text;
      }
    }

    // Check if streaming just stopped (last assistant message stopped changing)
    const last = current[current.length - 1];
    if (last && isStreaming) {
      const cachedLast = messageCache.get(last.id);
      if (cachedLast && cachedLast.text === last.text) {
        // Text hasn't changed since last check — streaming is done
        isStreaming = false;
        send({ type: "message_end", id: last.id });
      }
    }
  }

  // ─── MutationObserver ───

  function startObserving() {
    const container = getMessageContainer();
    debugLog("startObserving", {
      found: !!container,
      firstUserMsg: !!document.querySelector("[data-testid='user-message']"),
      time: new Date().toISOString(),
    });
    if (!container) {
      // Retry until the container appears
      setTimeout(startObserving, 2000);
      return;
    }

    console.log("[LiveShare] Observing message container");

    // Re-sync now that we have the container (initial fullSync may have run too early)
    fullSync();

    observer = new MutationObserver(() => {
      // Debounce to batch rapid mutations (streaming)
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkForChanges, 150);
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also observe for container replacement (navigation between conversations)
    if (containerObserver) containerObserver.disconnect();
    const scroller =
      document.querySelector("[class*='scrollbar-gutter']") ||
      document.querySelector("[class*='overflow-y-auto'][class*='overflow-x-hidden'][class*='flex-1']");
    if (scroller) {
      containerObserver = new MutationObserver(() => {
        const newContainer = getMessageContainer();
        if (newContainer && newContainer !== container) {
          console.log("[LiveShare] Container changed, re-initializing");
          observer.disconnect();
          setTimeout(() => {
            fullSync();
            startObserving();
          }, 1000);
        }
      });
      containerObserver.observe(scroller, { childList: true, subtree: false });
    }
  }

  // ─── URL change detection (SPA navigation) ───
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("[LiveShare] URL changed:", lastUrl);
      if (observer) observer.disconnect();
      setTimeout(() => {
        fullSync();
        startObserving();
      }, 2000);
    }
  }, 1000);

  // ─── Cleanup ───
  window.addEventListener("beforeunload", () => {
    if (observer) observer.disconnect();
    if (containerObserver) containerObserver.disconnect();
    if (ws) ws.close();
  });

  // ─── Init ───
  connect();
  setTimeout(startObserving, 2000);
})();
