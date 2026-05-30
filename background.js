const STORAGE_KEYS = {
  INDEX_CACHE: 'indexCache',
  DETAIL_CACHE: 'detailCache',
  MATCH_CACHE: 'matchCache',
  NEGATIVE_CACHE: 'negativeCache',
  SETTINGS: 'settings',
  MANUAL_OVERRIDES: 'manualOverrides',
};

const CACHE_SCHEMA_VERSION = 1;
const INDEX_URL = 'https://www.co-optimus.com/gamesMap.php';
const COOPTIMUS_ORIGIN = 'https://www.co-optimus.com';
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_MAX_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AMBIGUOUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALARM_NAME = 'weeklyIndexRefresh';
const REQUEST_GAP_MS = 900;
const MAX_CONCURRENT_DETAIL_FETCHES = 2;

const inFlight = new Map();
let lastRequestAt = 0;
let activeDetailFetches = 0;
const detailQueue = [];

/**
 * Tab-based proxy state.
 * We open one co-optimus.com tab (pinned, inactive) the first time we need
 * it, reuse it for subsequent requests, and close it when no longer needed.
 */
let proxyTabId = null;
let proxyTabReady = false;
let proxyTabQueue = [];

const DEFAULT_SETTINGS = {
  autoRefreshIndex: true,
  debugMode: false,
};

const MANUAL_ALIASES = {
  'left4dead 2': ['left 4 dead 2'],
  'tom clancys rainbow six siege': ['rainbow six siege'],
  'portal 2': ['portal 2'],
};

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await ensureWeeklyAlarm();
  void refreshIndexIfNeeded({ force: false, reason: 'install' });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  await ensureWeeklyAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (merged.autoRefreshIndex) {
      await refreshIndexIfNeeded({ force: true, reason: 'alarm' });
    }
  }
});

// Clean up proxy tab if the user closes it manually.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === proxyTabId) {
    proxyTabId = null;
    proxyTabReady = false;
    // Reject any queued requests so callers get a clean error and can retry.
    for (const item of proxyTabQueue) {
      item.reject(new Error('Proxy tab was closed unexpectedly'));
    }
    proxyTabQueue = [];
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Mark the proxy tab as ready once its content script fires.
  if (message?.type === 'PROXY_READY' && sender.tab?.id === proxyTabId) {
    proxyTabReady = true;
    flushProxyQueue();
    return false;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'GET_COOP_DATA':
      return await getCoopData(message.payload || {});
    case 'REFRESH_INDEX':
      await refreshIndexIfNeeded({ force: true, reason: 'manual' });
      return { state: 'ok' };
    case 'REFRESH_APP':
      await invalidateAppCaches(message.payload?.appid);
      return await getCoopData({ ...(message.payload || {}), forceRefresh: true });
    case 'GET_STATUS':
      return await getStatus();
    case 'SETTINGS_GET':
      return { settings: await getSettings() };
    case 'SETTINGS_SET':
      await setSettings(message.payload || {});
      return { settings: await getSettings() };
    default:
      throw new Error(`Unknown message type: ${message?.type || 'undefined'}`);
  }
}

// ---------------------------------------------------------------------------
// Proxy tab management
// ---------------------------------------------------------------------------

/**
 * Open (or reuse) a Co-Optimus tab and ask its content script to fetch
 * `url`, returning the HTML text. The tab is opened in the background
 * (active:false) and is reused across calls to avoid repeated tab churn.
 */
async function proxyFetch(url) {
  return new Promise((resolve, reject) => {
    proxyTabQueue.push({ url, resolve, reject });
    ensureProxyTab().catch(reject);
  });
}

async function ensureProxyTab() {
  if (proxyTabId !== null) {
    // Tab already exists; if ready, flush the queue immediately.
    if (proxyTabReady) flushProxyQueue();
    return;
  }

  // Create a silent background tab pointing at the Co-Optimus root so the
  // content script loads and is authorised to fetch co-optimus.com URLs.
  const tab = await chrome.tabs.create({
    url: COOPTIMUS_ORIGIN + '/',
    active: false,
    pinned: false,
  });
  proxyTabId = tab.id;
  proxyTabReady = false;

  // The content script signals readiness via PROXY_READY; flushProxyQueue
  // is called from the onMessage handler at that point.
  // Safety timeout: if the page never reports ready within 15 s, flush anyway.
  setTimeout(() => {
    if (!proxyTabReady && proxyTabId === tab.id) {
      proxyTabReady = true;
      flushProxyQueue();
    }
  }, 15000);
}

