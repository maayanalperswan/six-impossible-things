'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CACHE_VERSION    = 11;          // bump to force palette recompute
const PALETTE_VERSION  = 10;          // bump alone to recompute palette only
const NUM_CANDIDATES   = 5;          // paintings scored per day
const HISTORY_DAYS     = 90;         // days of history to keep
const ARTIST_COOLDOWN  = 30;         // days before same artist may repeat

// Art movements + specific artists to query on Wikidata
const SUBJECTS = [
  // Movements
  'Dada', 'Vienna Secession', 'Art Nouveau', 'Art Deco',
  'Pre-Raphaelite Brotherhood', 'Fauvism', 'Surrealism',
  'Orientalism in art', 'Impressionism', 'Post-Impressionism',
  'Dutch Golden Age painting', 'Russian avant-garde', 'Bauhaus',
  'Symbolism (arts)', 'Early Netherlandish painting', 'Flemish Baroque painting',
  // Individual artists
  'Hilma af Klint', 'Egon Schiele', 'J. M. W. Turner',
  'James McNeill Whistler',
  'Henri de Toulouse-Lautrec', 'John Singer Sargent',
];

// ─── HUE FAMILY DEFINITIONS ──────────────────────────────────────────────────
// Finer warm-band bins so yellow doesn't collapse into orange/red
const HUE_FAMILIES = [
  { name: 'red',        hMin: 345, hMax: 360 },
  { name: 'red2',       hMin:   0, hMax:  18 },
  { name: 'orange',     hMin:  18, hMax:  40 },
  { name: 'yellow',     hMin:  40, hMax:  68 },   // wide — captures all yellows
  { name: 'chartreuse', hMin:  68, hMax:  88 },
  { name: 'green',      hMin:  88, hMax: 150 },
  { name: 'teal',       hMin: 150, hMax: 190 },
  { name: 'cyan',       hMin: 190, hMax: 220 },
  { name: 'blue',       hMin: 220, hMax: 265 },
  { name: 'violet',     hMin: 265, hMax: 295 },
  { name: 'magenta',    hMin: 295, hMax: 330 },
  { name: 'pink',       hMin: 330, hMax: 345 },
];

// ─── COLOUR MATH ─────────────────────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    default: h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

function hexFromRgb(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
}

function colorDistance(c1, c2) {
  return Math.sqrt(
    (c1[0] - c2[0]) ** 2 +
    (c1[1] - c2[1]) ** 2 +
    (c1[2] - c2[2]) ** 2
  );
}

function pdist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

function hueFamilyOf(h) {
  for (const f of HUE_FAMILIES) {
    if (f.hMin <= f.hMax) {
      if (h >= f.hMin && h < f.hMax) return f.name;
    } else {
      if (h >= f.hMin || h < f.hMax) return f.name;
    }
  }
  return 'red';
}

// Merge red + red2 for display purposes
function canonicalFamily(name) {
  return name === 'red2' ? 'red' : name;
}

