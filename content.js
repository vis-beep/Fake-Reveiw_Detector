/**
 * TrueScore – content.js
 * =======================
 * Core logic: Scrapes Amazon reviews, analyzes them for authenticity,
 * modifies the DOM to flag fakes, and injects the TrueScore widget.
 *
 * Execution flow:
 *  1. Wait for review elements to appear (MutationObserver + setInterval fallback)
 *  2. Extract text and star rating from each review card
 *  3. Run each review through analyzeReview() — mock or real API
 *  4. Apply visual flags to fake reviews
 *  5. Calculate TrueScore and inject floating widget
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const TRUESCORE_WIDGET_ID   = 'truescore-widget';
const TRUESCORE_PROCESSED   = 'data-truescore-processed';
const MAX_OBSERVER_WAIT_MS  = 15000; // 15 seconds max wait
const SCAN_DEBOUNCE_MS      = 800;   // Debounce re-scans on DOM changes

/**
 * Amazon review card selectors.
 * Amazon A/B tests layouts frequently — we try multiple selectors for resilience.
 */
const SELECTORS = {
  reviewContainer:  '[data-hook="reviews-medley-footer"], #cm_cr-review_list, .reviewNumericalSummary',
  reviewCard:       '[data-hook="review"], .review, .a-section.review',
  reviewBody:       '[data-hook="review-body"], .review-text-content, .reviewText',
  reviewStars:      '[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], .review-rating',
  reviewerName:     '.a-profile-name, [data-hook="genome-widget"] .a-profile-name',
  reviewTitle:      '[data-hook="review-title"], .review-title',
  ratingSummary:    '#averageCustomerReviews, [data-hook="rating-out-of-text"]',
  reviewsSection:   '#reviewsMedley, #customerReviews, [data-hook="reviews-medley-footer"]'
};

// ─── Mock Fake-Word Dictionary ────────────────────────────────────────────────
// These phrases are statistically over-represented in fake/incentivised reviews.
const FAKE_TRIGGER_PHRASES = [
  'highly recommend', 'highly recommended',
  'amazing product', 'amazing quality',
  'perfect product', 'works perfectly',
  'best product', 'best purchase',
  'love this product', 'love it',
  'exceeded my expectations',
  'five stars', '5 stars',
  'must buy', 'must have',
  'waste of money',
  'do not buy',
  'game changer', 'game-changer',
  'absolutely love',
  'very happy with',
  'exactly as described',
  'fast shipping',
  'great seller'
];

// ─── State ───────────────────────────────────────────────────────────────────

let scanInProgress  = false;
let debounceTimer   = null;

// ─── Entry Point ─────────────────────────────────────────────────────────────

init();

function init() {
  chrome.storage.local.get('enabled', (data) => {
    if (data.enabled === false) {
      console.log('[TrueScore] Extension is disabled. Skipping scan.');
      return;
    }
    waitForReviewsAndScan();
  });
}

// ─── 1. DOM Readiness: Observer + Interval Fallback ──────────────────────────

function waitForReviewsAndScan() {
  let resolved = false;

  // ── Strategy A: MutationObserver ──
  const observer = new MutationObserver((mutations, obs) => {
    const cards = document.querySelectorAll(SELECTORS.reviewCard);
    if (cards.length > 0) {
      obs.disconnect();
      if (!resolved) {
        resolved = true;
        clearInterval(fallbackInterval);
        debouncedScan();
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree:   true
  });

  // ── Strategy B: setInterval Fallback ──
  const fallbackInterval = setInterval(() => {
    const cards = document.querySelectorAll(SELECTORS.reviewCard);
    if (cards.length > 0 && !resolved) {
      resolved = true;
      clearInterval(fallbackInterval);
      observer.disconnect();
      debouncedScan();
    }
  }, 1500);

  // ── Timeout Safety ──
  setTimeout(() => {
    if (!resolved) {
      observer.disconnect();
      clearInterval(fallbackInterval);
      console.warn('[TrueScore] Timed out waiting for reviews. This may not be a review page.');
    }
  }, MAX_OBSERVER_WAIT_MS);

  // ── Re-scan on significant DOM mutations (pagination, "load more") ──
  const rescanObserver = new MutationObserver(() => {
    debouncedScan();
  });

  setTimeout(() => {
    const reviewSection = document.querySelector(SELECTORS.reviewsSection);
    if (reviewSection) {
      rescanObserver.observe(reviewSection, { childList: true, subtree: true });
    }
  }, MAX_OBSERVER_WAIT_MS / 2);
}

function debouncedScan() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runScan, SCAN_DEBOUNCE_MS);
}

// ─── 2. Main Scan Orchestrator ────────────────────────────────────────────────

