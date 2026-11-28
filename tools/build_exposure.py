#!/usr/bin/env python3
# Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
# People at risk at every site: residents within a fixed radius (5 km of a river site's town,
# 10 km of a flash-flood city), summed from the JRC Global Human Settlement Layer population grid
# (GHS-POP R2023A, epoch 2025, 30 arc-seconds ≈ 1 km). Writes site.pop = {n, r} into src/sites.json.
# Needs: pip install rasterio numpy  (runs on GitHub Actions; downloads ~460 MB once)

import json, math, os, urllib.request, zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

URL = ('https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/'
       'GHS_POP_E2025_GLOBE_R2023A_4326_30ss/V1-0/GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.zip')
ZIP = Path(os.environ.get('GHS_ZIP', '/tmp/ghs_pop_2025.zip'))
SITES = Path(__file__).resolve().parent.parent / 'src' / 'sites.json'
RADIUS = {'river': 5, 'rain': 10}
BOUNDS = (43.0, 24.0, 64.0, 41.0)  # lon/lat box around Iran

if not ZIP.exists():
    print('downloading GHS-POP 2025 …', flush=True)
    urllib.request.urlretrieve(URL, ZIP)
with zipfile.ZipFile(ZIP) as z:
    tif = next(n for n in z.namelist() if n.lower().endswith('.tif'))
with rasterio.open(f'/vsizip/{ZIP}/{tif}') as src:
    win = from_bounds(*BOUNDS, transform=src.transform)
    grid = src.read(1, window=win).astype('float64')
    tr = src.window_transform(win)
    nodata = src.nodata
if nodata is not None:
    grid[grid == nodata] = 0
grid[~np.isfinite(grid) | (grid < 0)] = 0
lons = tr.c + (np.arange(grid.shape[1]) + 0.5) * tr.a
lats = tr.f + (np.arange(grid.shape[0]) + 0.5) * tr.e


def people_within(lat, lon, r_km):
    dlat = r_km / 111.0
    dlon = r_km / (111.0 * math.cos(math.radians(lat)))
    ri = np.where((lats >= lat - dlat - 0.01) & (lats <= lat + dlat + 0.01))[0]
    ci = np.where((lons >= lon - dlon - 0.01) & (lons <= lon + dlon + 0.01))[0]
    sub = grid[np.ix_(ri, ci)]
    la = np.radians(lats[ri])[:, None]
    lo = np.radians(lons[ci])[None, :]
    p1 = math.radians(lat)
    a = np.sin((la - p1) / 2) ** 2 + math.cos(p1) * np.cos(la) * np.sin((lo - math.radians(lon)) / 2) ** 2
    d = 2 * 6371.0 * np.arcsin(np.sqrt(a))
    return float(sub[d <= r_km].sum())


sites = json.loads(SITES.read_text(encoding='utf-8'))
for kind in ('river', 'rain'):
    for s in sites[kind]:
        n = people_within(s['lat'], s['lon'], RADIUS[kind])
        s['pop'] = {'n': int(round(n, -2)), 'r': RADIUS[kind]}
        print(f"{kind:5} {s['id']:24} {s['pop']['n']:>10,} within {RADIUS[kind]} km", flush=True)
sites['info']['popSource'] = 'JRC GHSL GHS-POP R2023A, epoch 2025, 30 arc-seconds'
sites['info']['touched'] = [{'kind': k, 'id': s['id'], 'fields': ['pop']} for k in ('river', 'rain') for s in sites[k]]
sites['info']['built'] = __import__('datetime').date.today().isoformat()  # makes the next update pick it up
SITES.write_text(json.dumps(sites, indent=1, ensure_ascii=False), encoding='utf-8')
print('wrote', SITES)
