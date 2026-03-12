"""
Launch Patchright, inspect claude.ai DOM, output to file.
Profile is saved in .chrome-profile/ — no re-login needed after first run.
"""
from patchright.sync_api import sync_playwright
import json, time, os

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(PROJECT_DIR, "extension")
PROFILE_DIR = os.path.join(PROJECT_DIR, ".chrome-profile")
OUTPUT_FILE = r"C:\tmp\dom-inspect.txt"

print(f"Extension: {EXTENSION_DIR}", flush=True)
print(f"Profile: {PROFILE_DIR}", flush=True)

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
    
    # Wait until we're on a conversation page (with or without login)
    print(f"Current URL: {page.url}", flush=True)
    
    for i in range(60):  # Wait up to 2 minutes
        time.sleep(2)
        url = page.url
        if "/chat/" in url:
            print(f"On conversation: {url}", flush=True)
            break
        if i % 5 == 0:
            print(f"  Waiting... ({url})", flush=True)
    else:
        print("Timeout waiting for conversation. Inspecting current page anyway.", flush=True)

    # Let the page settle
    time.sleep(3)
    print("Inspecting DOM...", flush=True)

    result = page.evaluate("""() => {
        const info = { url: location.href, tests: {} };
        
        const selectorTests = {
            'overflow-y-auto': '[class*="overflow-y-auto"]',
            'overflow-x-hidden': '[class*="overflow-x-hidden"]',
            'both-overflow': '[class*="overflow-y-auto"][class*="overflow-x-hidden"]',
            'font-claude': '[class*="font-claude"]',
            'items-end': '[class*="items-end"]',
            'contents-class': '.contents',
        };
        
        for (const [name, sel] of Object.entries(selectorTests)) {
            const els = document.querySelectorAll(sel);
            info.tests[name] = {
                count: els.length,
                samples: Array.from(els).slice(0, 3).map(el => ({
                    tag: el.tagName,
                    classes: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
                    children: el.children.length,
                    testid: el.getAttribute('data-testid') || '',
                }))
            };
        }
        
        // All data-testid values
        info.testids = [...new Set(
            Array.from(document.querySelectorAll('[data-testid]'))
            .map(el => el.getAttribute('data-testid'))
        )];
        
        // DOM tree from <main>
        function tree(el, depth = 0, max = 7) {
            if (depth > max || !el) return [];
            const tag = el.tagName?.toLowerCase() || '?';
            const cls = typeof el.className === 'string' ? el.className : '';
            const short = cls.split(' ').filter(c=>c).slice(0,6).join(' ');
            const n = el.children?.length || 0;
            let line = '  '.repeat(depth) + '<' + tag;
            if (short) line += ' class="' + short + '"';
            const tid = el.getAttribute?.('data-testid');
            if (tid) line += ' data-testid="' + tid + '"';
            const role = el.getAttribute?.('role');
            if (role) line += ' role="' + role + '"';
            line += ' [' + n + ']>';
            if (n === 0 && el.textContent?.trim())
                line += ' "' + el.textContent.trim().slice(0, 50) + '"';
            const lines = [line];
            if (n > 0 && n < 50) {
                for (const c of el.children) lines.push(...tree(c, depth+1, max));
            } else if (n >= 50) {
                lines.push('  '.repeat(depth+1) + '... (' + n + ' children, first 3)');
                for (let i = 0; i < 3; i++) lines.push(...tree(el.children[i], depth+1, max));
            }
            return lines;
        }
        
        const main = document.querySelector('main');
        info.tree = main ? tree(main).join('\\n') : 'NO MAIN';
        return info;
    }""")

    out = []
    out.append(f"URL: {result.get('url')}")
    out.append(f"\n=== SELECTOR TESTS ===")
    for k, v in result.get("tests", {}).items():
        out.append(f"\n{k}: {v['count']} found")
        for s in v.get('samples', []):
            out.append(f"  {s['tag']} class=\"{s['classes']}\" children={s['children']} testid={s['testid']}")
    out.append(f"\n=== DATA-TESTID VALUES ===")
    for t in result.get("testids", []):
        out.append(f"  {t}")
    out.append(f"\n=== DOM TREE ===")
    out.append(result.get("tree", "empty"))
    
    text = "\n".join(out)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(text)
    
    print(f"\nDone! Output: {OUTPUT_FILE}", flush=True)
    ctx.close()