// ─── PALETTE EXTRACTION ───────────────────────────────────────────────────────
// APPROVED "maximin spread" algorithm. The palette MAPS THE PAINTING'S STRUCTURE
// — a dominant field, a saturated dark anchor, a pigmented light, and accents
// chosen for maximum spread — rather than picking the six most prominent colors.
function extractPalette(canvas, ctx) {
  const W = canvas.width, H = canvas.height;
  const imageData = ctx.getImageData(0, 0, W, H).data;
  const total = W * H;

  // 1. Sample pixels + the painting's average cast
  const pixels = [];
  let avgR = 0, avgG = 0, avgB = 0;
  for (let i = 0; i < imageData.length; i += 4) {
    if (imageData[i + 3] < 128) continue;
    const r = imageData[i], g = imageData[i + 1], b = imageData[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    pixels.push({ r, g, b, h, s, l });
    avgR += r; avgG += g; avgB += b;
  }
  if (!pixels.length) return { colors: [], vividness: 0 };
  avgR /= pixels.length; avgG /= pixels.length; avgB /= pixels.length;

  // 2. Median-cut into 150 clusters (saturation-aware split)
  const clusters = medianCut(pixels, 150);

  // 3. Representative = MOST VIVID member when meaningfully more saturated than the
  //    cluster average (lightness stays area-true). dist = distance from the cast.
  const cs = clusters.map(c => {
    const aS = rgbToHsl(c.r, c.g, c.b)[1];
    const vS = rgbToHsl(c.vr, c.vg, c.vb)[1];
    const useVivid = vS > aS + 0.04;
    const rr = useVivid ? c.vr : c.r;
    const gg = useVivid ? c.vg : c.g;
    const bb = useVivid ? c.vb : c.b;
    const [dh, ds, dl] = rgbToHsl(rr, gg, bb);
    return {
      r: rr, g: gg, b: bb, rgb: [rr, gg, bb],
      h: dh, s: ds, l: dl,
      coverage: c.count / total,
      dist: pdist([rr, gg, bb], [avgR, avgG, avgB]),
    };
  }).filter(c => c.coverage >= 0.004);

  const MINSEP = 85; // hard separation floor between any two swatches
  const toEntry = (c) => ({ hex: hexFromRgb(c.r, c.g, c.b), rgb: c.rgb, l: c.l, h: c.h, s: c.s });
  const nearestDist = (c, pal) => pal.length ? Math.min(...pal.map(p => pdist(c.rgb, p.rgb))) : Infinity;
  const farEnough = (c, pal) => pal.length === 0 || nearestDist(c, pal) >= MINSEP;
  const palette = [];

  // Slot A — FIELD: largest-coverage cluster, in its most vivid form
  const byCov = [...cs].sort((a, b) => b.coverage - a.coverage);
  if (byCov.length) palette.push(toEntry(byCov[0]));

  // Slot B — DARK: saturation-led anchor, true to the painting (not flat black)
  const darks = cs.filter(c => c.l < 0.42 && c.coverage >= 0.006)
    .map(c => ({ c, score: c.s * 2.2 + (0.42 - c.l) * 0.8 + c.coverage * 0.4 }))
    .sort((a, b) => b.score - a.score);
  for (const { c } of darks) { if (farEnough(c, palette)) { palette.push(toEntry(c)); break; } }

  // Slot C — LIGHT: pigmented (powder/cream/lavender), not camel, not near-white
  const lights = cs.filter(c => c.l > 0.62 && c.l < 0.93 && c.coverage >= 0.005)
    .map(c => {
      const pig = Math.min(c.s, 0.55) * 2.0;
      const camel = c.s < 0.12 ? -0.8 : 0;
      const tooWhite = c.l > 0.90 ? -0.5 : 0;
      return { c, score: pig + camel + tooWhite + (c.l - 0.62) * 0.5 + c.coverage * 0.3 };
    })
    .sort((a, b) => b.score - a.score);
  for (const { c } of lights) { if (farEnough(c, palette)) { palette.push(toEntry(c)); break; } }

  // Slots D — ACCENTS via MAXIMIN (greedy farthest-point): repeatedly add the color
  //    that maximizes [nearestDist + dist*0.6 + min(cov,0.15)*120], requiring
  //    nearestDist >= MINSEP. This enforces spread and blocks duplicate hues.
  const addMaximin = () => {
    let best = null, bestScore = -1;
    for (const c of cs) {
      if (palette.some(p => p.hex === hexFromRgb(c.r, c.g, c.b))) continue;
      const near = nearestDist(c, palette);
      if (near < MINSEP) continue;
      const score = near + c.dist * 0.6 + Math.min(c.coverage, 0.15) * 120;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };
  while (palette.length < 6) { const pick = addMaximin(); if (!pick) break; palette.push(toEntry(pick)); }

  // Slot E — fallback: relax the separation floor, fill by coverage
  if (palette.length < 6) {
    const relaxed = [...cs].sort((a, b) => b.coverage - a.coverage);
    for (const c of relaxed) {
      if (palette.length >= 6) break;
      if (palette.some(p => p.hex === hexFromRgb(c.r, c.g, c.b))) continue;
      if (nearestDist(c, palette) >= MINSEP * 0.7) palette.push(toEntry(c));
    }
  }

  // Display sorted light → dark
  palette.sort((a, b) => b.l - a.l);

  // Vividness (for daily candidate ranking): mean chroma of the chosen swatches
  const vividness = palette.reduce((sum, p) => sum + (p.s || 0), 0);

  return { colors: palette.slice(0, 6).map(p => ({ hex: p.hex, rgb: p.rgb })), vividness };
}

// ─── MEDIAN CUT ───────────────────────────────────────────────────────────────
// Cuts in RGB with a saturation-aware bucket selection: buckets containing vivid
// pixels are split sooner so small saturated accents (a yellow sari, a cobalt tile)
// separate into their own clusters instead of being averaged into muddy neighbors.
// Each returned cluster carries BOTH its area-true average (r,g,b) and its most
// vivid member (vr,vg,vb), so the palette can show a field's most saturated form.
function medianCut(pixels, maxClusters) {
  if (!pixels.length) return [];
  let buckets = [pixels];
  while (buckets.length < maxClusters) {
    let widest = -1, widestScore = -1, widestChannel = null;
    buckets.forEach((b, i) => {
      if (b.length < 2) return;
      let avgS = 0;
      for (const p of b) avgS += p.s;
      avgS /= b.length;
      for (const ch of ['r', 'g', 'b']) {
        let mn = 255, mx = 0;
        for (const p of b) { if (p[ch] < mn) mn = p[ch]; if (p[ch] > mx) mx = p[ch]; }
        const score = (mx - mn) * (1 + avgS * 1.2);
        if (score > widestScore) { widestScore = score; widest = i; widestChannel = ch; }
      }
    });
    if (widest < 0) break;
    const bucket = buckets[widest];
    let mn = 255, mx = 0;
    for (const p of bucket) { if (p[widestChannel] < mn) mn = p[widestChannel]; if (p[widestChannel] > mx) mx = p[widestChannel]; }
    if (mx - mn < 6) break;
    buckets.splice(widest, 1);
    bucket.sort((a, b) => a[widestChannel] - b[widestChannel]);
    const mid = Math.floor(bucket.length / 2);
    buckets.push(bucket.slice(0, mid), bucket.slice(mid));
  }
  return buckets.filter(b => b.length).map(b => {
    const avg = (ch) => Math.round(b.reduce((s, p) => s + p[ch], 0) / b.length);
    let vivid = b[0], vs = -1;
    for (const p of b) { if (p.s > vs) { vs = p.s; vivid = p; } }
    return { r: avg('r'), g: avg('g'), b: avg('b'), vr: vivid.r, vg: vivid.g, vb: vivid.b, count: b.length };
  });
}

// ─── WIKIDATA / COMMONS ───────────────────────────────────────────────────────
const WIKIDATA_API  = 'https://www.wikidata.org/w/api.php';
const COMMONS_API   = 'https://commons.wikimedia.org/w/api.php';
const SPARQL_EP     = 'https://query.wikidata.org/sparql';

async function resolveQid(name) {
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&limit=3&format=json&origin=*`;
  const res = await fetch(url);
  const j   = await res.json();
  const hit = j.search && j.search[0];
  if (!hit) return null;
  console.log(`  resolved: "${name}" → ${hit.id} (${hit.description || ''})`);
  return hit.id;
}

async function fetchPaintingsForQid(qid, isArtist) {
  let sparql;
  if (isArtist) {
    sparql = `
      SELECT ?painting ?paintingLabel ?creatorLabel ?year ?image WHERE {
        ?painting wdt:P31 wd:Q3305213 ;
                  wdt:P170 wd:${qid} ;
                  wdt:P18  ?image .
        OPTIONAL { ?painting wdt:P571 ?date . BIND(YEAR(?date) AS ?year) }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } LIMIT 80`;
  } else {
    sparql = `
      SELECT ?painting ?paintingLabel ?creatorLabel ?year ?image WHERE {
        ?painting wdt:P31 wd:Q3305213 ;
                  wdt:P135 wd:${qid} ;
                  wdt:P18  ?image .
        OPTIONAL { ?painting wdt:P571 ?date . BIND(YEAR(?date) AS ?year) }
        OPTIONAL { ?painting wdt:P170 ?creator . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } LIMIT 80`;
  }
  const url = `${SPARQL_EP}?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const j   = await res.json();
  return (j.results?.bindings || []).map(row => normalizeRow(row)).filter(Boolean);
}

async function resolveCommonsUrl(wikifileUrl) {
  // Extract filename from a wikidata P18 URL like:
  // http://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg
  const match = decodeURIComponent(wikifileUrl).match(/Special:FilePath\/(.+)$/i);
  if (!match) return null;
  const filename = match[1].replace(/_/g, ' ');
  const url = `${COMMONS_API}?action=query&titles=File:${encodeURIComponent(filename)}&prop=imageinfo&iiprop=url&format=json&origin=*`;
  const res = await fetch(url);
  const j   = await res.json();
  const pages = j.query?.pages || {};
  const page  = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url || null;
}

function normalizeRow(row) {
  let title = row.paintingLabel?.value;
  if (!title || title.match(/^Q\d+$/)) return null;
  // Wikidata appends "(2)", "(7)" etc. to disambiguate works sharing a label.
  // Strip a trailing parenthesized number so titles read cleanly.
  title = title.replace(/\s*\(\d+\)\s*$/, '').trim();
  const imageWiki = row.image?.value;
  if (!imageWiki) return null;
  const qid = row.painting?.value?.split('/').pop() || '';
  const artist = row.creatorLabel?.value || '';
  const year   = row.year?.value ? parseInt(row.year.value) : null;
  return { qid, title, artist, year, imageWiki };
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('sit_history') || '[]'); }
  catch { return []; }
}

function saveHistory(hist) {
  localStorage.setItem('sit_history', JSON.stringify(hist));
}

function pruneHistory(hist) {
  const cutoff = Date.now() - HISTORY_DAYS * 86400000;
  return hist.filter(e => e.ts > cutoff);
}

function recentArtists(hist) {
  const cutoff = Date.now() - ARTIST_COOLDOWN * 86400000;
  return new Set(hist.filter(e => e.ts > cutoff).map(e => e.artist).filter(Boolean));
}

function recordToday(entry) {
  let hist = pruneHistory(loadHistory());
  const today = todayStr();
  hist = hist.filter(e => e.date !== today); // remove any stale today entry
  hist.unshift({ ...entry, ts: Date.now(), date: today });
  saveHistory(hist);
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadCache() {
  try {
    const raw = localStorage.getItem('sit_cache');
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c.version !== CACHE_VERSION) { localStorage.removeItem('sit_cache'); return null; }
    return c;
  } catch { return null; }
}

function saveCache(data) {
  localStorage.setItem('sit_cache', JSON.stringify({ version: CACHE_VERSION, ...data }));
}

// ─── POOL ─────────────────────────────────────────────────────────────────────
async function buildPool() {
  console.log('[SIT] Building painting pool from Wikidata…');
  const paintings = [];
  const seen = new Set();

  const isArtistSubject = new Set([
    'Hilma af Klint', 'Egon Schiele', 'J. M. W. Turner',
    'James McNeill Whistler',
    'Henri de Toulouse-Lautrec', 'John Singer Sargent',
  ]);

  for (const subject of SUBJECTS) {
    const isArtist = isArtistSubject.has(subject);
    const qid = await resolveQid(subject);
    if (!qid) { console.warn(`[SIT] Could not resolve: ${subject}`); continue; }
    try {
      const rows = await fetchPaintingsForQid(qid, isArtist);
      for (const r of rows) {
        // Artist queries fix the creator to the QID, so creatorLabel comes back
        // empty — stamp the known artist name (the subject we queried) onto them.
        if (isArtist && !r.artist) r.artist = subject;
        if (!seen.has(r.qid)) { seen.add(r.qid); paintings.push(r); }
      }
      console.log(`[SIT] ${subject} (${qid}): ${rows.length} paintings`);
    } catch (e) {
      console.warn(`[SIT] Failed to fetch for ${subject}:`, e);
    }
  }

  console.log(`[SIT] Pool: ${paintings.length} total paintings`);
  return paintings;
}

// ─── DAILY PICK ───────────────────────────────────────────────────────────────
function deterministicSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickCandidates(pool, today, blocked) {
  // Sort pool by QID to ensure consistent ordering across all users/browsers.
  // Without this, Wikidata fetch order varies and different users get different paintings.
  const sorted = [...pool].sort((a, b) => (a.qid > b.qid ? 1 : -1));
  // Filter out recently seen artists
  const eligible = sorted.filter(p => !blocked.has(p.artist));
  const source   = eligible.length >= NUM_CANDIDATES ? eligible : sorted;
  const seed     = deterministicSeed(today);
  const indices  = new Set();
  let   n        = 0;
  while (indices.size < NUM_CANDIDATES && n < source.length * 3) {
    indices.add((seed + n * 7919) % source.length);
    n++;
  }
  return [...indices].map(i => source[i]);
}

// ─── IMAGE LOADING + SCORING ──────────────────────────────────────────────────
function loadImageOnCanvas(url) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    const img    = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const maxDim = 360;
      const scale  = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
      canvas.width  = Math.round(img.naturalWidth  * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ canvas, ctx });
    };
    img.onerror = reject;
    if (url) img.src = url;
    else reject(new Error('Empty image URL'));
  });
}

