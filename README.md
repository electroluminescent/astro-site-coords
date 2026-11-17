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
- **All values** table — decimal degrees (E+ / W+ / 0–360°), DMS (Unicode & ASCII), signed `sDD:MM:SS`,
  space-separated FITS-string style, degrees + decimal minutes, arcminutes, arcseconds, radians,
  longitude as time, elevation in m/ft/km, geocentric `OBSGEO-X/Y/Z`, Maidenhead, time zone,
  live local sidereal time, GMST and Julian date. Export as TSV (Excel/Sheets), Markdown or JSON.
- **By program** presets: N.I.N.A., ASTAP, MLAstro & generic tools, PixInsight, Siril, Stellarium,
  KStars / Ekos / INDI (`indi_setprop` line), ASCOM / SGPro / APT / SharpCap / MaxIm DL,
  LX200 / OnStep serial commands, and a full FITS header block.
- **Tonight & polar**: sunset/sunrise, civil / nautical / astronomical twilight, dark hours, moon-free
  dark time, moon phase, hourly cloud-cover forecast strip, and live Polaris / σ Octantis hour angle with a
  polar-scope reticle (naked-eye or inverted view).
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
[Open-Meteo](https://open-meteo.com) · Esri World Imagery · OpenTopoMap · CARTO.

MIT License.
