/* AstroSite — UI. MIT License. */
(function () {
  'use strict';
  const A = window.Astro;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OPEN_METEO = 'https://api.open-meteo.com/v1';
  const AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  const FC_DAYS = 14;
  const FC_VARS = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility',
    'temperature_2m', 'dew_point_2m', 'relative_humidity_2m', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
    'precipitation_probability', 'surface_pressure', 'total_column_integrated_water_vapour',
    'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_500hPa', 'wind_direction_500hPa',
    'wind_speed_300hPa', 'wind_direction_300hPa', 'wind_speed_200hPa'];
  const SM = window.SkyModel;

  const state = {
    lat: null, lon: null,
    elev: null, elevSource: '',
    name: '', sub: '',
    tz: null, utcOffset: null,
    clouds: null, // [{t: Date, c: %}]
    fc: null, fcSel: null,
    units: 'metric',
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
    state.tz = null; state.utcOffset = null; state.fc = null; state.fcSel = null; state.demElev = null;
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
    const metaP = fetch(`${OPEN_METEO}/forecast?${q}&timezone=auto&forecast_days=${FC_DAYS}&wind_speed_unit=ms&hourly=${FC_VARS.join(',')}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const aqP = fetch(`${AIR_QUALITY}?${q}&timezone=auto&forecast_days=7&hourly=aerosol_optical_depth`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const [elev, meta, aq] = await Promise.all([elevP, metaP, aqP]);
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
      if (meta.hourly && meta.hourly.time) state.fc = buildForecast(meta, aq);
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

  /* ---------------- Coordinates tab: by program (pinnable) or by type (deduplicated) ---------------- */
  let pins = [];
  try { pins = JSON.parse(localStorage.getItem('astrosite.pins') || '[]'); } catch (e) { pins = []; }
  let coordView = 'program';
  try { coordView = localStorage.getItem('astrosite.view') === 'type' ? 'type' : 'program'; } catch (e) { /* ignore */ }

  const kindOf = (label) => (/lat/i.test(label) ? 'lat' : /lon/i.test(label) ? 'lon' : /elev|height|altitude/i.test(label) ? 'elev' : 'other');
  function classify(label, v) {
    if (/\*/.test(v)) return 'Mount protocol';
    if (kindOf(label) === 'elev' && /^-?\d+(\.\d+)?$/.test(v)) return 'Elevation';
    if (/^[-+]?\d+(\.\d+)?(, [-+]?\d+(\.\d+)?)?$/.test(v)) return 'Decimal degrees';
    return 'Degrees · arcminutes · arcseconds';
  }

  // Every distinct value once, grouped by subject, tagged with the programs that use it.
  function byType() {
    const progs = programs();
    const groups = buildGroups().map((g) => ({ title: g.title, rows: g.rows.map(([k, sub, v, lv]) => ({ k, sub, v, lv, progs: [] })) }));
    const group = (title) => {
      let g = groups.find((x) => x.title === title);
      if (!g) { g = { title, rows: [] }; groups.push(g); }
      return g;
    };
    progs.forEach((p) => (p.rows || []).forEach(([k, v]) => {
      const hit = groups.flatMap((g) => g.rows).find((r) => !r.lv && r.v === v && (kindOf(r.k) === kindOf(k) || kindOf(k) === 'other'));
      if (hit) { if (!hit.progs.includes(p.short)) hit.progs.push(p.short); }
      else group(classify(k, v)).rows.push({ k, sub: '', v, progs: [p.short] });
    }));
    const snips = progs.filter((p) => p.snippet);
    const lines = (p) => p.snippet.split('\n');
    const kept = [];
    snips.forEach((p) => {
      const host = snips.find((o) => o !== p && lines(o).length > lines(p).length && lines(p).every((l) => lines(o).includes(l)));
      if (host) (host.also = host.also || []).push(p.short);
      else kept.push(p);
    });
    const sg = group('Commands & FITS headers');
    kept.forEach((p) => sg.rows.push({ k: p.snippetLabel, sub: '', v: p.snippet, snip: true, progs: [p.short, ...(p.also || [])] }));
    const order = ['Decimal degrees', 'Degrees · arcminutes · arcseconds', 'Arc units, radians & time', 'Elevation', 'Mount protocol', 'Geocentric & grid', 'Commands & FITS headers', 'Time'];
    return groups.filter((g) => g.rows.length).sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
  }

  function renderByType(box) {
    box.innerHTML = byType().map((g) => `
      <div class="vgroup"><h3>${esc(g.title)}</h3>
        <table class="vals"><tbody>
        ${g.rows.map((r) => {
          const tags = r.progs.length ? `<span class="tags">${r.progs.map((t) => `<em>${esc(t)}</em>`).join('')}</span>` : '';
          const label = `<td class="k">${esc(r.k)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}${tags}</td>`;
          if (r.snip) return `<tr>${label}<td><pre class="snip inrow" title="Click to copy">${esc(r.v)}</pre></td></tr>`;
          return `<tr>${label}<td class="v"${r.lv ? ` data-live="${r.lv}"` : ''} title="Click to copy">${esc(r.lv ? live[r.lv]() : r.v)}</td></tr>`;
        }).join('')}
        </tbody></table>
      </div>`).join('');
  }

  function renderCoords() {
    const box = $('#coordsBody');
    $$('#tab-coords [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === coordView));
    $('#viewHint').textContent = coordView === 'program'
      ? 'Values formatted the way each program expects. Pin the programs you use to keep them at the top. Click any value to copy it.'
      : 'Every distinct value once, grouped by type. Tags show which programs use each format. Click any value to copy it.';
    if (state.lat == null) {
      box.innerHTML = '<p class="muted" style="padding:12px 0">No site selected yet. Search for a place, paste coordinates, click the map, or use your GPS.</p>';
      return;
    }
    if (coordView === 'type') renderByType(box);
    else renderProgramCards(box);
  }
  const renderValues = renderCoords;

  $$('#tab-coords [data-view]').forEach((b) => b.addEventListener('click', () => {
    coordView = b.dataset.view;
    try { localStorage.setItem('astrosite.view', coordView); } catch (e) { /* ignore */ }
    renderCoords();
  }));

  document.addEventListener('click', (e) => {
    const pb = e.target.closest('button[data-pin]');
    if (!pb) return;
    const name = pb.dataset.pin;
    pins = pins.includes(name) ? pins.filter((n) => n !== name) : [...pins, name];
    try { localStorage.setItem('astrosite.pins', JSON.stringify(pins)); } catch (err) { /* ignore */ }
    renderCoords();
    toast(pins.includes(name) ? `Pinned ${name} to the top` : `Unpinned ${name}`);
  });

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
        short: 'N.I.N.A.',
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
        short: 'ASTAP',
        snippetLabel: 'FITS site keywords',
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
        short: 'MLAstro / generic',
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
        short: 'PixInsight',
        snippetLabel: 'OBSGEO keywords',
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
        short: 'Siril',
        where: 'Siril reads SITELAT / SITELONG / SITEELEV from FITS headers (decimal degrees, East positive).',
        rows: [
          ['SITELAT', fixed(lat, 6)],
          ['SITELONG', fixed(lon, 6)],
          ['SITEELEV', String(elevR)],
        ],
      },
      {
        name: 'Stellarium',
        short: 'Stellarium',
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
        short: 'KStars / INDI',
        snippetLabel: 'INDI indi_setprop command',
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
        short: 'ASCOM · SGPro · APT · SharpCap · MaxIm',
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
        short: 'LX200 / OnStep',
        snippetLabel: 'LX200 serial commands',
        where: 'Classic LX200 protocol: latitude sDD*MM, longitude DDD*MM measured West-positive (0–360).',
        rows: [
          ['Latitude', A.lx200Lat(lat)],
          ['Longitude (+W)', A.lx200Long(lon)],
        ],
        snippet: `:St${A.lx200Lat(lat)}#\n:Sg${A.lx200Long(lon)}#`,
      },
      {
        name: 'FITS header block',
        short: 'FITS header',
        snippetLabel: 'FITS header block',
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

  function renderProgramCards(box) {
    const list = programs();
    const pinned = pins.map((n) => list.find((p) => p.name === n)).filter(Boolean);
    const rest = list.filter((p) => !pins.includes(p.name));
    const card = (p, isPinned) => `
      <section class="pcard${isPinned ? ' pinned' : ''}">
        <header><h4>${esc(p.name)}</h4>
          <button class="pin" data-pin="${esc(p.name)}" aria-pressed="${isPinned}" title="${isPinned ? 'Unpin' : 'Pin to top'}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-5-5 5H3v-1l5-5-5-4 2-2 5 1 4-4z"/></svg>${isPinned ? 'Pinned' : 'Pin'}
          </button>
        </header>
        <div class="where">${esc(p.where)}</div>
        ${p.rows ? `<table class="vals"><tbody>${p.rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v" title="Click to copy">${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${p.snippet ? `<pre class="snip" title="Click to copy">${esc(p.snippet)}</pre>` : ''}
      </section>`;
    box.innerHTML = (pinned.length ? `<div class="pin-head">Pinned</div>${pinned.map((p) => card(p, true)).join('')}<div class="pin-head">All programs</div>` : '')
      + rest.map((p) => card(p, false)).join('');
  }
  const renderPrograms = renderCoords;

  /* ---------------- Night forecast (Astrospheric-style hourly grid, 14 days) ---------------- */
  function siteOffsetSec() {
    if (state.utcOffset != null) return state.utcOffset;
    return Math.round(state.lon / 15) * 3600;
  }

  function fmtTime(d, opts = {}) {
    if (!d || isNaN(d)) return '—';
    const o = { hour: '2-digit', minute: '2-digit', hour12: false, ...opts };
    if (state.tz) return new Intl.DateTimeFormat('en-GB', { ...o, timeZone: state.tz }).format(d);
    return new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(new Date(d.getTime() + siteOffsetSec() * 1000));
  }
  const fmtHour = (d) => fmtTime(d, { minute: undefined }).slice(0, 2);
  const fmtDay = (d) => fmtTime(d, { hour: undefined, minute: undefined, weekday: 'short', day: 'numeric', month: 'short' });

  function fmtDur(ms) {
    if (!(ms > 0)) return '0h 00m';
    const m = Math.round(ms / 60000);
    return `${Math.floor(m / 60)}h ${A.pad(m % 60, 2)}m`;
  }

  function moonPhaseName(phase) {
    const names = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return names[Math.round(phase * 8) % 8];
  }

  // Small moon-phase disc: lit fraction drawn on the right when waxing, left when waning (northern-hemisphere view)
  function moonDisc(frac, phase) {
    const lit = Math.round(frac * 100);
    const dir = (phase < 0.5) === (state.lat >= 0) ? 'to left' : 'to right';
    return `<i class="mdisc" style="background:linear-gradient(${dir}, #f2ecc8 ${lit}%, #2a3046 ${lit}%)"></i>`;
  }

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => (deg == null ? '' : COMPASS[Math.round(A.mod(deg, 360) / 22.5) % 16]);

  // Units
  const U = {
    temp: (c) => (c == null ? null : state.units === 'metric' ? c : c * 9 / 5 + 32),
    tempU: () => (state.units === 'metric' ? '°C' : '°F'),
    wind: (ms) => (ms == null ? null : state.units === 'metric' ? ms * 3.6 : ms * 2.23694),
    windU: () => (state.units === 'metric' ? 'km/h' : 'mph'),
    vis: (m) => (m == null ? null : state.units === 'metric' ? m / 1000 : m / 1609.344),
    visU: () => (state.units === 'metric' ? 'km' : 'mi'),
    spread: (c) => (c == null ? null : state.units === 'metric' ? c : c * 9 / 5),
  };

  /* Build per-hour records from the Open-Meteo responses. */
  function buildForecast(meta, aq) {
    const H = meta.hourly;
    const off = meta.utc_offset_seconds * 1000;
    const toDate = (t) => new Date(Date.parse(t + ':00Z') - off);
    const aodMap = new Map();
    if (aq && aq.hourly && aq.hourly.time) {
      const aoff = (aq.utc_offset_seconds || 0) * 1000;
      aq.hourly.time.forEach((t, i) => {
        const v = aq.hourly.aerosol_optical_depth[i];
        if (v != null) aodMap.set(Date.parse(t + ':00Z') - aoff, v);
      });
    }
    const g = (k, i) => (H[k] ? H[k][i] : null);
    let hours = H.time.map((t, i) => {
      const date = toDate(t);
      const h = {
        t: date,
        cloud: g('cloud_cover', i), cloudLow: g('cloud_cover_low', i), cloudMid: g('cloud_cover_mid', i), cloudHigh: g('cloud_cover_high', i),
        vis: g('visibility', i), temp: g('temperature_2m', i), dew: g('dew_point_2m', i), rh: g('relative_humidity_2m', i),
        wind: g('wind_speed_10m', i), gust: g('wind_gusts_10m', i), wdir: g('wind_direction_10m', i),
        precip: g('precipitation_probability', i), pressure: g('surface_pressure', i), tcwv: g('total_column_integrated_water_vapour', i),
        ws850: g('wind_speed_850hPa', i), wd850: g('wind_direction_850hPa', i), ws500: g('wind_speed_500hPa', i), wd500: g('wind_direction_500hPa', i),
        ws300: g('wind_speed_300hPa', i), wd300: g('wind_direction_300hPa', i), ws200: g('wind_speed_200hPa', i),
        aod: aodMap.has(date.getTime()) ? aodMap.get(date.getTime()) : null,
      };
      const sun = SunCalc.getPosition(date, state.lat, state.lon);
      const moon = SunCalc.getMoonPosition(date, state.lat, state.lon);
      h.sunAlt = sun.altitude * A.R2D;
      h.moonAlt = moon.altitude * A.R2D;
      const mi = SunCalc.getMoonIllumination(date);
      h.moonIllum = mi.fraction;
      h.moonPhase = mi.phase;
      h.see = SM.seeing(h);
      h.trans = SM.transparency(h);
      h.fog = SM.fog(h);
      h.dewRisk = SM.dewRisk(h.fog.spread);
      h.score = SM.imagingScore({ cloud: h.cloud, trans: h.trans, see: h.see, sunAlt: h.sunAlt, moonAlt: h.moonAlt, moonIllum: h.moonIllum, fogLevel: h.fog.level });
      return h;
    });
    // Drop hours that are already past (keep the previous hour for context)
    const cutoff = Date.now() - 2 * 3600000;
    while (hours.length > 24 && hours[0].t.getTime() < cutoff) hours.shift();
    const aodHours = hours.filter((h) => h.aod != null).length;
    return { hours, aodHours, model: 'Open-Meteo best match + CAMS aerosols' };
  }

  /* Colour scales: darker = better. Blue when the hour has full data, red when inputs are missing or estimated. */
  function shade(q, limited) {
    if (q == null || !isFinite(q)) return null;
    q = Math.max(0, Math.min(1, q));
    const L = 88 - q * 70; // 88% (worst, near white) → 18% (best)
    const S = 25 + q * 50;
    const hue = limited ? 2 : 216;
    return { bg: `hsl(${hue} ${limited ? S + 10 : S}% ${L}%)`, fg: L < 55 ? '#eef3ff' : '#0b1220' };
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // Row definitions: each returns {q, txt, lim, nodata, mark, title}
  function rowDefs() {
    const n = (v, d = 0) => (v == null ? '' : (+v).toFixed(d));
    return [
      { key: 'score', label: 'Imaging score', sub: '0–100 · higher = better', group: 'Summary',
        cell: (h) => {
          if (h.score == null) return { q: null, txt: '', day: true };
          const lim = !!(h.trans && (h.trans.aodEst || h.trans.pwvEst)) || h.see == null || h.vis == null;
          return { q: h.score / 100, txt: String(h.score), lim, nodata: h.cloud == null };
        } },
      { key: 'sun', label: 'Sun altitude', sub: '° · twilight / darkness', group: 'Darkness',
        cell: (h) => ({ q: clamp01(-h.sunAlt / 18), txt: String(Math.round(h.sunAlt)), title: `Sun ${h.sunAlt.toFixed(1)}° — ${h.sunAlt <= -18 ? 'astronomical night' : h.sunAlt <= -12 ? 'astronomical twilight' : h.sunAlt <= -6 ? 'nautical twilight' : h.sunAlt <= 0 ? 'civil twilight' : 'day'}` }) },
      { key: 'moonAlt', label: 'Moon altitude', sub: '° above horizon', group: 'Moonlight',
        cell: (h) => (h.moonAlt > 0
          ? { q: 1 - clamp01(h.moonAlt / 60) * (0.35 + 0.65 * h.moonIllum), txt: String(Math.round(h.moonAlt)), title: `Moon ${h.moonAlt.toFixed(1)}° above the horizon` }
          : { q: 1, txt: '', title: `Moon below horizon (${h.moonAlt.toFixed(0)}°)` }) },
      { key: 'moonIllum', label: 'Moon illumination', sub: '% lit · phase', group: 'Moonlight',
        cell: (h) => ({ q: 1 - h.moonIllum, html: `${moonDisc(h.moonIllum, h.moonPhase)}${Math.round(h.moonIllum * 100)}`, title: `${Math.round(h.moonIllum * 100)}% illuminated — ${moonPhaseName(h.moonPhase)}${h.moonAlt > 0 ? ', above horizon' : ', below horizon'}` }) },
      { key: 'cloud', label: 'Cloud cover', sub: 'total %', group: 'Sky',
        cell: (h) => (h.cloud == null ? { nodata: true } : { q: 1 - h.cloud / 100, txt: n(h.cloud), lim: h.cloudLow == null || h.cloudHigh == null }) },
      { key: 'cloudLow', label: 'Low cloud', sub: '% · below 2 km', group: 'Sky',
        cell: (h) => (h.cloudLow == null ? { nodata: true } : { q: 1 - h.cloudLow / 100, txt: n(h.cloudLow) }) },
      { key: 'cloudMid', label: 'Mid cloud', sub: '% · 2–6 km', group: 'Sky',
        cell: (h) => (h.cloudMid == null ? { nodata: true } : { q: 1 - h.cloudMid / 100, txt: n(h.cloudMid) }) },
      { key: 'cloudHigh', label: 'High cloud', sub: '% · above 6 km (cirrus)', group: 'Sky',
        cell: (h) => (h.cloudHigh == null ? { nodata: true } : { q: 1 - h.cloudHigh / 100, txt: n(h.cloudHigh) }) },
      { key: 'trans', label: 'Transparency', sub: 'water vapour · aerosol · cirrus', group: 'Sky',
        cell: (h) => {
          if (!h.trans) return { nodata: true };
          const lim = h.trans.aodEst || h.trans.pwvEst;
          if (h.trans.cls === 0) return { q: 0, txt: '', lim, title: `Cloudy (index ${h.trans.index.toFixed(0)})` };
          return { q: clamp01(1 - h.trans.index / 30), txt: String(h.trans.cls), lim, title: `${SM.TRANS_LABELS[h.trans.cls]} · index ${h.trans.index.toFixed(1)}${lim ? ' · estimated inputs' : ''}` };
        } },
      { key: 'see', label: 'Seeing', sub: 'est. arcsec', group: 'Sky',
        cell: (h) => {
          if (!h.see) return { nodata: true };
          const lim = h.wd850 == null || h.wd500 == null || h.wd300 == null || h.gust == null;
          if (h.see.cls === 0) return { q: 0, txt: '', lim, title: `Cloudy (est. ${h.see.arcsec.toFixed(1)}″)` };
          return { q: clamp01((4.5 - h.see.arcsec) / 3.5), txt: h.see.arcsec.toFixed(1), lim, title: `${SM.SEEING_LABELS[h.see.cls]} · ~${h.see.arcsec.toFixed(1)}″ · jet ${h.see.jet.toFixed(0)} m/s` };
        } },
      { key: 'fog', label: 'Mist / fog', sub: `visibility`, group: 'Ground',
        cell: (h) => {
          const f = h.fog;
          if (f.vis == null && f.spread == null) return { nodata: true };
          const q = f.vis != null ? clamp01(Math.log10(Math.max(f.vis, 200) / 200) / 2) : clamp01(f.spread / 6);
          const v = U.vis(f.vis);
          return { q, txt: f.vis == null ? '' : v >= 20 ? '' : v.toFixed(v < 10 ? 1 : 0), lim: f.vis == null, mark: f.level >= 1, title: `${f.label}${f.vis != null ? ` · visibility ${U.vis(f.vis).toFixed(1)} ${U.visU()}` : ' · no visibility data, judged from dew-point spread'}` };
        } },
      { key: 'wind', label: 'Wind speed', sub: '10 m', group: 'Ground',
        cell: (h) => (h.wind == null ? { nodata: true } : { q: clamp01(1 - h.wind / 12), txt: String(Math.round(U.wind(h.wind))), title: `${Math.round(U.wind(h.wind))} ${U.windU()}` }) },
      { key: 'wdir', label: 'Wind direction', sub: 'arrow = blowing toward', group: 'Ground',
        cell: (h) => (h.wdir == null ? { nodata: true } : { q: clamp01(1 - (h.wind || 0) / 12), lim: h.wind == null, html: `<i class="arr" style="transform:rotate(${(h.wdir + 180) % 360}deg)">↑</i>`, title: `From ${compass(h.wdir)} (${Math.round(h.wdir)}°)` }) },
      { key: 'gust', label: 'Wind gusts', sub: '', group: 'Ground',
        cell: (h) => (h.gust == null ? { nodata: true } : { q: clamp01(1 - h.gust / 18), txt: String(Math.round(U.wind(h.gust))) }) },
      { key: 'temp', label: 'Temperature', sub: '', group: 'Ground',
        cell: (h) => (h.temp == null ? { nodata: true } : { q: clamp01(1 - (h.temp + 20) / 55), txt: String(Math.round(U.temp(h.temp))) }) },
      { key: 'dew', label: 'Dew point', sub: 'orange = fog / dew risk', group: 'Ground',
        cell: (h) => {
          if (h.dew == null) return { nodata: true };
          const sp = h.fog.spread;
          return { q: sp == null ? null : clamp01(sp / 8), txt: String(Math.round(U.temp(h.dew))), lim: h.temp == null, mark: h.dewRisk.level >= 1, warn2: h.dewRisk.level >= 2, title: `${h.dewRisk.label}${sp != null ? ` · spread ${U.spread(sp).toFixed(1)}${U.tempU()}` : ''}` };
        } },
      { key: 'rh', label: 'Humidity', sub: '%', group: 'Ground',
        cell: (h) => (h.rh == null ? { nodata: true } : { q: clamp01(1 - (h.rh - 30) / 70), txt: String(Math.round(h.rh)) }) },
    ];
  }

  function nightOf(date) {
    // A "night" is labelled by the evening it starts: hours before local noon belong to the previous evening.
    const off = siteOffsetSec() * 1000;
    const local = date.getTime() + off;
    const day = 86400000;
    let mid = Math.floor(local / day) * day;
    if ((local - mid) / 3600000 < 12) mid -= day;
    return new Date(mid + 12 * 3600000 - off); // local noon (as UTC instant) starting that night
  }

  function nightSummary(noon) {
    const { lat, lon } = state;
    const ev = SunCalc.getTimes(noon, lat, lon);
    const mo = SunCalc.getTimes(new Date(noon.getTime() + 86400000), lat, lon);
    const step = 5 * 60000;
    let astroDark = 0, moonFree = 0, moonRise = null, moonSet = null, prevMoon = null;
    let moonUpAll = true, moonDownAll = true;
    for (let t = noon.getTime() + 4 * 3600000; t <= noon.getTime() + 20 * 3600000; t += step) {
      const d = new Date(t);
      const s = SunCalc.getPosition(d, lat, lon).altitude * A.R2D;
      const m = SunCalc.getMoonPosition(d, lat, lon).altitude * A.R2D;
      if (s < -18) { astroDark += step; if (m < 0) moonFree += step; }
      if (prevMoon != null) {
        if (prevMoon < 0 && m >= 0 && !moonRise) moonRise = d;
        if (prevMoon >= 0 && m < 0 && !moonSet) moonSet = d;
      }
      if (m >= 0) moonDownAll = false; else moonUpAll = false;
      prevMoon = m;
    }
    const illum = SunCalc.getMoonIllumination(new Date(noon.getTime() + 12 * 3600000));
    return { ev, mo, astroDark, moonFree, moonRise, moonSet, moonUpAll, moonDownAll, illum };
  }

  let fcKeyHandlerBound = false;

  function renderTonight() {
    const box = $('#tonight');
    if (state.lat == null) { box.innerHTML = '<p class="muted" style="padding:12px 0">Pick a location first.</p>'; return; }
    if (typeof SunCalc === 'undefined') { box.innerHTML = '<p class="muted">Ephemeris library failed to load.</p>'; return; }
    const fc = state.fc;
    if (!fc) { box.innerHTML = '<p class="muted" style="padding:12px 0">Loading the 14-day forecast…</p>'; return; }

    const hours = fc.hours;
    if (state.fcSel == null || state.fcSel >= hours.length) {
      // default: first hour after astronomical dusk tonight (or now if already dark)
      const now = Date.now();
      let i = hours.findIndex((h) => h.t.getTime() >= now - 3600000 && h.sunAlt <= -18);
      if (i < 0) i = hours.findIndex((h) => h.t.getTime() >= now - 3600000);
      state.fcSel = Math.max(0, i);
    }

    const rows = rowDefs();
    // Day header (local dates)
    const dayGroups = [];
    hours.forEach((h, i) => {
      const lbl = fmtDay(h.t);
      if (!dayGroups.length || dayGroups[dayGroups.length - 1].lbl !== lbl) dayGroups.push({ lbl, n: 0, start: i });
      dayGroups[dayGroups.length - 1].n++;
    });
    const nowIdx = hours.findIndex((h, i) => i + 1 < hours.length && hours[i + 1].t.getTime() > Date.now());

    let html = '<table class="fc"><thead>';
    html += `<tr class="fc-days"><th class="fc-lbl"></th>${dayGroups.map((g) => `<th colspan="${g.n}" class="fc-day"><span class="dl">${g.n >= 3 ? esc(g.lbl) : ''}</span></th>`).join('')}</tr>`;
    html += `<tr class="fc-hours"><th class="fc-lbl">Hour <span class="muted">(${esc(state.tz || 'local')})</span></th>${hours.map((h, i) => {
      const dark = h.sunAlt <= -18 ? 'd4' : h.sunAlt <= -12 ? 'd3' : h.sunAlt <= -6 ? 'd2' : h.sunAlt <= 0 ? 'd1' : 'd0';
      return `<th data-c="${i}" class="${dark}${i === nowIdx ? ' now' : ''}">${fmtHour(h.t)}</th>`;
    }).join('')}</tr></thead><tbody>`;
    let lastGroup = '';
    rows.forEach((r) => {
      if (r.group !== lastGroup) {
        html += `<tr class="fc-group"><th class="fc-lbl">${esc(r.group)}</th><td colspan="${hours.length}"></td></tr>`;
        lastGroup = r.group;
      }
      const unit = r.key === 'wind' || r.key === 'gust' ? U.windU() : r.key === 'temp' || r.key === 'dew' ? U.tempU() : r.key === 'fog' ? U.visU() : '';
      html += `<tr class="fc-row${r.minor ? ' minor' : ''}"><th class="fc-lbl">${esc(r.label)}<small>${esc([r.sub, unit].filter(Boolean).join(' · '))}</small></th>`;
      hours.forEach((h, i) => {
        const c = r.cell(h);
        if (c.nodata) { html += `<td data-c="${i}" class="nd" title="No data for this hour">·</td>`; return; }
        const col = c.day ? null : shade(c.q, c.lim);
        const cls = [c.mark ? (c.warn2 ? 'mk2' : 'mk') : '', c.lim ? 'lim' : '', c.day ? 'day' : ''].filter(Boolean).join(' ');
        const style = col ? ` style="background:${col.bg};color:${col.fg}"` : '';
        const title = c.title ? ` title="${esc(c.title)}${c.lim ? ' — limited data' : ''}"` : (c.lim ? ' title="Limited data — some inputs missing or estimated"' : '');
        html += `<td data-c="${i}"${cls ? ` class="${cls}"` : ''}${style}${title}>${c.html || esc(c.txt || '')}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

    const firstLimitedTrans = hours.findIndex((h) => h.trans && h.trans.aodEst);
    const tzLabel = state.tz ? `${state.tz} (${offsetString(state.utcOffset)})` : `approx. ${offsetString(siteOffsetSec())}`;
    const scaleBar = (lim) => `<span class="scale">${[0, 0.25, 0.5, 0.75, 1].map((q) => `<i style="background:${shade(q, lim).bg}"></i>`).join('')}</span>`;

    box.innerHTML = `
      <div class="fc-nav">
        <div class="fc-nav-btns">
          <button class="btn small" data-nav="prev" title="Previous night (Page Up)">◀ Prev night</button>
          <button class="btn small" data-nav="tonight">Tonight</button>
          <button class="btn small" data-nav="next" title="Next night (Page Down)">Next night ▶</button>
        </div>
        <div class="seg" role="group" aria-label="Units">
          <button data-units="metric" class="${state.units === 'metric' ? 'on' : ''}">Metric</button>
          <button data-units="imperial" class="${state.units === 'imperial' ? 'on' : ''}">Imperial</button>
        </div>
      </div>
      <input type="range" class="fc-slider" min="0" max="${hours.length - 1}" value="${state.fcSel}" aria-label="Scroll through the forecast hours">
      <div class="fc-scroll" tabindex="0" aria-label="Hourly forecast grid; use arrow keys to move between hours">${html}</div>
      <div class="fc-legend">
        <span>${scaleBar(false)} full data</span>
        <span>${scaleBar(true)} limited data (inputs missing or estimated)</span>
        <span><i class="nd-swatch">·</i> no data</span>
        <span><i class="mk-swatch"></i> fog / dew risk</span>
        <span class="muted">Darker = better. ${esc(tzLabel)}.</span>
      </div>
      ${firstLimitedTrans > 0 ? `<p class="fc-note">Aerosol (smoke / haze) forecasts end ${esc(fmtDay(hours[firstLimitedTrans].t))} ${fmtTime(hours[firstLimitedTrans].t)}; after that, transparency and the imaging score assume typical clean air and are shown in red.</p>` : ''}
      <div id="fcDetail"></div>
      <div id="fcNight"></div>
      <details class="fc-about">
        <summary>About these forecasts</summary>
        <p><b>Cloud cover</b> (total and low / mid / high layers), <b>visibility</b>, <b>wind</b>, <b>temperature</b>, <b>dew point</b> and <b>humidity</b> come straight from the Open-Meteo best-match weather models (14 days). Long-range hours come from coarser global models, so treat days 8–14 as a trend.</p>
        <p><b>Transparency</b> follows Astrospheric's scale: index 0–5 excellent, 6–9 above average, 10–13 average, 14–23 below average, 24–27 poor, above 27 cloudy. It's estimated here from precipitable water vapour, CAMS aerosol optical depth (smoke, dust, haze), high-cloud fraction and surface pressure (elevation).</p>
        <p><b>Seeing</b> is an estimate in arcseconds from jet-stream speed (300 / 200 hPa), vertical wind shear between 850, 500 and 300 hPa, and surface gusts. Ratings: excellent &lt;1.4″, above average &lt;1.9″, average &lt;2.6″, below average &lt;3.4″, poor beyond that. Above ${SM.CLOUDY}% cloud, both are reported as cloudy.</p>
        <p><b>Mist / fog</b> uses forecast visibility: under 1 km is fog, 1–5 km is mist. An orange mark means radiation fog or heavy dew is likely (temperature within 2 °C of the dew point; amber within 4 °C).</p>
        <p><b>Red cells</b> mark hours where an input was missing and a fallback was used, for example typical aerosol levels beyond the aerosol forecast range, or dew-point-derived water vapour.</p>
      </details>
      <h5 class="sec">Open this site in</h5>
      <div class="links">
        <a href="https://clearoutside.com/forecast/${state.lat.toFixed(2)}/${state.lon.toFixed(2)}" target="_blank" rel="noopener">Clear Outside</a>
        <a href="https://www.astrospheric.com/" target="_blank" rel="noopener">Astrospheric</a>
        <a href="https://lightpollutionmap.app/?lat=${state.lat.toFixed(5)}&lng=${state.lon.toFixed(5)}" target="_blank" rel="noopener">Light Pollution Map</a>
        <a href="https://www.openstreetmap.org/?mlat=${state.lat.toFixed(6)}&mlon=${state.lon.toFixed(6)}#map=14/${state.lat.toFixed(5)}/${state.lon.toFixed(5)}" target="_blank" rel="noopener">OpenStreetMap</a>
      </div>`;

    const scroller = $('.fc-scroll', box);
    const slider = $('.fc-slider', box);
    scroller.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-c]');
      if (cell) selectHour(+cell.dataset.c, false);
    });
    slider.addEventListener('input', () => selectHour(+slider.value, true));
    scroller.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, PageDown: 'next', PageUp: 'prev', Home: 'tonight' }[e.key];
      if (step == null) return;
      e.preventDefault();
      if (typeof step === 'number') selectHour(state.fcSel + step, true);
      else navNight(step);
    });
    $$('[data-nav]', box).forEach((b) => b.addEventListener('click', () => navNight(b.dataset.nav)));
    $$('[data-units]', box).forEach((b) => b.addEventListener('click', () => {
      state.units = b.dataset.units;
      try { localStorage.setItem('astrosite.units', state.units); } catch (err) { /* ignore */ }
      const sl = scroller.scrollLeft;
      renderTonight();
      $('.fc-scroll').scrollLeft = sl;
    }));
    selectHour(state.fcSel, true, true);
  }

  function navNight(dir) {
    const hours = state.fc.hours;
    const curNight = nightOf(hours[state.fcSel].t).getTime();
    let target;
    if (dir === 'tonight') target = nightOf(new Date()).getTime();
    else target = curNight + (dir === 'next' ? 1 : -1) * 86400000;
    // first astro-dark hour of that night, else first hour after sunset, else local 22:00
    const inNight = hours.map((h, i) => [h, i]).filter(([h]) => Math.abs(nightOf(h.t).getTime() - target) < 3600000);
    if (!inNight.length) return;
    const pick = inNight.find(([h]) => h.sunAlt <= -18) || inNight.find(([h]) => h.sunAlt <= 0) || inNight[10] || inNight[0];
    selectHour(pick[1], true, false, true);
  }

  function selectHour(i, scroll, instant, alignNight) {
    const hours = state.fc.hours;
    i = Math.max(0, Math.min(hours.length - 1, i));
    state.fcSel = i;
    const box = $('#tonight');
    $$('.sel', box).forEach((el) => el.classList.remove('sel'));
    $$(`[data-c="${i}"]`, box).forEach((el) => el.classList.add('sel'));
    const slider = $('.fc-slider', box);
    if (slider && +slider.value !== i) slider.value = i;
    if (scroll) {
      const scroller = $('.fc-scroll', box);
      const th = $(`thead [data-c="${i}"]`, box);
      const lblW = $('.fc-lbl', box).offsetWidth;
      if (scroller && th) {
        const colLeft = th.offsetLeft;
        const view = scroller.clientWidth - lblW;
        let left = scroller.scrollLeft;
        if (alignNight) left = colLeft - lblW - 3 * th.offsetWidth;
        else if (colLeft - lblW < scroller.scrollLeft || colLeft + th.offsetWidth > scroller.scrollLeft + lblW + view) left = colLeft - lblW - view / 2;
        scroller.scrollTo({ left: Math.max(0, left), behavior: instant ? 'auto' : 'smooth' });
      }
    }
    renderHourDetail(hours[i]);
    renderNightSummary(hours[i].t);
  }

  function renderHourDetail(h) {
    const el = $('#fcDetail');
    if (!el) return;
    const v = (x, d = 0) => (x == null ? '—' : (+x).toFixed(d));
    const limTag = (b) => (b ? ' <span class="limtag">limited</span>' : '');
    const seeTxt = h.see ? (h.see.cls === 0 ? `Cloudy (~${h.see.arcsec.toFixed(1)}″ if clear)` : `${SM.SEEING_LABELS[h.see.cls]} · ~${h.see.arcsec.toFixed(1)}″`) : '—';
    const trTxt = h.trans ? `${SM.TRANS_LABELS[h.trans.cls]} · index ${h.trans.index.toFixed(1)}` : '—';
    const items = [
      ['Imaging score', h.score == null ? 'daylight / twilight' : `${h.score} / 100`],
      ['Sun', `${h.sunAlt.toFixed(1)}° ${h.sunAlt <= -18 ? '(astronomical night)' : h.sunAlt <= -12 ? '(astro twilight)' : h.sunAlt <= -6 ? '(nautical twilight)' : h.sunAlt <= 0 ? '(civil twilight)' : '(day)'}`],
      ['Moon', h.moonAlt > 0 ? `${h.moonAlt.toFixed(0)}° high · ${Math.round(h.moonIllum * 100)}% lit` : `below horizon · ${Math.round(h.moonIllum * 100)}% lit`],
      ['Cloud', `${v(h.cloud)}% (low ${v(h.cloudLow)} · mid ${v(h.cloudMid)} · high ${v(h.cloudHigh)})`],
      ['Transparency', trTxt + limTag(h.trans && (h.trans.aodEst || h.trans.pwvEst))],
      ['  · water vapour', h.trans ? `${h.trans.pwv.toFixed(1)} mm${h.trans.pwvEst ? ' (from dew point)' : ''}` : '—'],
      ['  · aerosol optical depth', h.trans ? `${h.trans.aod.toFixed(2)}${h.trans.aodEst ? ' (assumed — beyond aerosol forecast)' : ''}` : '—'],
      ['Seeing', seeTxt + limTag(h.wd300 == null)],
      ['  · jet stream / shear', h.see ? `${Math.round(U.wind(h.see.jet))} ${U.windU()} · shear ${Math.round(U.wind(h.see.shear))} ${U.windU()}` : '—'],
      ['Mist / fog', `${h.fog.label}${h.vis != null ? ` · visibility ${U.vis(h.vis).toFixed(1)} ${U.visU()}` : ''}` + limTag(h.vis == null)],
      ['Wind', h.wind == null ? '—' : `${Math.round(U.wind(h.wind))} ${U.windU()} from ${compass(h.wdir)} (${v(h.wdir)}°) · gusts ${h.gust == null ? '—' : Math.round(U.wind(h.gust))} ${U.windU()}`],
      ['Temperature / dew point', h.temp == null ? '—' : `${U.temp(h.temp).toFixed(1)} / ${U.temp(h.dew).toFixed(1)} ${U.tempU()} · ${h.dewRisk.label}`],
      ['Humidity / pressure', `${v(h.rh)}% · ${v(h.pressure)} hPa`],
      ['Precipitation chance', h.precip == null ? '—' : `${h.precip}%`],
    ];
    el.innerHTML = `<h5 class="sec">${esc(fmtDay(h.t))} · ${fmtTime(h.t)}</h5>
      <table class="vals fc-detail"><tbody>${items.map(([k, val]) => `<tr><td class="k">${esc(k)}</td><td>${val}</td></tr>`).join('')}</tbody></table>`;
  }

  let lastNightKey = null;
  function renderNightSummary(t) {
    const el = $('#fcNight');
    if (!el) return;
    const noon = nightOf(t);
    const key = `${noon.getTime()}|${state.lat}|${state.lon}`;
    if (key === lastNightKey && el.innerHTML) return;
    lastNightKey = key;
    const s = nightSummary(noon);
    const cell = (l, tt, sub) => `<div class="tn-cell"><div class="l">${l}</div><div class="t">${tt}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    const moonTxt = s.moonUpAll ? 'up all night' : s.moonDownAll ? 'below horizon all night'
      : [s.moonRise ? `rises ${fmtTime(s.moonRise)}` : 'up at dusk', s.moonSet ? `sets ${fmtTime(s.moonSet)}` : 'up at dawn'].join(' · ');
    el.innerHTML = `
      <h5 class="sec">Night of ${esc(fmtDay(noon))}</h5>
      <div class="tn-grid">
        ${cell('Sunset', fmtTime(s.ev.sunset), `Civil dusk ${fmtTime(s.ev.dusk)}`)}
        ${cell('Sunrise', fmtTime(s.mo.sunrise), `Civil dawn ${fmtTime(s.mo.dawn)}`)}
        ${cell('Astro dusk (−18°)', fmtTime(s.ev.night), `Nautical dusk ${fmtTime(s.ev.nauticalDusk)}`)}
        ${cell('Astro dawn (−18°)', fmtTime(s.mo.nightEnd), `Nautical dawn ${fmtTime(s.mo.nauticalDawn)}`)}
        ${cell('Darkness', fmtDur(s.astroDark), isNaN(s.ev.night) ? 'No astronomical darkness' : `${fmtDur(s.moonFree)} moon-free`)}
        ${cell('Moon', `${Math.round(s.illum.fraction * 100)}%`, `${moonPhaseName(s.illum.phase)} · ${moonTxt}`)}
      </div>`;
  }

  /* ---------------- Export ---------------- */
  function exportRows() {
    const rows = [];
    byType().forEach((g) => g.rows.forEach((r) => {
      if (r.snip) return;
      rows.push([g.title, r.k + (r.sub ? ` (${r.sub})` : '') + (r.progs.length ? ` [${r.progs.join(', ')}]` : ''), r.lv ? live[r.lv]() : r.v]);
    }));
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
      try {
        localStorage.setItem('astrosite.last', JSON.stringify({
          lat: state.lat, lon: state.lon, name: state.name, sub: state.sub, z: map.getZoom(),
          elev: state.elevSource === 'manual entry' || /GPS/.test(state.elevSource) ? state.elev : null,
          elevSource: state.elevSource,
        }));
      } catch (e) { /* storage unavailable */ }
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
    document.body.classList.toggle('fc-wide', t.dataset.tab === 'tonight');
    if (t.dataset.tab === 'tonight') renderTonight();
    setTimeout(() => map.invalidateSize(), 50);
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
    renderCoords();
    if (!$('#tab-tonight').hidden) renderTonight();
  }

  // Live clock cells
  setInterval(() => {
    if (state.lat == null) return;
    $$('[data-live]').forEach((el) => { if (!el.classList.contains('copied')) el.textContent = live[el.dataset.live](); });
  }, 1000);

  window.addEventListener('hashchange', () => {
    const p = new URLSearchParams(location.hash.slice(1));
    const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
    if (isFinite(lat) && isFinite(lon) && (Math.abs(lat - state.lat) > 1e-6 || Math.abs(lon - state.lon) > 1e-6)) readHash();
  });

  function restoreLast() {
    try {
      const s = JSON.parse(localStorage.getItem('astrosite.last') || 'null');
      if (!s || !isFinite(s.lat) || !isFinite(s.lon)) return false;
      setLocation(s.lat, s.lon, {
        zoom: s.z || 11, name: s.name || '', sub: s.sub || '',
        elev: s.elev != null && isFinite(s.elev) ? s.elev : null, elevSource: s.elevSource || 'manual entry',
      });
      return true;
    } catch (e) { return false; }
  }
  try { if (localStorage.getItem('astrosite.units') === 'imperial') state.units = 'imperial'; } catch (e) { /* ignore */ }

  renderAll();
  if (!readHash() && !restoreLast()) {
    setTimeout(() => input.focus(), 50);
  }
})();