async function scoreAndExtract(painting) {
  // Resolve direct Commons URL
  const directUrl = await resolveCommonsUrl(painting.imageWiki);
  if (!directUrl) throw new Error('Could not resolve Commons URL');
  painting.imageUrl = directUrl;

  const { canvas, ctx } = await loadImageOnCanvas(directUrl);
  const { colors, vividness } = extractPalette(canvas, ctx);
  return { ...painting, colors, vividness };
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function formatFooterDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function renderToday(entry) {
  const todayView = document.getElementById('today-view');
  const status    = document.getElementById('status');

  document.getElementById('painting').src = entry.imageUrl;
  document.getElementById('painting').alt = entry.title;
  document.getElementById('attr-title').textContent = entry.title;
  document.getElementById('attr-meta').textContent =
    [entry.artist, entry.year].filter(Boolean).join(' · ');

  // Populate footer date
  const footerDate = document.getElementById('footer-date');
  if (footerDate) footerDate.textContent = formatFooterDate(entry.date || todayStr());

  const paletteEl = document.getElementById('palette');
  paletteEl.innerHTML = '';
  for (const c of entry.colors) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = c.hex;
    sw.title = `Click to copy ${c.hex}`;

    // Determine if swatch is light or dark for label contrast
    const [rr, gg, bb] = c.rgb;
    const luminance = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
    const labelColor = luminance > 0.45 ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.6)';
    const flashColor = luminance > 0.45 ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)';

    // Hex label always visible at bottom of swatch
    const label = document.createElement('span');
    label.className = 'hex-label';
    label.textContent = c.hex;
    label.style.color = labelColor;
    sw.appendChild(label);

    // "Copied" flash overlay
    const flash = document.createElement('span');
    flash.className = 'copy-flash';
    flash.textContent = 'Copied';
    flash.style.color = flashColor;
    sw.appendChild(flash);

    sw.addEventListener('click', () => {
      navigator.clipboard.writeText(c.hex).catch(() => {});
      sw.classList.add('copied');
      setTimeout(() => sw.classList.remove('copied'), 1100);
    });
    paletteEl.appendChild(sw);
  }

  status.style.display    = 'none';
  todayView.style.display = 'flex';
}

