# Spec: markers from trusted Telegram channels

Ukraine only for now. Prove the method here, then apply it to the other
conflicts. Sources and reasoning are in SOURCES.md.

## Why this over GDELT

GDELT geocodes *mentions*. These channels are humans reporting *events*, in
English, with a permanent link back to each claim. Measured from one page of
noel_reports on 29 Aug: five of eleven posts named a specific settlement with a
specific event, one of them with target type and casualty figures.

**Recommendation: pause the GKG layer for Ukraine while evaluating this.**
Leave the code, disable it. Running two mediocre detectors is worse than
running one and judging it honestly.

## Source, already verified

`https://t.me/s/<channel>` is server-rendered HTML. No JavaScript, no account,
no key. Proven 29 Aug: 99 KB, 11 posts, all text present in the raw bytes.

Parse per message container `<div class="tgme_widget_message ...`:

    data-post="noel_reports/51876"          -> id and permalink
    <time datetime="2026-08-29T11:59:24+00:00">
    <div class="tgme_widget_message_text">  -> the text

Three known traps, found during the test:
- A reply carries **two** text blocks, a greyed quote of the original and the
  new text. Take the last.
- Reactions live in `tgme_widget_message_reactions`. A greedy `.*</div>` grab
  swallows them.
- Media-only posts have no text block. Skip them.

Pagination: `?before=<oldest_id>` returns the preceding ~20. Walk back only as
far as needed; on a schedule, stop at the newest id already seen.

## Channels

Start with the two highest-signal ones. Add the others once the method works.

    noel_reports              English, Ukraine, place-specific
    wartranslated             English, Ukraine, place-specific
    KyivIndependent_official  add later
    nexta_live                add later
    OSINTdefender             add later, mostly global rather than Ukraine

## Gazetteer

GeoNames, free, CC BY 4.0 (**attribution required on the site**).

    https://download.geonames.org/export/dump/UA.zip
    https://download.geonames.org/export/dump/RU.zip

RU is needed: posts report strikes on Klintsy, Bryansk, Engels, Yaroslavl.
Occupied Crimea sits inside the UA file.

Read their `readme.txt` for the column layout rather than assuming it. Keep
feature class `P` (populated places). Build a trimmed `gazetteer.json` and
commit it, so the job never re-downloads.

Keep per entry: name, **alternatenames** (this is what makes `Київ`, `Kiev`
and `Kyiv` resolve to one place), lat, lng, admin1 code, population.

**Do NOT apply a population floor as an inclusion filter.** The valuable
matches are villages: Berestky, Znamianka, Hvardiiske. A floor would delete
precisely the signal we are looking for.

## Matching

1. Match settlement names in post text on **word boundaries**, case-insensitive,
   including alternate names. Prefer the longest match where names overlap.
2. **Disambiguate by region.** Posts name the oblast: "Berestky, Donetsk
   region", "Klintsy, Bryansk region". If a region appears in the post, keep
   only candidates in that admin1. This is the primary disambiguator.
3. If no region is given and several candidates share a name, fall back to
   population. If still ambiguous, **drop it and log it**. A wrong marker is
   worse than a missing one.
4. Maintain a stoplist for settlement names that are ordinary words. Build it
   from real output rather than guessing up front.
5. Discard anything outside the ukraine conflict's existing `bbox`.

## Output

Extend `auto-locations.json`. Same file, new fields:

    {
      "name": "Berestky",
      "lat": 48.11, "lng": 37.55,
      "source": "telegram",
      "count": 2,
      "firstSeen": "2026-08-29",
      "lastSeen": "2026-08-29",
      "evidence": [
        {
          "channel": "noel_reports",
          "url": "https://t.me/noel_reports/51874",
          "at": "2026-08-29T11:36:45Z",
          "excerpt": "a drone command post in Berestky, Donetsk region"
        }
      ]
    }

Keep at most 3 pieces of evidence per place, newest first. Keep a
`seen-posts.json` of processed post ids so reruns are cheap and idempotent.

The relationship is many-to-many: one post yields several places, one place
accumulates several posts.

## Frontend

- Telegram markers render distinctly from both curated and GKG markers.
- The panel shows the actual post excerpt, the channel name, the timestamp,
  and a link to the post.
- Wording, exactly: **"Reported by [channel]. Not independently verified."**
  A marker here means a source William trusts said something happened there.
  It does not mean it did.

## Acceptance

- Run by hand against two channels. Print every match with the post excerpt
  and the coordinates chosen, plus every ambiguous name that was dropped.
- William reads that list and judges whether the places are right. This is the
  checkpoint that matters; everything before it is plumbing.
- Only then wire it to a schedule.

## Open question

Whether GitHub's runners can reach t.me. Workflow run 33252016028 was testing
this. If they cannot, the job runs on William's Mac on a schedule instead and
pushes the result. Nothing else in this spec changes.
