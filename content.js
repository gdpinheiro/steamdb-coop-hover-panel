const PANEL_ID = 'steamdb-coop-panel-root';
const HOVER_ID = 'js-hover';
const DESCRIPTION_SELECTORS = [
  'p.header-description.limit-lines',
  '.header-description',
  '[class*="header-description"]',
  '[class*="description"]'
];
const APPID_SELECTORS = [
  '[data-appid]',
  'a[href*="/app/"]'
];

let bodyObserver = null;
let hoverObserver = null;
let currentHoverKey = null;
let pendingRenderToken = 0;
let mutationTimer = null;

bootstrap();

function bootstrap() {
  armBodyObserver();
  const existing = document.getElementById(HOVER_ID);
  if (existing) {
    connectHoverObserver(existing);
  }
}

function armBodyObserver() {
  if (bodyObserver) return;
  bodyObserver = new MutationObserver(() => {
    const hover = document.getElementById(HOVER_ID);
    if (hover) {
      connectHoverObserver(hover);
    }
  });
  bodyObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function connectHoverObserver(hoverRoot) {
  if (hoverObserver) {
    hoverObserver.disconnect();
  }
  hoverObserver = new MutationObserver(() => {
    if (mutationTimer) {
      clearTimeout(mutationTimer);
    }
    mutationTimer = setTimeout(() => handleHoverMutation(hoverRoot), 70);
  });
  hoverObserver.observe(hoverRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-appid', 'style', 'class', 'href'],
  });
  handleHoverMutation(hoverRoot);
}

async function handleHoverMutation(hoverRoot) {
  if (!hoverRoot || !document.body.contains(hoverRoot)) {
    return;
  }

  const active = extractActiveHoverGame(hoverRoot);
  if (!active) {
    removePanel(hoverRoot);
    currentHoverKey = null;
    return;
  }

  const hoverKey = `${active.appid}`;
  if (currentHoverKey === hoverKey && findOwnedPanel(hoverRoot)) {
    ensurePlacement(hoverRoot);
    return;
  }

  currentHoverKey = hoverKey;
  const renderToken = ++pendingRenderToken;
  renderPanel(hoverRoot, buildState('loading', { appid: active.appid, steamTitle: active.title }));

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_COOP_DATA',
      payload: {
        appid: active.appid,
        steamTitle: active.title,
      },
    });

    if (renderToken !== pendingRenderToken || currentHoverKey !== hoverKey) {
      return;
    }

    if (!response?.ok) {
      renderPanel(hoverRoot, buildState('error', {
        appid: active.appid,
        steamTitle: active.title,
        message: response?.error?.message || 'Unable to load co-op data',
      }));
      return;
    }

    renderPanel(hoverRoot, mapBackgroundResponseToState(response));
  } catch (error) {
    if (renderToken !== pendingRenderToken || currentHoverKey !== hoverKey) {
      return;
    }
    renderPanel(hoverRoot, buildState('error', {
      appid: active.appid,
      steamTitle: active.title,
      message: error?.message || 'Unable to load co-op data',
    }));
  }
}

function extractActiveHoverGame(hoverRoot) {
  const appNode = queryFirst(hoverRoot, APPID_SELECTORS);
  if (!appNode) {
    return null;
  }

  const appid = appNode.getAttribute?.('data-appid') || extractAppIdFromHref(appNode.getAttribute?.('href') || appNode.href || '');
  if (!appid) {
    return null;
  }

  const title = extractTitle(hoverRoot);
  if (!title) {
    return null;
  }

  return {
    appid: String(appid),
    title,
  };
}

function extractTitle(hoverRoot) {
  const candidates = [
    '.header-title',
    'h1',
    'h2',
    'h3',
    'a[href*="/app/"]',
    '[data-appid]'
  ];
  for (const selector of candidates) {
    const node = hoverRoot.querySelector(selector);
    const text = normalizeWhitespace(node?.textContent || '');
    if (text) return text;
  }
  return null;
}

function renderPanel(hoverRoot, state) {
  const anchor = findAnchor(hoverRoot);
  if (!anchor) {
    removePanel(hoverRoot);
    return;
  }

  let panel = findOwnedPanel(hoverRoot);
  if (!panel) {
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'sdbcoop-panel';
    panel.setAttribute('data-appid', state.appid || '');
  }

  panel.replaceChildren(buildPanelContent(state));
  panel.setAttribute('data-state', state.kind);
  panel.setAttribute('data-appid', state.appid || '');

  if (panel.parentElement !== anchor.parentElement || panel.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', panel);
  }
}

