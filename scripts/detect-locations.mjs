// ---------------------------------------------------------------------------
// detect-locations.mjs
//
// Builds auto-locations.json: a SEPARATE, clearly-unverified layer of places
// that recent conflict news has been mentioning. conflicts.json is hand-written
// and never touched here.
//
// Fetching approach (spec v2, 28 Aug 2026): the GEO 2.0 API is dead (404 from
// every machine we tried). Instead we download GDELT's raw Global Knowledge
// Graph files from data.gdeltproject.org - a much faster, more reliable host -
// and extract the locations ourselves.
//
// A marker still means "several articles about this conflict named this place",
// nothing stronger. GKG locations are geocoded from article text, not events.
//
// No dependencies to install. Node 20+ (built-in fetch; shells out to `unzip`,
// which every ubuntu-latest runner has).
// ---------------------------------------------------------------------------

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');
const execFileP = promisify(execFile);

const CONFLICTS_PATH = 'conflicts.json';
const OUTPUT_PATH = 'auto-locations.json';

// Conflicts whose auto layer is handled elsewhere. Ukraine is served by the
// Telegram detector (scripts/telegram-detect.mjs) while that is being judged;
// the GKG layer for it is paused, not deleted. See TELEGRAM-SPEC.md.
const SKIP = new Set(['ukraine']);

const GKG_HOST = 'https://data.gdeltproject.org/gdeltv2';

// How many 15-minute GKG files to pull, stepping back from the latest.
// 12 = the last three hours. START AT 2 for the first manual run so it is quick.
const WINDOW_FILES = 2;

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_RETRIES = 1;
const RETRY_PAUSE_MS = 4_000;
const UNZIP_MAX_BUFFER = 1024 ** 3;   // a 15-min GKG csv can be tens of MB

const MIN_ARTICLES = 3;              // one mention is noise
const MAX_PER_CONFLICT = 25;
const DEDUPE_KM = 25;                // closer than this to a curated point = same place
const EXPIRY_DAYS = 14;              // show the current war, not everything that ever happened

// A row is "about conflict" if V2Themes carries one of these. The first run
// logs which ones actually matched so the list can be tuned.
const CONFLICT_THEMES = new Set([
  'ARMEDCONFLICT',
  'WB_2433_CONFLICT_AND_VIOLENCE',
  'MILITARY',
  'KILL',
  'WOUND',
  'SIEGE',
  'TERROR',
  'DISPLACEMENT',
]);

