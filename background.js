// Full Page Clip — service worker (Manifest V3)
//
// One shortcut press:
//   1. Inject helpers into the page (isolated world) and warm up lazy-loaded content.
//   2. Attach the DevTools protocol (chrome.debugger) to the tab and capture the whole document:
//        resize mode  — enlarge the viewport to the document height (Emulation.setDeviceMetricsOverride),
//                       re-measure until the height is stable, capture in vertical chunks. Fast, fixed
//                       elements appear once. Default.
//        scroll mode  — keep the real viewport, scroll step by step and capture each screen
//                       (fixed elements hidden after the first screen). Used automatically when the
//                       document keeps growing with the viewport (100vh-style layouts), or when chosen.
//   3. Detach, stitch chunks in the page, encode PNG, write it to the clipboard.

'use strict';

const DEFAULT_SETTINGS = {
  mode: 'auto',       // 'auto' | 'resize' | 'scroll'
  scale: '1x',        // '1x' (CSS px → image px) | 'device' (keep devicePixelRatio, e.g. 2x on Retina)
  maxHeight: 20000,   // CSS px; 0 = unlimited
  preScroll: true,    // scroll through the page once before capture to trigger lazy loading
  showToast: true,    // in-page confirmation / error message
  alsoDownload: false // also save the PNG via the browser download
};

const CHUNK_HEIGHT = 4000;     // CSS px per Page.captureScreenshot call (resize mode)
const MAX_WIDTH = 10000;       // CSS px
const SETTLE_DELAY_MS = 250;   // after each viewport change
const MAX_RESIZE_ITERATIONS = 3;
const SCROLL_MODE_GROWTH_RATIO = 0.25; // auto mode: document grows ≥ this much per viewport px → scroll mode

class UserError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-full-page') void run(tab);
});

chrome.action.onClicked.addListener((tab) => {
  void run(tab);
});

const inFlight = new Set();

/** Entry point. Returns a result object; never throws (errors are shown to the user). */
async function run(tab) {
  if (!tab || tab.id == null) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  if (!tab || tab.id == null) return { ok: false, error: 'no active tab' };
  if (inFlight.has(tab.id)) return { ok: false, error: 'capture already in progress' };
  inFlight.add(tab.id);
  globalThis.__fullPageClipRuns = (globalThis.__fullPageClipRuns || 0) + 1; // observability (used by test/e2e.mjs)
  globalThis.__fullPageClipLastResult = null;
  await setBadge(tab.id, '…', '#1a73e8');
  let result;
  try {
    result = await captureFullPage(tab);
    await setBadge(tab.id, result.copied ? '✓' : '!', result.copied ? '#188038' : '#d93025');
    setTimeout(() => setBadge(tab.id, '', null), 2500);
  } catch (err) {
    console.error('[Full Page Clip]', err);
    await setBadge(tab.id, '!', '#d93025');
    setTimeout(() => setBadge(tab.id, '', null), 4000);
    await reportError(tab.id, err);
    result = { ok: false, error: String((err && err.message) || err) };
  } finally {
    inFlight.delete(tab.id);
  }
  globalThis.__fullPageClipLastResult = result;
  return result;
}

