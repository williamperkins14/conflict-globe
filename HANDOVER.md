# WHERE WE STOPPED (29 Aug 2026)

## Done since last time

**Telegram integration works.** scripts/telegram-detect.mjs, gazetteer.json.gz
(UA + RU from GeoNames), seen-posts.json. Committed and pushed. It produced 11
Ukraine markers from noel_reports and wartranslated, rendered in blue against
the curated red.

**The 19-marker load bug is FIXED** (commit e4395d5) and verified on the live
site: 5 markers, activeConflict null, panel closed.

Cause: a stray pointer click landing during page load. globe.gl counts a quick
pointerdown+up near a marker as a click, and Ukraine's marker sits near screen
centre at the default camera, so clicking into the window to focus it while the
globe settles fired openConflict. Fix: no transition on first paint, plus
navigating=true for 800ms so early clicks are swallowed, plus onPointClick
returning early while navigating.

Note for anyone revisiting this: the "it's the pulsing rings" theory is WRONG.
The count came from globe.pointsData(), which is the data array, not rendered
geometry, and the entries were named Kyiv, Kharkiv, Pokrovsk etc. Do not
re-investigate the rings.

## THE NEXT STEP, and it is William's, not a machine's

Review the 11 Telegram markers and decide which belong. This is the checkpoint
the whole method rests on.

Eight look like genuine events:
  Klintsy (Bryansk) Buk-M3 destroyed | Kletnya (Bryansk) Pantsir-S1 destroyed
  Bryansk | Rostov-on-Don drone strikes | Hvardiyske (Crimea) drone sites
  Znamianka (Crimea) EW system | Berestky (Donetsk) drone command post
  Dmytrivka community head killed

Three look like the place being DISCUSSED rather than an event happening there:
  Chernihiv  - post says offensive groupings are NOT currently there
  Luhansk    - a stated objective for December, not an event
  Zhytomyr   - a fire on the "Zhytomyr highway", which is outside Kyiv

That is the failure mode now: the place is matched correctly, but the post is
talking about it rather than reporting something there. Proposed fix, pending
William's verdict: require an event word (struck, hit, destroyed, killed,
shelling, attack) within a short distance of the matched name, and treat
"X highway" and "X region" as special cases.

## Still open

- Whether GitHub runners can reach t.me. Workflow run 33252016028 was testing
  it; the result was never read. If they cannot, the job runs on the Mac.
- Four conflict summaries are empty; Kyiv's `sources` still has the placeholder
  "Whatever you want the link to say" pointing at https://... Live on the site.
- GKG layer still produces country centroids and demonyms for Sudan and Iran.
  Recommendation stands: pause it for Ukraine while judging Telegram alone.
- ACLED and UCDP emails drafted in DATA-ACCESS-EMAILS.md, unsent.
- Backup files index.html.backup through .bak9 and conflicts.json.bak can go.

## TELEGRAM LAYER BUILT (29 Aug) — awaiting William's editorial review

`scripts/telegram-detect.mjs` + `gazetteer.json.gz` (GeoNames UA+RU, committed).
Matches settlement names in `noel_reports` and `wartranslated` posts against the
gazetteer, disambiguates by the oblast named in the post, drops the ambiguous.
Ran by hand 29 Aug: 11 places, 2 dropped, 5 suppressed as already-curated.

- Ukraine's GKG layer is PAUSED: `SKIP = new Set(['ukraine'])` in
  detect-locations.mjs. The telegram detector owns `auto-locations.json`'s
  ukraine array; stale GKG entries there were dropped.
- Frontend: telegram markers are blue (curated red, GKG amber), panel shows
  each post excerpt + channel + date + link, wording "Reported by [channel].
  Not independently verified."
- NOT wired to a schedule. `auto-locations.json` + `seen-posts.json` here are
  a hand-run result committed for review.
- **Not visually verified** — no browser this session. Load the site and click
  a blue Ukraine marker.
