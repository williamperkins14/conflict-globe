# Spec v2: auto-detected locations from GDELT GKG files

Supersedes AUTO-MARKERS-SPEC.md. That version is dead: it was built on the
GEO 2.0 API, which returns 404 to the documented minimal call from every
machine we tested (William's laptop, a Claude Code sandbox, and the GitHub
runner) while the DOC API on the same host returns 200. The endpoint is gone.

Everything already built stays. The frontend, `auto-locations.json` format,
bounding boxes, filters, merge and expiry logic are all unchanged and tested.
**Only the fetching half is replaced.**

## What changes

Instead of asking an API for geocoded points, download GDELT's raw Global
Knowledge Graph files and extract the locations ourselves.

Measured from the runner, 28 Aug:

    lastupdate: 200, connect 0.126s
    masterlist: 200, connect 0.004s, 127 MB
    api.gdeltproject.org: connect 4-11s, intermittent

The file host is a different, far faster machine than the API host. The API
timed out completely in one run and worked in the next. The file host answered
in four milliseconds. This is a more reliable foundation than the API ever was.

## The source files

`https://data.gdeltproject.org/gdeltv2/lastupdate.txt` returns three lines,
each `size  md5  url`. The third is the GKG file:

    4554008 77c8910c... https://data.gdeltproject.org/gdeltv2/20260828001500.gkg.csv.zip

Filenames are `YYYYMMDDHHMMSS.gkg.csv.zip` on a strict 15-minute grid
(:00, :15, :30, :45). So earlier files can be constructed by subtracting
15 minutes repeatedly from the latest timestamp. Do NOT download
masterfilelist.txt; it is 127 MB and we do not need it.

## The job

1. GET `lastupdate.txt`, take the gkg line, parse out the timestamp.
2. Build the previous N filenames by stepping back 15 minutes. Default
   `WINDOW_FILES = 12` (three hours). Make it a constant at the top.
   **For the first run set it to 2** so the test is quick.
3. For each file: download, then unzip. The runner has the `unzip` command,
   so `unzip -p file.zip` via child_process avoids adding any npm dependency.
   A 404 on one file is normal (occasionally a slot is missing); skip and
   carry on.
4. Parse as TAB-separated. The GKG 2.1 columns are believed to be, zero-indexed:

       0  GKGRECORDID
       1  DATE
       3  SourceCommonName      (the outlet domain)
       4  DocumentIdentifier    (the article URL)
       8  V2Themes
       10 V2Locations
       15 V2Tone

   **These indices are UNVERIFIED.** On the first run, log one complete raw
   row and the split field count before relying on them. This exact class of
   assumption has already cost this project two false starts.

5. `V2Locations` is believed to be semicolon-separated entries, each
   hash-separated:

       LocationType#FullName#CountryCode#ADM1#ADM2#Lat#Long#FeatureID#Offset

   Log one parsed entry on the first run and confirm before trusting it.

6. Keep a row only if `V2Themes` contains at least one conflict theme.
   Start with:

       ARMEDCONFLICT, WB_2433_CONFLICT_AND_VIOLENCE, MILITARY,
       KILL, WOUND, SIEGE, TERROR, DISPLACEMENT

   Log the theme strings that actually matched so the list can be tuned.

7. For each location in a kept row, apply the EXISTING filters unchanged:
   inside a conflict's `bbox`, then count distinct article URLs per place,
   then `>= 3` articles, then not within 25km of a curated location, then
   cap at 25 per conflict by count.

   Group places by FeatureID where present, falling back to name plus
   coordinates rounded to 2 decimals. One article must count once per place
   however many times it mentions it.

8. Merge into `auto-locations.json` exactly as now: bump `count` and
   `lastSeen`, set `firstSeen` on new entries, expire after 14 days, write
   only if changed. That code is already tested and should not be rewritten.

## Reporting

Per conflict, print the funnel as it does now, with the new stages:

    [ukraine] rows 41283 -> conflict themes 1904 -> locations 5120
              -> in bbox 288 -> >=3 articles 41 -> not curated/dup 33 -> kept 25

Print total bytes downloaded and elapsed time, so the cost of the window size
is visible.

## Acceptance

- A manual run with `WINDOW_FILES = 2` completes, logs one raw row, one parsed
  location entry, the matched theme names, and the funnel per conflict.
- Then set `WINDOW_FILES = 12`, run again, and confirm it finishes inside the
  job timeout.
- `auto-locations.json` is committed and its places sit inside the right
  countries. Sanity-check a few by eye before trusting the filters.
- Deleting `auto-locations.json` still leaves the site working.

## Unchanged non-negotiables

- Never write to `conflicts.json`.
- Auto markers stay visually distinct and labelled unverified.
- A marker means "several articles about this conflict mentioned this place",
  not "a strike happened here". GKG locations are still extracted from text,
  so this is better geocoding, not verified events. The panel wording stays.

## Cleanup

Remove the GEO probe lines from the workflow once this works, or keep one
DOC probe as a canary. The api host is not used by the new job at all.
