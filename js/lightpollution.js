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

  const overlayUrl = `${BASE}/image_tiles/tiles${YEAR}/tile_{z}_{x}_{y}.png`;
  const errorTile = `${BASE}/image_tiles/tiles${YEAR}/black.png`;

  const api = { lookup, YEAR, ZONES, overlayUrl, errorTile, infoUrl: `${BASE}/lp/`, colorsUrl: `${BASE}/lp/colors.html`, bortleUrl: `${BASE}/lp/bortle.html` };
  root.LightPollution = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
