"""Two independent browsers exercise real trade terms using a disposable database.

Requires Playwright and Chromium. No real manager votes are modified.
"""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "test-results"


def run():
    OUTPUT.mkdir(exist_ok=True)
    errors=[]
    with tempfile.TemporaryDirectory(prefix="trade-match-browser-") as tmp:
        temp = Path(tmp)
        shutil.copy(ROOT/".data/model.json",temp/"model.json")
        server_env={**os.environ,"DATA_DIR":str(temp),"AUTO_SYNC":"0","PORT":"8017"}
        with (temp/"server.log").open("w") as log:
            server=subprocess.Popen([str(ROOT/".venv/bin/gunicorn"),"--bind","127.0.0.1:8017","--workers","1","--threads","8","app:application"],cwd=ROOT,env=server_env,stdout=log,stderr=log)
            try:
                base="http://127.0.0.1:8017"
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError((temp/"server.log").read_text())
                    try:
                        with urllib.request.urlopen(base+"/health",timeout=1) as response:
                            assert json.load(response)["status"]=="ok"
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise RuntimeError("Production server did not become ready")
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path=shutil.which("chromium"),headless=True,args=["--no-sandbox"])
                    context_a=browser.new_context(viewport={"width":1440,"height":1000})
                    context_b=browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,device_scale_factor=1)
                    a=context_a.new_page();b=context_b.new_page()
                    for page in (a,b):
                        page.on("pageerror",lambda err:errors.append(str(err)))
                        page.goto(base)
                        page.wait_for_selector("#team-dialog[open]")
                    a.locator('[data-team="4"]').click()
                    expect(a.locator('#trade-card')).to_have_attribute('data-proposal-id',re.compile('.+'))
                    assert "Tonzcollins" in a.locator('#my-manager').inner_text()
                    deck=a.request.get(base+'/api/deck').json()['proposals']
                    target=deck[0]
                    a.screenshot(path=str(OUTPUT/'desktop.png'),full_page=True)
                    a.locator('#like-button').click()
                    expect(a.locator('#trade-card')).not_to_have_attribute('data-proposal-id',target['id'])
                    assert not a.locator('#match-dialog').is_visible(), 'One like must not make a match'
                    a.locator('[data-view="likes"]').click()
                    a.wait_for_selector('.saved-trade')
                    assert target['give'][0]['name'] in a.locator('#likes-list').inner_text()
                    b.locator(f'[data-team="{target["partner"]["id"]}"]').click()
                    expect(b.locator('#trade-card')).to_have_attribute('data-proposal-id',re.compile('.+'))
                    assert b.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
                    b.screenshot(path=str(OUTPUT/'mobile.png'),full_page=True)
                    second_deck=b.request.get(base+'/api/deck').json()['proposals']
                    index=next(i for i,v in enumerate(second_deck) if v['id']==target['id'])
                    assert index<30, 'Shared trade should be discoverable without excessive swiping'
                    for _ in range(index):
                        previous=b.locator('#trade-card').get_attribute('data-proposal-id')
                        b.locator('#pass-button').click()
                        expect(b.locator('#trade-card')).not_to_have_attribute('data-proposal-id',previous)
                    assert target['receive'][0]['name'] in b.locator('#trade-card .give-group').inner_text()
                    assert target['give'][0]['name'] in b.locator('#trade-card .receive-group').inner_text()
                    # Real pointer gesture, rather than calling a JS vote function.
                    box=b.locator('#trade-card').bounding_box()
                    x=box['x']+box['width']*.25;y=box['y']+70
                    b.mouse.move(x,y);b.mouse.down();b.mouse.move(x+135,y+3,steps=8);b.mouse.up()
                    b.wait_for_selector('#match-dialog[open]')
                    b.screenshot(path=str(OUTPUT/'match.png'),full_page=True)
                    a.bring_to_front()
                    a.wait_for_selector('#match-dialog[open]',timeout=20000)
                    assert target['give'][0]['name'] in a.locator('#match-terms').inner_text()
                    a.locator('#match-open-button').click()
                    a.wait_for_selector('#matches-list .saved-trade')
                    assert len(a.request.get(base+'/api/matches').json()['items'])==1
                    assert len(b.request.get(base+'/api/matches').json()['items'])==1
                    assert a.request.get(base+'/api/likes').json()['items']==[]
                    a.reload()
                    expect(a.locator('#trade-card')).to_have_attribute('data-proposal-id',re.compile('.+'))
                    assert 'Tonzcollins' in a.locator('#my-manager').inner_text(), 'Session should survive reload'
                    assert len(a.request.get(base+'/api/matches').json()['items'])==1
                    assert not errors, errors
                    browser.close()
                print('PASS: production server health, desktop/mobile rendering, isolated team sessions, private like, mirrored terms, swipe gesture, mutual alerts for both managers, and match/session persistence after reload.')
                print('Screenshots:',OUTPUT)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill();server.wait()


if __name__=='__main__':
    run()
