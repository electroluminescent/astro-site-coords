/* Astro Planner — astronomical sky-quality estimates from standard NWP fields. MIT License.
 *
 * Inputs come from Open-Meteo (best-match global/regional models + CAMS aerosols).
 * Seeing and transparency are *estimates* built from the same physical drivers that
 * dedicated astronomy forecasts use (upper-level wind / shear; water vapour, aerosols,
 * thin cirrus, pressure). Scales follow Astrospheric's published conventions:
 *   Seeing        0 Cloudy · 1 Poor · 2 Below average · 3 Average · 4 Above average · 5 Excellent
 *   Transparency  0–5 Excellent · 6–9 Above average · 10–13 Average · 14–23 Below average ·
 *                 24–27 Poor · >27 Cloudy   (lower index = clearer air)
 */
(function (root) {
  'use strict';

  const CLOUDY = 80; // % total cloud above which seeing / transparency are reported as "Cloudy"
  const num = (v) => (v == null || !isFinite(v) ? null : +v);

  function uv(speed, dirDeg) {
    const r = (dirDeg * Math.PI) / 180;
    return [-speed * Math.sin(r), -speed * Math.cos(r)];
  }
  function vecDiff(s1, d1, s2, d2) {
    const a = uv(s1, d1), b = uv(s2, d2);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  /* Seeing (FWHM arcsec estimate) from jet-stream speed, vertical wind shear and surface gusts. */
  function seeing(h) {
    const ws850 = num(h.ws850), ws500 = num(h.ws500), ws300 = num(h.ws300);
    if (ws850 == null || ws500 == null || ws300 == null) return null;
    const ws200 = num(h.ws200);
    const jet = Math.max(ws300, ws200 != null ? ws200 * 0.85 : 0);
    const shear = (h.wd850 != null && h.wd500 != null && h.wd300 != null)
      ? vecDiff(ws850, h.wd850, ws500, h.wd500) + vecDiff(ws500, h.wd500, ws300, h.wd300)
      : Math.abs(ws500 - ws850) + Math.abs(ws300 - ws500);
    const gust = num(h.gust) || 0;
    let arcsec = 1.0 + 0.04 * Math.max(0, jet - 12) + 0.035 * shear + 0.06 * Math.max(0, gust - 7);
    arcsec = Math.min(6, Math.max(0.8, arcsec));
    const cls = arcsec < 1.4 ? 5 : arcsec < 1.9 ? 4 : arcsec < 2.6 ? 3 : arcsec < 3.4 ? 2 : 1;
    const cloudy = num(h.cloud) != null && h.cloud >= CLOUDY;
    return { arcsec, jet, shear, cls: cloudy ? 0 : cls, rawCls: cls };
  }

  /* Precipitable water (mm) from dew point (°C) — Reitan (1963), used only when the model gives no TCWV. */
  function pwvFromDewPoint(tdC) {
    const tdF = tdC * 9 / 5 + 32;
    return Math.exp(-0.981 + 0.0341 * tdF) * 10;
  }

  function transparency(h) {
    let pwv = num(h.tcwv), pwvEst = false;
    if (pwv == null && num(h.dew) != null) { pwv = pwvFromDewPoint(h.dew); pwvEst = true; }
    if (pwv == null) return null;
    let aod = num(h.aod), aodEst = false;
    if (aod == null) { aod = 0.1; aodEst = true; }
    const high = num(h.cloudHigh) || 0;
    const p = num(h.pressure) || 1013.25;
    const index = (0.38 * pwv + 22 * aod + 0.10 * high) * (p / 1013.25);
    const rawCls = index <= 5 ? 5 : index <= 9 ? 4 : index <= 13 ? 3 : index <= 23 ? 2 : index <= 27 ? 1 : 0;
    const cloudy = num(h.cloud) != null && h.cloud >= CLOUDY;
    return { index, pwv, pwvEst, aod, aodEst, cls: cloudy ? 0 : rawCls, rawCls };
  }

  /* Mist / fog from visibility, plus a radiation-fog risk flag from temperature–dew-point spread and wind. */
  function fog(h) {
    const vis = num(h.vis);
    const spread = num(h.temp) != null && num(h.dew) != null ? h.temp - h.dew : null;
    const wind = num(h.wind);
    let level = 0, label = 'Clear';
    if (vis != null && vis < 1000) { level = 3; label = 'Fog'; }
    else if (vis != null && vis < 5000) { level = 2; label = 'Mist'; }
    else if (spread != null && spread <= 1.5 && (wind == null || wind < 3)) { level = 1; label = 'Fog risk'; }
    return { vis, spread, level, label };
  }

  /* Dew risk for optics from the temperature – dew point spread (°C). */
  function dewRisk(spread) {
    if (spread == null) return { level: 0, label: '' };
    if (spread <= 2) return { level: 2, label: 'Fog / heavy dew likely' };
    if (spread <= 4) return { level: 1, label: 'Dew likely — run heaters' };
    return { level: 0, label: 'Low dew risk' };
  }

  const SEEING_LABELS = ['Cloudy', 'Poor', 'Below avg', 'Average', 'Above avg', 'Excellent'];
  const TRANS_LABELS = ['Cloudy', 'Poor', 'Below avg', 'Average', 'Above avg', 'Excellent'];

  const api = { seeing, transparency, fog, dewRisk, pwvFromDewPoint, vecDiff, SEEING_LABELS, TRANS_LABELS, CLOUDY };
  root.SkyModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
