// Re-run dedupe over the events already stored, under the current rules.
//
// mergeMarkerEvents only runs when the detector or backfill writes, so a change
// to the matching rule has no effect on events already on disk. This applies it
// retroactively. Dry by default; --write to save.
//
//   node scripts/redupe-events.mjs
//   node scripts/redupe-events.mjs --write
import { readFile, writeFile } from 'node:fs/promises';
import { dedupeEvents, applyCorroboration, sideOfChannel, OUTPUT_PATH, CONFLICT_ID }
  from './telegram-detect.mjs';

const WRITE = process.argv.includes('--write');
const doc = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
const events = (doc.events && doc.events[CONFLICT_ID]) || {};

let before = 0, after = 0, promoted = 0;
const newly = [];

for (const [marker, list] of Object.entries(events)) {
  before += list.length;
  const wasCorroborated = new Set(
    list.filter(e => e.status === 'corroborated').map(e => e.url));
  const merged = dedupeEvents(list).map(e => applyCorroboration(e));
  after += merged.length;
  for (const e of merged) {
    if (e.status === 'corroborated' && !wasCorroborated.has(e.url)) {
      promoted++;
      newly.push({ marker, e });
    }
  }
  events[marker] = merged;
}

const rule = '='.repeat(66);
console.log(`\n${rule}\nRE-DEDUPE${WRITE ? '' : '  (dry run)'}\n${rule}`);
console.log(`events before : ${before}`);
console.log(`events after  : ${after}   (${before - after} folded)`);
console.log(`newly corroborated : ${promoted}\n`);

for (const { marker, e } of newly) {
  const ev = (e.statusEvidence || []).filter(x => x.kind === 'corroboration').pop() || {};
  console.log(`[${marker}]  ${String(e.at).slice(0, 10)}`);
  console.log(`   ${e.sentence}`);
  console.log(`   ${ev.reason || ''}`);
  for (const s of ev.sources || []) console.log(`     - ${s.channel} (${s.side || sideOfChannel(s.channel)})`);
  console.log();
}

if (WRITE) {
  doc.events[CONFLICT_ID] = events;
  await writeFile(OUTPUT_PATH, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${rule}\nwrote ${OUTPUT_PATH}\n${rule}`);
} else {
  console.log(`${rule}\nDRY RUN — nothing written. Re-run with --write to apply.\n${rule}`);
}
