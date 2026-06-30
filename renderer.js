'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CACHE_VERSION    = 19;          // bump to force pool rebuild + fresh pick (19: removed Olga Boznańska from artist roster)
const PALETTE_VERSION  = 39;          // bump alone to recompute palette only (39: green-cool added to MINORITY_FAMS so emerald/forest/viridian gets a reserved slot like teal/blue/purple; MINORITY_MAX 2→3 so a painting with teal+blue+green-cool can surface all three; MINORITY_MIN_COV 0.02→0.015 so pinks and blues at 1.5% canvas qualify. todayStr/tomorrowStr/archive loop switched from toISOString/UTC to localDateStr so painting flips at midnight LOCAL time not UTC. v24–v38 retained)
const NUM_CANDIDATES   = 8;          // paintings scored per day (more candidates → better odds a vivid one is in the mix)
const NUM_CANDIDATES_STREAK = 12;    // widen the sample on days following a tonal streak
const ANTISTREAK_LOOKBACK   = 2;     // how many recent displayed days in a row define a "tonal streak"
const VIVIDNESS_FLOOR       = 0.30;  // composite score below this reads as "tonal/dark" — NEW 0–1 scale, tune from console
const DARK_FLOOR_LO         = 0.18;  // mean lightness at/below which a painting is "too dark" (darkness gate → 0)
const DARK_FLOOR_HI         = 0.34;  // mean lightness at/above which there is NO darkness penalty (gate → 1). No upper limit — light is fine.
const NEAR_BLACK_L          = 0.13;  // swatches darker than this (HSL lightness) are skipped by the accent + fill slots, so near-black voids aren't seated. FIELD is exempt — a genuinely black-dominant painting still shows it.

// ─── "IN A ROOM" FILTERING (CLIP) ─────────────────────────────────────────────
// Some Wikidata images are photographs of a painting hanging in a room (frame +
// wall) rather than a flat reproduction. We score each candidate with a small
// vision-language model (CLIP, via Transformers.js, loaded from CDN and cached
// in the browser on first run) and demote any that read as "in a room / framed".
// A candidate is only shown if EVERY candidate that day reads that way.
// The model loads lazily; if it can't load, filtering is skipped and the app
// behaves exactly as before (most-vivid candidate wins).
const ROOM_THRESHOLD    = 0.57;       // roomScore >= this  ->  treated as "in a room"
const CLIP_MODEL        = 'Xenova/clip-vit-base-patch32';
const TRANSFORMERS_CDN  = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
const ROOM_LABELS = [
  'a painting hanging on a gallery wall with the room and other artworks visible',
  'a photograph of a framed painting hanging on a wall',
  'a painting depicted on display in a museum gallery',
  'a photo of a framed artwork in a room',
  'a photograph of a painting in a frame on a wall',
  'a photograph of a framed painting with the wall visible around it',
  'a painting hanging on a wall, photographed at an angle',
  'a snapshot of artwork with the floor or room visible',
  'a framed painting casting a shadow on the wall behind it',
];
const FLAT_LABELS = [
  'a flat digital reproduction of a painting',
  'a full-frame scan of a painting with no wall or frame',
  'just the painting itself, edge to edge',
  'a digital image of a painting only',
  'a painted portrait of a standing figure on a plain studio background',
  'white ground paintings or drawings allowed as long as no wall or frame',
  'a painting that depicts the interior of a room',
  'a flat reproduction of a painting of a bedroom or interior scene',
];
const ALL_LABELS = [...ROOM_LABELS, ...FLAT_LABELS];
const ROOM_SET   = new Set(ROOM_LABELS);
const HISTORY_DAYS     = 90;         // days of history to keep
const ARTIST_COOLDOWN  = 30;         // days before same artist may repeat
const POOL_LIMIT       = 300;        // paintings fetched per subject (was 80 — a fixed sliver of big movements)
const POOL_TTL_DAYS    = 14;         // rebuild the pool from Wikidata this often, rotating to a fresh slice
const SCORE_WIDTH      = 512;        // thumbnail width used to SCORE candidates (canvas is capped at 360 anyway)
const DISPLAY_WIDTH    = 1600;       // larger version fetched only for the one painting actually shown

// Paintings whose titles contain any of these terms (case-insensitive) are excluded
// from the pool at build time. Catches Wikimedia colour-chart, calibration-card, and
// Munsell-chip images that score high on vividness but aren't paintings.
const BLOCKED_TITLE_TERMS = [
  'munsell', 'color chart', 'colour chart', 'color scale', 'colour scale',
  'calibration', 'test card', 'color card', 'colour card',
];

