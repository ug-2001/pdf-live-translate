// Node smoke test: run textblocks.buildBlocks on a real PDF via pdf.js.
import { pathToFileURL } from "node:url";
import path from "node:path";

const deps = "C:\\Users\\ug\\Documents\\pdf-translate-deps\\node_modules\\pdfjs-dist\\legacy\\build\\pdf.mjs";
const mod = await import(pathToFileURL(deps).href);
const pdfjs = mod.default ?? mod;
const { buildBlocks } = await import(
  pathToFileURL(path.resolve("C:/Users/ug/Documents/pdf-live-translate/textblocks.js")).href
);

const file = process.argv[2];
const buf = new Uint8Array(await (await import("node:fs/promises")).readFile(file));
const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: false }).promise;
console.log("pages:", doc.numPages);

const page = await doc.getPage(Number(process.argv[3] || 1));
const h = page.getViewport({ scale: 1 }).height;
const tc = await page.getTextContent();
const blocks = buildBlocks(tc, h, 1);

console.log("blocks:", blocks.length);
for (const b of blocks.slice(0, 8)) {
  console.log(
    `- [${b.id}] top=${b.topPdf.toFixed(1)} h=${b.heightPdf.toFixed(1)} len=${b.text.length}`,
  );
  console.log("  " + b.text.slice(0, 220));
}
const avg = blocks.reduce((a, b) => a + b.text.length, 0) / Math.max(1, blocks.length);
console.log("avg block chars:", Math.round(avg));
console.log("longest:", Math.max(...blocks.map((b) => b.text.length)));
