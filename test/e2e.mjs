#!/usr/bin/env node
/*
  Full Page Clip — end-to-end check (developer tool, not part of the extension).

  Launches a Chromium build with the extension loaded, opens a test page, triggers the capture
  exactly like the shortcut does (calls run() inside the service worker), prints the result and,
  on macOS, reads the image back from the system clipboard to verify its size.

    node test/e2e.mjs                       # default: test/test-page.html, scale 1x
    node test/e2e.mjs --page test-scroller.html
    node test/e2e.mjs --scale device --zoom 1.25
    node test/e2e.mjs --mode scroll            # force scroll-and-stitch mode (auto | resize | scroll)
    node test/e2e.mjs --insecure            # serve over the LAN IP (http://, not a secure context)
    node test/e2e.mjs --url https://example.com/some/long/page
    node test/e2e.mjs --chrome "/path/to/Chromium" --keep --out ./e2e-out

  Needs a build that honours --load-extension: Chrome for Testing or Chromium.
  (Branded Google Chrome 137+ ignores --load-extension.)  Node 22+ (global fetch/WebSocket).

  Note: the real extension only has "activeTab", which Chrome grants when the user presses the
  shortcut or clicks the icon. Synthesized key events cannot trigger extension commands, so this
  harness loads a TEMP COPY of the extension with host_permissions ["<all_urls>"] added and calls
  run() directly inside the service worker. Everything else (debugger capture, stitching, clipboard)
  is exercised exactly as in real use.
*/
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const opts = parseArgs(process.argv.slice(2));
const outDir = path.resolve(opts.out || path.join(os.tmpdir(), 'full-page-clip-e2e'));
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}

