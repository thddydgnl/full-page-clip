// Full Page Clip — clipboard helper frame.
// Loaded as a tiny invisible iframe by the page-side helper on pages where the page itself
// cannot use navigator.clipboard (http:// pages are not secure contexts). The extension origin is.
'use strict';

window.addEventListener('message', async (ev) => {
  const d = ev.data;
  if (!d || d.__fullPageClip !== 'copy' || !(d.blob instanceof Blob)) return;
  let ok = false;
  let error = null;
  try {
    window.focus();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': d.blob })]);
    ok = true;
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const target = ev.origin && ev.origin !== 'null' ? ev.origin : '*';
  try { ev.source.postMessage({ __fullPageClip: 'copy-result', ok, error }, target); } catch (e) { /* ignore */ }
});
