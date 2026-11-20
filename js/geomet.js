/* Astro Planner — direct access to Environment and Climate Change Canada's MSC GeoMet (no API key, CORS-enabled).
 *
 * One WCS GetCoverage request returns a whole model field (one variable, one hour) for a bounding box as an
 * uncompressed float32 GeoTIFF, so a map overlay costs one request per layer per hour instead of one call per point.
 *   RDPS 10 km — northern hemisphere, hourly to +84 h (also CMC's astronomical seeing and sky-transparency indices)
 *   GDPS 15 km — global, hourly then 3-hourly to +240 h
 * MSC usage policy: stay well under ~1 request/second sustained; requests are paced and fields cached.
 * MIT License.
 */
(function (root) {
  'use strict';

  const BASE = 'https://geo.weather.gc.ca/geomet';
  // Open-Meteo variable name → GeoMet coverage suffix (per model)
  const VARS = {
    RDPS: {
      cloud_cover: 'TotalCloudCover', temperature_2m: 'AirTemp_2m', dew_point_2m: 'DewPoint_2m',
      relative_humidity_2m: 'RelativeHumidity_2m', wind_speed_10m: 'WindSpeed_10m', wind_gusts_10m: 'WindGust_10m',
      cmc_seeing: 'SeeingIndex', cmc_transparency: 'SkyTransparencyIndex',
    },
    GDPS: {
      cloud_cover: 'TotalCloudCover', temperature_2m: 'AirTemp_2m', dew_point_2m: 'DewPoint_2m',
      relative_humidity_2m: 'RelativeHumidity_2m', wind_speed_10m: 'WindSpeed_10m', wind_gusts_10m: 'WindGust_10m',
    },
  };
  const PREFIX = { RDPS: 'RDPS_10km_', GDPS: 'GDPS_15km_' };
  const NATIVE = { RDPS: 0.09, GDPS: 0.15 };      // native grid spacing (degrees, approx.)
  const RDPS_SOUTH = -3.8;                         // RDPS domain: northern hemisphere

  /* ---------- request pacing (polite: ≤ 3 in flight, ≥ 250 ms apart) ---------- */
  let inFlight = 0, lastStart = 0;
  const queue = [];
  function pump() {
    while (inFlight < 3 && queue.length) {
      const wait = lastStart + 250 - Date.now();
      if (wait > 0) { setTimeout(pump, wait); return; }
      const job = queue.shift();
      if (job.stale && job.stale()) { job.reject(new Error('superseded')); continue; } // the view or hour moved on
      inFlight++; lastStart = Date.now();
      job.run().then(job.resolve, job.reject).finally(() => { inFlight--; pump(); });
    }
  }
  const paced = (run, stale) => new Promise((resolve, reject) => { queue.push({ run, resolve, reject, stale }); pump(); });

  /* ---------- model run times (from the layer-specific WMS GetCapabilities, cached 20 min) ---------- */
  const timesMemo = new Map();
  function parseTimes(s) {
    if (!s) return null;
    s = s.trim();
    if (s.includes('/')) {
      const [a, b, step] = s.split('/');
      const h = /PT(\d+)H/.exec(step || 'PT1H');
      return { start: Date.parse(a), end: Date.parse(b), step: (h ? +h[1] : 1) * 3600000, list: null };
    }
    const list = s.split(',').map((x) => Date.parse(x)).filter(isFinite);
    return { start: list[0], end: list[list.length - 1], step: 0, list: new Set(list) };
  }
  async function times(model) {
    const m = timesMemo.get(model);
    if (m && Date.now() - m.at < 20 * 60000) return m.p;
    const p = paced(async () => {
      const r = await fetch(`${BASE}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${PREFIX[model]}TotalCloudCover`);
      const txt = await r.text();
      const d = /<Dimension name="time"[^>]*>([^<]*)/.exec(txt);
      const ref = /<Dimension name="reference_time"[^>]*>([^<]*)/.exec(txt);
      const t = parseTimes(d && d[1]);
      if (!t) throw new Error('GeoMet: no time dimension');
      t.ref = ref ? ref[1].split('/')[1] || ref[1] : '';
      return t;
    });
    timesMemo.set(model, { at: Date.now(), p });
    p.catch(() => timesMemo.delete(model));
    return p;
  }
  const hasTime = (tm, t) => !!tm && t >= tm.start && t <= tm.end && (tm.list ? tm.list.has(t) : (t - tm.start) % tm.step === 0);

  /* ---------- float32 GeoTIFF reader (what GeoMet's WCS returns: uncompressed, strips, EPSG:4326) ---------- */
  function readTiff(buf) {
    const dv = new DataView(buf);
    const le = dv.getUint16(0) === 0x4949;
    const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
    if (u16(2) !== 42) throw new Error('GeoMet: not a GeoTIFF');
    const ifd = u32(4), n = u16(ifd), tags = {};
    const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 };
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), sz = SZ[type] || 1;
      const off = sz * cnt <= 4 ? e + 8 : u32(e + 8);
      const v = [];
      for (let j = 0; j < cnt && j < 4096; j++) {
        const o = off + j * sz;
        v.push(type === 3 ? u16(o) : type === 4 ? u32(o) : type === 12 ? dv.getFloat64(o, le) : type === 11 ? dv.getFloat32(o, le) : dv.getUint8(o));
      }
      tags[tag] = type === 2 ? String.fromCharCode(...v).replace(/\0+$/, '') : v;
    }
    const W = tags[256][0], H = tags[257][0];
    if ((tags[259] || [1])[0] !== 1 || (tags[258] || [32])[0] !== 32 || (tags[339] || [3])[0] !== 3) throw new Error('GeoMet: unsupported GeoTIFF encoding');
    const offs = tags[273], rps = (tags[278] || [H])[0];
    const data = new Float32Array(W * H);
    const nodata = tags[42113] ? parseFloat(tags[42113]) : NaN;
    offs.forEach((o, s) => {
      const rows = Math.min(rps, H - s * rps);
      for (let i = 0; i < rows * W; i++) {
        const v = dv.getFloat32(o + i * 4, le);
        data[s * rps * W + i] = !isFinite(v) || v === nodata || Math.abs(v) > 1e20 ? NaN : v;
      }
    });
    const scale = tags[33550], tie = tags[33922];
    if (!scale || !tie) throw new Error('GeoMet: GeoTIFF without georeference');
    // pixel-is-area: (tie[3], tie[4]) is the top-left corner of the first pixel
    return { W, H, x0: tie[3] - tie[0] * scale[0], y0: tie[4] + tie[1] * scale[1], dx: scale[0], dy: scale[1], data };
  }

  /* ---------- fields (memory LRU) ---------- */
  const mem = new Map();
  const MAX_FIELDS = 240;
  function remember(k, v) { mem.delete(k); mem.set(k, v); while (mem.size > MAX_FIELDS) mem.delete(mem.keys().next().value); }
  let reqCount = 0;

  // bbox: {w,s,e,n} in degrees (w<e, no dateline crossing); res: degrees per pixel
  // stale(): optional; when it returns true before the request starts, the request is dropped
  function field(model, omVar, t, bbox, res, stale) {
    const cov = PREFIX[model] + VARS[model][omVar];
    const iso = new Date(t).toISOString().slice(0, 19) + 'Z';
    const key = `${cov}|${iso}|${bbox.w},${bbox.s},${bbox.e},${bbox.n}|${res}`;
    if (mem.has(key)) { const v = mem.get(key); remember(key, v); return v; }
    const p = paced(async () => {
      const url = `${BASE}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=${cov}&SUBSETTINGCRS=EPSG:4326&OUTPUTCRS=EPSG:4326`
        + `&SUBSET=x(${bbox.w},${bbox.e})&SUBSET=y(${bbox.s},${bbox.n})&RESOLUTION=x(${res})&RESOLUTION=y(${res})&TIME=${iso}&FORMAT=image/tiff`;
      reqCount++;
      const r = await fetch(url);
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !/tiff/.test(ct)) {
        const txt = await r.text().catch(() => '');
        const m = /<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/.exec(txt);
        throw new Error(`GeoMet ${cov}: ${m ? m[1].trim() : `HTTP ${r.status}`}`);
      }
      return readTiff(await r.arrayBuffer());
    }, stale);
    remember(key, p);
    p.catch(() => mem.delete(key));
    return p;
  }

  function sample(f, lat, lon) {
    if (!f) return NaN;
    const fx = (lon - f.x0) / f.dx - 0.5, fy = (f.y0 - lat) / f.dy - 0.5;
    if (fx < -0.5 || fy < -0.5 || fx > f.W - 0.5 || fy > f.H - 0.5) return NaN;
    const x0 = Math.max(0, Math.min(f.W - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(f.H - 1, Math.floor(fy)));
    const x1 = Math.min(f.W - 1, x0 + 1), y1 = Math.min(f.H - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    let acc = 0, ws = 0;
    [[y0, x0, (1 - tx) * (1 - ty)], [y0, x1, tx * (1 - ty)], [y1, x0, (1 - tx) * ty], [y1, x1, tx * ty]].forEach(([y, x, w]) => {
      const v = f.data[y * f.W + x];
      if (w > 0 && !Number.isNaN(v)) { acc += v * w; ws += w; }
    });
    return ws > 0 ? acc / ws : NaN;
  }

  // Which model (if any) serves hour t over this bbox
  async function modelFor(t, bbox) {
    const out = [];
    if (bbox.s >= RDPS_SOUTH) out.push('RDPS');
    out.push('GDPS');
    for (const m of out) {
      try { if (hasTime(await times(m), t)) return m; } catch (e) { /* unavailable: try next */ }
    }
    return null;
  }
  const serves = (model, omVar) => !!(model && VARS[model][omVar]);

  // Snap a view box outward so small pans reuse the same fields; resolution suits the requested spacing
  function snapBox(b, spacingDeg, model) {
    const res = Math.max(NATIVE[model], Math.min(1, +(spacingDeg / 2).toPrecision(2)));
    const step = Math.max(1, res * 32);
    const w = Math.max(-180, Math.floor(b.w / step) * step), e = Math.min(180, Math.ceil(b.e / step) * step);
    const s = Math.max(-90, Math.floor(b.s / step) * step), n = Math.min(90, Math.ceil(b.n / step) * step);
    return { box: { w: +w.toFixed(4), s: +s.toFixed(4), e: +e.toFixed(4), n: +n.toFixed(4) }, res };
  }

  const api = { VARS, PREFIX, times, hasTime, field, sample, modelFor, serves, snapBox, readTiff, requests: () => reqCount, RDPS_SOUTH };
  root.GeoMet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
