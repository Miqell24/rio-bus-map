// Synthesizes a minimal GTFS feed for Rio's RAIL systems out of OSM route
// relations, because none of their operators publishes one: data.rio ships the
// municipal buses only, and MetrôRio, VLT Carioca and SuperVia publish nothing
// at all — the Mobility Database has no entry for any of them.
//
// This is the Thessaloniki pattern (pipeline/metro-feed.mjs there), and it has
// the same honest limit: a relation gives GEOMETRY AND STATIONS, never a
// timetable. The lines are drawn with their stations and names; the journey
// planner cannot route over them, because there are no times to route with.
//
// Only the parts build.mjs actually reads are written (routes/trips/stops/
// stop_times) and shapes.txt is deliberately LEFT OUT — that makes the pipeline
// take its no-shapes path, where the station sequence becomes the HMM
// observations and Viterbi lays the geometry along the OSM tracks. So the
// relation supplies the stations and the track graph supplies the shape.
//
// Input:  data/osm/rio-rail-rel.json (Overpass: rel[route~subway|tram|train|
//         light_rail] with all members, `(._;>>;);out body;`)
// Output: data/gtfs-rail/{routes,trips,stops,stop_times}.txt
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/gtfs-rail');

// Which relations become which mode, and under what key. The three systems are
// kept apart because they run on different rails and answer to different
// toggles: the metro underground, the VLT on street tracks, SuperVia on the
// mainline. Route types follow the GTFS classics so the cfgs can filter on them.
//   L1/L2/L4  MetrôRio                       route_type 1, official colours
//   VLT1..3   VLT Carioca                    route_type 0
//   the five SuperVia branches               route_type 2
// The Santa Teresa heritage tram and the Corcovado rack railway are left out:
// both are tourist rides rather than parts of the network, and the Corcovado
// climbs on a rack the tram graph has no business routing over.
const METRO_COLOR = { L1: '008DD0', L2: '00A551', L4: 'F7941E' };

const rules = [
  { match: (t) => t.route === 'subway' && /Metr/i.test(t.operator || ''),
    key: (t) => 'L' + (t.ref || '').trim(), type: '1' },
  { match: (t) => t.route === 'tram' && /VLT/i.test(t.name || ''),
    key: (t) => 'VLT' + (t.ref || '').trim(), type: '0' },
  { match: (t) => t.route === 'train' && /SuperVia/i.test(t.operator || ''),
    key: (t) => (t.ref || '').trim(), type: '2' },
];

const osm = JSON.parse(readFileSync(join(ROOT, 'data/osm/rio-rail-rel.json'), 'utf8'));
const nodes = new Map();
for (const e of osm.elements) if (e.type === 'node') nodes.set(e.id, e);

// relation member order IS the travel order; keep the stopping members only
const stationsOf = (rel) => (rel.members || [])
  .filter((m) => m.type === 'node' && nodes.has(m.ref))
  .filter((m) => {
    const t = nodes.get(m.ref).tags || {};
    return t.name && (/^(stop|station|halt)$/.test(t.railway || '')
      || t.public_transport === 'stop_position' || t.public_transport === 'station');
  })
  .map((m) => nodes.get(m.ref));

const byKey = new Map();
for (const e of osm.elements) {
  if (e.type !== 'relation') continue;
  const t = e.tags || {};
  const rule = rules.find((r) => r.match(t));
  if (!rule) continue;
  const key = rule.key(t);
  if (!key || key === 'L' || key === 'VLT') continue;
  const st = stationsOf(e);
  if (st.length < 2) continue;
  let arr = byKey.get(key);
  if (!arr) byKey.set(key, (arr = { type: rule.type, dirs: [] }));
  arr.dirs.push(st);
}

