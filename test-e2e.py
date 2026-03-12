"""
End-to-end test: launch Electron server + Patchright with extension on claude.ai.
Checks that messages flow from claude.ai → extension → server → viewer.
"""
from patchright.sync_api import sync_playwright
import json, time, os, subprocess, signal

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(PROJECT_DIR, "extension")
PROFILE_DIR = os.path.join(PROJECT_DIR, ".chrome-profile")

# Start the WS server (standalone, not Electron — simpler for testing)
print("Starting WS server...", flush=True)
server_proc = subprocess.Popen(
    ["node", "server/server.js"],
    cwd=PROJECT_DIR,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
time.sleep(2)

# Check server is running
import urllib.request
try:
    resp = urllib.request.urlopen("http://localhost:3333", timeout=3)
    print(f"Server OK: {resp.status}", flush=True)
except Exception as e:
    print(f"Server failed: {e}", flush=True)
    server_proc.kill()
    exit(1)

print("Launching Patchright with extension...", flush=True)

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

    # Open claude.ai
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://claude.ai", wait_until="domcontentloaded", timeout=30000)
    
    for i in range(30):
        time.sleep(2)
        if "/chat/" in page.url:
            break
        if i % 5 == 0:
            print(f"  Waiting for conversation... ({page.url})", flush=True)

    print(f"On: {page.url}", flush=True)
    time.sleep(5)  # Let extension connect and sync

    # Check server logs
    print("\n=== SERVER OUTPUT ===", flush=True)
    # Read whatever the server has output
    import selectors
    sel = selectors.DefaultSelector()
    sel.register(server_proc.stdout, selectors.EVENT_READ)
    server_output = ""
    while sel.select(timeout=0.5):
        line = server_proc.stdout.readline()
        if line:
            server_output += line
            print(f"  {line.rstrip()}", flush=True)
        else:
            break
    sel.close()

    # Also check via WebSocket what the server has
    ws_check = page.evaluate("""() => {
        return new Promise((resolve) => {
            const ws = new WebSocket('ws://localhost:3333/ws/viewer');
            ws.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                ws.close();
                resolve({
                    type: msg.type,
                    messageCount: msg.messages?.length || 0,
                    firstMsg: msg.messages?.[0] || null,
                    lastMsg: msg.messages?.[msg.messages?.length - 1] || null,
                });
            };
            ws.onerror = () => resolve({ error: 'ws failed' });
            setTimeout(() => resolve({ error: 'timeout' }), 5000);
        });
    }""")

    print(f"\n=== VIEWER WS CHECK ===", flush=True)
    print(json.dumps(ws_check, indent=2, ensure_ascii=False)[:2000], flush=True)

    if ws_check.get("messageCount", 0) > 0:
        print(f"\n✅ SUCCESS! {ws_check['messageCount']} messages flowing through!", flush=True)
    else:
        print(f"\n❌ No messages received by viewer", flush=True)

    # Open the viewer page in a second tab
    viewer_page = ctx.new_page()
    viewer_page.goto("http://localhost:3333", wait_until="domcontentloaded", timeout=10000)
    time.sleep(2)
    print(f"\nViewer page opened. Check it visually!", flush=True)

    input("\nPress Enter to close everything...")
    ctx.close()

server_proc.kill()
print("Done.", flush=True)
