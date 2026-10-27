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

// Self-hosted engine (vendor/). The language file is fetched at build time by render.yaml.
const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;
const TESSERACT_URL = VENDOR + 'tesseract.min.js';

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

let regionPromise = null;
const WORKER_OPTS = () => ({ workerPath: VENDOR + 'worker.min.js', corePath: VENDOR + 'core', langPath: VENDOR + 'lang', workerBlobURL: false });
async function getWorker(lang, onProgress, region) {
  if (region) {
    // own worker so a picked area reads instantly even while the background scan is busy
    if (!regionPromise) regionPromise = (async () => { await loadScript(TESSERACT_URL); return window.Tesseract.createWorker(lang, 1, WORKER_OPTS()); })().catch((e) => { regionPromise = null; throw e; });
    return regionPromise;
  }
  currentLogger = onProgress;
  if (!workerPromise) {
    workerPromise = (async () => {
      onProgress({ stage: 1, label: 'Loading text engine (first run only)', value: 0.1 });
      await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker(lang, 1, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR + 'core',
        langPath: VENDOR + 'lang',
        workerBlobURL: false,
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
let paramsSet = null;
// deep: false returns after the main layout pass (fast); extractMore() then runs the slower passes on the cached result.
const passCache = new WeakMap();
export async function extractText(source, { lang = 'eng', mainOnly = true, onProgress = () => {}, deep = true } = {}) {
  const worker = await getWorker(lang, onProgress);
  const psm = async (m) => { try { await worker.setParameters({ tessedit_pageseg_mode: m, preserve_interword_spaces: '1', user_defined_dpi: '300' }); } catch (e) {} };
  const { canvas, w, h } = source.canvas ? source : await canvasFromBlob(source);
  let c = passCache.get(canvas);
  if (!c || c.lang !== lang) {
    onProgress({ stage: 2, label: 'Preparing image', value: 0 });
    const prep = prepareForOcr(canvas, w, h);
    onProgress({ stage: 2, label: 'Reading text', value: 0 });
    await psm('3');
    const { data } = await worker.recognize(prep.canvas, {}, { text: true, blocks: true });
    c = { lang, prep, data, sparse: null, deepDone: false }; passCache.set(canvas, c);
  }
  if (deep && !c.deepDone) {
    // sparse mode on a locally thresholded copy picks up scattered labels (cards, buttons, tags) the layout pass skipped
    onProgress({ stage: 2, label: 'Checking for missed text', value: 0.6 });
    try { await psm('11'); c.sparse = (await worker.recognize(adaptive(c.prep.canvas), {}, { text: true, blocks: true })).data; } catch (e) {}
    // weak lines get a close-up second look: cropped, enlarged and read as a single line
    try { await psm('7'); await rereadWeak([c.data, c.sparse], c.prep.canvas, worker, onProgress); } catch (e) {}
    await psm('3'); c.deepDone = true;
  }
  onProgress({ stage: 3, label: 'Formatting output', value: 0.5 });
  const split = splitMainText(c.data, c.prep.w, c.prep.h, mainOnly, deep ? c.sparse : null);
  onProgress({ stage: 3, label: 'Formatting output', value: 1 });
  return { ...split, confidence: Math.round(c.data.confidence || 0) };
}

// Pinpoint read: one area of the image, read as a block of text on its own worker. rect is in 0-1 fractions.
export async function readRegion(source, rect, { lang = 'eng' } = {}) {
  const worker = await getWorker(lang, null, true);
  const { canvas, w, h } = source.canvas ? source : await canvasFromBlob(source);
  const sx = Math.max(0, Math.round(rect.x * w)), sy = Math.max(0, Math.round(rect.y * h));
  const sw = Math.max(8, Math.min(w - sx, Math.round(rect.w * w))), sh = Math.max(8, Math.min(h - sy, Math.round(rect.h * h)));
  const crop = document.createElement('canvas'); crop.width = sw; crop.height = sh;
  const cx = crop.getContext('2d'); cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, sw, sh); cx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const prep = prepareForOcr(crop, sw, sh, true);
  const read = async (img, mode) => { try { await worker.setParameters({ tessedit_pageseg_mode: mode, preserve_interword_spaces: '1', user_defined_dpi: '300' }); } catch (e) {} return (await worker.recognize(img, {}, { text: true, blocks: true })).data; };
  let best = await read(prep.canvas, '6');
  if (best.confidence < 70) { const alt = await read(adaptive(prep.canvas), '6'); if (alt.confidence > best.confidence) best = alt; }
  if (best.confidence < 55) { const alt = await read(prep.canvas, '11'); if (alt.confidence > best.confidence) best = alt; }
  const res = splitMainText(best, prep.w, prep.h, false, null);
  const lines = res.lines.map((l) => ({ text: l.text, box: { x: rect.x + l.box.x * rect.w, y: rect.y + l.box.y * rect.h, w: l.box.w * rect.w, h: l.box.h * rect.h } }));
  return { text: res.text, lines, confidence: Math.round(best.confidence || 0) };
}

// Background scan: returns only lines the fast pass did not already give (by position and by text), in reading order.
export async function extractMore(source, { lang = 'eng', mainOnly = true, onProgress = () => {}, known = [] } = {}) {
  const res = await extractText(source, { lang, mainOnly, onProgress, deep: true });
  const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const have = new Set(known.map((k) => key(k.text)));
  const ov = (a, b) => { const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); return (ix * iy) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h)); };
  const fresh = res.lines.filter((l) => key(l.text).length >= 2 && !have.has(key(l.text)) && !known.some((k) => k.box && ov(l.box, k.box) > 0.3));
  return { text: fresh.map((l) => l.text).join('\n'), lines: fresh };
}

const flatWords = (d) => { const w = []; ((d && d.blocks) || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => (l.words || []).forEach((x) => w.push(x))))); return w; };
async function rereadWeak(datas, src, worker, onProgress) {
  const cand = [];
  datas.forEach((d) => ((d && d.blocks) || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => {
    const txt = (l.words || []).map((x) => x.text).join(' ');
    const ws = (l.words || []).filter((x) => x.text.trim()), minC = Math.min(...ws.map((x) => x.confidence), 100);
    const stub = ws.length > 1 && /^[A-Za-z]$/.test(ws[ws.length - 1].text.trim()); // label cut short, e.g. "Aa T"
    if (((l.confidence || 0) >= 80 && minC >= 70 && !stub) || (txt.match(/[A-Za-z]/g) || []).length < 2) return;
    const bb = l.bbox; if (bb.x1 - bb.x0 < 12 || bb.y1 - bb.y0 < 6) return;
    if (cand.some((c) => overlapFrac(c.bbox, bb) > 0.5 && overlapFrac(bb, c.bbox) > 0.5)) return;
    cand.push(l);
  }))));
  cand.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
  const list = cand.slice(0, 10);
  for (let i = 0; i < list.length; i++) {
    const l = list[i], bb = l.bbox, hgt = bb.y1 - bb.y0, pad = Math.round(hgt * 0.4);
    const ws = (l.words || []).filter((x) => x.text.trim()), stub = ws.length > 1 && /^[A-Za-z]$/.test(ws[ws.length - 1].text.trim());
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad), x1 = Math.min(src.width, bb.x1 + pad + (stub ? hgt * 8 : 0)), y1 = Math.min(src.height, bb.y1 + pad);
    const s = Math.max(1, Math.min(4, 80 / hgt)), W = Math.round((x1 - x0) * s), H = Math.round((y1 - y0) * s);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, W, H);
    onProgress({ stage: 2, label: 'Taking a closer look', value: 0.85 + 0.15 * (i / list.length) });
    let best = (await worker.recognize(c, {}, { text: true, blocks: true })).data;
    if (best.confidence < 75) { const d = (await worker.recognize(adaptive(c), {}, { text: true, blocks: true })).data; if (d.confidence > best.confidence) best = d; }
    const words = flatWords(best).filter((x) => x.text.trim());
    if (!words.length || best.confidence < (l.confidence || 0) + 8) continue;
    const map = (q) => ({ x0: x0 + q.x0 / s, y0: y0 + q.y0 / s, x1: x0 + q.x1 / s, y1: y0 + q.y1 / s });
    l.words = words.map((x) => ({ ...x, bbox: map(x.bbox) }));
    l.text = words.map((x) => x.text).join(' '); l.confidence = best.confidence;
  }
}

