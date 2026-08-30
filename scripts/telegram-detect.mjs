// ---------------------------------------------------------------------------
// telegram-detect.mjs
//
// Turns posts from a few trusted English-language Telegram channels into
// auto-locations.json markers for the Ukraine conflict, by matching settlement
// names against a GeoNames gazetteer. Deterministic, auditable, no model.
//
// A marker from this source means: "a channel William trusts reported an event
// at this place." It does NOT mean the event is confirmed. The panel says so.
//
// See TELEGRAM-SPEC.md and SOURCES.md. No dependencies (built-in fetch + zlib).
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const CHANNELS = ['noel_reports', 'wartranslated'];
const CONFLICT_ID = 'ukraine';

const CONFLICTS_PATH = 'conflicts.json';
const GAZETTEER_PATH = 'gazetteer.json.gz';
const OUTPUT_PATH = 'auto-locations.json';
const SEEN_PATH = 'seen-posts.json';

const MAX_EVIDENCE = 3;
const EXPIRY_DAYS = 14;
const EXCERPT_CHARS = 160;
const MIN_NAME_LEN = 3;
const CURATED_SUPPRESS_KM = 25;   // already a red marker -> not an auto one

// Settlement names that are also ordinary words / names that collide with
// non-place capitalised words in this domain (unit names, surnames, brands).
// Grows from real output; a match here is dropped silently.
const STOPLIST = new Set([
  'most', 'many', 'star', 'mir', 'may', 'march', 'combat', 'front', 'union',
  'rada', 'both', 'sum', 'lite', 'hulk', 'orange', 'as', 'port', 'plan', 'more',
  'azov',                       // the Sea and the brigade far more often than the town
  'pantsir', 'iskander', 'buk', // weapon systems
  'ozon',                       // retailer
  // surnames that collide with village names (grows from output)
  'taras', 'tkachenko', 'putin', 'peskov', 'didych', 'lukashenko', 'zelensky',
  'ratcliffe', 'sikorski',
]);

const haversineKm = (aLat, aLng, bLat, bLng) => {
  const R = 6371, r = d => d * Math.PI / 180;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// Population rules for the no-region case (spec step 3).
const POP_DOMINATES = 3;      // top must be >= this * runner-up
const POP_MIN_ABSOLUTE = 2000;

const fetchTimeout = (url, ms = 25_000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 conflict-globe' } })
    .finally(() => clearTimeout(t));
};

const todayISO = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Telegram parsing (traps from TELEGRAM-SPEC.md)
// ---------------------------------------------------------------------------

function decode(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseChannel(html, channel) {
  const posts = [];
  const parts = html.split('<div class="tgme_widget_message ');
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i];
    const idM = c.match(/data-post="([^"]+)"/);
    if (!idM) continue;
    const slug = idM[1];                      // "noel_reports/51876"
    const num = Number(slug.split('/')[1]);

    // all text blocks; a reply carries a greyed quote first, real text last
    const texts = [...c.matchAll(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\n<div class="tgme_widget_message_/g
    )].map(m => decode(m[1]));
    const text = texts.length ? texts[texts.length - 1] : '';
    if (!text) continue;                      // media-only post, skip

    const timeM = c.match(/<time[^>]*datetime="([^"]+)"/);
    posts.push({
      channel,
      num,
      url: `https://t.me/${slug}`,
      at: timeM ? timeM[1] : null,
      text,
    });
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Gazetteer
// ---------------------------------------------------------------------------