// A line can be mapped as several CONSECUTIVE relations per direction: OSM
// splits SuperVia's Saracuruna into Central–Gramacho (49 members) and
// Gramacho–Saracuruna (13). They are sections of one run, not alternatives, so
// they are CHAINED — end station meets start station — rather than picked
// between. Choosing the longest instead cost the line its outer eight stations,
// which is the sort of loss that leaves a plausible-looking map.
const csv = (rows) => rows.map((r) => r.map((v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(',')).join('\n') + '\n';

const routes = [['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color']];
const trips = [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id']];
const stopTimes = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']];
const stops = new Map();

// Chain every section that continues another, then keep the two longest runs —
// which are the line's two directions.
//
// The junction test alone is not enough: the RETURN relation also begins where
// the outbound one ends, so chaining on that rule folds both directions into a
// there-and-back loop (Deodoro → Deodoro, 37 stations). A section only extends
// a run when it revisits NOTHING the run has already called at.
//
// "Already called at" is compared by NAME, not by node id: SuperVia's Deodoro
// and Japeri give each direction its own stop_position node, so an id test sees
// two different stations where a passenger sees one platform pair, and the
// reversal slips through.
const chainUp = (sections) => {
  const runs = sections.map((s) => s.slice());
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < runs.length; i++) {
      for (let j = 0; j < runs.length; j++) {
        if (i === j) continue;
        const a = runs[i], b = runs[j];
        if (a[a.length - 1].id !== b[0].id) continue;
        const nameOf = (n) => (n.tags.name || '').trim().toLowerCase();
        const seen = new Set(a.map(nameOf));
        if (b.slice(1).some((n) => seen.has(nameOf(n)))) continue; // a reversal, not a continuation
        runs[i] = a.concat(b.slice(1));
        runs.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return runs.sort((x, y) => y.length - x.length);
};

for (const [key, { type, dirs }] of [...byKey].sort((a, b) => a[0].localeCompare(b[0]))) {
  const runs = chainUp(dirs);
  // two directions at most: the longest run each way. The return is the run
  // whose endpoints mirror the first; anything else is a duplicate section.
  // The return is matched on station NAMES, not node ids, for the same reason
  // the chain guard is: MetrôRio and SuperVia give each direction its own
  // stop_position node, so an id test finds no return at all and half the
  // network comes out single-direction (L2, L4, every VLT line, Santa Cruz and
  // Belford Roxo, on the first run of this).
  const nm = (n) => (n.tags.name || '').trim().toLowerCase();
  const kept = [runs[0]];
  const head = nm(runs[0][0]), tail = nm(runs[0][runs[0].length - 1]);
  const back = runs.slice(1).find((d) => nm(d[0]) === tail && nm(d[d.length - 1]) === head);
  if (back) kept.push(back);
  routes.push([key, key, key, type, METRO_COLOR[key] || '']);
  kept.forEach((st, di) => {
    const tripId = `${key}_${di}`;
    trips.push([key, 'ALL', tripId, (st[st.length - 1].tags.name || '').trim(), String(di)]);
    st.forEach((n, i) => {
      const sid = 'n' + n.id;
      if (!stops.has(sid)) stops.set(sid, [sid, (n.tags.name || '').trim(), n.lat, n.lon]);
      // synthetic clock: the pipeline only needs the ORDER, and writing plausible
      // times keeps any GTFS reader that looks at this feed from choking
      const hh = String(5 + Math.floor(i * 2 / 60)).padStart(2, '0');
      const mm = String((i * 2) % 60).padStart(2, '0');
      stopTimes.push([tripId, `${hh}:${mm}:00`, `${hh}:${mm}:00`, sid, String(i + 1)]);
    });
  });
  console.log(`${key.padEnd(12)} type ${type}  ${kept.length} dir  ${kept[0].length} stacji  ` +
    `${(kept[0][0].tags.name || '').trim()} → ${(kept[0][kept[0].length - 1].tags.name || '').trim()}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'routes.txt'), csv(routes));
writeFileSync(join(OUT, 'trips.txt'), csv(trips));
writeFileSync(join(OUT, 'stop_times.txt'), csv(stopTimes));
writeFileSync(join(OUT, 'stops.txt'),
  csv([['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], ...stops.values()]));
console.log(`\n${routes.length - 1} linii, ${stops.size} stacji → data/gtfs-rail/ (bez shapes.txt — pseudo-matching)`);
