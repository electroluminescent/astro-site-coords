/* AstroSite — pure coordinate / astronomy helpers (no DOM). MIT License. */
(function (root) {
  'use strict';

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  const pad = (n, w) => String(n).padStart(w, '0');
  const mod = (a, n) => ((a % n) + n) % n;

  /* ---------- Sexagesimal formatting ---------- */

  // Split an absolute value into [deg, min, sec] with rounding carried correctly.
  function toSexagesimal(value, secDecimals) {
    const abs = Math.abs(value);
    const scale = Math.pow(10, secDecimals);
    let totalSec = Math.round(abs * 3600 * scale) / scale;
    let d = Math.floor(totalSec / 3600);
    totalSec -= d * 3600;
    let m = Math.floor(totalSec / 60 + 1e-9);
    let s = totalSec - m * 60;
    s = Math.round(s * scale) / scale;
    if (s >= 60) { s -= 60; m += 1; }
    if (m >= 60) { m -= 60; d += 1; }
    return [d, m, s];
  }

  function fmtSec(s, dec) {
    const str = s.toFixed(dec);
    const intLen = dec > 0 ? 2 + 1 + dec : 2;
    return str.padStart(intLen, '0');
  }

  // 43° 35′ 20.40″ N
  function dmsHemi(value, isLat, dec = 2) {
    const [d, m, s] = toSexagesimal(value, dec);
    const hemi = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
    return `${d}° ${pad(m, 2)}′ ${fmtSec(s, dec)}″ ${hemi}`;
  }

  // ASCII-safe: 43°35'20.40"N
  function dmsAscii(value, isLat, dec = 2) {
    const [d, m, s] = toSexagesimal(value, dec);
    const hemi = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
    return `${d}°${pad(m, 2)}'${fmtSec(s, dec)}"${hemi}`;
  }

  // +43:35:20.40  (sep configurable)
  function dmsSigned(value, sep = ':', dec = 2, degWidth = 2) {
    const [d, m, s] = toSexagesimal(value, dec);
    const sign = value < 0 ? '-' : '+';
    return `${sign}${pad(d, degWidth)}${sep}${pad(m, 2)}${sep}${fmtSec(s, dec)}`;
  }

  // 43° 35.3400′ N
  function ddmHemi(value, isLat, dec = 4) {
    const abs = Math.abs(value);
    let d = Math.floor(abs);
    let m = +((abs - d) * 60).toFixed(dec);
    if (m >= 60) { m -= 60; d += 1; }
    const hemi = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
    return `${d}° ${m.toFixed(dec).padStart(dec + 3, '0')}′ ${hemi}`;
  }

  // Hours (from degrees): -5h 18m 34.71s
  function hmsFromDeg(deg, dec = 2, signed = true) {
    const hours = deg / 15;
    const [h, m, s] = toSexagesimal(hours, dec);
    const sign = signed ? (hours < 0 ? '-' : '+') : '';
    return `${sign}${h}h ${pad(m, 2)}m ${fmtSec(s, dec)}s`;
  }

  function hmsColon(hours, dec = 1) {
    const [h, m, s] = toSexagesimal(mod(hours, 24), dec);
    return `${pad(h % 24, 2)}:${pad(m, 2)}:${fmtSec(s, dec)}`;
  }

  // LX200 style  sDD*MM  /  DDD*MM (west-positive 0..360)
  function lx200Lat(lat) {
    const [d, m, s] = toSexagesimal(lat, 0);
    const [dd, mm] = roundToMinutes(d, m, s);
    return `${lat < 0 ? '-' : '+'}${pad(dd, 2)}*${pad(mm, 2)}`;
  }
  function lx200Long(lonEast) {
    const west = mod(-lonEast, 360);
    const [d, m, s] = toSexagesimal(west, 0);
    let [dd, mm] = roundToMinutes(d, m, s);
    if (dd >= 360) dd -= 360;
    return `${pad(dd, 3)}*${pad(mm, 2)}`;
  }
  function roundToMinutes(d, m, s) {
    let mm = m + (s >= 30 ? 1 : 0);
    let dd = d;
    if (mm >= 60) { mm -= 60; dd += 1; }
    return [dd, mm];
  }

  /* ---------- Parsing user coordinate input ---------- */

  function parseAngle(str, kind) {
    // kind: 'lat' | 'lon' | undefined
    let s = String(str).trim();
    if (!s) return null;
    let sign = 1;
    const hemiMatch = s.match(/[NSEWnsew]/g);
    let hemi = null;
    if (hemiMatch) {
      if (hemiMatch.length > 1) return null;
      hemi = hemiMatch[0].toUpperCase();
      if (hemi === 'S' || hemi === 'W') sign = -1;
      s = s.replace(/[NSEWnsew]/, ' ');
    }
    s = s.replace(/[°º˚'′’"″”:dDmMsS]/g, ' ').replace(/deg|min|sec/gi, ' ');
    const nums = s.match(/[-+−]?\d+(?:[.,]\d+)?/g);
    if (!nums || nums.length > 3) return null;
    const vals = nums.map((n) => parseFloat(n.replace('−', '-').replace(',', '.')));
    if (/^\s*[-−]/.test(s) || vals[0] < 0 || Object.is(vals[0], -0)) sign *= -1;
    const d = Math.abs(vals[0]);
    const m = vals[1] !== undefined ? Math.abs(vals[1]) : 0;
    const sec = vals[2] !== undefined ? Math.abs(vals[2]) : 0;
    if (m >= 60 || sec >= 60) return null;
    const value = sign * (d + m / 60 + sec / 3600);
    const isLatHemi = hemi === 'N' || hemi === 'S';
    const isLonHemi = hemi === 'E' || hemi === 'W';
    return { value, hemi, isLatHemi, isLonHemi, kind };
  }

  function maidenheadToLatLon(loc) {
    const s = loc.trim();
    if (!/^[A-Ra-r]{2}(\d{2}([A-Xa-x]{2}(\d{2})?)?)?$/.test(s)) return null;
    const U = s.toUpperCase();
    let lon = (U.charCodeAt(0) - 65) * 20 - 180;
    let lat = (U.charCodeAt(1) - 65) * 10 - 90;
    let lonSize = 20, latSize = 10;
    if (s.length >= 4) {
      lon += +U[2] * 2; lat += +U[3] * 1; lonSize = 2; latSize = 1;
    }
    if (s.length >= 6) {
      lon += (U.charCodeAt(4) - 65) * (2 / 24); lat += (U.charCodeAt(5) - 65) * (1 / 24);
      lonSize = 2 / 24; latSize = 1 / 24;
    }
    if (s.length >= 8) {
      lon += +U[6] * (2 / 240); lat += +U[7] * (1 / 240);
      lonSize = 2 / 240; latSize = 1 / 240;
    }
    return { lat: lat + latSize / 2, lon: lon + lonSize / 2 };
  }

  // Returns {lat, lon} or null if the text is not a coordinate pair.
  function parseCoordinates(text) {
    if (!text) return null;
    const t = String(text).trim();
    if (!t) return null;

    // Maidenhead (only if it looks like one and is not a pure word search, require digits)
    if (/^[A-Ra-r]{2}\d{2}([A-Xa-x]{2}(\d{2})?)?$/.test(t)) {
      return maidenheadToLatLon(t);
    }

    // Must contain at least one digit and no long words
    if (!/\d/.test(t)) return null;
    if (/[A-Za-z]{4,}/.test(t.replace(/deg|min|sec/gi, ''))) return null;

    let parts = null;

    // 1. explicit separators
    if (/[;,|/]/.test(t) && !/\d,\d+\s*[;|/]/.test(t)) {
      const sp = t.split(/\s*[;,|/]\s*/).filter(Boolean);
      if (sp.length === 2) parts = sp;
    }
    // 2. split on hemisphere letters
    if (!parts) {
      let m = t.match(/^\s*(.*?[NSns])\s*(.+?[EWew])\s*$/);
      if (m && /\d/.test(m[1]) && /\d/.test(m[2])) parts = [m[1], m[2]];
      if (!parts) {
        m = t.match(/^\s*([NSns].*?)\s+([EWew].*)$/);
        if (m) parts = [m[1], m[2]];
      }
      if (!parts) {
        m = t.match(/^\s*(.*?[EWew])\s*(.+?[NSns])\s*$/);
        if (m && /\d/.test(m[1]) && /\d/.test(m[2])) parts = [m[2], m[1]];
      }
    }
    // 3. purely numeric tokens: 2 (dec), 4 (DM), 6 (DMS)
    if (!parts) {
      const nums = t.replace(/[°º˚'′’"″”:]/g, ' ').trim().split(/\s+/);
      if (nums.every((n) => /^[-+−]?\d+(\.\d+)?$/.test(n))) {
        if (nums.length === 2) parts = [nums[0], nums[1]];
        else if (nums.length === 4) parts = [nums.slice(0, 2).join(' '), nums.slice(2).join(' ')];
        else if (nums.length === 6) parts = [nums.slice(0, 3).join(' '), nums.slice(3).join(' ')];
      }
    }
    if (!parts) return null;

    let a = parseAngle(parts[0]);
    let b = parseAngle(parts[1]);
    if (!a || !b) return null;
    // Swap if user typed lon first with hemisphere letters
    if (a.isLonHemi && b.isLatHemi) [a, b] = [b, a];
    const lat = a.value, lon = b.value;
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
    return { lat, lon: lon > 180 ? lon - 360 : lon };
  }

  /* ---------- Geodesy ---------- */

  function maidenhead(lat, lon) {
    const L = mod(lon + 180, 360);
    const P = Math.min(Math.max(lat + 90, 0), 179.9999999);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    const f1 = A[Math.floor(L / 20)], f2 = A[Math.floor(P / 10)];
    const s1 = Math.floor((L % 20) / 2), s2 = Math.floor(P % 10);
    const ss1 = A[Math.floor((L % 2) * 12)].toLowerCase();
    const ss2 = A[Math.floor((P % 1) * 24)].toLowerCase();
    const e1 = Math.floor(((L % 2) * 12 % 1) * 10);
    const e2 = Math.floor(((P % 1) * 24 % 1) * 10);
    return `${f1}${f2}${s1}${s2}${ss1}${ss2}${e1}${e2}`;
  }

  // WGS84 geodetic -> ECEF (metres)
  function ecef(lat, lon, h) {
    const a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f);
    const phi = lat * D2R, lam = lon * D2R;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    return {
      x: (N + h) * Math.cos(phi) * Math.cos(lam),
      y: (N + h) * Math.cos(phi) * Math.sin(lam),
      z: (N * (1 - e2) + h) * Math.sin(phi),
    };
  }

  /* ---------- Time & sidereal ---------- */

  function julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }

  // Greenwich mean sidereal time in degrees (IAU 1982, Meeus 12.4)
  function gmstDeg(date) {
    const jd = julianDate(date);
    const T = (jd - 2451545.0) / 36525;
    return mod(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000, 360);
  }

  function lstHours(date, lonEast) { return mod(gmstDeg(date) + lonEast, 360) / 15; }

  /* ---------- Precession (IAU 1976) J2000 -> date ---------- */
  function precessJ2000(raDeg, decDeg, date) {
    const T = (julianDate(date) - 2451545.0) / 36525;
    const as = (x) => (x / 3600) * D2R;
    const zeta = as(2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3);
    const z = as(2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3);
    const theta = as(2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3);
    const ra0 = raDeg * D2R, dec0 = decDeg * D2R;
    const A = Math.cos(dec0) * Math.sin(ra0 + zeta);
    const B = Math.cos(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) - Math.sin(theta) * Math.sin(dec0);
    const C = Math.sin(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) + Math.cos(theta) * Math.sin(dec0);
    const ra = mod(Math.atan2(A, B) + z, 2 * Math.PI) * R2D;
    const dec = Math.atan2(C, Math.sqrt(A * A + B * B)) * R2D;
    return { ra, dec };
  }

  // Pole stars, J2000 (Hipparcos). Proper motion over a few decades is < 2″, ignored.
  const POLARIS = { name: 'Polaris', ra: (2 + 31 / 60 + 49.09 / 3600) * 15, dec: 89 + 15 / 60 + 50.79 / 3600 };
  const SIGMA_OCT = { name: 'Sigma Octantis', ra: (21 + 8 / 60 + 46.86 / 3600) * 15, dec: -(88 + 57 / 60 + 23.4 / 3600) };

  function poleStar(lat, lonEast, date) {
    const star = lat >= 0 ? POLARIS : SIGMA_OCT;
    const p = precessJ2000(star.ra, star.dec, date);
    const lst = lstHours(date, lonEast) * 15;
    const haDeg = mod(lst - p.ra, 360);
    return { name: star.name, raDeg: p.ra, decDeg: p.dec, haHours: haDeg / 15, poleDistArcmin: (90 - Math.abs(p.dec)) * 60 };
  }

  const api = {
    D2R, R2D, mod, pad,
    toSexagesimal, dmsHemi, dmsAscii, dmsSigned, ddmHemi, hmsFromDeg, hmsColon,
    lx200Lat, lx200Long,
    parseAngle, parseCoordinates, maidenhead, maidenheadToLatLon, ecef,
    julianDate, gmstDeg, lstHours, precessJ2000, poleStar,
  };
  root.Astro = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