async function runScan() {
  if (scanInProgress) return;
  scanInProgress = true;

  console.log('[TrueScore] Starting review scan...');

  try {
    const reviewCards = document.querySelectorAll(SELECTORS.reviewCard);

    if (reviewCards.length === 0) {
      console.log('[TrueScore] No review cards found on this page.');
      return;
    }

    const results = {
      total:          reviewCards.length,
      fakeCount:      0,
      realCount:      0,
      realRatings:    [],
      originalRating: extractOriginalRating()
    };

    const analysisPromises = Array.from(reviewCards).map(card =>
      processReviewCard(card, results)
    );

    await Promise.allSettled(analysisPromises);

    injectTrueScoreWidget(results);
    reportResultsToBackground(results);

    console.log(`[TrueScore] Scan complete. Fake: ${results.fakeCount}, Real: ${results.realCount}`);

  } catch (err) {
    console.error('[TrueScore] Scan failed:', err);
  } finally {
    scanInProgress = false;
  }
}

// ─── 3. Per-Review Processing ─────────────────────────────────────────────────

async function processReviewCard(card, results) {
  if (card.getAttribute(TRUESCORE_PROCESSED) === 'true') {
    const wasFlagged = card.getAttribute('data-truescore-fake') === 'true';
    if (!wasFlagged) {
      const rating = extractStarRating(card);
      if (rating) results.realRatings.push(rating);
    }
    return;
  }

  const bodyEl  = card.querySelector(SELECTORS.reviewBody);
  const titleEl = card.querySelector(SELECTORS.reviewTitle);
  const reviewText = [
    titleEl?.textContent?.trim() ?? '',
    bodyEl?.textContent?.trim()  ?? ''
  ].join(' ').trim();

  if (!reviewText) {
    card.setAttribute(TRUESCORE_PROCESSED, 'true');
    return;
  }

  const starRating = extractStarRating(card);

  let isFake = false;
  try {
    isFake = await analyzeReview(reviewText);
  } catch (err) {
    console.warn('[TrueScore] analyzeReview() threw an error:', err);
    isFake = false;
  }

  card.setAttribute(TRUESCORE_PROCESSED, 'true');
  card.setAttribute('data-truescore-fake', String(isFake));

  if (isFake) {
    results.fakeCount++;
    applyFakeReviewStyles(card);
  } else {
    results.realCount++;
    if (starRating) results.realRatings.push(starRating);
    applyRealReviewStyles(card);
  }
}

// ─── 4. ★ FAKE REVIEW ANALYSIS ENGINE ★ ─────────────────────────────────────
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  HOW TO CONNECT YOUR PYTHON BACKEND:                                    ║
// ║                                                                          ║
// ║  Replace the mock block below with this real fetch() call:              ║
// ║                                                                          ║
// ║     const response = await fetch('http://localhost:8000/analyze', {     ║
// ║       method:  'POST',                                                   ║
// ║       headers: { 'Content-Type': 'application/json' },                  ║
// ║       body:    JSON.stringify({ review_text: text })                    ║
// ║     });                                                                  ║
// ║     if (!response.ok) throw new Error('API error: ' + response.status); ║
// ║     const data = await response.json();                                  ║
// ║     return data.is_fake === true;                                        ║
// ║                                                                          ║
// ║  Also add "http://localhost:8000/*" to host_permissions in manifest.json║
// ╚══════════════════════════════════════════════════════════════════════════╝

async function analyzeReview(text) {

  // ── MOCK LOGIC START ── (Delete this block when connecting real API)
  await simulateDelay(50, 200);

  const normalizedText = text.toLowerCase();

  const hasFakePhrases = FAKE_TRIGGER_PHRASES.some(phrase =>
    normalizedText.includes(phrase)
  );

  const isTooShort = text.trim().length < 20;
  const randomFlag = Math.random() < 0.30;

  return hasFakePhrases || isTooShort || randomFlag;
  // ── MOCK LOGIC END ──

}

