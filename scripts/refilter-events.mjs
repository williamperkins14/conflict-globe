// ---------------------------------------------------------------------------
// refilter-events.mjs
//
// The event filters (>=3 places, event word, metonymy) run on new matches as
// they come in, but events already sitting in auto-locations.json were written
// before the current rules existed. This re-runs every stored event's
// `sentence` through those same rules and drops the ones that now fail.
//
// It reuses telegram-detect.mjs's mergeMarkerEvents() for the filtering itself
// — there is no second copy of the logic here. The exported predicates are
// called only to label WHY each dropped event failed, for the report.
//
// Prints a full before/after report first, then writes auto-locations.json.
//
// Run:  node scripts/refilter-events.mjs
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import {
  loadGazetteer, mergeMarkerEvents, metonymyReject, placesNamed, EVENT_WORDS,
  OUTPUT_PATH, CONFLICT_ID,
} from './telegram-detect.mjs';

const gaz = loadGazetteer();
const doc = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
const stored = (doc.events && doc.events[CONFLICT_ID]) || {};

// Label a drop with the first rule it fails. Same rules mergeMarkerEvents uses.
const dropReason = (e, marker) => {
  if (!e.sentence) return 'no isolated sentence';
  if (!EVENT_WORDS.test(e.sentence)) return 'no event word in the sentence';
  if (placesNamed(e.sentence, gaz).size >= 3) return 'sentence names 3+ places';
  const met = metonymyReject(e.sentence, marker);
  if (!met.ok) return met.reason;
  return 'exact duplicate url';
};

let totalBefore = 0, totalAfter = 0;
const perLocation = [];
const dropped = [];
const kept = [];
const nextEvents = {};

for (const [marker, list] of Object.entries(stored)) {
  const merged = mergeMarkerEvents(list, [], gaz, marker);   // <- the actual filter
  const survives = new Set();
  for (const e of merged) {
    survives.add(e.url);
    for (const c of e.corroboration || []) survives.add(c.url);
  }
  totalBefore += list.length;
  totalAfter += merged.length;
  perLocation.push({ marker, before: list.length, after: merged.length });
  for (const e of list) {
    if (survives.has(e.url)) kept.push({ marker, sentence: e.sentence, len: (e.sentence || '').length });
    else dropped.push({ marker, reason: dropReason(e, marker), sentence: e.sentence, url: e.url });
  }
  if (merged.length) nextEvents[marker] = merged;
}

// ---- report -------------------------------------------------------------
const rule = '-'.repeat(64);
console.log(`\n${rule}\nREFILTER — report (nothing written yet)\n${rule}`);
console.log(`total events: ${totalBefore} -> ${totalAfter}  (${dropped.length} dropped)\n`);

console.log('per location (before -> after):');
for (const p of perLocation.sort((a, b) => b.before - a.before)) {
  const bar = p.before === p.after ? '' : `   -${p.before - p.after}`;
  console.log(`  ${p.marker.padEnd(14)} ${String(p.before).padStart(3)} -> ${String(p.after).padStart(3)}${bar}`);
}

const byReason = {};
for (const d of dropped) byReason[d.reason] = (byReason[d.reason] || 0) + 1;
console.log('\ndropped by reason:');
for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${r}`);

// 15 drops, spread across markers
console.log(`\n${rule}\n15 SAMPLE DROPS\n${rule}`);
const perMarkerSeen = {};
const sample = [];
for (const d of dropped) {
  perMarkerSeen[d.marker] = (perMarkerSeen[d.marker] || 0);
  if (perMarkerSeen[d.marker] < 2 && sample.length < 15) { sample.push(d); perMarkerSeen[d.marker]++; }
}
for (const d of dropped) { if (sample.length >= 15) break; if (!sample.includes(d)) sample.push(d); }
for (const d of sample.slice(0, 15)) {
  console.log(`\n[${d.marker}]  ${d.reason}`);
  console.log(`  "${d.sentence}"`);
  console.log(`  ${d.url}`);
}

// 5 keeps near the boundary — shortest kept sentences per distinct marker
console.log(`\n${rule}\n5 SAMPLE KEEPS (shortest, most borderline)\n${rule}`);
const seenKeepMarker = new Set();
const keepSample = kept
  .slice()
  .sort((a, b) => a.len - b.len)
  .filter(k => { if (seenKeepMarker.has(k.marker)) return false; seenKeepMarker.add(k.marker); return true; })
  .slice(0, 5);
for (const k of keepSample) console.log(`\n[${k.marker}]\n  "${k.sentence}"`);

// ---- write -------------------------------------------------------------
doc.events[CONFLICT_ID] = nextEvents;
doc.generated = new Date().toISOString();
await writeFile(OUTPUT_PATH, JSON.stringify(doc, null, 2) + '\n');
console.log(`\n${rule}\nwrote ${OUTPUT_PATH}: ${totalBefore} -> ${totalAfter} events\n${rule}`);
