"""
Level 2 test: Extension content script on mock DOM page.
Launches WS server + Patchright with extension loaded on test-mock-page.html.
Verifies that the content script detects messages and relays them to the server.

Usage: python test-extension.py
Requirements: pip install patchright
"""
import json
import time
import os
import subprocess
import sys

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(PROJECT_DIR, "extension")
PROFILE_DIR = os.path.join(PROJECT_DIR, ".chrome-profile-test")
MOCK_PAGE = os.path.join(PROJECT_DIR, "test-mock-page.html").replace("\\", "/")

passed = 0
failed = 0

def check(condition, label):
    global passed, failed
    if condition:
        print(f"  ✅ {label}", flush=True)
        passed += 1
    else:
        print(f"  ❌ {label}", flush=True)
        failed += 1

# ── 1. Start WS server ──
print("=== Starting WS server ===", flush=True)

# Kill any leftover on port 3333
try:
    import subprocess as sp
    result = sp.run(["powershell", "-Command",
        "Get-NetTCPConnection -LocalPort 3333 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"],
        capture_output=True, timeout=5)
except Exception:
    pass
time.sleep(1)

server_proc = subprocess.Popen(
    ["node", "server/server.js"],
    cwd=PROJECT_DIR,
    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
)
time.sleep(2)

import urllib.request
try:
    urllib.request.urlopen("http://localhost:3333", timeout=3)
    print("Server OK", flush=True)
except Exception as e:
    print(f"Server FAILED: {e}", flush=True)
    server_proc.kill()
    sys.exit(1)

# ── 2. Launch browser with extension on mock page ──
print("\n=== Launching Patchright with extension ===", flush=True)

try:
    from patchright.sync_api import sync_playwright
except ImportError:
    print("ERROR: patchright not installed. Run: pip install patchright", flush=True)
    server_proc.kill()
    sys.exit(1)

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
        
        # ── 3. Open mock page ──
        print("\n=== Opening mock page ===", flush=True)
        # The content script matches claude.ai/* only, but we need it to run on our mock page.
        # Since manifest V3 restricts content scripts to declared matches, we'll inject it manually.
        mock_url = f"file:///{MOCK_PAGE}"
        page.goto(mock_url, wait_until="domcontentloaded", timeout=10000)
        time.sleep(1)
        print(f"Mock page loaded: {page.url}", flush=True)

        # ── 4. Inject content script manually (since our mock isn't on claude.ai domain) ──
        print("\n=== Injecting content script ===", flush=True)
        content_script_path = os.path.join(EXTENSION_DIR, "content-v2.js")
        with open(content_script_path, "r", encoding="utf-8") as f:
            content_script_code = f.read()
        
        page.evaluate(content_script_code)
        print("Content script injected", flush=True)
        
        # Wait for the content script to init (it has a 2s setTimeout)
        print("Waiting for content script to init (4s)...", flush=True)
        time.sleep(4)

        # ── 5. Check if messages were relayed to server via WS ──
        print("\n=== Checking server state ===", flush=True)
        
        ws_check = page.evaluate("""() => {
            return new Promise((resolve) => {
                const ws = new WebSocket('ws://localhost:3333/ws/viewer');
                ws.onmessage = (e) => {
                    const msg = JSON.parse(e.data);
                    ws.close();
                    resolve({
                        type: msg.type,
                        count: msg.messages?.length || 0,
                        messages: (msg.messages || []).map(m => ({
                            id: m.id,
                            role: m.role, 
                            textPreview: (m.text || '').slice(0, 100)
                        }))
                    });
                };
                ws.onerror = () => resolve({ error: 'ws failed' });
                setTimeout(() => resolve({ error: 'timeout' }), 5000);
            });
        }""")

        print(f"Server state: {json.dumps(ws_check, indent=2, ensure_ascii=False)[:500]}", flush=True)
        
        check(ws_check.get("count", 0) >= 2, f"Server has ≥2 messages (got {ws_check.get('count', 0)})")
        
        if ws_check.get("count", 0) >= 2:
            msgs = ws_check.get("messages", [])
            check(msgs[0]["role"] == "user", "First message is user")
            check("Hello" in msgs[0].get("textPreview", ""), "User message text correct")
            check(msgs[1]["role"] == "assistant", "Second message is assistant")
            check("doing well" in msgs[1].get("textPreview", ""), "Assistant message text correct")

        # ── 6. Test streaming: add a new message and check it appears ──
        print("\n=== Testing dynamic DOM changes ===", flush=True)
        
        # Add a new user message via the mock page's API
        page.evaluate("addUserMessage('Dynamic test message')")
        time.sleep(1)  # Wait for MutationObserver + debounce
        
        # Check server again
        ws_check2 = page.evaluate("""() => {
            return new Promise((resolve) => {
                const ws = new WebSocket('ws://localhost:3333/ws/viewer');
                ws.onmessage = (e) => {
                    const msg = JSON.parse(e.data);
                    ws.close();
                    resolve({
                        count: msg.messages?.length || 0,
                        lastText: msg.messages?.[msg.messages.length - 1]?.text?.slice(0, 100) || ''
                    });
                };
                setTimeout(() => resolve({ error: 'timeout' }), 5000);
            });
        }""")
        
        check(ws_check2.get("count", 0) >= 3, f"Server has ≥3 messages after DOM add (got {ws_check2.get('count', 0)})")
        check("Dynamic test" in ws_check2.get("lastText", ""), "New message detected by content script")

        # ── 7. Test streaming simulation ──
        print("\n=== Testing streaming simulation ===", flush=True)
        
        page.evaluate("simulateStreaming()")
        time.sleep(4)  # Let a few words stream
        
        ws_check3 = page.evaluate("""() => {
            return new Promise((resolve) => {
                const ws = new WebSocket('ws://localhost:3333/ws/viewer');
                ws.onmessage = (e) => {
                    const msg = JSON.parse(e.data);
                    ws.close();
                    resolve({
                        count: msg.messages?.length || 0,
                        lastRole: msg.messages?.[msg.messages.length - 1]?.role || '',
                        lastText: msg.messages?.[msg.messages.length - 1]?.text?.slice(0, 100) || '',
                        streaming: msg.streamingId
                    });
                };
                setTimeout(() => resolve({ error: 'timeout' }), 5000);
            });
        }""")
        
        check(ws_check3.get("count", 0) >= 4, f"Server has ≥4 messages with streaming (got {ws_check3.get('count', 0)})")
        check(ws_check3.get("lastRole") == "assistant", "Streaming message is assistant")
        check(len(ws_check3.get("lastText", "")) > 10, f"Streaming text captured ({len(ws_check3.get('lastText', ''))} chars)")
        
        print(f"\nStreaming state: {json.dumps(ws_check3, indent=2, ensure_ascii=False)[:300]}", flush=True)

        # Keep browser open briefly for visual inspection
        print("\nBrowser open 5s for visual check...", flush=True)
        time.sleep(5)
        ctx.close()

except Exception as e:
    print(f"\nCRASH: {e}", flush=True)
    import traceback
    traceback.print_exc()
    failed += 1

server_proc.kill()

print(f"\n{'─' * 40}", flush=True)
print(f"Results: {passed} passed, {failed} failed", flush=True)

if failed > 0:
    print("\n❌ SOME TESTS FAILED", flush=True)
    sys.exit(1)
else:
    print("\n✅ ALL TESTS PASSED", flush=True)
    sys.exit(0)
