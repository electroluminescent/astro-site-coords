/* AstroSite — UI. MIT License. */
(function () {
  'use strict';
  const A = window.Astro;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OPEN_METEO = 'https://api.open-meteo.com/v1';

  const state = {
    lat: null, lon: null,
    elev: null, elevSource: '',
    name: '', sub: '',
    tz: null, utcOffset: null,
    clouds: null, // [{t: Date, c: %}]
    polarView: 'sky',
  };

  /* ---------------- Map ---------------- */
  const map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([25, 0], 2);
  const baseLayers = {
    'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
    'Terrain': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    }),
    'Dark': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'tiles-dark', attribution: '© OpenStreetMap contributors',
    }),
  };
  let savedLayer = 'Dark';
  try { savedLayer = localStorage.getItem('astrosite.layer') || 'Dark'; } catch (e) { /* ignore */ }
  (baseLayers[savedLayer] || baseLayers.Dark).addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: true, metric: true }).addTo(map);
  map.on('baselayerchange', (e) => { try { localStorage.setItem('astrosite.layer', e.name); } catch (err) { /* ignore */ } });

  const markerIcon = L.divIcon({
    className: 'site-marker',
    html: '<svg viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="14" fill="none" stroke="#ffcc66" stroke-width="2"/><path d="M20 2v10M20 28v10M2 20h10M28 20h10" stroke="#ffcc66" stroke-width="2"/><circle cx="20" cy="20" r="2.5" fill="#ffcc66"/></svg>',
    iconSize: [40, 40], iconAnchor: [20, 20],
  });
  let marker = null;

  map.on('click', (e) => setLocation(e.latlng.lat, e.latlng.lng, { keepZoom: true }));
  map.on('mousemove', (e) => {
    const ll = e.latlng.wrap();
    $('#cursorReadout').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  });
  map.on('mouseout', () => { $('#cursorReadout').textContent = ''; });

  /* ---------------- Utilities ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      ta.remove();
    }
  }

  function flashCopied(el) {
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 1100);
  }

  // Nominatim asks for ≤ 1 request/second
  let lastNominatim = 0;
  async function nominatim(path) {
    const wait = Math.max(0, lastNominatim + 1100 - Date.now());
    lastNominatim = Date.now() + wait;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(`${NOMINATIM}${path}`, { headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    return res.json();
  }

  const fixed = (n, d) => (Object.is(+n.toFixed(d), -0) ? (0).toFixed(d) : n.toFixed(d));

  /* ---------------- Location handling ---------------- */
  let fetchSeq = 0;

  function setLocation(lat, lon, opts = {}) {
    lon = A.mod(lon + 180, 360) - 180;
    lat = Math.max(-90, Math.min(90, lat));
    state.lat = lat; state.lon = lon;
    if (!opts.keepElev) { state.elev = null; state.elevSource = 'loading'; }
    state.name = opts.name || '';
    state.sub = opts.sub || '';
    state.tz = null; state.utcOffset = null; state.clouds = null; state.demElev = null;
    if (!opts.fromGps) state.gps = null;

    const ll = [lat, lon];
    if (!marker) {
      marker = L.marker(ll, { draggable: true, icon: markerIcon, keyboard: true, title: 'Observing site' }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        setLocation(p.lat, p.lng, { keepZoom: true });
      });
    } else {
      marker.setLatLng(ll);
    }
    $('#mapHint').style.opacity = '0';

    if (opts.bounds) {
      map.fitBounds(opts.bounds, { maxZoom: 14, padding: [30, 30] });
    } else if (!opts.keepZoom) {
      map.setView(ll, opts.zoom || Math.max(map.getZoom(), 11));
    }

    if (opts.elev != null) { state.elev = opts.elev; state.elevSource = opts.elevSource || 'manual'; }

    renderAll();
    updateHash();

    const seq = ++fetchSeq;
    fetchSiteData(seq, opts.elev == null);
    if (!state.name) reverseGeocode(seq);
  }

  async function fetchSiteData(seq, wantElev) {
    const { lat, lon } = state;
    const q = `latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`;
    const elevP = fetch(`${OPEN_METEO}/elevation?${q}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const metaP = fetch(`${OPEN_METEO}/forecast?${q}&timezone=auto&forecast_days=3&hourly=cloud_cover&current=cloud_cover`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const [elev, meta] = await Promise.all([elevP, metaP]);
    if (seq !== fetchSeq) return;
    const dem = elev && Array.isArray(elev.elevation) && isFinite(elev.elevation[0]) ? elev.elevation[0] : null;
    state.demElev = dem;
    if (wantElev) {
      if (dem != null) {
        state.elev = dem;
        state.elevSource = 'Copernicus DEM (90 m)';
      } else {
        state.elev = 0; state.elevSource = 'unavailable — enter manually';
      }
    }
    if (meta && meta.timezone) {
      state.tz = meta.timezone;
      state.utcOffset = meta.utc_offset_seconds;
      if (meta.hourly && meta.hourly.time) {
        const off = meta.utc_offset_seconds * 1000;
        state.clouds = meta.hourly.time.map((t, i) => ({ t: new Date(Date.parse(t + ':00Z') - off), c: meta.hourly.cloud_cover[i] }));
      }
      state.cloudNow = meta.current ? meta.current.cloud_cover : null;
    }
    renderAll();
  }

  async function reverseGeocode(seq) {
    try {
      const r = await nominatim(`/reverse?format=jsonv2&zoom=12&lat=${state.lat}&lon=${state.lon}`);
      if (seq !== fetchSeq) return;
      if (r && !r.error) {
        const a = r.address || {};
        state.name = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || a.state || r.name || 'Unnamed site';
        state.sub = r.display_name || '';
      } else {
        state.name = 'Unnamed site';
        state.sub = '';
      }
    } catch (e) {
      if (seq !== fetchSeq) return;
      state.name = 'Unnamed site';
    }
    renderHead();
    renderPrograms();
    updateHash();
  }

  /* ---------------- Search ---------------- */
  const form = $('#searchForm');
  const input = $('#searchInput');
  const list = $('#searchResults');
  let results = [];
  let activeIdx = -1;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const c = A.parseCoordinates(q);
    if (c) {
      hideResults();
      setLocation(c.lat, c.lon, { zoom: 12 });
      return;
    }
    showResults([{ loading: true }]);
    try {
      const data = await nominatim(`/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`);
      showResults(data.length ? data : [{ empty: true }]);
    } catch (err) {
      showResults([{ empty: true, msg: err.message }]);
    }
  });

  function showResults(items) {
    results = items;
    activeIdx = -1;
    list.innerHTML = items.map((it, i) => {
      if (it.loading) return '<li class="empty">Searching…</li>';
      if (it.empty) return `<li class="empty">${esc(it.msg || 'No places found. Try a different spelling or enter coordinates.')}</li>`;
      const parts = (it.display_name || '').split(', ');
      return `<li role="option" data-i="${i}"><span class="r-main">${esc(parts[0])}</span><span class="r-sub">${esc(parts.slice(1).join(', '))} · ${(+it.lat).toFixed(4)}, ${(+it.lon).toFixed(4)}</span></li>`;
    }).join('');
    list.hidden = false;
  }
  function hideResults() { list.hidden = true; results = []; }

  function choose(i) {
    const it = results[i];
    if (!it || it.empty || it.loading) return;
    hideResults();
    const parts = (it.display_name || '').split(', ');
    let bounds = null;
    if (it.boundingbox) {
      const [s, n, w, e] = it.boundingbox.map(Number);
      bounds = [[s, w], [n, e]];
    }
    setLocation(+it.lat, +it.lon, { name: parts[0], sub: it.display_name, bounds });
  }

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) choose(+li.dataset.i);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const lis = $$('li[data-i]', list);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!lis.length) return;
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((l, i) => l.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      choose(+lis[activeIdx].dataset.i);
    } else if (e.key === 'Escape') {
      hideResults();
    }
  });
  document.addEventListener('click', (e) => { if (!form.contains(e.target)) hideResults(); });

  /* ---------------- Device GPS (W3C Geolocation API — all modern browsers) ---------------- */
  const locateBtn = $('#locateBtn');
  function gpsError(err) {
    locateBtn.classList.remove('busy');
    const msg = {
      1: 'Location permission denied — allow location access for this site in your browser settings',
      2: 'Position unavailable — check that location services / GPS are enabled on the device',
      3: 'Timed out waiting for a GPS fix — try again outdoors or with a clearer sky view',
    }[err.code] || err.message;
    toast(msg);
  }
  function gpsSuccess(p) {
    locateBtn.classList.remove('busy');
    const c = p.coords;
    state.gps = {
      acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy, time: new Date(p.timestamp),
    };
    const accTxt = c.accuracy != null ? ` ±${Math.round(c.accuracy)} m` : '';
    const opts = { zoom: c.accuracy && c.accuracy > 2000 ? 11 : 15, sub: `Device location${accTxt}`, fromGps: true };
    // Use the GPS altitude when the device supplies one (most phones with a GPS chip do; desktops usually don't)
    if (c.altitude != null && isFinite(c.altitude)) {
      opts.elev = c.altitude;
      opts.elevSource = `device GPS${c.altitudeAccuracy != null ? ` ±${Math.round(c.altitudeAccuracy)} m` : ''}`;
    }
    setLocation(c.latitude, c.longitude, opts);
    toast(`Location found${accTxt}`);
  }
  locateBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) { toast('This browser does not support geolocation'); return; }
    if (!window.isSecureContext) { toast('Location needs a secure (https) page'); return; }
    locateBtn.classList.add('busy');
    toast('Getting a GPS fix…');
    navigator.geolocation.getCurrentPosition(gpsSuccess, (err) => {
      // High-accuracy fix timed out or unavailable: fall back to a network/Wi-Fi position
      if (err.code === 1) { gpsError(err); return; }
      navigator.geolocation.getCurrentPosition(gpsSuccess, gpsError, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });

  /* ---------------- Head (name / elevation) ---------------- */
  $('#siteName').addEventListener('input', (e) => { state.name = e.target.value; renderPrograms(); updateHash(); });
  $('#elevInput').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) return;
    state.elev = v; state.elevSource = 'manual entry';
    $('#elevSrc').textContent = state.elevSource;
    renderValues(); renderPrograms(); updateHash();
  });

  function renderHead() {
    const nameEl = $('#siteName');
    if (document.activeElement !== nameEl) nameEl.value = state.name || '';
    $('#siteSub').textContent = state.lat == null ? 'Search, click the map, or use your location to begin' : (state.sub || `${fixed(state.lat, 5)}, ${fixed(state.lon, 5)}`);
    const ei = $('#elevInput');
    if (document.activeElement !== ei) ei.value = state.elev == null ? '' : Math.round(state.elev);
    $('#elevSrc').textContent = state.elevSource === 'loading' ? 'looking up…' : state.elevSource;
  }

  /* ---------------- Value model ---------------- */
  function elevM() { return state.elev == null ? 0 : state.elev; }

  function siteTimeString(date) {
    if (state.tz) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(date).replace(',', '');
    }
    return '—';
  }

  function offsetString(sec) {
    if (sec == null) return '—';
    const sign = sec < 0 ? '-' : '+';
    const a = Math.abs(sec);
    return `UTC${sign}${A.pad(Math.floor(a / 3600), 2)}:${A.pad(Math.floor((a % 3600) / 60), 2)}`;
  }

  function buildGroups() {
    const { lat, lon } = state;
    const h = elevM();
    const lonW = -lon;
    const lon360 = A.mod(lon, 360);
    const e = A.ecef(lat, lon, h);
    return [
      {
        title: 'Decimal degrees',
        rows: [
          ['Latitude', 'signed, + North', fixed(lat, 6)],
          ['Longitude', 'signed, + East (ISO 6709, ASCOM, N.I.N.A.)', fixed(lon, 6)],
          ['Longitude', '+ West (classic LX200, some planetarium apps)', fixed(lonW, 6)],
          ['Longitude 0–360° East', 'INDI / KStars GEOGRAPHIC_COORD', fixed(lon360, 6)],
          ['Lat, Lon pair', 'Google Maps / GPS', `${fixed(lat, 6)}, ${fixed(lon, 6)}`],
          ['Latitude (hemisphere)', '', `${Math.abs(lat).toFixed(6)}° ${lat < 0 ? 'S' : 'N'}`],
          ['Longitude (hemisphere)', '', `${Math.abs(lon).toFixed(6)}° ${lon < 0 ? 'W' : 'E'}`],
        ],
      },
      {
        title: 'Degrees · arcminutes · arcseconds',
        rows: [
          ['Latitude DMS', '', A.dmsHemi(lat, true)],
          ['Longitude DMS', '', A.dmsHemi(lon, false)],
          ['Latitude DMS (ASCII)', '', A.dmsAscii(lat, true)],
          ['Longitude DMS (ASCII)', '', A.dmsAscii(lon, false)],
          ['Latitude sDD:MM:SS', 'colon separated', A.dmsSigned(lat, ':', 2, 2)],
          ['Longitude sDDD:MM:SS', 'colon separated, + East', A.dmsSigned(lon, ':', 2, 3)],
          ['Latitude sDD MM SS', 'space separated (FITS string style)', A.dmsSigned(lat, ' ', 2, 2)],
          ['Longitude sDDD MM SS', 'space separated, + East', A.dmsSigned(lon, ' ', 2, 3)],
          ['Latitude D° M.mmmm′', 'degrees + decimal minutes', A.ddmHemi(lat, true)],
          ['Longitude D° M.mmmm′', 'degrees + decimal minutes', A.ddmHemi(lon, false)],
        ],
      },
      {
        title: 'Arc units, radians & time',
        rows: [
          ['Latitude in arcminutes', '', `${fixed(lat * 60, 3)}′`],
          ['Latitude in arcseconds', '', `${fixed(lat * 3600, 1)}″`],
          ['Longitude in arcminutes', '+ East', `${fixed(lon * 60, 3)}′`],
          ['Longitude in arcseconds', '+ East', `${fixed(lon * 3600, 1)}″`],
          ['Latitude (radians)', '', fixed(lat * A.D2R, 9)],
          ['Longitude (radians)', '+ East', fixed(lon * A.D2R, 9)],
          ['Longitude as time', 'offset of local mean time from UT', A.hmsFromDeg(lon)],
          ['Longitude as decimal hours', '+ East', fixed(lon / 15, 6)],
        ],
      },
      {
        title: 'Elevation',
        rows: [
          ['Elevation (m)', state.elevSource || '', fixed(h, 0)],
          ['Elevation (ft)', '', fixed(h / 0.3048, 0)],
          ['Elevation (km)', '', fixed(h / 1000, 3)],
          ...(state.demElev != null && state.elevSource !== 'Copernicus DEM (90 m)' ? [['Ground elevation (DEM)', 'Copernicus 90 m model', `${fixed(state.demElev, 0)} m`]] : []),
          ...(state.gps ? [
            ['GPS altitude', state.gps.alt != null ? `device reported${state.gps.altAcc != null ? `, ±${Math.round(state.gps.altAcc)} m` : ''}` : 'not provided by this device', state.gps.alt != null ? `${fixed(state.gps.alt, 1)} m` : '—'],
            ['GPS horizontal accuracy', `fix at ${state.gps.time.toISOString().slice(11, 19)} UTC`, state.gps.acc != null ? `±${Math.round(state.gps.acc)} m` : '—'],
          ] : []),
        ],
      },
      {
        title: 'Geocentric & grid',
        rows: [
          ['OBSGEO-X (m)', 'WGS84 ECEF, height treated as ellipsoidal', fixed(e.x, 2)],
          ['OBSGEO-Y (m)', '', fixed(e.y, 2)],
          ['OBSGEO-Z (m)', '', fixed(e.z, 2)],
          ['Maidenhead locator', 'amateur-radio grid square', A.maidenhead(lat, lon)],
        ],
      },
      {
        title: 'Time',
        rows: [
          ['Time zone', 'IANA', state.tz || '…'],
          ['UTC offset (now)', '', offsetString(state.utcOffset)],
          ['Site local time', '', '', 'local'],
          ['UTC', '', '', 'utc'],
          ['Local sidereal time', 'hh:mm:ss', '', 'lst'],
          ['Greenwich sidereal time', 'mean, hh:mm:ss', '', 'gmst'],
          ['Julian date', '', '', 'jd'],
        ],
      },
    ];
  }

  const live = {
    local: () => siteTimeString(new Date()),
    utc: () => new Date().toISOString().replace('T', ' ').slice(0, 19),
    lst: () => A.hmsColon(A.lstHours(new Date(), state.lon), 1),
    gmst: () => A.hmsColon(A.gmstDeg(new Date()) / 15, 1),
    jd: () => A.julianDate(new Date()).toFixed(5),
  };

  function renderValues() {
    const box = $('#valuesTable');
    if (state.lat == null) {
      box.innerHTML = '<p class="muted" style="padding:12px 0">No site selected yet. Search for a place, paste coordinates, or click anywhere on the map.</p>';
      return;
    }
    box.innerHTML = buildGroups().map((g) => `
      <div class="vgroup"><h3>${esc(g.title)}</h3>
        <table class="vals"><tbody>
        ${g.rows.map(([k, sub, v, lv]) => `<tr><td class="k">${esc(k)}${sub ? `<small>${esc(sub)}</small>` : ''}</td><td class="v"${lv ? ` data-live="${lv}"` : ''} title="Click to copy">${esc(lv ? live[lv]() : v)}</td></tr>`).join('')}
        </tbody></table>
      </div>`).join('');
  }

  // Copy on click for any value cell / snippet
  document.addEventListener('click', (e) => {
    const td = e.target.closest('td.v');
    const pre = e.target.closest('pre.snip');
    const el = td || pre;
    if (!el) return;
    const text = el.dataset.copy || el.textContent.trim();
    copyText(text);
    flashCopied(el);
    toast(`Copied: ${text.length > 48 ? text.slice(0, 45) + '…' : text}`);
  });

  /* ---------------- Program presets ---------------- */
  function fitsCard(key, value, comment) {
    let v;
    if (typeof value === 'number' || (typeof value === 'string' && value.startsWith('#'))) {
      v = String(typeof value === 'number' ? value : value.slice(1)).padStart(20);
    } else {
      v = `'${String(value).replace(/'/g, "''").padEnd(8)}'`.padEnd(20);
    }
    return `${key.padEnd(8)}= ${v} / ${comment}`.slice(0, 80);
  }

  function programs() {
    const { lat, lon } = state;
    const h = elevM();
    const e = A.ecef(lat, lon, h);
    const lat6 = +fixed(lat, 6), lon6 = +fixed(lon, 6);
    const elevR = Math.round(h);
    const site = (state.name || 'Observing site').slice(0, 60);
    return [
      {
        name: 'N.I.N.A.',
        where: 'Options › General › Astrometry — Latitude, Longitude, Elevation. West longitudes are negative; a stray minus sign is the usual cause of mount / sync errors.',
        rows: [
          ['Latitude', fixed(lat, 6)],
          ['Longitude', fixed(lon, 6)],
          ['Elevation (m)', String(elevR)],
          ['Latitude (DMS)', A.dmsSigned(lat, ' ', 2, 2)],
          ['Longitude (DMS)', A.dmsSigned(lon, ' ', 2, 3)],
        ],
      },
      {
        name: 'ASTAP',
        where: 'ASTAP reads the site from the FITS header (SITELAT / SITELONG / SITEELEV) for airmass, annotation and photometry. Use these in its header editor or wherever it asks for latitude / longitude; it accepts decimal or space-separated D M S.',
        rows: [
          ['Latitude (decimal)', fixed(lat, 6)],
          ['Longitude (decimal, +E)', fixed(lon, 6)],
          ['Latitude (D M S)', A.dmsSigned(lat, ' ', 1, 2)],
          ['Longitude (D M S)', A.dmsSigned(lon, ' ', 1, 3)],
          ['Elevation (m)', String(elevR)],
        ],
        snippet: [
          fitsCard('SITELAT', `#${fixed(lat, 6)}`, '[deg] Observatory latitude'),
          fitsCard('SITELONG', `#${fixed(lon, 6)}`, '[deg] Observatory longitude (E+)'),
          fitsCard('SITEELEV', `#${elevR}`, '[m] Observatory elevation'),
        ].join('\n'),
      },
      {
        name: 'MLAstro & other generic tools',
        where: 'For tools that just ask for "latitude / longitude / elevation" — pick whichever format the field accepts.',
        rows: [
          ['Latitude, Longitude (decimal)', `${fixed(lat, 6)}, ${fixed(lon, 6)}`],
          ['Latitude (decimal)', fixed(lat, 6)],
          ['Longitude (decimal, +E)', fixed(lon, 6)],
          ['Latitude (DMS)', A.dmsAscii(lat, true)],
          ['Longitude (DMS)', A.dmsAscii(lon, false)],
          ['Elevation (m)', String(elevR)],
        ],
      },
      {
        name: 'PixInsight',
        where: 'ImageSolver / SPFC / observation metadata use OBSGEO-L/B/H (also SITELONG / SITELAT). Observer-location dialogs take signed D M S.',
        rows: [
          ['Longitude (D M S, +E)', A.dmsSigned(lon, ' ', 2, 3)],
          ['Latitude (D M S)', A.dmsSigned(lat, ' ', 2, 2)],
          ['Height (m)', String(elevR)],
        ],
        snippet: [
          fitsCard('OBSGEO-L', `#${fixed(lon, 6)}`, '[deg] Geodetic longitude (E+)'),
          fitsCard('OBSGEO-B', `#${fixed(lat, 6)}`, '[deg] Geodetic latitude'),
          fitsCard('OBSGEO-H', `#${elevR}`, '[m] Geodetic height'),
        ].join('\n'),
      },
      {
        name: 'Siril',
        where: 'Siril reads SITELAT / SITELONG / SITEELEV from FITS headers (decimal degrees, East positive).',
        rows: [
          ['SITELAT', fixed(lat, 6)],
          ['SITELONG', fixed(lon, 6)],
          ['SITEELEV', String(elevR)],
        ],
      },
      {
        name: 'Stellarium',
        where: 'Location window (F6) — Latitude, Longitude, Altitude.',
        rows: [
          ['Latitude', A.dmsHemi(lat, true)],
          ['Longitude', A.dmsHemi(lon, false)],
          ['Altitude (m)', String(elevR)],
          ['Latitude (decimal)', fixed(lat, 6)],
          ['Longitude (decimal)', fixed(lon, 6)],
        ],
      },
      {
        name: 'KStars / Ekos / INDI',
        where: 'KStars Geographic dialog takes signed D:M:S (East +). INDI drivers use GEOGRAPHIC_COORD with longitude 0–360° East.',
        rows: [
          ['KStars latitude', A.dmsSigned(lat, ':', 0, 2)],
          ['KStars longitude', A.dmsSigned(lon, ':', 0, 3)],
          ['INDI LAT', fixed(lat, 6)],
          ['INDI LONG (0–360 E)', fixed(A.mod(lon, 360), 6)],
          ['INDI ELEV (m)', String(elevR)],
        ],
        snippet: `indi_setprop "Telescope Simulator.GEOGRAPHIC_COORD.LAT;LONG;ELEV=${fixed(lat, 6)};${fixed(A.mod(lon, 360), 6)};${elevR}"`,
      },
      {
        name: 'ASCOM drivers / SGPro / APT / SharpCap / MaxIm DL',
        where: 'ASCOM SiteLatitude / SiteLongitude / SiteElevation are decimal degrees, East positive. Most Windows capture suites accept decimal; MaxIm and APT also accept D M S.',
        rows: [
          ['SiteLatitude', fixed(lat, 6)],
          ['SiteLongitude', fixed(lon, 6)],
          ['SiteElevation (m)', String(elevR)],
          ['Latitude (D M S)', A.dmsSigned(lat, ' ', 1, 2)],
          ['Longitude (D M S)', A.dmsSigned(lon, ' ', 1, 3)],
        ],
      },
      {
        name: 'LX200 / OnStep / Meade serial',
        where: 'Classic LX200 protocol: latitude sDD*MM, longitude DDD*MM measured West-positive (0–360).',
        rows: [
          ['Latitude', A.lx200Lat(lat)],
          ['Longitude (+W)', A.lx200Long(lon)],
        ],
        snippet: `:St${A.lx200Lat(lat)}#\n:Sg${A.lx200Long(lon)}#`,
      },
      {
        name: 'FITS header block',
        where: 'Standard keyword set written by N.I.N.A. and others — paste into any FITS header editor (ASTAP, Siril, PixInsight FITSHeader).',
        snippet: [
          fitsCard('SITELAT', `#${fixed(lat6, 6)}`, '[deg] Observatory latitude'),
          fitsCard('SITELONG', `#${fixed(lon6, 6)}`, '[deg] Observatory longitude (E+)'),
          fitsCard('SITEELEV', `#${elevR}`, '[m] Observatory elevation'),
          fitsCard('OBSGEO-B', `#${fixed(lat6, 6)}`, '[deg] Geodetic latitude'),
          fitsCard('OBSGEO-L', `#${fixed(lon6, 6)}`, '[deg] Geodetic longitude (E+)'),
          fitsCard('OBSGEO-H', `#${elevR}`, '[m] Geodetic height'),
          fitsCard('OBSGEO-X', `#${fixed(e.x, 2)}`, '[m] Geocentric X (ITRS)'),
          fitsCard('OBSGEO-Y', `#${fixed(e.y, 2)}`, '[m] Geocentric Y (ITRS)'),
          fitsCard('OBSGEO-Z', `#${fixed(e.z, 2)}`, '[m] Geocentric Z (ITRS)'),
          fitsCard('OBSERVAT', site.replace(/[^\x20-\x7e]/g, '?'), 'Observatory / site name'),
        ].join('\n'),
      },
    ];
  }

  function renderPrograms() {
    const box = $('#programCards');
    if (state.lat == null) { box.innerHTML = '<p class="muted" style="padding:12px 0">Pick a location first.</p>'; return; }
    box.innerHTML = programs().map((p) => `
      <section class="pcard">
        <header><h4>${esc(p.name)}</h4></header>
        <div class="where">${esc(p.where)}</div>
        ${p.rows ? `<table class="vals"><tbody>${p.rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v" title="Click to copy">${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${p.snippet ? `<pre class="snip" title="Click to copy">${esc(p.snippet)}</pre>` : ''}
      </section>`).join('');
  }

  /* ---------------- Tonight & polar alignment ---------------- */
  function siteOffsetSec() {
    if (state.utcOffset != null) return state.utcOffset;
    return Math.round(state.lon / 15) * 3600;
  }

  function fmtTime(d, withDay) {
    if (!d || isNaN(d)) return '—';
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (withDay) opts.weekday = 'short';
    if (state.tz) return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: state.tz }).format(d);
    const shifted = new Date(d.getTime() + siteOffsetSec() * 1000);
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(shifted);
  }

  function fmtDur(ms) {
    if (!(ms > 0)) return '0h 00m';
    const m = Math.round(ms / 60000);
    return `${Math.floor(m / 60)}h ${A.pad(m % 60, 2)}m`;
  }

  function moonPhaseName(phase) {
    const names = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return names[Math.round(phase * 8) % 8];
  }

  function nightWindow() {
    const off = siteOffsetSec() * 1000;
    const now = Date.now();
    const localNow = now + off;
    const day = 86400000;
    let localMidnight = Math.floor(localNow / day) * day;
    const localHour = (localNow - localMidnight) / 3600000;
    if (localHour < 9) localMidnight -= day; // still "last night" in the early morning
    const noon = new Date(localMidnight + 12 * 3600000 - off);
    return { noon, start: new Date(noon.getTime() + 3 * 3600000), end: new Date(noon.getTime() + 21 * 3600000) };
  }

  function renderTonight() {
    const box = $('#tonight');
    if (state.lat == null) { box.innerHTML = '<p class="muted" style="padding:12px 0">Pick a location first.</p>'; return; }
    if (typeof SunCalc === 'undefined') { box.innerHTML = '<p class="muted">Ephemeris library failed to load.</p>'; return; }
    const { lat, lon } = state;
    const { noon, start, end } = nightWindow();
    const ev = SunCalc.getTimes(noon, lat, lon);
    const mo = SunCalc.getTimes(new Date(noon.getTime() + 86400000), lat, lon);

    // Sample sun & moon altitudes across the window
    const step = 5 * 60000;
    const samples = [];
    for (let t = start.getTime(); t <= end.getTime(); t += step) {
      const d = new Date(t);
      samples.push({
        t,
        sun: SunCalc.getPosition(d, lat, lon).altitude * A.R2D,
        moon: SunCalc.getMoonPosition(d, lat, lon).altitude * A.R2D,
      });
    }
    let astroDark = 0, moonFreeDark = 0;
    samples.forEach((s) => { if (s.sun < -18) { astroDark += step; if (s.moon < 0) moonFreeDark += step; } });

    const midnight = new Date((start.getTime() + end.getTime()) / 2);
    const illum = SunCalc.getMoonIllumination(midnight);

    let moonRise = null, moonSet = null;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1].moon < 0 && samples[i].moon >= 0 && !moonRise) moonRise = new Date(samples[i].t);
      if (samples[i - 1].moon >= 0 && samples[i].moon < 0 && !moonSet) moonSet = new Date(samples[i].t);
    }
    const moonAllNight = samples.every((s) => s.moon >= 0);
    const moonNone = samples.every((s) => s.moon < 0);

    const cell = (l, t, s) => `<div class="tn-cell"><div class="l">${l}</div><div class="t">${t}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    const tzLabel = state.tz ? `${state.tz} (${offsetString(state.utcOffset)})` : `approx. ${offsetString(siteOffsetSec())} (time zone loading)`;

    // Timeline SVG
    const W = 520, H = 64, span = end - start;
    const x = (t) => ((t - start) / span) * W;
    const sunColor = (alt) => (alt > 0 ? '#3d6fb6' : alt > -6 ? '#2b4c80' : alt > -12 ? '#1d3358' : alt > -18 ? '#132240' : '#05080f');
    let rects = '';
    samples.forEach((s) => { rects += `<rect x="${x(s.t).toFixed(1)}" y="0" width="${(W * step / span + 0.6).toFixed(1)}" height="30" fill="${sunColor(s.sun)}"/>`; });
    samples.forEach((s) => { if (s.moon > 0) rects += `<rect x="${x(s.t).toFixed(1)}" y="32" width="${(W * step / span + 0.6).toFixed(1)}" height="6" fill="#d9d2a6" opacity="${(0.25 + 0.75 * illum.fraction).toFixed(2)}"/>`; });
    if (state.clouds) {
      state.clouds.forEach((c) => {
        const t = c.t.getTime();
        if (t < start - 3600000 || t > end) return;
        rects += `<rect x="${Math.max(0, x(t)).toFixed(1)}" y="40" width="${(W * 3600000 / span).toFixed(1)}" height="8" fill="#9aa7bf" opacity="${(c.c / 100).toFixed(2)}"/>`;
      });
    }
    let ticks = '';
    const firstHour = Math.ceil(start.getTime() / 3600000) * 3600000;
    for (let t = firstHour; t <= end.getTime(); t += 3600000) {
      const lbl = fmtTime(new Date(t)).slice(0, 2);
      const show = ((t - firstHour) / 3600000) % 2 === 0;
      ticks += `<line x1="${x(t)}" x2="${x(t)}" y1="48" y2="52" stroke="#3b4a68"/>`;
      if (show && x(t) > 8 && x(t) < W - 8) ticks += `<text class="lbl" x="${x(t)}" y="62" text-anchor="middle">${lbl}</text>`;
    }
    const nowT = Date.now();
    const nowLine = nowT > start && nowT < end ? `<line x1="${x(nowT)}" x2="${x(nowT)}" y1="0" y2="48" stroke="#ffcc66" stroke-width="1.5"/>` : '';

    const darkNote = isNaN(ev.night) ? 'No astronomical darkness tonight' : `${fmtDur(astroDark)} astro-dark · ${fmtDur(moonFreeDark)} moon-free`;

    box.innerHTML = `
      <h5 class="sec">Tonight · ${esc(tzLabel)}</h5>
      <div class="timeline">
        <svg viewBox="0 0 ${W} ${H}">${rects}${ticks}${nowLine}</svg>
        <div class="legend">
          <span><i style="background:#3d6fb6"></i>Day</span>
          <span><i style="background:#2b4c80"></i>Civil</span>
          <span><i style="background:#1d3358"></i>Nautical</span>
          <span><i style="background:#132240"></i>Astronomical</span>
          <span><i style="background:#05080f;border:1px solid #3b4a68"></i>Dark</span>
          <span><i style="background:#d9d2a6"></i>Moon up</span>
          ${state.clouds ? '<span><i style="background:#9aa7bf"></i>Cloud cover (forecast)</span>' : ''}
        </div>
      </div>
      <div class="tn-grid">
        ${cell('Sunset', fmtTime(ev.sunset, true), `Civil dusk ${fmtTime(ev.dusk)}`)}
        ${cell('Sunrise', fmtTime(mo.sunrise, true), `Civil dawn ${fmtTime(mo.dawn)}`)}
        ${cell('Astro dusk (−18°)', fmtTime(ev.night), `Nautical dusk ${fmtTime(ev.nauticalDusk)}`)}
        ${cell('Astro dawn (−18°)', fmtTime(mo.nightEnd), `Nautical dawn ${fmtTime(mo.nauticalDawn)}`)}
        ${cell('Darkness', fmtDur(astroDark), darkNote)}
        ${cell('Moon', `${Math.round(illum.fraction * 100)}%`, `${moonPhaseName(illum.phase)} · ${moonAllNight ? 'up all night' : moonNone ? 'below horizon all night' : [moonRise ? `rises ${fmtTime(moonRise)}` : 'up at dusk', moonSet ? `sets ${fmtTime(moonSet)}` : 'up at dawn'].join(' · ')}`)}
        ${state.cloudNow != null ? cell('Cloud cover now', `${state.cloudNow}%`, 'Open-Meteo model forecast') : ''}
      </div>
      <div id="polarBox"></div>
      <h5 class="sec">Open this site in</h5>
      <div class="links">
        <a href="https://clearoutside.com/forecast/${lat.toFixed(2)}/${lon.toFixed(2)}" target="_blank" rel="noopener">Clear Outside</a>
        <a href="https://lightpollutionmap.app/?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}" target="_blank" rel="noopener">Light Pollution Map</a>
        <a href="https://www.google.com/maps/@?api=1&map_action=map&center=${lat.toFixed(6)},${lon.toFixed(6)}&zoom=14" target="_blank" rel="noopener">Google Maps</a>
        <a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=14/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener">OpenStreetMap</a>
      </div>`;
    renderPolar();
  }

  function renderPolar() {
    const box = $('#polarBox');
    if (!box || state.lat == null) return;
    const now = new Date();
    const p = A.poleStar(state.lat, state.lon, now);
    const north = state.lat >= 0;
    // Angle measured clockwise from 12 o'clock, as seen looking at the pole with the naked eye.
    // North: stars circle the pole counter-clockwise, HA 0 = star above the pole.
    // South: stars circle the pole clockwise.
    let ang = north ? 360 - p.haHours * 15 : p.haHours * 15;
    if (state.polarView === 'inverted') ang += 180;
    ang = A.mod(ang, 360);
    const clockH = ang / 30;
    let hh = Math.floor(clockH), mm = Math.round((clockH - hh) * 60);
    if (mm === 60) { mm = 0; hh += 1; }
    hh = hh % 12 === 0 ? 12 : hh % 12;
    const R = 62, cx = 85, cy = 85;
    const sx = cx + R * Math.sin(ang * A.D2R), sy = cy - R * Math.cos(ang * A.D2R);
    let ticks = '';
    for (let i = 0; i < 12; i++) {
      const a = i * 30 * A.D2R;
      ticks += `<line class="cross" x1="${cx + 70 * Math.sin(a)}" y1="${cy - 70 * Math.cos(a)}" x2="${cx + 75 * Math.sin(a)}" y2="${cy - 75 * Math.cos(a)}"/>`;
      if (i % 3 === 0) ticks += `<text class="tick" x="${cx + 81 * Math.sin(a)}" y="${cy - 81 * Math.cos(a)}">${i === 0 ? 12 : i}</text>`;
    }
    box.innerHTML = `
      <h5 class="sec">Polar alignment — ${esc(p.name)}</h5>
      <div class="polar">
        <svg viewBox="0 0 170 170" aria-label="Pole star position">
          <circle class="ring" cx="${cx}" cy="${cy}" r="${R}"/>
          <circle class="ring" cx="${cx}" cy="${cy}" r="72"/>
          <line class="cross" x1="${cx - 8}" y1="${cy}" x2="${cx + 8}" y2="${cy}"/>
          <line class="cross" x1="${cx}" y1="${cy - 8}" x2="${cx}" y2="${cy + 8}"/>
          ${ticks}
          <line class="cross" x1="${cx}" y1="${cy}" x2="${sx}" y2="${sy}" stroke-dasharray="2 3"/>
          <circle class="star" cx="${sx}" cy="${sy}" r="5"/>
        </svg>
        <div class="info">
          <div class="muted" style="font-size:12px">Hour angle (live)</div>
          <div class="big" data-live-polar="ha">${A.hmsColon(p.haHours, 0)}</div>
          <div style="margin-top:6px">Clock position <b data-live-polar="clock">${hh}:${A.pad(mm, 2)}</b></div>
          <div class="muted" style="font-size:12px;margin-top:6px">JNow RA ${A.hmsColon(p.raDeg / 15, 1)} · Dec ${A.dmsSigned(p.decDeg, ':', 0, 2)}<br>${p.poleDistArcmin.toFixed(1)}′ from the ${north ? 'north' : 'south'} celestial pole</div>
          <div class="seg" role="group" aria-label="View orientation">
            <button data-view="sky" class="${state.polarView === 'sky' ? 'on' : ''}">Naked-eye view</button>
            <button data-view="inverted" class="${state.polarView === 'inverted' ? 'on' : ''}">Inverted polar scope</button>
          </div>
        </div>
      </div>`;
    $$('.seg button', box).forEach((b) => b.addEventListener('click', () => { state.polarView = b.dataset.view; renderPolar(); }));
  }

  /* ---------------- Export ---------------- */
  function exportRows() {
    const rows = [];
    buildGroups().forEach((g) => g.rows.forEach(([k, sub, v, lv]) => rows.push([g.title, k + (sub ? ` (${sub})` : ''), lv ? live[lv]() : v])));
    return rows;
  }
  $('#copyTsv').addEventListener('click', () => {
    if (state.lat == null) return;
    copyText(exportRows().map((r) => r.join('\t')).join('\n'));
    toast('Table copied (tab-separated — pastes into Excel / Sheets)');
  });
  $('#copyMd').addEventListener('click', () => {
    if (state.lat == null) return;
    const md = ['| Group | Quantity | Value |', '|---|---|---|', ...exportRows().map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
    copyText(`**${state.name || 'Observing site'}**\n\n${md}`);
    toast('Markdown table copied');
  });
  $('#dlJson').addEventListener('click', () => {
    if (state.lat == null) return;
    const e = A.ecef(state.lat, state.lon, elevM());
    const data = {
      name: state.name, description: state.sub,
      latitude: +state.lat.toFixed(7), longitude: +state.lon.toFixed(7), elevation_m: Math.round(elevM()),
      elevation_source: state.elevSource, timezone: state.tz, utc_offset_seconds: state.utcOffset,
      latitude_dms: A.dmsHemi(state.lat, true), longitude_dms: A.dmsHemi(state.lon, false),
      longitude_west_positive: +(-state.lon).toFixed(7), longitude_0_360_east: +A.mod(state.lon, 360).toFixed(7),
      maidenhead: A.maidenhead(state.lat, state.lon),
      ecef_m: { x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2) },
      generated_utc: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.name || 'site').replace(/[^\w-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#copyLink').addEventListener('click', () => { copyText(location.href); toast('Link to this site copied'); });

  /* ---------------- URL hash ---------------- */
  let hashTimer;
  function updateHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      if (state.lat == null) return;
      const p = new URLSearchParams();
      p.set('lat', state.lat.toFixed(6));
      p.set('lon', state.lon.toFixed(6));
      if (state.elevSource === 'manual entry' && state.elev != null) p.set('elev', Math.round(state.elev));
      if (state.name) p.set('name', state.name);
      p.set('z', map.getZoom());
      history.replaceState(null, '', `#${p.toString()}`);
    }, 300);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return false;
    const elev = parseFloat(p.get('elev'));
    setLocation(lat, lon, {
      zoom: parseInt(p.get('z'), 10) || 11,
      name: p.get('name') || '',
      elev: isFinite(elev) ? elev : null,
      elevSource: 'manual entry',
    });
    return true;
  }
  map.on('zoomend', updateHash);

  /* ---------------- Tabs, night mode ---------------- */
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    $$('.tab-body').forEach((b) => { b.hidden = b.id !== `tab-${t.dataset.tab}`; });
    if (t.dataset.tab === 'tonight') renderTonight();
  }));

  function setNight(on) {
    document.body.classList.toggle('night', on);
    $('#nightBtn').setAttribute('aria-pressed', on);
    try { localStorage.setItem('astrosite.night', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  $('#nightBtn').addEventListener('click', () => setNight(!document.body.classList.contains('night')));
  try { if (localStorage.getItem('astrosite.night') === '1') setNight(true); } catch (e) { /* ignore */ }

  /* ---------------- Render orchestration ---------------- */
  function renderAll() {
    renderHead();
    renderValues();
    renderPrograms();
    if (!$('#tab-tonight').hidden) renderTonight();
  }

  // Live clock cells
  setInterval(() => {
    if (state.lat == null) return;
    $$('[data-live]').forEach((el) => { if (!el.classList.contains('copied')) el.textContent = live[el.dataset.live](); });
    const ha = $('[data-live-polar="ha"]');
    if (ha && !$('#tab-tonight').hidden) {
      const s = new Date().getSeconds();
      if (s % 10 === 0) renderPolar();
      else ha.textContent = A.hmsColon(A.poleStar(state.lat, state.lon, new Date()).haHours, 0);
    }
  }, 1000);

  window.addEventListener('hashchange', () => {
    const p = new URLSearchParams(location.hash.slice(1));
    const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
    if (isFinite(lat) && isFinite(lon) && (Math.abs(lat - state.lat) > 1e-6 || Math.abs(lon - state.lon) > 1e-6)) readHash();
  });

  renderAll();
  if (!readHash()) {
    setTimeout(() => input.focus(), 50);
  }
})();
