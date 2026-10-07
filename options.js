'use strict';

const DEFAULTS = { mode: 'auto', scale: '1x', maxHeight: 20000, preScroll: true, showToast: true, alsoDownload: false };

const $ = (sel) => document.querySelector(sel);

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;
  for (const r of document.querySelectorAll('input[name=scale]')) r.checked = r.value === s.scale;
  $('#maxHeight').value = s.maxHeight;
  $('#preScroll').checked = !!s.preScroll;
  $('#showToast').checked = !!s.showToast;
  $('#alsoDownload').checked = !!s.alsoDownload;
}

async function save() {
  const modeEl = document.querySelector('input[name=mode]:checked');
  const scaleEl = document.querySelector('input[name=scale]:checked');
  const maxHeight = Math.max(0, Math.floor(Number($('#maxHeight').value) || 0));
  const s = {
    mode: modeEl ? modeEl.value : DEFAULTS.mode,
    scale: scaleEl ? scaleEl.value : DEFAULTS.scale,
    maxHeight,
    preScroll: $('#preScroll').checked,
    showToast: $('#showToast').checked,
    alsoDownload: $('#alsoDownload').checked
  };
  await chrome.storage.sync.set(s);
  const st = $('#status');
  st.textContent = '저장됨';
  setTimeout(() => { st.textContent = ''; }, 1500);
}

async function showShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'capture-full-page');
    $('#shortcut').textContent = c && c.shortcut ? c.shortcut : '설정되지 않음 — 아래 버튼으로 지정하세요';
  } catch (e) {
    $('#shortcut').textContent = '확인 불가';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  showShortcut();
  for (const el of document.querySelectorAll('input')) el.addEventListener('change', save);
  $('#openShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
});
