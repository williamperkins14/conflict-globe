// Generates conflicts.json content from the editable markdown files.
//
// The markdown is the source of truth: prose is edited as prose, and nobody
// hand-edits JSON (which is how a trailing comma took the site down in the
// first week). Run this after changing any WRITEUPS-*.md or KEY-EVENTS-*.md.
//
//   node scripts/apply-content.mjs
import fs from 'fs';

const SOURCES = [
  { id: 'ukraine', writeups: 'WRITEUPS-UKRAINE.md', keyEvents: 'KEY-EVENTS-UKRAINE.md',
    conflictHeading: 'CONFLICT: Russia-Ukraine war' },
  { id: 'sudan', writeups: 'WRITEUPS-SUDAN.md', keyEvents: 'KEY-EVENTS-SUDAN.md',
    conflictHeading: 'CONFLICT: Sudan civil war' },
];

// Curated-only markers that have no entry in conflicts.json yet. Nord Stream
// sits in the Baltic, outside the bounding box the Telegram matcher searches,
// so it will never pick up auto-detected events. For this one that is correct.
const EXTRA_LOCATIONS = {
  ukraine: [{
    name: 'Nord Stream', lat: 55.32, lng: 15.55, intensity: 0.7,
    query: '(Nord Stream)',
    match: ['Nord Stream', 'Nordstream', 'Nord Stream 1', 'Nord Stream 2'],
    summary: '', sources: [],
  }],
};

// Split a markdown file into { "## heading": [lines] }.
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

function readWriteups(path) {
  const out = {};
  for (const [name, lines] of Object.entries(sections(fs.readFileSync(path, 'utf8')))) {
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (text) out[name] = text;
  }
  return out;
}

// A line is an event ONLY if it starts with a date. Everything else in those
// files — the criterion, the editorial notes, the warnings about death tolls —
// is written for us and must never reach the site.
const DATED = /^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/;

function readKeyEvents(path) {
  const out = {};
  for (const [name, lines] of Object.entries(sections(fs.readFileSync(path, 'utf8')))) {
    const evs = [];
    for (const line of lines) {
      const m = line.trim().match(DATED);
      if (!m) continue;
      let text = m[2].trim(), note = null, source = null;

      // ` | src: <url>` at the very end is the citation. Stripped first so it
      // can coexist with a trailing [CONTESTED ...] note.
      const sm = text.match(/\s*\|\s*src:\s*(\S+)\s*$/);
      if (sm) { source = sm[1]; text = text.slice(0, sm.index).trim(); }

      const b = text.match(/\s*\[(CONTESTED|DECIDE|note)([^\]]*)\]\s*$/i);
      if (b) { note = (b[1] + b[2]).trim(); text = text.slice(0, b.index).trim(); }

      const ev = { date: m[1], text };
      if (note) ev.note = note;
      if (source) ev.source = source;
      evs.push(ev);
    }
    if (evs.length) out[name] = evs.sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

const data = JSON.parse(fs.readFileSync('conflicts.json', 'utf8'));
const conflicts = data.conflicts || data;
let totalEvents = 0, totalCited = 0;

for (const SRC of SOURCES) {
  if (!fs.existsSync(SRC.writeups) || !fs.existsSync(SRC.keyEvents)) {
    console.log(`${SRC.id.padEnd(9)} markdown missing — skipped`);
    continue;
  }
  const conflict = conflicts.find(c => c.id === SRC.id);
  if (!conflict) { console.log(`${SRC.id.padEnd(9)} not in conflicts.json — skipped`); continue; }

  for (const extra of EXTRA_LOCATIONS[SRC.id] || []) {
    if (!conflict.locations.some(l => l.name === extra.name)) {
      conflict.locations.push(extra);
      console.log(`${SRC.id.padEnd(9)} added location: ${extra.name}`);
    }
  }

  const writeups = readWriteups(SRC.writeups);
  const keyEvents = readKeyEvents(SRC.keyEvents);
  if (writeups[SRC.conflictHeading]) conflict.summary = writeups[SRC.conflictHeading];

  let s = 0, k = 0, ev = 0, cited = 0;
  for (const loc of conflict.locations) {
    if (writeups[loc.name]) { loc.summary = writeups[loc.name]; s++; }
    if (keyEvents[loc.name]) {
      loc.keyEvents = keyEvents[loc.name];
      k++; ev += loc.keyEvents.length;
      cited += loc.keyEvents.filter(e => e.source).length;
    }
  }
  totalEvents += ev; totalCited += cited;
  console.log(`${SRC.id.padEnd(9)} summaries ${s}  ·  ${ev} key events on ${k} locations  ·  ${cited}/${ev} cited`);

  const unmatched = Object.keys(keyEvents).filter(n => !conflict.locations.some(l => l.name === n));
  if (unmatched.length) console.log(`${' '.repeat(9)} UNMATCHED headings: ${unmatched.join(', ')}`);
}

fs.writeFileSync('conflicts.json', JSON.stringify(data, null, 2) + '\n');
console.log(`\ntotal: ${totalEvents} key events, ${totalCited} cited (${totalEvents - totalCited} without a source)`);
