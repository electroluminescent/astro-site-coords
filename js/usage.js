/* Astro Planner — counts of successful requests per service, bucketed by hour (this browser, last 48 hours).
 * Stored under apcache.* (a cache, not part of exported config). MIT License.
 */
(function (root) {
  'use strict';

  const KEY = 'apcache.reqlog';
  const KEEP_HOURS = 48;
  const LS = (() => { try { return root.localStorage; } catch (e) { return null; } })();
  // Display order and names
  const SERVICES = [
    ['om-forecast', 'Open-Meteo forecast'],
    ['om-aq', 'Open-Meteo air quality'],
    ['om-elevation', 'Open-Meteo elevation'],
    ['geomet', 'ECCC GeoMet'],
    ['gibs', 'NASA GIBS satellite'],
    ['lp', 'Light pollution atlas'],
    ['nominatim', 'Nominatim search'],
    ['basemap', 'Base map tiles'],
  ];
  const hourBucket = (t = Date.now()) => Math.floor(t / 3600000);

  let log = {};
  try { log = JSON.parse((LS && LS.getItem(KEY)) || '{}') || {}; } catch (e) { log = {}; }
  let saveTimer = 0;
  const listeners = new Set();
  function save() {
    saveTimer = 0;
    const min = hourBucket() - KEEP_HOURS;
    Object.keys(log).forEach((h) => { if (+h < min) delete log[h]; });
    try { LS && LS.setItem(KEY, JSON.stringify(log)); } catch (e) { /* ignore */ }
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
  }
  function record(service, n = 1) {
    // pick up counts written by other tabs before adding ours
    if (!saveTimer) { try { log = JSON.parse((LS && LS.getItem(KEY)) || '{}') || log; } catch (e) { /* ignore */ } }
    const h = hourBucket();
    const b = log[h] || (log[h] = {});
    b[service] = (b[service] || 0) + n;
    if (!saveTimer) saveTimer = setTimeout(save, 1000);
  }
  // {service: {now, prev, day}} — this hour, previous hour, last 24 hours
  function summary() {
    if (!saveTimer) { try { log = JSON.parse((LS && LS.getItem(KEY)) || '{}') || log; } catch (e) { /* ignore */ } }
    const h = hourBucket(), out = {};
    SERVICES.forEach(([id]) => {
      let day = 0;
      for (let i = 0; i < 24; i++) day += ((log[h - i] || {})[id]) || 0;
      out[id] = { now: ((log[h] || {})[id]) || 0, prev: ((log[h - 1] || {})[id]) || 0, day };
    });
    return out;
  }
  // Counts per hour for one service, oldest first (last n hours)
  function series(service, n = 24) {
    const h = hourBucket(), out = [];
    for (let i = n - 1; i >= 0; i--) out.push(((log[h - i] || {})[service]) || 0);
    return out;
  }

  const api = { SERVICES, record, summary, series, onChange: (fn) => listeners.add(fn) };
  root.ReqUsage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