/* ---------- Image prep: upscale small text, grayscale, dark-mode inversion, contrast stretch ---------- */
// Runs on a copy; the stored image is untouched. Box fractions stay valid because only scale changes.
function prepareForOcr(src, w, h, region) {
  const long = Math.max(w, h);
  const scale = region ? Math.min(4, Math.max(1, 1600 / long)) : long < 1400 ? Math.min(2.5, 2000 / long) : long > 4000 ? 4000 / long : 1;
  const W = Math.round(w * scale), H = Math.round(h * scale);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(src, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H;
  const hist = new Uint32Array(256); const g = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) { const v = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0; g[i] = v; hist[v]++; }
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  const invert = sum / n < 110; // dark UI: light text on dark ground
  const pct = (q) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * q) return v; } return 255; };
  const lo = pct(0.01), hi = pct(0.99), span = Math.max(1, hi - lo);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let v = ((g[i] - lo) * 255 / span); v = v < 0 ? 0 : v > 255 ? 255 : v; if (invert) v = 255 - v;
    d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, w: W, h: H };
}

// Local-mean threshold: separates text sitting on gradients, photos and tinted cards that a global threshold washes out.
function adaptive(src) {
  const W = src.width, H = src.height, d = src.getContext('2d').getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H), I = new Float64Array((W + 1) * (H + 1));
  for (let i = 0; i < W * H; i++) g[i] = d[i * 4];
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const r = Math.max(8, Math.round(Math.max(W, H) / 60));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d'); const out = ctx.createImageData(W, H); const o = out.data;
  for (let y = 0; y < H; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const m = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const v = g[y * W + x] < m - 12 ? 0 : 255; const p = (y * W + x) * 4; o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255; } }
  ctx.putImageData(out, 0, 0); return c;
}

