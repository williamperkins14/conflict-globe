// ---------------------------------------------------------------------------
// reparse-events.mjs
//
// Events already in auto-locations.json were parsed by whatever version of
// parseSentence existed when they arrived. When the parser improves, the
// stored events do not: they keep whatever it managed at the time. Nothing is
// re-scraped here — every event already carries the sentence it was built
// from, so the parser can simply be run over it again.
//
// This is the same idea as refilter-events.mjs, and it imports the real
// parseSentence rather than keeping a second copy of the rules.
//
// Prints a before/after report, and only writes with --write.
//
//   node scripts/reparse-events.mjs           (dry run)
//   node scripts/reparse-events.mjs --write
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { parseSentence, placesNamed, loadGazetteer, OUTPUT_PATH } from './telegram-detect.mjs';

const write = process.argv.includes('--write');
const gaz = loadGazetteer();
const doc = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));

let total = 0, changed = 0, gained = 0, lost = 0;
const examples = [];
const field = p => (p ? ['weapon', 'target', 'targetType', 'casualties'].filter(k => p[k]).length : 0);

for (const places of Object.values(doc.events || {})) {
  for (const items of Object.values(places)) {
    for (const e of items) {
      total++;
      const before = e.parsed || null;
      const places2 = placesNamed(e.sentence || '', gaz);
      const after = parseSentence(e.sentence || '', places2);
      const b = field(before), a = field(after);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changed++;
        if (a > b) gained++; else if (a < b) lost++;
        if (examples.length < 12 && (before?.casualties || null) !== (after?.casualties || null)) {
          examples.push({
            sentence: (e.sentence || '').slice(0, 110),
            was: before?.casualties ?? null,
            now: after?.casualties ?? null,
          });
        }
        e.parsed = after;
      }
    }
  }
}

const withCas = () => {
  let n = 0;
  for (const places of Object.values(doc.events || {}))
    for (const items of Object.values(places))
      for (const e of items) if (e.parsed?.casualties) n++;
  return n;
};

console.log(`events           : ${total}`);
console.log(`re-parsed changed: ${changed}  (${gained} gained a field, ${lost} lost one)`);
console.log(`with casualties  : ${withCas()}`);
console.log('\ncasualty changes (sample):');
for (const x of examples) console.log(`  ${x.was ?? '-'}  ->  ${x.now ?? '-'}   ${x.sentence}`);

if (write) {
  await writeFile(OUTPUT_PATH, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\nwritten to ${OUTPUT_PATH}`);
} else {
  console.log('\ndry run. re-run with --write to save.');
}
