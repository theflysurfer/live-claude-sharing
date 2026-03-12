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
  const EXTENSION_VERSION = "2.2.0";

  // Centralized selectors — update here when claude.ai DOM changes
  const SELECTORS = {
    userMessage: "[data-testid='user-message']",
    claudeResponse: "[class*='font-claude-response']",
    scroller: "[class*='scrollbar-gutter'], [class*='overflow-y-auto'][class*='overflow-x-hidden'][class*='flex-1']",
    contents: ".contents",
  };

  let ws = null;
  let wsState = "disconnected"; // disconnected, connecting, connected
  let messageCache = new Map(); // id -> { role, text }
  let observer = null;
  let containerObserver = null;
  let debounceTimer = null;
  let isStreaming = false;
  let selectorCheckDone = false;
  let syncCount = 0;
  let connectCount = 0;

  // ─── Logging ───

  function log(level, msg) {
    const ts = new Date().toISOString().split("T")[1].slice(0, 12);
    const line = `[LiveShare ${ts}] [${level}] ${msg}`;
    if (level === "ERROR" || level === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }
    // Also send to server as debug (if connected)
    if (level !== "DEBUG") {
      send({ type: "__debug", key: `ext_${level.toLowerCase()}`, val: msg });
    }
  }

  // ─── WebSocket ───

  function connect() {
    connectCount++;
    wsState = "connecting";
    log("INFO", `WS connecting to ${WS_URL} (attempt #${connectCount})`);

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      wsState = "connected";
      log("INFO", `WS connected (attempt #${connectCount})`);

      // Only fullSync if container already found
      const container = getMessageContainer();
      if (container) {
        log("INFO", "Container already available on WS connect → fullSync");
        fullSync();
      } else {
        log("INFO", "Container not ready on WS connect → deferring to startObserving");
      }
    };

    ws.onclose = (event) => {
      wsState = "disconnected";
      log("WARN", `WS disconnected — code=${event.code} reason="${event.reason || ""}" wasClean=${event.wasClean}`);
      setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = (event) => {
      log("ERROR", `WS error — readyState=${ws.readyState}`);
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const json = JSON.stringify(data);
        ws.send(json);
        return true;
      } catch (err) {
        log("ERROR", `WS send failed: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  // ─── DOM Parsing ───

  function getMessageContainer() {
    const firstUserMsg = document.querySelector(SELECTORS.userMessage);
    if (!firstUserMsg) return null;

    let el = firstUserMsg.parentElement;
    let depth = 0;
    while (el) {
      const userMsgs = el.querySelectorAll(`:scope > * ${SELECTORS.userMessage}`);
      const claudeMsgs = el.querySelectorAll(`:scope > * ${SELECTORS.claudeResponse}`);
      if (userMsgs.length >= 1 && claudeMsgs.length >= 1 && el.children.length >= 3) {
        log("DEBUG", `Container found at depth ${depth}: tag=${el.tagName} class="${(el.className || "").slice(0, 60)}" children=${el.children.length} user=${userMsgs.length} claude=${claudeMsgs.length}`);
        return el;
      }
      el = el.parentElement;
      depth++;
    }

    return null;
  }

  function parseMessageEl(el) {
    if (!el || el.nodeType !== 1) return null;

    // USER message
    const userMsg =
      (el.getAttribute("data-testid") === "user-message" ? el : null) ||
      el.querySelector(SELECTORS.userMessage);
    if (userMsg) {
      const textContainer =
        userMsg.querySelector("[class*='items-end']") || userMsg;
      return { role: "user", text: textContainer.textContent.trim() };
    }

    // ASSISTANT message
    const claudeResponse = el.querySelector(SELECTORS.claudeResponse);
    if (claudeResponse) {
      return { role: "assistant", text: claudeResponse.innerHTML };
    }

    // ASSISTANT fallback
    const contents = el.querySelector(SELECTORS.contents);
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
    if (!container) {
      log("DEBUG", "getAllMessages: no container");
      return [];
    }
    const messages = [];
    let idx = 0;
    let skipped = 0;
    for (const child of container.children) {
      const parsed = parseMessageEl(child);
      if (parsed) {
        messages.push({
          id: `msg-${idx}`,
          role: parsed.role,
          text: parsed.text,
        });
        idx++;
      } else {
        skipped++;
      }
    }
    log("DEBUG", `getAllMessages: ${messages.length} parsed, ${skipped} skipped, ${container.children.length} total children`);
    return messages;
  }

  // ─── Sync Logic ───

  function fullSync() {
    syncCount++;
    const container = getMessageContainer();
    log("INFO", `fullSync #${syncCount}: container=${!!container}, wsState=${wsState}`);

    if (!container) {
      log("WARN", "fullSync called but no container — sending empty sync");
    }

    const messages = getAllMessages();
    messageCache.clear();
    for (const m of messages) {
      messageCache.set(m.id, { role: m.role, text: m.text });
    }

    const sent = send({ type: "full_sync", messages, version: EXTENSION_VERSION });
    log("INFO", `fullSync #${syncCount}: ${messages.length} messages, sent=${sent}`);

    if (messages.length > 0) {
      log("INFO", `  first: [${messages[0].role}] "${(messages[0].text || "").slice(0, 60)}"`);
      log("INFO", `  last:  [${messages[messages.length - 1].role}] "${(messages[messages.length - 1].text || "").slice(0, 60)}"`);
    }

    // Send container debug info
    send({ type: "__debug", key: "fullSync_detail", val: {
      syncCount,
      containerFound: !!container,
      containerClass: container?.className?.slice(0, 80) || null,
      containerChildren: container?.children?.length || 0,
      msgCount: messages.length,
      userMsgsInDOM: document.querySelectorAll(SELECTORS.userMessage).length,
      claudeMsgsInDOM: document.querySelectorAll(SELECTORS.claudeResponse).length,
      url: location.href,
      time: new Date().toISOString(),
    }});
  }

  function checkForChanges() {
    const current = getAllMessages();
    const prevSize = messageCache.size;

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

    log("INFO", `checkForChanges: ${prevSize}→${current.length} messages`);

    for (const m of current) {
      const cached = messageCache.get(m.id);

      if (!cached) {
        log("INFO", `  NEW message ${m.id} [${m.role}] ${(m.text || "").length} chars`);
        send({ type: "message_start", id: m.id, role: m.role });
        send({ type: "delta", id: m.id, text: m.text });
        messageCache.set(m.id, { role: m.role, text: m.text });
      } else if (cached.text !== m.text) {
        isStreaming = true;
        if (m.text.startsWith(cached.text) && m.text.length > cached.text.length) {
          const appended = m.text.slice(cached.text.length);
          send({ type: "delta", id: m.id, text: appended });
        } else {
          log("DEBUG", `  REPLACE ${m.id}: ${cached.text.length}→${m.text.length} chars`);
          send({ type: "delta_replace", id: m.id, text: m.text });
        }
        cached.text = m.text;
      }
    }

    // Check if streaming just stopped
    const last = current[current.length - 1];
    if (last && isStreaming) {
      const cachedLast = messageCache.get(last.id);
      if (cachedLast && cachedLast.text === last.text) {
        isStreaming = false;
        log("INFO", `  STREAM END ${last.id}`);
        send({ type: "message_end", id: last.id });
      }
    }
  }

  // ─── MutationObserver ───

  function startObserving() {
    const container = getMessageContainer();
    const userCount = document.querySelectorAll(SELECTORS.userMessage).length;
    const claudeCount = document.querySelectorAll(SELECTORS.claudeResponse).length;

    log("INFO", `startObserving: container=${!!container} user=${userCount} claude=${claudeCount} url=${location.href}`);

    send({ type: "__debug", key: "startObserving", val: {
      found: !!container,
      userMsgs: userCount,
      claudeMsgs: claudeCount,
      bodyChildren: document.body?.children?.length || 0,
      allElements: document.querySelectorAll("*").length,
      url: location.href,
      wsState,
      time: new Date().toISOString(),
    }});

    if (!container) {
      if (!selectorCheckDone) {
        setTimeout(() => {
          if (!getMessageContainer() && document.querySelectorAll("*").length > 100) {
            selectorCheckDone = true;
            log("ERROR", `SELECTORS BROKEN — DOM has ${document.querySelectorAll("*").length} elements but no container found after 30s`);
            send({ type: "__debug", key: "selector_broken", val: {
              selectors: SELECTORS,
              bodyChildren: document.body.children.length,
              version: EXTENSION_VERSION,
              time: new Date().toISOString(),
            }});
          }
        }, 30000);
      }
      setTimeout(startObserving, 2000);
      return;
    }

    log("INFO", "Observing message container — attaching MutationObserver");

    // Re-sync now that we have the container
    fullSync();

    observer = new MutationObserver(() => {
      const delay = messageCache.size > 20 ? 300 : 150;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkForChanges, delay);
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also observe for container replacement (navigation between conversations)
    if (containerObserver) containerObserver.disconnect();
    const scroller = document.querySelector(SELECTORS.scroller);
    if (scroller) {
      log("INFO", `Scroller found: tag=${scroller.tagName} class="${(scroller.className || "").slice(0, 60)}"`);
      containerObserver = new MutationObserver(() => {
        const newContainer = getMessageContainer();
        if (newContainer && newContainer !== container) {
          log("INFO", "Container changed (navigation?) — re-initializing");
          observer.disconnect();
          setTimeout(() => {
            fullSync();
            startObserving();
          }, 1000);
        }
      });
      containerObserver.observe(scroller, { childList: true, subtree: false });
    } else {
      log("WARN", "Scroller NOT found — SPA navigation detection disabled");
    }
  }

  // ─── URL change detection (SPA navigation) ───
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      const oldUrl = lastUrl;
      lastUrl = location.href;
      log("INFO", `URL changed: ${oldUrl} → ${lastUrl}`);
      if (observer) observer.disconnect();
      setTimeout(() => {
        fullSync();
        startObserving();
      }, 2000);
    }
  }, 1000);

  // ─── Cleanup ───
  window.addEventListener("beforeunload", () => {
    log("INFO", "Page unloading — cleanup");
    if (observer) observer.disconnect();
    if (containerObserver) containerObserver.disconnect();
    if (ws) ws.close();
  });

  // ─── Init ───
  log("INFO", `Content script v${EXTENSION_VERSION} loaded on ${location.href}`);
  log("INFO", `Selectors: ${JSON.stringify(SELECTORS)}`);
  connect();
  setTimeout(startObserving, 2000);
})();