// GKG 2.1 column positions, zero-indexed. UNVERIFIED - the first run logs a
// full raw row and the field count so these can be checked. A wrong index here
// fails silently and produces an empty map; that has bitten this project twice.
const COL = {
  RECORD_ID: 0,
  DATE: 1,
  SOURCE: 3,        // SourceCommonName - the outlet domain
  DOC_ID: 4,        // DocumentIdentifier - the article URL
  THEMES: 8,        // V2Themes
  LOCATIONS: 10,    // V2Locations
  TONE: 15,         // V2Tone
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Geometry (unchanged from v1)
// ---------------------------------------------------------------------------

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// bbox is [minLat, maxLat, minLng, maxLng]
function insideBox(lat, lng, box) {
  if (!Array.isArray(box) || box.length !== 4) return true;
  const [minLat, maxLat, minLng, maxLng] = box;
  return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
}

function normaliseName(s) {
  return String(s || '')
    .toLowerCase()
    .split(',')[0]            // "Kyiv, Ukraine" -> "kyiv"
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// GDELT GKG files
// ---------------------------------------------------------------------------

function parseStamp(s) {
  return new Date(Date.UTC(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14),
  ));
}

function fmtStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
         `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// lastupdate.txt is three "size  md5  url" lines; the third is the GKG file.
async function getLatestStamp() {
  const res = await fetchWithTimeout(`${GKG_HOST}/lastupdate.txt`);
  const text = await res.text();
  if (!res.ok) throw new Error(`lastupdate.txt -> HTTP ${res.status}`);
  const line = text.trim().split('\n').find(l => l.includes('.gkg.csv.zip'));
  if (!line) throw new Error(`lastupdate.txt had no gkg line:\n${text}`);
  const url = line.trim().split(/\s+/)[2] || '';
  const m = url.match(/(\d{14})\.gkg\.csv\.zip/);
  if (!m) throw new Error(`could not read a timestamp from: ${url}`);
  console.log(`lastupdate.txt -> ${url}`);
  return parseStamp(m[1]);
}

// Download one 15-minute file and unzip it to text. Returns {stamp, text, bytes}
// on success; {stamp, status: 404} for a missing slot (normal); throws on a
// hard failure after retries.
async function fetchGkgFile(stamp) {
  const url = `${GKG_HOST}/${stamp}.gkg.csv.zip`;

  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 404) return { stamp, status: 404, bytes: 0 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = join(tmpdir(), `gkg-${stamp}-${process.pid}.zip`);
      await writeFile(tmp, buf);
      try {
        const { stdout } = await execFileP('unzip', ['-p', tmp], {
          maxBuffer: UNZIP_MAX_BUFFER,
          encoding: 'utf8',
        });
        return { stamp, status: 200, text: stdout, bytes: buf.length };
      } finally {
        await unlink(tmp).catch(() => {});
      }
    } catch (err) {
      const last = attempt === DOWNLOAD_RETRIES;
      console.error(`  ${stamp}: ${err.message}${last ? ' (giving up on this file)' : ', retrying'}`);
      if (!last) await sleep(RETRY_PAUSE_MS);
    }
  }
  return { stamp, status: 0, bytes: 0 };
}

async function downloadWindow() {
  // Testing hook: GKG_FIXTURE = path to an already-unzipped GKG csv. Skips the
  // network entirely so the parse + filter pipeline can be run locally.
  if (process.env.GKG_FIXTURE) {
    const text = await readFile(process.env.GKG_FIXTURE, 'utf8');
    console.log(`GKG_FIXTURE: ${process.env.GKG_FIXTURE} (${text.length} chars)`);
    return [{ stamp: 'fixture', status: 200, text, bytes: Buffer.byteLength(text) }];
  }

  const latest = await getLatestStamp();
  const files = [];
  for (let i = 0; i < WINDOW_FILES; i++) {
    const stamp = fmtStamp(new Date(latest.getTime() - i * 15 * 60_000));
    const f = await fetchGkgFile(stamp);
    const note = f.status === 200 ? `${(f.bytes / 1e6).toFixed(2)} MB` : `status ${f.status}`;
    console.log(`  ${stamp}.gkg.csv.zip -> ${note}`);
    files.push(f);
  }
  return files;
}

// V2Locations: entries separated by ";", fields within an entry by "#".
// Believed layout (UNVERIFIED - first run logs one):
//   0 type  1 fullname  2 countрyCode  3 ADM1  4 ADM2  5 lat  6 long  7 featureID  8 offset
function parseLocations(field, logOne) {
  if (!field) return [];
  const out = [];
  for (const entry of field.split(';')) {
    if (!entry) continue;
    const p = entry.split('#');
    if (logOne && !parseLocations._logged) {
      parseLocations._logged = true;
      console.log(`  sample V2Locations entry raw: ${entry}`);
      console.log(`  split on '#' -> ${JSON.stringify(p)}`);
    }
    const name = (p[1] || '').trim();
    const lat = Number(p[5]);
    const lng = Number(p[6]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    if (lat === 0 && lng === 0) continue;
    out.push({ name, lat, lng, featureId: (p[7] || '').trim() });
  }
  return out;
}

// Turn the downloaded files into a pool of rows that carry a conflict theme.
function buildRowPool(files) {
  let rawRowCount = 0;
  let firstRowLogged = false;
  let firstThemedLogged = false;
  const themeHits = new Map();
  const themedRows = [];

  for (const f of files) {
    if (!f.text) continue;
    for (const line of f.text.split('\n')) {
      if (!line) continue;
      rawRowCount++;
      const cols = line.split('\t');

      if (!firstRowLogged) {
        firstRowLogged = true;
        console.log(`\n--- RAW GKG ROW (${cols.length} tab-separated fields) ---`);
        console.log(line.length > 8000 ? line.slice(0, 8000) + ' …[truncated]' : line);
        console.log('--- end raw row ---');
      }

      const rowThemes = new Set(
        (cols[COL.THEMES] || '').split(';').map(e => e.split(',')[0]).filter(Boolean)
      );
      const matched = [...rowThemes].filter(t => CONFLICT_THEMES.has(t));
      if (!matched.length) continue;
      for (const t of matched) themeHits.set(t, (themeHits.get(t) || 0) + 1);

      const url = (cols[COL.DOC_ID] || '').trim();
      if (!url) continue;

      const locations = parseLocations(cols[COL.LOCATIONS] || '', !firstThemedLogged);
      if (!firstThemedLogged) {
        firstThemedLogged = true;
        console.log(`  first themed row: ${matched.join(', ')} | ${url}`);
        console.log(`  -> ${locations.length} usable locations`);
      }
      if (!locations.length) continue;

      themedRows.push({ url, domain: (cols[COL.SOURCE] || '').trim(), locations });
    }
  }

  return { rawRowCount, themedRows, themeHits };
}

// ---------------------------------------------------------------------------
// Per-conflict: filter the shared row pool down to this conflict's places
// (all filter logic and thresholds unchanged from v1)
// ---------------------------------------------------------------------------

function processConflict(conflict, existingForId, themedRows, globals) {
  const box = conflict.bbox;
  const curated = Array.isArray(conflict.locations) ? conflict.locations : [];
  const stats = { ...globals, inBbox: 0, afterCount: 0, afterDedupe: 0, kept: 0, added: 0, updated: 0, expired: 0 };

  // group location mentions inside this bbox by place; one article counts once
  const byPlace = new Map();
  for (const row of themedRows) {
    for (const loc of row.locations) {
      if (!insideBox(loc.lat, loc.lng, box)) continue;
      stats.inBbox++;
      const key = loc.featureId
        ? 'F:' + loc.featureId
        : 'N:' + normaliseName(loc.name) + '@' + loc.lat.toFixed(2) + ',' + loc.lng.toFixed(2);
      let rec = byPlace.get(key);
      if (!rec) {
        rec = { name: loc.name, lat: loc.lat, lng: loc.lng, urls: new Set() };
        byPlace.set(key, rec);
      }
      rec.urls.add(row.url);
    }
  }

  let places = [...byPlace.values()].map(r => ({
    name: r.name, lat: r.lat, lng: r.lng, count: r.urls.size,
  }));

  places = places.filter(p => p.count >= MIN_ARTICLES);
  stats.afterCount = places.length;

  places = places.filter(p => {
    const n = normaliseName(p.name);
    return !curated.some(c =>
      normaliseName(c.name) === n ||
      haversineKm(p.lat, p.lng, c.lat, c.lng) < DEDUPE_KM
    );
  });

  places.sort((a, b) => b.count - a.count);
  const deduped = [];
  for (const p of places) {
    const n = normaliseName(p.name);
    const dup = deduped.find(m =>
      normaliseName(m.name) === n || haversineKm(p.lat, p.lng, m.lat, m.lng) < DEDUPE_KM
    );
    if (!dup) deduped.push(p);
  }
  stats.afterDedupe = deduped.length;

  const winners = deduped.slice(0, MAX_PER_CONFLICT);
  stats.kept = winners.length;

  // --- merge into what we already had (unchanged) ---
  const today = todayISO();
  const out = existingForId.map(e => ({ ...e }));

  for (const pt of winners) {
    const n = normaliseName(pt.name);
    const hit = out.find(e =>
      normaliseName(e.name) === n || haversineKm(pt.lat, pt.lng, e.lat, e.lng) < DEDUPE_KM
    );
    if (hit) {
      hit.count = pt.count;
      hit.lastSeen = today;
      stats.updated++;
    } else {
      out.push({
        name: pt.name,
        lat: Number(pt.lat.toFixed(4)),
        lng: Number(pt.lng.toFixed(4)),
        count: pt.count,
        firstSeen: today,
        lastSeen: today,
      });
      stats.added++;
    }
  }

  // --- expire the stale (unchanged) ---
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - EXPIRY_DAYS);
  const kept = out.filter(e => {
    const alive = new Date(e.lastSeen + 'T00:00:00Z') >= cutoff;
    if (!alive) stats.expired++;
    return alive;
  });

  kept.sort((a, b) => b.count - a.count);
  return { points: kept, stats };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const conflicts = JSON.parse(await readFile(CONFLICTS_PATH, 'utf8'));

  // This script owns exactly two top-level keys: `generated` and `conflicts`.
  // Everything else in the file belongs to another writer — `events` is the
  // Telegram detector's layer (scripts/telegram-detect.mjs) — so read the whole
  // object and carry every key we do not own through untouched. Rebuilding the
  // file from just our two keys wiped all 130 Telegram events on 30 Aug 2026.
  const firstRun = !existsSync(OUTPUT_PATH);
  let previous = { generated: null, conflicts: {} };
  if (!firstRun) {
    try {
      previous = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
      if (!previous.conflicts) previous.conflicts = {};
    } catch {
      console.error(`${OUTPUT_PATH} exists but is unreadable; starting fresh`);
      previous = { generated: null, conflicts: {} };
    }
  }
  console.log(firstRun ? 'First run: no existing auto-locations.json' : 'Merging into existing auto-locations.json');
  console.log(`WINDOW_FILES = ${WINDOW_FILES}`);

  // --- download + parse ---
  let files;
  try {
    files = await downloadWindow();
  } catch (err) {
    console.error(`Could not begin: ${err.message}`);
    process.exit(1);
  }
  const usable = files.filter(f => f.text);
  const totalBytes = files.reduce((s, f) => s + (f.bytes || 0), 0);
  if (!usable.length) {
    console.error('No GKG files were downloaded. Leaving auto-locations.json untouched.');
    process.exit(1);
  }

  const { rawRowCount, themedRows, themeHits } = buildRowPool(usable);
  const totalLocs = themedRows.reduce((s, r) => s + r.locations.length, 0);

  console.log(`\nthemes matched: ` +
    ([...themeHits.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', ') || '(none)'));

  const globals = { rows: rawRowCount, themed: themedRows.length, locs: totalLocs };

  // --- per conflict ---
  const nextConflicts = {};
  const totals = { added: 0, updated: 0, expired: 0 };

  for (const conflict of conflicts) {
    if (!conflict.id) { console.error(`conflict with no id, skipping`); continue; }
    const existingForId = Array.isArray(previous.conflicts[conflict.id])
      ? previous.conflicts[conflict.id] : [];

    // Paused conflict: carry its existing entries through untouched so the
    // other detector's markers are not wiped, and move on.
    if (SKIP.has(conflict.id)) {
      nextConflicts[conflict.id] = existingForId;
      console.log(`\n[${conflict.id}] GKG layer paused - kept ${existingForId.length} existing entries`);
      continue;
    }

    const { points, stats } = processConflict(conflict, existingForId, themedRows, globals);
    nextConflicts[conflict.id] = points;
    totals.added += stats.added;
    totals.updated += stats.updated;
    totals.expired += stats.expired;

    console.log(
      `\n[${conflict.id}] rows ${stats.rows} -> conflict themes ${stats.themed}` +
      ` -> locations ${stats.locs} -> in bbox ${stats.inBbox}` +
      ` -> >=${MIN_ARTICLES} articles ${stats.afterCount}` +
      ` -> not curated/dup ${stats.afterDedupe} -> kept ${stats.kept}`
    );
    console.log(`  merge: +${stats.added} new, ${stats.updated} updated, ${stats.expired} expired`);
  }

  // --- change detection + write (unchanged from v1) ---
  const bodyChanged = JSON.stringify(previous.conflicts || {}) !== JSON.stringify(nextConflicts);
  const hasContent = Object.values(nextConflicts).some(a => a.length > 0);
  const write = bodyChanged && (hasContent || !firstRun);

  const summary =
    `+${totals.added} new, ${totals.expired} expired` +
    (totals.updated ? `, ${totals.updated} updated` : '');

  console.log(`\n==============================`);
  console.log(`${write ? 'WRITE' : 'NO WRITE'}: ${summary}`);
  console.log(`downloaded ${(totalBytes / 1e6).toFixed(1)} MB across ${usable.length}/${files.length} files` +
              `, elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`==============================`);

  if (write) {
    // Spread `previous` first so any key we do not own (e.g. the Telegram
    // detector's `events`) survives; then overwrite our own two keys.
    const merged = { ...previous, generated: new Date().toISOString(), conflicts: nextConflicts };
    await writeFile(OUTPUT_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${OUTPUT_PATH}`);
  } else {
    console.log(`${OUTPUT_PATH} left untouched`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${write}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
