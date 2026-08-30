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
import { pathToFileURL } from 'node:url';

const CHANNELS = ['noel_reports', 'wartranslated'];
const CONFLICT_ID = 'ukraine';

const CONFLICTS_PATH = 'conflicts.json';
const GAZETTEER_PATH = 'gazetteer.json.gz';
const OUTPUT_PATH = 'auto-locations.json';
const SEEN_PATH = 'seen-posts.json';
const EXPIRED_PATH = 'expired-events.json';

const MAX_EVIDENCE = 3;
const EXPIRY_DAYS = 14;
const EXCERPT_CHARS = 160;
const MIN_NAME_LEN = 3;
const CURATED_SUPPRESS_KM = 25;   // already a red marker -> not an auto one
const EVENTS_CAP = 200;           // events kept per curated marker, newest first

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

const clipExcerpt = s => (s.length > EXCERPT_CHARS ? s.slice(0, EXCERPT_CHARS) + '…' : s);
const clipText = s => (s.length > 4000 ? s.slice(0, 4000) + '…' : s);

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
// Rule-based sentence parser
//
// Turns ONE sentence into { weapon, target, targetType, casualties }. Pure
// regex, no model, no guessing.
//
// It is fed only the single sentence that names the matched place - never the
// whole post. Telegram war-channel posts are digests covering several events;
// reading across sentences let one event's weapon or casualty figure attach to
// another's location (a "fire near the Zhytomyr highway" inherited "38 killed"
// from a strike on Myla three sentences later). Sentence isolation stops that.
//
// `parsed` is attached ALONGSIDE the raw excerpt, never in place of it. If
// nothing fills, it is null and the frontend shows the excerpt verbatim.
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

// Category vocabulary. First match wins, so multi-word / specific entries come
// before the generic word they contain ("thermal power plant" before "power
// plant", "oil depot" before "depot").
const TARGET_TYPE_RULES = [
  ['thermal power plant', /\b(?:thermal|combined heat and power|CHP)\s+power (?:plant|station)\b|\bthermal power plant\b|\bC?HPP\b/i],
  ['power plant',         /\bpower (?:plant|station)\b|\bpowerplant\b|\bTPP\b/i],
  ['substation',          /\b(?:electrical |power |traction |high-voltage )?substations?\b/i],
  ['oil depot',           /\boil (?:storage )?depot\b/i],
  ['fuel depot',          /\bfuel (?:storage )?depot\b/i],
  ['oil terminal',        /\boil (?:terminal|storage|tank farm)\b|\bfuel terminal\b/i],
  ['refinery',            /\brefiner(?:y|ies)\b/i],
  ['grain terminal',      /\bgrain (?:terminal|elevator|silo|storage)\b/i],
  ['railway station',     /\b(?:railway|train) station\b|\brail(?:way)? (?:hub|junction)\b/i],
  ['sorting centre',      /\bsorting cent(?:re|er)\b/i],
  ['delivery hub',        /\bdelivery hub\b/i],
  ['logistics hub',       /\blogistics (?:hub|cent(?:re|er)|base)\b/i],
  ['bridge',              /\bbridges?\b/i],
  ['air defence system',  /\bair[ -]defen[cs]e (?:system|battery|missile system|unit)\b|\bSAM (?:site|system|battery)\b|\bsurface-to-air missile system\b|\bS-[0-9]{3}\b|\bPantsir(?:-[A-Z0-9]+)?\b|\bBuk(?:-[A-Z0-9]+)?\b|\belectronic warfare (?:system|complex)\b/i],
  ['apartment block',     /\bapartment (?:block|building|complex)s?\b|\bresidential (?:building|block|tower|high-rise)s?\b|\bblock of flats\b/i],
  ['warehouse',           /\bwarehouses?\b/i],
  ['airfield',            /\bairfields?\b|\bair ?base\b|\baerodrome\b/i],
  ['depot',               /\b(?:ammunition|ammo|supply|arms) depots?\b|\bdepots?\b/i],
  ['port',                /\b(?:sea)?ports?\b|\bharbou?r\b/i],
  ['school',              /\bschools?\b|\bkindergartens?\b/i],
  ['hospital',            /\bhospitals?\b|\bclinics?\b|\bmedical facilit(?:y|ies)\b/i],
];

