# Research notes: Dannegracht, Breukelen

Compiled 2026-09-25. The sandboxed research environment used to build this module could
**not** reach OpenStreetMap, Overpass, PDOK, Nominatim, or Wikipedia directly (all blocked
by the container's egress proxy — confirmed with direct `curl` attempts and `WebFetch`,
which returned `EGRESS_BLOCKED` for `api.pdok.nl`, `nl.wikipedia.org`, and
`wiki.openstreetmap.org`). Only the `WebSearch` tool worked. All findings below therefore
come from web-search snippets (which quote/summarize primary sources including Dutch
Wikipedia, Rijksmonumenten.nl and government PDFs) rather than from fetching and parsing
the primary documents myself, and from general geographic knowledge of Breukelen's layout.
**The app itself runs in the user's browser, which _can_ reach Overpass/PDOK at runtime** —
`src/geo/overpass.ts` and `src/geo/geocode.ts` do the authoritative, precise lookups live;
`src/geo/fallback.ts` is only a schematic backup for when that fails.

Confidence key: **VERIFIED** = corroborated by a named source found via search.
**ESTIMATED** = plausible value from general knowledge/geometry, not confirmed by a source.
**UNVERIFIED-BUT-SOURCED** = a search snippet asserts it, but I could not open the primary
page myself to double check wording/context.

## Course of the Danne / Dannegracht

