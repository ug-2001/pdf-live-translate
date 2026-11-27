// PDF Live Translate - viewer
// Renders the PDF with pdf.js, groups text into paragraph blocks, and translates
// each block as it scrolls into view (small batches + local cache).

import * as pdfjsLib from "./vendor/pdf.min.mjs";
import {
  getSettings,
  translateBatch,
  makeBatches,
  cacheGet,
  cacheSet,
} from "./shared.js";
import { buildBlocks } from "./textblocks.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const pagesEl = $("pages");
const emptyEl = $("empty");
const statusEl = $("status");
const pageInfoEl = $("pageInfo");
const zoomLabelEl = $("zoomLabel");

const BASE_COL_WIDTH = 340;
const MODE_KEY = "pdt:mode";
const FS_KEY = "pdt:fs";
const FS_MIGRATED_KEY = "pdt:fsMigratedV2";
const SHOWPAGE_KEY = "pdt:page";

const state = {
  pdf: null,
  settings: null,
  pageWidth: 0,
  scale: 1, // pdf.js scale (points -> css px)
  zoom: 1,
  mode: "image", // "image" | "text"
  fontSize: 14, // English column size in px
  showPage: true, // show the original page scan on the right
  pages: [], // { el, canvas, col, reading, blocks:[], rendered:false }
  queue: [],
  inflight: 0,
  done: 0,
  total: 0,
  dpr: Math.min(2, window.devicePixelRatio || 1),
  sourceName: "",
};

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  state.settings = await getSettings();

  // Reading preferences live in this page's localStorage (per reader tab).
  state.mode = localStorage.getItem(MODE_KEY) === "text" ? "text" : "image";
  let savedFs = Number(localStorage.getItem(FS_KEY));
  // One-time migration: previous builds used a 14px default; new default is +2 bold English.
  if (Number.isFinite(savedFs) && savedFs > 0 && !localStorage.getItem(FS_MIGRATED_KEY)) {
    savedFs = Math.min(28, savedFs + 2);
    localStorage.setItem(FS_KEY, String(savedFs));
    localStorage.setItem(FS_MIGRATED_KEY, "1");
  }
  state.fontSize = Number.isFinite(savedFs) && savedFs >= 9 && savedFs <= 28 ? savedFs : 16;
  state.showPage = localStorage.getItem(SHOWPAGE_KEY) !== "0";
  applyMode();
  applyFontSize();
  applyPageVisibility();

  const params = new URLSearchParams(location.search);
  const fileUrl = params.get("file");

  $("showTr").addEventListener("change", (e) => {
    document.body.classList.toggle("hide-tr", !e.target.checked);
  });
  $("showPage").checked = state.showPage;
  $("showPage").addEventListener("change", (e) => {
    state.showPage = e.target.checked;
    localStorage.setItem(SHOWPAGE_KEY, state.showPage ? "1" : "0");
    applyPageVisibility();
    // Page width changed, so the render scale has to be recomputed from scratch.
    if (state.pdf) rebuild();
  });
  $("modeBtn").addEventListener("click", () => {
    state.mode = state.mode === "text" ? "image" : "text";
    localStorage.setItem(MODE_KEY, state.mode);
    applyMode();
    reflowAll();
  });
  $("fsUp").addEventListener("click", () => {
    state.fontSize = Math.min(28, state.fontSize + 1);
    localStorage.setItem(FS_KEY, String(state.fontSize));
    applyFontSize();
    reflowAll();
  });
  $("fsDown").addEventListener("click", () => {
    state.fontSize = Math.max(9, state.fontSize - 1);
    localStorage.setItem(FS_KEY, String(state.fontSize));
    applyFontSize();
    reflowAll();
  });
  $("zoomIn").addEventListener("click", () => setZoom(state.zoom * 1.15));
  $("zoomOut").addEventListener("click", () => setZoom(state.zoom / 1.15));
  $("settingsLink").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $("fileInput").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) openFile(f);
  });
  $("urlOpen").addEventListener("click", () => {
    const v = $("urlInput").value.trim();
    if (!v) return;
    openRemote(v);
  });
  wireDragAndDrop();
  window.addEventListener("resize", debounce(reflowAll, 300));

  if (fileUrl) {
    openRemote(fileUrl, params.get("name") || "");
  } else {
    showEmpty();
  }
}