const EVENT_VERB_AFTER  = /\b(?:struck|hit|destroyed|damaged|attacked|targeted|shelled|blew up|knocked out|wrecked)\s+(?:a |an |the |several |two |three |four |\d+ )*([A-Za-z][\w'-]*(?: [A-Za-z][\w'-]*){0,2})/i;
const EVENT_VERB_BEFORE = /\b(?:a |an |the )?([A-Z][\w'-]*(?: [a-z][\w'-]*){0,3})\s+(?:was|were)\s+(?:struck|hit|destroyed|damaged|attacked|targeted|shelled|blown up|set (?:on )?fire)/;
const TARGET_LEAD = /^(?:a |an |the |another |and |or |also |in |at |on |near |of |around |russian |ukrainian |enemy |russia's |ukraine's )+/i;
const TARGET_TAIL = /\s+\b(and|or|also|in|on|at|near|of|for|as|to|the|a|an|belonging|was|were|from|over|this|that|region|regions|oblast|air|surface|missile|system|systems|complex)\b.*$/i;
const TARGET_STOP = new Set([
  'russian', 'ukrainian', 'enemy', 'occupier', 'occupiers', 'them', 'it',
  'people', 'area', 'region', 'target', 'targets', 'city', 'building',
]);

// The SENTENCE naming the place has to describe something that happened. A
// sentence without one of these words is commentary, diplomacy or analysis, not
// an event, and is dropped. Deliberately excludes words that name the conflict
// rather than an occurrence ("war", "offensive", "invasion", "front") — a quote
// about Russia's war aims that happens to sit in a post full of strike news is
// still not an event.
const EVENT_WORDS = /\b(strikes?|struck|(?<!nearly )(?<!narrowly )hit|hitting|destroy(?:ed|s)?|kill(?:ed|s)?|wound(?:ed|s)?|fires?|explosions?|shell(?:ed|ing|s)?|drone attack|drone strike|missiles?|down(?:ed)?|damag(?:ed|es?|ing)|blast|detonation|attack(?:ed)?)\b/i;

// Words carrying no signal for the near-duplicate check.
const DEDUPE_STOP = new Set([
  'the', 'and', 'was', 'were', 'has', 'have', 'had', 'been', 'that', 'this',
  'with', 'for', 'from', 'are', 'near', 'into', 'over', 'after', 'before',
  'also', 'per', 'say', 'says', 'said', 'report', 'reports', 'reported',
  'russian', 'ukrainian', 'russia', 'ukraine', 'occupied', 'region', 'oblast',
  'overnight', 'morning', 'august', 'september', 'their', 'they', 'his', 'her',
  'according', 'confirmed', 'preliminary', 'still', 'more', 'about', 'around',
]);

const significantWords = s => new Set(
  (s.toLowerCase().match(/[a-z]{3,}/g) || []).filter(w => !DEDUPE_STOP.has(w))
);

// Overlap coefficient: shared words / the smaller word set.
function wordOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

// The event-entry shape written under auto-locations.json > events > <marker>.
// `parsed` is filled by mergeMarkerEvents, from the sentence, at merge time.
const buildEventEntry = (s, post) => ({
  channel: post.channel,
  url: post.url,
  at: post.at ? post.at.replace('+00:00', 'Z') : null,
  text: clipText(post.text),
  sentence: s.sentence,
  excerpt: clipExcerpt(s.excerpt),
});