- The Danne (also called Dannegracht for the eastern, built-up stretch nearest the Vecht)
  branches off the river Vecht in the centre of Breukelen village, near the church /
  Kerkbrink, and runs roughly westward to the Amsterdam-Rijnkanaal (ARK).
  **UNVERIFIED-BUT-SOURCED**: [Danne (watergang) — Wikipedia](<https://nl.wikipedia.org/wiki/Danne_(watergang)>)
  ("The Danne runs from the Vecht at the center of the village of Breukelen westward toward
  the Amsterdam-Rijnkanaal… The split of the river Vecht with the Danne plays an important
  role in Breukelen's history.")
- Multiple iron drawbridges (ophaalbrug) cross the Danne/Dannegracht: at Stationsweg (house
  numbers 37 and 1), at Molenwerf (14), and at Dannegracht (9). A separate riveted bascule
  bridge, the **Straatwegbrug**, crosses the Dannegracht connecting Straatweg and Kerkbrink,
  "near the old lock", dated 1937.
  **UNVERIFIED-BUT-SOURCED**: search snippets citing
  [Rijksmonumenten.nl — Ophaalbrug over de Danne](https://rijksmonumenten.nl/monument/520641/ophaalbrug-over-de-danne/breukelen/),
  [Wikimedia Commons category](<https://commons.wikimedia.org/wiki/Category:Ophaalbrug_over_de_Danne_(Breukelen)>),
  [Waterkaart Live — Dannebrug](https://waterkaart.net/gids/brug.php?naam=Dannebrug).
- A historic **schutsluis (shipping/flood lock)** and an accompanying **sluiswachterswoning**
  (lock keeper's house) are listed as rijksmonumenten in Breukelen, described as a
  "double-acting lock" of water-management significance for the connection between the
  Dannegracht/Danne and the Vecht (built ~1891 for the waterworks).
  **UNVERIFIED-BUT-SOURCED**: [Rijksmonumenten.nl — Schutsluis](https://rijksmonumenten.nl/monument/520606/schutsluis/breukelen/),
  [Rijksmonumenten.nl — Sluiswachterswoning](http://rijksmonumenten.nl/monument/520605/sluiswachterswoning/breukelen/).
  This is the "sluis" the task asked to verify rather than assume: there genuinely is one,
  near the Straatweg/Kerkbrink crossing, i.e. close to the Vecht end of the Dannegracht.
  Whether it is still operable / normally open or closed today is **not established** by
  these sources (they describe it as a heritage structure); `fallback.ts` models it as a
  structure with `blocksFlow: true` as the conservative modelling choice for a lock, and
  this should be revisited once the live Overpass data (which may carry `lock=yes` /
  `waterway=lock_gate` tags with more current state) is available in-browser.
- No weir (stuw) or culvert (duiker) in the Dannegracht itself was found in any source — per
  the task instructions, none is included in the fallback data. `overpass.ts` still queries
  for `waterway=weir` and `tunnel=culvert` so a genuine one (if OSM has it) is picked up live.
- I could not obtain precise node-by-node centerline coordinates for the Danne/Vecht/ARK from
  OSM (blocked). The fallback centerlines in `fallback.ts` are **ESTIMATED** from Breukelen's
  known layout (Vecht running roughly north–south through the village center at approx.
  52.173°N 5.003°E; the Amsterdam-Rijnkanaal running roughly north–south about 700 m–1 km
  further west at approx. 4.993°E–4.994°E; the Danne connecting the two roughly east–west).
  They are schematic, not survey-accurate, and are clearly marked `source: 'fallback'` in the
  `Scene` they produce so the UI/sim can show a "using approximate geometry" notice.

## Widths / depths

- **Amsterdam-Rijnkanaal**: **VERIFIED (search-summarized from Rijkswaterstaat "Vaarwegen in
  Nederland" and binnenvaartkennis.nl)**: CEMT class VIb (search result phrased the class as
  "VIb", note the task brief said "Vb" — the corroborated class from the search summary is
  VIb, allowing vessels up to 200 × 23.5 × 4.0 m); channel width over 100–120 m in large
  stretches; RWS-maintained depth roughly NAP/KP ‑5.00 to ‑6.00 m. Used in `fallback.ts` as
  width 110 m, depthM 5.5.
  Sources: [Amsterdam-Rijnkanaal — Binnenvaart Kennis](https://www.binnenvaartkennis.nl/2026/09/ark/),
  [Vaarwegen in Nederland (RWS)](https://open.rijkswaterstaat.nl/publish/pages/85510/vin_2006.pdf).
- **Vecht** (through Breukelen): **UNVERIFIED-BUT-SOURCED**, from a boater forum thread: the
  fairway (vaargeul) is at least 2.40 m deep; a boat with 1.45 m draught never touched bottom.
  Width through the village is **ESTIMATED** at ~25 m (typical for this stretch of the Vecht,
  a historically canalized river used by recreational and some small commercial traffic).
  Used in `fallback.ts` as width 25 m, depthM 2.5.
  Source: [watersportforum.eu — Diepte Vecht???](https://watersportforum.eu/viewtopic.php?f=33&t=4083).
- **Dannegracht**: no direct source for width/depth found. **ESTIMATED** as a narrow town
  gracht: width 10 m, depthM 1.8 (shallower than the Vecht, consistent with it carrying only
  local/leisure traffic and having several low drawbridges).

## Brugstraat 10e, Breukelen

- PDOK locatieserver (`api.pdok.nl`) was **unreachable** from this environment (egress
  blocked), so the address could not be geocoded precisely here. `src/geo/geocode.ts`
  implements the PDOK lookup so the **browser** (which has full internet access) resolves it
  live when a user adds/edits the pinned probe.
- Brugstraat is a short residential street in "Breukelen Midden", postcodes 3621AG/3621AH,
  house numbers roughly 2–25, in the historic village centre near the Vecht/Kerkbrink area —
  i.e. very close to the Vecht-end of the Dannegracht and its bridges/lock described above
  (the street's own name, "Brug"-straat, is consistent with being next to one of the
  drawbridges there). **UNVERIFIED-BUT-SOURCED**:
  [AlleCijfers.nl — Brugstraat in Breukelen](https://allecijfers.nl/weg/brugstraat-breukelen/),
  [Postcode 3621 in Breukelen](https://www.postcodezoekmachine.nl/3621),
  [postcodebijadres.nl — Brugstraat 3–25](https://postcodebijadres.nl/breukelen/brugstraat/3-25).
- No source gave an exact lat/lon for house number 10e. The coordinate used in
  `fallback.ts` (`brugstraat-10e` probe) is **ESTIMATED / APPROXIMATE**: placed a short
  distance (~15–20 m) north of the Dannegracht centerline, near the Vecht-end
  cluster of bridges/lock, consistent with the postcode/street-number research above. This
  MUST be treated as a placeholder — the app should prefer the live PDOK geocode result at
  runtime (`geocode('Brugstraat 10e, Breukelen')`) and only fall back to this schematic pin
  if that request fails offline.

## Summary of confidence

| Item                                                                                         | Confidence                                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Danne connects Vecht (village centre) to ARK, flowing roughly east→west                      | UNVERIFIED-BUT-SOURCED                                                     |
| Several drawbridges over the Danne/Dannegracht (Stationsweg x2, Molenwerf, Dannegracht)      | UNVERIFIED-BUT-SOURCED                                                     |
| Historic schutsluis + sluiswachterswoning near Straatweg/Kerkbrink, Vecht end of Dannegracht | UNVERIFIED-BUT-SOURCED                                                     |
| No weir/culvert found in the Dannegracht                                                     | absence not proven, none assumed                                           |
| ARK ≈ CEMT VIb, ~100–120 m wide, ~5–6 m maintained depth                                     | VERIFIED via search-summarized RWS sources                                 |
| Vecht fairway depth ≥ ~2.4 m at Breukelen                                                    | UNVERIFIED-BUT-SOURCED (forum)                                             |
| Vecht/Dannegracht widths, Dannegracht depth                                                  | ESTIMATED                                                                  |
| All centerline coordinates (Vecht/Danne/ARK)                                                 | ESTIMATED, schematic only                                                  |
| Brugstraat 10e exact coordinates                                                             | ESTIMATED / APPROXIMATE placeholder — resolve live via PDOK in the browser |

## Proposed follow-up (not done here, network-blocked)

Once this runs somewhere with real internet access, re-derive `fallback.ts`'s centerlines
from actual Overpass `out geom` results for `waterway` ways named Vecht / Danne / Dannegracht
and the ARK relation, and re-geocode Brugstraat 10e via PDOK, to replace the ESTIMATED
coordinates with surveyed ones.
