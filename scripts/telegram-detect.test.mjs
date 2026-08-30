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

// corroboration promotes 'reported' -> 'corroborated'
const evt = initLadder({ channel: 'noel_reports', at: '2026-08-20T10:00:00Z', sentence: 'A depot was hit in Belgorod.', text: 'A depot was hit in Belgorod, ASTRA reports.', corroboration: [{ channel: 'wartranslated', origins: ['governor'] }] });
applyCorroboration(evt, new Date('2026-08-30'));
check(evt.status === 'corroborated' && evt.statusEvidence.length === 1, 'applyCorroboration promotes and records evidence');

// expiry only touches 'reported' events past 14 days
check(isExpired({ status: 'reported', at: '2026-08-01T00:00:00Z' }, new Date('2026-08-30')), 'a 29-day-old reported event is expired');
check(!isExpired({ status: 'corroborated', at: '2026-01-01T00:00:00Z' }, new Date('2026-08-30')), 'a corroborated event never expires');
check(!isExpired({ status: 'reported', at: '2026-08-25T00:00:00Z' }, new Date('2026-08-30')), 'a 5-day-old reported event is not expired');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