/* ---------- Clean-up of OCR noise ---------- */
const LIGS = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"' };
const ALNUM = /[A-Za-z0-9\u00C0-\u024F]/;
const KEEP_SOLO = /^([AaI&+=%$#@€£\-–—•*\d]|[.,:;!?)\]}]|[(\[{"'])$/;
const BULLETISH = /^[eo°«»*+·•®©¢]$/;
const JUNK_TOKEN = /^[^A-Za-z0-9\u00C0-\u024F]+$/;
function cleanWords(words, lineX, H) {
  const out = [];
  words.forEach((wd, k) => {
    let t = wd.text.replace(/[\uFB00-\uFB04\u2018\u2019\u201C\u201D]/g, (m) => LIGS[m] || m).replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '').trim();
    if (!t) return;
    const c = wd.confidence;
    const first = out.length === 0;
    // icon misreads at the start of a line become a bullet when real text follows
    if (first && BULLETISH.test(t) && c < 75 && words.length > 1) { out.push({ t: '•', x0: wd.bbox.x0, x1: wd.bbox.x1 }); return; }
    const nx = words[k + 1] && words[k + 1].text.trim();
    // UI icon read as a symbol or 1-2 stray letters in front of a capitalised label
    if (first && nx && /^[A-Za-z][a-z]{2,}/.test(nx) && words.length <= 4 && ((/^[^A-Za-z0-9•\-*–—]{1,2}$/.test(t) || /^(?=.*[^A-Za-z0-9.,])[^\s]{1,2}$/.test(t)) || (/^[A-Za-z]{1,2}$/.test(t) && !/^(A|I|An|At|As|Is|It|In|On|Of|Or|To|By|My|We|No|So|If|Do|Go|Up|Hi|Me|Be|He|Us)$/.test(t) && (c < 80 || words[k + 1].bbox.x0 - wd.bbox.x1 > (wd.bbox.y1 - wd.bbox.y0) * 0.9)))) return;
    const junk = JUNK_TOKEN.test(t);
    if (junk) {
      if (/^[|¦]+$/.test(t) && c < 85) return;                // stray rules / cursor bars
      if (/^[~_^`¬°§¤]+$/.test(t)) return;                   // never meaningful alone
      if (t.length > 1 && !/^(-{2,}|\.{3}|…|->|=>|<=|>=|!=|==|\*\*|&&|\|\|)$/.test(t) && c < 70) return;
      if (t.length === 1 && !KEEP_SOLO.test(t) && c < 80) return;
    } else {
      if (c < 30 && (t.match(/[A-Za-z0-9]/g) || []).length / t.length < 0.6) return;
      if (t.length === 1 && c < 45 && !/^[AaIi0-9]$/.test(t)) return;
      t = t.replace(/^[|¦~_]+(?=[A-Za-z0-9])/, '').replace(/(?<=[A-Za-z0-9.,!?)])[|¦~_]+$/, '');
    }
    out.push({ t, x0: wd.bbox.x0, x1: wd.bbox.x1 });
  });
  // overlapping fragments of one word read twice: "Typogra" + "raphy" -> "Typography"
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1], b = out[i], ov = a.x1 - b.x0;
    if (ov <= 0 && b.x0 - a.x1 > H * 0.12) continue;
    let k = Math.min(a.t.length, b.t.length) - 1, m = 0;
    for (; k >= 2; k--) if (a.t.slice(-k).toLowerCase() === b.t.slice(0, k).toLowerCase()) { m = k; break; }
    if (m) { a.t = a.t + b.t.slice(m); a.x1 = Math.max(a.x1, b.x1); out.splice(i, 1); }
    else if (ov > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) { if (b.t.length > a.t.length) { a.t = b.t; } a.x1 = Math.max(a.x1, b.x1); out.splice(i, 1); }
  }
  // drop trailing / leading lone symbols left after cleaning (e.g. "Settings >" icon chevrons)
  while (out.length > 1 && /^([>›»<‹«|=~_→\\/-]|=>|->|—)$/.test(out[out.length - 1].t)) out.pop();
  while (out.length > 1 && /^[<‹«>›»|]$/.test(out[0].t)) out.shift();
  // rebuild with spacing from geometry: wide gaps keep a double space so columns don't fuse into one word
  let s = '';
  out.forEach((o, i) => { if (i) { const gap = o.x0 - out[i - 1].x1; s += gap > H * 2.2 ? '   ' : ' '; } s += o.t; });
  s = s.replace(/\s+([,.;:!?)\]}])/g, '$1').replace(/([(\[{])\s+/g, '$1').trim();
  return fixLine(s);
}
// Button outlines read as ( ) or [ ], icon arrows read as > or ->, and I/l/1/0 confusions inside words.
const ARROW_END = /\s*(?:->|=>|-+>|>{1,2}|›|»|→|➔|➜|↗|⟶)\s*$/;
const ARROW_START = /^\s*(?:<-|<{1,2}|‹|«|←)\s*/;
function fixLine(s) {
  let t = s;
  for (let k = 0; k < 2; k++) {
    const m = t.match(/^[([{|]\s*(.+?)\s*[)\]}|]$/);
    if (m && !/[()[\]{}]/.test(m[1]) && m[1].split(/\s+/).length <= 8 && !/[.!?]$/.test(m[1].replace(ARROW_END, ''))) t = m[1];
    t = t.replace(ARROW_END, '').replace(ARROW_START, '');
    if (/\)$/.test(t) && !t.includes('(')) t = t.slice(0, -1).replace(ARROW_END, '');
    if (/^\(/.test(t) && !t.includes(')')) t = t.slice(1).replace(ARROW_START, '');
  }
  t = t.replace(/^[^A-Za-z0-9\s"'(\[•*\-–—]{1,2}\s*(?=[A-Z][a-z]{2,})/, '');
  return t.split(' ').map(fixWord).join(' ').trim();
}
function fixWord(wd) {
  if (wd === 'l' || wd === '|') return 'I';
  if (/^[\d.,:%$€£+\-/]+$/.test(wd) || /^https?:|@|\.(com|io|js|md)\b/i.test(wd)) return wd;
  let x = wd;
  x = x.replace(/^(["'(]?)ll(?=l|[aeiou][a-z])/, '$1Il');                 // lllegal -> Illegal
  x = x.replace(/^(["'(]?)l(?=[A-Z]{2,})/, '$1I');                      // lNFO -> INFO
  x = x.replace(/(?<=[a-z])[|1]+(?=[a-z])/g, (m) => 'l'.repeat(m.length)).replace(/(?<=[a-z])0(?=[a-z])/g, 'o');
  x = x.replace(/(?<=[A-Z])0(?=[A-Z])/g, 'O').replace(/(?<=[A-Z])[|1l](?=[A-Z])/g, 'I');
  return x;
}

/* ---------- Main text vs text inside pictures + reading order ---------- */

// Text inside screenshots, photos, charts and logos tends to be much smaller than the body, read with low
// confidence, mostly symbols, or sitting alone in a tiny block. Those lines are set aside, not deleted.
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function linesOf(data, offset) {
  const out = [];
  ((data && data.blocks) || []).forEach((b, bi) => {
    const bt = String(b.blocktype || b.block_type || '');
    (b.paragraphs || []).forEach((p, pi) => (p.lines || []).forEach((l) => {
      const words = (l.words || []).filter((x) => x.text && x.text.trim());
      if (!words.length) return;
      out.push({ bi: bi + offset, pi, bt, bb: l.bbox, words, conf: l.confidence != null ? l.confidence : (words.reduce((a, x) => a + x.confidence, 0) / words.length) });
    }));
  });
  return out;
}
const overlapFrac = (a, b) => { const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); return (ix * iy) / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0)); };
function splitMainText(data, w, h, mainOnly, sparse) {
  const raw = linesOf(data, 0);
  // add sparse-pass lines only where the first pass found nothing, and only if they read cleanly
  linesOf(sparse, 10000).forEach((s) => {
    const txt = s.words.map((x) => x.text).join(' ');
    const letters = (txt.match(/[A-Za-z]/g) || []).length;
    if (letters < 3 || s.conf < (letters >= 5 ? 50 : 65)) return;
    const hits = raw.filter((r) => overlapFrac(s.bb, r.bb) > 0.2 || overlapFrac(r.bb, s.bb) > 0.2);
    if (!hits.length) { raw.push(s); return; }
    // a sparse read that clearly beats the overlapping layout read (more letters, similar confidence) replaces it
    if (hits.length === 1) { const r = hits[0], rl = (r.words.map((x) => x.text).join('').match(/[A-Za-z]/g) || []).length;
      if (letters >= rl + 3 && s.conf >= r.conf - 10) raw[raw.indexOf(r)] = { ...s, bi: r.bi, pi: r.pi }; }
  });
  const H0 = median(raw.filter((r) => r.words.length >= 3).map((r) => r.bb.y1 - r.bb.y0)) || median(raw.map((r) => r.bb.y1 - r.bb.y0)) || 1;
  const rows = [];
  raw.forEach((r) => {
    const t = cleanWords(r.words, r.bb.x0, H0);
    if (!t || !ALNUM.test(t)) return;
    const bb = r.bb;
    rows.push({ bi: r.bi, pi: r.pi, bt: r.bt, t, hgt: bb.y1 - bb.y0, conf: r.conf, nWords: t.split(/\s+/).length, words: r.words,
      x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1, cy: (bb.y0 + bb.y1) / 2,
      letters: (t.match(/[A-Za-z0-9\u00C0-\u024F]/g) || []).length / Math.max(1, t.replace(/\s/g, '').length),
      box: { x: bb.x0 / w, y: bb.y0 / h, w: (bb.x1 - bb.x0) / w, h: (bb.y1 - bb.y0) / h } });
  });
  const solid = rows.filter((r) => r.nWords >= 3 && r.conf >= 60);
  const H = median((solid.length ? solid : rows).map((r) => r.hgt)) || 1;
  const blockStats = {};
  rows.forEach((r) => { const s = blockStats[r.bi] || (blockStats[r.bi] = { n: 0, words: 0, conf: 0 }); s.n++; s.words += r.nWords; s.conf += r.conf; });
  rows.forEach((r) => {
    const bs = blockStats[r.bi]; const bConf = bs.conf / bs.n;
    // needs two signals: one alone (small type, an image block) is common for real labels
    const score = (/IMAGE|NOISE|PICTURE/i.test(r.bt) ? 1 : 0) + (r.hgt < H * 0.5 ? 1 : 0) + (r.conf < 45 ? 1 : 0)
      + (r.letters < 0.55 ? 2 : 0) + (bs.n <= 2 && bs.words <= 4 && bConf < 65 ? 1 : 0);
    r.graphic = score >= 2 || (r.nWords === 1 && r.t.length <= 2 && r.conf < 80);
  });
  const ordered = readingOrder(rows);
  let keep = mainOnly ? ordered.filter((r) => !r.graphic) : ordered;
  if (!keep.length) keep = ordered;
  const left = mainOnly ? ordered.filter((r) => r.graphic && !keep.includes(r)) : [];
  const lowWords = [];
  keep.forEach((r) => r.words.forEach((wd) => { const t = wd.text.trim(); if (wd.confidence < LIMITS.lowConfidence && t.length > 1 && ALNUM.test(t)) lowWords.push(t); }));
  return { text: build(keep, H), lines: keep.map((r) => ({ text: r.t, box: r.box })), lowWords, excludedText: build(left, H), excludedCount: left.length };
}

// Strict top-to-bottom, left-to-right: lines whose vertical extents overlap form one row band, ordered by x.
function readingOrder(rows) {
  const byY = [...rows].sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const bands = [];
  byY.forEach((r) => {
    const band = bands[bands.length - 1];
    if (band) {
      const ov = Math.min(band.y1, r.y1) - Math.max(band.y0, r.y0);
      if (ov > 0.5 * Math.min(band.y1 - band.y0, r.hgt) && Math.abs(r.cy - band.cy) < 0.6 * Math.max(r.hgt, band.h)) {
        band.items.push(r); band.y0 = Math.min(band.y0, r.y0); band.y1 = Math.max(band.y1, r.y1); band.h = Math.max(band.h, r.hgt); return;
      }
    }
    bands.push({ items: [r], y0: r.y0, y1: r.y1, cy: r.cy, h: r.hgt });
  });
  const out = [];
  bands.forEach((b) => { b.items.sort((x, y) => x.x0 - y.x0); b.items.forEach((r) => { r.band = b; out.push(r); }); });
  return out;
}

// Paragraph breaks from geometry: a vertical gap, a size change, or a jump in left edge starts a new block.
function build(list, H) {
  let out = '', prev = null;
  list.forEach((r) => {
    if (prev) {
      if (prev.band === r.band) out += '\n';
      else {
        // gaps are judged against the lines' own size, so tight multi-line headlines stay together
        const gap = r.y0 - prev.y1, lh = Math.min(r.hgt, prev.hgt);
        const sizeJump = Math.max(r.hgt, prev.hgt) / Math.max(1, lh) > 1.5;
        const indentJump = Math.abs(r.x0 - prev.x0) > Math.max(H, lh) * 1.5;
        const label = (x) => x.nWords <= 3 && !/[.,;:!?]$/.test(x.t);
        const stacked = label(prev) && label(r) && !sizeJump && Math.abs(r.x0 - prev.x0) < Math.max(H, lh) * 3 && gap < lh * 2.6;
        out += (!stacked && (gap > lh * 0.6 || sizeJump || indentJump)) ? '\n\n' : '\n';
      }
    }
    const startsBlock = !prev || out.endsWith('\n\n');
    out += startsBlock && /^[a-z][a-z]+(\s|$)/.test(r.t) && !/[\/_.@#$<>{}=]/.test(r.t) ? r.t[0].toUpperCase() + r.t.slice(1) : r.t; prev = r;
  });
  return normalize(out);
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
  return t.replace(/\r/g, '').replace(/[ \t]{4,}/g, '   ').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
