// Popup: route the user into the built-in viewer.
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function openViewer(url) {
  chrome.runtime.sendMessage({ type: "openViewer", url: url || "" }, () => {
    window.close();
  });
}

chrome.runtime.sendMessage({ type: "probeActiveTab" }, (res) => {
  const btn = $("current");
  if (!res?.ok) {
    btn.textContent = "无法读取当前标签页";
    return;
  }
  if (res.isPdf) {
    btn.disabled = false;
    btn.textContent = "翻译当前这个 PDF";
    btn.onclick = () => openViewer(res.url);
  } else {
    btn.disabled = true;
    btn.textContent = "当前页面不是 PDF";
    statusEl.textContent =
      "浏览器里显示 PDF 但没有 .pdf 后缀时，可复制链接后用本地文件/链接方式打开。";
  }
});

$("localBtn").addEventListener("click", () => openViewer(""));

$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