function buildPanelContent(state) {
  const wrap = document.createDocumentFragment();

  const heading = document.createElement('div');
  heading.className = 'sdbcoop-heading';
  heading.textContent = 'Co-op';
  wrap.appendChild(heading);

  if (state.kind === 'loading') {
    wrap.appendChild(buildMessage('Loading co-op data…', 'muted'));
    wrap.appendChild(buildSkeleton());
    return wrap;
  }

  if (state.kind === 'error') {
    wrap.appendChild(buildMessage(state.message || 'Unable to load data', 'error'));
    if (state.appid && state.steamTitle) {
      wrap.appendChild(buildActionRow(state.appid, state.steamTitle));
    }
    return wrap;
  }

  if (state.kind === 'no-data') {
    wrap.appendChild(buildMessage('No Co-Optimus PC co-op data found', 'muted'));
    if (state.appid && state.steamTitle) {
      wrap.appendChild(buildActionRow(state.appid, state.steamTitle));
    }
    return wrap;
  }

  if (state.kind === 'ambiguous') {
    wrap.appendChild(buildMessage('Multiple possible matches', 'muted'));
    const list = document.createElement('div');
    list.className = 'sdbcoop-ambiguous-list';
    for (const candidate of (state.candidates || []).slice(0, 3)) {
      const item = document.createElement('div');
      item.className = 'sdbcoop-ambiguous-item';
      item.textContent = `${candidate.coopTitle} (${candidate.confidence})`;
      list.appendChild(item);
    }
    wrap.appendChild(list);
    if (state.appid && state.steamTitle) {
      wrap.appendChild(buildActionRow(state.appid, state.steamTitle));
    }
    return wrap;
  }

  const rows = [
    ['Local Co-Op', state.detail?.features?.localCoop],
    ['Online Co-Op', state.detail?.features?.onlineCoop],
    ['Combo Co-Op', state.detail?.features?.comboCoop],
    ['LAN / System Link', state.detail?.features?.lanPlay],
  ];

  const grid = document.createElement('div');
  grid.className = 'sdbcoop-grid';
  for (const [label, feature] of rows) {
    const row = document.createElement('div');
    row.className = 'sdbcoop-row';

    const left = document.createElement('span');
    left.className = 'sdbcoop-label';
    left.textContent = label;

    const right = document.createElement('span');
    right.className = 'sdbcoop-value';
    right.textContent = formatFeatureValue(feature);
    if (!feature?.supported) {
      right.classList.add('is-muted');
    }

    row.append(left, right);
    grid.appendChild(row);
  }
  wrap.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'sdbcoop-footer';
  footer.textContent = state.kind === 'refreshed' ? 'Updated now' : (state.stale ? 'Cached, refreshing in background' : 'Cached');
  wrap.appendChild(footer);

  if (state.detail?.detailUrl) {
    const source = document.createElement('a');
    source.className = 'sdbcoop-source';
    source.href = state.detail.detailUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'Source';
    wrap.appendChild(source);
  }

  return wrap;
}

function buildSkeleton() {
  const skeleton = document.createElement('div');
  skeleton.className = 'sdbcoop-skeleton';
  for (let i = 0; i < 3; i += 1) {
    const line = document.createElement('div');
    line.className = 'sdbcoop-skeleton-line';
    skeleton.appendChild(line);
  }
  return skeleton;
}

function buildMessage(text, tone) {
  const message = document.createElement('div');
  message.className = `sdbcoop-message ${tone ? `is-${tone}` : ''}`.trim();
  message.textContent = text;
  return message;
}

function buildActionRow(appid, steamTitle) {
  const row = document.createElement('div');
  row.className = 'sdbcoop-actions';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sdbcoop-refresh';
  button.textContent = 'Refresh';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REFRESH_APP',
        payload: { appid, steamTitle },
      });
      const hoverRoot = document.getElementById(HOVER_ID);
      if (hoverRoot) {
        renderPanel(hoverRoot, response?.ok ? mapBackgroundResponseToState(response) : buildState('error', { appid, steamTitle, message: 'Refresh failed' }));
      }
    } finally {
      button.disabled = false;
    }
  });

  row.appendChild(button);
  return row;
}

function mapBackgroundResponseToState(response) {
  const payload = response || {};
  switch (payload.state) {
    case 'cached':
    case 'refreshed':
      return buildState(payload.state, {
        appid: payload.appid,
        steamTitle: payload.steamTitle,
        stale: payload.stale,
        detail: payload.detail,
      });
    case 'ambiguous':
      return buildState('ambiguous', {
        appid: payload.appid,
        steamTitle: payload.steamTitle,
        candidates: payload.candidates || [],
      });
    case 'no-data':
      return buildState('no-data', {
        appid: payload.appid,
        steamTitle: payload.steamTitle,
      });
    default:
      return buildState('error', {
        appid: payload.appid,
        steamTitle: payload.steamTitle,
        message: payload.error?.message || 'Unable to load co-op data',
      });
  }
}

function buildState(kind, patch = {}) {
  return { kind, ...patch };
}

function formatFeatureValue(feature) {
  if (!feature || feature.supported === false) {
    return 'Not Supported';
  }
  if (feature.text) {
    return feature.text;
  }
  if (Number.isFinite(feature.minPlayers) && Number.isFinite(feature.maxPlayers)) {
    if (feature.minPlayers === feature.maxPlayers) {
      return `${feature.minPlayers} Players`;
    }
    return `${feature.minPlayers}-${feature.maxPlayers} Players`;
  }
  return 'Supported';
}

function ensurePlacement(hoverRoot) {
  const anchor = findAnchor(hoverRoot);
  const panel = findOwnedPanel(hoverRoot);
  if (!anchor || !panel) return;
  if (panel.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', panel);
  }
}

function findAnchor(hoverRoot) {
  return queryFirst(hoverRoot, DESCRIPTION_SELECTORS) || null;
}

function queryFirst(root, selectors) {
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    if (node) return node;
  }
  return null;
}

function findOwnedPanel(hoverRoot) {
  return hoverRoot.querySelector(`#${PANEL_ID}`);
}

function removePanel(hoverRoot) {
  const panel = findOwnedPanel(hoverRoot);
  if (panel) panel.remove();
}

function extractAppIdFromHref(href) {
  const match = String(href || '').match(/\/app\/(\d+)/);
  return match ? match[1] : null;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
