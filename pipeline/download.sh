#!/usr/bin/env bash
# Downloads input data: Rio de Janeiro GTFS (SMTR via data.rio), OSM roadways
# (Overpass), MapLibre GL. Everything is cached — re-running only fetches what
# is missing.
#
# ONE feed covers every municipal bus the city licenses: the four consortia
# (Internorte, Intersul, Santa Cruz, Transcarioca) and MOBI-Rio, which runs the
# BRT. It uses the EXTENDED route types — 700 bus, 702 express bus (the BRT),
# 200 coach — all of them road-based, so there is one graph. The metro, the VLT
# Carioca tram and the SuperVia trains are other operators and are not here.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs data/osm/road-tiles web/vendor

# A downloaded extract is only accepted if it PARSES and carries a plausible
# number of elements. `grep -q '"elements"'` — the guard this family used
# everywhere — passes on a truncated response too: Brașov's roads arrived as a
# 65 kB fragment that still contained the string, was taken for complete, and
# silently skipped the city (16.08.2026).
# The minimum differs by extract: a road network runs to tens of thousands of
# ways, a city tram network to a few hundred (Cluj's is 132), so the caller
# passes its own floor rather than sharing one.
ok_json () { # $1=file  $2=minimum element count
  python3 - "$1" "$2" <<'PYEOF' 2>/dev/null
import json, sys
try:
    sys.exit(0 if len(json.load(open(sys.argv[1])).get("elements", [])) >= int(sys.argv[2]) else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# 1) GTFS — data.rio publishes it through ArcGIS; the item id is the stable part
if [ ! -f data/gtfs/routes.txt ]; then
  echo "== SMTR GTFS (Rio de Janeiro) =="
  curl -fL --retry 3 --max-time 900 -o data/rio-gtfs.zip \
    "https://www.arcgis.com/sharing/rest/content/items/8ffe62ad3b2f42e49814bf941654ea6c/data"
  unzip -o data/rio-gtfs.zip -d data/gtfs
fi

# 2) OSM — roadways in FOUR TILES. Stops span 23.07–22.79 S / 43.72–43.16 W;
#    the margin reaches Santa Cruz in the west and Ilha do Governador in the
#    north. One query over 71 × 42 km of a city this dense times out everywhere.
if [ ! -f data/osm/rio.json ]; then
  echo "== Overpass (roads, 4 tiles) =="
  HW='^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$'
  i=0; ok_all=1
  for BB in "-23.12,-43.80,-22.93,-43.45" "-23.12,-43.45,-22.93,-43.10" \
            "-22.93,-43.80,-22.74,-43.45" "-22.93,-43.45,-22.74,-43.10"; do
    i=$((i+1))
    ok_json "data/osm/road-tiles/tile$i.json" 2000 && continue
    Q="[out:json][timeout:900];way($BB)[\"highway\"~\"$HW\"];out geom;"
    got=0
    # overpass-api.de first: the lighter mirrors have been caught serving a
    # stale database (Naples, 16.08.2026 — a line opened in 2025 was missing)
    for EP in "https://overpass-api.de/api/interpreter" \
              "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
              "https://overpass.kumi.systems/api/interpreter"; do
      echo "-- tile$i: $EP"
      if curl -fsS --max-time 900 -o data/osm/road-tiles/tile$i.json --data-urlencode "data=$Q" "$EP" \
         && ok_json "data/osm/road-tiles/tile$i.json" 2000; then got=1; break; fi
      sleep 6
    done
    [ "$got" = 1 ] || ok_all=0
    sleep 5
  done
  [ "$ok_all" = 1 ] || { echo "Overpass (roads): tiles failed" >&2; exit 1; }
  node -e '
    const fs = require("fs");
    const seen = new Set(); const els = [];
    for (let i = 1; i <= 4; i++) {
      for (const e of JSON.parse(fs.readFileSync(`data/osm/road-tiles/tile${i}.json`)).elements) {
        if (!seen.has(e.id)) { seen.add(e.id); els.push(e); }
      }
    }
    fs.writeFileSync("data/osm/rio.json", JSON.stringify({ version: 0.6, elements: els }));
    console.log(`roads merged: ${els.length} ways`);
  '
fi

# 3) MapLibre GL (vendored, no CDN at runtime)
if [ ! -f web/vendor/maplibre-gl.js ]; then
  echo "== MapLibre GL =="
  curl -fL --retry 3 -o web/vendor/maplibre-gl.js  https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js
  curl -fL --retry 3 -o web/vendor/maplibre-gl.css https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css
fi

echo "OK — data ready:"
du -sh data/rio-gtfs.zip data/osm/rio.json 2>/dev/null || true