function flushProxyQueue() {
  while (proxyTabQueue.length > 0 && proxyTabReady && proxyTabId !== null) {
    const item = proxyTabQueue.shift();
    dispatchProxyFetch(item);
  }
}

function dispatchProxyFetch({ url, resolve, reject }) {
  chrome.tabs.sendMessage(
    proxyTabId,
    { type: 'PROXY_FETCH', payload: { url } },
    (response) => {
      if (chrome.runtime.lastError) {
        // Content script not yet injected; push back and retry after a short delay.
        proxyTabQueue.unshift({ url, resolve, reject });
        proxyTabReady = false;
        setTimeout(() => {
          if (proxyTabId !== null) {
            proxyTabReady = true;
            flushProxyQueue();
          }
        }, 1500);
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || `Proxy fetch failed for ${url}`));
        return;
      }
      resolve(response.html);
    }
  );
}

// ---------------------------------------------------------------------------
// Throttled fetch wrapper — now routes Co-Optimus URLs through the proxy tab.
// Direct fetch() from the service worker gets 403 because Co-Optimus blocks
// requests that lack normal browser headers/cookies. The proxy tab runs in
// page context so its requests look like regular browser navigation.
// ---------------------------------------------------------------------------

async function fetchWithThrottle(url, _options = {}) {
  const now = Date.now();
  const waitMs = Math.max(0, REQUEST_GAP_MS - (now - lastRequestAt));
  if (waitMs > 0) await delay(waitMs);
  lastRequestAt = Date.now();

  if (url.startsWith(COOPTIMUS_ORIGIN)) {
    const html = await proxyFetch(url);
    // Wrap in a minimal Response-compatible object so callers don't change.
    return {
      ok: true,
      status: 200,
      text: async () => html,
      headers: { get: () => null },
    };
  }

  // Non-Co-Optimus URLs (currently none, but kept for safety).
  return fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
  });
}

// ---------------------------------------------------------------------------
// Everything below is unchanged from the original background.js.
// ---------------------------------------------------------------------------

