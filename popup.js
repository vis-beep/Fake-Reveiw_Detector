/**
 * TrueScore – popup.js
 * =====================
 * Drives the browser action popup UI.
 * Communicates with background.js to display the last scan results,
 * and with the active tab to re-trigger scans.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const toggleEl     = document.getElementById('toggle-enabled');
const statusBanner = document.getElementById('status-banner');
const statusIcon   = document.getElementById('status-icon');
const statusText   = document.getElementById('status-text');
const resultsPanel = document.getElementById('results-panel');
const resOriginal  = document.getElementById('res-original');
const resTrueScore = document.getElementById('res-truescore');
const resTotal     = document.getElementById('res-total');
const resFake      = document.getElementById('res-fake');
const resReal      = document.getElementById('res-real');
const resMeta      = document.getElementById('res-meta');

// ─── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadToggleState();
  loadScanResults();
});

// ─── Toggle (Enable/Disable Extension) ───────────────────────────────────────

function loadToggleState() {
  chrome.storage.local.get('enabled', (data) => {
    toggleEl.checked = data.enabled !== false;
  });
}

toggleEl.addEventListener('change', () => {
  chrome.runtime.sendMessage(
    { type: 'TOGGLE_ENABLED' },
    (response) => {
      if (chrome.runtime.lastError) return;
      toggleEl.checked = response?.enabled ?? toggleEl.checked;
      setStatus(
        response?.enabled ? 'status-idle' : 'status-warning',
        response?.enabled ? '🟢' : '🔴',
        response?.enabled
          ? 'TrueScore is active. Visit an Amazon product page.'
          : 'TrueScore is disabled. Toggle to re-enable.'
      );
    }
  );
});

// ─── Load & Render Last Scan Results ─────────────────────────────────────────

function loadScanResults() {
  chrome.runtime.sendMessage({ type: 'GET_SCAN_RESULTS' }, (response) => {
    if (chrome.runtime.lastError || !response?.results) {
      setStatus('status-idle', '🔄', 'Navigate to an Amazon product page to scan reviews.');
      return;
    }

    const r = response.results;

    getCurrentTabUrl((currentUrl) => {
      if (currentUrl && !currentUrl.includes(getDomain(r.url))) {
        setStatus('status-idle', '🔄', 'Open an Amazon product page to see TrueScore results.');
        return;
      }
      renderResults(r);
    });
  });
}

function renderResults(r) {
  resultsPanel.classList.remove('hidden');

  resOriginal.textContent  = r.originalRating ?? '–';
  resTrueScore.textContent = r.trueScore       ?? '–';
  resTotal.textContent     = r.total            ?? '0';
  resFake.textContent      = r.fakeCount        ?? '0';
  resReal.textContent      = r.realCount        ?? '0';

  const ts = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '';
  resMeta.textContent = ts ? `Last scanned at ${ts}` : '';

  const hasFakes = (r.fakeCount ?? 0) > 0;
  setStatus(
    hasFakes ? 'status-warning' : 'status-success',
    hasFakes ? '⚠️' : '✅',
    hasFakes
      ? `Found ${r.fakeCount} potentially fake review${r.fakeCount > 1 ? 's' : ''} on this page.`
      : 'All reviews appear authentic on this page.'
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(className, icon, text) {
  statusBanner.className = `status-banner ${className}`;
  statusIcon.textContent = icon;
  statusText.textContent = text;
}

function getCurrentTabUrl(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    callback(tabs[0]?.url ?? null);
  });
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
