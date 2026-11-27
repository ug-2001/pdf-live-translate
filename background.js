// PDF Live Translate - service worker
// Minimal: detect a PDF in the active tab, then hand the URL to the built-in viewer.

const PDF_URL_RE = /\.pdf(?:$|[?#])/i;

function looksLikePdfUrl(url) {
  if (!url) return false;
  if (url.startsWith("file:")) return PDF_URL_RE.test(url);
  try {
    const u = new URL(url);
    if (PDF_URL_RE.test(u.pathname)) return true;
    // Some sites serve PDFs from a path without .pdf (e.g. arxiv, journals).
    return /\/pdf\/|\/download\/|format=pdf|type=pdf/i.test(u.href);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "openViewer") {
    const target = message.url
      ? chrome.runtime.getURL(
          "viewer.html?file=" + encodeURIComponent(message.url),
        )
      : chrome.runtime.getURL("viewer.html");
    chrome.tabs.create({ url: target }, () => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "probeActiveTab") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      sendResponse({
        ok: true,
        url: tab?.url || "",
        isPdf: looksLikePdfUrl(tab?.url || ""),
    });
    });
    return true;
  }
  return false;
});