async function getCoopData({ appid, steamTitle, forceRefresh = false }) {
  if (!appid || !steamTitle) {
    throw new Error('appid and steamTitle are required');
  }

  const dedupeKey = `app:${appid}:${steamTitle}:${forceRefresh ? 'force' : 'normal'}`;
  if (inFlight.has(dedupeKey)) {
    return inFlight.get(dedupeKey);
  }

  const promise = (async () => {
    const now = Date.now();
    const settings = await getSettings();
    const storage = await chrome.storage.local.get([
      STORAGE_KEYS.INDEX_CACHE,
      STORAGE_KEYS.DETAIL_CACHE,
      STORAGE_KEYS.MATCH_CACHE,
      STORAGE_KEYS.NEGATIVE_CACHE,
      STORAGE_KEYS.MANUAL_OVERRIDES,
    ]);

    const indexCache = storage[STORAGE_KEYS.INDEX_CACHE] || null;
    const detailCache = storage[STORAGE_KEYS.DETAIL_CACHE] || {};
    const matchCache = storage[STORAGE_KEYS.MATCH_CACHE] || {};
    const negativeCache = storage[STORAGE_KEYS.NEGATIVE_CACHE] || {};
    const manualOverrides = storage[STORAGE_KEYS.MANUAL_OVERRIDES] || {};

    const override = manualOverrides[String(appid)];
    const cachedMatch = matchCache[String(appid)];
    const negativeEntry = negativeCache[String(appid)];

    if (!forceRefresh && negativeEntry && negativeEntry.retryAfter > now) {
      return {
        state: negativeEntry.reason === 'ambiguous' ? 'ambiguous' : 'no-data',
        source: 'negative-cache',
        stale: false,
        appid,
        steamTitle,
        reason: negativeEntry.reason,
        debug: debugPayload(settings, { negativeEntry }),
      };
    }

    const ensuredIndex = await ensureIndexAvailability(indexCache, forceRefresh);
    const effectiveIndex = ensuredIndex.indexCache;

    const directDetailKey = override?.detailKey || cachedMatch?.detailKey;
    if (!forceRefresh && directDetailKey) {
      const detail = detailCache[directDetailKey];
      if (detail && detail.expiresAt > now) {
        return panelDataResponse({
          state: 'cached',
          source: 'detail-cache',
          appid,
          steamTitle,
          detail,
          match: cachedMatch || override,
          debug: debugPayload(settings, { indexAgeMs: ageMs(effectiveIndex?.fetchedAt), match: cachedMatch || override }),
        });
      }
      if (detail && detail.staleUntil > now) {
        void refreshDetailByKey(directDetailKey, detail.detailUrl).catch(() => null);
        return panelDataResponse({
          state: 'cached',
          source: 'detail-cache-stale',
          stale: true,
          appid,
          steamTitle,
          detail,
          match: cachedMatch || override,
          debug: debugPayload(settings, { indexAgeMs: ageMs(effectiveIndex?.fetchedAt), match: cachedMatch || override }),
        });
      }
    }

    const resolution = await resolveSteamGame({ appid, steamTitle, indexCache: effectiveIndex, forceRefresh });

    if (resolution.state === 'ambiguous') {
      await storeNegative(appid, 'ambiguous', AMBIGUOUS_TTL_MS);
      return {
        state: 'ambiguous',
        source: 'resolver',
        appid,
        steamTitle,
        candidates: resolution.candidates,
        debug: debugPayload(settings, { resolution }),
      };
    }

    if (resolution.state === 'no-data') {
      await storeNegative(appid, 'not_found', NEGATIVE_TTL_MS);
      return {
        state: 'no-data',
        source: 'resolver',
        appid,
        steamTitle,
        debug: debugPayload(settings, { resolution }),
      };
    }

    const detail = await getOrFetchDetail(resolution.match, detailCache, forceRefresh);
    await persistMatch(appid, steamTitle, resolution.match);

    return panelDataResponse({
      state: forceRefresh ? 'refreshed' : (detail.fromCache ? 'cached' : 'refreshed'),
      source: detail.fromCache ? 'detail-cache' : 'detail-fetch',
      stale: !!detail.stale,
      appid,
      steamTitle,
      detail: detail.entry,
      match: resolution.match,
      debug: debugPayload(settings, { resolution, detailSource: detail.fromCache ? 'cache' : 'network' }),
    });
  })().finally(() => {
    inFlight.delete(dedupeKey);
  });

  inFlight.set(dedupeKey, promise);
  return promise;
}

async function ensureIndexAvailability(existingIndex, forceRefresh) {
  const now = Date.now();
  const hasUsableFreshIndex = existingIndex && existingIndex.expiresAt > now;
  const hasUsableStaleIndex = existingIndex && existingIndex.staleUntil > now;

  if (!forceRefresh && hasUsableFreshIndex) {
    return { indexCache: existingIndex, refreshed: false };
  }

  if (!forceRefresh && hasUsableStaleIndex) {
    void refreshIndexIfNeeded({ force: false, reason: 'stale-while-revalidate' }).catch(() => null);
    return { indexCache: existingIndex, refreshed: false, staleServed: true };
  }

  const refreshed = await refreshIndexIfNeeded({ force: true, reason: forceRefresh ? 'forced-request' : 'missing' });
  return { indexCache: refreshed, refreshed: true };
}

