"""Quick Patchright script to inspect claude.ai DOM structure for selectors."""
from patchright.sync_api import sync_playwright
import json, time

CHROME_USER_DATA = r"C:\Users\julien\AppData\Local\Google\Chrome\User Data"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=CHROME_USER_DATA,
        channel="chrome",
        headless=False,
        no_viewport=True,
        args=["--disable-blink-features=AutomationControlled"],
    )
    
    page = ctx.new_page()
    page.goto("https://claude.ai", wait_until="networkidle", timeout=30000)
    time.sleep(3)
    
    # Dump conversation structure
    result = page.evaluate("""() => {
        // Find the conversation container
        const selectors = [
            '[class*="conversation"]',
            '[data-testid*="conversation"]',
            '[class*="chat"]',
            '[class*="thread"]',
            '[class*="message"]',
            '[role="main"]',
            'main',
        ];
        
        const found = {};
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                found[sel] = els.length;
            }
        }
        
        // Get the main content area structure
        const main = document.querySelector('main') || document.querySelector('[role="main"]');
        if (!main) return { selectors: found, tree: 'no main found', url: location.href };
        
        function describeTree(el, depth = 0, maxDepth = 5) {
            if (depth > maxDepth || !el) return [];
            const lines = [];
            const tag = el.tagName?.toLowerCase() || '?';
            const cls = el.className && typeof el.className === 'string' ? el.className.split(' ').filter(c => c).slice(0, 3).join('.') : '';
            const role = el.getAttribute?.('role') || '';
            const testId = el.getAttribute?.('data-testid') || '';
            const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 
                ? el.textContent?.slice(0, 50) : '';
            
            let desc = `${'  '.repeat(depth)}<${tag}`;
            if (cls) desc += ` class="${cls}"`;
            if (role) desc += ` role="${role}"`;
            if (testId) desc += ` data-testid="${testId}"`;
            desc += '>';
            if (text) desc += ` "${text}"`;
            lines.push(desc);
            
            for (const child of el.children || []) {
                lines.push(...describeTree(child, depth + 1, maxDepth));
            }
            return lines;
        }
        
        return {
            selectors: found,
            url: location.href,
            tree: describeTree(main, 0, 6).join('\\n')
        };
    }""")
    
    print("=== URL ===")
    print(result.get("url", "?"))
    print("\n=== MATCHING SELECTORS ===")
    print(json.dumps(result.get("selectors", {}), indent=2))
    print("\n=== DOM TREE (main) ===")
    print(result.get("tree", "empty"))
    
    # Keep browser open for manual inspection
    input("\nPress Enter to close...")
    ctx.close()
