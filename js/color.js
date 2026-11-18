/* Astro Planner — perceptual colour helpers (OKLab / OKLCH, Björn Ottosson 2020). MIT License. */
(function (root) {
  'use strict';

  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function rgbToOklab([r, g, b]) {
    const R = toLin(r / 255), G = toLin(g / 255), B = toLin(b / 255);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }

  function oklabToLinear([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }

  const inGamut = (lin) => lin.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

  // OKLCH → sRGB [0..255]; out-of-gamut colours keep their lightness and hue and lose chroma.
  function oklchToRgb(L, C, h) {
    const hr = (h * Math.PI) / 180;
    let lo = 0, hi = C, c = C;
    let lin = oklabToLinear([L, c * Math.cos(hr), c * Math.sin(hr)]);
    if (!inGamut(lin)) {
      for (let i = 0; i < 20; i++) {
        c = (lo + hi) / 2;
        lin = oklabToLinear([L, c * Math.cos(hr), c * Math.sin(hr)]);
        if (inGamut(lin)) lo = c; else hi = c;
      }
      lin = oklabToLinear([L, lo * Math.cos(hr), lo * Math.sin(hr)]);
    }
    return lin.map((v) => Math.round(255 * Math.max(0, Math.min(1, toGam(Math.max(0, Math.min(1, v)))))));
  }

  function oklabToRgb(lab) {
    const lin = oklabToLinear(lab);
    return lin.map((v) => Math.round(255 * Math.max(0, Math.min(1, toGam(Math.max(0, Math.min(1, v)))))));
  }

  // Perceptual blend of two sRGB colours (t = 0 → a, 1 → b), interpolated in OKLab
  function mix(a, b, t = 0.5) {
    const A = rgbToOklab(a), B = rgbToOklab(b);
    return oklabToRgb([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }

  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const str = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  const api = { rgbToOklab, oklchToRgb, oklabToRgb, mix, hex, str };
  root.ColorOK = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