async function refreshIndexIfNeeded({ force, reason }) {
  const lockKey = 'index-refresh';
  if (!force && inFlight.has(lockKey)) {
    return inFlight.get(lockKey);
  }

  const promise = (async () => {
    const { indexCache } = await chrome.storage.local.get(STORAGE_KEYS.INDEX_CACHE);
    const now = Date.now();
    if (!force && indexCache && indexCache.expiresAt > now) {
      return indexCache;
    }

    const response = await fetchWithThrottle(INDEX_URL);

    if (response.status === 304 && indexCache) {
      const updated = {
        ...indexCache,
        fetchedAt: now,
        expiresAt: now + INDEX_TTL_MS,
        staleUntil: now + INDEX_MAX_STALE_MS,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.INDEX_CACHE]: updated });
      return updated;
    }

    if (!response.ok) {
      throw new Error(`Index fetch failed with status ${response.status} (${reason})`);
    }

    const html = await response.text();
    const parsed = parseGamesMap(html);
    const headers = extractCacheHeaders(response);
    const built = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceUrl: INDEX_URL,
      fetchedAt: now,
      expiresAt: now + INDEX_TTL_MS,
      staleUntil: now + INDEX_MAX_STALE_MS,
      sourceHash: simpleHash(html),
      parseVersion: 1,
      etag: headers.etag,
      lastModified: headers.lastModified,
      entriesByKey: parsed.entriesByKey,
      stats: parsed.stats,
    };

    await chrome.storage.local.set({ [STORAGE_KEYS.INDEX_CACHE]: built });
    return built;
  })().finally(() => {
    inFlight.delete(lockKey);
  });

  inFlight.set(lockKey, promise);
  return promise;
}

function parseGamesMap(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const bodyText = doc.body?.textContent || '';
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entriesByKey = {};
  let totalEntries = 0;
  let pcEntries = 0;

  for (let i = 0; i < lines.length - 2; i += 1) {
    const title = lines[i];
    const marker = lines[i + 1];
    const platform = lines[i + 2];

    if (marker !== 'for') {
      continue;
    }
    if (platform !== 'PC') {
      continue;
    }

    totalEntries += 1;
    pcEntries += 1;

    const normalized = buildNormalizedTitleKeys(title);
    const detailUrl = inferCoOptimusDetailUrl(doc, title);
    const entry = {
      coopTitle: title,
      normalizedTitle: normalized.strictKey,
      strictKey: normalized.strictKey,
      looseKey: normalized.looseKey,
      platform,
      detailUrl,
      titleHash: simpleHash(`${title}|${platform}`),
      aliases: MANUAL_ALIASES[normalized.strictKey] || [],
    };

    if (!entriesByKey[normalized.strictKey]) {
      entriesByKey[normalized.strictKey] = [];
    }
    entriesByKey[normalized.strictKey].push(entry);
  }

  return {
    entriesByKey,
    stats: {
      totalEntries,
      pcEntries,
    },
  };
}

function inferCoOptimusDetailUrl(doc, title) {
  const links = Array.from(doc.querySelectorAll('a[href]'));
  const found = links.find((link) => normalizeWhitespace(link.textContent || '') === normalizeWhitespace(title));
  if (!found) {
    return null;
  }
  const href = found.getAttribute('href');
  if (!href) {
    return null;
  }
  return new URL(href, 'https://www.co-optimus.com/').toString();
}

async function resolveSteamGame({ appid, steamTitle, indexCache }) {
  if (!indexCache?.entriesByKey) {
    return { state: 'no-data', reason: 'index_unavailable' };
  }

  const keys = buildNormalizedTitleKeys(steamTitle);
  const exactStrict = indexCache.entriesByKey[keys.strictKey] || [];
  if (exactStrict.length === 1) {
    return { state: 'resolved', match: buildMatchPayload(exactStrict[0], 'exact', 1.0) };
  }

  const exactLoose = collectLooseMatches(indexCache.entriesByKey, keys.looseKey);
  if (exactLoose.length === 1) {
    return { state: 'resolved', match: buildMatchPayload(exactLoose[0], 'exact-loose', 0.96) };
  }

  const aliasMatches = collectAliasMatches(indexCache.entriesByKey, keys);
  if (aliasMatches.length === 1) {
    return { state: 'resolved', match: buildMatchPayload(aliasMatches[0], 'alias', 0.94) };
  }

  const scored = scoreCandidates(indexCache.entriesByKey, steamTitle, keys).slice(0, 3);
  if (!scored.length) {
    return { state: 'no-data', reason: 'no_candidates' };
  }

  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.04) {
    return {
      state: 'ambiguous',
      candidates: scored.map((item) => ({
        coopTitle: item.entry.coopTitle,
        detailUrl: item.entry.detailUrl,
        confidence: round(item.score),
      })),
    };
  }

  if (scored[0].score < 0.86) {
    return { state: 'no-data', reason: 'low_confidence' };
  }

  return { state: 'resolved', match: buildMatchPayload(scored[0].entry, 'fuzzy', round(scored[0].score)) };
}

