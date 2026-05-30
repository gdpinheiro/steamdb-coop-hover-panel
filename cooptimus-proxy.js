/**
 * Co-Optimus fetch proxy content script.
 *
 * Runs in the context of co-optimus.com pages so requests carry normal
 * browser headers (User-Agent, Referer, cookies) and are never blocked
 * by the 403 that bare service-worker fetches receive.
 *
 * The background script sends a PROXY_FETCH message, this script fetches
 * the URL, and replies with the HTML text (or an error).
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PROXY_FETCH') return false;

  const { url } = message.payload || {};
  if (!url || !url.startsWith('https://www.co-optimus.com/')) {
    sendResponse({ ok: false, error: 'Invalid or disallowed proxy URL' });
    return true;
  }

  fetch(url, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        sendResponse({ ok: false, status: response.status, error: `HTTP ${response.status}` });
        return;
      }
      const html = await response.text();
      sendResponse({ ok: true, html, status: response.status });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

  return true;
});
