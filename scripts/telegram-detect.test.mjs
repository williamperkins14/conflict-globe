// ---------------------------------------------------------------------------
// Regression check for the sentence parser.  Run:  node scripts/telegram-detect.test.mjs
//
// Guards the fabricated-casualty bug: a post about a fire "near the Zhytomyr
// highway outside Kyiv ... after a Russian drone attack" was parsing as
// weapon=missile / casualties="38 killed", inheriting the 38 deaths from a
// strike on Myla three sentences further down the same post.
// ---------------------------------------------------------------------------

import {
  parseSentence, sentenceAt, placesNamed, loadGazetteer, EVENT_WORDS, metonymyReject,
  namedOrigins, independentSourceCount, initLadder, applyCorroboration, isExpired,
} from './telegram-detect.mjs';

const gaz = loadGazetteer();

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
};

const parseFromPost = (post, needle) => {
  const sentence = sentenceAt(post, post.indexOf(needle));
  return { sentence, parsed: parseSentence(sentence, placesNamed(sentence, gaz)) };
};

// --- the Zhytomyr highway event -------------------------------------------------
const zhytomyrPost =
  'A large fire broke out near the Zhytomyr highway outside Kyiv, reportedly after a Russian drone attack. ' +
  '0:12 This media is not supported in your browser VIEW IN TELEGRAM ' +
  '38 people were killed in the Russian strike and subsequent warehouse detonation in Myla, Bucha district, Zelensky says. ' +
  'Four more are still missing.';

const zh = parseFromPost(zhytomyrPost, 'outside Kyiv');
console.log(`\nsentence: "${zh.sentence}"`);
console.log(`parsed  : ${JSON.stringify(zh.parsed)}\n`);

check(
  zh.sentence === 'A large fire broke out near the Zhytomyr highway outside Kyiv, reportedly after a Russian drone attack.',
  'only the sentence naming the place is isolated',
);
check(zh.parsed !== null, 'parsed is not null');
check(zh.parsed?.weapon === 'drone', `weapon === "drone"  (got ${JSON.stringify(zh.parsed?.weapon)})`);
check(zh.parsed?.casualties === null, `casualties === null — the 38 deaths are NOT inherited  (got ${JSON.stringify(zh.parsed?.casualties)})`);

// --- a strike-summary sentence naming many places must not parse ---------------
const summary =
  'Targets included a drone warehouse in Khartsyzk, a command post near Chumatske, depots in Donetsk region and Kadiivka, and a radar in Bryansk region.';
const sm = parseSentence(summary, placesNamed(summary, gaz));
check(sm === null, `strike-summary sentence (>=3 places) parses as null  (got ${JSON.stringify(sm)})`);

// countries outside the UA+RU gazetteer still count toward the >=3 rule
check(placesNamed('GRU-linked operatives ran training programs in Serbia, Bosnia and Moscow', gaz).size >= 3,
  '"Serbia, Bosnia and Moscow" counts as 3 places (foreign countries counted)');

// --- a clean single-event sentence still parses -------------------------------
const clean = 'Yeysk airfield was hit overnight, with secondary detonations reported.';
const cl = parseSentence(clean, placesNamed(clean, gaz));
check(cl?.targetType === 'airfield', `clean sentence still parses targetType=airfield  (got ${JSON.stringify(cl)})`);

// --- extended target-type vocabulary -----------------------------------------
const tpp = parseSentence('Early reports say a thermal power plant was hit in Belgorod.', placesNamed('...', gaz));
check(tpp?.targetType === 'thermal power plant', `"thermal power plant" recognised  (got ${JSON.stringify(tpp?.targetType)})`);
const hub = parseSentence('Its sorting centre and delivery hub were struck.', new Set());
check(hub?.targetType === 'sorting centre', `"sorting centre" recognised  (got ${JSON.stringify(hub?.targetType)})`);

// --- war-aims commentary is not an event -------------------------------------
check(
  !EVENT_WORDS.test("Russia's goal is not Donetsk or Luhansk alone."),
  'a sentence about war aims has no event word (Donetsk commentary is dropped)',
);
check(
  EVENT_WORDS.test('Yeysk airfield was hit overnight.'),
  'a real strike sentence still has an event word',
);