- Soft matches for William to judge: "Zhytomyr" (the highway, not the city),
  "Luhansk"/"Chernihiv" (analytical mentions, not events). `STOPLIST` in the
  script is where common-word / surname collisions get killed; it grows from
  output (peskov, tkachenko, etc. already added).
- Next: wire a dispatch-only workflow (t.me returns 200 from the runner,
  confirmed run 33252016028), then a schedule once the matches hold up.

## OPEN BUG (found 29 Aug, live on the site)

On first page load the globe draws **19 markers**: the 5 conflicts PLUS all 14
Ukraine locations, mixed together at world level. Calling showWorld() corrects
it to 5, so showWorld itself is fine and the fault is in the initial draw after
conflicts.json loads. Suspect something added with the auto-locations layer.

Small fix, but it defeats the two-tier design for anyone arriving fresh.

# WHERE WE STOPPED (28 Aug 2026, late)

William stopped here, tired, after a long session. Pick up from this point.

## The good news: the GKG pipeline WORKS

The GEO 2.0 API is dead (404 from every machine, three separate runs, while
DOC returns 200 on the same host). We rewrote the fetching half to download
GDELT's raw Global Knowledge Graph files from data.gdeltproject.org instead.
See AUTO-MARKERS-SPEC-V2.md.

It ran end to end and produced a real auto-locations.json. Download, unzip,
parse, theme filter, bbox filter, thresholds, merge and expiry all function.

## The one problem, and it is small

The places it found are the wrong KIND of place:

    ukraine: "Ukraine" (49, 32)  count 37     <- the country, not a city
             "Romanian" (46, 25) count 6      <- a demonym
    sudan:   "Ethiopians" (8, 38) count 3     <- a demonym, wrong country

GKG's V2Locations includes a location TYPE as the first hash-separated field:

    1 = country        2 = US state       3 = US city
    4 = world city     5 = world state/ADM1

We are currently keeping every type, so country centroids and demonyms swamp
the actual cities. **The fix is to keep only type 4, and possibly 5.** That is
a one-line filter in parseLocations(), plus a log line counting what each type
contributed so the choice can be checked rather than assumed.

Verify the type is really field 0 by reading the logged sample entry first.
Assumed data shapes have cost this project two false starts already.

## Immediate next steps, in order

1. Filter V2Locations by type (keep 4, evaluate 5). Re-run with
   WINDOW_FILES = 2 and check the places are cities inside the right country.
2. Widen to WINDOW_FILES = 12 and confirm it finishes in time.
3. Look at the results by eye. This is the editorial checkpoint: are these
   places where something actually happened, or just places that got
   mentioned? Tune CONFLICT_THEMES and MIN_ARTICLES from real output.
4. Remove the now-pointless GEO probe from the workflow; keep a DOC canary.
5. Only then enable the schedule.

## Still outstanding, unrelated to the above

- Four conflict summaries are empty and Kyiv's `sources` still contains the
  placeholder "Whatever you want the link to say" pointing at https://...
  This is live on the internet.
- The GDELT news feed scoring still gives +2 for English and matches only
  Latin-alphabet terms, so the best local-language coverage arrives via the
  "loosely matched" fallback rather than on merit.
- ACLED and UCDP emails are drafted in DATA-ACCESS-EMAILS.md and unsent.
  William intends to send them; he has not yet.
- Asked about using trusted X/Twitter accounts as a source. X has no free API
  and scraping it breaches their terms, so this is not a route. Telegram
  channels and outlet RSS feeds are the realistic equivalent and are worth
  investigating instead.

## Infrastructure set up this session (for a fresh Claude session)

- Repo: github.com/williamperkins14/conflict-globe. Pages serves `main` at
  https://williamperkins14.github.io/conflict-globe/
- `gh` CLI is installed at `~/.local/bin/gh` and authenticated as
  williamperkins14. `git push` works via gh's credential helper.
