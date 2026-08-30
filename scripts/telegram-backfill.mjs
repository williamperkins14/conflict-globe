// ---------------------------------------------------------------------------
// telegram-backfill.mjs
//
// One-off historical backfill of the `events` layer in auto-locations.json.
//
// Walks each trusted channel backwards through
//   https://t.me/s/<channel>?before=<id>
// running every post through the SAME matcher (matchPost) and sentence parser
// (parseSentence, via mergeMarkerEvents) that telegram-detect.mjs uses, and
// stops once a page reaches back 90 days.
//
// Resumable. State lives in scripts/backfill-state.json and is written after
// every page; auto-locations.json is appended to after every page that yields
// events, never only at the end. A channel that already has state is resumed
// from its lowest id, never restarted; a channel marked done or paused is
// skipped.
//
// Run:  node scripts/telegram-backfill.mjs
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import {
  loadGazetteer, parseChannel, matchPost,
  buildEventEntry, mergeMarkerEvents,
  placesNamed, EVENT_WORDS,
  CHANNELS, CONFLICT_ID, CONFLICTS_PATH, OUTPUT_PATH,
} from './telegram-detect.mjs';

const STATE_PATH     = 'scripts/backfill-state.json';
const MAX_AGE_DAYS   = 90;
const REQUEST_GAP_MS = 1_500;                       // between every request
const BACKOFF_MS     = [3_000, 6_000, 12_000, 24_000]; // waits between the 5 attempts
const MAX_ATTEMPTS   = 5;                           // 5 consecutive failures -> pause the channel
const PAGE_SAFETY_CAP = Number(process.env.BACKFILL_MAX_PAGES) || 600; // ~4x the pages 90 days should need

const sleep = ms => new Promise(r => setTimeout(r, ms));
const minDate = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

const fetchTimeout = (url, ms = 25_000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 conflict-globe' } })
    .finally(() => clearTimeout(t));
};

// One page fetch. Up to MAX_ATTEMPTS tries; on 429/5xx or a network error it
// backs off 3s, 6s, 12s, 24s and retries. A non-retriable HTTP status ends the
// channel cleanly; exhausting the retries pauses it.
async function fetchPage(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchTimeout(url);
      if (res.ok) return { html: await res.text() };
      if (res.status !== 429 && res.status < 500) {
        console.log(`  ${url} -> HTTP ${res.status} (not retriable), ending channel`);
        return { error: 'gone' };
      }
      console.log(`  ${url} -> HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.log(`  ${url} -> ${err.message} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
  }
  return { error: 'paused' };
}

const loadDoc = async () => {
  try {
    const d = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
    d.conflicts ||= {};
    return d;
  } catch {
    return { generated: null, conflicts: {} };
  }
};
const writeDoc   = d => writeFile(OUTPUT_PATH, JSON.stringify(d, null, 2) + '\n');
const writeState = s => writeFile(STATE_PATH, JSON.stringify(s, null, 2) + '\n');

