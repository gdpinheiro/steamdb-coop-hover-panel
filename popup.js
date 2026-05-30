const indexStatus = document.getElementById('indexStatus');
const pcEntries = document.getElementById('pcEntries');
const detailCount = document.getElementById('detailCount');
const matchCount = document.getElementById('matchCount');
const message = document.getElementById('message');
const refreshIndexButton = document.getElementById('refreshIndex');
const autoRefreshIndex = document.getElementById('autoRefreshIndex');
const debugMode = document.getElementById('debugMode');

init().catch((error) => {
  setMessage(error.message || 'Failed to load popup status');
});

async function init() {
  await loadStatus();

  refreshIndexButton.addEventListener('click', async () => {
    refreshIndexButton.disabled = true;
    setMessage('Refreshing master index…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'REFRESH_INDEX' });
      if (!response?.ok) throw new Error(response?.error?.message || 'Refresh failed');
      await loadStatus();
      setMessage('Master index refreshed');
    } catch (error) {
      setMessage(error.message || 'Refresh failed');
    } finally {
      refreshIndexButton.disabled = false;
    }
  });

  autoRefreshIndex.addEventListener('change', saveSettings);
  debugMode.addEventListener('change', saveSettings);
}

async function loadStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!response?.ok) {
    throw new Error(response?.error?.message || 'Unable to read extension status');
  }

  const status = response;
  autoRefreshIndex.checked = !!status.settings?.autoRefreshIndex;
  debugMode.checked = !!status.settings?.debugMode;

  if (status.index) {
    indexStatus.textContent = formatDate(status.index.fetchedAt);
    pcEntries.textContent = String(status.index.pcEntries || 0);
  } else {
    indexStatus.textContent = 'Not cached yet';
    pcEntries.textContent = '0';
  }

  detailCount.textContent = String(status.detailsCount || 0);
  matchCount.textContent = String(status.matchesCount || 0);
}

async function saveSettings() {
  const response = await chrome.runtime.sendMessage({
    type: 'SETTINGS_SET',
    payload: {
      autoRefreshIndex: autoRefreshIndex.checked,
      debugMode: debugMode.checked,
    },
  });
  if (!response?.ok) {
    setMessage(response?.error?.message || 'Unable to save settings');
    return;
  }
  setMessage('Settings saved');
}

function setMessage(text) {
  message.textContent = text || '';
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}
