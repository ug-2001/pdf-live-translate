// Node smoke test for the translation core (no chrome APIs used on this path).
import { pathToFileURL } from "node:url";

const shared = await import(
  pathToFileURL("C:/Users/ug/Documents/pdf-live-translate/shared.js").href
);

const settings = {
  provider: "google",
  baseUrl: "",
  model: "",
  apiKey: "",
  target: "简体中文",
  batchSize: 4,
  batchChars: 3000,
};

const segs = [
  {
    id: "p1b0",
    text: "The men tried to patent the idea, but met with resistance from the government and the patent courts.",
  },
  {
    id: "p1b1",
    text: "Mervin Kelly had long regarded scientific research as a pursuit of the unknown that inherently defied corporate planning.",
  },
];

console.log("batches:", shared.makeBatches(segs.map((s) => ({ ...s, text: s.text })), settings).length);

const out = await shared.translateBatch(segs, settings);
for (const [id, text] of out) console.log(`${id}: ${text}`);

// batching limits
const many = Array.from({ length: 9 }, (_, i) => ({ id: "b" + i, text: "x".repeat(400) }));
console.log("batch count for 9 x 400 chars:", shared.makeBatches(many, settings).map((b) => b.length));
