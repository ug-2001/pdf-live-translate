import { getSettings, saveSettings, translateBatch, clearCache } from "./shared.js";

const $ = (id) => document.getElementById(id);
const msg = $("msg");

function setMsg(text, kind = "") {
  msg.textContent = text;
  msg.className = kind;
}

async function fill() {
  const s = await getSettings();
  $("provider").value = s.provider;
  $("baseUrl").value = s.baseUrl;
  $("model").value = s.model;
  $("apiKey").value = s.apiKey;
  $("target").value = s.target;
  $("batchSize").value = s.batchSize;
  $("batchChars").value = s.batchChars;
  $("autoTranslate").checked = s.autoTranslate;
  syncProviderVisibility();
}

function syncProviderVisibility() {
  $("openaiFields").hidden = $("provider").value !== "openai";
}

$("provider").addEventListener("change", syncProviderVisibility);

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const patch = {
    provider: $("provider").value,
    baseUrl: $("baseUrl").value.trim() || "https://api.deepseek.com",
    model: $("model").value.trim() || "deepseek-chat",
    apiKey: $("apiKey").value.trim(),
    target: $("target").value.trim() || "简体中文",
    batchSize: Number($("batchSize").value) || 4,
    batchChars: Number($("batchChars").value) || 3000,
    autoTranslate: $("autoTranslate").checked,
  };
  await saveSettings(patch);
  setMsg("已保存。回到 PDF 标签页重新打开即可生效。", "ok");
});

$("test").addEventListener("click", async () => {
  setMsg("测试中…");
  const settings = {
    ...(await getSettings()),
    provider: $("provider").value,
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value.trim(),
    target: $("target").value.trim() || "简体中文",
  };
  try {
    const t0 = performance.now();
    const out = await translateBatch(
      [{ id: "t1", text: "Attention is all you need." }],
      settings,
    );
    const ms = Math.round(performance.now() - t0);
    const got = out.get("t1");
    if (!got) throw new Error("返回为空");
    setMsg(`连接正常（${ms} ms）：${got}`, "ok");
  } catch (e) {
    setMsg("失败：" + (e.message || e), "err");
  }
});

$("clearCache").addEventListener("click", () => {
  // The viewer page owns the cache; ask it in a later version. Clear here too.
  const n = clearCache();
  setMsg(`已清空本页缓存 ${n} 条（PDF 标签页内的缓存需重新加载阅读器后再清）`, "ok");
});

fill();
