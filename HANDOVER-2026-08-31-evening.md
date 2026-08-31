# Where we stopped — 31 August 2026, evening

Live: https://williamperkins14.github.io/conflict-globe/
origin/main: 61eae8f

## THE RESULT

The confidence ladder works. Four events promoted — the first this project
has ever produced — and they happened with GDELT completely unreachable.

    [Kyiv]   5 Aug  Rozetka warehouse struck in Brovary
                    wartranslated (UA) + intelslava (RU)
    [Moscow] 1 Aug  Explosion at the Balzi Rossi restaurant
                    wartranslated (UA) + noel_reports (UA) + intelslava (RU)
    [Moscow] 18 Jun Kapotnya refinery attacked, per Mayor Sobyanin
                    intelslava (RU) + noel_reports (UA)
    [Donetsk] 30 Jun Donetsk airport (weak — really commentary, not an event)

Both directions fire: Ukraine's report conceded by a Russian channel, and
Russia's report confirmed by a Ukrainian one. The Kapotnya case is the
strongest — the Moscow mayor announcing damage to his own refinery.

The diagnosis all along was that the ladder was broken. It was not. The
SOURCE POOL was one-sided. Adding intelslava fixed it.

## State

- 3 channels, all backfilled to 2 June 2026, all done:
  noel_reports 3,449 posts · wartranslated 1,706 · intelslava 3,736
- 282 events (was 130). 278 reported, 4 corroborated.
- 23 auto markers. Ukraine: 15 curated locations, 56 key events, 55 cited.
- Sudan drafted: 5 locations, 14 key events, all cited. NOT yet reviewed
  by William.

## GDELT is down

Unreachable from four independent networks on 31 Aug (GitHub runner, the
laptop, the cloud container, Anthropic's fetcher) — TCP never opens. It
answered from a runner at 11:23 the same morning. Not our code, not the
query shape, not rate limiting. Three of my hypotheses were wrong in turn.

The site now says so plainly in the news panel rather than "could not load".
Nothing else depends on it: corroboration works channel-to-channel.

## THE NEXT PROBLEM — measured, not guessed

278 events remain 'reported'. The bottleneck is no longer missing sources.
It is that we cannot tell two channels are describing the same event.

Cross-channel, same place, same day, sentence-word overlap:

    >=0.60    7        (the current dedupe threshold — and it compares
    0.40-0.60 15        FULL POST TEXT, not the sentence, which is why
    0.25-0.40 39        only 4 got through)
    <0.25     113

DO NOT just lower the threshold. The data says it would be wrong:

  0.86  "...destroyed UKRTAC's factory and warehouses in Kyiv"
        "...destroyed the UKRTAC plant and warehouses in Kyiv"
        -> same event, genuinely missed. Fixing dedupe to compare the
           SENTENCE rather than the full post text would catch this.

  0.33  "large-scale overnight missile and drone attack on Kyiv, killing 17"
        "A Russian missile destroyed a Roshen Corporation building in Kyiv"
        -> DIFFERENT events. Merging loses the Roshen strike.

  0.33  "death toll in Kyiv has risen to 21"
        "overnight attack on Kyiv has killed at least 17"
        -> same attack, different moments. One event or two?

The real issue: the data model has ONE level where it needs TWO. A mass
attack produces an overall toll, individual buildings hit, and individual
casualties. Those are facets of one INCIDENT, not duplicates of each other.
Merging loses granularity; not merging loses corroboration.

That is an incident-vs-report modelling change, not a tuning job. Design it
rested.

Two smaller things visible in the same data:
- "The EU approved sanctions over deadly strikes on Kyiv" passed the
  event-word filter. Policy news is not an event at a place.
- intelslava posts carry flag emoji and "⚡️" prefixes that the sentence
  extractor keeps.

## Cheap win available first

dedupeEvents() compares `significantWords(ev.text || ev.excerpt)` — the whole
post. Comparing the isolated `sentence` instead is a one-line change and
would have caught the UKRTAC pair. Do that, measure, THEN decide about the
incident model.

## Still open

- Gaza, Haiti, Iran: no write-ups, no key events. Generator handles multiple
  conflicts; each needs two markdown files.
- William has not read the Sudan drafts.
- Dobropillia filed under Pokrovsk — his call.
- ACLED / UCDP emails unsent. Now the only route to the word "verified".
- DATA.md not written.
- vvgladkov (Belgorod governor, 426K subs) would be an official-source tier,
  but it is Russian-language and the matcher is English end to end. One post
  suggested he has resigned as governor — check before building on it.

## Working rule

One agent holds the pen. Claude Code and Cowork editing the same tree cost a
commit that missed a change and a write that nearly deleted 1,547 lines.
