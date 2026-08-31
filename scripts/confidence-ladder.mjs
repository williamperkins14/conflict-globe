// ---------------------------------------------------------------------------
// confidence-ladder.mjs
//
// Runs the full confidence ladder over the events in auto-locations.json:
//
//   1. give every event its status fields (existing -> 'reported')
//   2. corroboration check: >= 2 independent sources -> 'corroborated'
//   3. GDELT cross-check: a same-window news article whose title shares the
//      event's significant nouns -> 'corroborated' (records the article URL)
//   4. expiry: still 'reported' after 14 days -> expired-events.json (nothing
//      is deleted; the expired file is part of the dataset)
//
// Prints a full report FIRST, then writes both files.
//
// Run:            node scripts/confidence-ladder.mjs
// Skip GDELT:     LADDER_NO_GDELT=1 node scripts/confidence-ladder.mjs
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  loadGazetteer, initLadder, applyCorroboration, independentSourceCount,
  isExpired, gdeltArticlesFor, gdeltMatchInArticles, EVENT_EXPIRY_DAYS,
  corroborationReason, sideOfChannel,
  OUTPUT_PATH, CONFLICT_ID,
} from './telegram-detect.mjs';

const EXPIRED_PATH = 'expired-events.json';
const GDELT_GAP_MS = 1_400;
const USE_GDELT = !process.env.LADDER_NO_GDELT;

// Writing is the destructive path — it is what moves events off the map — so
// it has to be asked for. Interactive runs report and stop; --write commits.
const WRITE = process.argv.includes('--write');
const DRY   = !WRITE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

loadGazetteer();   // validates the gazetteer is present; not otherwise needed here

const doc = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
const events = (doc.events && doc.events[CONFLICT_ID]) || {};

let expiredDoc = { expired: [] };
if (existsSync(EXPIRED_PATH)) {
  try { expiredDoc = JSON.parse(await readFile(EXPIRED_PATH, 'utf8')); expiredDoc.expired ||= []; } catch {}
}
const alreadyExpired = new Set(expiredDoc.expired.map(e => e.url));

// flatten, keeping the marker key
const all = [];
for (const [marker, list] of Object.entries(events)) for (const e of list) all.push({ marker, e });

// ---- 1 + 2: init + corroboration ----------------------------------------
// First fix the stored bug: strip corroboration entries from the event's own
// channel (a repost is not a second source). Going forward dedupeEvents does
// this at write time.
let selfCorrStripped = 0;
for (const { e } of all) {
  if (!Array.isArray(e.corroboration)) continue;
  const clean = e.corroboration.filter(c => c.channel && c.channel !== e.channel);
  selfCorrStripped += e.corroboration.length - clean.length;
  if (clean.length) e.corroboration = clean; else delete e.corroboration;
}

const promotedByCorr = [];
for (const { marker, e } of all) {
  const before = e.status;
  initLadder(e);
  applyCorroboration(e, new Date());
  if (before !== 'corroborated' && e.status === 'corroborated') promotedByCorr.push({ marker, e });
}

// ---- 3: GDELT cross-check ----------------------------------------------
const promotedByGdelt = [];
let gdeltQueries = 0, gdeltErrors = 0;
if (USE_GDELT) {
  // One query per place+date, not per sentence. GDELT's article list depends
  // only on `${marker}|${date}`, so keying the cache on the sentence too (as
  // this once did) defeated it — every event was its own query. Fetch the
  // list once, then test each event's sentence against it in memory.
  const listCache = new Map();   // `${marker}|${date}` -> articles[] | null | Error
  for (const { marker, e } of all) {
    if (e.status !== 'reported' || !e.at) continue;
    const key = `${marker}|${String(e.at).slice(0, 10)}`;
    let articles = listCache.get(key);
    if (articles === undefined) {
      await sleep(GDELT_GAP_MS);
      gdeltQueries++;
      try { articles = await gdeltArticlesFor(marker, e.at); }
      catch { articles = new Error('GDELT fetch failed'); gdeltErrors++; }
      listCache.set(key, articles);
    }
    if (articles instanceof Error) continue;   // this place+date could not be checked
    const hit = gdeltMatchInArticles(articles, marker, e.sentence);
    // Stamp the event as checked whether or not GDELT found anything. This
    // is what earns it the right to expire later: an event that has never
    // been looked at must never be dropped for failing to be corroborated.
    if (hit !== null) e.checkedOn = today;

    // A match is not yet corroboration. What decides it is WHOSE match:
    // an article from the opposing side, or a third-party wire. A second
    // Ukrainian outlet agreeing with a Ukrainian Telegram channel is the
    // same perspective arriving twice, and promotes nothing.
    if (hit && hit.matches) {
      const reason = corroborationReason(hit.sides, sideOfChannel(e.channel));
      if (reason) {
        e.status = 'corroborated';
        e.statusChanged = today;
        // Record the article that actually carried the weight, not the first
        // one that happened to match: whichever match is on the opposing side.
        const opposed = { russia_aligned: 'ukraine_aligned', ukraine_aligned: 'russia_aligned' };
        const want = opposed[sideOfChannel(e.channel)];
        const key = hit.matches.find(m => m.side === 'third_party')
                 || hit.matches.find(m => m.side === want)
                 || hit.matches[0];
        e.statusEvidence.push({
          kind: 'gdelt', at: today, reason,
          url: key.url, title: key.title, domain: key.domain,
          side: key.side, shared: key.shared,
          sides: hit.sides,
        });
        promotedByGdelt.push({ marker, e, reason });
      } else {
        // Matched, but only from its own side. Worth recording that we looked
        // and what we found — a near-miss is data, not nothing.
        e.statusEvidence.push({
          kind: 'gdelt-same-side', at: today, sides: hit.sides,
          note: 'matched only sources on the reporting side; not corroboration',
        });
      }
    }
  }
}