async function captureFullPage(tab) {
  const tabId = tab.id;
  if (!isCapturableUrl(tab.url)) {
    throw new UserError('이 페이지는 캡처할 수 없습니다 (브라우저 내부 페이지 / 웹 스토어 / 확장 프로그램 페이지)');
  }
  const settings = await getSettings();
  const t0 = Date.now();

  // 1) helpers + lazy-load warm-up (runs inside the page, isolated world)
  await exec(tabId, installHelpers);
  const prep = await exec(tabId, (opts) => window.__fullPageClip.prepare(opts), [{ preScroll: !!settings.preScroll }]);
  if (!prep || !prep.ok) throw new Error('페이지 준비 실패: ' + (prep && prep.error));

  const target = { tabId };
  const ctx = {
    tabId,
    settings,
    cdp: (method, params) => chrome.debugger.sendCommand(target, method, params || {}),
    cap: settings.maxHeight > 0 ? Math.floor(Number(settings.maxHeight)) : Infinity,
    outScale: 1, // set after the zoom factor is known
    zoom: 1,
    overridden: false,
    debug: { prep, timings: {} }
  };

  let attached = false;
  let capture;
  try {
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/already attached/i.test(msg)) {
        throw new UserError('다른 디버거가 이 탭에 연결되어 있습니다. DevTools(개발자 도구)를 닫거나 다른 디버깅 확장을 끄고 다시 시도하세요.');
      }
      throw new UserError('디버거 연결 실패: ' + msg);
    }
    attached = true;
    ctx.zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
    // Page.captureScreenshot takes the clip in device-independent px (CSS px × browser zoom) and
    // renders it at (device scale factor × clip.scale), where the device scale factor excludes zoom.
    // '1x'     → image px = device-independent px (what you see at 100% on a 1x screen)
    // 'device' → image px = physical screen px
    const dsf = (prep.dpr || 1) / ctx.zoom;
    ctx.outScale = settings.scale === 'device' ? 1 : 1 / dsf;
    ctx.debug.scale = { dpr: prep.dpr, zoom: ctx.zoom, dsf, outScale: ctx.outScale };

    let mode = settings.mode === 'scroll' ? 'scroll' : 'resize';
    if (mode === 'resize') {
      capture = await captureByResize(ctx, settings.mode !== 'resize');
      if (capture.useScroll) mode = 'scroll';
    }
    if (mode === 'scroll') {
      if (ctx.overridden) {
        await ctx.cdp('Emulation.clearDeviceMetricsOverride');
        ctx.overridden = false;
        await sleep(SETTLE_DELAY_MS);
      }
      capture = await captureByScroll(ctx);
    }
    ctx.debug.mode = mode;
  } finally {
    if (attached) {
      try { if (ctx.overridden) await ctx.cdp('Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ }
      try { await chrome.debugger.detach(target); } catch (e) { /* ignore */ }
    }
  }
  ctx.debug.timings.capture = Date.now() - t0;

  // 3) stitch + clipboard + restore (page side, after the debugger bar is gone)
  await sleep(60);
  const filename = makeFilename(tab.url || tab.title || 'page');
  const result = await exec(tabId, (opts) => window.__fullPageClip.finish(opts), [
    { showToast: !!settings.showToast, alsoDownload: !!settings.alsoDownload, truncated: capture.truncated, filename }
  ]);
  if (!result || !result.ok) throw new Error('이미지 합치기 실패: ' + (result && result.error));
  ctx.debug.timings.total = Date.now() - t0;
  return { ...result, truncated: capture.truncated, chunks: capture.chunks, cssWidth: capture.width, cssHeight: capture.height, mode: ctx.debug.mode, debug: ctx.debug };
}

// ---------- measurement ----------

async function measure(ctx) {
  const metrics = await ctx.cdp('Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize || {};
  const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  const p = await exec(ctx.tabId, () => window.__fullPageClip.measure());
  const width = Math.max(1, Math.min(MAX_WIDTH, Math.ceil(layout.clientWidth || p.clientWidth || content.width || 1)));
  const height = Math.ceil(Math.max(content.height || 0, p.docHeight || 0, p.scrollerHeight || 0, 1));
  return { width, height, viewportHeight: p.innerHeight, viewportWidth: p.innerWidth };
}

async function setViewport(ctx, width, height) {
  await ctx.cdp('Emulation.setDeviceMetricsOverride', {
    width: Math.round(width * ctx.zoom),
    height: Math.round(height * ctx.zoom),
    deviceScaleFactor: 0,
    mobile: false
  });
  ctx.overridden = true;
  await sleep(SETTLE_DELAY_MS);
  await exec(ctx.tabId, () => window.__fullPageClip.settle(1500));
}

// ---------- resize mode ----------

async function captureByResize(ctx, allowScrollFallback) {
  const { cap } = ctx;
  const steps = [];
  const m0 = await measure(ctx);
  const width = m0.width;
  let truncated = false;
  let prev = { V: m0.viewportHeight, H: m0.height };
  let V = Math.min(m0.height, cap);
  if (m0.height > cap) truncated = true;
  await setViewport(ctx, width, V);
  let H = (await measure(ctx)).height;
  steps.push({ V: prev.V, H: prev.H }, { V, H });

  for (let iter = 0; iter < MAX_RESIZE_ITERATIONS && H > V + 2 && V < cap; iter++) {
    const dV = V - prev.V;
    const b = dV >= 100 ? (H - prev.H) / dV : 0; // document growth per viewport px
    // Document grows with the viewport (vh-sized blocks, 100vh layouts): enlarging the viewport
    // would inflate those blocks (or never contain them), so capture by scrolling instead.
    if (allowScrollFallback && iter === 0 && dV >= 200 && b >= SCROLL_MODE_GROWTH_RATIO) {
      ctx.debug.resize = { steps, b, decision: 'scroll' };
      return { useScroll: true };
    }
    let next = b > 0 && b < 0.9 ? Math.ceil((H - b * V) / (1 - b)) + 2 : H; // secant step to the fixed point
    if (next > cap) { next = cap; truncated = true; }
    prev = { V, H };
    V = next;
    await setViewport(ctx, width, V);
    H = (await measure(ctx)).height;
    steps.push({ V, H, b: Number(b.toFixed(3)) });
  }
  if (H > V + 2 && V >= cap) truncated = true;
  const height = Math.min(H, V);
  ctx.debug.resize = { steps, decision: 'resize' };

  const total = Math.ceil(height / CHUNK_HEIGHT);
  await exec(ctx.tabId, () => window.__fullPageClip.begin());
  for (let i = 0; i < total; i++) {
    const y = i * CHUNK_HEIGHT;
    const h = Math.min(CHUNK_HEIGHT, height - y);
    await captureChunk(ctx, i, { x: 0, y, width, height: h });
  }
  return { width, height, truncated, chunks: total };
}

// ---------- scroll mode ----------

async function captureByScroll(ctx) {
  const { cap } = ctx;
  const begin = await exec(ctx.tabId, () => window.__fullPageClip.scrollBegin());
  if (!begin || !begin.ok) throw new Error('스크롤 캡처 준비 실패: ' + (begin && begin.error));
  await exec(ctx.tabId, () => window.__fullPageClip.begin());
  let captured = 0;
  let width = begin.vw;
  let truncated = false;
  let i = 0;
  try {
    for (;;) {
      const step = await exec(ctx.tabId, (idx, remaining) => window.__fullPageClip.scrollStep(idx, remaining), [i, cap - captured]);
      if (!step || !step.ok) throw new Error('스크롤 캡처 실패: ' + (step && step.error));
      if (step.done) break;
      await sleep(40);
      await captureChunk(ctx, i, step.clip);
      captured += step.clip.height;
      width = Math.max(width, Math.ceil(step.clip.width));
      i++;
      if (captured >= cap) { truncated = true; break; }
      if (i > 400) break;
    }
  } finally {
    await exec(ctx.tabId, () => window.__fullPageClip.scrollEnd()).catch(() => {});
  }
  ctx.debug.scroll = { chunks: i, captured, vw: begin.vw, vh: begin.vh, total: begin.total, scroller: begin.scroller };
  return { width, height: captured, truncated, chunks: i };
}

// `clip` is in CSS px (document coordinates); the protocol wants device-independent px.
async function captureChunk(ctx, index, clip) {
  const z = ctx.zoom;
  const shot = await ctx.cdp('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x * z, y: clip.y * z, width: clip.width * z, height: clip.height * z, scale: ctx.outScale },
    captureBeyondViewport: false,
    fromSurface: true
  });
  const r = await exec(ctx.tabId, (idx, url) => window.__fullPageClip.addChunk(idx, url), [index, 'data:image/png;base64,' + shot.data]);
  if (!r || !r.ok) throw new Error('캡처 조각 디코딩 실패: ' + (r && r.error));
}

// ---------- helpers (service worker side) ----------

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function isCapturableUrl(url) {
  if (!url) return true; // unknown → let it try
  if (/^(chrome|chrome-extension|chrome-untrusted|edge|about|devtools|view-source|chrome-search|chrome-error):/i.test(url)) return false;
  if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url)) return false;
  return true;
}

