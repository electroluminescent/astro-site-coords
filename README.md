# Astro Planner — site coordinates, sky brightness & night forecast for astrophotography

**Live tool:** https://electroluminescent.github.io/astro-site-coords/

Find any place on a map, by name or by coordinates (or from your device's GPS), and get every
latitude / longitude / elevation format that astrophotography software asks for — ready to click-copy.

## Features

- **Map** (Leaflet) — Dark, Streets, Satellite, Terrain, plus a **Layers** panel:
  - **Light pollution** (David Lorenz atlas 2025) with opacity;
  - **Satellite clouds** — latest GOES-East/West and Himawari infrared from NASA GIBS (≈40 min old, refreshed every 10 min);
  - **Forecast overlay** — any forecast row (cloud, low/mid/high cloud, transparency, seeing, mist/fog, wind, gusts, temperature,
    dew point, humidity) sampled on a grid across the view, following the hour selected in the Night forecast (◀ ▶ on the map caption).
- **Home** tab — every saved location with a **next 24 h** gradient (hour ticks) and a **next 14 nights** gradient (day ticks)
  combining cloud cover, transparency and seeing into one colour; click to open that hour/night. Display preferences,
  **map quality** (High = spline-interpolated light pollution beyond zoom 8 and forecast overlays), and all import/export/backup.
- **Search** by place name or address (Nominatim), or paste coordinates in almost any form
  (`43.589, -79.644` · `43°35'20.4"N 79°38'38.4"W` · `N43 35 20 W79 38 38` · `43:35:20, -79:38:38` · Maidenhead `FN03eo`).
- **Device GPS** via the browser Geolocation API (high-accuracy fix with network fallback, accuracy shown, GPS altitude used when reported).
- **Elevation** from the Copernicus 90 m DEM (or device GPS altitude). Read-only.
- **Sky brightness / Bortle** for the selected point: zenith mag/arcsec², light-pollution zone, artificial/natural ratio and approximate
  Bortle class (Clear Sky Chart conversion of the Lorenz atlas ratios).
- **Coordinates** tab, *By program* / *By type*:
  - *By program* — N.I.N.A., ASTAP, MLAstro & generic tools, PixInsight, Siril, Stellarium, KStars / Ekos / INDI, ASCOM / SGPro / APT /
    SharpCap / MaxIm DL, LX200 / OnStep, full FITS header block. **Pin** programs to the top; **Edit** to hide programs.
  - *By type* — every distinct value once, grouped by subject; **pin** any value into a *Pinned* section at the top; **Edit** to hide groups.
  - All labels come from one format registry, e.g. `Latitude (DMS, ±DD MM SS)`; program-specific field names (SITELAT, SiteLatitude…) are shown as tags.
- **Night forecast** — 14-day hour-by-hour grid modelled on Astrospheric's layout, one row per quantity (sun altitude, moon altitude,
  moon illumination, total/low/mid/high cloud, transparency, seeing, mist/fog, wind speed, direction, gusts, temperature, dew point, humidity).
  Blue scale (darker = better); **solid red** = value missing or based on an estimated input. Hover any cell for its value; click a row label
  to open that row's data source. Show/hide values, **Edit rows** to choose rows, day dividers, timeline slider with day ticks, ←/→ and
  PgUp/PgDn, Prev / Tonight / Next night. Every section of the tab collapses (remembered).
- **Saved locations** — star a site, rename it, jump between saved sites, download the list and import it again.
- **Backup** (Home tab) — export every remembered setting (saved locations, pins, hidden rows/programs/groups, units, view, colour
  scheme, sidebar width, map layers) to a JSON file and import it to restore; reset all.
- **Colour scheme** (Home tab) — Default or **Night** (monochrome red theme for dark adaptation; map imagery converted luminance → red).
- Resizable sidebar (width remembered), eased transitions throughout, last site remembered.

## Conventions

- Longitude is **East-positive** unless a row says otherwise (`+ West` rows are for classic LX200-style protocols).
- Elevation from the DEM is height above mean sea level (≈ orthometric). `OBSGEO-X/Y/Z` treat it as ellipsoidal height;
  the geoid difference (typically tens of metres) is negligible for astrophotography.

## Running locally

It's a static site with no build step:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Browser GPS needs `https://` or `localhost`.)

## Credits

[Leaflet](https://leafletjs.com) · [SunCalc](https://github.com/mourner/suncalc) ·
[OpenStreetMap](https://www.openstreetmap.org/copyright) / [Nominatim](https://nominatim.org) ·
[Open-Meteo](https://open-meteo.com) (forecast, elevation, CAMS aerosols) ·
[Light Pollution Atlas](https://djlorenz.github.io/astronomy/lp/) by David Lorenz · Esri World Imagery · OpenTopoMap · CARTO.

MIT License.

## Forecast method notes

Cloud, visibility, wind, temperature, dew point and humidity come directly from Open-Meteo's best-match models.
Transparency is estimated from precipitable water vapour, aerosol optical depth, high-cloud fraction and surface pressure,
mapped onto Astrospheric's published transparency scale. Seeing is estimated from 300/200 hPa jet speed, 850→500→300 hPa
wind shear and surface gusts. Both are estimates, not Astrospheric's proprietary model.
