/**
 * TrueScore – background.js (Service Worker)
 * ============================================
 * Handles cross-tab state management, badge updates,
 * and acts as a relay for future API calls if needed.
 */

// ─── Lifecycle ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TrueScore] Extension installed and ready.');

  // Set default storage values on first install
  chrome.storage.local.set({
    enabled: true,
    totalAnalyzed: 0,
    totalFlagged: 0
  });
});

// ─── Message Listener ────────────────────────────────────────────────────────

/**
 * Listens for messages from content.js or popup.js.
 * Acts as the central hub for communication between extension parts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Handler: Update badge with fake review count ──
  if (message.type === 'UPDATE_BADGE') {
    const { fakeCount, tabId } = message.payload;
    const resolvedTabId = tabId ?? sender.tab?.id;

    if (resolvedTabId) {
      // Show the count of fake reviews on the extension badge
      chrome.action.setBadgeText({
        text: fakeCount > 0 ? String(fakeCount) : '',
        tabId: resolvedTabId
      });
      chrome.action.setBadgeBackgroundColor({
        color: fakeCount > 0 ? '#E53E3E' : '#48BB78',
        tabId: resolvedTabId
      });
    }
    sendResponse({ success: true });
  }

  // ── Handler: Persist scan results for popup display ──
  if (message.type === 'SAVE_SCAN_RESULTS') {
    const results = message.payload;
    chrome.storage.local.set({ lastScanResults: results }, () => {
      sendResponse({ success: true });
    });
    return true; // Keep channel open for async response
  }

  // ── Handler: Get scan results (called by popup.js) ──
  if (message.type === 'GET_SCAN_RESULTS') {
    chrome.storage.local.get('lastScanResults', (data) => {
      sendResponse({ results: data.lastScanResults || null });
    });
    return true; // Keep channel open for async response
  }

  // ── Handler: Toggle extension on/off ──
  if (message.type === 'TOGGLE_ENABLED') {
    chrome.storage.local.get('enabled', (data) => {
      const newState = !data.enabled;
      chrome.storage.local.set({ enabled: newState });
      sendResponse({ enabled: newState });
    });
    return true;
  }

  return true; // Default: keep message channel open
});
