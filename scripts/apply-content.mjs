// Generates conflicts.json content from the editable markdown files.
// WRITEUPS-*.md and KEY-EVENTS-*.md are the source of truth; this script
// writes them into the JSON the site reads. Edit the markdown, re-run this.
import fs from 'fs';

const CONFLICT_ID = 'ukraine';

function sections(md) {
  const out = {};
  let cur = null, buf = [];
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) out[cur] = buf;
      cur = line.slice(3).trim(); buf = [];
    } else if (cur) buf.push(line);
  }
  if (cur) out[cur] = buf;
  return out;
}

// ---- summaries ----------------------------------------------------------
const writeups = {};
for (const [name, lines] of Object.entries(
       sections(fs.readFileSync('WRITEUPS-UKRAINE.md', 'utf8')))) {
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (text) writeups[name] = text;
}

// ---- key events ---------------------------------------------------------
// A line is an event only if it starts with a date. Everything else in the
// file is a note to ourselves and must never reach the site.
const DATED = /^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/;
const keyEvents = {};
for (const [name, lines] of Object.entries(
       sections(fs.readFileSync('KEY-EVENTS-UKRAINE.md', 'utf8')))) {
  const evs = [];
  for (const line of lines) {
    const m = line.trim().match(DATED);
    if (!m) continue;
    let text = m[2].trim(), note = null;
    // [CONTESTED ...] / [DECIDE ...] notes are kept as data, not shown.
    const b = text.match(/\s*\[(CONTESTED|DECIDE|note)([^\]]*)\]\s*$/i);
    if (b) { note = (b[1] + b[2]).trim(); text = text.slice(0, b.index).trim(); }
    evs.push(note ? { date: m[1], text, note } : { date: m[1], text });
  }
  if (evs.length) keyEvents[name] = evs.sort((a, b) => a.date.localeCompare(b.date));
}

// ---- apply --------------------------------------------------------------
const data = JSON.parse(fs.readFileSync('conflicts.json', 'utf8'));
const conflicts = data.conflicts || data;
const conflict = conflicts.find(c => c.id === CONFLICT_ID);
if (!conflict) throw new Error('conflict not found: ' + CONFLICT_ID);

// Nord Stream is a curated-only marker: it sits in the Baltic, outside the
// bounding box the Telegram matcher searches, so it will never pick up
// auto-detected events. That is correct for this one.
if (!conflict.locations.some(l => l.name === 'Nord Stream')) {
  conflict.locations.push({
    name: 'Nord Stream',
    // Representative point between the four leak sites near Bornholm.
    lat: 55.32, lng: 15.55,
    intensity: 0.7,
    query: '(Nord Stream)',
    match: ['Nord Stream', 'Nordstream', 'Nord Stream 1', 'Nord Stream 2'],
    summary: '', sources: []
  });
  console.log('added location: Nord Stream');
}

const conflictKey = 'CONFLICT: Russia-Ukraine war';
if (writeups[conflictKey]) conflict.summary = writeups[conflictKey];

let s = 0, k = 0;
for (const loc of conflict.locations) {
  if (writeups[loc.name]) { loc.summary = writeups[loc.name]; s++; }
  if (keyEvents[loc.name]) { loc.keyEvents = keyEvents[loc.name]; k++; }
}

fs.writeFileSync('conflicts.json', JSON.stringify(data, null, 2) + '\n');
console.log(`summaries applied: ${s}`);
console.log(`key events applied to ${k} locations, ` +
            Object.values(keyEvents).reduce((n, v) => n + v.length, 0) + ' events total');
const unmatched = Object.keys(keyEvents)
  .filter(n => !conflict.locations.some(l => l.name === n));
if (unmatched.length) console.log('UNMATCHED headings:', unmatched.join(', '));