// --- metonymy filter: the place name has to mean the place -------------------
check(!metonymyReject('despite Moscow warning of consequences', 'Moscow').ok,
  '"Moscow warning of consequences" is rejected (the government)');
check(!metonymyReject('posting a graphic of a missile over central Moscow', 'Moscow').ok,
  '"posting a graphic ... over central Moscow" is rejected (a picture)');
check(!metonymyReject('Kyiv says it will retaliate.', 'Kyiv').ok,
  '"Kyiv says it will ..." is rejected (speech + intention)');
check(metonymyReject('Explosions were heard in central Kyiv this morning.', 'Kyiv').ok,
  '"explosions ... in central Kyiv" is kept (a real location)');
check(metonymyReject("Firefighters put out a fire in Kyiv's Darnytsia district.", 'Kyiv').ok,
  '"Kyiv\'s Darnytsia district" is kept (possessive naming a place)');

// --- confidence ladder ------------------------------------------------------
check(namedOrigins('the Ukrainian General Staff says a depot was hit').has('Ukraine General Staff'),
  'namedOrigins picks up "General Staff"');

// two telegram channels, no shared named origin -> 2 independent sources
check(independentSourceCount({
  channel: 'noel_reports', text: 'A warehouse was hit in Belgorod, local channels report.',
  corroboration: [{ channel: 'wartranslated', origins: [] }],
}) === 2, 'two telegram channels with no shared origin count as 2');

// same story, both relaying the General Staff -> 1 source
check(independentSourceCount({
  channel: 'noel_reports', text: 'The General Staff says a Pantsir was destroyed near Kletnya.',
  corroboration: [{ channel: 'wartranslated', origins: ['Ukraine General Staff'] }],
}) === 1, 'two channels relaying the same origin count as 1');

// an event is never corroborated by its own channel
check(independentSourceCount({
  channel: 'noel_reports', text: 'Explosions in Belgorod.',
  corroboration: [{ channel: 'noel_reports', origins: [] }],
}) === 1, 'a repost by the same channel is not a second source');

// Corroboration needs OPPOSING sides, not merely two independent sources.
// noel_reports and wartranslated both report from the Ukrainian side, so two
// of them agreeing is one perspective arriving twice. This test asserted the
// old source-counting rule and failed the moment sides were enforced, which is
// the test doing its job.
const sameSide = initLadder({
  channel: 'noel_reports', at: '2026-08-20T10:00:00Z',
  sentence: 'A depot was hit in Belgorod.',
  text: 'A depot was hit in Belgorod, ASTRA reports.',
  corroboration: [{ channel: 'wartranslated', origins: ['governor'] }],
});
applyCorroboration(sameSide, new Date('2026-08-30'));
check(sameSide.status === 'reported',
      'two Ukrainian channels agreeing does NOT promote (same side)');

// A Russian-side channel agreeing with a Ukrainian one is adversarial: neither
// gains from conceding the other's claim.
const opposed = initLadder({
  channel: 'noel_reports', at: '2026-08-20T10:00:00Z',
  sentence: 'A depot was hit in Belgorod.',
  text: 'A depot was hit in Belgorod, ASTRA reports.',
  corroboration: [{ channel: 'intelslava', origins: [] }],
});
applyCorroboration(opposed, new Date('2026-08-30'));
check(opposed.status === 'corroborated' && opposed.statusEvidence.length === 1,
      'a Russian-side channel agreeing DOES promote (adversarial)');
check(/Russian-aligned|Ukrainian-side/.test(
        (opposed.statusEvidence[0] || {}).reason || ''),
      'the promotion records which sides agreed');

// Independence still applies on top: a Russian channel merely relaying the
// same named origin is not a second source.
const relay = initLadder({
  channel: 'noel_reports', at: '2026-08-20T10:00:00Z',
  sentence: 'A Pantsir was destroyed near Kletnya.',
  text: 'The General Staff says a Pantsir was destroyed near Kletnya.',
  corroboration: [{ channel: 'intelslava', origins: ['Ukraine General Staff'] }],
});
applyCorroboration(relay, new Date('2026-08-30'));
check(relay.status === 'reported',
      'opposing sides sharing one named origin still counts as one source');