// ---- 4: expiry --------------------------------------------------------
// Two independent conditions, and BOTH must hold. Age alone is not enough:
// we backfilled twenty days of history in an afternoon, and those events had
// never been offered a corroboration pass. Expiring them would have measured
// our own timing, not their quality — 99 of 130 would have gone.
//
// And if the GDELT pass did not complete, nothing expires at all. A partial
// check is not a failed check.
const gdeltComplete = !USE_GDELT ? false : gdeltErrors === 0;
const expirySkipped = !gdeltComplete;
if (expirySkipped) {
  console.log(USE_GDELT
    ? `\n!! expiry SKIPPED — ${gdeltErrors} GDELT queries failed, so the check is incomplete.`
    : '\n!! expiry SKIPPED — GDELT was disabled, so nothing has been checked this run.');
}

const expired = [];
for (const [marker, list] of Object.entries(events)) {
  const live = [];
  for (const e of list) {
    if (!expirySkipped && e.checkedOn && isExpired(e) && !alreadyExpired.has(e.url)) {
      const rec = { expiredOn: today, reason: `no corroboration within ${EVENT_EXPIRY_DAYS} days`, marker, ...e };
      expiredDoc.expired.push(rec);
      alreadyExpired.add(e.url);
      expired.push(rec);
    } else {
      live.push(e);
    }
  }
  if (live.length) events[marker] = live; else delete events[marker];
}

// ---- report ---------------------------------------------------------
const totalPromoted = promotedByCorr.length + promotedByGdelt.length;
const rule = '='.repeat(66);
console.log(`\n${rule}\nCONFIDENCE LADDER — report (nothing written yet)\n${rule}`);
console.log(`events considered : ${all.length}`);
console.log(`self-corroboration entries stripped (own-channel repost) : ${selfCorrStripped}`);
console.log(`promoted to 'corroborated' : ${totalPromoted}  (${promotedByCorr.length} by a second source, ${promotedByGdelt.length} by GDELT)`);
console.log(`expired (>${EVENT_EXPIRY_DAYS}d, still 'reported') : ${expired.length}`);
if (USE_GDELT) console.log(`GDELT queries : ${gdeltQueries}${gdeltErrors ? `  (${gdeltErrors} failed)` : ''}`);
else console.log(`GDELT : skipped (LADDER_NO_GDELT)`);

const statusNow = {};
for (const { e } of all) statusNow[e.status] = (statusNow[e.status] || 0) + 1;
console.log('status distribution now :', statusNow);

const sample = (arr, label, fmt) => {
  console.log(`\n${'-'.repeat(66)}\n${label} — ${Math.min(10, arr.length)} of ${arr.length}\n${'-'.repeat(66)}`);
  for (const x of arr.slice(0, 10)) console.log(fmt(x));
};

sample(promotedByCorr, 'PROMOTED by a second independent source', ({ marker, e }) => {
  const ev = [...e.statusEvidence].reverse().find(x => x.kind === 'corroboration') || {};
  const srcs = (ev.sources || []).map(s => s.channel + (s.origins?.length ? ` (${s.origins.join('/')})` : '')).join(' + ');
  return `\n[${marker}] x${independentSourceCount(e)} independent\n  "${e.sentence}"\n  sources: ${srcs}`;
});

sample(promotedByGdelt, 'PROMOTED by an opposing or third-party source', ({ marker, e }) => {
  const g = [...e.statusEvidence].reverse().find(x => x.kind === 'gdelt');
  return `\n[${marker}] "${e.sentence}"\n  ${g.reason}\n  ${g.domain} (${g.side})`
       + `\n  "${g.title}"\n  ${g.url}\n  shared nouns: ${g.shared?.join(', ')}`;
});

sample(expired, 'EXPIRED', r => `\n[${r.marker}] posted ${String(r.at).slice(0, 10)}\n  "${r.sentence}"\n  ${r.url}`);

// still 'reported', not yet expired — the pool the next pass will re-check
const stillReported = all.filter(x => x.e.status === 'reported' && !isExpired(x.e));
sample(stillReported.map(x => ({ ...x.e, marker: x.marker })), "STILL 'reported' (age < 14d, no match yet)",
  e => `\n[${e.marker}] ${String(e.at).slice(0, 10)}  "${e.sentence}"`);

// ---- write ---------------------------------------------------------
doc.events[CONFLICT_ID] = events;
if (DRY) {
  console.log(`\n${rule}\nDRY RUN — nothing written. Re-run with --write to apply.\n${rule}`);
} else {
  if (expired.length || !existsSync(EXPIRED_PATH)) {
    await writeFile(EXPIRED_PATH, JSON.stringify(expiredDoc, null, 2) + '\n');
  }
  doc.generated = new Date().toISOString();
  await writeFile(OUTPUT_PATH, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\n${rule}\nwrote ${OUTPUT_PATH}  (+${expired.length} moved to ${EXPIRED_PATH})\n${rule}`);
}