function makeFilename(urlOrTitle) {
  let host = 'page';
  try { host = new URL(urlOrTitle).hostname || host; } catch (e) { host = String(urlOrTitle).slice(0, 40); }
  host = host.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '_');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `fullpage-${host}-${stamp}.png`;
}

async function exec(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func,
    args: args || []
  });
  return res ? res.result : undefined;
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (e) { /* tab may be gone */ }
}

async function reportError(tabId, err) {
  const msg = err instanceof UserError ? err.message : '캡처 실패: ' + String((err && err.message) || err);
  try {
    await exec(tabId, installHelpers);
    await exec(tabId, (text) => window.__fullPageClip.toast(text, 'error'), [msg]);
  } catch (e) {
    try { await chrome.action.setTitle({ tabId, title: 'Full Page Clip — ' + msg }); } catch (e2) { /* ignore */ }
  }
}

// ---------- page-side helpers (serialized into the tab's isolated world) ----------
// NOTE: this function must be self-contained: it is stringified and executed inside the page.

function installHelpers() {
  const W = window;
  const D = document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

  const prevState = W.__fullPageClip && W.__fullPageClip.state;
  const state = { chunks: [], savedScroll: null, scroller: null, styleBackup: [], scroll: null };
  if (prevState && prevState.styleBackup && prevState.styleBackup.length) restoreStyles(prevState); // crash recovery
  for (const el of D.querySelectorAll('style[data-full-page-clip-style]')) el.remove();

  function docHeight() {
    const de = D.documentElement;
    const b = D.body;
    return Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0, de ? de.offsetHeight : 0);
  }

  // Apps that scroll inside a container (not the window): find the dominant scroller.
  function findMainScroller() {
    const vh = W.innerHeight;
    const vw = W.innerWidth;
    let best = null;
    let bestHeight = 0;
    const all = D.querySelectorAll('body *');
    const n = Math.min(all.length, 20000);
    for (let i = 0; i < n; i++) {
      const el = all[i];
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      if (ch < vh * 0.5 || sh <= ch + 100) continue;
      if (el.clientWidth < vw * 0.4) continue;
      const ov = getComputedStyle(el).overflowY;
      if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') continue;
      if (sh > bestHeight) { best = el; bestHeight = sh; }
    }
    return best;
  }

  function scrollerTargetHeight(el) {
    if (!el) return 0;
    const top = el.getBoundingClientRect().top + W.scrollY;
    return Math.ceil(el.scrollHeight + Math.max(0, top));
  }

  function waitForImages(timeoutMs) {
    const pending = [];
    for (const img of D.images) {
      if (img.complete || !img.getAttribute('src')) continue;
      pending.push(new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }));
    }
    if (!pending.length) return Promise.resolve(0);
    return Promise.race([Promise.all(pending).then(() => pending.length), sleep(timeoutMs).then(() => -pending.length)]);
  }

  function measure() {
    return {
      ok: true,
      innerWidth: W.innerWidth,
      innerHeight: W.innerHeight,
      clientWidth: D.documentElement.clientWidth,
      clientHeight: D.documentElement.clientHeight,
      docHeight: docHeight(),
      scrollerHeight: scrollerTargetHeight(state.scroller)
    };
  }

  async function prepare(opts) {
    try {
      state.savedScroll = { x: W.scrollX, y: W.scrollY };
      state.scroller = findMainScroller();
      if (state.scroller) state.savedScroll.scrollerTop = state.scroller.scrollTop;

      // Make native lazy-loading images/iframes load now.
      try {
        for (const el of D.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) el.loading = 'eager';
      } catch (e) { /* ignore */ }

      if (opts && opts.preScroll) {
        const vh = Math.max(W.innerHeight, 200);
        const targets = [{ get total() { return docHeight(); }, set(y) { W.scrollTo({ top: y, left: 0, behavior: 'instant' }); } }];
        if (state.scroller) {
          const el = state.scroller;
          targets.push({ get total() { return el.scrollHeight; }, set(y) { el.scrollTop = y; } });
        }
        for (const t of targets) {
          const total = t.total;
          if (total <= vh + 10) continue;
          const steps = Math.min(Math.ceil(total / vh), 80);
          const stepSize = Math.max(vh, total / steps);
          for (let i = 1; i <= steps; i++) {
            t.set(Math.min(i * stepSize, t.total));
            await nextFrame();
            await sleep(40);
          }
          t.set(0);
        }
      }
      W.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      if (state.scroller) state.scroller.scrollTop = 0;
      await nextFrame();
      await waitForImages(1500);
      await nextFrame();
      return { ...measure(), dpr: W.devicePixelRatio || 1, scroller: !!state.scroller };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function settle(timeoutMs) {
    try {
      await nextFrame();
      const imgs = await waitForImages(timeoutMs);
      await nextFrame();
      return { ...measure(), imagesWaited: imgs };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ----- scroll mode -----

  function backupStyle(el) {
    state.styleBackup.push({ el, position: el.style.position, top: el.style.top, visibility: el.style.visibility });
  }

  // After the first screen: hide fixed elements (they would repeat on every screen) and un-stick
  // sticky ones (they stay at their natural place in the flow).
  function neutralizeFixedElements() {
    const all = D.querySelectorAll('body *');
    const n = Math.min(all.length, 20000);
    for (let i = 0; i < n; i++) {
      const el = all[i];
      if (el.hasAttribute('data-full-page-clip-toast')) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed') {
        backupStyle(el);
        el.style.visibility = 'hidden';
      } else if (pos === 'sticky') {
        backupStyle(el);
        el.style.position = 'relative';
        el.style.top = 'auto';
      }
    }
  }

  function restoreStyles(st) {
    for (const s of st.styleBackup) {
      try {
        s.el.style.position = s.position;
        s.el.style.top = s.top;
        s.el.style.visibility = s.visibility;
      } catch (e) { /* ignore */ }
    }
    st.styleBackup = [];
  }

  function hideScrollbars() {
    removeScrollbarStyle();
    const st = D.createElement('style');
    st.setAttribute('data-full-page-clip-style', '');
    st.textContent = '*, html, body { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
    (D.head || D.documentElement).appendChild(st);
  }

  function removeScrollbarStyle() {
    for (const el of D.querySelectorAll('style[data-full-page-clip-style]')) el.remove();
  }

  async function scrollBegin() {
    try {
      restoreStyles(state);
      hideScrollbars();
      W.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      if (state.scroller) state.scroller.scrollTop = 0;
      await nextFrame();
      await nextFrame();
      const de = D.documentElement;
      state.scroll = { nextY: 0, fixedHandled: false };
      const el = state.scroller;
      const total = el ? scrollerTargetHeight(el) : docHeight();
      return { ok: true, vw: de.clientWidth, vh: de.clientHeight, total, scroller: !!el };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Returns the next region to capture, in document coordinates, after scrolling it into view.
  async function scrollStep(index, remaining) {
    try {
      const s = state.scroll;
      const de = D.documentElement;
      const vw = de.clientWidth;
      const vh = de.clientHeight;
      const el = state.scroller;
      if (!el) {
        const total = docHeight();
        if (s.nextY >= total || remaining <= 0) return { ok: true, done: true };
        W.scrollTo({ top: s.nextY, left: 0, behavior: 'instant' });
        if (index > 0 && !s.fixedHandled) { neutralizeFixedElements(); s.fixedHandled = true; }
        await nextFrame();
        await nextFrame();
        const actual = W.scrollY;
        // Sub-pixel leftovers happen with browser zoom (fractional scroll positions): stop below 1px.
        const h = Math.floor(Math.min(vh, docHeight() - s.nextY, remaining, actual + vh - s.nextY));
        if (h < 1) return { ok: true, done: true };
        const clip = { x: 0, y: s.nextY, width: vw, height: h };
        s.nextY += h;
        return { ok: true, done: false, clip };
      }
      // Scrolling container: screen 0 is the whole viewport, then the container's content screen by screen.
      if (index === 0) {
        el.scrollTop = 0;
        W.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        await nextFrame();
        await nextFrame();
        const r = el.getBoundingClientRect();
        s.nextTop = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)); // container px already shown
        return { ok: true, done: false, clip: { x: 0, y: 0, width: vw, height: Math.min(vh, remaining) } };
      }
      if (s.nextTop >= el.scrollHeight || remaining <= 0) return { ok: true, done: true };
      el.scrollTop = s.nextTop;
      if (!s.fixedHandled) { neutralizeFixedElements(); s.fixedHandled = true; }
      await nextFrame();
      await nextFrame();
      const actual = el.scrollTop;
      const r = el.getBoundingClientRect();
      const visTop = Math.max(r.top, 0);
      const visBottom = Math.min(r.bottom, vh);
      const offset = s.nextTop - actual; // content px of the visible box that were already captured
      const h = Math.floor(Math.min(el.scrollHeight - s.nextTop, visBottom - visTop - offset, remaining));
      if (h < 1) return { ok: true, done: true };
      const clip = { x: Math.max(0, r.left), y: visTop + offset + W.scrollY, width: Math.min(r.width, vw), height: h };
      s.nextTop += h;
      return { ok: true, done: false, clip };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function scrollEnd() {
    restoreStyles(state);
    removeScrollbarStyle();
    return { ok: true };
  }

  // ----- chunks / stitching -----

  function begin() {
    for (const c of state.chunks) { try { c && c.close && c.close(); } catch (e) { /* ignore */ } }
    state.chunks = [];
    return { ok: true };
  }

  async function addChunk(index, dataUrl) {
    try {
      let bmp;
      try {
        const blob = await (await fetch(dataUrl)).blob();
        bmp = await createImageBitmap(blob);
      } catch (e) {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        bmp = await createImageBitmap(img);
      }
      state.chunks[index] = bmp;
      return { ok: true, width: bmp.width, height: bmp.height };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function restoreScroll() {
    try {
      const s = state.savedScroll;
      if (!s) return;
      W.scrollTo({ top: s.y, left: s.x, behavior: 'instant' });
      if (state.scroller && s.scrollerTop != null) state.scroller.scrollTop = s.scrollerTop;
    } catch (e) { /* ignore */ }
  }

  async function copyViaClipboardApi(blob) {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('Clipboard API unavailable (insecure context)');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  // Fallback for http:// pages: an extension-origin iframe is a secure context.
  function copyViaExtensionFrame(blob, timeoutMs) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = chrome.runtime.getURL('clipboard.html'); } catch (e) { reject(e); return; }
      const origin = new URL(url).origin;
      const frame = D.createElement('iframe');
      frame.setAttribute('allow', 'clipboard-write');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.01;border:0;z-index:2147483647;';
      const prev = D.activeElement;
      let done = false;
      let timer = null;
      const cleanup = () => {
        W.removeEventListener('message', onMsg);
        frame.remove();
        try { if (prev && prev.focus) prev.focus(); } catch (e) { /* ignore */ }
      };
      const onMsg = (ev) => {
        if (ev.origin !== origin || ev.source !== frame.contentWindow) return;
        const d = ev.data;
        if (!d || d.__fullPageClip !== 'copy-result') return;
        done = true;
        clearTimeout(timer);
        cleanup();
        if (d.ok) resolve(); else reject(new Error(d.error || 'copy failed in extension frame'));
      };
      timer = setTimeout(() => { if (!done) { cleanup(); reject(new Error('extension frame timeout')); } }, timeoutMs || 8000);
      W.addEventListener('message', onMsg);
      frame.addEventListener('load', () => {
        try {
          frame.focus();
          frame.contentWindow.postMessage({ __fullPageClip: 'copy', blob }, origin);
        } catch (e) {
          clearTimeout(timer);
          cleanup();
          reject(e);
        }
      }, { once: true });
      frame.src = url;
      (D.body || D.documentElement).appendChild(frame);
    });
  }

  function downloadBlob(blob, filename) {
    const a = D.createElement('a');
    const u = URL.createObjectURL(blob);
    a.href = u;
    a.download = filename || 'fullpage.png';
    a.style.display = 'none';
    (D.body || D.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  }

  async function finish(opts) {
    opts = opts || {};
    const chunks = state.chunks.filter(Boolean);
    restoreStyles(state);
    removeScrollbarStyle();
    restoreScroll();
    if (!chunks.length) return { ok: false, error: 'no captured chunks' };
    try {
      const width = Math.max(...chunks.map((c) => c.width));
      const height = chunks.reduce((s, c) => s + c.height, 0);

      // Stay inside Chrome's canvas limits (area 16384², side 32767).
      const MAX_AREA = 268435456;
      const MAX_SIDE = 32767;
      let k = 1;
      if (width * height > MAX_AREA || height > MAX_SIDE || width > MAX_SIDE) {
        k = Math.min(Math.sqrt(MAX_AREA / (width * height)), MAX_SIDE / height, MAX_SIDE / width);
      }
      const cw = Math.max(1, Math.floor(width * k));
      const ch = Math.max(1, Math.floor(height * k));
      const canvas = D.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      let y = 0;
      for (const c of chunks) {
        const y0 = Math.round(y * k);
        const y1 = Math.round((y + c.height) * k);
        ctx.drawImage(c, 0, 0, c.width, c.height, 0, y0, Math.round(c.width * k), Math.max(1, y1 - y0));
        y += c.height;
        try { c.close(); } catch (e) { /* ignore */ }
      }
      state.chunks = [];
      const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 인코딩 실패'))), 'image/png'));
      canvas.width = 0;
      canvas.height = 0;

      let copied = false;
      let method = null;
      const errors = [];
      try {
        await copyViaClipboardApi(blob);
        copied = true;
        method = 'clipboard';
      } catch (e) {
        errors.push('clipboard: ' + String((e && e.message) || e));
        try {
          await copyViaExtensionFrame(blob, 8000);
          copied = true;
          method = 'frame';
        } catch (e2) {
          errors.push('frame: ' + String((e2 && e2.message) || e2));
        }
      }

      let downloaded = false;
      if (opts.alsoDownload || !copied) {
        try { downloadBlob(blob, opts.filename); downloaded = true; } catch (e) { errors.push('download: ' + String((e && e.message) || e)); }
      }

      if (opts.showToast) {
        const paste = isMac ? '⌘V' : 'Ctrl+V';
        const size = `${cw}×${ch}px`;
        const notes = [];
        if (opts.truncated) notes.push('최대 높이 제한으로 아래쪽이 잘렸습니다');
        if (k < 1) notes.push('크기 제한으로 축소됨');
        if (copied) {
          let text = `전체 페이지 복사 완료 · ${size} · ${paste} 로 붙여넣기`;
          if (downloaded) text += ' · PNG 저장됨';
          if (notes.length) text += ' (' + notes.join(', ') + ')';
          toast(text, 'ok');
        } else if (downloaded) {
          toast(`클립보드 복사 실패 → PNG 파일로 저장했습니다 (${size}). 페이지를 한 번 클릭한 뒤 다시 시도해 보세요.`, 'warn');
        } else {
          toast('클립보드 복사 실패: ' + errors.join(' / '), 'error');
        }
      }
      return { ok: true, copied, method, downloaded, width: cw, height: ch, bytes: blob.size, scaledDown: k < 1, errors };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function toast(text, kind) {
    try {
      for (const old of D.querySelectorAll('[data-full-page-clip-toast]')) old.remove();
      const host = D.createElement('div');
      host.setAttribute('data-full-page-clip-toast', '');
      host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      const box = D.createElement('div');
      const bg = kind === 'error' ? '#b3261e' : kind === 'warn' ? '#8a5a00' : '#1f1f1f';
      box.style.cssText =
        'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;' +
        `color:#fff;background:${bg};padding:10px 14px;border-radius:10px;max-width:420px;` +
        'box-shadow:0 6px 24px rgba(0,0,0,.28);opacity:0;transform:translateY(-6px);' +
        'transition:opacity .18s ease,transform .18s ease;white-space:pre-wrap;word-break:keep-all;';
      box.textContent = text;
      root.appendChild(box);
      (D.body || D.documentElement).appendChild(host);
      requestAnimationFrame(() => { box.style.opacity = '1'; box.style.transform = 'translateY(0)'; });
      const ttl = kind === 'ok' ? 3200 : 7000;
      setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => host.remove(), 250);
      }, ttl);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  W.__fullPageClip = { state, prepare, measure, settle, begin, addChunk, scrollBegin, scrollStep, scrollEnd, finish, toast };
  return { ok: true };
}
