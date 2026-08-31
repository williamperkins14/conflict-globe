# Start here next session

Live: https://williamperkins14.github.io/conflict-globe/

Read this first, then HANDOVER-2026-08-31-evening.md for the detail.

## Where things stand

The confidence ladder WORKS. 5 events corroborated, in both directions,
with GDELT completely unreachable. The long-running diagnosis that the
ladder was broken was wrong — the SOURCE POOL was one-sided. Adding
intelslava (Russian-side, English) fixed it.

    261 events · 256 reported · 5 corroborated
    3 channels, all backfilled to 2 June 2026 (8,891 posts)
    Ukraine: 15 locations, 56 key events, 55 cited
    Sudan:    5 locations, 14 key events, 14 cited (NOT yet reviewed)
    Gaza / Haiti / Iran: still blank

## Last thing done

dedupeEvents now compares the isolated SENTENCE, not the whole post — two
channels describing one strike write different posts, so full-text overlap
never reached the threshold. Guards: 4+ significant words each, 3+ shared.
Measured: 21 merges folded, 1 new corroboration.
scripts/redupe-events.mjs applies the rule retroactively (dry by default).

## THE NEXT PROBLEM (measured, do not guess at it)

256 events are still 'reported'. Not for want of sources — because the data
model has ONE level where it needs TWO.

A mass attack on Kyiv produces: an overall death toll, individual buildings
hit, individual casualties. Those are FACETS OF ONE INCIDENT, not duplicates.
Merge them and you lose the Roshen building strike. Leave them apart and
nothing corroborates. No similarity threshold fixes this.

The change is an incident-vs-report split. Design it rested, at the start of
a session, not at the end of one.

## Gaza / Haiti / Iran — research already done, do not redo it

GAZA
- Ceasefire signed 10 October 2025 after a two-year war; over 72,000
  Palestinians killed before it.
- It is "neither war nor peace". 700+ further deaths since; Gaza's Government
  Media Office recorded 2,073+ violations Oct 2025 - Mar 2026.
- Israel did NOT withdraw to pre-war lines. A demarcation called the YELLOW
  LINE now divides the Strip; Israel holds roughly 50-55%, including large
  parts of Rafah, Khan Younis and northern Gaza. Fatal incidents cluster at
  the line, which shifts.
- Aid at ~21% of planned truckloads; medical evacuation ~8% of need.
- Sources: aljazeera.com/news/2026/4/10/neither-war-nor-peace-what-gaza-looks-
  like-six-months-into-ceasefire · en.wikipedia.org/wiki/Yellow_Line_(Gaza) ·
  ochaopt.org situation reports

IRAN
- There was a 2026 Iran war. A joint US-Israeli strike hit NATANZ around
  21 March 2026; Iran confirmed it and said no radioactive leak was detected.
- See britannica.com/event/2026-Iran-war and
  en.wikipedia.org/wiki/United_States_strikes_on_Iranian_nuclear_sites
- NOT yet verified in detail. Do the date-verification agent pass first, as
  was done for Ukraine and Sudan.

HAITI
- Gangs still mounting attacks as of Aug 2026, with concern over the security
  of upcoming elections.
- Crisis Group: "Undoing Haiti's Deadly Gang Alliance".
- Sources: haitiantimes.com/2026/08/12/haiti-gangs-continue-attacks-insecurity-
  grows/ · crisisgroup.org/rpt/latin-america-caribbean/haiti/110-undoing-
  haitis-deadly-gang-alliance
- NOT yet verified in detail.

Method that worked twice: research current state -> spawn an agent to verify
every date against a URL -> write WRITEUPS-X.md and KEY-EVENTS-X.md -> add the
conflict to SOURCES in scripts/apply-content.mjs -> node scripts/apply-content.mjs

## Also open

- William has not read the Sudan drafts. That material is heavy — contested
  tolls differing by an order of magnitude, a genocide finding.
- Dobropillia is filed under Pokrovsk. His call.
- ACLED / UCDP emails unsent. Still the only route to the word "verified".
- DATA.md not written.
- GDELT was unreachable from four networks on 31 Aug. Check before assuming
  any GDELT work is broken.

## Working rule

One agent holds the pen. Claude Code and Cowork editing the same tree cost a
commit that missed a change and a write that nearly deleted 1,547 lines.
