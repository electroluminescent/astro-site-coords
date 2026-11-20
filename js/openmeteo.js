/* Astro Planner — Open-Meteo access layer: endpoint selection, call-weight accounting, caching and back-off.
 *
 * Free Open-Meteo limits apply per IP (600/min, 5,000/hour, 10,000/day). One location with up to 10 variables over
 * up to 14 days is one call; more variables or days count fractionally more, and every location counts separately.
 * Requests are paced so this browser stays well inside the per-minute and hourly limits.
 * MIT License.
 */
(function (root) {
  'use strict';

  const LS = (() => { try { return root.localStorage; } catch (e) { return null; } })();
  const CACHE_PREFIX = 'apcache.';           // not part of exported config
  const KEY_STORE = 'astrosite.omApiKey';    // optional customer API key (part of config)
  const mem = new Map();
  let cooldownUntil = 0;
  let onLimit = null;

  try { cooldownUntil = +(LS && LS.getItem(`${CACHE_PREFIX}cooldown`)) || 0; } catch (e) { /* ignore */ }

  const apiKey = () => { try { return (LS && LS.getItem(KEY_STORE)) || ''; } catch (e) { return ''; } };
  function base(kind) {
    const k = apiKey();
    const host = {
      forecast: k ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast',
      elevation: k ? 'https://customer-api.open-meteo.com/v1/elevation' : 'https://api.open-meteo.com/v1/elevation',
      aq: k ? 'https://customer-air-quality-api.open-meteo.com/v1/air-quality' : 'https://air-quality-api.open-meteo.com/v1/air-quality',
    }[kind];
    return { url: host, key: k };
  }

  // Estimated call weight (Open-Meteo: 1 call per location for ≤10 variables over ≤14 days, fractional beyond)
  function weight(locations, nVars, days) {
    return locations * Math.max(1, nVars / 10) * Math.max(1, days / 14);
  }
  // Self-imposed budgets, below Open-Meteo's free limits (other devices on the same IP share those)
  const MINUTE_BUDGET = 400, HOUR_BUDGET = 4000;
  const recent = []; // [time, weight] of requests sent in the last minute (this tab)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function pace(w) {
    for (;;) {
      const now = Date.now();
      while (recent.length && now - recent[0][0] > 60000) recent.shift();
      const used = recent.reduce((a, x) => a + x[1], 0);
      if (!recent.length || used + w <= MINUTE_BUDGET) { recent.push([now, w]); return; }
      await sleep(Math.max(500, 60000 - (now - recent[0][0]) + 200));
    }
  }

  function hourBucket() { return Math.floor(Date.now() / 3600000); }
  function addUsage(w) {
    try {
      const raw = JSON.parse((LS && LS.getItem(`${CACHE_PREFIX}usage`)) || '{}');
      const b = hourBucket(), d = Math.floor(b / 24);
      const u = { hour: raw.hour === b ? raw.hourCalls || 0 : 0, day: raw.day === d ? raw.dayCalls || 0 : 0 };
      LS && LS.setItem(`${CACHE_PREFIX}usage`, JSON.stringify({ hour: b, hourCalls: u.hour + w, day: d, dayCalls: u.day + w }));
    } catch (e) { /* ignore */ }
  }
  function usage() {
    try {
      const raw = JSON.parse((LS && LS.getItem(`${CACHE_PREFIX}usage`)) || '{}');
      const b = hourBucket();
      return { hour: raw.hour === b ? Math.round(raw.hourCalls) : 0, day: raw.day === Math.floor(b / 24) ? Math.round(raw.dayCalls) : 0 };
    } catch (e) { return { hour: 0, day: 0 }; }
  }

  function setCooldown(reason) {
    const now = Date.now();
    let until;
    if (/minut/i.test(reason)) until = now + 65000;
    else if (/daily|day/i.test(reason)) { const d = new Date(); d.setUTCHours(24, 1, 0, 0); until = d.getTime(); }
    else until = (Math.floor(now / 3600000) + 1) * 3600000 + 60000; // hourly (default)
    cooldownUntil = until;
    try { LS && LS.setItem(`${CACHE_PREFIX}cooldown`, String(until)); } catch (e) { /* ignore */ }
    if (onLimit) onLimit(until, reason);
  }
  const limited = () => Date.now() < cooldownUntil;

  class LimitError extends Error {
    constructor(until, reason) { super(`Open-Meteo limit reached (${reason || 'too many requests'})`); this.until = until; this.limit = true; }
  }

  async function request(kind, params, meta) {
    if (limited()) throw new LimitError(cooldownUntil, 'cooling down');
    const w = weight(meta.locations || 1, meta.vars || 1, meta.days || 1);
    if (!apiKey() && usage().hour + w > HOUR_BUDGET) { setCooldown('hourly budget'); throw new LimitError(cooldownUntil, 'hourly budget'); }
    if (!apiKey()) await pace(w);
    if (limited()) throw new LimitError(cooldownUntil, 'cooling down');
    const { url, key } = base(kind);
    const full = `${url}?${params}${key ? `&apikey=${encodeURIComponent(key)}` : ''}`;
    let res;
    try { res = await fetch(full); } catch (e) { throw new Error('network error'); }
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    const reason = body && (body.reason || body.error_message) ? String(body.reason || body.error_message) : '';
    if (res.status === 429 || /limit/i.test(reason)) { setCooldown(reason || 'hourly'); throw new LimitError(cooldownUntil, reason); }
    if (!res.ok || (body && body.error)) throw new Error(reason || `HTTP ${res.status}`);
    addUsage(w);
    if (root.ReqUsage) root.ReqUsage.record({ forecast: 'om-forecast', aq: 'om-aq', elevation: 'om-elevation' }[kind] || 'om-forecast');
    return body;
  }

  // Simple TTL cache in memory + localStorage (falls back gracefully when storage is full)
  function cacheGet(key, maxAgeMs) {
    let e = mem.get(key);
    if (!e && LS) { try { e = JSON.parse(LS.getItem(CACHE_PREFIX + key) || 'null'); if (e) mem.set(key, e); } catch (err) { e = null; } }
    if (!e) return null;
    return { data: e.data, at: e.at, fresh: Date.now() - e.at < maxAgeMs };
  }
  function cacheSet(key, data) {
    const e = { at: Date.now(), data };
    mem.set(key, e);
    if (!LS) return;
    try { LS.setItem(CACHE_PREFIX + key, JSON.stringify(e)); } catch (err) {
      // storage full: drop the oldest cache entries and retry once
      try {
        const keys = Object.keys(LS).filter((k) => k.startsWith(CACHE_PREFIX) && !/cooldown|usage/.test(k));
        keys.map((k) => { let at = 0; try { at = JSON.parse(LS.getItem(k)).at || 0; } catch (x) { /* ignore */ } return [k, at]; })
          .sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(keys.length / 2)).forEach(([k]) => LS.removeItem(k));
        LS.setItem(CACHE_PREFIX + key, JSON.stringify(e));
      } catch (x) { /* give up on persistence */ }
    }
  }

  // Fetch with cache: returns fresh cache if available; otherwise requests; on failure returns stale cache when present.
  async function cached(key, maxAgeMs, fn) {
    const c = cacheGet(key, maxAgeMs);
    if (c && c.fresh) return { data: c.data, stale: false };
    try {
      const data = await fn();
      cacheSet(key, data);
      return { data, stale: false };
    } catch (err) {
      if (c) return { data: c.data, stale: true, error: err };
      throw err;
    }
  }

  const api = {
    request, weight, usage, MINUTE_BUDGET, HOUR_BUDGET, cached, cacheGet, cacheSet, limited,
    cooldownUntil: () => cooldownUntil,
    onLimit: (fn) => { onLimit = fn; },
    apiKey, setApiKey: (k) => { try { if (k) LS.setItem(KEY_STORE, k.trim()); else LS.removeItem(KEY_STORE); } catch (e) { /* ignore */ } },
    LimitError,
  };
  root.OpenMeteo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
