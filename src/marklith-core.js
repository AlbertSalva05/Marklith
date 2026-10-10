// marklith core: formatting, OCR and local storage. No network calls except loading the OCR engine itself.

export const LIMITS = {
  // Provisional product rules, confirm with real uploads (Step 02, open question 6).
  maxBytes: 10 * 1024 * 1024,
  maxEdge: 2400,
  types: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'],
  typeLabel: 'PNG, JPG, WebP or BMP',
  lowConfidence: 60,
  maxFiles: 10,
  maxTotal: 100,
  quality: 0.85
};

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export function validateFile(file) {
  if (!file) return { ok: false, reason: 'No file was chosen.' };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!LIMITS.types.includes(file.type)) {
    const shown = ext ? ext.toUpperCase() : 'This file type';
    return { ok: false, reason: `${shown} files can't be read. Use ${LIMITS.typeLabel}.` };
  }
  if (file.size > LIMITS.maxBytes) {
    return { ok: false, reason: `This image is ${formatBytes(file.size)}. The limit is ${formatBytes(LIMITS.maxBytes)}. Try a smaller screenshot or crop it first.` };
  }
  return { ok: true };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function browserSupport() {
  const missing = [];
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  if (typeof indexedDB === 'undefined') missing.push('IndexedDB');
  return missing;
}

/* ---------- OCR ---------- */

let workerPromise = null;
let currentLogger = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('The text engine could not be downloaded. Check your connection and try again.'));
    document.head.appendChild(s);
  });
}

