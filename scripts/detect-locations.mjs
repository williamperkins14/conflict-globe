// ---------------------------------------------------------------------------
// detect-locations.mjs
//
// Runs in GitHub Actions on a schedule. For each conflict in conflicts.json it
// asks GDELT's GEO 2.0 API which places recent news about that conflict has
// been mentioning, filters the noise out, and merges the survivors into
// auto-locations.json. That file is a SEPARATE layer the site draws in amber;
// it never touches conflicts.json, which is hand-written.
//
// GDELT geocodes MENTIONS, not events. A point here means "several articles
// about this conflict named this place", nothing stronger.
//
// No dependencies. Node 20+ (uses the built-in fetch).
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';

const CONFLICTS_PATH = 'conflicts.json';
const OUTPUT_PATH = 'auto-locations.json';

const GEO_ENDPOINT = 'https://api.gdeltproject.org/api/v2/geo/geo';
const REQUEST_TIMEOUT_MS = 20_000;   // GDELT hangs under load; give up and move on
const GAP_BETWEEN_CONFLICTS_MS = 5_000;
const ATTEMPTS_PER_CONFLICT = 2;
const RETRY_PAUSE_MS = 8_000;

const MIN_ARTICLES = 3;              // one mention is noise
const MAX_PER_CONFLICT = 25;
const DEDUPE_KM = 25;                // closer than this to a curated point = same place
const EXPIRY_DAYS = 14;              // show the current war, not everything that ever happened

const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);

// GEO 2.0's exact property names were unverified when this was written. The
// first response that actually comes back gets dumped to the log, once, so
// they can be checked against reality.
let sampleLogged = false;

// ---------------------------------------------------------------------------
// Geometry
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
  if (!Array.isArray(box) || box.length !== 4) return true; // no box defined -> don't filter
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
// GDELT
// ---------------------------------------------------------------------------

function geoUrl(query) {
  const p = new URLSearchParams({
    query,
    mode: 'PointData',
    format: 'GeoJSON',
    timespan: '3d',
    maxpoints: '100',
  });
  return `${GEO_ENDPOINT}?${p.toString()}`;
}