function buildMatchPayload(entry, matchType, confidence) {
  const detailKey = simpleHash(`${entry.coopTitle}|${entry.platform}|${entry.detailUrl || 'none'}`);
  return {
    detailKey,
    coopTitle: entry.coopTitle,
    detailUrl: entry.detailUrl || null,
    matchType,
    confidence,
    strictKey: entry.strictKey,
    looseKey: entry.looseKey,
  };
}

function collectLooseMatches(entriesByKey, looseKey) {
  const all = [];
  for (const bucket of Object.values(entriesByKey)) {
    for (const entry of bucket) {
      if (entry.looseKey === looseKey) {
        all.push(entry);
      }
    }
  }
  return dedupeEntries(all);
}

function collectAliasMatches(entriesByKey, keys) {
  const all = [];
  for (const bucket of Object.values(entriesByKey)) {
    for (const entry of bucket) {
      const aliases = entry.aliases || [];
      if (aliases.includes(keys.strictKey) || aliases.includes(keys.looseKey)) {
        all.push(entry);
      }
    }
  }
  return dedupeEntries(all);
}

function scoreCandidates(entriesByKey, steamTitle, keys) {
  const candidates = [];
  for (const bucket of Object.values(entriesByKey)) {
    for (const entry of bucket) {
      const score = similarityScore(keys, buildNormalizedTitleKeys(entry.coopTitle), steamTitle, entry.coopTitle);
      if (score >= 0.62) {
        candidates.push({ entry, score });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function similarityScore(steamKeys, coopKeys, steamTitle, coopTitle) {
  if (steamKeys.strictKey === coopKeys.strictKey) return 1;
  if (steamKeys.looseKey === coopKeys.looseKey) return 0.96;

  const steamTokens = new Set(steamKeys.looseKey.split(' ').filter(Boolean));
  const coopTokens = new Set(coopKeys.looseKey.split(' ').filter(Boolean));
  const overlap = intersectSize(steamTokens, coopTokens);
  const union = new Set([...steamTokens, ...coopTokens]).size || 1;
  const jaccard = overlap / union;
  const levenshtein = levenshteinRatio(steamKeys.looseKey, coopKeys.looseKey);
  const subtitleBoost = hasSubtitleAgreement(steamTitle, coopTitle) ? 0.04 : 0;
  const editionPenalty = hasEditionConflict(steamTitle, coopTitle) ? 0.08 : 0;
  return Math.max(0, (jaccard * 0.55) + (levenshtein * 0.45) + subtitleBoost - editionPenalty);
}

async function getOrFetchDetail(match, detailCache, forceRefresh) {
  const now = Date.now();
  const cached = detailCache[match.detailKey];
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return { fromCache: true, entry: cached };
  }
  if (!forceRefresh && cached && cached.staleUntil > now) {
    void refreshDetailByKey(match.detailKey, match.detailUrl).catch(() => null);
    return { fromCache: true, entry: cached, stale: true };
  }
  const entry = await refreshDetailByKey(match.detailKey, match.detailUrl, match.coopTitle);
  return { fromCache: false, entry };
}

async function refreshDetailByKey(detailKey, detailUrl, coopTitle = '') {
  const task = () => (async () => {
    if (!detailUrl) {
      throw new Error(`Missing detail URL for ${coopTitle || detailKey}`);
    }

    const response = await fetchWithThrottle(detailUrl);
    if (!response.ok) {
      throw new Error(`Detail fetch failed with status ${response.status}`);
    }
    const html = await response.text();
    const parsed = parseDetailPage(html, detailUrl, coopTitle);
    const now = Date.now();
    const { detailCache = {} } = await chrome.storage.local.get(STORAGE_KEYS.DETAIL_CACHE);
    const entry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      detailKey,
      coopTitle: parsed.coopTitle || coopTitle,
      detailUrl,
      fetchedAt: now,
      expiresAt: now + DETAIL_TTL_MS,
      staleUntil: now + DETAIL_MAX_STALE_MS,
      sourceHash: simpleHash(html),
      parseVersion: 1,
      platform: 'PC',
      features: parsed.features,
      rawHints: parsed.rawHints,
    };
    detailCache[detailKey] = entry;
    await chrome.storage.local.set({ [STORAGE_KEYS.DETAIL_CACHE]: detailCache });
    return entry;
  })();

  return enqueueDetailFetch(task);
}

function parseDetailPage(html, detailUrl, coopTitleHint) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const text = normalizeWhitespace(doc.body?.textContent || '');
  const title = normalizeWhitespace(doc.querySelector('title')?.textContent || coopTitleHint || '');
  const features = {
    localCoop: parseFeatureBlock(text, ['Local Co-Op']),
    onlineCoop: parseFeatureBlock(text, ['Online Co-Op']),
    comboCoop: parseFeatureBlock(text, ['Combo Co-Op', 'Combo Co-op']),
    lanPlay: parseFeatureBlock(text, ['LAN Play', 'System Link']),
  };

  return {
    coopTitle: title.replace(/\s*\|.*$/, '').trim(),
    detailUrl,
    features,
    rawHints: {
      extractedFromText: true,
    },
  };
}

function parseFeatureBlock(text, labels) {
  for (const label of labels) {
    const rx = new RegExp(`${escapeRegExp(label)}\\s*[:\\-]?\\s*([^\\n\\r]{0,80})`, 'i');
    const match = text.match(rx);
    if (!match) continue;

    const value = normalizeWhitespace(match[1]);
    if (/not supported|no co-op|none/i.test(value)) {
      return { supported: false, text: 'Not Supported' };
    }

    const rangeMatch = value.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*player/i);
    if (rangeMatch) {
      return {
        supported: true,
        minPlayers: Number(rangeMatch[1]),
        maxPlayers: Number(rangeMatch[2]),
        text: `${rangeMatch[1]}-${rangeMatch[2]} Players`,
      };
    }

    const singleMatch = value.match(/(\d+)\s*player/i);
    if (singleMatch) {
      return {
        supported: true,
        minPlayers: Number(singleMatch[1]),
        maxPlayers: Number(singleMatch[1]),
        text: `${singleMatch[1]} Players`,
      };
    }

    if (/yes|supported|available/i.test(value)) {
      return { supported: true, text: 'Supported' };
    }

    return { supported: false, text: 'Not Supported' };
  }
  return { supported: false, text: 'Not Supported' };
}

