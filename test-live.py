"""
Launch Patchright with extension, open a conversation, check if messages are detected.
Uses saved profile — no re-login needed.
"""
from patchright.sync_api import sync_playwright
import json, time, os

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(PROJECT_DIR, "extension")
PROFILE_DIR = os.path.join(PROJECT_DIR, ".chrome-profile")

print(f"Launching with saved profile...", flush=True)

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
    page.goto("https://claude.ai", wait_until="domcontentloaded", timeout=30000)
    
    # Wait for conversation
    for i in range(30):
        time.sleep(2)
        if "/chat/" in page.url:
            break
        if i % 5 == 0:
            print(f"  Waiting for conversation... ({page.url})", flush=True)
    
    print(f"On: {page.url}", flush=True)
    time.sleep(3)

    # Check extension console logs
    logs = page.evaluate("""() => {
        // Check if content script found messages
        const userMsgs = document.querySelectorAll("[data-testid='user-message']");
        const claudeMsgs = document.querySelectorAll("[class*='font-claude-response']");
        const scroller = document.querySelector("[class*='scrollbar-gutter']");
        
        return {
            userMessages: userMsgs.length,
            claudeMessages: claudeMsgs.length,
            scrollerFound: !!scroller,
            scrollerChildren: scroller ? scroller.children.length : 0,
            scrollerFirstChildClasses: scroller?.firstElementChild?.className?.slice(0, 80) || 'none',
        };
    }""")
    
    print(f"\n=== DETECTION TEST ===", flush=True)
    print(f"  User messages (data-testid): {logs['userMessages']}", flush=True)
    print(f"  Claude messages (font-claude): {logs['claudeMessages']}", flush=True)
    print(f"  Scroller found: {logs['scrollerFound']}", flush=True)
    print(f"  Scroller children: {logs['scrollerChildren']}", flush=True)
    print(f"  First child: {logs['scrollerFirstChildClasses']}", flush=True)

    # Now check the content script's getMessageContainer via console
    container_test = page.evaluate("""() => {
        // Replicate getMessageContainer logic (walk-up from first user message)
        const firstUserMsg = document.querySelector("[data-testid='user-message']");
        if (!firstUserMsg) return { error: 'no user-message found' };
        
        let el = firstUserMsg.parentElement;
        let path = [];
        while (el) {
            const userMsgs = el.querySelectorAll(":scope > * [data-testid='user-message']");
            const claudeMsgs = el.querySelectorAll(":scope > * [class*='font-claude-response']");
            path.push({
                tag: el.tagName,
                children: el.children.length,
                classes: el.className?.slice(0, 60) || '',
                userMsgs: userMsgs.length,
                claudeMsgs: claudeMsgs.length,
                isContainer: userMsgs.length >= 1 && claudeMsgs.length >= 1 && el.children.length >= 3,
            });
            if (userMsgs.length >= 1 && claudeMsgs.length >= 1 && el.children.length >= 3) {
                // Found it!
                // Show what the children look like
                const childInfo = Array.from(el.children).slice(0, 5).map(c => ({
                    tag: c.tagName,
                    classes: c.className?.slice(0, 50) || '',
                    hasUser: !!c.querySelector("[data-testid='user-message']"),
                    hasClaude: !!c.querySelector("[class*='font-claude-response']"),
                }));
                return { found: true, container: path[path.length - 1], path, childSamples: childInfo };
            }
            el = el.parentElement;
        }
        
        return { found: false, path };
    }""")
    
    print(f"\n=== CONTAINER RESOLUTION ===", flush=True)
    print(json.dumps(container_test, indent=2), flush=True)

    print(f"\n=== EXTENSION CONSOLE LOGS ===", flush=True)
    print("Check the browser DevTools console for [LiveShare] messages.", flush=True)
    
    input("\nPress Enter to close...")
    ctx.close()