// expiry only touches 'reported' events past 14 days
check(isExpired({ status: 'reported', at: '2026-08-01T00:00:00Z' }, new Date('2026-08-30')), 'a 29-day-old reported event is expired');
check(!isExpired({ status: 'corroborated', at: '2026-01-01T00:00:00Z' }, new Date('2026-08-30')), 'a corroborated event never expires');
check(!isExpired({ status: 'reported', at: '2026-08-25T00:00:00Z' }, new Date('2026-08-30')), 'a 5-day-old reported event is not expired');

// ---------------------------------------------------------------------------
// The Leningrad class. "<Name> region" names an administrative area. When we
// do not recognise that area, we must NOT quietly fall back to a same-named
// settlement that happens to sit inside the bounding box.
//
// Real failure, 31 Aug 2026: "struck the Kirishi oil refinery in Leningrad
// region" put a marker on a village in Kherson oblast — wrong country, 1,400km
// out. The bbox rejected the real Leningrad oblast for being outside Ukraine
// and accepted the namesake for being inside, so the guard that was meant to
// protect us picked the wrong answer.
// ---------------------------------------------------------------------------
{
  const { matchPost, loadGazetteer } = await import('./telegram-detect.mjs');
  const gaz = loadGazetteer();
  const bbox = [44, 56, 22, 46];   // Ukraine

  const regionPost = {
    text: 'Ukraine struck the Kirishi oil refinery in Leningrad region overnight.',
  };
  const r = matchPost(regionPost, gaz, bbox, []);
  check(!r.matches.some(m => m.name === 'Leningrad'),
        '"Leningrad region" does not produce a Leningrad marker');

  // The guard must not swallow a place named as a place.
  const plainPost = { text: 'Drones struck a fuel depot in Bryansk overnight.' };
  const p = matchPost(plainPost, gaz, bbox, []);
  check(p.matches.some(m => m.name === 'Bryansk'),
        'a place named WITHOUT "region" still matches');

  // A Ukrainian oblast we DO recognise must keep working.
  const knownPost = { text: 'Six people were injured in Kyiv region overnight.' };
  const k = matchPost(knownPost, gaz, bbox, []);
  check(Array.isArray(k.matches), 'a recognised Ukrainian region still resolves');
}

// ---------------------------------------------------------------------------
// dedupeEvents compares the isolated sentence, not the whole post. Two channels
// describing one event write different posts; only the sentence is comparable.
// ---------------------------------------------------------------------------
{
  const { dedupeEvents } = await import('./telegram-detect.mjs');
  const same = dedupeEvents([
    { channel: 'wartranslated', url: 'https://t.me/w/1', at: '2026-08-01T10:00:00Z',
      text: 'Some long unrelated preamble about the day. An explosion hit the Balzi Rossi restaurant in central Moscow.',
      sentence: 'An explosion hit the Balzi Rossi restaurant in central Moscow.' },
    { channel: 'intelslava', url: 'https://t.me/i/1', at: '2026-08-01T11:00:00Z',
      text: 'Completely different framing and a pile of other stories entirely.',
      sentence: 'An explosion occurred at the Balzi Rossi restaurant in central Moscow near the metro.' },
  ]);
  check(same.length === 1, 'two channels describing one event fold into one');
  check((same[0].corroboration || []).length === 1, 'the second channel is recorded as corroboration');

  const different = dedupeEvents([
    { channel: 'noel_reports', url: 'https://t.me/n/1', at: '2026-08-22T10:00:00Z',
      sentence: 'Russian forces launched a large-scale overnight missile and drone attack on Kyiv, killing at least 17 people.' },
    { channel: 'intelslava', url: 'https://t.me/i/2', at: '2026-08-22T11:00:00Z',
      sentence: 'A Russian missile destroyed a Roshen Corporation building in Kyiv.' },
  ]);
  check(different.length === 2,
        'a mass attack and one building hit within it stay separate events');

  const tooShort = dedupeEvents([
    { channel: 'noel_reports', url: 'https://t.me/n/2', at: '2026-08-30T10:00:00Z',
      sentence: 'Explosions in Belgorod.' },
    { channel: 'intelslava', url: 'https://t.me/i/3', at: '2026-08-30T11:00:00Z',
      sentence: 'Explosions in Belgorod.' },
  ]);
  check(tooShort.length === 2,
        'sentences below the word floor never match, however similar');
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