function panelDataResponse({ state, source, stale = false, appid, steamTitle, detail, match, debug }) {
  return {
    state,
    source,
    stale,
    appid,
    steamTitle,
    match,
    detail: {
      coopTitle: detail.coopTitle,
      detailUrl: detail.detailUrl,
      features: detail.features,
      fetchedAt: detail.fetchedAt,
    },
    debug,
  };
}

async function persistMatch(appid, steamTitle, match) {
  const { matchCache = {} } = await chrome.storage.local.get(STORAGE_KEYS.MATCH_CACHE);
  const now = Date.now();
  matchCache[String(appid)] = {
    appid: String(appid),
    steamTitle,
    normalizedSteamTitle: buildNormalizedTitleKeys(steamTitle).strictKey,
    resolved: true,
    detailKey: match.detailKey,
    detailUrl: match.detailUrl,
    coopTitle: match.coopTitle,
    matchType: match.matchType,
    confidence: match.confidence,
    resolvedAt: now,
    expiresAt: now + MATCH_TTL_MS,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.MATCH_CACHE]: matchCache });
}

async function storeNegative(appid, reason, ttlMs) {
  const { negativeCache = {} } = await chrome.storage.local.get(STORAGE_KEYS.NEGATIVE_CACHE);
  const now = Date.now();
  negativeCache[String(appid)] = {
    key: String(appid),
    reason,
    firstSeenAt: negativeCache[String(appid)]?.firstSeenAt || now,
    lastSeenAt: now,
    retryAfter: now + ttlMs,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.NEGATIVE_CACHE]: negativeCache });
}

