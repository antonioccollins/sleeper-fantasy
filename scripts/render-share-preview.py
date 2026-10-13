"""Render the checked-in social preview. Optional tooling: Playwright + Chromium.

Run from any directory with: python scripts/render-share-preview.py
The generated PNG is committed; Netlify builds need no browser or image tools.
"""
from pathlib import Path
import shutil
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
output = root / 'static/share/tradeblock-v1.png'
output.parent.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1200, 'height': 630}, device_scale_factor=1)
    page.set_content((root / 'scripts/share-preview.html').read_text())
    page.evaluate('document.fonts.ready')
    page.screenshot(path=str(output))
    page.set_viewport_size({'width': 180, 'height': 180})
    page.set_content('<style>body{margin:0}body>svg{display:block;width:180px;height:180px}</style>' + (root / 'static/favicon.svg').read_text())
    page.screenshot(path=str(output.with_name('tradeblock-icon.png')))
    browser.close()
print(output)