function applyMode() {
  document.body.classList.toggle("mode-text", state.mode === "text");
  $("modeBtn").textContent = state.mode === "text" ? "纯文本" : "图文对照";
}

function applyPageVisibility() {
  document.body.classList.toggle("hide-page", !state.showPage);
}

function applyFontSize() {
  document.documentElement.style.setProperty("--en-size", state.fontSize + "px");
  document.documentElement.style.setProperty("--zh-size", Math.max(9, state.fontSize - 2) + "px");
  $("fsLabel").textContent = String(state.fontSize);
}

function showEmpty() {
  emptyEl.style.display = "";
  pagesEl.style.display = "none";
}

function showDoc() {
  emptyEl.style.display = "none";
  pagesEl.style.display = "";
}

/* ------------------------------------------------------------------ */
/* Loading                                                            */
/* ------------------------------------------------------------------ */

async function openRemote(url, name = "") {
  setStatus("正在读取 PDF…");
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    state.sourceName = name || decodeURIComponent(url.split("/").pop() || "PDF");
    await openArrayBuffer(buf);
  } catch (err) {
    setStatus("读取失败：" + (err.message || err), true);
    showEmpty();
  }
}

async function openFile(file) {
  setStatus("正在读取 " + file.name + "…");
  const buf = await file.arrayBuffer();
  state.sourceName = file.name;
  await openArrayBuffer(buf);
}

async function openArrayBuffer(data) {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  state.pdf = doc;
  state.done = 0;
  state.total = 0;
  state.queue = [];
  state.inflight = 0;
  state.pages = [];
  state.blocksById.clear();
  pagesEl.innerHTML = "";
  $("docTitle").textContent = state.sourceName || "PDF";
  $("docTitle").title = state.sourceName || "";

  const firstPage = await doc.getPage(1);
  const vp1 = firstPage.getViewport({ scale: 1 });
  state.pageWidth = vp1.width;

  // Translation column takes the main width; the original page becomes the narrow gutter.
  const colWidth = calcColWidth();
  document.documentElement.style.setProperty("--tr-col", colWidth + "px");
  let baseScale;
  if (state.showPage) {
    const content = Math.max(360, window.innerWidth - 76);
    const avail = Math.max(240, content - colWidth - 14);
    baseScale = Math.min(2.2, avail / vp1.width);
  } else {
    baseScale = 1;
  }
  state.scale = baseScale * state.zoom;

  for (let i = 1; i <= doc.numPages; i++) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = String(i);
    const canvas = document.createElement("canvas");
    const col = document.createElement("div");
    col.className = "col";
    const reading = document.createElement("div");
    reading.className = "reading";
    el.append(canvas, col, reading);
    pagesEl.append(el);
    state.pages.push({ el, canvas, col, reading, blocks: [], rendered: false });
    pageTracker.observe(el);
  }

  showDoc();
  updateZoomLabel();
  observePages();
  setStatus(`共 ${doc.numPages} 页`);
}

function calcColWidth() {
  // Content area inside #pages (18px padding each side) and the .page card.
  const content = Math.max(360, window.innerWidth - 76);
  if (!state.showPage) return content;
  // Translation gets ~60% of the width, the original page keeps the narrow gutter.
  return Math.round(Math.max(420, content * 0.6));
}

/* ------------------------------------------------------------------ */
/* Lazy page rendering                                                */
/* ------------------------------------------------------------------ */

let pageObserver = null;

function observePages() {
  pageObserver?.disconnect();
  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageNo = Number(entry.target.dataset.page);
        renderPage(pageNo);
      }
    },
    { rootMargin: "800px 0px" },
  );
  state.pages.forEach((p) => pageObserver.observe(p.el));
}