function loadGazetteer() {
  const raw = JSON.parse(gunzipSync(readFileSync(GAZETTEER_PATH)).toString('utf8'));
  // [name, asciiname|0, alt[]|0, lat, lng, admin1, population]
  const byName = new Map();                   // lowercased name -> [place]
  const add = (key, place) => {
    const k = key.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(place);
  };
  const cleanAlt = a => /^[a-z][a-z '’-]{3,}$/.test(a) && !STOPLIST.has(a);
  for (const [n, aa, alt, lat, lng, a1, pop] of raw.places) {
    const place = { name: n, lat, lng, a1, pop };
    if (n.length >= MIN_NAME_LEN) add(n, place);
    if (aa && aa.length >= MIN_NAME_LEN) add(aa, place);
    if (alt) for (const a of alt) if (cleanAlt(a)) add(a, place);
  }

  // region keyword -> Set of admin1 codes, from the admin1 display names
  const regionCodes = new Map();
  const regionAdd = (word, code) => {
    const w = word.toLowerCase();
    if (!regionCodes.has(w)) regionCodes.set(w, new Set());
    regionCodes.get(w).add(code);
  };
  for (const [code, name] of Object.entries(raw.admin1)) {
    const bare = name.toLowerCase()
      .replace(/\b(oblast|oblast'|republic|kray|krai|city|autonomous|okrug)\b/g, '')
      .replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim();
    if (bare) regionAdd(bare, code);
  }
  // hand aliases the display names miss
  regionAdd('crimea', 'UA.11');
  regionAdd('kyiv', 'UA.13'); regionAdd('kiev', 'UA.13');
  regionAdd('zaporizhzhia', 'UA.26'); regionAdd('zaporizhia', 'UA.26');
  regionAdd('dnipropetrovsk', 'UA.04'); regionAdd('dnipro', 'UA.04');
  regionAdd('mykolaiv', 'UA.16'); regionAdd('nikolaev', 'UA.16');
  regionAdd('kharkiv', 'UA.07'); regionAdd('kharkov', 'UA.07');
  regionAdd('odesa', 'UA.17'); regionAdd('odessa', 'UA.17');

  return { byName, regionCodes, admin1: raw.admin1, attribution: raw.attribution };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const WORD = /[\p{L}][\p{L}'’.-]*/gu;

function detectRegions(text, regionCodes) {
  const codes = new Set();
  const hits = [];
  const lower = text.toLowerCase();
  // only treat a region word as a region when it's presented as one
  for (const [word, set] of regionCodes) {
    const re = new RegExp(`\\b${word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b[^.]{0,18}?\\b(oblast|region|raion|district)\\b`, 'i');
    if (re.test(lower)) { for (const c of set) codes.add(c); hits.push(word); }
  }
  if (/\boccupied crimea\b|\bin crimea\b|\bcrimean\b/i.test(text)) { codes.add('UA.11'); hits.push('crimea'); }
  return { codes, hits };
}

function chooseCandidate(name, cands, regionCodes, bbox, drops) {
  const inBox = c => c.lat >= bbox[0] && c.lat <= bbox[1] && c.lng >= bbox[2] && c.lng <= bbox[3];

  if (regionCodes.size) {
    const inRegion = cands.filter(c => regionCodes.has(c.a1));
    if (inRegion.length === 0) {
      drops.push({ name, reason: `region given but no "${name}" in it`, cands: cands.length });
      return null;
    }
    inRegion.sort((a, b) => b.pop - a.pop);
    const pick = inRegion[0];
    return inBox(pick) ? pick : (drops.push({ name, reason: 'chosen candidate outside bbox' }), null);
  }

  const boxed = cands.filter(inBox);
  if (boxed.length === 0) {
    drops.push({ name, reason: 'no candidate inside bbox', cands: cands.length });
    return null;
  }
  if (boxed.length === 1) return boxed[0];

  boxed.sort((a, b) => b.pop - a.pop);
  const [top, next] = boxed;
  if (top.pop >= POP_MIN_ABSOLUTE && top.pop >= POP_DOMINATES * (next.pop || 1)) return top;

  drops.push({
    name,
    reason: 'ambiguous, no region, population inconclusive',
    cands: boxed.slice(0, 4).map(c => `${c.a1}:pop${c.pop}`).join(' / '),
  });
  return null;
}

const isCapitalised = tok => /^[\p{Lu}]/u.test(tok);

// ---------------------------------------------------------------------------
// Rule-based excerpt parser
//
// Turns one excerpt into { weapon, target, targetType, casualties }. Pure
// regex, no model, no guessing. If fewer than two of the four fields fill,
// it returns null and the frontend falls back to the verbatim excerpt.
//
// `parsed` is attached ALONGSIDE the raw excerpt, never in place of it.
// ---------------------------------------------------------------------------

// First match wins, so list the specific systems before the generic word.
const WEAPON_RULES = [
  ['glide bomb', /\bglide bombs?\b|\bKABs?\b|\bKAB[- ]?\d+\b|\bUMPK\b/i],
  ['Shahed',     /\bShaheds?(?:[- ]?\d+)?\b/i],
  ['Geran',      /\bGeran(?:[- ]?\d+)?\b|\bГеран[ья]/i],
  ['Iskander',   /\bIskander(?:[- ][A-Z0-9]+)?\b/i],
  ['HIMARS',     /\bHIMARS\b/i],
  ['ATACMS',     /\bATACMS\b/i],
  // "missile" the weapon, not "missile system" / "surface-to-air missile" (an
  // air-defence target) — those are caught by TARGET_TYPE_RULES instead.
  ['missile',    /\b(?<!surface-to-air )(?<!air defense )(?<!air defence )(?:cruise |ballistic |anti-?ship |guided )?missiles?\b(?!\s+(?:system|regiment|brigade|division|complex|launcher|battery|unit|forces|defen))|\bmissile strike\b/i],
  // "drone" only counts as the weapon used, not when it describes the thing
  // hit ("drone warehouse", "drone command post", "drone launch site").
  ['drone',      /\b(?:kamikaze |attack |strike |FPV |naval |long-range )?drones?\b(?!\s+(?:launch|command|storage|warehouse|depot|stockpile|site|sites|factor|plant|assembl|operator|unit|regiment|base|hub|hangar))|\bUAVs?\b(?!\s+(?:launch|command|site|base))|\bloitering munitions?\b/i],
  ['artillery',  /\bartillery\b|\bMLRS\b|\bGrad(?: rockets?)?\b|\brocket artillery\b|\bmortars?\b|\bhowitzers?\b/i],
  ['shell',      /\bshell(?:ed|ing|s|fire)?\b/i],
];

// Category vocabulary is fixed by the spec. First match wins.
const TARGET_TYPE_RULES = [
  ['oil terminal',       /\boil (?:terminal|storage|tank farm)\b|\bfuel terminal\b/i],
  ['refinery',           /\brefiner(?:y|ies)\b/i],
  ['air defence system', /\bair[ -]defen[cs]e (?:system|battery|missile system|unit)\b|\bSAM (?:site|system|battery)\b|\bsurface-to-air missile system\b|\bS-[0-9]{3}\b|\bPantsir(?:-[A-Z0-9]+)?\b|\bBuk(?:-[A-Z0-9]+)?\b|\belectronic warfare (?:system|complex)\b/i],
  ['apartment block',    /\bapartment (?:block|building|complex)s?\b|\bresidential (?:building|block|tower|high-rise)s?\b|\bblock of flats\b/i],
  ['warehouse',          /\bwarehouses?\b/i],
  ['airfield',           /\bairfields?\b|\bair ?base\b|\baerodrome\b/i],
  ['substation',         /\b(?:electrical |power |traction )?substations?\b/i],
  ['depot',              /\b(?:ammunition|ammo|fuel|supply|arms|oil) depots?\b|\bdepots?\b/i],
  ['port',               /\b(?:sea)?ports?\b|\bharbou?r\b/i],
  ['school',             /\bschools?\b|\bkindergartens?\b/i],
  ['hospital',           /\bhospitals?\b|\bclinics?\b|\bmedical facilit(?:y|ies)\b/i],
];

const EVENT_VERB_AFTER  = /\b(?:struck|hit|destroyed|damaged|attacked|targeted|shelled|blew up|knocked out|wrecked)\s+(?:a |an |the |several |two |three |four |\d+ )*([A-Za-z][\w'-]*(?: [A-Za-z][\w'-]*){0,2})/i;
const EVENT_VERB_BEFORE = /\b(?:a |an |the )?([A-Z][\w'-]*(?: [a-z][\w'-]*){0,3})\s+(?:was|were)\s+(?:struck|hit|destroyed|damaged|attacked|targeted|shelled|blown up|set (?:on )?fire)/;
const TARGET_LEAD = /^(?:a |an |the |another |and |or |also |russian |ukrainian |enemy |russia's |ukraine's )+/i;
const TARGET_TAIL = /\s+\b(and|or|also|in|on|at|near|of|the|a|an|belonging|was|were|from|over|this|that|region|regions|oblast|air|surface|missile|system|systems|complex)\b.*$/i;
const TARGET_STOP = new Set([
  'russian', 'ukrainian', 'enemy', 'occupier', 'occupiers', 'them', 'it',
  'people', 'area', 'region', 'target', 'targets', 'city', 'building',
]);

function parseExcerpt(excerpt) {
  if (!excerpt) return null;
  const text = excerpt.replace(/^[…\s]+|[…\s]+$/g, '');

  let weapon = null;
  for (const [label, re] of WEAPON_RULES) if (re.test(text)) { weapon = label; break; }

  let targetType = null;
  for (const [label, re] of TARGET_TYPE_RULES) if (re.test(text)) { targetType = label; break; }

  // target: the noun next to an event verb, either word order.
  let target = null;
  const before = text.match(EVENT_VERB_BEFORE);
  const after = text.match(EVENT_VERB_AFTER);
  let cand = (before && before[1]) || (after && after[1]) || '';
  cand = cand.replace(TARGET_LEAD, '').replace(TARGET_TAIL, '').trim();
  const junk = /\b(set|ablaze|alight|fire|burning|reported|struck|hit|destroyed|damaged|attacked|overnight)\b/i.test(cand);
  if (cand.length >= 3 && !junk && !/^\d+$/.test(cand) && !TARGET_STOP.has(cand.toLowerCase())) target = cand;

  // casualties: "N killed", "N wounded", "N injured" (and "N dead"), either
  // order. A few interposed words are allowed ("20 people ... were injured")
  // but a unit/time word in the gap ("20 minutes after ... killed") rules it out.
  const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const N = '(\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)';
  const GAP = "(?:[a-z’'-]+\\s+){0,4}?";
  const GAP_BAD = /\b(minute|hour|day|week|month|year|km|kilomet|mile|meters?|metres?|sq|percent|floor|storey|story|aircraft|drones?|missiles?)\b/i;
  const cas = [];
  const seen = new Set();
  const toNum = s => NUMWORD[s.toLowerCase()] ?? s;
  const push = (n, kindRaw) => {
    const kind = kindRaw.toLowerCase() === 'dead' ? 'killed' : kindRaw.toLowerCase();
    if (seen.has(kind)) return;
    seen.add(kind);
    cas.push(`${toNum(n)} ${kind}`);
  };
  for (const m of text.matchAll(new RegExp(`\\b${N}\\s+(${GAP})(?:were\\s+|are\\s+|reported\\s+|confirmed\\s+|left\\s+)?(killed|dead|wounded|injured)\\b`, 'gi')))
    if (!GAP_BAD.test(m[2])) push(m[1], m[3]);
  for (const m of text.matchAll(new RegExp(`\\b(killed|wounded|injured)\\s+(?:at least\\s+|around\\s+|some\\s+)?${N}\\b`, 'gi')))
    push(m[2], m[1]);
  const casualties = cas.length ? cas.join(', ') : null;

  const filled = [weapon, target, targetType, casualties].filter(Boolean).length;
  if (filled < 2) return null;
  return { weapon, target, targetType, casualties };
}

function matchPost(post, gaz, bbox, curated) {
  const { codes: regionCodes, hits: regionHits } = detectRegions(post.text, gaz.regionCodes);
  const tokens = [...post.text.matchAll(WORD)].map(m => ({
    raw: m[0], lc: m[0].toLowerCase().replace(/[.'’]+$/, ''), idx: m.index,
  }));

  const matches = [];
  const suppressed = [];   // real place, but already a curated marker
  const drops = [];        // capitalised, plausible, but couldn't be resolved

  let i = 0;
  while (i < tokens.length) {
    let advanced = 1;
    for (let n = Math.min(4, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).map(t => t.lc).join(' ');
      if (!gaz.byName.has(phrase)) continue;

      // Place names in these posts are always capitalised. This one rule
      // removes "as", "is", "port", "day", "more" and the junk alt-names.
      if (!isCapitalised(tokens[i].raw) || phrase.length < MIN_NAME_LEN) { continue; }
      if (STOPLIST.has(phrase)) { advanced = n; break; }

      const localDrops = [];
      const chosen = chooseCandidate(phrase, gaz.byName.get(phrase), regionCodes, bbox, localDrops);
      advanced = n;

      if (chosen) {
        const end = tokens[i + n - 1].idx + tokens[i + n - 1].raw.length;
        const from = Math.max(0, tokens[i].idx - 60);
        const excerpt = (from > 0 ? '…' : '') +
          post.text.slice(from, Math.min(post.text.length, end + 80)).replace(/\s+/g, ' ').trim() +
          (end + 80 < post.text.length ? '…' : '');
        const nearCurated = curated.find(c =>
          c.name.toLowerCase() === chosen.name.toLowerCase() ||
          haversineKm(chosen.lat, chosen.lng, c.lat, c.lng) < CURATED_SUPPRESS_KM);
        (nearCurated ? suppressed : matches).push({
          name: chosen.name, place: chosen, excerpt,
          ...(nearCurated ? { curated: nearCurated.name } : {}),
        });
      } else {
        drops.push(...localDrops);
      }
      break;
    }
    i += advanced;
  }
  return { matches, suppressed, drops, regionHits };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const conflicts = JSON.parse(await readFile(CONFLICTS_PATH, 'utf8'));
  const conflict = conflicts.find(c => c.id === CONFLICT_ID);
  if (!conflict) throw new Error(`no conflict "${CONFLICT_ID}" in conflicts.json`);
  const bbox = conflict.bbox;                 // [minLat, maxLat, minLng, maxLng]

  if (!existsSync(GAZETTEER_PATH)) throw new Error(`${GAZETTEER_PATH} missing - build it first`);
  const gaz = loadGazetteer();
  console.log(`gazetteer: ${[...gaz.byName.values()].reduce((s, a) => s + a.length, 0)} name keys, ${Object.keys(gaz.admin1).length} regions`);

  const seen = existsSync(SEEN_PATH) ? JSON.parse(await readFile(SEEN_PATH, 'utf8')) : {};

  // --- fetch + parse every channel ---
  const allPosts = [];
  for (const ch of CHANNELS) {
    let html;
    try {
      if (process.env.TG_FIXTURE_DIR) {
        html = await readFile(`${process.env.TG_FIXTURE_DIR}/${ch}.html`, 'utf8');
      } else {
        const res = await fetchTimeout(`https://t.me/s/${ch}`);
        if (!res.ok) { console.error(`[${ch}] HTTP ${res.status}, skipping`); continue; }
        html = await res.text();
      }
    } catch (err) {
      console.error(`[${ch}] fetch failed: ${err.message}, skipping`);
      continue;
    }
    const posts = parseChannel(html, ch).filter(p => p.num > (seen[ch] || 0));
    console.log(`[${ch}] ${posts.length} new posts`);
    allPosts.push(...posts);
  }

  allPosts.sort((a, b) => (a.at || '').localeCompare(b.at || ''));

  const curated = Array.isArray(conflict.locations) ? conflict.locations : [];

  // --- match ---
  const places = new Map();          // key -> { name, lat, lng, a1, evidence:[] }
  const allDrops = [];
  const suppressedNames = new Map(); // name -> curated marker it collided with
  const newEvents = {};              // curated marker name -> [ {channel,url,at,excerpt,parsed} ]

  const clipExcerpt = s => (s.length > EXCERPT_CHARS ? s.slice(0, EXCERPT_CHARS) + '…' : s);

  const addEvidence = (m, post) => {
    const key = `${m.place.lat.toFixed(2)},${m.place.lng.toFixed(2)}`;
    if (!places.has(key)) {
      places.set(key, { name: m.name, lat: m.place.lat, lng: m.place.lng, a1: m.place.a1, evidence: [] });
    }
    const ev = places.get(key).evidence;
    if (ev.some(e => e.url === post.url)) return;   // one post counts once per place
    const excerpt = clipExcerpt(m.excerpt);
    ev.push({
      channel: post.channel,
      url: post.url,
      at: post.at ? post.at.replace('+00:00', 'Z') : null,
      excerpt,
      parsed: parseExcerpt(excerpt),
    });
  };

  // A suppressed match is a real event at a place that already has a curated
  // red marker. It makes no new marker, but it IS reported news, so it lands
  // in auto-locations.json under `events`, keyed by the curated marker name.
  const addEvent = (s, post) => {
    const list = (newEvents[s.curated] ||= []);
    if (list.some(e => e.url === post.url)) return;
    const excerpt = clipExcerpt(s.excerpt);
    list.push({
      channel: post.channel,
      url: post.url,
      at: post.at ? post.at.replace('+00:00', 'Z') : null,
      excerpt,
      parsed: parseExcerpt(excerpt),
    });
  };

  for (const post of allPosts) {
    const { matches, suppressed, drops } = matchPost(post, gaz, bbox, curated);
    for (const d of drops) allDrops.push({ ...d, post: post.url, at: post.at });
    for (const s of suppressed) { suppressedNames.set(s.name, s.curated); addEvent(s, post); }
    for (const m of matches) addEvidence(m, post);
  }

  // --- report (the acceptance checkpoint) ---
  console.log(`\n${'='.repeat(70)}\nMATCHES  (${places.size} places from ${allPosts.length} posts)\n${'='.repeat(70)}`);
  for (const p of [...places.values()].sort((a, b) => b.evidence.length - a.evidence.length)) {
    console.log(`\n${p.name}  (${p.lat}, ${p.lng})  [${gaz.admin1[p.a1] || p.a1}]  x${p.evidence.length}`);
    for (const e of p.evidence) {
      console.log(`   ${e.at}  ${e.channel}  ${e.url}`);
      console.log(`   "${e.excerpt}"`);
    }
  }

  if (suppressedNames.size) {
    console.log(`\n${'='.repeat(70)}\nSUPPRESSED - already a curated marker  (${suppressedNames.size})\n${'='.repeat(70)}`);
    for (const [name, cur] of suppressedNames) console.log(`  ${name}  (curated: ${cur})`);
  }

  console.log(`\n${'='.repeat(70)}\nDROPPED / AMBIGUOUS  (${allDrops.length})\n${'='.repeat(70)}`);
  for (const d of allDrops) {
    console.log(`\n${d.name} - ${d.reason}${d.cands ? `  [${d.cands}]` : ''}`);
    console.log(`   ${d.at}  ${d.post}`);
  }

  // --- merge into auto-locations.json ---
  let doc = { generated: null, conflicts: {} };
  if (existsSync(OUTPUT_PATH)) {
    try { doc = JSON.parse(await readFile(OUTPUT_PATH, 'utf8')); doc.conflicts ||= {}; } catch {}
  }
  const prevAll = Array.isArray(doc.conflicts[CONFLICT_ID]) ? doc.conflicts[CONFLICT_ID] : [];
  const prevTelegram = prevAll.filter(e => e.source === 'telegram');
  // Ukraine's GKG layer is paused (see detect-locations.mjs SKIP): this
  // detector owns the whole conflict array. Stale GKG entries are dropped.
  const dropped = prevAll.filter(e => e.source !== 'telegram');
  if (dropped.length) console.log(`dropping ${dropped.length} stale non-telegram entries for ${CONFLICT_ID}`);
  const keepOther = [];

  const merged = new Map(prevTelegram.map(e => [`${e.lat.toFixed(2)},${e.lng.toFixed(2)}`, e]));
  for (const [key, p] of places) {
    const ev = p.evidence.slice().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const existing = merged.get(key);
    const allEv = [...(existing?.evidence || []), ...ev]
      .filter((e, idx, arr) => arr.findIndex(x => x.url === e.url) === idx)
      .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const dates = allEv.map(e => (e.at || '').slice(0, 10)).filter(Boolean);
    merged.set(key, {
      name: existing?.name || p.name,
      lat: Number(p.lat.toFixed(4)),
      lng: Number(p.lng.toFixed(4)),
      source: 'telegram',
      count: allEv.length,
      firstSeen: existing?.firstSeen && existing.firstSeen < (dates.at(-1) || '9999')
        ? existing.firstSeen : (dates.at(-1) || todayISO()),
      lastSeen: dates[0] || todayISO(),
      evidence: allEv.slice(0, MAX_EVIDENCE),
    });
  }

  // expire stale telegram entries
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - EXPIRY_DAYS);
  const telegramOut = [...merged.values()]
    .filter(e => new Date(e.lastSeen + 'T00:00:00Z') >= cutoff)
    .sort((a, b) => b.count - a.count);

  // Attach `parsed` to every piece of evidence, recomputing for entries
  // carried over from an older file that never had it.
  for (const e of telegramOut) {
    e.evidence = e.evidence.map(ev => ({
      channel: ev.channel, url: ev.url, at: ev.at, excerpt: ev.excerpt,
      parsed: parseExcerpt(ev.excerpt),
    }));
  }

  doc.conflicts[CONFLICT_ID] = [...keepOther, ...telegramOut];

  // --- merge `events` (suppressed matches at curated markers) ---
  const EVENTS_CAP = 12;
  doc.events = (doc.events && typeof doc.events === 'object' && !Array.isArray(doc.events)) ? doc.events : {};
  const prevEvents = (doc.events[CONFLICT_ID] && typeof doc.events[CONFLICT_ID] === 'object' && !Array.isArray(doc.events[CONFLICT_ID]))
    ? doc.events[CONFLICT_ID] : {};
  const outEvents = {};
  for (const marker of new Set([...Object.keys(prevEvents), ...Object.keys(newEvents)])) {
    const combined = [...(newEvents[marker] || []), ...(prevEvents[marker] || [])]
      .filter((e, idx, arr) => arr.findIndex(x => x.url === e.url) === idx)
      .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
      .slice(0, EVENTS_CAP)
      .map(e => ({
        channel: e.channel, url: e.url, at: e.at, excerpt: e.excerpt,
        parsed: parseExcerpt(e.excerpt),
      }));
    if (combined.length) outEvents[marker] = combined;
  }
  doc.events[CONFLICT_ID] = outEvents;

  doc.generated = new Date().toISOString();
  doc.attribution ||= gaz.attribution;

  // --- parsed-excerpt table (hit-rate check) ---
  const parsedRows = [];
  for (const p of telegramOut)
    for (const e of p.evidence) parsedRows.push({ where: `${p.name}`, e });
  for (const [marker, list] of Object.entries(outEvents))
    for (const e of list) parsedRows.push({ where: `${marker} «event»`, e });

  const got = parsedRows.filter(r => r.e.parsed).length;
  console.log(`\n${'='.repeat(70)}\nPARSED EXCERPTS  (${got}/${parsedRows.length} parsed, ${parsedRows.length - got} fall back to verbatim)\n${'='.repeat(70)}`);
  for (const { where, e } of parsedRows) {
    console.log(`\n[${where}]  ${e.channel}`);
    console.log(`   excerpt: "${e.excerpt}"`);
    if (e.parsed) {
      const f = e.parsed;
      console.log(`   parsed : weapon=${f.weapon ?? '-'}  target=${f.target ?? '-'}  targetType=${f.targetType ?? '-'}  casualties=${f.casualties ?? '-'}`);
    } else {
      console.log(`   parsed : null  (frontend shows the excerpt verbatim)`);
    }
  }

  // advance seen-posts
  for (const ch of CHANNELS) {
    const maxNum = Math.max(seen[ch] || 0, ...allPosts.filter(p => p.channel === ch).map(p => p.num));
    if (Number.isFinite(maxNum) && maxNum > 0) seen[ch] = maxNum;
  }

  if (!process.env.TG_DRY_RUN) {
    await writeFile(OUTPUT_PATH, JSON.stringify(doc, null, 2) + '\n');
    await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2) + '\n');
    console.log(`\nwrote ${OUTPUT_PATH} (${telegramOut.length} telegram places for ${CONFLICT_ID}) and ${SEEN_PATH}`);
  } else {
    console.log(`\n[dry run] would write ${telegramOut.length} telegram places`);
  }
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