async function invalidateAppCaches(appid) {
  if (!appid) return;
  const { matchCache = {}, negativeCache = {} } = await chrome.storage.local.get([
    STORAGE_KEYS.MATCH_CACHE,
    STORAGE_KEYS.NEGATIVE_CACHE,
  ]);
  delete matchCache[String(appid)];
  delete negativeCache[String(appid)];
  await chrome.storage.local.set({
    [STORAGE_KEYS.MATCH_CACHE]: matchCache,
    [STORAGE_KEYS.NEGATIVE_CACHE]: negativeCache,
  });
}

async function getStatus() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.INDEX_CACHE,
    STORAGE_KEYS.DETAIL_CACHE,
    STORAGE_KEYS.MATCH_CACHE,
    STORAGE_KEYS.NEGATIVE_CACHE,
    STORAGE_KEYS.SETTINGS,
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    index: summarizeIndex(data.indexCache),
    detailsCount: Object.keys(data.detailCache || {}).length,
    matchesCount: Object.keys(data.matchCache || {}).length,
    negativesCount: Object.keys(data.negativeCache || {}).length,
  };
}

function summarizeIndex(indexCache) {
  if (!indexCache) return null;
  return {
    fetchedAt: indexCache.fetchedAt,
    expiresAt: indexCache.expiresAt,
    staleUntil: indexCache.staleUntil,
    pcEntries: indexCache.stats?.pcEntries || 0,
    totalEntries: indexCache.stats?.totalEntries || 0,
  };
}

async function ensureSettings() {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!settings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS } });
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(patch) {
  const merged = { ...(await getSettings()), ...(patch || {}) };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  await ensureWeeklyAlarm();
}

async function ensureWeeklyAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: 7 * 24 * 60,
    delayInMinutes: 1,
  });
}

function enqueueDetailFetch(task) {
  return new Promise((resolve, reject) => {
    detailQueue.push({ task, resolve, reject });
    pumpDetailQueue();
  });
}

function pumpDetailQueue() {
  while (activeDetailFetches < MAX_CONCURRENT_DETAIL_FETCHES && detailQueue.length) {
    const item = detailQueue.shift();
    activeDetailFetches += 1;
    item.task()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeDetailFetches -= 1;
        pumpDetailQueue();
      });
  }
}

function buildNormalizedTitleKeys(title) {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const strictKey = normalizeWhitespace(
    ascii
      .replace(/[™®©]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[:''.,!?()\[\]{}+/_-]+/g, ' ')
  );
  const looseKey = normalizeWhitespace(
    strictKey
      .replace(/\b(game of the year edition|definitive edition|ultimate edition|complete edition|remastered|hd|vr)\b/g, ' ')
      .replace(/\b(the|a|an)\b/g, ' ')
      .replace(/\bii\b/g, '2')
      .replace(/\biii\b/g, '3')
      .replace(/\biv\b/g, '4')
  );
  return { strictKey, looseKey };
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.coopTitle}|${entry.platform}|${entry.detailUrl || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function intersectSize(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

function levenshteinRatio(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  const distance = matrix[a.length][b.length];
  return 1 - (distance / Math.max(a.length, b.length));
}

function hasSubtitleAgreement(a, b) {
  const aParts = a.split(':').map((x) => normalizeWhitespace(x.toLowerCase()));
  const bParts = b.split(':').map((x) => normalizeWhitespace(x.toLowerCase()));
  return aParts.length > 1 && bParts.length > 1 && aParts[1] === bParts[1];
}

function hasEditionConflict(a, b) {
  const aEdition = /(demo|prologue|soundtrack|dlc)/i.test(a);
  const bEdition = /(demo|prologue|soundtrack|dlc)/i.test(b);
  return aEdition !== bEdition;
}

function simpleHash(input) {
  let hash = 0;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return `h${Math.abs(hash)}`;
}

function extractCacheHeaders(response) {
  return {
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
  };
}

function buildConditionalHeaders(indexCache) {
  const headers = {};
  if (indexCache?.etag) headers['If-None-Match'] = indexCache.etag;
  if (indexCache?.lastModified) headers['If-Modified-Since'] = indexCache.lastModified;
  return headers;
}

function debugPayload(settings, payload) {
  return settings.debugMode ? payload : undefined;
}

function ageMs(timestamp) {
  return timestamp ? Date.now() - timestamp : null;
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