async function main() {
  const conflicts = JSON.parse(await readFile(CONFLICTS_PATH, 'utf8'));
  const conflict = conflicts.find(c => c.id === CONFLICT_ID);
  if (!conflict) throw new Error(`no conflict "${CONFLICT_ID}" in ${CONFLICTS_PATH}`);
  const bbox = conflict.bbox;
  const curated = Array.isArray(conflict.locations) ? conflict.locations : [];

  const gaz = loadGazetteer();
  const passesEventGate = s => EVENT_WORDS.test(s.sentence) && placesNamed(s.sentence, gaz).size < 3;

  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
  const cutoffMs = Date.now() - MAX_AGE_DAYS * 86_400_000;

  for (const ch of CHANNELS) {
    const st = state[ch];
    if (st?.done) {
      console.log(`[${ch}] already complete — ${st.postsProcessed} posts back to ${st.oldestDate}, skipping`);
      continue;
    }
    if (st?.paused) {
      console.log(`[${ch}] paused after repeated failures — delete its entry in ${STATE_PATH} to retry`);
      continue;
    }
    await backfillChannel(ch, st);
  }

  // --- report -------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}\nBACKFILL REPORT\n${'='.repeat(60)}`);
  for (const ch of CHANNELS) {
    const s = state[ch] || {};
    const flag = s.paused ? '  [PAUSED]' : s.done ? '' : '  [incomplete]';
    console.log(`${ch}: ${s.postsProcessed || 0} posts processed, oldest ${s.oldestDate || '-'}, ${s.eventsFound || 0} events found${flag}`);
  }
  const doc = await loadDoc();
  const ev = (doc.events && doc.events[CONFLICT_ID]) || {};
  console.log('\nper-location event counts:');
  for (const [m, list] of Object.entries(ev).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${m}: ${list.length}`);
  }

  // --- the resumable channel walk ---------------------------------------
  async function backfillChannel(ch, st) {
    let before          = st?.lowestIdSeen ?? null;   // null -> start from the newest page
    let postsProcessed  = st?.postsProcessed ?? 0;
    let eventsFound     = st?.eventsFound ?? 0;
    let oldestDate      = st?.oldestDate ?? null;
    let reachedEnd      = false;   // hit the 90-day boundary or the channel start
    console.log(`\n[${ch}] ${before == null ? 'starting from newest' : `resuming from id ${before}`}`);

    for (let page = 0; page < PAGE_SAFETY_CAP; page++) {
      const url = before == null
        ? `https://t.me/s/${ch}`
        : `https://t.me/s/${ch}?before=${before}`;
      await sleep(REQUEST_GAP_MS);

      const r = await fetchPage(url);
      if (r.error === 'paused') {
        state[ch] = { lowestIdSeen: before ?? 0, postsProcessed, oldestDate, done: false, paused: true, eventsFound };
        await writeState(state);
        console.log(`[${ch}] PAUSED after ${MAX_ATTEMPTS} failed attempts`);
        return;
      }
      if (r.error === 'gone') { reachedEnd = true; break; }

      const posts = parseChannel(r.html, ch);
      const ids = posts.map(p => p.num).filter(Number.isFinite);
      if (!ids.length) { console.log(`[${ch}] page with no parseable posts — reached the start`); reachedEnd = true; break; }

      const minId = Math.min(...ids);
      if (before != null && minId >= before) { console.log(`[${ch}] no older posts returned — done`); reachedEnd = true; break; }

      let reachedCutoff = false;
      const pageEvents = {};   // curated marker -> [event entry]
      for (const post of posts) {
        if (before != null && post.num >= before) continue;   // handled on an earlier page
        const t = post.at ? Date.parse(post.at) : NaN;
        if (Number.isFinite(t) && t < cutoffMs) { reachedCutoff = true; continue; }

        postsProcessed++;
        if (post.at) oldestDate = minDate(oldestDate, post.at.slice(0, 10));

        const { suppressed } = matchPost(post, gaz, bbox, curated);
        for (const s of suppressed) {
          if (!passesEventGate(s)) continue;
          (pageEvents[s.curated] ||= []).push(buildEventEntry(s, post));
          eventsFound++;
        }
      }

      // incremental append — merge this page's events into the file now
      if (Object.keys(pageEvents).length) {
        const doc = await loadDoc();
        doc.events ||= {};
        doc.events[CONFLICT_ID] ||= {};
        for (const [marker, entries] of Object.entries(pageEvents)) {
          doc.events[CONFLICT_ID][marker] =
            mergeMarkerEvents(doc.events[CONFLICT_ID][marker], entries, gaz);
        }
        doc.generated = new Date().toISOString();
        await writeDoc(doc);
      }

      before = minId;
      state[ch] = { lowestIdSeen: before, postsProcessed, oldestDate, done: false, eventsFound };
      await writeState(state);
      console.log(`[${ch}] page ${page + 1}: id<=${before}, ${postsProcessed} posts, oldest ${oldestDate}, ${eventsFound} events`);

      if (reachedCutoff) { console.log(`[${ch}] reached the ${MAX_AGE_DAYS}-day boundary`); reachedEnd = true; break; }
      if (minId <= 1) { reachedEnd = true; break; }
    }

    state[ch] = { lowestIdSeen: before ?? 0, postsProcessed, oldestDate, done: reachedEnd, eventsFound };
    await writeState(state);
    console.log(`[${ch}] ${reachedEnd ? 'done' : 'stopped at page-safety cap (incomplete — rerun to continue)'} — ${postsProcessed} posts back to ${oldestDate}, ${eventsFound} events found`);
  }
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
