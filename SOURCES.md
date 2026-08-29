# Trusted sources

William's list, 28 Aug 2026. Grouped by how a machine can actually read them,
which turns out to matter more than the platform they were found on.

Nothing here is verified: the feed URLs below are expected shapes, not tested.
The job that consumes this must confirm each one and log what it got.

## Tier 1: structured assessments (best fit for this project)

These publish daily written analysis naming specific settlements. That is much
closer to "what happened where" than any news feed, and closer than GDELT.

| Source | X | Site |
|---|---|---|
| Institute for the Study of War | @TheStudyofWar | understandingwar.org |
| Critical Threats (AEI) | @criticalthreats | criticalthreats.org |

ISW's daily Russian Offensive Campaign Assessment names settlements
individually and updates a map. Critical Threats covers Iran and Africa and
co-publishes some ISW output. Both are free, public, and have RSS.

**This is the strongest thing on the list.** It is human analysis, updated
daily, place-specific, in English, and requires nobody's permission.

## Tier 2: news organisations with RSS

Readable without X, without Telegram, without an API key.

| Source | X | Site |
|---|---|---|
| Reuters | @Reuters | reuters.com |
| Associated Press | @AP | apnews.com |
| The Guardian | @guardian | theguardian.com |
| New York Times | @nytimes | nytimes.com |
| Politico | @politico | politico.com |
| Politico Europe | @POLITICOEurope | politico.eu |
| Kyiv Independent | @KyivIndependent | kyivindependent.com |

The Guardian additionally has a free open API with a proper key, which is
better than scraping RSS if we want structure.

## Tier 3: OSINT aggregators and individuals

X-native. Most maintain a public Telegram channel, which is readable at
`t.me/s/<channel>` without an account. Channel names need confirming.

| Source | X | Notes |
|---|---|---|
| OSINTdefender | @sentdefender | Fast, broad, aggregates unverified claims |
| NOELreports | @NOELreports | Ukraine-focused, generally careful |
| WarTranslated | @wartranslated | Translates Russian-language military content |
| NEXTA | @nexta_tv | Belarusian outlet, large Telegram presence |
| Illia Ponomarenko | @IAPonomarenko | Journalist, individual account |

Different reliability class from tiers 1 and 2. Fast, sometimes first, and
sometimes wrong in ways that get amplified before they get corrected.

## Still missing: the editorial half

For each source: why William trusts it, and where it is weak. Every one of
these has a lean. Some sit close to a government or a military, some amplify
unverified claims when a story is breaking, some are strong on imagery and
weak on casualty figures.

That is the part no machine can supply and the part that would make this layer
defensible rather than merely fast.

## Coverage gap

Every source here covers Ukraine. Four of the five conflicts on the globe
(Sudan, Gaza, Haiti, Iran) have no dedicated source on this list. Worth
addressing before the site claims to be a world map rather than a Ukraine map.

---

# Telegram channels: VERIFIED 28 Aug 2026

Checked by actually loading each `t.me/s/` page and reading the posts, not by
assuming. All are public, readable with no account, no API key, no login.
Each page shows roughly the last 15-20 posts with timestamps and permalinks.

| Source | Telegram | Verdict for this project |
|---|---|---|
| NOELreports | `noel_reports` | **Best of the list.** English, Ukraine-focused, roughly 5 posts in 18 named a specific settlement with a specific event (Udachne, Mariupol, Siversk, Kyiv/Chernihiv/Sumy air defence). |
| WarTranslated | `wartranslated` | **Strong.** English, Ukraine-focused, place-specific (Engels, Yaroslavl). Translates Russian-language military material. |
| Kyiv Independent | `KyivIndependent_official` | Newsroom feed. Reliable, less granular than the two above. |
| NEXTA | `nexta_live` (also `nexta_tv`) | Broad Belarus/Russia/Ukraine. Less place-specific. |
| OSINTdefender | `OSINTdefender` | Active, but scope is global geopolitics rather than Ukraine ground detail. Fewer usable settlement mentions. |
| Illia Ponomarenko | not found | No public channel located. X only, so out of reach. |

Not needed here: ISW, Critical Threats, Reuters, AP, Guardian, NYT, Politico.
All publish RSS, which is a better route than Telegram for those.

## Signal quality, measured not guessed

From one page of NOELreports, posts naming a place AND an event:

    "Ukrainian forces have cleared the village of Udachne in Donetsk region"
    "Reports of a missile strike and fire in temporarily occupied Mariupol"
    "Air defence shot down 48 Russian drones ... Kyiv, Chernihiv, Sumy"
    "Electronic warfare units halted Russia's advance on Siversk"

That is a far higher hit rate than GDELT produced, already in English, already
written by a human, and each post has a permanent link back to itself.

## The approach: gazetteer matching, NOT a language model

To turn a post into a marker we need a place name and coordinates.

**Do this with a gazetteer, not an LLM.** Download the GeoNames dataset for
Ukraine (free, no key), which lists every settlement with its alternate
spellings and coordinates. Match post text against that list.

Why this and not extraction by model:

- Deterministic. The same post always produces the same result.
- Auditable. Every marker traces to a matched string and a source post.
- No invention. A model can hallucinate a place; a lookup table cannot.
- Free, offline after the initial download, and fast.

This is the same argument that killed the headline-rewriting experiment on
27 Aug, and it applies more strongly here, because a wrong marker is a claim
about where a war is being fought.

## Known difficulties

- **Ambiguity.** Many Ukrainian villages share a name. Mitigate with a
  population floor, a preference for longer names, and using an oblast name in
  the same post to disambiguate.
- **Common-word collisions.** Some settlement names are ordinary words. Needs
  a stoplist built from real output.
- **Russian place names.** Posts mention strikes inside Russia (Engels,
  Yaroslavl). The Ukraine gazetteer alone will miss those. Add RU later.
- **These posts are claims, not verified facts.** A marker sourced this way
  means "a source William trusts reported an event here", and the panel must
  say exactly that.