- **Security debt:** a classic PAT (`ghp_...`, full `repo` scope) was pasted
  into chat early on. Revoke it at GitHub → Settings → Developer settings →
  Tokens (classic) if not already done. gh uses its own token now, so this is
  safe to revoke.
- `auto-markers` branch is merged into `main`; safe to delete.
- If a `git` command fails with a `.git/index.lock` error and nothing is
  running, it is a stale lock from VS Code — `rm .git/index.lock`.
- Workflow `detect-locations.yml` is on `main`: `workflow_dispatch` only,
  `schedule:` commented out, still carries a now-pointless GEO probe step.
  `WINDOW_FILES = 2`. Run it from the Actions tab; check the log.

# Conflict Globe — handover notes

## What this is
An interactive 3D globe showing ongoing armed conflicts. Red markers sit on conflict
locations. Clicking one opens a left-hand panel with a written summary, its sources,
and a live feed of recent news headlines pulled from GDELT.

## Who you are working with
William. Politics and International Relations background, strong on the subject
matter, **no prior programming experience**. He explicitly chose to treat this as a
learning exercise.

That means:
- Explain what code does and why, in plain language, not just what to type.
- Do not silently rewrite large parts of the project. Small, explained changes.
- He should write the conceptually interesting parts himself. Boilerplate (CSS,
  scaffolding, data reshuffling) is fine to do for him, with an explanation after.
- He is direct and does not want padding or flattery. Say what is wrong plainly.
- Verify things actually work before saying they work. He has been burned by
  "that should work" more than once.

## Stack
Deliberately minimal. No framework, no build step, no bundler.
- Plain HTML / CSS / JavaScript in a single `index.html`
- `globe.gl` v2.46.2 loaded from jsDelivr (three.js under the hood)
- Earth textures from unpkg (`three-globe` example images)
- Data in `conflicts.json`, loaded with `fetch`
- Edited in VS Code, served locally with the Live Server extension on port 5500

Do not introduce React, a bundler, or a package.json unless there is a concrete
reason and he agrees to it.

## Files
- `index.html` — everything. The script is split into commented PART 1 to PART 6:
  1. build the globe, 2. camera and motion, 3. fetch data and draw markers,
  4. window resize, 5. the panel (`showPanel`), 6. news and sources
  (`loadNews`, `showSources`, `formatDate`)
- `conflicts.json` — the dataset
- `index.html.backup`, `index.html.bak2` — old copies, safe to delete
- `conflicts.json:` (with a trailing colon) — junk file, 0 bytes, delete it
- `.DS_Store` — macOS noise, gitignore it

## Data schema
```json
{
  "name": "Kyiv, Ukraine",
  "type": "Interstate war",
  "updated": "2026-08-25",
  "lat": 50.4501, "lng": 30.5234, "intensity": 0.9,
  "query": "(Kyiv OR Kiev)",
  "match": ["Kyiv", "Kiev"],
  "summary": "Prose written by William.",
  "sources": [{ "label": "...", "url": "https://..." }]
}
```
- `intensity` (0 to 1) drives marker size and ring spread
- `query` is the GDELT search string. **OR'd terms MUST be wrapped in parentheses**
  or GDELT returns a plain-text error with an HTTP 200 status.
- `match` terms filter returned headlines. An article is kept only if its title
  contains one of them.

## What works
Globe renders, markers sized by intensity with pulsing rings, click opens the panel
and flies the camera to the location, summary and sources render, GDELT headlines
load and are filtered to English articles whose titles mention the place.

## GDELT findings (27 Aug 2026)
Measured directly in the browser, not assumed:
- OR'd terms **must** be wrapped in parentheses. `Kyiv OR Kiev` is rejected;
  `(Kyiv OR Kiev)` works. GDELT returns that rejection as **plain text with an
  HTTP 200 status**, so `.json()` throws and a broad catch hides the message.