// The first day the app is opened on THIS device. The archive never reaches
// back before this — a new subscriber starts fresh from their install day.
function installDate() {
  let d = localStorage.getItem('sit_install');
  if (!d) { d = todayStr(); localStorage.setItem('sit_install', d); }
  return d;
}

// Insert/replace a single day's entry in history (used to cache reconstructed
// missed days so they only ever fetch once).
function upsertHistory(entry) {
  let hist = pruneHistory(loadHistory());
  hist = hist.filter(e => e.date !== entry.date);
  hist.unshift(entry);
  saveHistory(hist);
}

// Reconstruct the painting for a day the user missed: the daily pick is
// deterministic from the date, so every device agrees. We resolve the real
// image and compute its palette so the card is complete, not a blank box.
async function reconstructDay(pool, dateStr) {
  const candidates = pickCandidates(pool, dateStr, new Set());
  if (!candidates.length) return null;
  const seed = deterministicSeed(dateStr);
  const pick = candidates[seed % candidates.length];
  const directUrl = await resolveCommonsUrl(pick.imageWiki);
  if (!directUrl) return null;
  const { canvas, ctx } = await loadImageOnCanvas(directUrl);
  const { colors } = extractPalette(canvas, ctx);
  return {
    date: dateStr, ts: Date.parse(dateStr + 'T12:00:00'),
    paletteVersion: PALETTE_VERSION,
    qid: pick.qid, title: pick.title, artist: pick.artist, year: pick.year,
    imageUrl: directUrl, colors,
  };
}

