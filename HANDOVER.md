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

## Known issues, roughly by priority
1. **GDELT rate limits.** Heavy testing got requests throttled to the point of
   hanging. The site needs to cache results per conflict rather than refetching on
   every click.
2. **`innerHTML` is used with unsanitised external strings** in `loadNews`. Article
   titles come straight from GDELT into the DOM. Must be fixed before this is
   public.
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