- `sort=datedesc` returns a narrow slice of the newest wire copy, heavily
  syndicated. `sort=hybridrel` gives a better spread across the week.
- Deduplicating on a normalised title collapsed 75 results to 18 unique stories.
- **The biggest finding:** for `(Kyiv OR Kiev)` the highest-relevance results are
  almost entirely Ukrainian-language local outlets, and they are the *best*
  coverage of strikes on the city ("Київ обстріл 27 серпня", "Вибухи в Київській
  області"). An English-only filter throws away the most relevant sources. A
  Latin-alphabet title match never matches Cyrillic headlines.
- GDELT rate-limits hard. After sustained testing, requests start failing with
  network errors or hanging past 20 seconds. It recovers on its own.
- The GEO 2.0 API sends no CORS headers and cannot be called from the browser.
- Untested, because GDELT started refusing requests: whether `sourcelang:english`
  or `sourcelang:eng` actually works as a query operator.

## Decision: headline cleanup is OFF (27 Aug 2026)
Chrome ships an on-device language model (`LanguageModel`, reports `available`,
free, no key, no server). It was wired up to rewrite the clumsy machine
translations into plain English, tested, and then deliberately switched off
behind `const HEADLINE_CLEANUP = false` in index.html.

Reason, from measured output: it made headlines read better and made them less
accurate. "Герань-4", a Geran strike drone, survived translation as
"Geranium-4" but the rewrite turned it into "an explosion involving a
geranium". Station gridlock ("колапс") became "a settlement to collapse".
"Destroyed" softened to "damaged".

Clumsy English warns the reader it is machine output. Fluent English removes
that warning without removing the errors. Do not re-enable without a way to
catch this class of failure.

Also tested and rejected: extracting structured event fields (area, target,
casualties) from headlines. The model did NOT invent casualty figures, it
correctly returned null every time, because headlines almost never state them.
It did misread the drone as the target. That format needs ACLED, not a model
reading headlines.

## Open editorial question
Should the feed show local-language sources (most relevant, unreadable to most
visitors) or English only (readable, much thinner)? Not decided.

## Known issues, roughly by priority
1. **GDELT rate limits.** Heavy testing got requests throttled to the point of
   hanging. The site needs to cache results per conflict rather than refetching on
   every click.
2. ~~`innerHTML` unsanitised~~ FIXED. `escapeHtml` now escapes titles, domains and
   languages, and hrefs are checked against `^https?://` before use.
3. **Relevance is still imperfect.** "Inside Kherson Red Zone: A Kyiv Post Special
   Report" passes the Kyiv filter because the outlet name contains "Kyiv". Query and
   match tuning is ongoing editorial work and belongs to William, not to you.
4. **Content is placeholder.** Only the Kyiv summary is real. All `sources` arrays
   are empty. He knows and is doing this deliberately later.

## Immediate task: deploy
Nothing is under version control yet. The plan:
1. `git init`, sensible `.gitignore` (`.DS_Store`, `*.backup`, `*.bak2`)
2. First commit
3. Create a GitHub repo and push
4. Enable GitHub Pages, confirm the live URL works

He has never used git. Explain what a commit and a remote actually are as you go.

## Queued after that
- Sanitise the news rendering
- Cache GDELT responses
- Two-tier zoom: conflict-level markers that expand into event-level markers on zoom
  in. **Blocked** until the dataset has several locations per conflict, which is
  editorial work he has not done yet. Do not build it against the current five
  single-location entries; the feature would be invisible.
- A methodology / about page explaining sourcing
- Real summaries and sources

## Things already ruled out
- Google Earth / Google Maps 3D tiles: not licensable as a drop-in, billed per load
- CesiumJS: too heavy for v1
- ACLED: best event data available, but licensing restricts building a public
  "substitute product". Worth writing to them; not resolved.
- GDELT GEO 2.0 API: better suited to this than the DOC API, but sends no CORS
  headers, so it cannot be called from the browser. Needs a server-side job.