async function renderArchive() {
  const grid = document.getElementById('archive-grid');

  // Days from install → today, capped to the most recent 30, newest first.
  const today    = todayStr();
  const install  = installDate();
  const installD = new Date(install + 'T12:00:00');
  const now      = new Date(today + 'T12:00:00');
  const days = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    if (d < installD) break;            // never reach before the install day
    days.push(d.toISOString().slice(0, 10));
  }

  if (!days.length) {
    grid.innerHTML = '<p style="color:#bbb;font-style:italic;font-size:0.8rem;text-align:center;width:100%">Your archive begins today.</p>';
    return;
  }

  const recorded = {};
  for (const e of pruneHistory(loadHistory())) if (e.imageUrl) recorded[e.date] = e;
  const cache = loadCache();
  const pool  = cache && cache.pool;

  // Lay out a card slot per day up front so order is preserved while missed
  // days fill in asynchronously.
  grid.innerHTML = '';
  const slots = days.map(dateStr => {
    const card = document.createElement('div'); card.className = 'archive-card';
    grid.appendChild(card);
    return { card, dateStr };
  });

  for (const { card, dateStr } of slots) {
    if (recorded[dateStr]) { fillArchiveCard(card, recorded[dateStr], dateStr); continue; }
    if (!pool || !pool.length) { card.remove(); continue; }   // can't reconstruct yet
    // loading state, then reconstruct + cache, or drop the slot if it fails
    card.innerHTML = '<div class="archive-loading" style="aspect-ratio:1;background:#f4f4f4;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:0.7rem;font-style:italic">…</div>';
    try {
      const entry = await reconstructDay(pool, dateStr);
      if (entry) { upsertHistory(entry); fillArchiveCard(card, entry, dateStr); }
      else card.remove();
    } catch (e) {
      console.warn('[SIT] Could not fill archive day', dateStr, e.message);
      card.remove();
    }
  }
}