async function renderPage(pageNo) {
  const rec = state.pages[pageNo - 1];
  if (!rec || rec.rendered) return;
  rec.rendered = true;

  const page = await state.pdf.getPage(pageNo);
  const vpCss = page.getViewport({ scale: state.scale });
  const vpHi = page.getViewport({ scale: state.scale * state.dpr });

  if (state.showPage) {
    rec.canvas.width = Math.floor(vpHi.width);
    rec.canvas.height = Math.floor(vpHi.height);
    rec.canvas.style.width = Math.floor(vpCss.width) + "px";
    rec.canvas.style.height = Math.floor(vpCss.height) + "px";

    await page.render({
      canvasContext: rec.canvas.getContext("2d", { alpha: false }),
      viewport: vpHi,
    }).promise;
  } else {
    rec.canvas.width = 0;
    rec.canvas.height = 0;
  }

  const textContent = await page.getTextContent();
  const pageHeightPdf = page.getViewport({ scale: 1 }).height;
  const blocks = buildBlocks(textContent, pageHeightPdf, pageNo);

  if (!blocks.length) {
    const note = document.createElement("div");
    note.className = "colTitle";
    note.textContent = "本页无可提取文字（可能是扫描件）";
    rec.col.append(note);
    return;
  }

  rec.blocks = blocks;
  for (const b of blocks) createBlockEl(rec, b);
  layoutPage(rec);
  state.total += blocks.length;

  for (const b of blocks) {
    const cached = cacheGet(state.settings, b.text);
    if (cached) {
      fillBlock(b, cached);
    } else if (state.settings.autoTranslate) {
      blockObserver.observe(b.el);
    }
  }
  updateStatus();
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Block DOM + column layout                                          */
/* ------------------------------------------------------------------ */

function createBlockEl(rec, b) {
  // --- image mode: absolute card in the right column ---
  const el = document.createElement("div");
  el.className = "tblock pending";
  el.style.top = "0px";
  el.dataset.id = b.id;

  const src = document.createElement("span");
  src.className = "src";
  src.textContent = b.text;

  const tr = document.createElement("span");
  tr.className = "tr";
  tr.textContent = state.settings.autoTranslate ? "…" : "";

  el.append(src, tr);

  // --- text mode: flowing row with English (Courier New) + Chinese ---
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = b.id;
  const en = document.createElement("div");
  en.className = "en";
  en.textContent = b.text;
  const zh = document.createElement("div");
  zh.className = "zh pending";
  zh.textContent = state.settings.autoTranslate ? "…" : "点一下翻译这段";
  row.append(en, zh);

  const retry = () => {
    if (b.state === "error" || b.state === "idle") {
      b.state = "idle";
      el.classList.remove("error");
      row.classList.remove("error");
      tr.textContent = "…";
      zh.textContent = "…";
      enqueue(b);
    }
  };
  el.addEventListener("click", retry);
  zh.addEventListener("click", retry);

  b.el = el;
  b.row = row;
  b.trEl = tr;
  b.zhEl = zh;
  b.state = "idle";
  if (state.settings.autoTranslate) {
    tr.textContent = "…";
  } else {
    el.classList.remove("pending");
    tr.textContent = "点一下翻译这段";
  }
  rec.col.append(el);
  rec.reading.append(row);
  state.blocksById.set(b.id, b);
}

function layoutPage(rec) {
  const scale = state.scale;
  let cursor = 0;
  for (const b of rec.blocks) {
    const desired = b.topPdf * scale;
    const top = Math.max(desired, cursor);
    b.el.style.top = Math.round(top) + "px";
    b.el.style.minHeight = Math.round(b.heightPdf * scale) + "px";
    cursor = top + Math.max(b.el.offsetHeight, b.heightPdf * scale) + 4;
  }
  rec.col.style.minHeight = Math.max(
    rec.canvas.height / state.dpr,
    cursor,
  ) + "px";
}

function reflowAll() {
  if (!state.pages.length) return;
  const colWidth = calcColWidth();
  document.documentElement.style.setProperty("--tr-col", colWidth + "px");
  state.pages.forEach((rec) => {
    if (rec.blocks?.length) layoutPage(rec);
  });
}

/* ------------------------------------------------------------------ */
/* Translation queue                                                  */
/* ------------------------------------------------------------------ */

const blockObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.dataset.id;
      const block = state.blocksById?.get(id);
      if (block && block.state === "idle") enqueue(block);
      blockObserver.unobserve(entry.target);
    }
  },
  { rootMargin: "300px 0px" },
);

