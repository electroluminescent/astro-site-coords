# AstroSite — observing-site coordinates for astrophotography

**Live tool:** https://electroluminescent.github.io/astro-site-coords/

Find any place on a map, by name or by coordinates (or from your device's GPS), and get every
latitude / longitude / elevation format that astrophotography software asks for — ready to click-copy.

## Features

- **Map** (Leaflet) with Dark, Streets, Satellite and Terrain layers; click the map or drag the marker to set the site.
- **Search** by place name or address (OpenStreetMap Nominatim), or paste coordinates in almost any form:
  - `43.589, -79.644` · `43.589 -79.644`
  - `43°35'20.4"N 79°38'38.4"W` · `N43 35 20 W79 38 38` · `43:35:20, -79:38:38`
  - `43 35 20.4 -79 38 38.4` (D M S pairs) · Maidenhead locators like `FN03eo`
- **Device GPS** (📍 button): uses the browser Geolocation API (Chrome, Edge, Firefox, Safari, Android, iOS).
  Requests a high-accuracy fix, falls back to a network fix, shows horizontal accuracy, and uses the GPS altitude
  as the elevation when the device reports one (alongside the DEM ground elevation for comparison).
- **Elevation** from the Copernicus 90 m DEM (Open-Meteo); editable for manual override.
- **Coordinates** tab with a **By program / By type** toggle:
  - *By program* — cards for N.I.N.A., ASTAP, MLAstro & generic tools, PixInsight, Siril, Stellarium,
    KStars / Ekos / INDI (`indi_setprop` line), ASCOM / SGPro / APT / SharpCap / MaxIm DL, LX200 / OnStep serial
    commands and a full FITS header block. **Pin** the programs you use to keep them at the top (remembered).
  - *By type* — every distinct value listed once, grouped by subject (decimal, D·M·S, arc units/radians/time,
    elevation, mount protocol, geocentric & grid, commands & FITS headers, time), tagged with the programs that use it.
  - Export as TSV (Excel/Sheets), Markdown or JSON; share links (`#lat=…&lon=…`).
- **Night forecast** — a 14-day, hour-by-hour grid modelled on Astrospheric's layout, one row per quantity:
  imaging score · sun altitude · moon altitude · moon illumination (with phase disc) · total / low / mid / high cloud ·
  transparency (Astrospheric scale) · seeing (estimated arcsec) · mist / fog (visibility) · wind speed · wind direction ·
  gusts · temperature · dew point (fog/dew-risk marks) · humidity.
  Darker blue = better. **Red cells mark hours with limited data** (an input missing and a fallback used — e.g. after the
  ~4½-day aerosol forecast ends); hatched cells have no data. Scroll the grid, drag the slider, use ←/→ and PgUp/PgDn, or
  the Prev / Tonight / Next night buttons; the selected hour shows a full breakdown and the night's twilight and moon times.
- The last selected site, units, view and pins are remembered in the browser.
- **Night mode** (red) for use at the telescope, and shareable links (`#lat=…&lon=…`).

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
[Open-Meteo](https://open-meteo.com) (forecast, elevation, CAMS aerosols) · Esri World Imagery · OpenTopoMap · CARTO.

MIT License.

## Forecast method notes

Cloud, visibility, wind, temperature, dew point and humidity come directly from Open-Meteo's best-match models.
Transparency is estimated from precipitable water vapour, aerosol optical depth, high-cloud fraction and surface pressure,
mapped onto Astrospheric's published transparency scale. Seeing is estimated from 300/200 hPa jet speed, 850→500→300 hPa
wind shear and surface gusts. Both are estimates, not Astrospheric's proprietary model.
