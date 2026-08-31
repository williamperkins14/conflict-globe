// ---------------------------------------------------------------------------
// Regression check for detect-locations.mjs.  Run:  node scripts/detect-locations.test.mjs
//
// Guards the layer-wipe bug: detect-locations.mjs rebuilt auto-locations.json
// from just the two keys it owns (`generated`, `conflicts`), which dropped the
// `events` key the Telegram detector writes. On 30 Aug 2026 that silently
// wiped all 130 restored events.
//
// The detector reads conflicts.json / auto-locations.json from its working
// directory, so we run it as a subprocess in a throwaway dir with fixtures and
// a GKG_FIXTURE that skips the network.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const DETECTOR = resolve(fileURLToPath(new URL('./detect-locations.mjs', import.meta.url)));

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
};

// A Telegram-layer payload that detect-locations.mjs has no business touching.
const EVENTS = {
  ukraine: {
    Belgorod: [
      { channel: 'noel_reports', url: 'https://t.me/noel_reports/1', at: '2026-08-29T10:00:00Z',
        sentence: 'A depot was hit in Belgorod.', status: 'reported' },
    ],
  },
};

const dir = await mkdtemp(join(tmpdir(), 'detect-loc-test-'));
try {
  // A conflict id that is NOT in the existing file, so the detector is
  // guaranteed to write (its `conflicts` body changes).
  await writeFile(join(dir, 'conflicts.json'), JSON.stringify([
    { id: 'ukraine', bbox: [44, 56, 22, 46], name: 'Ukraine', lat: 49, lng: 32, locations: [] },
    { id: 'testconf', bbox: [0, 1, 0, 1], name: 'Test', lat: 0.5, lng: 0.5, locations: [] },
  ]));

  await writeFile(join(dir, 'auto-locations.json'), JSON.stringify({
    generated: '2026-08-30T00:00:00.000Z',
    conflicts: { ukraine: [] },
    events: EVENTS,
  }, null, 2) + '\n');

  // A GKG csv the parser can read but that yields no usable rows: enough to
  // let the run reach the write step without any network.
  await writeFile(join(dir, 'gkg-fixture.csv'), 'no-usable-rows-here\n');

  const { stdout } = await execFileP('node', [DETECTOR], {
    cwd: dir,
    env: { ...process.env, GKG_FIXTURE: join(dir, 'gkg-fixture.csv') },
  });
  check(/Wrote auto-locations\.json/.test(stdout), 'the detector wrote the file (otherwise the test proves nothing)');

  const after = JSON.parse(await readFile(join(dir, 'auto-locations.json'), 'utf8'));
  check('events' in after, 'the `events` key still exists after a detector run');
  check(JSON.stringify(after.events) === JSON.stringify(EVENTS), 'the `events` payload is byte-for-byte unchanged');
  check(Array.isArray(after.conflicts.testconf), 'the detector still wrote its own `conflicts` key');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