// Metonymy filter. A place name is not always a place: "Moscow warned of
// consequences" is the government, "a graphic of a missile over central Moscow"
// is a picture. Before a match counts, the sentence has to use the name as a
// LOCATION where something happened. Returns { ok } or { ok:false, reason }.
const LOCATIVE_BEFORE = /\b(in|at|near|on|over|outside|across|into|towards?)\b[^.,;:!?()"']{0,22}$/i;
const POSSESSIVE_PLACE = /^['’]s\s+\p{Lu}/u;
// name immediately (allowing a short adverb) followed by a speech / policy verb
const SPEECH_VERB = /^[,\s]*(?:(?:has|had|also|now|then|reportedly|however|again|since|repeatedly)\s+)*(says?|said|warn(?:s|ed|ing)?|announce[sd]?|denie[sd]|deny|claim(?:s|ed)?|threaten(?:s|ed|ing)?|agree[sd]?|refuse[sd]?|respond(?:s|ed)?|reject(?:s|ed)?|accuse[sd]?|urge[sd]?)\b/i;
// the sentence is about a depiction or an intention, not an occurrence
const DEPICTION = /\b(post(?:ed|ing) a|a graphic|footage of|responded to|responding to|says? it will|said it would|plans? to|planning to|threaten(?:ed|s)? to|intends? to|vow(?:ed|s)? to|pledg(?:ed|es) to|warn(?:s|ed|ing) of|warning that)\b/i;

function metonymyReject(sentence, name) {
  if (!sentence || !name) return { ok: true };
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu');
  const m = re.exec(sentence);
  if (!m) return { ok: true };                      // name not in this sentence; other filters handle it
  const before = sentence.slice(0, m.index);
  const after = sentence.slice(m.index + m[0].length);

  if (DEPICTION.test(sentence)) return { ok: false, reason: 'depiction or stated intention, not an occurrence' };
  if (SPEECH_VERB.test(after))  return { ok: false, reason: 'place is the subject of a speech/policy verb' };
  if (LOCATIVE_BEFORE.test(before) || POSSESSIVE_PLACE.test(after)) return { ok: true };
  return { ok: false, reason: 'bare occurrence — not written as a location' };
}

// ---------------------------------------------------------------------------
// Confidence ladder (phase one, no external accounts)
//
//   reported     -> one source said it happened
//   corroborated -> a second INDEPENDENT source, or a GDELT news match
//   confirmed    -> reserved for press/official sources (not phase one)
// ---------------------------------------------------------------------------

// Source type of a channel. Only telegram exists today; press/official are
// declared here so the independence rule already knows about them.
const SOURCE_TYPE = { noel_reports: 'telegram', wartranslated: 'telegram' };
const sourceType = channel => SOURCE_TYPE[channel] || 'telegram';

// The originating source a post is quoting. Two telegram channels both relaying
// "the General Staff says …" are ONE source, not two.
const ORIGIN_PATTERNS = [
  ['Ukraine General Staff',   /\bgeneral staff\b/i],
  ['Ukraine Air Force',       /\bair force(?: command)?\b/i],
  ['HUR',                     /\bHUR\b|\bdefen[cs]e intelligence\b|\bmilitary intelligence\b/i],
  ['SBU',                     /\bSBU\b|\bsecurity service of ukraine\b/i],
  ['Ukraine Navy',            /\bukrainian navy\b|\bnavy command\b/i],
  ['Unmanned Systems Forces', /\bunmanned systems forces\b/i],
  ['Special Operations Forces',/\bspecial operations forces\b|\bSSO\b/i],
  ['Zelensky',                /\bzelensky+\b/i],
  ['Ukraine MoD',             /\bukrainian (?:defense|defence) ministry\b|\bministry of defen[cs]e of ukraine\b/i],
  ['Russian MoD',             /\brussian (?:defense|defence) ministry\b|\brussian mod\b/i],
  ['Reuters',                 /\breuters\b/i],
  ['AP',                      /\bassociated press\b/i],
  ['AFP',                     /\bAFP\b/i],
  ['Bloomberg',               /\bbloomberg\b/i],
  ['NYT',                     /\bnew york times\b/i],
  ['BBC',                     /\bBBC\b/i],
  ['CNN',                     /\bCNN\b/i],
  ['ISW',                     /\bISW\b|\binstitute for the study of war\b/i],
  ['NASA FIRMS',              /\bNASA FIRMS\b|\bFIRMS data\b/i],
  ['Crimean Wind',            /\bcrimean wind\b/i],
  ['ASTRA',                   /\bASTRA\b/i],
  ['Baza',                    /\bBaza\b/i],
  ['Mash',                    /\bMash\b/i],
  ['Exilenova',               /\bexilenova\b/i],
  ['governor',                /\bgovernor\b|\bregion(?:al)? (?:head|chief|administration)\b/i],
  ['mayor',                   /\bmayor\b/i],
  ['local authorities',       /\blocal (?:authorities|officials|media)\b/i],
  ['emergency service',       /\b(?:state )?emergency service\b|\bDSNS\b/i],
];

function namedOrigins(text) {
  const out = new Set();
  for (const [label, re] of ORIGIN_PATTERNS) if (re.test(text || '')) out.add(label);
  return out;
}

// Count the INDEPENDENT sources backing an event. Two sources are independent
// only if their types differ, or they are two telegram channels that do not
// name the same originating source.
function independentSourceCount(event) {
  const src = [
    { type: sourceType(event.channel), channel: event.channel, origins: namedOrigins(event.text || event.sentence || '') },
    ...(event.corroboration || []).map(c => ({
      type: sourceType(c.channel), channel: c.channel,
      origins: new Set(c.origins || namedOrigins(c.text || '')),
    })),
  ];
  const groups = [];   // each group is one effective source
  for (const s of src) {
    const same = groups.find(g => {
      if (g.type !== s.type) return false;
      if (g.type !== 'telegram') return true;                 // same non-telegram type: treat as one outlet for now
      if (g.channels.has(s.channel)) return true;             // same channel
      for (const o of s.origins) if (g.origins.has(o)) return true;   // shared named origin
      return false;
    });
    if (same) {
      same.channels.add(s.channel);
      for (const o of s.origins) same.origins.add(o);
    } else {
      groups.push({ type: s.type, channels: new Set([s.channel]), origins: new Set(s.origins) });
    }
  }
  return groups.length;
}

const iso10 = d => new Date(d).toISOString().slice(0, 10);

// Give an event its ladder fields if it has none. Existing events start
// 'reported', dated to when they were first seen.
function initLadder(event) {
  if (!event.status) {
    event.status = 'reported';
    event.statusChanged = event.at ? iso10(event.at) : iso10(Date.now());
    event.statusEvidence = [];
  }
  event.statusEvidence ||= [];
  return event;
}

// The corroboration promotion. Idempotent; run it on every pass.
function applyCorroboration(event, now = new Date()) {
  initLadder(event);
  if (event.status !== 'reported') return event;
  if (independentSourceCount(event) < 2) return event;
  event.status = 'corroborated';
  event.statusChanged = iso10(now);
  event.statusEvidence.push({
    kind: 'corroboration',
    at: iso10(now),
    sources: [
      { channel: event.channel, origins: [...namedOrigins(event.text || event.sentence || '')] },
      ...(event.corroboration || []).map(c => ({ channel: c.channel, origins: c.origins || [] })),
    ],
  });
  return event;
}

// Within one location, fold near-duplicate reports of the same event into a
// single entry (keep the earliest). A repost by the SAME channel is deduped
// but is not corroboration; a different channel is recorded with the named
// origins it quotes, so the independence check can weigh it.
function dedupeEvents(list) {
  const kept = [];
  for (const ev of list.slice().sort((a, b) => (a.at || '').localeCompare(b.at || ''))) {
    const sig = significantWords(ev.text || ev.excerpt || '');
    const dup = kept.find(k => wordOverlap(sig, k._sig) > 0.6);
    if (dup) {
      dup.corroboration ||= [];
      const add = c => {
        if (!c || !c.url || c.channel === dup.channel) return;             // same channel is not corroboration
        if (dup.corroboration.some(x => x.url === c.url)) return;          // already recorded
        dup.corroboration.push({ channel: c.channel, url: c.url, origins: c.origins || [] });
      };
      add({ channel: ev.channel, url: ev.url, origins: [...namedOrigins(ev.text || '')] });
      for (const c of ev.corroboration || []) add(c);
      // carry the higher ladder rung and its evidence forward
      const RANK = { reported: 0, corroborated: 1, confirmed: 2 };
      if (Array.isArray(ev.statusEvidence)) dup.statusEvidence = [...(dup.statusEvidence || []), ...ev.statusEvidence];
      if (ev.status && (RANK[ev.status] || 0) > (RANK[dup.status || 'reported'] || 0)) {
        dup.status = ev.status;
        dup.statusChanged = ev.statusChanged || dup.statusChanged;
      }
    } else {
      kept.push({ ...ev, _sig: sig });
    }
  }
  return kept
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
    .map(({ _sig, ...e }) => e);
}

const EVENT_EXPIRY_DAYS = 14;

// An event still 'reported' this many days after it was posted has had no
// corroboration and no news pickup. It is not deleted — the caller moves the
// whole entry to expired-events.json.
function isExpired(event, now = new Date()) {
  if (!event || event.status !== 'reported' || !event.at) return false;
  const ageDays = (now - new Date(event.at)) / 86_400_000;
  return ageDays > EVENT_EXPIRY_DAYS;
}

// GDELT news cross-check. Query the DOC API for the place over the event date
// +/- 1 day and look for an article whose title shares the event sentence's
// significant nouns (the place name itself does not count).
//
// Three distinct returns, because the caller needs to tell them apart:
//   { url, title, shared }  a match          -> promote to 'corroborated'
//   false                   checked, nothing -> event has now been looked at
//   null                    not checkable    (no date, or too thin to query)
// A real GDELT failure (network, timeout, rejection) THROWS, so the caller can
// see that the pass was incomplete and hold off on expiring anything.
async function gdeltCorroborates(placeName, atISO, sentence, fetchImpl = fetch) {
  if (!atISO || !sentence) return null;
  const d = new Date(atISO);
  if (Number.isNaN(+d)) return null;

  const nouns = significantWords(sentence);
  nouns.delete(placeName.toLowerCase());
  if (nouns.size < 2) return null;                  // nothing specific enough to match on

  const stamp = x => new Date(x).toISOString().slice(0, 10).replace(/-/g, '') + '000000';
  const start = new Date(d); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(d);   end.setUTCDate(end.getUTCDate() + 2);
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + `?query=${encodeURIComponent(`"${placeName}"`)}`
    + '&mode=artlist&format=json&maxrecords=50&sort=hybridrel'
    + `&startdatetime=${stamp(start)}&enddatetime=${stamp(end)}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  let articles;
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 conflict-globe' } });
    if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
    const body = await res.text();
    if (!body.trim().startsWith('{')) throw new Error('GDELT returned a non-JSON body');   // its errors are plain text with HTTP 200
    articles = JSON.parse(body).articles || [];
  } finally {
    clearTimeout(t);
  }

  for (const a of articles) {
    const titleWords = significantWords(a.title || '');
    const shared = [...nouns].filter(w => titleWords.has(w));
    if (shared.length >= 2) return { url: a.url, title: a.title, domain: a.domain, shared };
  }
  return false;
}

// Merge new event entries for one curated marker into the ones already stored:
// keep only entries with an isolated sentence that names a single occurrence,
// fewer than three places, and the marker used as a location rather than as a
// government or a picture; dedupe by URL, fold near-duplicates, cap the list
// newest-first. Shared by the incremental detector and the backfill.
function mergeMarkerEvents(prevList, newList, gaz, markerName) {
  const raw = [...(newList || []), ...(prevList || [])]
    .filter(e => e.sentence)
    .filter(e => EVENT_WORDS.test(e.sentence) && placesNamed(e.sentence, gaz).size < 3)
    .filter(e => metonymyReject(e.sentence, markerName).ok)
    .filter((e, idx, arr) => arr.findIndex(x => x.url === e.url) === idx)
    .map(e => ({
      channel: e.channel,
      url: e.url,
      at: e.at,
      text: e.text || null,
      sentence: e.sentence,
      excerpt: e.excerpt,
      parsed: parseSentence(e.sentence, placesNamed(e.sentence, gaz)),
      ...(e.status ? { status: e.status, statusChanged: e.statusChanged, statusEvidence: e.statusEvidence || [] } : {}),
      ...(Array.isArray(e.corroboration) && e.corroboration.length ? { corroboration: e.corroboration } : {}),
    }));
  // fold near-duplicates, then run the (idempotent) corroboration promotion
  return dedupeEvents(raw)
    .slice(0, EVENTS_CAP)
    .map(e => applyCorroboration(e));
}

// Split a post into sentences and return the one covering character `offset`.
// Boundaries: . ! ? … followed by whitespace/end, or a newline. A period right
// after a lone capital ("U.S.", "Gen.") is not treated as a boundary.
const SENT_ABBREV = new Set(['gen', 'lt', 'col', 'sgt', 'maj', 'mr', 'mrs', 'ms', 'dr', 'st', 'mt', 'no', 'vs', 'inc', 'jr', 'sr']);
function sentenceAt(text, offset) {
  const bounds = [0];
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\n') { bounds.push(k + 1); continue; }
    if (!'.!?…'.includes(ch)) continue;
    // skip "U.S.", single-initial and known abbreviations
    const before = text.slice(Math.max(0, k - 4), k);
    const lastWord = (before.match(/[A-Za-z]+$/) || [''])[0].toLowerCase();
    if (/(^|[^A-Za-z])[A-Za-z]$/.test(before) || SENT_ABBREV.has(lastWord)) continue;
    let j = k + 1;
    while (j < text.length && '".!?…”’\')]'.includes(text[j])) j++;
    if (j >= text.length || /\s/.test(text[j])) bounds.push(j);
  }
  bounds.push(text.length);
  for (let a = 0; a < bounds.length - 1; a++) {
    if (offset >= bounds[a] && offset < bounds[a + 1]) {
      return text.slice(bounds[a], bounds[a + 1]).replace(/\s+/g, ' ').trim();
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Countries and foreign cities these channels name. The gazetteer is UA+RU
// only, so without this "in Serbia, Bosnia and Moscow" would count as one
// place. Kept place-only (never unit or weapon model names). Deliberately
// excludes Ukraine, Russia, Belarus and Crimea — named in almost every post,
// they would inflate the count everywhere.
const WORLD_PLACES = new Set([
  'serbia', 'bosnia', 'kosovo', 'croatia', 'slovenia', 'hungary', 'slovakia',
  'poland', 'romania', 'moldova', 'bulgaria', 'greece', 'austria', 'germany',
  'france', 'britain', 'england', 'ireland', 'italy', 'spain', 'portugal',
  'netherlands', 'belgium', 'luxembourg', 'denmark', 'norway', 'sweden',
  'finland', 'estonia', 'latvia', 'lithuania', 'iceland', 'switzerland',
  'georgia', 'armenia', 'azerbaijan', 'turkey', 'turkiye', 'kazakhstan',
  'uzbekistan', 'kyrgyzstan', 'tajikistan', 'turkmenistan', 'mongolia',
  'china', 'india', 'pakistan', 'japan', 'vietnam', 'thailand', 'indonesia',
  'iran', 'iraq', 'syria', 'lebanon', 'israel', 'jordan', 'yemen', 'egypt',
  'libya', 'sudan', 'ethiopia', 'somalia', 'nigeria', 'algeria', 'morocco',
  'canada', 'mexico', 'brazil', 'argentina', 'venezuela', 'cuba', 'australia',
  'washington', 'london', 'paris', 'berlin', 'brussels', 'warsaw', 'minsk',
  'tehran', 'baghdad', 'damascus', 'cairo', 'beijing', 'pyongyang', 'seoul',
  'tokyo', 'ankara', 'istanbul', 'tbilisi', 'yerevan', 'baku', 'astana',
  'vienna', 'geneva', 'zurich', 'budapest', 'bucharest', 'sofia', 'belgrade',
  'sarajevo', 'zagreb', 'helsinki', 'stockholm', 'oslo', 'copenhagen',
  'amsterdam', 'rome', 'madrid', 'lisbon', 'athens', 'dublin', 'ottawa',
]);

// Count the distinct places (settlements, regions, countries, foreign cities)
// a sentence mentions. Three or more means a strike-summary or a commentary
// line that cannot be pinned to one location, so it is refused.
function placesNamed(sentence, gaz) {
  const toks = [...sentence.matchAll(WORD)].map(m => ({
    raw: m[0], lc: m[0].toLowerCase().replace(/[.'’]+$/, ''),
  }));
  const found = new Set();
  let i = 0;
  while (i < toks.length) {
    let adv = 1;
    for (let n = Math.min(4, toks.length - i); n >= 1; n--) {
      const phrase = toks.slice(i, i + n).map(t => t.lc).join(' ');
      if (!isCapitalised(toks[i].raw) || phrase.length < MIN_NAME_LEN || STOPLIST.has(phrase)) continue;
      if (gaz.byName.has(phrase) || gaz.regionCodes.has(phrase) || WORLD_PLACES.has(phrase)) {
        found.add(phrase); adv = n; break;
      }
    }
    i += adv;
  }
  return found;
}

// `places` is the Set from placesNamed() for this sentence: three or more
// distinct places means a strike-summary that can't be pinned to one location,
// and any place name is rejected as a `target` (it is the location, not the
// thing struck).
function parseSentence(sentence, places = new Set()) {
  if (!sentence) return null;
  if (places.size >= 3) return null;          // strike-summary sentence
  const text = sentence.replace(/^[…\s]+|[…\s]+$/g, '');

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
  if (cand.length >= 3 && !junk && !/^\d+$/.test(cand)
      && !TARGET_STOP.has(cand.toLowerCase()) && !places.has(cand.toLowerCase())) target = cand;

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

  if (!weapon && !target && !targetType && !casualties) return null;
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

        // "<place> region" / "<place> oblast" is the OBLAST, not the city. The
        // 38 deaths at Myla, ~30 km outside Kyiv, must not pin to the Kyiv
        // marker just because the post wrote "Myla, Kyiv region". Drop it.
        if (/^[\s,]*\b(region|oblast|raion|krai|kray)\b/i.test(post.text.slice(end, end + 24))) {
          drops.push({ name: `${phrase} region`, reason: 'matched the oblast, not a city — not pinned to a marker' });
          break;
        }

        const from = Math.max(0, tokens[i].idx - 60);
        const excerpt = (from > 0 ? '…' : '') +
          post.text.slice(from, Math.min(post.text.length, end + 80)).replace(/\s+/g, ' ').trim() +
          (end + 80 < post.text.length ? '…' : '');
        const sentence = sentenceAt(post.text, tokens[i].idx);
        const nearCurated = curated.find(c =>
          c.name.toLowerCase() === chosen.name.toLowerCase() ||
          haversineKm(chosen.lat, chosen.lng, c.lat, c.lng) < CURATED_SUPPRESS_KM);

        // metonymy: "Moscow warned of consequences" is the government, not a
        // place where something happened. This bites hardest on the big city
        // names, which are exactly the curated markers, so apply it to the
        // event path only. Judge against the name as it was matched.
        if (nearCurated) {
          const matchedText = tokens.slice(i, i + n).map(t => t.raw).join(' ');
          const met = metonymyReject(sentence, matchedText);
          if (!met.ok) { drops.push({ name: phrase, reason: met.reason }); break; }
        }

        (nearCurated ? suppressed : matches).push({
          name: chosen.name, place: chosen, excerpt, sentence,
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
  const newEvents = {};              // curated marker name -> [ {channel,url,at,text,excerpt,parsed} ]

  const addEvidence = (m, post) => {
    const key = `${m.place.lat.toFixed(2)},${m.place.lng.toFixed(2)}`;
    if (!places.has(key)) {
      places.set(key, { name: m.name, lat: m.place.lat, lng: m.place.lng, a1: m.place.a1, evidence: [] });
    }
    const ev = places.get(key).evidence;
    if (ev.some(e => e.url === post.url)) return;   // one post counts once per place
    ev.push({
      channel: post.channel,
      url: post.url,
      at: post.at ? post.at.replace('+00:00', 'Z') : null,
      excerpt: clipExcerpt(m.excerpt),
      sentence: m.sentence,
      parsed: parseSentence(m.sentence, placesNamed(m.sentence, gaz)),
    });
  };

  // A suppressed match is a real event at a place that already has a curated
  // red marker. It makes no new marker, but it IS reported news, so it lands
  // in auto-locations.json under `events`, keyed by the curated marker name.
  // Everything here judges the SENTENCE naming the place, never the whole post:
  //  - >= 3 places named -> a strike-summary line, not attributable, so drop it
  //  - no event word in that sentence -> commentary / analysis, so drop it
  // `text` (the whole post) is kept only for the near-duplicate check below.
  let eventsDroppedNoWord = 0, eventsDroppedSummary = 0;
  const addEvent = (s, post) => {
    const pl = placesNamed(s.sentence, gaz);
    if (pl.size >= 3) { eventsDroppedSummary++; return; }
    if (!EVENT_WORDS.test(s.sentence)) { eventsDroppedNoWord++; return; }
    const list = (newEvents[s.curated] ||= []);
    if (list.some(e => e.url === post.url)) return;
    list.push({ ...buildEventEntry(s, post), parsed: parseSentence(s.sentence, pl) });
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
    // fresh evidence first, so on a URL collision the entry that carries a
    // `sentence` wins over one written before sentence-scoping
    const allEv = [...ev, ...(existing?.evidence || [])]
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

  // Attach `parsed` to every piece of evidence, recomputing (from the stored
  // sentence, falling back to the excerpt for entries written before `sentence`
  // existed) so a parser change reaches carried-over entries too.
  for (const e of telegramOut) {
    e.evidence = e.evidence.map(ev => ({
      channel: ev.channel, url: ev.url, at: ev.at, excerpt: ev.excerpt,
      sentence: ev.sentence || null,
      // parse only from a real isolated sentence; an entry written before
      // sentence-scoping has none, and its truncated excerpt is not safe to parse
      parsed: ev.sentence ? parseSentence(ev.sentence, placesNamed(ev.sentence, gaz)) : null,
    }));
  }

  doc.conflicts[CONFLICT_ID] = [...keepOther, ...telegramOut];

  // --- merge `events` (suppressed matches at curated markers) ---
  doc.events = (doc.events && typeof doc.events === 'object' && !Array.isArray(doc.events)) ? doc.events : {};
  const prevEvents = (doc.events[CONFLICT_ID] && typeof doc.events[CONFLICT_ID] === 'object' && !Array.isArray(doc.events[CONFLICT_ID]))
    ? doc.events[CONFLICT_ID] : {};
  const outEvents = {};
  for (const marker of new Set([...Object.keys(prevEvents), ...Object.keys(newEvents)])) {
    const deduped = mergeMarkerEvents(prevEvents[marker], newEvents[marker], gaz, marker);
    if (deduped.length) outEvents[marker] = deduped;
  }

  // Expiry: an event still 'reported' after 14 days moves to expired-events.json.
  // Nothing is deleted. (Corroboration ran inside mergeMarkerEvents; the GDELT
  // cross-check is heavier and lives in scripts/confidence-ladder.mjs.)
  let expiredDoc = { expired: [] };
  if (existsSync(EXPIRED_PATH)) {
    try { expiredDoc = JSON.parse(await readFile(EXPIRED_PATH, 'utf8')); expiredDoc.expired ||= []; } catch {}
  }
  const seenExpired = new Set(expiredDoc.expired.map(e => e.url));
  let expiredCount = 0;
  for (const marker of Object.keys(outEvents)) {
    const live = [];
    for (const e of outEvents[marker]) {
      if (isExpired(e) && !seenExpired.has(e.url)) {
        expiredDoc.expired.push({ expiredOn: new Date().toISOString().slice(0, 10), reason: 'no corroboration within 14 days', marker, ...e });
        seenExpired.add(e.url);
        expiredCount++;
      } else {
        live.push(e);
      }
    }
    if (live.length) outEvents[marker] = live; else delete outEvents[marker];
  }
  doc.events[CONFLICT_ID] = outEvents;
  if (eventsDroppedNoWord || eventsDroppedSummary)
    console.log(`events: dropped ${eventsDroppedNoWord} with no event word in the sentence, ${eventsDroppedSummary} strike-summary (>=3 places)`);
  if (expiredCount) console.log(`events: ${expiredCount} expired (still 'reported' after ${EVENT_EXPIRY_DAYS} days) -> ${EXPIRED_PATH}`);

  doc.generated = new Date().toISOString();
  doc.attribution ||= gaz.attribution;

  // --- parsed-vs-raw table (hit-rate check) ---
  const parsedRows = [];
  for (const p of telegramOut)
    for (const e of p.evidence) parsedRows.push({ where: p.name, kind: 'marker', e });
  for (const [marker, list] of Object.entries(outEvents))
    for (const e of list) parsedRows.push({ where: marker, kind: 'event', e });

  const evRows = parsedRows.filter(r => r.kind === 'event');
  const evGot = evRows.filter(r => r.e.parsed).length;
  const got = parsedRows.filter(r => r.e.parsed).length;
  console.log(`\n${'='.repeat(70)}\nPARSED vs RAW`);
  console.log(`events : ${evGot}/${evRows.length} parsed`);
  console.log(`all    : ${got}/${parsedRows.length} parsed, ${parsedRows.length - got} fall back to verbatim\n${'='.repeat(70)}`);
  for (const { where, kind, e } of parsedRows) {
    const corr = e.corroboration?.length ? ` +${e.corroboration.length} corroborating` : '';
    console.log(`\n[${kind === 'event' ? where + ' «event»' : where}]  ${e.channel}${corr}`);
    console.log(`   raw      : "${e.excerpt}"`);
    if (e.sentence) console.log(`   sentence : "${e.sentence}"`);
    if (e.parsed) {
      const f = e.parsed;
      console.log(`   parsed   : weapon=${f.weapon ?? '-'}  target=${f.target ?? '-'}  targetType=${f.targetType ?? '-'}  casualties=${f.casualties ?? '-'}`);
    } else {
      console.log(`   parsed   : null  (frontend shows the raw excerpt verbatim)`);
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
    if (expiredCount) await writeFile(EXPIRED_PATH, JSON.stringify(expiredDoc, null, 2) + '\n');
    console.log(`\nwrote ${OUTPUT_PATH} (${telegramOut.length} telegram places for ${CONFLICT_ID}) and ${SEEN_PATH}`);
  } else {
    console.log(`\n[dry run] would write ${telegramOut.length} telegram places`);
  }
}

// Run only when invoked directly (`node scripts/telegram-detect.mjs`), not when
// imported by the regression test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
}

export {
  parseSentence, sentenceAt, placesNamed, loadGazetteer, EVENT_WORDS,
  parseChannel, matchPost, buildEventEntry, mergeMarkerEvents, metonymyReject,
  namedOrigins, sourceType, independentSourceCount,
  initLadder, applyCorroboration, isExpired, gdeltCorroborates, significantWords,
  EVENT_EXPIRY_DAYS,
  CHANNELS, CONFLICT_ID, CONFLICTS_PATH, OUTPUT_PATH, GAZETTEER_PATH,
};
