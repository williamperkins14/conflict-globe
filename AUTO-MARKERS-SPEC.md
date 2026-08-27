# Spec: automatically detected conflict locations

Hand this to Claude Code. It is a build spec, not a tutorial. William has never
programmed before this project, so explain what you are doing as you go and do
not rewrite parts of the site that are not listed here.

## Goal

Markers should appear for places where events are being reported, without
William adding them by hand. If Lviv is struck tomorrow, a Lviv marker should
appear under the Russia-Ukraine conflict within a few hours.

These are a SEPARATE, clearly-labelled layer. They never touch `conflicts.json`,
which is hand-written and stays that way.

## Why this cannot run in the browser

Two hard blockers, both already tested:

1. A static page cannot write to its own data file, so nothing discovered in
   the browser survives a refresh.
2. GDELT's GEO 2.0 API sends no CORS headers. It is unreachable from a page and
   perfectly reachable from a server.

Running the work in GitHub Actions solves both at once. GEO 2.0 is the right
endpoint here because it returns geocoded points with coordinates already
resolved, rather than headlines that would then need a separate geocoder.

## Architecture

    .github/workflows/detect-locations.yml   schedule + workflow_dispatch
    scripts/detect-locations.mjs             the job (Node 20+, no deps needed)
    auto-locations.json                      output, committed by the job
    conflicts.json                           UNCHANGED, hand-written
    index.html                               loads and renders the extra layer

No API key is required. GDELT needs no authentication, so there are no secrets
to configure.

## The job, step by step

For each conflict in `conflicts.json`:

1. Call GDELT GEO 2.0:

       https://api.gdeltproject.org/api/v2/geo/geo
         ?query=<conflict.query, URL-encoded>
         &mode=PointData
         &format=GeoJSON
         &timespan=3d
         &maxpoints=100

2. **On the very first run, write the raw response of one conflict to the job
   log before parsing it.** I could not reach this endpoint from either machine
   available to me, so the exact property names below are from documentation and
   are UNVERIFIED. Confirm them against real output rather than assuming. A
   wrong property name here fails silently and produces an empty map.

   Expected shape: a GeoJSON FeatureCollection. Each feature has
   `geometry.coordinates` as `[lng, lat]` (note the order, it is not lat/lng)
   and a `properties` object containing at least a place name and a count of
   articles. Log it and check.

3. Discard any point that fails ANY of these:

   - **Outside the conflict's bounding box.** Add a `bbox` field to each
     conflict in `conflicts.json` as `[minLat, maxLat, minLng, maxLng]`:

         ukraine  [44, 56, 22, 46]
         sudan    [8, 23, 21, 39]
         gaza     [31.0, 31.7, 34.1, 34.6]
         haiti    [17.9, 20.2, -74.6, -71.6]
         iran     [25, 40, 44, 64]

     This is the single most important filter. Without it an article datelined
     Washington that mentions Kyiv puts a marker on Washington.

   - **Fewer than 3 articles.** One mention is noise.

   - **Within 25km of an existing curated location in that conflict, or the
     same name.** Kyiv must not acquire a second marker.

4. Keep at most 25 per conflict, highest article count first.

5. Merge into `auto-locations.json`. For a point already present, update
   `lastSeen` and `count`. For a new one, add it with `firstSeen` set to today.

6. Drop any entry whose `lastSeen` is more than 14 days ago. The map should
   show the current war, not everything that ever happened.

7. Write the file only if it changed, then commit and push.

Space the requests out. GDELT rate-limits hard and starts hanging or refusing
under sustained load; we hit this repeatedly during development. Five seconds
between conflicts, a 20-second timeout per request, and a failure on one
conflict must not abort the others.

## `auto-locations.json` format

    {
      "generated": "2026-08-28T06:00:00Z",
      "conflicts": {
        "ukraine": [
          {
            "name": "Lviv",
            "lat": 49.8397,
            "lng": 24.0297,
            "count": 12,
            "firstSeen": "2026-08-28",
            "lastSeen": "2026-08-28"
          }
        ]
      }
    }

## Workflow file

- `schedule:` every 6 hours, plus `workflow_dispatch` so it can be run by hand.
- `permissions: contents: write` so it can commit.
- Commit message should state what changed, e.g.
  `Auto-locations: +2 new, 1 expired`.
- Run it manually via `workflow_dispatch` and check the output BEFORE enabling
  the schedule.

## Frontend changes in `index.html`

Keep changes minimal and in keeping with what is there.

- Fetch `auto-locations.json` alongside `conflicts.json`. If it is missing or
  fails, the site must work exactly as it does now. This layer is additive.
- In `openConflict(c)`, draw curated locations AND that conflict's auto
  locations. Tag the auto ones so they can be told apart, e.g. `auto: true`.
- Auto markers render **hollow or amber, and smaller** than curated red ones.
  A reader must be able to tell at a glance which is which.
- In the panel for an auto location, show plainly:
  `Automatically detected from news coverage. Not verified.`
  plus the article count and the dates first and last seen.
- Add auto locations to the panel's Locations list, visually distinguished,
  under their own subheading.

## Non-negotiables

- Never write to `conflicts.json`. Promotion from auto to curated is a manual
  edit by William and nothing else.
- Never present an auto marker as equivalent to a curated one.
- GDELT geocodes **mentions, not events**. A marker means "several articles
  about this conflict mentioned this place". It does not mean a strike happened
  there. The wording in the panel must not overstate it.

## Acceptance

- Manual `workflow_dispatch` run completes and prints, per conflict, how many
  points were returned and how many survived each filter.
- `auto-locations.json` is committed and contains plausible places inside the
  right countries.
- The globe shows them, visually distinct, and clicking one explains what it is.
- Deleting `auto-locations.json` leaves the site working exactly as before.

## Known unknowns

- GEO 2.0 response property names, as above. Verify from a logged sample.
- Whether GEO 2.0 rate-limits as aggressively as the DOC API. Assume it does.
- Bounding boxes are first guesses. Gaza's is deliberately tight and may need
  widening; Iran's is very broad and that conflict entry is the weakest in the
  dataset anyway.