function simulateDelay(minMs, maxMs) {
  const ms = Math.random() * (maxMs - minMs) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 5. DOM Helpers ──────────────────────────────────────────────────────────

function extractStarRating(card) {
  try {
    const starEl = card.querySelector(SELECTORS.reviewStars);
    if (!starEl) return null;

    const ariaLabel = starEl.getAttribute('aria-label') || starEl.textContent || '';
    const match = ariaLabel.match(/(\d+(\.\d+)?)\s*out\s*of\s*5/i);
    if (match) return parseFloat(match[1]);

    const classList = [...(starEl.classList || [])];
    for (const cls of classList) {
      const clsMatch = cls.match(/a-star-(\d+)(?:-(\d+))?/);
      if (clsMatch) {
        const whole = parseInt(clsMatch[1], 10);
        const frac  = clsMatch[2] ? parseInt(clsMatch[2], 10) / 10 : 0;
        return whole + frac;
      }
    }
  } catch (e) {
    // Silently fail
  }
  return null;
}

function extractOriginalRating() {
  try {
    const el = document.querySelector(SELECTORS.ratingSummary);
    if (!el) return 'N/A';
    const text  = el.getAttribute('aria-label') || el.textContent || '';
    const match = text.match(/(\d+(\.\d+)?)/);
    return match ? match[1] : 'N/A';
  } catch (e) {
    return 'N/A';
  }
}

// ─── 6. Visual Injection ─────────────────────────────────────────────────────

function applyFakeReviewStyles(card) {
  card.classList.add('truescore-fake-review');

  const body = card.querySelector(SELECTORS.reviewBody);
  if (body) body.classList.add('truescore-fake-body');

  const nameEl = card.querySelector(SELECTORS.reviewerName);
  if (nameEl && !nameEl.querySelector('.truescore-fake-badge')) {
    const badge = document.createElement('span');
    badge.className  = 'truescore-fake-badge';
    badge.textContent = '⚠️ AI-Generated / Fake Review Detected';
    nameEl.insertAdjacentElement('afterend', badge);
  }
}

function applyRealReviewStyles(card) {
  card.classList.add('truescore-real-review');

  const nameEl = card.querySelector(SELECTORS.reviewerName);
  if (nameEl && !nameEl.querySelector('.truescore-real-badge')) {
    const badge = document.createElement('span');
    badge.className  = 'truescore-real-badge';
    badge.textContent = '✅ Verified Authentic';
    nameEl.insertAdjacentElement('afterend', badge);
  }
}

// ─── 7. TrueScore Widget ─────────────────────────────────────────────────────

function injectTrueScoreWidget(results) {
  const existing = document.getElementById(TRUESCORE_WIDGET_ID);
  if (existing) existing.remove();

  const trueScore = results.realRatings.length > 0
    ? (results.realRatings.reduce((sum, r) => sum + r, 0) / results.realRatings.length).toFixed(1)
    : 'N/A';

  const trueStars     = renderStars(parseFloat(trueScore));
  const originalStars = renderStars(parseFloat(results.originalRating));
  const percentFake   = results.total > 0
    ? Math.round((results.fakeCount / results.total) * 100)
    : 0;

  const widget = document.createElement('div');
  widget.id        = TRUESCORE_WIDGET_ID;
  widget.className = 'truescore-widget';
  widget.setAttribute('role', 'complementary');
  widget.setAttribute('aria-label', 'TrueScore fake review analysis results');

  widget.innerHTML = `
    <div class="truescore-header">
      <span class="truescore-logo">🔍 TrueScore</span>
      <span class="truescore-tagline">Fake Review Detector</span>
      <button class="truescore-close-btn" aria-label="Close TrueScore widget">✕</button>
    </div>
    <div class="truescore-body">
      <div class="truescore-rating-row">
        <div class="truescore-rating-block truescore-original">
          <div class="truescore-rating-label">Amazon Rating</div>
          <div class="truescore-rating-value">${results.originalRating} <span class="truescore-out-of">/ 5</span></div>
          <div class="truescore-stars">${originalStars}</div>
        </div>
        <div class="truescore-divider">→</div>
        <div class="truescore-rating-block truescore-true ${parseFloat(trueScore) < parseFloat(results.originalRating) ? 'truescore-lower' : 'truescore-higher'}">
          <div class="truescore-rating-label">TrueScore™</div>
          <div class="truescore-rating-value">${trueScore} <span class="truescore-out-of">/ 5</span></div>
          <div class="truescore-stars">${trueStars}</div>
        </div>
      </div>
      <div class="truescore-stats">
        <div class="truescore-stat-pill truescore-stat-total">📋 ${results.total} Reviews Scanned</div>
        <div class="truescore-stat-pill truescore-stat-fake">⚠️ ${results.fakeCount} Fake (${percentFake}%)</div>
        <div class="truescore-stat-pill truescore-stat-real">✅ ${results.realCount} Authentic</div>
      </div>
    </div>
  `;

  const closeBtn = widget.querySelector('.truescore-close-btn');
  closeBtn.addEventListener('click', () => widget.remove());

  const anchor = findWidgetAnchor();
  if (anchor) {
    anchor.insertAdjacentElement('beforebegin', widget);
  } else {
    document.body.insertAdjacentElement('afterbegin', widget);
  }
}

function findWidgetAnchor() {
  const anchors = [
    '#reviewsMedley',
    '#customerReviews',
    '[data-hook="reviews-medley-footer"]',
    '#cm_cr-review_list',
    '.reviewNumericalSummary',
    '#averageCustomerReviews'
  ];
  for (const sel of anchors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function renderStars(rating) {
  if (isNaN(rating)) return '–';
  const full  = Math.floor(rating);
  const half  = (rating - full) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

// ─── 8. Reporting ────────────────────────────────────────────────────────────

function reportResultsToBackground(results) {
  chrome.runtime.sendMessage({
    type:    'UPDATE_BADGE',
    payload: { fakeCount: results.fakeCount }
  }).catch(() => {});

  const payload = {
    timestamp:      new Date().toISOString(),
    url:            window.location.href,
    total:          results.total,
    fakeCount:      results.fakeCount,
    realCount:      results.realCount,
    originalRating: results.originalRating,
    trueScore:      results.realRatings.length > 0
      ? (results.realRatings.reduce((a, b) => a + b, 0) / results.realRatings.length).toFixed(1)
      : 'N/A'
  };

  chrome.runtime.sendMessage({
    type:    'SAVE_SCAN_RESULTS',
    payload: payload
  }).catch(() => {});
}
