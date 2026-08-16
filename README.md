# Rio de Janeiro Public Transport — interactive map

Interactive, poster-grade map of every municipal bus the city of **Rio de
Janeiro** licenses: the four consortia (Internorte, Intersul, Santa Cruz,
Transcarioca) and MOBI-Rio, which runs the BRT — 498 lines and 24 008 km of
network drawn along the real street geometry.

## Live

Not published — this map is built and reviewed locally.

One feed covers everything. It uses the EXTENDED route types, not the classic
ones, and all of them are road-based, so there is a single graph:

| mode | route_type | lines | drawn |
|---|---|---|---|
| buses | 700 | 440 municipal lines, plus the SN night, SV sea-front, SP/SR seasonal and LECD school variants | navy |
| BRT | 702 | 30 MOBI-Rio busway lines — TransOeste, TransCarioca, TransOlímpica | amber, own toggle |
| coach | 200 | 28 intermunicipal runs into Castelo | navy |

The rail is a **second, synthesized feed**. MetrôRio, VLT Carioca and SuperVia
publish no GTFS anywhere — the Mobility Database has no entry for any of them —
so `pipeline/rail-feed.mjs` builds one out of OSM route relations, the way
Thessaloniki's metro is built:

| mode | lines | drawn |
|---|---|---|
| MetrôRio | L1, L2, L4 | official colours, metro treatment |
| VLT Carioca | 1, 2, 3, 4 | teal |
| SuperVia | Belford Roxo, Deodoro, Japeri, Santa Cruz, Saracuruna | violet |

**What that feed can and cannot give**: it carries real geometry and real
stations, and no timetable at all. The lines are drawn with their station discs
and names; the journey planner cannot route over them, because there are no
times to route with.

Three traps in those relations, all the same shape — **OSM gives each direction
its own stop_position node**, so comparing by node id silently fails:

* SuperVia's Saracuruna is mapped as two consecutive sections (Central–Gramacho
  and Gramacho–Saracuruna). Taking "the longest relation" cost the line its
  outer eight stations, so sections are chained instead.
* Chaining on the junction alone then folded each line's two directions into a
  there-and-back loop (Deodoro → Deodoro, 37 stations), because the return
  relation also begins where the outbound one ends.
* The same id blindness left L2, L4, all four VLT lines, Santa Cruz and Belford
  Roxo single-direction, because the return was never recognised as the return.

All three are fixed by comparing station NAMES rather than node ids.

Build quirks worth knowing:

* **The BRT is its own category, not a fast bus.** It runs on segregated
  busways with its own stations, so it takes the engine's amber "metroline"
  slot: its own colour, its own toggle, and a dashed overlay where a busway
  corridor is shared with ordinary buses. 612 drawn segments are BRT-only,
  192 shared.
* **The match is the tightest in the family** — median error 0.7 m, 95th
  percentile 1.4 m, worst 2.8 m across 943 runs. Read that with care: it says
  the feed's shapes and OSM agree closely here, which is a statement about two
  datasets, not a guarantee about the street.
* **The feed's shapes carry many holes.** Line 60 alone has 15 gaps over 300 m,
  the widest 1 487 m. The engine bridges a gap by ROUTING through the graph
  rather than interpolating, so a hole becomes real streets instead of a
  straight chord across the block.
* **One corner resists matching: the BRT through the Grota Funda tunnel.**
  OSM has the Transoeste busway one way only there, and the parallel twin-bore
  tunnel is `highway=trunk`, which the graph treats as hard one-way, so the
  return direction has nothing to run on. Each of the 30 BRT lines draws about
  640 m of raw shape there — 19 km of 24 008, 0.08 % of the network. The line
  stays continuous and correctly aligned; it is simply not snapped to a way.
* **The Galeão airport stop (Terminal 1) sits 3.3 km from every line calling
  there** and is dropped. The feed places it inside the terminal building while
  the routes stop on the approach road.
* **Portuguese is written in the Latin alphabet**, so this map runs without the
  second, transliterated label line its Greek, Bulgarian and Serbian siblings
  carry, and the stop names arrive properly cased and accented from SMTR.

## Pipeline

`npm run download` fetches the GTFS (data.rio publishes it through ArcGIS),
the OSM roadways and MapLibre GL. The roads come in tiles: one query over
71 × 42 km of a city this dense times out on every mirror, and on a bad
afternoon even the quarter-tiles need halving again. `npm run build`
map-matches every line (HMM/Viterbi on the OSM graph — 541 467 nodes,
591 611 segments) and writes GeoJSON to `data/out/`. `npm run serve` hosts the
map at http://localhost:8148.

Data: Secretaria Municipal de Transportes do Rio de Janeiro (SMTR) via
data.rio · base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
