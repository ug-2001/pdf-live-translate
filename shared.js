// Shared settings + translation core.
// Used by options.js (test connection) and viewer.js (live translation).

export const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  target: "简体中文",
  batchSize: 4,
  batchChars: 3000,
  autoTranslate: true,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored?.settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ------------------------------------------------------------------ */
/* Cache                                                              */
/* ------------------------------------------------------------------ */

const CACHE_PREFIX = "pdt:";

export function hashKey(settings, text) {
  // Small, stable, dependency-free string hash (FNV-1a 32-bit + length).
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h ^ (h >>> 16)) * 0x45d9f3b;
    h >>>= 0;
  }
  return `${settings.provider}|${settings.model}|${settings.target}|${text.length}|${h}`;
}

export function cacheGet(settings, text) {
  try {
    return localStorage.getItem(CACHE_PREFIX + hashKey(settings, text)) || "";
  } catch {
    return "";
  }
}

export function cacheSet(settings, text, translated) {
  try {
    localStorage.setItem(CACHE_PREFIX + hashKey(settings, text), translated);
  } catch {
    /* quota - ignore */
  }
}

export function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  return keys.length;
}

/* ------------------------------------------------------------------ */
/* Translation providers                                              */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = (target) =>
  `You are a precise translator for academic and technical PDF documents. ` +
  `Translate each segment into ${target}. Keep technical terms, code, formulas, ` +
  `numbers and proper nouns accurate; do not add commentary, do not merge or split segments. ` +
  `Return ONLY a JSON object shaped {"segments":[{"id":"<same id>","text":"<translation>"}]}. ` +
  `Every input id must appear exactly once.`;

function parseLooseJson(text) {
  if (!text) throw new Error("empty model response");
  let s = text.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model did not return JSON");
  }
  return JSON.parse(s.slice(start, end + 1));
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + path;
}

async function translateViaOpenAI(segments, settings, signal) {
  const res = await fetch(joinUrl(settings.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT(settings.target) },
        {
          role: "user",
          content: JSON.stringify({ segments }),
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = parseLooseJson(text);

  const out = new Map();
  const src = new Map(segments.map((s) => [s.id, s.text]));
  for (const seg of parsed?.segments || []) {
    if (typeof seg?.id !== "string" || typeof seg?.text !== "string") continue;
    if (!src.has(seg.id)) continue;
    const val = seg.text.trim();
    if (!val) continue;
    // Guard against the model echoing the source unchanged for long Latin text.
    const latin = (src.get(seg.id).match(/[A-Za-z]/g) || []).length;
    if (latin >= 30 && /^\s*$/.test(val)) continue;
    out.set(seg.id, val);
  }
  return out;
}

async function translateViaGoogle(segments, settings, signal) {
  const out = new Map();
  for (const seg of segments) {
    const lang = settings.target.includes("中") ? "zh-CN" : "zh-CN";
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto" +
      `&tl=${lang}&dt=t&q=` +
      encodeURIComponent(seg.text);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Google translate HTTP ${res.status}`);
    const data = await res.json();
    const joined = (data?.[0] || [])
      .map((part) => (Array.isArray(part) ? part[0] : ""))
      .join("");
    if (joined.trim()) out.set(seg.id, joined.trim());
  }
  return out;
}

/**
 * Translate a batch of {id, text} segments.
 * Returns Map(id -> translation). Throws on provider errors.
 */
export async function translateBatch(segments, settings, signal) {
  if (!segments.length) return new Map();
  if (settings.provider === "openai") {
    if (!settings.apiKey) throw new Error("未配置 API Key（打开设置页填写）");
    return translateViaOpenAI(segments, settings, signal);
  }
  return translateViaGoogle(segments, settings, signal);
}

/** Split blocks into provider-sized batches (段数 + 字符上限). */
export function makeBatches(blocks, settings) {
  const batches = [];
  let cur = [];
  let chars = 0;
  const maxN = Math.max(1, Math.min(4, settings.batchSize || 4));
  const maxChars = Math.max(300, Math.min(12000, settings.batchChars || 3000));
  for (const b of blocks) {
    const len = b.text.length;
    if (cur.length && (cur.length >= maxN || chars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(b);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