function findChrome() {
  if (opts.chrome) return opts.chrome;
  const home = os.homedir();
  const candidates = [];
  const glob = (dir, fn) => { try { for (const d of fs.readdirSync(dir)) fn(path.join(dir, d), d); } catch (e) { /* none */ } };
  if (process.platform === 'darwin') {
    glob(path.join(home, 'Library/Caches/ms-playwright'), (p, d) => {
      if (!d.startsWith('chromium-')) return;
      for (const sub of ['chrome-mac-arm64', 'chrome-mac']) {
        candidates.push(path.join(p, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
        candidates.push(path.join(p, sub, 'Chromium.app/Contents/MacOS/Chromium'));
      }
    });
    glob(path.join(home, '.cache/puppeteer/chrome'), (p) => {
      candidates.push(path.join(p, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
      candidates.push(path.join(p, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
    });
    candidates.push('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    glob(path.join(local, 'ms-playwright'), (p, d) => { if (d.startsWith('chromium-')) candidates.push(path.join(p, 'chrome-win', 'chrome.exe')); });
    glob(path.join(home, '.cache/puppeteer/chrome'), (p) => candidates.push(path.join(p, 'chrome-win64', 'chrome.exe')));
  } else {
    glob(path.join(home, '.cache/ms-playwright'), (p, d) => { if (d.startsWith('chromium-')) candidates.push(path.join(p, 'chrome-linux', 'chrome')); });
    glob(path.join(home, '.cache/puppeteer/chrome'), (p) => candidates.push(path.join(p, 'chrome-linux64', 'chrome')));
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chromium / Chrome for Testing found. Pass --chrome <path>.');
}

function makeTestCopy(srcDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-page-clip-ext-'));
  for (const name of fs.readdirSync(srcDir)) {
    if (['test', 'scripts', 'node_modules', '.git', 'README.md'].includes(name)) continue;
    fs.cpSync(path.join(srcDir, name), path.join(dir, name), { recursive: true });
  }
  const mp = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function serveDir(dir, host) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const f = path.join(dir, p === '/' ? 'test-page.html' : p);
      if (!f.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.on('error', reject);
    srv.listen(0, host, () => resolve(srv));
  });
}

function lanIp() {
  const all = Object.values(os.networkInterfaces()).flat();
  const hit = all.find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!hit) throw new Error('no LAN IPv4 address found for --insecure');
  return hit.address;
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Set();
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('CDP connection closed')); this.pending.clear(); };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  onMessage(m) {
    if (m.id) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
    } else {
      for (const l of this.listeners) l(m);
    }
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function waitForDevtools(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) { /* not yet */ }
    await sleep(200);
  }
  throw new Error('DevTools endpoint not reachable');
}

function readClipboardImageMac(outPng) {
  const script = (cls) => [
    `set d to the clipboard as «class ${cls}»`,
    `set f to open for access POSIX file "${outPng}" with write permission`,
    'set eof f to 0',
    'write d to f',
    'close access f'
  ].flatMap((l) => ['-e', l]);
  for (const cls of ['PNGf', 'TIFF']) {
    try { execFileSync('osascript', script(cls), { stdio: 'pipe' }); return cls; } catch (e) { /* try next */ }
  }
  return null;
}

function imageSizeMac(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  return { width: w, height: h };
}

async function main() {
  const chrome = findChrome();
  const host = opts.insecure ? '0.0.0.0' : '127.0.0.1';
  const server = await serveDir(here, host);
  const serverHost = opts.insecure ? lanIp() : '127.0.0.1';
  const page = typeof opts.page === 'string' ? opts.page : 'test-page.html';
  const url = typeof opts.url === 'string' ? opts.url : `http://${serverHost}:${server.address().port}/${page}`;
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'full-page-clip-profile-'));
  const loadDir = makeTestCopy(extDir);
  log('chrome:', chrome);
  log('url:', url);
  log('extension (temp copy with host_permissions):', loadDir);

  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${loadDir}`,
    `--disable-extensions-except=${loadDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-features=TranslateUI,MediaRouter', '--password-store=basic',
    '--window-size=1280,900', '--window-position=60,60',
    'about:blank'
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  let cdp;
  let exitCode = 1;
  try {
    const version = await waitForDevtools(port);
    log('browser:', version.Browser);
    cdp = await CDP.connect(version.webSocketDebuggerUrl);

    // 1) find OUR extension's service worker (Chrome ships component extensions with a background.js too)
    const manifestName = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).name;
    const checked = new Set();
    let swSession = null;
    let extId = null;
    const evalIn = async (sessionId, expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error('SW eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
      return r.result.value;
    };
    for (let i = 0; i < 150 && !swSession; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const t of targetInfos) {
        if (t.type !== 'service_worker' || !t.url.startsWith('chrome-extension://') || checked.has(t.targetId)) continue;
        let sessionId = null;
        let name = null;
        try {
          ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }));
          name = await evalIn(sessionId, 'chrome.runtime.getManifest().name');
        } catch (e) { /* worker not ready yet — probe it again on the next round */ }
        if (name === manifestName) { swSession = sessionId; extId = new URL(t.url).host; break; }
        if (name !== null) checked.add(t.targetId); // definitely another extension
        if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      if (!swSession) await sleep(200);
    }
    if (!swSession) throw new Error('extension service worker not found — was the extension loaded? stderr: ' + stderr.slice(-800));
    log('extension id:', extId);
    const evalSW = (expression) => evalIn(swSession, expression);

    // 2) open the page and wait for load, then detach so the extension's debugger can attach
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    let loaded = false;
    for (let i = 0; i < 300 && !loaded; i++) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({ href: location.href, state: document.readyState })', returnByValue: true }, pageSession);
      const { href, state } = JSON.parse(r.result.value);
      loaded = state === 'complete' && href !== 'about:blank' && href.startsWith(url.split('#')[0]);
      if (!loaded) await sleep(100);
    }
    if (!loaded) throw new Error('page did not finish loading: ' + url);
    await sleep(300);
    const dims = (await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({dpr: devicePixelRatio, innerWidth, innerHeight, scrollHeight: document.documentElement.scrollHeight})',
      returnByValue: true
    }, pageSession)).result.value;
    log('page:', dims);
    await cdp.send('Page.bringToFront', {}, pageSession);
    await cdp.send('Target.detachFromTarget', { sessionId: pageSession });

    // 3) settings / zoom, focus the window (clipboard writes need a focused document)
    const settings = { mode: typeof opts.mode === 'string' ? opts.mode : 'auto', scale: typeof opts.scale === 'string' ? opts.scale : '1x', alsoDownload: false, showToast: true, preScroll: true, maxHeight: Number(opts.maxHeight || 20000) };
    await evalSW(`chrome.storage.sync.set(${JSON.stringify(settings)})`);
    if (opts.zoom) {
      const z = await evalSW(`(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.setZoom(t.id, ${Number(opts.zoom)}); return chrome.tabs.getZoom(t.id); })()`);
      log('zoom set to', z);
      await sleep(400);
    }
    await evalSW('(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.windows.update(t.windowId, { focused: true }); return t.url; })()');
    await sleep(400);

    // 4) trigger the capture exactly like the shortcut handler does
    const t0 = Date.now();
    const result = await evalSW('(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return await run(t); })()');
    const elapsed = Date.now() - t0;
    log(`capture result (${elapsed} ms):`);
    console.log(JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

    // 5) verify the clipboard (macOS only)
    let pass = !!(result && result.ok && result.copied);
    if (process.platform === 'darwin') {
      const file = path.join(outDir, 'clipboard.png');
      try { fs.unlinkSync(file); } catch (e) { /* none */ }
      const cls = readClipboardImageMac(file);
      if (!cls) {
        log('clipboard: no image on the clipboard');
        pass = false;
      } else {
        const size = imageSizeMac(file);
        const match = size.width === result.width && size.height === result.height;
        log(`clipboard: ${cls} ${size.width}x${size.height} (${fs.statSync(file).size} bytes) → ${file}`, match ? 'MATCHES result' : 'DOES NOT MATCH result');
        pass = pass && match;
        try {
          execFileSync('sips', ['--resampleWidth', '480', file, '--out', path.join(outDir, 'clipboard-preview.png')], { stdio: 'pipe' });
          log('preview:', path.join(outDir, 'clipboard-preview.png'));
        } catch (e) { /* optional */ }
      }
    } else {
      log('clipboard verification is only automated on macOS; paste into an image editor to check manually.');
    }
    log(pass ? 'PASS' : 'FAIL');
    exitCode = pass ? 0 : 1;
    if (opts.keep) { log('--keep: leaving the browser open; press Ctrl+C to exit'); await new Promise(() => {}); }
  } catch (e) {
    console.error('[e2e] ERROR', e);
    if (stderr) console.error('[e2e] chrome stderr (tail):', stderr.slice(-1500));
  } finally {
    try { if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(3000)]); } catch (e) { /* ignore */ }
    if (cdp) cdp.close();
    await sleep(500);
    try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(loadDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  process.exit(exitCode);
}

main();
