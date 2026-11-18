/* Astro Planner — artificial sky brightness lookup from David Lorenz's Light Pollution Atlas.
 * Data: https://djlorenz.github.io/astronomy/lp/  (VIIRS-based world atlas, 1/120° grid, 65°S–75°N)
 * Decoding mirrors the atlas's own overlay page. Bortle mapping follows the Clear Sky Chart
 * "Conditions at Zenith" table, which is keyed to the same artificial/natural brightness ratios. MIT License.
 */
(function (root) {
  'use strict';

  const YEAR = 2025;
  const BASE = 'https://djlorenz.github.io/astronomy';
  const cache = new Map();
  const mod = (n, m) => ((n % m) + m) % m;

  // ratio upper bound, LP zone, zone colour, approx Bortle class
  const ZONES = [
    [0.01, '0', '#000000', '1'],
    [0.06, '1a', '#222222', '2'],
    [0.11, '1b', '#424242', '2'],
    [0.19, '2a', '#142f72', '3'],
    [0.33, '2b', '#2154d8', '3'],
    [0.58, '3a', '#0f5714', '4'],
    [1.00, '3b', '#1fa12a', '4'],
    [1.73, '4a', '#6e641e', '4.5'],
    [3.00, '4b', '#b8a625', '4.5'],
    [5.20, '5a', '#bf641e', '5'],
    [9.00, '5b', '#fd9650', '5'],
    [15.59, '6a', '#fb5a49', '6'],
    [27.00, '6b', '#fb998a', '7'],
    [46.77, '7a', '#a0a0a0', '8'],
    [Infinity, '7b', '#f2f2f2', '9'],
  ];

  async function gunzip(buf) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser lacks gzip decompression');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Int8Array(await new Response(stream).arrayBuffer());
  }

  async function tile(year, tx, ty) {
    const key = `${year}/${tx}/${ty}`;
    if (!cache.has(key)) {
      cache.set(key, fetch(`${BASE}/binary_tiles/${year}/binary_tile_${tx}_${ty}.dat.gz`)
        .then((r) => { if (!r.ok) throw new Error(`Atlas tile ${r.status}`); return r.arrayBuffer(); })
        .then(gunzip)
        .catch((e) => { cache.delete(key); throw e; }));
    }
    return cache.get(key);
  }

  async function lookup(lat, lon, year = YEAR) {
    const lonFromDateLine = mod(lon + 180, 360);
    const latFromStart = lat + 65;
    const tx = Math.floor(lonFromDateLine / 5) + 1;
    const ty = Math.floor(latFromStart / 5) + 1;
    if (ty < 1 || ty > 28) return { outOfBounds: true, year };
    const ix = Math.round(120 * (lonFromDateLine - 5 * (tx - 1) + 1 / 240));
    const iy = Math.round(120 * (latFromStart - 5 * (ty - 1) + 1 / 240));
    const d = await tile(year, tx, ty);
    let value = 128 * d[0] + d[1];
    for (let i = 1; i < iy; i++) value += d[600 * i + 1];
    for (let i = 1; i < ix; i++) value += d[600 * (iy - 1) + 1 + i];
    const ratio = (5 / 195) * (Math.exp(0.0195 * value) - 1);
    const sqm = 22 - (5 * Math.log(1 + ratio)) / Math.log(100);
    const z = ZONES.find((row) => ratio < row[0]);
    return { year, ratio, sqm, zone: z[1], zoneColor: z[2], bortle: z[3], nelm: nelmFromSqm(sqm) };
  }

  // Naked-eye limiting magnitude from zenith sky brightness (Schaefer-style approximation commonly used with SQM)
  function nelmFromSqm(sqm) {
    return 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1);
  }

  /* ---- High-quality rendering: decode whole atlas tiles and sample with a bicubic (Catmull-Rom) spline ---- */
  const decodedCache = new Map();
  function decodeAll(d) {
    const out = new Float32Array(360000);
    let rowStart = 128 * d[0] + d[1];
    for (let r = 0; r < 600; r++) {
      if (r > 0) rowStart += d[600 * r + 1];
      let v = rowStart;
      out[r * 600] = v;
      for (let c = 1; c < 600; c++) { v += d[600 * r + 1 + c]; out[r * 600 + c] = v; }
    }
    return out;
  }
  function decodedTile(tx, ty, year = YEAR) {
    const key = `${year}/${tx}/${ty}`;
    if (!decodedCache.has(key)) {
      decodedCache.set(key, tile(year, tx, ty).then(decodeAll).catch(() => null));
    }
    return decodedCache.get(key);
  }
  const toRatio = (x) => (5 / 195) * (Math.exp(0.0195 * x) - 1);
  const ZONE_RGB = ZONES.map((z) => [z[0], parseInt(z[2].slice(1, 3), 16), parseInt(z[2].slice(3, 5), 16), parseInt(z[2].slice(5, 7), 16)]);
  // Value-space (compressed atlas value) centre of each zone: midpoint between its lower and upper bounds.
  const toX = (ratio) => Math.log(ratio * 39 + 1) / 0.0195;      // inverse of toRatio
  const ZONE_CENTERS = (() => {
    const bounds = [0, ...ZONES.slice(0, -1).map((z) => toX(z[0]))];
    const centers = bounds.slice(0, -1).map((b, k) => (b + bounds[k + 1]) / 2);
    const lastW = bounds[bounds.length - 1] - bounds[bounds.length - 2];
    centers.push(bounds[bounds.length - 1] + lastW / 2);
    return centers;
  })();
  function smoothColour(x) {
    const C = ZONE_CENTERS;
    if (x <= C[0]) return ZONE_RGB[0];
    if (x >= C[C.length - 1]) return ZONE_RGB[C.length - 1];
    let k = 0;
    while (k < C.length - 2 && x > C[k + 1]) k++;
    const t = (x - C[k]) / (C[k + 1] - C[k]);
    const a = ZONE_RGB[k], b = ZONE_RGB[k + 1];
    return [0, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  }
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };

  /* The atlas stores integers, so dark, flat regions form 1-step terraces whose edges follow the grid and show up
     as stair-steps once a zone boundary runs along them. Where the local range is only about one step, blend in a
     Gaussian-smoothed estimate of the true surface; where the field changes faster (real features) keep the data. */
  function dequantize(win, W, H) {
    const sigma = 2.5, R = 7;
    const k = [];
    let ks = 0;
    for (let i = -R; i <= R; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); ks += w; }
    const tmp = new Float32Array(W * H), blur = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, wsum = 0;
        for (let i = -R; i <= R; i++) {
          const xx = x + i; if (xx < 0 || xx >= W) continue;
          const v = win[y * W + xx]; if (!isFinite(v)) continue;
          sum += v * k[i + R]; wsum += k[i + R];
        }
        tmp[y * W + x] = wsum ? sum / wsum : NaN;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, wsum = 0;
        for (let i = -R; i <= R; i++) {
          const yy = y + i; if (yy < 0 || yy >= H) continue;
          const v = tmp[yy * W + x]; if (!isFinite(v)) continue;
          sum += v * k[i + R]; wsum += k[i + R];
        }
        blur[y * W + x] = wsum ? sum / wsum : NaN;
      }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = y * W + x, v = win[o];
        if (!isFinite(v)) { out[o] = NaN; continue; }
        let lo = v, hi = v;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
            const n = win[yy * W + xx]; if (!isFinite(n)) continue;
            if (n < lo) lo = n; if (n > hi) hi = n;
          }
        }
        const w = Math.max(0, Math.min(1, 1 - (hi - lo - 1) / 3)); // range ≤1 step → fully smoothed; ≥4 → raw data
        out[o] = isFinite(blur[o]) ? v + (blur[o] - v) * w : v;
      }
    }
    return out;
  }

  // Render one 256-px web-mercator tile into a canvas. lonAt(px) / latAt(py) map pixel centres to degrees.
  async function renderHQ(canvas, lonAt, latAt, size = 256, smooth = false) {
    const lons = new Float64Array(size), lats = new Float64Array(size);
    for (let i = 0; i < size; i++) { lons[i] = lonAt(i + 0.5); lats[i] = latAt(i + 0.5); }
    const fx = (lon) => mod(lon + 180, 360) * 120 - 0.5;
    const fy = (lat) => (lat + 65) * 120 - 0.5;
    const M = 9; // margin (cells) for the de-terracing filter + bicubic support
    let gx0 = Math.floor(Math.min(fx(lons[0]), fx(lons[size - 1]))) - M, gx1 = Math.ceil(Math.max(fx(lons[0]), fx(lons[size - 1]))) + M;
    const gyA = Math.floor(fy(Math.min(lats[0], lats[size - 1]))) - M, gyB = Math.ceil(fy(Math.max(lats[0], lats[size - 1]))) + M;
    if (gyB < 0 || gyA > 28 * 600 - 1) return false;               // outside atlas coverage
    if (gx1 - gx0 > 1500 || gyB - gyA > 1500) return false;         // too large: let the image tiles handle low zooms
    const W = gx1 - gx0 + 1, Hh = gyB - gyA + 1;
    const win = new Float32Array(W * Hh).fill(NaN);
    const need = new Map();
    for (let gy = Math.max(0, gyA); gy <= Math.min(28 * 600 - 1, gyB); gy += 1) {
      const ty = Math.floor(gy / 600) + 1;
      for (let gx = gx0; gx <= gx1; gx += 1) {
        const gxw = mod(gx, 43200), tx = Math.floor(gxw / 600) + 1;
        need.set(`${tx},${ty}`, [tx, ty]);
        gx += Math.min(gx1 - gx, 599 - (gxw % 600));               // skip to the next tile column
      }
      gy += Math.min(gyB - gy, 599 - (gy % 600));
    }
    const tiles = new Map();
    await Promise.all([...need.values()].map(async ([tx, ty]) => tiles.set(`${tx},${ty}`, await decodedTile(tx, ty))));
    for (let gy = gyA; gy <= gyB; gy++) {
      if (gy < 0 || gy >= 28 * 600) continue;
      const ty = Math.floor(gy / 600) + 1, r = gy % 600;
      for (let gx = gx0; gx <= gx1; gx++) {
        const gxw = mod(gx, 43200), tx = Math.floor(gxw / 600) + 1;
        const arr = tiles.get(`${tx},${ty}`);
        if (arr) win[(gy - gyA) * W + (gx - gx0)] = arr[r * 600 + (gxw % 600)];
      }
    }
    const field = dequantize(win, W, Hh);
    const at = (x, y) => {
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(Hh - 1, y));
      return field[y * W + x];
    };
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let py = 0; py < size; py++) {
      const yy = fy(lats[py]) - gyA;
      const y1 = Math.floor(yy), ty = yy - y1;
      for (let px = 0; px < size; px++) {
        const xx = fx(lons[px]) - gx0;
        const x1 = Math.floor(xx), tx = xx - x1;
        const c0 = cr(at(x1 - 1, y1 - 1), at(x1, y1 - 1), at(x1 + 1, y1 - 1), at(x1 + 2, y1 - 1), tx);
        const c1 = cr(at(x1 - 1, y1), at(x1, y1), at(x1 + 1, y1), at(x1 + 2, y1), tx);
        const c2 = cr(at(x1 - 1, y1 + 1), at(x1, y1 + 1), at(x1 + 1, y1 + 1), at(x1 + 2, y1 + 1), tx);
        const c3 = cr(at(x1 - 1, y1 + 2), at(x1, y1 + 2), at(x1 + 1, y1 + 2), at(x1 + 2, y1 + 2), tx);
        const v = cr(c0, c1, c2, c3, ty);
        const o = (py * size + px) * 4;
        if (!isFinite(v)) { data[o + 3] = 0; continue; }
        let z;
        if (smooth) z = smoothColour(v);
        else {
          const ratio = toRatio(v);
          z = ZONE_RGB[ZONE_RGB.length - 1];
          for (let k = 0; k < ZONE_RGB.length; k++) { if (ratio < ZONE_RGB[k][0]) { z = ZONE_RGB[k]; break; } }
        }
        data[o] = z[1]; data[o + 1] = z[2]; data[o + 2] = z[3]; data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return true;
  }

  const overlayUrl = `${BASE}/image_tiles/tiles${YEAR}/tile_{z}_{x}_{y}.png`;
  const errorTile = `${BASE}/image_tiles/tiles${YEAR}/black.png`;

  const api = { lookup, renderHQ, _smoothColour: smoothColour, _zoneCenters: ZONE_CENTERS, YEAR, ZONES, overlayUrl, errorTile, infoUrl: `${BASE}/lp/`, colorsUrl: `${BASE}/lp/colors.html`, bortleUrl: `${BASE}/lp/bortle.html` };
  root.LightPollution = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