async function getWorker(lang, onProgress) {
  currentLogger = onProgress;
  if (!workerPromise) {
    workerPromise = (async () => {
      onProgress({ stage: 1, label: 'Loading text engine (first run only)', value: 0.1 });
      await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker(lang, 1, {
        logger: (m) => {
          if (!currentLogger) return;
          if (m.status === 'recognizing text') currentLogger({ stage: 2, label: 'Reading text', value: m.progress || 0 });
          else currentLogger({ stage: 1, label: 'Loading text engine (first run only)', value: Math.min(0.95, m.progress || 0.2) });
        }
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

export async function cancelOcr() {
  const p = workerPromise; workerPromise = null; currentLogger = null;
  if (p) { try { (await p).terminate(); } catch (e) {} }
}

// Scales the image to LIMITS.maxEdge and re-encodes it (WebP, JPEG fallback). The original file is not kept.
export async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LIMITS.maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const encode = (type) => new Promise((res) => canvas.toBlob(res, type, LIMITS.quality));
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  // Keep the original if re-encoding made it bigger (small, flat screenshots).
  if (!scale || (scale === 1 && blob.size >= file.size)) blob = file;
  return { blob, canvas, w, h, before: file.size, after: blob.size, scaled: scale < 1 };
}

export async function canvasFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return { canvas, w: bmp.width, h: bmp.height };
}

// Returns { text, lines: [{text, box:{x,y,w,h} as fractions}], lowWords: [string], confidence }
export async function extractText(source, { lang = 'eng', mainOnly = true, onProgress = () => {} } = {}) {
  const worker = await getWorker(lang, onProgress);
  const { canvas, w, h } = source.canvas ? source : await canvasFromBlob(source);
  onProgress({ stage: 2, label: 'Reading text', value: 0 });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  onProgress({ stage: 3, label: 'Formatting output', value: 0.5 });
  const split = splitMainText(data, w, h, mainOnly);
  onProgress({ stage: 3, label: 'Formatting output', value: 1 });
  return { ...split, confidence: Math.round(data.confidence || 0) };
}

/* ---------- Main text vs text inside pictures ---------- */

// Text inside screenshots, photos, charts and logos tends to be much smaller than the body, read with low
// confidence, mostly symbols, or sitting alone in a tiny block. Those lines are set aside, not deleted.
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function splitMainText(data, w, h, mainOnly) {
  const rows = [];
  (data.blocks || []).forEach((b, bi) => {
    const bt = String(b.blocktype || b.block_type || '');
    (b.paragraphs || []).forEach((p, pi) => (p.lines || []).forEach((l) => {
      const t = (l.text || '').replace(/\s+$/, '');
      if (!t.trim()) return;
      const bb = l.bbox; const words = (l.words || []).filter((x) => x.text.trim());
      rows.push({ bi, pi, t: t.trim(), bt, hgt: bb.y1 - bb.y0, conf: l.confidence != null ? l.confidence : (words.reduce((a, x) => a + x.confidence, 0) / Math.max(1, words.length)), nWords: words.length, words,
        letters: (t.match(/[A-Za-z0-9\u00C0-\u024F]/g) || []).length / Math.max(1, t.replace(/\s/g, '').length),
        box: { x: bb.x0 / w, y: bb.y0 / h, w: (bb.x1 - bb.x0) / w, h: (bb.y1 - bb.y0) / h } });
    }));
  });
  const solid = rows.filter((r) => r.nWords >= 3 && r.conf >= 60);
  const H = median((solid.length ? solid : rows).map((r) => r.hgt)) || 1;
  const blockStats = {};
  rows.forEach((r) => { const s = blockStats[r.bi] || (blockStats[r.bi] = { n: 0, words: 0, conf: 0 }); s.n++; s.words += r.nWords; s.conf += r.conf; });
  rows.forEach((r) => {
    const bs = blockStats[r.bi]; const bConf = bs.conf / bs.n;
    r.graphic = /IMAGE|NOISE|PICTURE/i.test(r.bt)
      || r.hgt < H * 0.55
      || r.conf < 40
      || r.letters < 0.5
      || (bs.n <= 2 && bs.words <= 4 && bConf < 70 && r.hgt < H * 0.9);
  });
  let keep = mainOnly ? rows.filter((r) => !r.graphic) : rows;
  if (!keep.length) keep = rows;
  const left = mainOnly ? rows.filter((r) => r.graphic && keep.includes(r) === false) : [];
  const build = (list) => { let out = '', prev = null; list.forEach((r) => { if (prev) out += (prev.bi !== r.bi || prev.pi !== r.pi) ? '\n\n' : '\n'; out += r.t; prev = r; }); return normalize(out); };
  const lowWords = [];
  keep.forEach((r) => r.words.forEach((wd) => { if (wd.confidence < LIMITS.lowConfidence && wd.text.trim().length > 1) lowWords.push(wd.text.trim()); }));
  return { text: build(keep), lines: keep.map((r) => ({ text: r.t, box: r.box })), lowWords, excludedText: build(left), excludedCount: left.length };
}

/* ---------- Crop ---------- */
export async function cropImage(source, rect) {
  const { canvas, w, h } = source.canvas ? source : await canvasFromBlob(source.blob);
  const sx = Math.round(rect.x * w), sy = Math.round(rect.y * h), sw = Math.max(8, Math.round(rect.w * w)), sh = Math.max(8, Math.round(rect.h * h));
  const out = document.createElement('canvas'); out.width = sw; out.height = sh;
  const ctx = out.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const encode = (type) => new Promise((res) => out.toBlob(res, type, LIMITS.quality));
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  return { blob, canvas: out, w: sw, h: sh, after: blob.size };
}

/* ---------- Formatting: one structure parser, three writers ---------- */

const CODEISH = /[{};]|=>|==|&&|\|\||::|\(\)|\s--?[a-z]|^\s{2,}\S|^\s*\$\s|^\s*(const|let|var|function|import|export|return|def|class|npm|npx|yarn|pnpm|pip|git|cd|sudo|brew|curl)\b/;
const BULLET_FAMS = { '-': 'dash', '*': 'dash', '+': 'dash', '\u2022': 'dot', '\u25cf': 'dot', '\u00b7': 'dot', '\u2219': 'dot', '\u25e6': 'circle', '\u25cb': 'circle', '\u25aa': 'square', '\u25a0': 'square', '\u25ab': 'square', '\u25a1': 'square', '\u2013': 'endash', '\u2014': 'endash', '\u2713': 'check', '\u2714': 'check', '\u27a4': 'arrow', '\u25ba': 'arrow', '\u2023': 'arrow', '\u2043': 'arrow' };
const GLYPHS = Object.keys(BULLET_FAMS).filter((k) => !'-*+\u2013\u2014'.includes(k)).join('');
const GLYPH_RE = new RegExp('^(\\s*)([' + GLYPHS + '])\\s*(\\S.*)$');
const ITEM_RE = /^(\s*)(?:([-*+\u2013\u2014])|\(?([0-9]{1,3}|[A-Za-z]|[ivxIVX]{2,4})[.)])\s+(\S.*)$/;
const FENCE = /^\s*(\x60\x60\x60|~~~)/;
const MDH = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const SETEXT = /^\s*(={3,}|-{3,})\s*$/;
const SECTION = /^(\d{1,2}(?:\.\d{1,2}){1,3})\.?\s+(\S.*)$/;
const DOTS = ['\u2022', '\u25e6', '\u25aa'];
const indentOf = (l) => l.match(/^\s*/)[0].length;
const isRow = (l) => (l.match(/\|/g) || []).length >= 2 || (/\|/.test(l) && /^\s*\||\|\s*$/.test(l));

export function normalize(t) {
  return t.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function joinWrapped(lines) {
  return lines.reduce((acc, l) => {
    const t = l.trim();
    if (!acc) return t;
    if (/[a-z]-$/.test(acc) && /^[a-z]/.test(t)) return acc.slice(0, -1) + t;
    return acc + ' ' + t;
  }, '');
}

function matchItem(line, stack) {
  let m = line.match(GLYPH_RE);
  if (m) return { indent: m[1].length, fam: BULLET_FAMS[m[2]], ordered: false, text: m[3] };
  m = line.match(ITEM_RE);
  if (!m) return null;
  const indent = m[1].length, text = m[4];
  if (m[2]) return { indent, fam: BULLET_FAMS[m[2]], ordered: false, text };
  const tok = m[3];
  if (/^\d+$/.test(tok)) return { indent, fam: 'num', ordered: true, start: +tok, text };
  const romanish = /^(i{1,3}|iv|vi{0,3}|ix|x)$/i.test(tok);
  const alpha = [...stack].reverse().find((s) => s.fam === 'alpha' || s.fam === 'ALPHA');
  const followsAlpha = alpha && tok.length === 1 && tok.toLowerCase().charCodeAt(0) === String(alpha.last).toLowerCase().charCodeAt(0) + 1;
  const lower = tok === tok.toLowerCase();
  if (romanish && !followsAlpha && (tok.length > 1 || stack.length)) return { indent, fam: lower ? 'roman' : 'ROMAN', ordered: true, start: fromRoman(tok), text };
  if (tok.length === 1 && (stack.length || /[aA]/.test(tok))) return { indent, fam: lower ? 'alpha' : 'ALPHA', ordered: true, start: tok.toLowerCase().charCodeAt(0) - 96, letter: tok, text };
  return null;
}

// Nesting comes from indentation when the source has it, otherwise from marker changes (1. then a. then a bullet), the way a reader infers it.
function placeItem(stack, it) {
  const mark = (s) => { s.last = it.letter || it.start; };
  if (!stack.length) { stack.push({ indent: it.indent, fam: it.fam }); mark(stack[0]); return 0; }
  let top = stack[stack.length - 1];
  if (it.indent >= top.indent + 2) { stack.push({ indent: it.indent, fam: it.fam }); mark(stack[stack.length - 1]); return stack.length - 1; }
  while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent - 2) stack.pop();
  top = stack[stack.length - 1];
  if (top.fam === it.fam) { mark(top); return stack.length - 1; }
  for (let k = stack.length - 2; k >= 0; k--) {
    if (stack[k].fam === it.fam) { stack.length = k + 1; mark(stack[k]); return k; }
  }
  if (stack.length >= 6) { mark(top); return stack.length - 1; }
  stack.push({ indent: it.indent, fam: it.fam }); mark(stack[stack.length - 1]);
  return stack.length - 1;
}

function headingHint(l, alone) {
  const t = l.trim();
  if (!t || t.length > 80) return null;
  const sec = t.match(SECTION);
  if (sec && !/[.;,]$/.test(t)) return 'sec:' + sec[1].split('.').length;
  if (/[.!?;,]$/.test(t) || /[a-z]-$/.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length > 12) return null;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return 'caps';
  if (/:$/.test(t) && words.length <= 6 && /^[A-Z0-9]/.test(t)) return 'label';
  const sig = words.filter((w, k) => k === 0 || w.replace(/[^A-Za-z]/g, '').length > 3);
  const caps = sig.filter((w) => /^["'(]?[A-Z0-9]/.test(w)).length;
  if (words.length >= 2 && caps / sig.length >= 0.75 && /^["'(]?[A-Z0-9]/.test(t)) return 'title';
  if (alone && t.length <= 60 && /^["'(]?[A-Z0-9]/.test(t)) return 'plain';
  return null;
}

function pushGroup(blocks, group) {
  const codeN = group.filter((l) => CODEISH.test(l)).length;
  if (codeN && codeN / group.length >= 0.5) {
    const min = Math.min(...group.map(indentOf));
    blocks.push({ type: 'code', text: group.map((l) => l.slice(min)).join('\n'), lang: '' });
    return;
  }
  const g = group.slice();
  // A stack of three or more short lines with no sentence punctuation reads as an unmarked list.
  const short = g.length >= 3 && g.every((l) => l.trim().length <= 48 && !/[,;]$|[a-z]-$/.test(l.trim()));
  if (short) {
    const hint = headingHint(g[0], false);
    if (hint && hint !== 'plain') { blocks.push({ type: 'heading', hint, text: g.shift().trim().replace(/:$/, '') }); }
    blocks.push({ type: 'list', items: g.map((l) => ({ text: l.trim(), level: 0, ordered: false, fam: 'dot', start: 1 })) });
    return;
  }
  while (g.length) {
    let hint = headingHint(g[0], g.length === 1);
    // A short capitalised line directly above a sentence that starts with a capital is a heading, not a wrapped line.
    if (!hint && g.length > 1) { const t = g[0].trim(); if (t.length <= 40 && t.split(/\s+/).length <= 5 && /^["'(]?[A-Z0-9]/.test(t) && !/[.!?;,:]$/.test(t) && /^["'(]?[A-Z]/.test(g[1].trim())) hint = 'lead'; }
    if (!hint) break;
    blocks.push({ type: 'heading', hint, text: g.shift().trim().replace(/:$/, '') });
  }
  if (g.length) blocks.push({ type: 'p', text: joinWrapped(g) });
}

function assignLevels(blocks) {
  const explicitH1 = blocks.some((b) => b.type === 'heading' && b.explicit && b.level === 1);
  let last = 0, section = 0, prevHeading = false;
  blocks.forEach((b, idx) => {
    if (b.type !== 'heading') { prevHeading = false; return; }
    if (!b.explicit) {
      const h = b.hint; let lv;
      if (h.startsWith('sec:')) lv = Math.min(6, +h.slice(4) + 1);
      else if (idx === 0 && !explicitH1) lv = 1;
      else if (h === 'label') lv = Math.min(6, Math.max(2, section + 1));
      else if (prevHeading) lv = Math.min(6, Math.max(2, last + 1));
      else lv = 2;
      b.level = lv;
    }
    last = b.level;
    if (b.hint !== 'label') section = b.level;
    prevHeading = true;
  });
  return blocks;
}

let memo = { text: null, blocks: [] };
export function analyze(text) {
  if (memo.text === text) return memo.blocks;
  const L = String(text || '').replace(/\r/g, '').replace(/\t/g, '    ').split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks = []; let stack = [], list = null, i = 0, gap = false;
  const endList = () => { list = null; stack = []; };
  const breaksGroup = (l) => !l.trim() || FENCE.test(l) || MDH.test(l) || QUOTE.test(l) || HR.test(l) || matchItem(l, []) || (isRow(l) && blocks);
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { gap = true; i++; continue; }
    const wasGap = gap; gap = false;
    if (FENCE.test(l)) {
      endList(); const f = l.trim().slice(0, 3); const lang = l.trim().slice(3).trim(); const body = []; i++;
      while (i < L.length && !L[i].trim().startsWith(f)) body.push(L[i++]);
      i++; blocks.push({ type: 'code', text: body.join('\n'), lang }); continue;
    }
    const h = l.match(MDH);
    if (h) { endList(); blocks.push({ type: 'heading', level: h[1].length, text: h[2], explicit: true }); i++; continue; }
    if (HR.test(l)) { endList(); blocks.push({ type: 'hr' }); i++; continue; }
    if (QUOTE.test(l)) { endList(); const q = []; while (i < L.length && QUOTE.test(L[i])) q.push(L[i++].match(QUOTE)[1]); blocks.push({ type: 'quote', text: joinWrapped(q.filter((x) => x.trim())) }); continue; }
    if (isRow(l) && i + 1 < L.length && isRow(L[i + 1])) {
      endList(); const rows = [];
      while (i < L.length && isRow(L[i])) { const r = L[i++]; if (/^[\s|:-]+$/.test(r)) continue; rows.push(r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((x) => x.trim())); }
      blocks.push({ type: 'table', rows }); continue;
    }
    const it = matchItem(l, stack);
    if (it) {
      // After a blank line, a top-level item with a marker style not already open starts a new list.
      if (list && wasGap && it.indent <= stack[0].indent + 1 && !stack.some((s) => s.fam === it.fam)) endList();
      if (!list) { list = { type: 'list', items: [] }; blocks.push(list); stack = []; }
      const level = placeItem(stack, it);
      const item = { text: it.text.trim(), level, ordered: it.ordered, fam: it.fam, start: it.start || 1 };
      list.items.push(item); i++;
      while (i < L.length) {
        const n = L[i];
        if (!n.trim()) {
          let j = i; while (j < L.length && !L[j].trim()) j++;
          if (j < L.length && indentOf(L[j]) >= it.indent + 2 && !matchItem(L[j], stack)) { i = j; continue; }
          break;
        }
        if (FENCE.test(n) || MDH.test(n) || QUOTE.test(n) || HR.test(n) || matchItem(n, stack)) break;
        const t = n.trim();
        if (indentOf(n) >= it.indent + 2 || /^[a-z0-9(\[,;:&]/.test(t) || /([,\-\u2013(&/]|\b(and|or|the|a|an|of|to|for|with|in|on|by|from|at))$/i.test(item.text)) { item.text = joinWrapped([item.text, t]); i++; }
        else break;
      }
      continue;
    }
    endList();
    if (i + 1 < L.length && SETEXT.test(L[i + 1])) { blocks.push({ type: 'heading', level: L[i + 1].trim()[0] === '=' ? 1 : 2, text: l.trim(), explicit: true }); i += 2; continue; }
    const group = [l]; i++;
    while (i < L.length && !breaksGroup(L[i]) && !(i + 1 < L.length && SETEXT.test(L[i + 1]))) group.push(L[i++]);
    pushGroup(blocks, group);
  }
  memo = { text, blocks: assignLevels(blocks) };
  return memo.blocks;
}

function toRoman(n) { const m = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; m.forEach(([v, r]) => { while (n >= v) { s += r; n -= v; } }); return s || 'i'; }
function fromRoman(s) { const v = { i: 1, v: 5, x: 10 }; const t = s.toLowerCase(); let n = 0; for (let k = 0; k < t.length; k++) { const a = v[t[k]], b = v[t[k + 1]] || 0; n += a < b ? -a : a; } return n || 1; }
function ordinal(n, fam) {
  if (fam === 'alpha' || fam === 'ALPHA') { const s = String.fromCharCode(97 + ((n - 1) % 26)); return fam === 'ALPHA' ? s.toUpperCase() : s; }
  if (fam === 'roman' || fam === 'ROMAN') { const s = toRoman(n); return fam === 'ROMAN' ? s.toUpperCase() : s; }
  return String(n);
}

// Shared numbering: each level counts on its own, restarts when it opens again or the marker style changes.
function listRows(items, style) {
  const rows = [], count = [], fams = []; let prev = -1;
  items.forEach((it) => {
    const L = Math.min(it.level, prev + 1);
    if (L > prev || fams[L] !== it.fam) count[L] = null;
    count.length = L + 1; fams.length = L + 1; fams[L] = it.fam;
    let marker;
    if (it.ordered) {
      count[L] = count[L] == null ? (it.start || 1) : count[L] + 1;
      marker = style === 'prompt' ? ordinal(count[L], it.fam) + '.' : count[L] + '.';
    } else marker = style === 'display' ? DOTS[L % 3] : '-';
    rows.push({ level: L, marker, text: it.text, ordered: it.ordered });
    prev = L;
  });
  return rows;
}
function listLines(items, style) {
  const width = [];
  return listRows(items, style).map((r) => {
    width.length = r.level; const pad = width.reduce((a, b) => a + b, 0);
    width[r.level] = r.marker.length + 1;
    return ' '.repeat(pad) + r.marker + ' ' + r.text;
  });
}
function tableMd(rows) {
  const n = Math.max(...rows.map((r) => r.length));
  const line = (r) => '| ' + [...r, ...Array(n - r.length).fill('')].join(' | ') + ' |';
  return [line(rows[0]), '| ' + Array(n).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
}

function writeMarkdown(blocks) {
  return blocks.map((b) => {
    if (b.type === 'heading') return '#'.repeat(b.level) + ' ' + b.text;
    if (b.type === 'list') return listLines(b.items, 'md').join('\n');
    if (b.type === 'code') return '\x60\x60\x60' + (b.lang || '') + '\n' + b.text + '\n\x60\x60\x60';
    if (b.type === 'quote') return '> ' + b.text;
    if (b.type === 'hr') return '---';
    if (b.type === 'table') return tableMd(b.rows);
    return b.text;
  }).join('\n\n');
}

function outlineRows(blocks) {
  const rows = []; const hs = blocks.filter((b) => b.type === 'heading').map((b) => b.level);
  const base = hs.length ? Math.min(...hs) : 1; let cur = -1;
  blocks.forEach((b) => {
    if (b.type === 'heading') { cur = Math.min(b.level - base, cur + 1); rows.push({ depth: cur, text: b.text, heading: true }); return; }
    const c = cur + 1;
    if (b.type === 'p') rows.push({ depth: c, text: b.text });
    else if (b.type === 'list') listRows(b.items, 'prompt').forEach((r) => rows.push({ depth: c + r.level, text: r.ordered ? r.marker + ' ' + r.text : r.text }));
    else if (b.type === 'code') b.text.split('\n').filter((x) => x.trim()).forEach((x) => rows.push({ depth: c, text: '\x60' + x.trim() + '\x60', code: true }));
    else if (b.type === 'quote') rows.push({ depth: c, text: '"' + b.text + '"' });
    else if (b.type === 'table') b.rows.forEach((r) => rows.push({ depth: c, text: r.join(' | ') }));
  });
  return rows;
}
function writeOutline(blocks) {
  return outlineRows(blocks).map((r) => '  '.repeat(r.depth) + '- ' + (r.heading ? '**' + r.text + '**' : r.text)).join('\n');
}

function writePrompt(blocks) {
  return blocks.map((b) => {
    if (b.type === 'heading') return b.text;
    if (b.type === 'list') return listLines(b.items, 'prompt').join('\n');
    if (b.type === 'quote') return '"' + b.text + '"';
    if (b.type === 'hr') return '';
    if (b.type === 'table') return b.rows.map((r) => r.join(' | ')).join('\n');
    return b.text;
  }).filter((x) => x !== '').join('\n\n');
}

export function toMarkdown(text) { return writeMarkdown(analyze(text)); }
export function toOutline(text) { return writeOutline(analyze(text)); }
export function toPrompt(text) { return writePrompt(analyze(text)); }

export function formatText(text, format) {
  if (!String(text || '').trim()) return '';
  if (format === 'outline') return toOutline(text);
  if (format === 'prompt') return toPrompt(text);
  return toMarkdown(text);
}

// Display model for the preview: each format renders the way it will read once pasted.
export function preview(text, format) {
  if (!String(text || '').trim()) return [];
  const blocks = analyze(text);
  if (format === 'outline') return [{ type: 'list', items: outlineRows(blocks).map((r) => ({ text: r.text, level: r.depth, bold: !!r.heading, code: !!r.code, marker: DOTS[r.depth % 3] })) }];
  if (format === 'prompt') return [{ type: 'pre', text: writePrompt(blocks) }];
  return blocks.map((b) => (b.type === 'list' ? { type: 'list', items: listRows(b.items, 'display') } : b));
}

export function slugify(s) {
  return (s || 'extract').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'extract';
}

/* ---------- Storage (IndexedDB, this browser only) ---------- */

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('marklith', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('extracts', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error('This browser blocked local storage. Private browsing or full storage can cause this.'));
  });
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('extracts', mode); const store = t.objectStore('extracts');
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error || new Error('Saving failed. Your browser storage may be full.'));
  }));
}

export const store = {
  list: () => tx('readonly', (s) => s.getAll()),
  put: (item) => tx('readwrite', (s) => s.put(item)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
  async estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return e.usage || 0;
  }
};