// Art movements + specific artists to query on Wikidata
const MOVEMENTS = [
  'Art Nouveau', 'Pre-Raphaelite Brotherhood', 'Fauvism', 'Surrealism',
  'Impressionism', 'Post-Impressionism', 'Flemish Baroque painting',
];
// Individual artists are queried by creator (P170), which Wikidata tags completely —
// unlike movement tags (P135), which are sparse. Add a colourful painter here and it
// reliably pulls their whole catalogue. buildPool reads this for both the subject list
// and the artist-vs-movement decision, so one list keeps everything in sync.
const ARTISTS = [
  'Hilma af Klint', 'Egon Schiele', 'Henri de Toulouse-Lautrec', 'John Singer Sargent',
  'Claude Monet', 'Pierre-Auguste Renoir', 'Vincent van Gogh', 'Paul Gauguin', 'Paul Signac',
  'Henri Matisse', 'André Derain', 'Raoul Dufy', 'Franz Marc', 'August Macke',
  'Pierre Bonnard', 'Odilon Redon', 'Gustav Klimt', 'Paul Klee', 'Jean-Léon Gérôme',
  'Albert Marquet', 'Henri Manguin', 'Othon Friesz', 'Louis Valtat', 'Georges Rouault',
  'Jules Chéret', 'Théophile Steinlen', 'Leonetto Cappiello', 'Max Kurzweil',
  'Koloman Moser', 'Maximilian Lenz', 'Hugo Baar', 'Alphonse Mucha', 'Vojtěch Hynais',
  'Emil Orlik', 'Jozef Mehoffer', 'John William Waterhouse', 'Lawrence Alma-Tadema', 'Jean-Auguste-Dominique Ingres',
  'Horace Vernet', 'David Roberts', 'Eugène Delacroix', 'Alexandre-Gabriel Decamps', 'Thomas Allom',
  'John Frederick Lewis', 'Prosper Marilhat', 'Charles-Théodore Frère', 'Amadeo Preziosi', 'Eugène Fromentin',
  'Charles Landelle', 'Alfred Dehodencq', 'Frederick Goodall', 'Gustave Boulanger', 'Alberto Pasini',
  'Léon Belly', 'Adolf Schreyer', 'Henriette Browne', 'Victor Huguet', 'Gustave Guillaumet',
  'Georges Clairin', 'Henri Regnault', 'Benjamin Constant', 'Frederick Arthur Bridgman', 'Édouard Debat-Ponsan',
  'Gustav Bauernfeind', 'Edwin Lord Weeks', 'Étienne Dinet', 'Edgar Degas', 'Camille Pissarro',
  'Édouard Manet', 'Alfred Sisley', 'Gustave Caillebotte', 'Frédéric Bazille', 'Eugène Boudin',
  'Johan Barthold Jongkind', 'Armand Guillaumin', 'Eva Gonzalès', 'Marie Bracquemond', 'Paul Cézanne',
  'Édouard Vuillard', 'Childe Hassam', 'William Merritt Chase', 'Edmund Tarbell', 'Frank Weston Benson',
  'Theodore Robinson', 'John Henry Twachtman', 'Julian Alden Weir', 'Lilla Cabot Perry', 'Walter Richard Sickert',
  'Philip Wilson Steer', 'Joaquín Sorolla', 'Frits Thaulow', 'Max Liebermann',
  'Lovis Corinth', 'Max Slevogt', 'Paul Sérusier', 'Ernst Ludwig Kirchner', 'Alexej von Jawlensky',
  'Jan Toorop', 'Fernand Khnopff', 'Georges de Feure', 'Yves Tanguy', 'Paul Nash',
  'Hashiguchi Goyō', 'Arshile Gorky', 'Horace Pippin', 'Arthur G. Dove', 'Henry Ossawa Tanner',
  'Paula Modersohn-Becker', 'Helene Schjerfbeck', 'Gustave Moreau', 'Carlos Schwabe', 'Henri Rousseau',
  'Fujishima Takeji', 'Margaret Macdonald Mackintosh', 'Élisabeth Sonrel', 'Valentin Serov', 'Leon Bakst',
  'Ferdinand Hodler', 'Victor Borisov-Musatov', 'Edmond-François Aman-Jean', 'Gerda Wegener', 'Nils Dardel',
  'Kuzma Petrov-Vodkin', 'Artemisia Gentileschi', 'Rachel Ruysch',
];
const SUBJECTS = [...MOVEMENTS, ...ARTISTS];

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

  // 1. Sample pixels + the painting's average cast (and area-true mean lightness,
  //    accumulated here so the dark-highlight gate below costs no extra pass)
  const pixels = [];
  let avgR = 0, avgG = 0, avgB = 0, sumL = 0;
  for (let i = 0; i < imageData.length; i += 4) {
    if (imageData[i + 3] < 128) continue;
    const r = imageData[i], g = imageData[i + 1], b = imageData[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    pixels.push({ r, g, b, h, s, l });
    avgR += r; avgG += g; avgB += b; sumL += l;
  }
  if (!pixels.length) return { colors: [], vividness: 0, hueVariety: 0, meanL: 0, colorfulness: 0 };
  avgR /= pixels.length; avgG /= pixels.length; avgB /= pixels.length;
  const paintingMeanL = sumL / pixels.length;   // 0–1; gates the adaptive dark highlight

  // 2. Median-cut into 150 clusters (saturation-aware split)
  const clusters = medianCut(pixels, 150);

  // 3. MERGE clusters into perceptual COLOUR FAMILIES. Median-cut alone scatters a
  //    single colour across many adjacent clusters, so no slot can see how prominent
  //    a colour really is. Here we walk clusters largest-first; each one either joins
  //    an existing family (if within MERGE_DIST of that family's anchor) or starts a
  //    new one. Coverage SUMS across the family, so the coral skirt that fills a
  //    quarter of the canvas becomes ONE family at 25% — finally visible to selection.
  //    We test against each family's fixed ANCHOR (its largest member), not a drifting
  //    centroid, so a smooth gradient can't chain the whole image into one mud family.
  //    The merge radius SCALES WITH CHROMA. Two muddy tones 60 apart still read as the
  //    same swatch, so muted colours merge generously (up to ~72); but at high chroma
  //    that same distance is two genuinely different hues, so vivid colours merge only
  //    when nearly identical (~36). This kills the "two near-identical browns/greys"
  //    pairs without collapsing distinct vivid accents.
  const mergeRadius = (chA, chB) => 30 + (1 - Math.min(chA, chB)) * 42;

  // Hue families (defined here so the MERGE below can respect them). NEUTRAL_CH is the
  // chroma floor under which a colour is just grey/black/taupe — but PROMINENCE buys it
  // down: a large region needs far less chroma to read as a real colour than a small one.
  // A 0.5% smudge must still clear 0.12; a 12%+ region only needs NEUTRAL_CH_LO (0.04).
  // This is what lets a pastel sky or a dusty green keep its hue identity instead of being
  // filed as neutral — the misclassification that (a) barred cool tones from their hue
  // slot and (b) made the backfill read them as mud, so browns (which sit above 0.12)
  // filled in their place while blues/greens vanished. A true grey (chroma < 0.05) stays
  // neutral at ANY size — that hard floor guards against a flat wall seating as a colour.
  // Coverage defaults to 0, so the MERGE and CLUSTERING calls (which don't pass it) keep
  // the old flat 0.12 bar; only selection-time calls (famOf, usedFams) get the slide.
  const NEUTRAL_CH = 0.12, NEUTRAL_CH_LO = 0.04;
  const NEUTRAL_COV_LO = 0.025, NEUTRAL_COV_HI = 0.12;   // coverage band over which it slides
  const neutralChFor = (coverage) => {
    const t = Math.min(Math.max((coverage - NEUTRAL_COV_LO) / (NEUTRAL_COV_HI - NEUTRAL_COV_LO), 0), 1);
    return NEUTRAL_CH - (NEUTRAL_CH - NEUTRAL_CH_LO) * t;
  };
  const hueFamily = (h, chroma, coverage = 0) => {
    if (chroma < neutralChFor(coverage)) return 'neutral';
    const hh = (((h % 360) + 360) % 360);
    if (hh < 16 || hh >= 345) return 'red';
    if (hh < 45)  return 'orange';      // browns live here too
    if (hh < 70)  return 'yellow';
    // The old single "green" ran 70–160° — a 90° band that lumped acid yellow-green,
    // true emerald, and sea-green/mint into ONE slot, so a green-rich painting could
    // only ever show one of them (and it was usually the biggest olive). Split into
    // three: a sage and a viridian are as different as a pink and a red and each earns
    // its own slot. MINSEP_HUE/MINSEP still block two that actually read alike.
    if (hh < 95)  return 'chartreuse';  // yellow-green / acid / olive-bright
    // Green split into two families so olive/grass can't block emerald/forest for the same slot.
    // green-warm (95–122°): olive, grass, lime, bright green
    // green-cool (122–150°): emerald, forest, viridian, deep green
    if (hh < 122) return 'green-warm';
    if (hh < 150) return 'green-cool';
    if (hh < 200) return 'teal';        // sea-green / mint / aqua / teal
    if (hh < 255) return 'blue';
    if (hh < 300) return 'purple';
    return 'magenta';                   // pink / magenta
  };

  const clist = clusters.map(c => {
    const rgb = [c.r, c.g, c.b];          // average — geometry/merge distances run on this
    const vrgb = [c.vr, c.vg, c.vb];      // saturated representative — what we actually show
    const lrgb = [c.lr, c.lg, c.lb];      // light representative — for the highlight slot
    const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
    return {
      rgb, vrgb, lrgb, chroma,
      coverage: c.count / total,
      vchroma: (Math.max(...vrgb) - Math.min(...vrgb)) / 255,
      lightL: rgbToHsl(lrgb[0], lrgb[1], lrgb[2])[2],
      fam: hueFamily(rgbToHsl(rgb[0], rgb[1], rgb[2])[0], chroma),   // hue family of this cluster
    };
  }).sort((a, b) => b.coverage - a.coverage);

  // MERGE is HUE-AWARE: a cluster only joins a family of its OWN hue family, even if a
  // different-family colour is closer in raw distance. This is the fix for "teals/aquas
  // keep getting lost" — a low-chroma teal sits between green and blue in colour space,
  // so the generous muted-merge radius used to swallow it into whichever was nearest
  // before selection ever saw it. Same for dusty mauves vanishing into a dominant pink.
  // Distance still gates within a family (a near-black and a near-white are both neutral
  // but far apart, so they don't merge); the hue gate just stops cross-hue absorption.
  const families = [];
  for (const c of clist) {
    let best = null, bd = Infinity;
    for (const f of families) {
      if (f.fam !== c.fam) continue;            // never merge across a hue-family boundary
      const d = pdist(c.rgb, f.anchor);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && bd < mergeRadius(c.chroma, best.anchorChroma)) {
      best.coverage += c.coverage;
      if (c.vchroma > best.bestVividChroma) { best.bestVividChroma = c.vchroma; best.bestVividRgb = c.vrgb; }
      if (c.lightL > best.bestLightL) { best.bestLightL = c.lightL; best.bestLightRgb = c.lrgb; }
    } else {
      families.push({ anchor: [...c.rgb], anchorChroma: c.chroma, coverage: c.coverage, fam: c.fam,
        bestVividChroma: c.vchroma, bestVividRgb: [...c.vrgb],
        bestLightL: c.lightL, bestLightRgb: [...c.lrgb] });
    }
  }

  //    Family swatch: show the most SATURATED real tone the family contains, whenever
  //    that tone is genuinely chromatic — surfacing the jade not the olive, the cobalt
  //    not the slate, AND the real (moderate) saturation of a pastel sky rather than a
  //    washed grey. Only a family with NO saturated member (a true grey, taupe, or
  //    near-white) keeps its clean average, so neutrals stay honest. Family CLASSIFICATION
  //    (which hue bucket it belongs to) uses the ANCHOR's hue — the bulk colour of the
  //    region — not the vivid pixel's hue, so a foliage green whose most-saturated pixels
  //    happen to lean yellow isn't misfiled as "yellow" and dropped. (Green kept losing
  //    its slot this way.) The displayed colour is still the saturated one.
  // A family survives into selection if it's a real region (≥0.4% of canvas) OR a
  // strongly saturated smaller note — a cobalt tile, a red accent behind a figure — that
  // the eye catches even at a fraction of a percent. Without the second clause these
  // vivid specks were dropped HERE, before any slot could see them, and the palette
  // backfilled a brown in their place. FIELD/LIGHT are coverage/lightness-ranked, so this
  // only lets a small jewel reach the accent passes — it can't change the field or light.
  const VIVID_KEEP_CH = 0.45, VIVID_KEEP_COV = 0.0018;
  const cs = families.filter(f =>
      f.coverage >= 0.004 ||
      (f.bestVividChroma >= VIVID_KEEP_CH && f.coverage >= VIVID_KEEP_COV)
    ).map(f => {
    const rgb = f.bestVividChroma >= 0.13 ? f.bestVividRgb : f.anchor;
    const [dh, ds, dl] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const famH = rgbToHsl(f.anchor[0], f.anchor[1], f.anchor[2])[0];   // bulk hue, for family
    const lightRgb = f.bestLightRgb;
    const [lh, lsat] = rgbToHsl(lightRgb[0], lightRgb[1], lightRgb[2]);
    return {
      r: rgb[0], g: rgb[1], b: rgb[2], rgb,
      h: dh, s: ds, l: dl, famH,
      chroma: (Math.max(...rgb) - Math.min(...rgb)) / 255,
      coverage: f.coverage,
      dist: pdist(rgb, [avgR, avgG, avgB]),
      lightRgb, lightL: f.bestLightL, lightH: lh, lightS: lsat,
    };
  });

  const MINSEP = 85; // hard separation floor between any two swatches
  const toEntry = (c) => ({ hex: hexFromRgb(c.r, c.g, c.b), rgb: c.rgb, l: c.l, h: c.h, s: c.s, famH: c.famH, cov: c.coverage });
  const nearestDist = (c, pal) => pal.length ? Math.min(...pal.map(p => pdist(c.rgb, p.rgb))) : Infinity;
  const farEnough = (c, pal) => pal.length === 0 || nearestDist(c, pal) >= MINSEP;
  const palette = [];

  // Slot A — FIELD: largest-coverage cluster, in its most vivid form
  const byCov = [...cs].sort((a, b) => b.coverage - a.coverage);
  if (byCov.length) palette.push(toEntry(byCov[0]));

  // (No forced dark slot. It used to seat the most-saturated dark cluster as a
  // value anchor — but that hunts down a near-black even when the painting's story
  // lives in its mid-tones and accents, stealing a slot for murk. Darks now appear
  // only when the painting genuinely features one, via FIELD or the maximin accents
  // below; the NEAR_BLACK_L floor keeps those from being near-black voids.)

  // Slot C — LIGHT / HIGHLIGHT: the painting's lightest genuinely-present note, shown
  // at its TRUE brightness. Every family carries a light rep (the mean of its lightest
  // fifth), so a clean white collar, a bright cap, or a luminous sky surfaces as the
  // light tone it actually is — not the region's darker saturated rep, which used to
  // make the slot fall back to a dull grey. We rank families by that light rep's
  // lightness (whitest real tone wins, regardless of area) and DISPLAY the light rep.
  // The 0.64 floor means a genuinely dark painting (no bright note) gets no forced
  // highlight — the slot goes to an accent instead, which is honest. Where the lightest
  // real tone is a dull grey, that grey is still the truth.
  const LIGHT_L = 0.64, LIGHT_MIN_COV = 0.004, LIGHT_SEP = 30;
  // Adaptive dark highlight. In a GENUINELY DARK painting nothing may clear the 0.64
  // floor, so the slot goes unused and the lit passage that carries the whole picture —
  // a face in lamplight, a single struck highlight — never reads. When that happens we
  // lower the floor to the painting's OWN brightest real note, never below REL_LIGHT_MIN
  // so a muddy mid-grey can't seat. The gate is darkness, NOT merely "no bright note": a
  // MID-KEY painting (tones at 0.5–0.63 but none at 0.64) stays unlit exactly as before —
  // it isn't dark, it just isn't bright, and a 0.6 grey forced into the light slot is the
  // regression we were avoiding. The note is displayed at its true brightness, so it stays
  // honest — if the painting is so dark even its brightest note is below REL_LIGHT_MIN,
  // there's still no highlight, which is also the truth.
  const DARK_KEY = 0.30, REL_LIGHT_MIN = 0.42;
  const lightEligible = cs.filter(c => c.coverage >= LIGHT_MIN_COV);
  const maxLightL = lightEligible.length ? Math.max(...lightEligible.map(c => c.lightL)) : 0;
  const lightFloor = (maxLightL >= LIGHT_L || paintingMeanL > DARK_KEY)
    ? LIGHT_L                               // bright or merely mid-key → unchanged
    : Math.max(REL_LIGHT_MIN, maxLightL);   // genuinely dark → its own brightest note
  const lightEntry = (c) => ({
    hex: hexFromRgb(c.lightRgb[0], c.lightRgb[1], c.lightRgb[2]),
    rgb: c.lightRgb, l: c.lightL, h: c.lightH, s: c.lightS, famH: c.famH, cov: c.coverage,
  });
  const lights = lightEligible.filter(c => c.lightL >= lightFloor)
    .sort((a, b) => b.lightL - a.lightL || b.coverage - a.coverage);
  for (const c of lights) {
    const e = lightEntry(c);
    if (!palette.length || Math.min(...palette.map(p => pdist(e.rgb, p.rgb))) >= LIGHT_SEP) { palette.push(e); break; }
  }

  // Slots D — ACCENTS by PERCEPTUAL HUE FAMILY. The rule your notes keep circling:
  //   reflect the painting's variety — a NEW distinct hue always beats a second
  //   helping of one already shown. We sort every colour into a perceptual family
  //   (one "yellow", one "orange"/brown, one "green", one "teal"…, plus "neutral" for
  //   greys/blacks/taupes) and seat the best member of each family, never two of the
  //   same family until the painting genuinely has nothing else. 30°-wide buckets used
  //   to split one yellow into two slots and bury the pink; families fix that.
  //   Family score balances AREA and CHROMA — coverage^0.45 × (0.4 + chroma) — so a
  //   small vivid pop (a yellow half-moon) and a large muted distinct hue (a pink that
  //   fills a quarter of the canvas) can each win a slot, while a tiny grey speck can't.
  // NEUTRAL_CH and hueFamily are defined above the merge (the merge needs them).
  const MINSEP_HUE = 36;      // guard so two near-identical warm hues across a family
                              //   boundary (a red-orange beside a red) don't both seat
  const DEDUP_SEP  = 70;      // last-resort repeats must clear this to avoid near-dupes

  const famOf = (c) => hueFamily(c.famH !== undefined ? c.famH : c.h, c.chroma, c.coverage || 0);
  // A colour earns an accent slot by STANDING OUT, the way your eye picks a palette —
  // but standing out is presence AND saturation TOGETHER, not a sum where one dominates.
  // The old additive score (chroma·1.1 + dist·1.3 + coverage·0.5) let the dist term run
  // the show: a tiny vivid speck far from the cast outscored a large muted hue sitting
  // near it, so a 25%-of-canvas purple robe, a sage meadow, a dusty aqua kept losing
  // their slot to a fleck — and with the colourful slots spent on flecks, the leftovers
  // backfilled brown. Now the three MULTIPLY:
  //   (chroma + CHROMA_FLOOR) · coverage^COV_EXP · (1 + min(dist, DIST_CAP)/DIST_NORM)
  // • CHROMA_FLOOR gives every genuine hue a saturation ground, so a muted tertiary isn't
  //   zeroed out of contention (a low-chroma purple still counts).
  // • coverage^COV_EXP makes PRESENCE a real factor — a hue that fills a quarter of the
  //   canvas can outrank a speck even if the speck is more saturated.
  // • distance-from-cast is now a gentle 1.0–1.5× NUDGE (capped), not the dominant term,
  //   so an off-cast pop is still rewarded but can't run away with the palette.
  // True mud is sequestered as 'neutral' (v27) and competes for only ONE slot, so
  // rewarding presence here lifts real hues — purples, greens, aquas — not browns.
  // Knobs: CHROMA_FLOOR up → favours muted hues; COV_EXP down → favours large area;
  // DIST_CAP/DIST_NORM → how much an off-cast colour is nudged.
  const CHROMA_FLOOR = 0.15, COV_EXP = 0.35, DIST_CAP = 150, DIST_NORM = 300;
  const accentScore = (c) =>
    (c.chroma + CHROMA_FLOOR) * Math.pow(c.coverage, COV_EXP) * (1 + Math.min(c.dist, DIST_CAP) / DIST_NORM);
  // Chroma-aware area floor for accents. A muted/neutral cluster must be a real region
  // (~0.8% of canvas) to earn a slot — but a strongly SATURATED cluster earns one at a
  // fraction of that, because the eye locks onto a small vivid pop it would never notice
  // in taupe. Mirrors the family filter above so a kept vivid speck isn't re-blocked here.
  const ACCENT_MIN_COV = 0.008, ACCENT_MIN_COV_HI = 0.0018;
  const accentCovFloor = (chroma) => {
    const t = Math.min(Math.max((chroma - 0.20) / 0.30, 0), 1);   // 0 at chroma .20 → 1 at .50
    return ACCENT_MIN_COV + (ACCENT_MIN_COV_HI - ACCENT_MIN_COV) * t;
  };

  // ── v29 levers — each independently switchable for live attribution ──────────
  //   VIVID_MEMBER — within a chosen hue family, show its most VIVID member, not the
  //                  largest/dullest. Doesn't change WHICH families seat.
  //   MINORITY_BALANCE — reserve up to two slots for genuinely-present EXPRESSIVE minority
  //                  hues (teal/blue/purple/magenta — the jewel tones that lose slots to
  //                  big warm/green areas) so pinks and purples stop vanishing. (Was
  //                  COOL_BALANCE; widened to include pink/magenta and a second slot.)
  //   VALUE_SPREAD — gated dark anchor for value range, plus tighter PASS-1 dedup.
  //   ADJ_DEDUP    — two swatches in the SAME or NEIGHBOURING hue family must clear a
  //                  larger gap, so "two greens / two blues / two tans" stop both seating
  //                  while genuinely distinct hues that happen to sit close in RGB still can.
  // Flip any to false, `npm start`, to isolate its effect without a rebuild.
  const VIVID_MEMBER = true, MINORITY_BALANCE = true, VALUE_SPREAD = true, ADJ_DEDUP = true;
  const VIVID_REP_MIN_COV = 0.004;             // a member must be ≥0.4% to represent its family
  const MINORITY_FAMS = new Set(['teal', 'blue', 'purple', 'magenta', 'green-cool']);
  const MINORITY_MIN_COV = 0.015;              // a minority hue must really be present (≥1.5%) to reserve
  const MINORITY_MAX = 3;                       // at most this many reserved minority slots
  const DEDUP_MIN = 52;                         // base PASS-1 separation when VALUE_SPREAD on (vs 36)
  const ADJ_SEP = 76;                           // same/neighbouring-hue pairs need this much gap
  const DARK_ANCHOR_L = 0.24, DARK_ANCHOR_MIN_COV = 0.02, DARK_PRESENT_L = 0.30;

  // Adjacency-aware separation. Distinct hues may sit close in RGB and still read apart, but
  // two of the SAME or NEIGHBOURING family that are also close are a near-dupe. `clears`
  // returns true only if a candidate is far enough from EVERY seated swatch — the base gap
  // for distinct hues, the larger ADJ_SEP for same/neighbour-family pairs (incl. two neutrals).
  const HUE_RING = ['red','orange','yellow','chartreuse','green-warm','green-cool','teal','blue','purple','magenta'];
  const adjacentFam = (f1, f2) => {
    if (f1 === f2) return true;                                // same family (incl. neutral+neutral)
    if (f1 === 'neutral' || f2 === 'neutral') return false;    // neutral vs a hue: not adjacent
    const i = HUE_RING.indexOf(f1), j = HUE_RING.indexOf(f2);
    if (i < 0 || j < 0) return false;
    const d = Math.abs(i - j);
    return d === 1 || d === HUE_RING.length - 1;               // neighbours on the ring (wraps)
  };
  const clears = (c, pal, baseSep) => pal.every(p => {
    const dist = pdist(c.rgb, p.rgb);
    if (dist < baseSep) return false;
    if (!ADJ_DEDUP) return true;
    const pf = hueFamily(p.famH !== undefined ? p.famH : p.h, (Math.max(...p.rgb) - Math.min(...p.rgb)) / 255, p.cov || 0);
    return !(adjacentFam(famOf(c), pf) && dist < ADJ_SEP);
  });

  // FIELD and LIGHT already spoke for their families — don't double up on those hues.
  const usedFams = new Set(palette.map(p => {
    const ch = (Math.max(...p.rgb) - Math.min(...p.rgb)) / 255;
    return hueFamily(p.famH !== undefined ? p.famH : p.h, ch, p.cov || 0);
  }));

  // Chroma-aware dark gate: colours in the 0.10–0.13 band only enter the accent pool if
  // they are genuinely saturated (chroma ≥ DARK_CHROMA_MIN). Dark navies, teals, and
  // crimsons clear this easily (~0.35–0.55); dark muddy browns don't (~0.12–0.22).
  // Below NEAR_BLACK_L (0.10) nothing seats regardless. Above 0.13 fully unchanged.
  const DARK_CHROMA_MIN = 0.35;
  const darkGatePass = (c) =>
    c.l >= 0.13 ||                                  // above the band — unchanged
    (c.l >= NEAR_BLACK_L && c.chroma >= DARK_CHROMA_MIN);  // in the band — vivid only

  const accentPool = cs
    .filter(c => !palette.some(p => p.hex === hexFromRgb(c.r, c.g, c.b)))
    .filter(c => darkGatePass(c) && c.coverage >= accentCovFloor(c.chroma))
    .map(c => ({ c, score: accentScore(c) }))
    .sort((a, b) => b.score - a.score);

  const PASS1_SEP = VALUE_SPREAD ? DEDUP_MIN : MINSEP_HUE;

  // MINORITY_BALANCE — priority reservation BEFORE warm/green families fill every slot.
  // Reserve up to MINORITY_MAX distinct expressive minority hues that are genuinely present
  // (≥ MINORITY_MIN_COV) and not already seated, each by its most vivid member. No swap — it
  // only ADDS a minority hue that's really there, never invents one. This is what keeps the
  // pinks and purples (and teals/blues) from losing their slot to a large green or warm.
  if (MINORITY_BALANCE) {
    const seen = new Set();
    let reserved = 0;
    const cands = accentPool
      .filter(e => MINORITY_FAMS.has(famOf(e.c)) && e.c.coverage >= MINORITY_MIN_COV && !usedFams.has(famOf(e.c)))
      .map(e => e.c)
      .sort((a, b) => b.chroma - a.chroma);
    for (const c of cands) {
      if (reserved >= MINORITY_MAX || palette.length >= 6) break;
      const f = famOf(c);
      if (seen.has(f)) continue;                       // one reservation per family
      if (palette.length && !clears(c, palette, PASS1_SEP)) continue;
      palette.push(toEntry(c));
      usedFams.add(f);
      seen.add(f);
      reserved++;
    }
  }

  // PASS 1 — one swatch per NEW family. v28's score decides WHICH families appear (presence
  // + saturation); VIVID_MEMBER decides WHICH MEMBER of each represents it (the vivid one,
  // by chroma, above a coverage floor so a fleck can't stand for the family).
  if (VIVID_MEMBER) {
    const byFam = new Map();
    for (const e of accentPool) {
      const f = famOf(e.c);
      if (!byFam.has(f)) byFam.set(f, { best: e.score, members: [] });
      const grp = byFam.get(f);
      if (e.score > grp.best) grp.best = e.score;
      grp.members.push(e.c);
    }
    const famRanked = [...byFam.entries()].sort((a, b) => b[1].best - a[1].best);
    for (const [f, grp] of famRanked) {
      if (palette.length >= 6) break;
      if (usedFams.has(f)) continue;
      const elig = grp.members.filter(c => c.coverage >= VIVID_REP_MIN_COV);
      const ranked = (elig.length ? elig : grp.members).slice().sort((a, b) => b.chroma - a.chroma);
      for (const c of ranked) {
        if (palette.length && !clears(c, palette, PASS1_SEP)) continue;
        palette.push(toEntry(c));
        usedFams.add(f);
        break;
      }
    }
  } else {
    for (const { c } of accentPool) {
      if (palette.length >= 6) break;
      if (usedFams.has(famOf(c))) continue;
      if (palette.length && !clears(c, palette, PASS1_SEP)) continue;
      palette.push(toEntry(c));
      usedFams.add(famOf(c));
    }
  }
  // PASS 2 — only if still short (a genuinely tonal painting with few families): allow
  // a repeated family, but demand a real perceptual gap so we never seat two browns or
  // two greys that read as one swatch.
  for (const { c } of accentPool) {
    if (palette.length >= 6) break;
    if (palette.some(p => p.hex === hexFromRgb(c.r, c.g, c.b))) continue;
    if (nearestDist(c, palette) < DEDUP_SEP) continue;
    palette.push(toEntry(c));
  }

  // VALUE_SPREAD — dark anchor. If the six are all mid-to-light but the painting genuinely
  // holds a substantial dark region, seat one dark swatch so the palette travels in VALUE,
  // not only hue. Gated three ways so a high-key painting is never handed a forced black:
  // the palette must currently LACK a dark (darkest swatch above DARK_PRESENT_L), a real
  // dark region must EXIST (a cluster in [NEAR_BLACK_L, DARK_ANCHOR_L] with enough area),
  // and it must clear separation. This is the deliberate, narrow re-admission of the dark
  // the old blanket dark-slot got wrong — it only fires when value range is actually missing.
  if (VALUE_SPREAD && palette.length > 0 && palette.length < 6) {
    const palMinL = Math.min(...palette.map(p => p.l));
    if (palMinL > DARK_PRESENT_L) {
      const darkCand = cs
        .filter(c => c.l <= DARK_ANCHOR_L && c.l >= NEAR_BLACK_L && c.coverage >= DARK_ANCHOR_MIN_COV &&
                     !palette.some(p => p.hex === hexFromRgb(c.r, c.g, c.b)))
        .sort((a, b) => b.coverage - a.coverage)[0];
      if (darkCand && nearestDist(darkCand, palette) >= MINSEP_HUE) palette.push(toEntry(darkCand));
    }
  }

  // Slot E — GUARANTEE SIX, honestly. Progressively relax the separation floor
  // and fill by coverage. A tonal painting (a Whistler nocturne, a brown Sargent)
  // genuinely doesn't hold six well-separated hues, so we keep the floor as high
  // as we can for as long as we can, then accept closer-but-still-distinct
  // clusters rather than leaving empty slots.
  if (palette.length < 6) {
    // Order leftovers so a genuine chromatic tone is taken before a muddy phantom
    // mid-tone (median-cut can average a green-beside-red boundary into a brown that
    // isn't actually anywhere in the painting). Reward presence AND chroma, so real
    // secondary colours fill first and murk is the true last resort.
    const byCovAll = [...cs].sort((a, b) =>
      (Math.pow(b.coverage, 0.4) * (0.4 + b.chroma) + (b.dist / 220) * 0.8)
      - (Math.pow(a.coverage, 0.4) * (0.4 + a.chroma) + (a.dist / 220) * 0.8));
    const MUD_CH = 0.26;   // at/below this chroma a fill itself reads as brown/grey/taupe
    for (let floor = MINSEP * 0.7; palette.length < 6 && floor >= 8; floor -= 12) {
      for (const c of byCovAll) {
        if (palette.length >= 6) break;
        if (palette.some(p => p.hex === hexFromRgb(c.r, c.g, c.b))) continue;
        if (!darkGatePass(c)) continue;            // chroma-aware dark gate — same rule as accent pool
        // ANTI-MUD. Never backfill a brown/grey/taupe while a genuine colour is still
        // waiting and could seat at this same floor. "Genuine colour" is coverage-aware
        // now (famOf via neutralChFor): a prominent pale blue or dusty green classifies as
        // its hue here, so the browns finally defer to the cool tones that kept vanishing.
        // median-cut also invents phantom boundary-browns nowhere in the painting; this
        // defers past them too. Only when no colour remains — or the floor has relaxed far
        // down — is mud acceptable, so six are still guaranteed.
        if (c.chroma < MUD_CH && floor > 16) {
          const realWaits = byCovAll.some(o =>
            famOf(o) !== 'neutral' && darkGatePass(o) &&
            !palette.some(p => p.hex === hexFromRgb(o.r, o.g, o.b)) &&
            nearestDist(o, palette) >= floor);
          if (realWaits) continue;
        }
        if (nearestDist(c, palette) >= floor) palette.push(toEntry(c));
      }
    }
  }

  // Slot F — LAST RESORT for near-monochrome images: if even a fully relaxed
  // floor can't surface six distinct clusters, synthesise the remaining swatches
  // as evenly-spaced steps along the painting's OWN tonal axis (the darkest →
  // lightest swatch already chosen). This stays true to the painting — it reads
  // as a value ramp of its real colours, not invented hue — while always
  // delivering six.
  if (palette.length < 6 && palette.length > 0) {
    const sortedL = [...palette].sort((a, b) => a.l - b.l);
    const lo = sortedL[0].rgb, hi = sortedL[sortedL.length - 1].rgb;
    const lerp = (t) => [0, 1, 2].map(k => Math.round(lo[k] + (hi[k] - lo[k]) * t));
    for (let i = 1; i <= 30 && palette.length < 6; i++) {
      let rgb = lerp(i / 31);
      // Solid-colour edge case (lo === hi): walk lightness so we still differ.
      if (rgb[0] === lo[0] && rgb[1] === lo[1] && rgb[2] === lo[2]) {
        const d = i * 9;
        rgb = lo.map(v => Math.max(0, Math.min(255, v + (lo[0] > 128 ? -d : d))));
      }
      const hex = hexFromRgb(rgb[0], rgb[1], rgb[2]);
      if (palette.some(p => p.hex === hex)) continue;
      const [hh, ss, ll] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      palette.push({ hex, rgb, l: ll, h: hh, s: ss });
    }
  }

  // Display sorted light → dark
  palette.sort((a, b) => b.l - a.l);

  // ── Scoring ──────────────────────────────────────────────────────────────
  // Judged so "tonal" and "dark" are independent of how SATURATED the colours are.
  // A soft, multi-hue pastel should rank like the varied painting it is — not get
  // lumped with monochrome browns just because its chroma is low.

  // (a) Colourfulness (Hasler–Süsstrunk) over every pixel, plus area-true mean
  //     lightness (for the darkness gate). Colourfulness is kept ONLY as a gentle
  //     tiebreaker, never a gate — so pastels aren't punished for low saturation.
  let sRG = 0, sYB = 0, sRG2 = 0, sYB2 = 0, sL = 0;
  for (const p of pixels) {
    const rg = p.r - p.g;
    const yb = 0.5 * (p.r + p.g) - p.b;
    sRG += rg; sYB += yb; sRG2 += rg * rg; sYB2 += yb * yb;
    sL += p.l;
  }
  const n = pixels.length;
  const mRG = sRG / n, mYB = sYB / n;
  const varRG = Math.max(0, sRG2 / n - mRG * mRG);
  const varYB = Math.max(0, sYB2 / n - mYB * mYB);
  const colorfulness = Math.sqrt(varRG + varYB) + 0.3 * Math.sqrt(mRG * mRG + mYB * mYB);

  // (b) Hue variety across the six swatches — circular spread of their hues,
  //     weighted by each swatch's saturation so near-grey swatches contribute no
  //     spurious hue. 0 = one hue family (tonal) … ~1 = hues spread around the wheel.
  //     Lightness- AND saturation-independent: pale pink / powder blue / sage still
  //     reads as "varied".
  const swatches = palette.slice(0, 6);
  let vx = 0, vy = 0, wsum = 0;
  for (const p of swatches) {
    const w = p.s;                            // chroma weight (0–1); grey swatches ≈ 0
    const a = p.h * Math.PI / 180;
    vx += w * Math.cos(a); vy += w * Math.sin(a); wsum += w;
  }
  const R = wsum > 0.001 ? Math.sqrt(vx * vx + vy * vy) / wsum : 1; // 1 ⇒ all aligned
  const hueVariety = 1 - R;                   // 0 tonal … ~1 varied

  // (c) Darkness gate — area-true mean lightness. A FLOOR only: very dark images are
  //     demoted; light / high-key images are never penalised (no upper limit).
  const meanL = sL / n;
  const darkGate = Math.min(1, Math.max(0, (meanL - DARK_FLOOR_LO) / (DARK_FLOOR_HI - DARK_FLOOR_LO)));

  // Composite the picker maximises: variety, gated by darkness, nudged by vibrancy.
  const vividness = (hueVariety + 0.15 * Math.min(colorfulness / 100, 1)) * darkGate;

  return {
    colors: swatches.map(p => ({ hex: p.hex, rgb: p.rgb })),
    vividness, hueVariety, meanL, colorfulness,
  };
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
      for (const ch of ['r', 'g', 'b']) {
        let mn = 255, mx = 0;
        for (const p of b) { if (p[ch] < mn) mn = p[ch]; if (p[ch] > mx) mx = p[ch]; }
        // Split purely by colour RANGE. (We used to multiply by saturation, which
        // shattered vivid regions into many tiny clusters — making the prominence of
        // a strong colour invisible downstream — and under-split low-saturation
        // highlights, burying whites. Range alone splits where the image truly varies.)
        const score = (mx - mn);
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
    // The bucket's plain average desaturates the region toward grey (averaging cancels
    // chroma). So we ALSO compute a saturated representative: the mean of the most-
    // saturated fifth of the bucket. That recovers the region's true vivid character —
    // the jade in a green field, the cobalt in a blue one — while staying robust to a
    // single stray pixel (which a lone max-saturation pixel would not be).
    const bySat = b.length > 1 ? [...b].sort((p, q) => q.s - p.s) : b;
    const topN = Math.max(1, Math.round(bySat.length * 0.2));
    const vAvg = (ch) => Math.round(bySat.slice(0, topN).reduce((s, p) => s + p[ch], 0) / topN);
    // ...and a LIGHT representative: the mean of the lightest fifth. The light slot uses
    // this so a clean highlight (a white collar, a bright sky) surfaces at its real
    // brightness instead of the region's darker saturated rep. Robust to a single
    // specular pixel for the same reason.
    const byLight = b.length > 1 ? [...b].sort((p, q) => q.l - p.l) : b;
    const lAvg = (ch) => Math.round(byLight.slice(0, topN).reduce((s, p) => s + p[ch], 0) / topN);
    return {
      r: avg('r'), g: avg('g'), b: avg('b'),
      vr: vAvg('r'), vg: vAvg('g'), vb: vAvg('b'),
      lr: lAvg('r'), lg: lAvg('g'), lb: lAvg('b'),
      count: b.length,
    };
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

async function fetchPaintingsForQid(qid, isArtist, salt = '') {
  // Rotating order: hashing each painting's id with a per-rebuild salt reshuffles
  // the whole result set, so each pool refresh draws a DIFFERENT window of a big
  // movement instead of the same fixed sliver every time. Stable within an epoch.
  const orderBy = `ORDER BY MD5(CONCAT(STR(?painting), "${salt}"))`;
  let sparql;
  if (isArtist) {
    sparql = `
      SELECT ?painting ?paintingLabel ?creatorLabel ?year ?image WHERE {
        ?painting wdt:P31 wd:Q3305213 ;
                  wdt:P170 wd:${qid} ;
                  wdt:P18  ?image .
        OPTIONAL { ?painting wdt:P571 ?date . BIND(YEAR(?date) AS ?year) }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } ${orderBy} LIMIT ${POOL_LIMIT}`;
  } else {
    sparql = `
      SELECT ?painting ?paintingLabel ?creatorLabel ?year ?image WHERE {
        ?painting wdt:P31 wd:Q3305213 ;
                  wdt:P135 wd:${qid} ;
                  wdt:P18  ?image .
        OPTIONAL { ?painting wdt:P571 ?date . BIND(YEAR(?date) AS ?year) }
        OPTIONAL { ?painting wdt:P170 ?creator . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } ${orderBy} LIMIT ${POOL_LIMIT}`;
  }
  const url = `${SPARQL_EP}?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const j   = await res.json();
  return (j.results?.bindings || []).map(row => normalizeRow(row)).filter(Boolean);
}

async function resolveCommonsUrl(wikifileUrl, width = 0) {
  // Extract filename from a wikidata P18 URL like:
  // http://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg
  const match = decodeURIComponent(wikifileUrl).match(/Special:FilePath\/(.+)$/i);
  if (!match) return null;
  const filename = match[1].replace(/_/g, ' ');
  // width > 0 → ask Commons for a scaled thumbnail (returns thumburl). Full-res
  // originals are often several MB; a thumbnail is a fraction of that with no
  // loss for our purposes (palette + CLIP both work on small images).
  const widthParam = width > 0 ? `&iiurlwidth=${width}` : '';
  const url = `${COMMONS_API}?action=query&titles=File:${encodeURIComponent(filename)}&prop=imageinfo&iiprop=url${widthParam}&format=json&origin=*`;
  const res = await fetch(url);
  const j   = await res.json();
  const pages = j.query?.pages || {};
  const page  = Object.values(pages)[0];
  const info  = page?.imageinfo?.[0];
  if (!info) return null;
  return (width > 0 && info.thumburl) ? info.thumburl : info.url;
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

// True when the last ANTISTREAK_LOOKBACK *displayed* days were all tonal (total
// swatch-chroma below VIVIDNESS_FLOOR). Days with no recorded vividness (older
// entries) count as non-tonal, so we never widen on missing data.
function recentlyTonal(hist) {
  const recent = [...hist].sort((a, b) => b.ts - a.ts).slice(0, ANTISTREAK_LOOKBACK);
  if (recent.length < ANTISTREAK_LOOKBACK) return false;
  return recent.every(e => typeof e.vividness === 'number' && e.vividness < VIVIDNESS_FLOOR);
}

function recordToday(entry) {
  let hist = pruneHistory(loadHistory());
  const today = todayStr();
  hist = hist.filter(e => e.date !== today); // remove any stale today entry
  hist.unshift({ ...entry, ts: Date.now(), date: today });
  saveHistory(hist);
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
function localDateStr(d) {
  // Format a Date as YYYY-MM-DD in the user's LOCAL timezone, not UTC.
  // Using toISOString() would return UTC which causes the painting to flip
  // at midnight UTC rather than midnight local time.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  return localDateStr(new Date());
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
async function buildPool(salt = '') {
  console.log(`[SIT] Building painting pool from Wikidata (${SUBJECTS.length} subjects)…`);
  const paintings = [];
  const seen = new Set();
  const isArtistSubject = new Set(ARTISTS);
  const CONCURRENCY = 5;   // gentle on Wikidata; cuts a 233-subject build from minutes to ~1 min

  async function fetchSubject(subject) {
    const isArtist = isArtistSubject.has(subject);
    const qid = await resolveQid(subject);
    if (!qid) { console.warn(`[SIT] Could not resolve: ${subject}`); return []; }
    try {
      const rows = await fetchPaintingsForQid(qid, isArtist, salt);
      // Artist queries fix the creator to the QID, so creatorLabel comes back
      // empty — stamp the known artist name (the subject we queried) onto them.
      if (isArtist) for (const r of rows) if (!r.artist) r.artist = subject;
      console.log(`[SIT] ${subject} (${qid}): ${rows.length} paintings`);
      return rows;
    } catch (e) {
      console.warn(`[SIT] Failed to fetch for ${subject}:`, e);
      return [];
    }
  }

  // Fetch subjects in concurrency-limited batches; dedupe single-threaded between
  // batches so there's no race on `seen`.
  for (let i = 0; i < SUBJECTS.length; i += CONCURRENCY) {
    const results = await Promise.all(SUBJECTS.slice(i, i + CONCURRENCY).map(fetchSubject));
    for (const rows of results) {
      for (const r of rows) {
        if (seen.has(r.qid)) continue;
        const titleLower = (r.title || '').toLowerCase();
        if (BLOCKED_TITLE_TERMS.some(t => titleLower.includes(t))) {
          console.log(`[SIT] Blocked by title filter: "${r.title}"`);
          continue;
        }
        seen.add(r.qid); paintings.push(r);
      }
    }
  }

  console.log(`[SIT] Pool: ${paintings.length} paintings across ${SUBJECTS.length} subjects`);
  return paintings;
}

// ─── DAILY PICK ───────────────────────────────────────────────────────────────
function deterministicSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickCandidates(pool, today, blocked, count = NUM_CANDIDATES) {
  // Sort pool by QID to ensure consistent ordering across all users/browsers.
  // Without this, Wikidata fetch order varies and different users get different paintings.
  const sorted = [...pool].sort((a, b) => (a.qid > b.qid ? 1 : -1));
  // Filter out recently seen ARTISTS (only the creator is cooled down, never the
  // movement or the painting itself — a movement may recur freely).
  const eligible = sorted.filter(p => !blocked.has(p.artist));
  const source   = eligible.length >= count ? eligible : sorted;
  const seed     = deterministicSeed(today);
  const indices  = new Set();
  let   n        = 0;
  while (indices.size < count && n < source.length * 3) {
    indices.add((seed + n * 7919) % source.length);
    n++;
  }
  return [...indices].map(i => source[i]);
}

const MIN_IMAGE_DIM = 300;   // images smaller than this in either dimension are skipped as too pixelated

// ─── IMAGE LOADING + SCORING ──────────────────────────────────────────────────
function loadImageOnCanvas(url) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    const img    = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (img.naturalWidth < MIN_IMAGE_DIM || img.naturalHeight < MIN_IMAGE_DIM) {
        reject(new Error(`Image too small: ${img.naturalWidth}×${img.naturalHeight} (min ${MIN_IMAGE_DIM}px)`));
        return;
      }
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

// Lazily load the CLIP pipeline once per session. Returns the pipeline, or null
// if it can't load (offline / CDN down) — callers then skip filtering.
let _clipPipe = undefined;   // undefined = not tried, null = failed, object = ready
let _clipPromise = null;
async function getClipPipe() {
  if (_clipPipe !== undefined) return _clipPipe;
  if (_clipPromise) return _clipPromise;
  _clipPromise = (async () => {
    try {
      const TF = await import(TRANSFORMERS_CDN);
      TF.env.allowLocalModels = false;
      TF.env.useBrowserCache  = true;   // cache the model after first download
      const pipe = await TF.pipeline('zero-shot-image-classification', CLIP_MODEL);
      _clipPipe = pipe;
      console.log('[SIT] CLIP model ready');
      return pipe;
    } catch (e) {
      console.warn('[SIT] CLIP model failed to load; room filtering disabled this session:', e.message);
      _clipPipe = null;
      return null;
    }
  })();
  return _clipPromise;
}

// Score a rasterised candidate canvas for "is this a painting in a room?".
// roomScore = share of probability CLIP puts on the ROOM labels vs the FLAT labels.
// Graceful: if the model isn't available, returns roomScore 0 (never demoted).
async function scoreRoomCLIP(canvas) {
  const pipe = await getClipPipe();
  if (!pipe) return { roomScore: 0, onWall: false };
  try {
    const dataURL = canvas.toDataURL('image/png');
    const out = await pipe(dataURL, ALL_LABELS);   // [{label, score}], softmax over ALL_LABELS
    let room = 0, total = 0;
    for (const o of out) { total += o.score; if (ROOM_SET.has(o.label)) room += o.score; }
    const roomScore = total > 0 ? room / total : 0;
    return { roomScore, onWall: roomScore >= ROOM_THRESHOLD };
  } catch (e) {
    console.warn('[SIT] CLIP scoring failed for one image:', e.message);
    return { roomScore: 0, onWall: false };
  }
}

// Pick the most vivid candidate, but prefer flat reproductions: only fall back
// to "in a room" images if EVERY candidate that day looks like one.
// Images with almost no colour (engravings, lithographs, B&W photos of works) score
// near-zero vividness already, but exclude them outright from the daily pick so they
// can never surface on a thin day. colourfulness < 8 ⇒ effectively greyscale.
const GRAYSCALE_MAX = 8;

function chooseBest(scored) {
  if (!scored.length) return null;
  const eligible = scored.filter(s => !s.onWall && !(s.colorfulness < GRAYSCALE_MAX));
  const pool = eligible.length ? eligible
             : (scored.filter(s => !s.onWall).length ? scored.filter(s => !s.onWall) : scored);
  return pool.reduce((best, s) => (!best || s.vividness > best.vividness ? s : best), null);
}

async function scoreAndExtract(painting) {
  // Resolve a small thumbnail for scoring (the canvas is only 360px anyway).
  const directUrl = await resolveCommonsUrl(painting.imageWiki, SCORE_WIDTH);
  if (!directUrl) throw new Error('Could not resolve Commons URL');
  painting.imageUrl = directUrl;

  const { canvas, ctx } = await loadImageOnCanvas(directUrl);
  const { colors, vividness, hueVariety, meanL, colorfulness } = extractPalette(canvas, ctx);
  const { roomScore, onWall } = await scoreRoomCLIP(canvas);
  console.log(`[SIT] "${painting.title}" score=${vividness.toFixed(2)} (variety ${hueVariety.toFixed(2)}, light ${meanL.toFixed(2)}, colourfulness ${colorfulness.toFixed(0)}) room=${roomScore.toFixed(2)}${onWall ? ' (in a room — demoted)' : ''}`);
  return { ...painting, colors, vividness, hueVariety, meanL, colorfulness, roomScore, onWall };
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
  const seed  = deterministicSeed(dateStr);
  const n     = candidates.length;
  const start = seed % n;
  // Walk candidates in deterministic (seed-rotated) order; take the first that
  // is NOT "in a room". If every candidate looks like a room, fall back to the
  // first one we could load. Keeps the archive consistent with the daily filter.
  let fallback = null;
  for (let k = 0; k < n; k++) {
    const pick = candidates[(start + k) % n];
    let directUrl, canvas, ctx;
    try {
      directUrl = await resolveCommonsUrl(pick.imageWiki, DISPLAY_WIDTH);
      if (!directUrl) continue;
      ({ canvas, ctx } = await loadImageOnCanvas(directUrl));
    } catch (e) { continue; }
    const { onWall } = await scoreRoomCLIP(canvas);
    const { colors } = extractPalette(canvas, ctx);
    const entry = {
      date: dateStr, ts: Date.parse(dateStr + 'T12:00:00'),
      paletteVersion: PALETTE_VERSION,
      qid: pick.qid, title: pick.title, artist: pick.artist, year: pick.year,
      imageUrl: directUrl, colors,
    };
    if (!onWall) return entry;          // first flat reproduction wins
    if (!fallback) fallback = entry;    // remember in case all are rooms
  }
  return fallback;
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
    days.push(localDateStr(d));
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
  m.textContent = [entry.artist, entry.year].filter(Boolean).join(' · '); card.appendChild(m);
}


// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  const status   = document.getElementById('status');
  const today    = todayStr();
  installDate();   // stamp the device's first-open day (no-op after the first time)
  const cache    = loadCache();
  const history  = pruneHistory(loadHistory());

  // FAST PATH A — today already chosen and cached: show instantly.
  if (cache?.today?.date === today && cache.today.paletteVersion === PALETTE_VERSION && cache?.pool?.length) {
    console.log('[SIT] Using cached today:', cache.today.title);
    renderToday(cache.today);
    setupNav();
    schedulePrepare(cache, cache.today);          // make sure tomorrow is ready
    return;
  }

  // FAST PATH B — we pre-picked THIS day in the background yesterday: promote it and
  // show instantly, with no scoring at launch. This is what makes most mornings fast.
  if (cache?.tomorrow?.date === today && cache.tomorrow.paletteVersion === PALETTE_VERSION && cache?.pool?.length) {
    const entry = cache.tomorrow;
    console.log('[SIT] Showing pre-picked painting:', entry.title);
    recordToday(entry);
    renderToday(entry);
    setupNav();
    saveCache({ pool: cache.pool, poolEpoch: cache.poolEpoch, poolBuiltTs: cache.poolBuiltTs, today: entry, tomorrow: null });
    schedulePrepare(loadCache(), entry);          // pre-pick the NEW tomorrow (+ refresh pool if stale)
    return;
  }

  // SLOW PATH — no usable cache for today: build the pool if needed, then score and
  // pick now. This is the only launch that waits — first install, a version bump, or
  // a day skipped so no pre-pick had a chance to run.
  let pool      = cache?.pool || null;
  let poolEpoch = cache?.poolEpoch || 0;
  let poolBuilt = cache?.poolBuiltTs || 0;

  if (!(pool && pool.length)) {
    // First run (or cache invalidated by a version bump): nothing to show yet, so
    // we must build before picking today's painting.
    status.textContent = 'a moment to slow down\nbefore today\'s painting\nis revealed';
    const fresh = await buildPool(String(poolEpoch + 1)).catch(e => {
      console.warn('[SIT] Pool build failed:', e.message);
      return [];
    });
    if (fresh.length) {
      pool = fresh; poolEpoch += 1; poolBuilt = Date.now();
    } else {
      status.textContent = 'Could not load paintings. Check your connection and reload.';
      return;
    }
  }

  status.textContent = 'a moment to slow down\nbefore today\'s painting\nis revealed';
  const entry = await pickForDate(pool, today, history);
  if (!entry) {
    status.textContent = 'Could not load a painting today. Please reload.';
    return;
  }

  saveCache({ pool, poolEpoch, poolBuiltTs: poolBuilt, today: entry, tomorrow: cache?.tomorrow || null });
  recordToday(entry);
  renderToday(entry);
  setupNav();
  schedulePrepare(loadCache(), entry);            // refresh pool if stale + pre-pick tomorrow
}

// Pick and fully prepare a display-ready entry for a given date: score the day's
// candidates, choose the best, resolve a crisp display image. Used for today
// (synchronously on the slow path) and for tomorrow (in the background).
async function pickForDate(pool, dateStr, history) {
  const blocked   = recentArtists(history);
  const candCount = recentlyTonal(history) ? NUM_CANDIDATES_STREAK : NUM_CANDIDATES;
  const candidates = pickCandidates(pool, dateStr, blocked, candCount);
  console.log(`[SIT] Scoring ${candidates.length} candidates for ${dateStr}…${candCount > NUM_CANDIDATES ? ' (widened — recent days were tonal)' : ''}`);
  const scored = [];
  for (const c of candidates) {
    try { scored.push(await scoreAndExtract(c)); }
    catch (e) { console.warn('[SIT] Skipped candidate:', c.title, e.message); }
  }
  const best = chooseBest(scored);
  if (!best) return null;
  console.log(`[SIT] Chose for ${dateStr}: "${best.title}" (vividness ${best.vividness.toFixed(2)}, room ${best.roomScore.toFixed(2)})`);
  try {
    const displayUrl = await resolveCommonsUrl(best.imageWiki, DISPLAY_WIDTH);
    if (displayUrl) best.imageUrl = displayUrl;
  } catch { /* keep the thumbnail if the display fetch fails */ }
  return {
    date: dateStr, paletteVersion: PALETTE_VERSION,
    qid: best.qid, title: best.title, artist: best.artist, year: best.year,
    imageUrl: best.imageUrl, colors: best.colors, vividness: best.vividness,
  };
}

function tomorrowStr() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return localDateStr(d);
}

// After today's painting is on screen, decide what background work is needed:
// refresh the pool if it's past its TTL, and/or pre-pick tomorrow if it isn't ready.
function schedulePrepare(cache, todayEntry) {
  if (!cache?.pool?.length) return;
  const stale = Date.now() - (cache.poolBuiltTs || 0) > POOL_TTL_DAYS * 86400000;
  const haveTomorrow = cache.tomorrow?.date === tomorrowStr()
                    && cache.tomorrow?.paletteVersion === PALETTE_VERSION;
  if (!stale && haveTomorrow) return;            // already prepared — nothing to do
  backgroundPrepare(cache, todayEntry, stale);
}

// Off the critical path: optionally rebuild the pool, then pre-pick tomorrow's
// painting so the NEXT launch is instant. Today's shown entry is preserved.
// Fire-and-forget; any failure just leaves things as-is for next time.
async function backgroundPrepare(cache, todayEntry, refreshPool) {
  if (window.__sitPreparing) return;             // guard against overlapping runs
  window.__sitPreparing = true;
  try {
    let pool = cache.pool, epoch = cache.poolEpoch || 0, builtTs = cache.poolBuiltTs || 0;
    if (refreshPool) {
      console.log('[SIT] Background: refreshing the pool…');
      const fresh = await buildPool(String(epoch + 1));
      if (fresh.length) { pool = fresh; epoch += 1; builtTs = Date.now(); }
    }
    const tStr = tomorrowStr();
    let tomorrow = cache.tomorrow;
    const needPick = refreshPool || !tomorrow || tomorrow.date !== tStr
                  || tomorrow.paletteVersion !== PALETTE_VERSION;
    if (needPick) {
      console.log('[SIT] Background: pre-picking tomorrow…');
      // history includes today (already recorded), so tomorrow avoids today's artist
      tomorrow = await pickForDate(pool, tStr, pruneHistory(loadHistory()));
    }
    saveCache({ pool, poolEpoch: epoch, poolBuiltTs: builtTs, today: todayEntry, tomorrow });
    console.log(`[SIT] Ready for tomorrow: ${tomorrow ? '"' + tomorrow.title + '"' : '(none)'}`);
  } catch (e) {
    console.warn('[SIT] Background prepare failed:', e.message);
  } finally {
    window.__sitPreparing = false;
  }
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
