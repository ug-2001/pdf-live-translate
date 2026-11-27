// Pure text-block extraction: pdf.js text content -> paragraph-ish blocks.
// Kept DOM-free so it can be unit-tested in Node.

export function buildBlocks(textContent, pageHeightPdf, pageNo) {
  const items = (textContent?.items || []).filter((it) => it.str && it.str.trim());
  if (!items.length) return [];

  // 1) group items into visual lines by baseline y
  const lines = [];
  for (const it of items) {
    const tr = it.transform;
    const x = tr[4];
    const y = tr[5];
    const h = Math.abs(tr[3]) || it.height || 10;
    let line = null;
    for (const l of lines) {
      if (Math.abs(l.y - y) <= Math.max(1.5, h * 0.35)) {
        line = l;
        break;
      }
    }
    if (!line) {
      line = { y, h, parts: [] };
      lines.push(line);
    }
    line.h = Math.max(line.h, h);
    line.parts.push({ x, w: it.width || 0, str: it.str });
  }

  // 2) concatenate parts, inserting spaces where the gaps need them
  lines.sort((a, b) => b.y - a.y);
  const good = [];
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = null;
    for (const p of l.parts) {
      if (prevEnd !== null) {
        const gap = p.x - prevEnd;
        if (gap > l.h * 0.18 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += " ";
      }
      text += p.str;
      prevEnd = p.x + p.w;
    }
    l.text = text.replace(/\s+/g, " ").trim();
    if (!l.text) continue;
    l.xStart = Math.min(...l.parts.map((p) => p.x));
    l.xEnd = Math.max(...l.parts.map((p) => p.x + p.w));
    good.push(l);
  }

  // 3) merge lines into paragraphs
  const textWidth = median(good.map((l) => l.xEnd - l.xStart));

  // Adaptive leading: most PDFs have consistent line spacing, so the median
  // baseline gap on this page is a better threshold than the glyph height.
  const gaps = [];
  for (let i = 1; i < good.length; i++) {
    const a = good[i - 1];
    const b = good[i];
    if (Math.abs(b.xStart - a.xStart) <= Math.max(8, b.h * 2)) {
      gaps.push(a.y - b.y);
    }
  }
  const leading = gaps.length ? median(gaps) : 0;

  const groups = [];
  for (const l of good) {
    const prev = groups[groups.length - 1];
    const last = prev?.lines[prev.lines.length - 1];
    const gap = last ? last.y - l.y : Infinity;
    const sameColumn = last ? Math.abs(l.xStart - last.xStart) <= Math.max(8, l.h * 1.2) : false;
    const lastWasShort = last ? last.xEnd - last.xStart < textWidth * 0.55 : false;
    const endsSentence = last ? /[.!?:;]["')\]]*\s*$/.test(last.text) : false;
    const threshold = Math.min(
      l.h * 3.2,
      Math.max(leading * 1.45 || 0, l.h * 1.5),
    );
    // A short previous line usually means "paragraph ended here"; only glue it
    // on when the next line sits at normal leading.
    const tightAfterShort = lastWasShort && gap > (leading * 1.15 || l.h * 1.2);
    const continuous =
      last && sameColumn && gap <= threshold && !endsSentence && !tightAfterShort;

    if (!continuous) groups.push({ lines: [l] });
    else prev.lines.push(l);
  }

  return groups
    .map((g, i) => {
      const first = g.lines[0];
      const last = g.lines[g.lines.length - 1];
      const text = g.lines.map((l) => l.text).join(" ");
      if (text.length < 6) return null;
      const topPdf = pageHeightPdf - (first.y + first.h * 1.15);
      const bottomPdf = pageHeightPdf - (last.y - last.h * 0.25);
      return {
        id: `p${pageNo}b${i}`,
        pageNo,
        text,
        topPdf,
        heightPdf: Math.max(8, bottomPdf - topPdf),
      };
    })
    .filter(Boolean)
    .flatMap(splitLongBlock);
}

const MAX_BLOCK_CHARS = 600;

/**
 * Very long paragraphs are split at a sentence boundary near the middle so the
 * first half can be translated and shown while the second half is still in
 * flight. Vertical space is shared proportional to the character count.
 */
function splitLongBlock(block) {
  if (block.text.length <= MAX_BLOCK_CHARS) return [block];
  const parts = [];
  let rest = block.text;
  let n = 0;
  const total = block.text.length;
  let consumed = 0;
  while (rest.length > MAX_BLOCK_CHARS) {
    const window = rest.slice(0, MAX_BLOCK_CHARS);
    let cut = -1;
    const re = /[.!?]["')\]]?\s/g;
    let m;
    while ((m = re.exec(window))) {
      if (m.index > MAX_BLOCK_CHARS * 0.35) cut = m.index + m[0].length;
    }
    if (cut <= 0) cut = MAX_BLOCK_CHARS;
    parts.push(rest.slice(0, cut).trim());
    consumed += cut;
    rest = rest.slice(cut);
    n++;
  }
  if (rest.trim()) parts.push(rest.trim());

  return parts.map((text, i) => {
    const share = text.length / total;
    const offset = shareToOffset(parts, i);
    const heightPdf = Math.max(8, block.heightPdf * share);
    return {
      ...block,
      id: `${block.id}s${i}`,
      text,
      topPdf: block.topPdf + block.heightPdf * offset,
      heightPdf,
    };
  });
}

function shareToOffset(parts, index) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const before = parts.slice(0, index).reduce((a, p) => a + p.length, 0);
  return before / total;
}

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