// Populate (or repopulate) a single archive card element with a real entry.
function fillArchiveCard(card, entry, dateStr) {
  card.innerHTML = '';
  const img = document.createElement('img'); img.alt = entry.title || '';
  if (entry.imageUrl) img.src = entry.imageUrl;
  else { img.style.background = '#f0f0f0'; img.style.opacity = '0.4'; }
  card.appendChild(img);
  if (entry.colors && entry.colors.length) {
    const pal = document.createElement('div'); pal.className = 'archive-palette';
    for (const c of entry.colors) { const sw = document.createElement('div'); sw.className = 'archive-swatch'; sw.style.background = c.hex; pal.appendChild(sw); }
    card.appendChild(pal);
  }
  const t = document.createElement('div'); t.className = 'archive-title'; t.textContent = entry.title || ''; card.appendChild(t);
  const m = document.createElement('div'); m.className = 'archive-meta';
  m.textContent = [entry.artist, entry.year, formatFooterDate(dateStr)].filter(Boolean).join(' · '); card.appendChild(m);
}


// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  const status   = document.getElementById('status');
  const today    = todayStr();
  installDate();   // stamp the device's first-open day (no-op after the first time)
  const cache    = loadCache();
  const history  = pruneHistory(loadHistory());
  const blocked  = recentArtists(history);

  // Check if we have today's entry cached with the right palette version
  if (cache?.today?.date === today && cache.today.paletteVersion === PALETTE_VERSION) {
    console.log('[SIT] Using cached today:', cache.today.title);
    renderToday(cache.today);
    setupNav();
    return;
  }

  // We need to pick and score today's painting
  let pool = cache?.pool || null;
  if (!pool || !pool.length) {
    status.textContent = 'Hanging today\'s painting…';
    pool = await buildPool();
    if (!pool.length) {
      status.textContent = 'Could not load paintings. Check your connection and reload.';
      return;
    }
  }

  status.textContent = 'Hanging today\'s painting…';
  const candidates = pickCandidates(pool, today, blocked);
  console.log(`[SIT] Scoring ${candidates.length} candidates…`);

  let best = null;
  for (const c of candidates) {
    try {
      const scored = await scoreAndExtract(c);
      if (!best || scored.vividness > best.vividness) best = scored;
    } catch (e) {
      console.warn('[SIT] Skipped candidate:', c.title, e.message);
    }
  }

  if (!best) {
    status.textContent = 'Could not load a painting today. Please reload.';
    return;
  }

  console.log(`[SIT] Chose: "${best.title}" (vividness ${best.vividness.toFixed(2)})`);

  const entry = {
    date:           today,
    paletteVersion: PALETTE_VERSION,
    qid:            best.qid,
    title:          best.title,
    artist:         best.artist,
    year:           best.year,
    imageUrl:       best.imageUrl,
    colors:         best.colors,
  };

  saveCache({ pool, today: entry });
  recordToday(entry);
  renderToday(entry);
  setupNav();
}

function setupNav() {
  document.getElementById('show-archive').addEventListener('click', () => {
    document.getElementById('today-view').style.display   = 'none';
    document.getElementById('archive-view').style.display = 'block';
    renderArchive();
  });
  document.getElementById('show-today').addEventListener('click', () => {
    document.getElementById('archive-view').style.display = 'none';
    document.getElementById('today-view').style.display   = 'flex';
  });
}

init().catch(e => {
  console.error('[SIT] Fatal:', e);
  document.getElementById('status').textContent = 'Something went wrong. Open DevTools → Console for details.';
});
