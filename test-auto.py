"""
Fully automated E2E test. No interaction, results to file.
"""
from patchright.sync_api import sync_playwright
import json, time, os, subprocess

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(PROJECT_DIR, "extension")
PROFILE_DIR = os.path.join(PROJECT_DIR, ".chrome-profile")
RESULTS_FILE = r"C:\tmp\test-results.txt"

results = []
def log(msg):
    print(msg, flush=True)
    results.append(msg)
def save():
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(results))

# ── 1. Kill old server, start fresh ──
log("=== STARTING SERVER ===")
os.system('cmd /c "for /f \\"tokens=5\\" %a in (\'netstat -ano ^| findstr :3333 ^| findstr LISTENING\') do taskkill /PID %a /F >nul 2>&1"')
time.sleep(1)

server_proc = subprocess.Popen(
    ["node", "server/server.js"],
    cwd=PROJECT_DIR,
    creationflags=subprocess.CREATE_NO_WINDOW,
)
time.sleep(2)

import urllib.request
try:
    urllib.request.urlopen("http://localhost:3333", timeout=3)
    log("Server OK")
except Exception as e:
    log(f"Server FAILED: {e}")
    save(); server_proc.kill(); exit(1)

# ── 2. Launch browser ──
log("\n=== LAUNCHING BROWSER ===")
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            channel="chrome",
            headless=False,
            no_viewport=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                f"--disable-extensions-except={EXTENSION_DIR}",
                f"--load-extension={EXTENSION_DIR}",
            ],
        )

        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # ── 3. Navigate directly to a known conversation ──
        log("\n=== NAVIGATING TO CONVERSATION ===")
        page.goto("https://claude.ai/chat/92f00ae5-2500-4832-ae01-aad3009e9624",
                   wait_until="domcontentloaded", timeout=30000)
        time.sleep(3)
        page.reload(wait_until="domcontentloaded", timeout=15000)
        time.sleep(5)
        log(f"On: {page.url}")

        # ── 5. Wait for page to fully render + extension to sync ──
        # Give MORE time: content script has 2s delay, then retries every 2s
        log("\n=== WAITING FOR CONTENT SCRIPT ===")
        for i in range(10):  # 20 seconds
            time.sleep(2)
            dom = page.evaluate("""() => ({
                userMsgs: document.querySelectorAll("[data-testid='user-message']").length,
                claudeMsgs: document.querySelectorAll("[class*='font-claude-response']").length,
            })""")
            if dom['userMsgs'] > 0:
                log(f"DOM ready at {i*2}s: {dom['userMsgs']} user, {dom['claudeMsgs']} claude")
                break
            log(f"  {i*2}s: {dom['userMsgs']} user, {dom['claudeMsgs']} claude")
        
        # Extra wait for extension to process
        time.sleep(5)
        
        # Check from extension's perspective: inject a check into the page
        # The content script runs in an isolated world, so we can't directly access it.
        # Instead, check the server via a viewer WS connection.
        ws_check = page.evaluate("""() => {
            return new Promise((resolve) => {
                const ws = new WebSocket('ws://localhost:3333/ws/viewer');
                ws.onmessage = (e) => {
                    const msg = JSON.parse(e.data);
                    ws.close();
                    resolve({
                        type: msg.type,
                        count: msg.messages?.length || 0,
                        firstRole: msg.messages?.[0]?.role || '',
                        firstText: msg.messages?.[0]?.text?.slice(0, 80) || '',
                    });
                };
                ws.onerror = () => resolve({ error: 'ws failed' });
                setTimeout(() => resolve({ error: 'timeout' }), 5000);
            });
        }""")
        log(f"\nServer state: {json.dumps(ws_check, ensure_ascii=False)}")

        if ws_check.get("count", 0) > 0:
            log(f"\n✅ SUCCESS! {ws_check['count']} messages on server!")
        else:
            log(f"\n❌ Messages in DOM but not on server")
            log("Content script might not be connecting to WS.")
            
            # Read server log file (includes debug from content script)
            log("\n=== SERVER LOG FILE ===")
            try:
                with open(r"C:\tmp\server.log", "r") as f:
                    log(f.read().strip() or "(empty)")
            except FileNotFoundError:
                log("(no server.log — no connections at all)")
            
            # Try to manually connect as source and send a test message
            log("\n=== MANUAL SOURCE TEST ===")
            manual_test = page.evaluate("""() => {
                return new Promise((resolve) => {
                    const ws = new WebSocket('ws://localhost:3333/ws/source');
                    ws.onopen = () => {
                        ws.send(JSON.stringify({ type: 'full_sync', messages: [
                            { id: 'test-0', role: 'user', text: 'MANUAL TEST' }
                        ]}));
                        ws.close();
                        resolve('sent_test_message');
                    };
                    ws.onerror = () => resolve('source_connect_failed');
                    setTimeout(() => resolve('source_timeout'), 3000);
                });
            }""")
            log(f"Manual source: {manual_test}")
            time.sleep(1)
            
            # Now check server again
            ws_recheck = page.evaluate("""() => {
                return new Promise((resolve) => {
                    const ws = new WebSocket('ws://localhost:3333/ws/viewer');
                    ws.onmessage = (e) => {
                        const msg = JSON.parse(e.data);
                        ws.close();
                        resolve({ count: msg.messages?.length || 0, firstText: msg.messages?.[0]?.text || '' });
                    };
                    setTimeout(() => resolve({ error: 'timeout' }), 3000);
                });
            }""")
            log(f"After manual send: {json.dumps(ws_recheck)}")
            
            if ws_recheck.get("count", 0) > 0:
                log("→ Server works fine. Problem is content script not sending.")
                log("→ Content script runs in isolated world — Patchright can't see its logs.")
                log("→ The extension IS loaded but content script may not match or run.")

        # ── 7. Open viewer ──
        viewer = ctx.new_page()
        viewer.goto("http://localhost:3333", wait_until="domcontentloaded", timeout=10000)
        time.sleep(2)
        viewer_msgs = viewer.evaluate("() => document.querySelectorAll('.message').length")
        log(f"\nViewer: {viewer_msgs} messages rendered")

        save()
        log("\nBrowser open 30s for visual check...")
        time.sleep(30)
        ctx.close()

except Exception as e:
    log(f"\nCRASH: {e}")
    import traceback
    log(traceback.format_exc())

save()
server_proc.kill()
