# Iran Flood Watch · پایش و هشدار سیل ایران

A flood early-warning dashboard for Iran, built only from open data. It watches 29 river reaches and 27 flash-flood-prone cities, checks for new model runs four times an hour, and sends an alert as soon as a site reaches a warning level or moves up a level. Each alert says how many people live nearby and what to do, in English and Persian, and is published in the international CAP alert format.

[![Spring 2019 flood replay on 26 March: warning levels across Iran and the Kor river at Marvdasht passing its 20-year flood](docs/preview.png)](https://risarezaei.github.io/iran-flood-watch/replay-2019.html#d-2019-03-26)

**Not an official warning service.** Always follow the Iran Meteorological Organization and local crisis-management authorities.

## What it does

| Signal | Forecast | Threshold |
|---|---|---|
| River flood (29 sites) | GloFAS ensemble river discharge (v4 now, v5 automatically once live), 51 members, 30 days ahead (~5 km river network). New run every day. | 2-, 5- and 20-year flows of the same model's own daily discharge (v4: water years 1997–2024) |
| Flash-flood rain (27 sites) | Seven global ensembles combined, 276 members, up to 16 days ahead, summed over Iran local days and 3-day windows (table below). | 2-, 5- and 20-year 1-day and 3-day rainfall from ERA5 (0.25°), water years 1992–2024, summed the same way |
| Rain on wet ground or snowmelt (27 sites) | The same rain plus degree-day snowmelt, times the share of ground wet enough to shed it (ECMWF ensemble soil moisture). | Return levels of the same quantity from ERA5 |

**Rain models.** Each counts equally, however many members it has, so no single model dominates:

| Model | Centre | Members | Type |
|---|---|---|---|
| IFS ENS | ECMWF | 51 | physics |
| AIFS ENS | ECMWF | 51 | AI |
| WeatherNext 2 | Google DeepMind | 64 | AI |
| GEFS | NOAA | 31 | physics |
| ICON-EPS | DWD | 40 | physics |
| GEPS | Environment and Climate Change Canada | 21 | physics |
| MOGREPS-G | UK Met Office | 18 | physics |

A model whose newest run is late is left out until it catches up. The page also shows each model's own level day by day, so you can see whether they agree.

Return levels come from a Gumbel distribution fitted by L-moments to water-year (October–September) annual maxima. Each forecast is compared with its own model's climate, the same idea GloFAS uses for its flood signals. Because of that, river flows are shown as multiples of the 2-year flood rather than as raw m³/s.

**Wet ground and snowmelt.** The same rain does more harm on soaked ground or on melting snow. Following the LISFLOOD model that drives GloFAS, the share of ground that sheds water rises with soil wetness (the Xinanjiang curve), and snowmelt comes from a degree-day model (4.5 mm per °C per day). This check can raise a rain site's level, never lower it, and it can lower the rain needed for a level by at most 30%, so drizzle on damp ground in dry cities does not count. On ERA5 with perfect foresight, it adds 0.6 alert days per year on average: 2.5 instead of 1.8. The most is 1.5 extra days at snowy Ardabil. The extra days fall in wet spells and on snowmelt days, such as Tehran on 1 April 2019. No alert from rain alone is lost.

Warning levels, checked day by day across the alert window (30 days for rivers, 10 days for rain):

- **Severe**: at least 30% of ensemble members above the 20-year level
- **High**: at least 30% above the 5-year level
- **Moderate**: at least 50% above the 2-year level
- **Normal**: none of these

For rain the share is model-weighted. A rain site takes the highest level of its four checks: 1-day rain, 3-day rain, and the same two on wet ground or snowmelt. The probabilities, horizons and models are all in `CONFIG` at the top of `src/engine.mjs`.

**People at risk and what to do.** Every site carries the number of residents within 5 km (river towns) or 10 km (city centres), from the JRC Global Human Settlement Layer for 2025. Each alert states that number, the chance and the day, and level-specific advice in English and Persian, with the emergency numbers 112 (Red Crescent) and 115 (ambulance).

**Feeds.** Alerts are published as CAP 1.2 messages ([`docs/cap/index.atom`](https://risarezaei.github.io/iran-flood-watch/cap/index.atom)), the OASIS Common Alerting Protocol that national warning services use. They follow each alert through Alert, Update and Cancel, in English and Persian. There is also an RSS feed ([`docs/feed.xml`](https://risarezaei.github.io/iran-flood-watch/feed.xml)).

**Timing:**
- GitHub's schedule starts the check four times an hour. It finishes in seconds when nothing is new, and downloads only the model that changed when something is. GitHub sometimes delays or skips scheduled runs, so a new forecast can take longer than 15 minutes to appear. Any scheduler that calls the workflow (for example every 10 minutes) makes this regular.
- The page shows which model runs it used, in Tehran time, and an "out of date" banner if the river run is older than 48 hours or fewer than four rain models are current.
- Each alert lists the day it starts and the day it peaks.

**Event check:** the largest modelled flows since 1997 fall on known disaster dates:
- Gorganrud on 18 March 2019 (the Golestan floods)
- Kor on 26 March 2019 (the Fars floods)
- Karkheh and Seymareh on 1 April 2019
- Sarbaz and Minab on 11 January 2020 (Sistan and Baluchestan)

Sites below large dams are marked, because the real flow there also depends on release decisions.

**Replay demos:** `tools/build-replay.mjs` builds a day-by-day replay of a past flood using the same thresholds and warning rules:
- `docs/replay-2026-11.html` covers the floods of 5–9 November 2026. For each rain point, it also replays the archived ECMWF forecasts issued every morning before the event, showing how many days ahead a warning would have appeared. These are the single ECMWF IFS run, because past ensemble runs aren't archived.
- `docs/replay-2019.html` covers the spring 2019 floods.

Rebuild with `node tools/build-replay.mjs --event 2026-11`, and open a given day with a link such as `#d-2026-11-07`.

## Run it

Needs Node.js 18 or newer. There are no packages to install.

```bash
node flood-watch.mjs                 # fetch the newest forecasts → docs/index.html, docs/data/*, docs/feed.xml, docs/cap/*
node flood-watch.mjs --if-new        # only refetch what has a new model run; does nothing if nothing is new
node flood-watch.mjs --archive       # also keep a small record of every update in docs/data/archive/
node flood-watch.mjs --from-json docs/data/latest.json   # re-render without fetching
npm test                             # unit tests
```

Each rain model's last run is kept in `.cache/`, so a routine update downloads one model for 27 points in three requests.

## How the live site updates

This repository runs itself on GitHub Actions and publishes to GitHub Pages from `main`, folder `/docs`:

- `.github/workflows/flood-watch.yml` runs four times an hour (and whenever it is started by hand or by an outside scheduler). It updates only when a model has a new run, and keeps the model cache between runs.
- Every new or rising alert opens a GitHub issue, which GitHub emails to the repository owner.
- To start an update by hand: **Actions → Flood watch → Run workflow**.
- `.github/workflows/rebuild.yml` rebuilds thresholds and population figures. It runs daily: it finishes any build that stopped at the Open-Meteo daily limit, and builds the GloFAS v5 thresholds once v5 is on Open-Meteo, after which the river forecasts switch to v5.
- Optional instant phone alerts: an [ntfy](https://ntfy.sh) topic saved as the repository secret `NTFY_TOPIC`. `NOTIFY_LEVEL` in the workflow sets the lowest level that alerts (1 = Moderate).

## Files

```
flood-watch.mjs              update run (model-run check → fetch → snapshot → page, bulletin, feeds, alerts)
src/engine.mjs               forecasting and warning logic: GloFAS versions, seven-model rain ensemble
src/climate.mjs              return levels, soil wetness, snowmelt
src/thresholds.mjs           rain-point return levels from an ERA5 record
src/impact.mjs               people at risk and advice, English and Persian
src/feeds.mjs                CAP 1.2 messages, CAP Atom index, RSS
src/stations.mjs             site list (names, Persian labels, coordinates, dams)
src/sites.json               snapped river cells, return levels and population for every site
src/dashboard.template.html  the dashboard (D3, embedded map of Iran)
src/iran_topo.json           boundaries simplified from Natural Earth
tools/build-thresholds.mjs   rebuilds return levels (resumable; --rain, --river, --glofas 5)
tools/build_exposure.py      people at risk from the GHSL population grid
```

To add a site, append it to `src/stations.mjs`, then run `node tools/build-thresholds.mjs --rain <new-id>` (or `--river`) and `python tools/build_exposure.py`.

## Data and credits

GloFAS (Copernicus Emergency Management Service); ensemble forecasts from ECMWF (IFS, AIFS), Google DeepMind (WeatherNext 2), NOAA (GEFS), DWD (ICON-EPS), ECCC (GEPS) and the UK Met Office (MOGREPS-G), all via [Open-Meteo](https://open-meteo.com) (CC BY 4.0); ERA5 (Copernicus Climate Change Service); population from the JRC Global Human Settlement Layer (GHS-POP R2023A); boundaries © [Natural Earth](https://www.naturalearthdata.com). These sources keep their own terms.

## Citation

Use the **Cite this repository** button on GitHub, or:

> Abbasalizadehrezaei, P. (2026). *Iran Flood Watch: ensemble flood early warning for Iran* (Version 2.0.0) [Software]. https://github.com/RisaRezaei/iran-flood-watch

## Copyright

© 2026 Parisa Abbasalizadehrezaei. All rights reserved.

The code is public so that it can be read and cited. It is **not** open source: copying, modifying, hosting or reusing any part of it, in software, services, papers or anywhere else, needs the author's written permission. See [`LICENSE`](LICENSE). To ask, get in touch through [risarezaei.github.io](https://risarezaei.github.io).