async function fetchGeoRaw(query) {
  // Testing hook: point GEO_FIXTURE at a local file to run the whole pipeline
  // against a saved response without touching the network.
  if (process.env.GEO_FIXTURE) {
    return { status: 200, text: await readFile(process.env.GEO_FIXTURE, 'utf8') };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(geoUrl(query), {
      signal: controller.signal,
      headers: { 'User-Agent': 'conflict-globe auto-locations (github actions)' },
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// Pull the fields we need out of one GeoJSON feature. GEO 2.0's exact property
// names were unverified when this was written, so this tries several and the
// first run logs a real sample (see main()).
function readFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const p = feature.properties || {};
  const name =
    p.name ?? p.location ?? p.placename ?? p.place ?? p.NAME ?? p.title ?? null;
  const count = Number(
    p.count ?? p.Count ?? p.numarticles ?? p.numarts ?? p.articles ?? p.value ?? p.weight ?? 0
  );

  if (name == null || !Number.isFinite(count)) return null;
  return { name: String(name).trim(), lat, lng, count };
}

// ---------------------------------------------------------------------------
// Per-conflict processing
// ---------------------------------------------------------------------------

async function processConflict(conflict, existingForId) {
  const id = conflict.id;
  const curated = Array.isArray(conflict.locations) ? conflict.locations : [];
  const box = conflict.bbox;

  const stats = {
    returned: 0, afterBbox: 0, afterCount: 0, afterDedupe: 0, kept: 0,
    added: 0, updated: 0, expired: 0,
  };

  // --- fetch, with one retry ---
  let raw = null;
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CONFLICT; attempt++) {
    try {
      raw = await fetchGeoRaw(conflict.query);
      break;
    } catch (err) {
      const cause = err && err.cause ? ` (cause: ${err.cause.code || err.cause.message || err.cause})` : '';
      console.error(`  [${id}] attempt ${attempt} failed: ${err.name}: ${err.message}${cause}`);
      if (attempt < ATTEMPTS_PER_CONFLICT) await sleep(RETRY_PAUSE_MS);
    }
  }
  if (!raw) {
    console.error(`  [${id}] gave up after ${ATTEMPTS_PER_CONFLICT} attempts, keeping existing points`);
    return { points: existingForId, stats, failed: true };
  }

  const firstResponse = !sampleLogged;
  if (firstResponse) {
    sampleLogged = true;
    console.log(`\n--- RAW GEO 2.0 RESPONSE for [${id}] (${geoUrl(conflict.query)}) ---`);
    console.log(`HTTP ${raw.status}`);
    console.log(raw.text.slice(0, 4000));
    console.log('--- end raw sample ---\n');
  }

  // GDELT returns errors as plain text with HTTP 200, so a parse failure is a
  // real possibility, not an exception.
  let geo;
  try {
    geo = JSON.parse(raw.text);
  } catch {
    console.error(`  [${id}] response was not JSON: ${raw.text.slice(0, 200)}`);
    return { points: existingForId, stats, failed: true };
  }

  const features = Array.isArray(geo.features) ? geo.features : [];
  stats.returned = features.length;

  if (firstResponse && features[0]) {
    console.log(`  [${id}] first feature: ${JSON.stringify(features[0])}`);
  }

  // --- filter ---
  let points = features.map(readFeature).filter(Boolean);

  points = points.filter(pt => insideBox(pt.lat, pt.lng, box));
  stats.afterBbox = points.length;

  points = points.filter(pt => pt.count >= MIN_ARTICLES);
  stats.afterCount = points.length;

  points = points.filter(pt => {
    const n = normaliseName(pt.name);
    return !curated.some(c =>
      normaliseName(c.name) === n ||
      haversineKm(pt.lat, pt.lng, c.lat, c.lng) < DEDUPE_KM
    );
  });

  // collapse auto points that are the same place as each other, keep the busier
  points.sort((a, b) => b.count - a.count);
  const merged = [];
  for (const pt of points) {
    const n = normaliseName(pt.name);
    const dup = merged.find(m =>
      normaliseName(m.name) === n || haversineKm(pt.lat, pt.lng, m.lat, m.lng) < DEDUPE_KM
    );
    if (!dup) merged.push(pt);
  }
  points = merged;
  stats.afterDedupe = points.length;

  points = points.slice(0, MAX_PER_CONFLICT);
  stats.kept = points.length;

  // --- merge into what we already had ---
  const today = todayISO();
  const out = existingForId.map(e => ({ ...e }));

  for (const pt of points) {
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

  // --- expire the stale ---
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - EXPIRY_DAYS);
  const kept = out.filter(e => {
    const seen = new Date(e.lastSeen + 'T00:00:00Z');
    const alive = seen >= cutoff;
    if (!alive) stats.expired++;
    return alive;
  });

  kept.sort((a, b) => b.count - a.count);
  return { points: kept, stats, failed: false };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const conflicts = JSON.parse(await readFile(CONFLICTS_PATH, 'utf8'));

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

  const nextConflicts = {};
  const totals = { added: 0, updated: 0, expired: 0, failed: 0 };

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i];
    if (!conflict.id) {
      console.error(`conflict at index ${i} has no id, skipping`);
      continue;
    }
    const existingForId = Array.isArray(previous.conflicts[conflict.id])
      ? previous.conflicts[conflict.id]
      : [];

    console.log(`\n[${conflict.id}] query: ${conflict.query}`);
    let result;
    try {
      result = await processConflict(conflict, existingForId);
    } catch (err) {
      console.error(`  [${conflict.id}] unexpected error, keeping existing: ${err.stack || err}`);
      result = { points: existingForId, stats: null, failed: true };
    }

    nextConflicts[conflict.id] = result.points;

    if (result.failed) totals.failed++;
    if (result.stats) {
      const s = result.stats;
      console.log(
        `  returned ${s.returned}` +
        ` -> in bbox ${s.afterBbox}` +
        ` -> >=${MIN_ARTICLES} articles ${s.afterCount}` +
        ` -> not already curated/dup ${s.afterDedupe}` +
        ` -> kept ${s.kept}`
      );
      console.log(`  merge: +${s.added} new, ${s.updated} updated, ${s.expired} expired`);
      totals.added += s.added;
      totals.updated += s.updated;
      totals.expired += s.expired;
    }

    if (i < conflicts.length - 1) await sleep(GAP_BETWEEN_CONFLICTS_MS);
  }

  // --- decide whether anything actually changed ---
  const oldBody = JSON.stringify(previous.conflicts || {});
  const newBody = JSON.stringify(nextConflicts);
  const bodyChanged = oldBody !== newBody;

  const processed = Object.keys(nextConflicts).length;
  const allFailed = processed > 0 && totals.failed >= processed;
  const hasContent = Object.values(nextConflicts).some(a => a.length > 0);

  // Don't create or commit a file off the back of a run where every fetch
  // failed - that is a network problem, not a real "no locations" result.
  const write = bodyChanged && !allFailed && (hasContent || !firstRun);

  const summary =
    `+${totals.added} new, ${totals.expired} expired` +
    (totals.updated ? `, ${totals.updated} updated` : '') +
    (totals.failed ? `, ${totals.failed} conflict(s) failed` : '');

  console.log(`\n==============================`);
  console.log(`${write ? 'WRITE' : 'NO WRITE'}: ${summary}`);
  if (allFailed) console.log('Every conflict failed to fetch - leaving auto-locations.json untouched.');
  console.log(`==============================`);

  if (write) {
    const doc = {
      generated: new Date().toISOString(),
      conflicts: nextConflicts,
    };
    await writeFile(OUTPUT_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${OUTPUT_PATH}`);
  } else {
    console.log(`${OUTPUT_PATH} left untouched`);
  }

  // hand the workflow what it needs for the commit step
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${write}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
  }

  // One conflict failing is expected (GDELT is flaky). Every conflict failing
  // is a real problem and the run should go red so someone looks.
  process.exit(allFailed ? 1 : 0);
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