state.blocksById = new Map();

function enqueue(block) {
  if (block.state !== "idle") return;
  block.state = "queued";
  state.queue.push(block);
  block.el.classList.remove("error");
  block.el.classList.add("pending");
  pump();
}

async function pump() {
  const settings = state.settings;
  const MAX_INFLIGHT = 2;
  while (state.inflight < MAX_INFLIGHT && state.queue.length) {
    // Take a batch from the head of the queue.
    const head = state.queue[0];
    const batches = makeBatches([head, ...state.queue.slice(1)], settings);
    const batch = batches[0] || [head];
    state.queue = state.queue.slice(batch.length);
    if (!batch.length) break;

    const segs = batch.map((b) => ({ id: b.id, text: b.text }));
    batch.forEach((b) => {
      b.state = "loading";
      b.trEl.textContent = "翻译中…";
      b.zhEl.textContent = "翻译中…";
    });

    state.inflight++;
    translateBatch(segs, settings)
      .then((map) => {
        for (const b of batch) {
          const t = map.get(b.id);
          if (t) {
            cacheSet(settings, b.text, t);
            fillBlock(b, t);
          } else {
            markError(b, "未返回译文");
          }
        }
      })
      .catch((err) => {
        const msg = err?.message || String(err);
        for (const b of batch) markError(b, msg);
        setStatus("翻译出错：" + msg, true);
      })
      .finally(() => {
        state.inflight--;
        updateStatus();
        pump();
      });
    updateStatus();
  }
  updateStatus();
}

function fillBlock(b, text) {
  b.state = "done";
  b.el.classList.remove("pending", "error");
  b.el.classList.add("done");
  b.trEl.textContent = text;
  b.zhEl.classList.remove("pending", "error");
  b.zhEl.textContent = text;
  state.done++;
  const rec = state.pages[b.pageNo - 1];
  if (rec && state.mode === "image") layoutPage(rec);
  updateStatus();
}

function markError(b, msg) {
  b.state = "error";
  b.el.classList.remove("pending");
  b.el.classList.add("error");
  b.trEl.textContent = "失败：" + msg + "（点此重试）";
  b.zhEl.classList.remove("pending");
  b.zhEl.classList.add("error");
  b.zhEl.textContent = "失败：" + msg + "（点此重试）";
  const rec = state.pages[b.pageNo - 1];
  if (rec && state.mode === "image") layoutPage(rec);
}

function updateStatus() {
  const q = state.queue.length;
  statusEl.textContent = `${state.done}/${state.total} 段已译${q ? ` · 队列 ${q}` : ""}`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", !!isError);
}

/* ------------------------------------------------------------------ */
/* Zoom / misc                                                        */
/* ------------------------------------------------------------------ */

function setZoom(next) {
  state.zoom = Math.min(3, Math.max(0.4, next));
  updateZoomLabel();
  rebuild();
}

function updateZoomLabel() {
  zoomLabelEl.textContent = Math.round(state.zoom * 100) + "%";
}

async function rebuild() {
  if (!state.pdf) return;
  // Re-render at the new scale, keeping translation results (cached).
  const doc = state.pdf;
  const buf = await doc.getData();
  state.queue = [];
  state.done = 0;
  state.total = 0;
  await openArrayBuffer(buf);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function wireDragAndDrop() {
  const hint = $("dropHint");
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    depth++;
    hint.classList.add("on");
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.classList.remove("on");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    hint.classList.remove("on");
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.pdf$/i.test(file.name)) openFile(file);
  });
}

// Track the page currently in view for the toolbar indicator.
const pageTracker = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        pageInfoEl.textContent = `第 ${entry.target.dataset.page} 页`;
      }
    }
  },
  { threshold: 0.2 },
);

boot();
