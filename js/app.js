/* Astro Planner — UI. MIT License. */
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
  const OM = window.OpenMeteo;
  const APP_VERSION = '1.9.0';

  const state = {
    lat: null, lon: null,
    elev: null, elevSource: '',
    name: '', sub: '',
    tz: null, utcOffset: null,
    clouds: null, // [{t: Date, c: %}]
    fc: null, fcSel: null, showVals: true, lp: null, lpErr: null, fcEdit: false,
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
  L.control.scale({ imperial: true, metric: true }).addTo(map);

  // Light-pollution overlay (Lorenz atlas tiles: 1024 px, native to zoom 8)
  // Own pane above the base tiles (tilePane z 200) and below vectors/markers (z 400+)
  map.createPane('lpPane');
  map.getPane('lpPane').style.zIndex = 250;
  map.getPane('lpPane').style.pointerEvents = 'none';
  const lpLayer = L.tileLayer(window.LightPollution.overlayUrl, {
    pane: 'lpPane',
    minZoom: 2, maxNativeZoom: 8, maxZoom: 19, tileSize: 1024, zoomOffset: -2, opacity: 0.5,
    errorTileUrl: window.LightPollution.errorTile,
    attribution: 'Light pollution: <a href="https://djlorenz.github.io/astronomy/lp/" target="_blank" rel="noopener">D. Lorenz atlas ' + window.LightPollution.YEAR + '</a>',
  });
  let mapQuality = 'standard';
  let smoothMapPref = false, smoothDataPref = false;
  try {
    mapQuality = localStorage.getItem('astrosite.quality') === 'high' ? 'high' : 'standard';
    smoothMapPref = localStorage.getItem('astrosite.smoothMap') === '1';
    smoothDataPref = localStorage.getItem('astrosite.smoothData') === '1';
  } catch (e) { /* ignore */ }
  const smoothMap = () => mapQuality === 'high' && smoothMapPref;
  const smoothData = () => mapQuality === 'high' && smoothDataPref;
  const tileLon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;
  const tileLat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z); return (180 / Math.PI) * Math.atan(Math.sinh(n)); };
  const LPHQ = L.GridLayer.extend({
    createTile(coords, done) {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const z = coords.z;
      window.LightPollution.renderHQ(c, (px) => tileLon(coords.x + px / 256, z), (py) => tileLat(coords.y + py / 256, z), 256, smoothMap())
        .then(() => done(null, c), (err) => done(err, c));
      return c;
    },
  });
  // Above zoom 8 the atlas images are upscaled and look blocky; in High quality we render those zooms from raw data
  const lpHQ = new LPHQ({ pane: 'lpPane', minZoom: 9, maxZoom: 19, opacity: 0.5, tileSize: 256, updateWhenZooming: false, keepBuffer: 1 });
  function lpSetOn(on) {
    const high = mapQuality === 'high';
    // Smooth gradients are drawn from raw data from zoom 6 up; otherwise raw rendering starts where the images run out (zoom 9)
    const hqFrom = smoothMap() ? 6 : 9;
    lpLayer.options.maxZoom = high ? hqFrom - 1 : 19;
    lpHQ.options.minZoom = hqFrom;
    if (map.hasLayer(lpLayer)) map.removeLayer(lpLayer);
    if (map.hasLayer(lpHQ)) map.removeLayer(lpHQ);
    if (on) { lpLayer.addTo(map); if (high) lpHQ.addTo(map); }
  }
  function lpSetOpacity(o) { lpLayer.setOpacity(o); lpHQ.setOpacity(o); }

  let currentBase = baseLayers[savedLayer] ? savedLayer : 'Dark';
  function setBase(name) {
    if (!baseLayers[name] || name === currentBase) return;
    map.removeLayer(baseLayers[currentBase]);
    baseLayers[name].addTo(map);
    baseLayers[name].bringToBack();
    currentBase = name;
    try { localStorage.setItem('astrosite.layer', name); } catch (err) { /* ignore */ }
    document.querySelectorAll('.base-seg button').forEach((b) => b.classList.toggle('on', b.dataset.base === name));
  }

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

    if (opts.elev != null) { state.elev = opts.elev; state.elevSource = opts.elevSource || 'device GPS'; }

    renderAll();
    updateHash();

    const seq = ++fetchSeq;
    fetchSiteData(seq, opts.elev == null);
    if (!state.name) reverseGeocode(seq);
    state.lp = null; state.lpErr = null;
    window.LightPollution.lookup(lat, lon).then((r) => {
      if (seq !== fetchSeq) return;
      state.lp = r; renderHead(); renderCoords();
    }).catch((err) => {
      if (seq !== fetchSeq) return;
      state.lpErr = err.message; renderHead();
    });
  }

  async function fetchSiteData(seq, wantElev) {
    const { lat, lon } = state;
    const q = `latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`;
    const k3 = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const soft = (p) => p.catch((err) => { if (!(err && err.limit)) console.warn(err); return { data: null, error: err }; });
    const [elevR, metaR, aqR] = await Promise.all([
      soft(OM.cached(`elev.${lat.toFixed(4)},${lon.toFixed(4)}`, Infinity, () => OM.request('elevation', q, { locations: 1, vars: 1, days: 1 }))),
      soft(OM.cached(`site.${k3}`, 3600000, () => OM.request('forecast', `${q}&timezone=auto&forecast_days=${FC_DAYS}&wind_speed_unit=ms&hourly=${FC_VARS.join(',')}`, { locations: 1, vars: FC_VARS.length, days: FC_DAYS }))),
      soft(OM.cached(`siteaq.${k3}`, 3600000, () => OM.request('aq', `${q}&timezone=auto&forecast_days=7&hourly=aerosol_optical_depth`, { locations: 1, vars: 1, days: 7 }))),
    ]);
    if (seq !== fetchSeq) return;
    const elev = elevR.data, meta = metaR.data, aq = aqR.data;
    state.fcStale = !!(metaR.stale || metaR.error);
    state.fcError = metaR.error ? metaR.error.message : null;
    const dem = elev && Array.isArray(elev.elevation) && isFinite(elev.elevation[0]) ? elev.elevation[0] : null;
    state.demElev = dem;
    if (wantElev) {
      if (dem != null) {
        state.elev = dem;
        state.elevSource = 'Copernicus DEM (90 m)';
      } else {
        state.elev = 0; state.elevSource = 'unavailable';
      }
    }
    if (meta && meta.timezone) {
      state.tz = meta.timezone;
      state.utcOffset = meta.utc_offset_seconds;
      if (meta.hourly && meta.hourly.time) state.fc = buildForecast(meta, aq);
    }
    if (wxActive()) scheduleWx(0);
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

  function renderHead() {
    const nameEl = $('#siteName');
    if (document.activeElement !== nameEl) nameEl.value = state.name || '';
    $('#siteSub').textContent = state.lat == null ? 'Search, click the map, or use GPS' : `${fixed(state.lat, 5)}, ${fixed(state.lon, 5)}`;
    $('#siteSub').title = state.sub || '';
    $('#elevInput').textContent = state.elev == null ? '…' : Math.round(state.elev);
    $('#elevSrc').textContent = state.elevSource === 'loading' ? 'looking up…' : state.elevSource;
    $('.elev-chip').title = `Elevation${state.elevSource && state.elevSource !== 'loading' ? ` · ${state.elevSource}` : ''}`;
    $('.elev-chip').hidden = state.lat == null;
    const b = $('#skyBadge');
    const LPm = window.LightPollution;
    if (state.lat == null) { b.hidden = true; }
    else {
      b.hidden = false;
      b.href = state.lp && !state.lp.outOfBounds ? LPm.colorsUrl : LPm.infoUrl;
      if (state.lp && !state.lp.outOfBounds) {
        const lp = state.lp;
        b.innerHTML = `<i style="background:${lp.zoneColor}"></i>Bortle ~${lp.bortle} · ${lp.sqm.toFixed(2)} mag/arcsec² · LP zone ${lp.zone}`;
        b.title = `Light Pollution Atlas ${lp.year} (D. Lorenz): artificial/natural brightness ${lp.ratio.toFixed(2)}. Bortle is an approximate conversion (Clear Sky Chart table). Click for the atlas colour key.`;
      } else if (state.lp && state.lp.outOfBounds) {
        b.textContent = 'Bortle: outside atlas coverage (65°S–75°N)';
      } else if (state.lpErr) {
        b.textContent = 'Bortle: light-pollution data unavailable';
      } else {
        b.textContent = 'Bortle: looking up…';
      }
    }
    updateFavStar();
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

  /* One registry of coordinate formats: every label used anywhere comes from here.
     Naming scheme: "<Quantity> (<format>[, <sign/hemisphere convention>])". */
  function formats() {
    const { lat, lon } = state;
    const h = elevM();
    const e = A.ecef(lat, lon, h);
    const F = (label, sub, v) => ({ label, sub, v });
    return {
      latDec: F('Latitude (decimal °)', '+ North', fixed(lat, 6)),
      lonDec: F('Longitude (decimal °, +E)', 'ISO 6709 / ASCOM convention', fixed(lon, 6)),
      lonDecW: F('Longitude (decimal °, +W)', 'classic LX200 / some planetarium apps', fixed(-lon, 6)),
      lon360: F('Longitude (decimal °, 0–360 E)', 'INDI GEOGRAPHIC_COORD', fixed(A.mod(lon, 360), 6)),
      pairDec: F('Latitude, Longitude (decimal °)', 'Google Maps / GPS', `${fixed(lat, 6)}, ${fixed(lon, 6)}`),
      latDecH: F('Latitude (decimal °, N/S)', '', `${Math.abs(lat).toFixed(6)}° ${lat < 0 ? 'S' : 'N'}`),
      lonDecH: F('Longitude (decimal °, E/W)', '', `${Math.abs(lon).toFixed(6)}° ${lon < 0 ? 'W' : 'E'}`),
      latDMS: F('Latitude (DMS, N/S)', '', A.dmsHemi(lat, true)),
      lonDMS: F('Longitude (DMS, E/W)', '', A.dmsHemi(lon, false)),
      latDMSa: F('Latitude (DMS, N/S, ASCII)', 'plain-keyboard symbols', A.dmsAscii(lat, true)),
      lonDMSa: F('Longitude (DMS, E/W, ASCII)', 'plain-keyboard symbols', A.dmsAscii(lon, false)),
      latColon: F('Latitude (DMS, ±DD:MM:SS)', '', A.dmsSigned(lat, ':', 2, 2)),
      lonColon: F('Longitude (DMS, ±DDD:MM:SS, +E)', '', A.dmsSigned(lon, ':', 2, 3)),
      latSpace: F('Latitude (DMS, ±DD MM SS)', 'FITS string style', A.dmsSigned(lat, ' ', 2, 2)),
      lonSpace: F('Longitude (DMS, ±DDD MM SS, +E)', 'FITS string style', A.dmsSigned(lon, ' ', 2, 3)),
      latDDM: F('Latitude (DDM, N/S)', 'degrees + decimal minutes', A.ddmHemi(lat, true)),
      lonDDM: F('Longitude (DDM, E/W)', 'degrees + decimal minutes', A.ddmHemi(lon, false)),
      latArcmin: F('Latitude (arcminutes)', '', `${fixed(lat * 60, 3)}′`),
      latArcsec: F('Latitude (arcseconds)', '', `${fixed(lat * 3600, 1)}″`),
      lonArcmin: F('Longitude (arcminutes, +E)', '', `${fixed(lon * 60, 3)}′`),
      lonArcsec: F('Longitude (arcseconds, +E)', '', `${fixed(lon * 3600, 1)}″`),
      latRad: F('Latitude (radians)', '', fixed(lat * A.D2R, 9)),
      lonRad: F('Longitude (radians, +E)', '', fixed(lon * A.D2R, 9)),
      lonTime: F('Longitude (time, h m s)', 'local mean time offset from UT', A.hmsFromDeg(lon)),
      lonHours: F('Longitude (decimal hours, +E)', '', fixed(lon / 15, 6)),
      elevM: F('Elevation (m)', state.elevSource || '', fixed(h, 0)),
      elevFt: F('Elevation (ft)', '', fixed(h / 0.3048, 0)),
      elevKm: F('Elevation (km)', '', fixed(h / 1000, 3)),
      lxLat: F('Latitude (LX200, ±DD*MM)', 'serial protocol', A.lx200Lat(lat)),
      lxLon: F('Longitude (LX200, DDD*MM, +W)', 'serial protocol', A.lx200Long(lon)),
      ecefX: F('Geocentric X (m)', 'WGS84 ECEF · FITS OBSGEO-X', fixed(e.x, 2)),
      ecefY: F('Geocentric Y (m)', 'WGS84 ECEF · FITS OBSGEO-Y', fixed(e.y, 2)),
      ecefZ: F('Geocentric Z (m)', 'WGS84 ECEF · FITS OBSGEO-Z', fixed(e.z, 2)),
      grid: F('Maidenhead locator', 'amateur-radio grid square', A.maidenhead(lat, lon)),
    };
  }

  function buildGroups() {
    const FM = formats();
    const { lat, lon } = state;
    const h = elevM();
    const lonW = -lon;
    const lon360 = A.mod(lon, 360);
    const e = A.ecef(lat, lon, h);
    return [
      ...[
        ['Decimal degrees', ['latDec', 'lonDec', 'lonDecW', 'lon360', 'pairDec', 'latDecH', 'lonDecH']],
        ['Degrees · arcminutes · arcseconds', ['latDMS', 'lonDMS', 'latDMSa', 'lonDMSa', 'latColon', 'lonColon', 'latSpace', 'lonSpace', 'latDDM', 'lonDDM']],
        ['Arc units, radians & time', ['latArcmin', 'latArcsec', 'lonArcmin', 'lonArcsec', 'latRad', 'lonRad', 'lonTime', 'lonHours']],
      ].map(([title, keys]) => ({ title, rows: keys.map((k) => [FM[k].label, FM[k].sub, FM[k].v, null, k]) })),
      {
        title: 'Elevation',
        rows: [
          ...['elevM', 'elevFt', 'elevKm'].map((k) => [FM[k].label, FM[k].sub, FM[k].v, null, k]),
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
          ...['ecefX', 'ecefY', 'ecefZ', 'grid'].map((k) => [FM[k].label, FM[k].sub, FM[k].v, null, k]),
        ],
      },
      { title: 'Mount protocol', rows: ['lxLat', 'lxLon'].map((k) => [FM[k].label, FM[k].sub, FM[k].v, null, k]) },
      ...(state.lp && !state.lp.outOfBounds ? [{
        title: 'Sky brightness',
        rows: [
          ['Bortle class (approx.)', 'from atlas ratio · Clear Sky Chart table', state.lp.bortle],
          ['Zenith sky brightness', `mag/arcsec² · Lorenz atlas ${state.lp.year}`, state.lp.sqm.toFixed(2)],
          ['Light pollution zone', 'Lorenz atlas colour key', state.lp.zone],
          ['Artificial / natural brightness', 'ratio', state.lp.ratio < 0.1 ? state.lp.ratio.toFixed(3) : state.lp.ratio.toFixed(2)],
          ['Naked-eye limiting magnitude', 'estimated from sky brightness', state.lp.nelm.toFixed(1)],
        ],
      }] : []),
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
  const loadSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch (e) { return new Set(); } };
  const saveSet = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch (e) { /* ignore */ } };
  const progHidden = loadSet('astrosite.progHidden');
  // Pins are ordered lists (pin order = display order)
  const loadList = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const saveList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  let progPins = loadList('astrosite.pins');
  let rowPins = loadList('astrosite.rowPins');
  const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-5-5 5H3v-1l5-5-5-4 2-2 5 1 4-4z"/></svg>';
  const pinBtn = (kind, id, on, label) => `<button class="pin${on ? ' on' : ''}" data-pin-kind="${kind}" data-pin="${esc(id)}" aria-pressed="${on}" title="${on ? 'Unpin' : 'Pin to top'}${label ? ` — ${esc(label)}` : ''}">${PIN_SVG}</button>`;
  const typeHidden = loadSet('astrosite.typeHidden');
  let coordEdit = false;
  let coordView = 'program';
  try { coordView = localStorage.getItem('astrosite.view') === 'type' ? 'type' : 'program'; } catch (e) { /* ignore */ }

  // Every distinct value once, grouped by subject, tagged with the programs that use it.
  function byType() {
    const progs = programs();
    const groups = buildGroups().map((g) => ({ title: g.title, rows: g.rows.map(([k, sub, v, lv, key]) => ({ k, sub, v, lv, key, progs: [] })) }));
    const group = (title) => {
      let g = groups.find((x) => x.title === title);
      if (!g) { g = { title, rows: [] }; groups.push(g); }
      return g;
    };
    const byKey = new Map();
    groups.forEach((g) => g.rows.forEach((r) => { if (r.key) byKey.set(r.key, r); }));
    progs.forEach((p) => (p.rows || []).forEach(([key, field]) => {
      const r = byKey.get(key);
      if (!r) return;
      const tag = field ? `${p.short} · ${field}` : p.short;
      if (!r.progs.includes(tag)) r.progs.push(tag);
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
    const order = ['Decimal degrees', 'Degrees · arcminutes · arcseconds', 'Arc units, radians & time', 'Elevation', 'Mount protocol', 'Geocentric & grid', 'Sky brightness', 'Commands & FITS headers', 'Time'];
    return groups.filter((g) => g.rows.length).sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
  }

  function renderByType(box) {
    const all = byType();
    const rowId = (r) => r.key || r.k;
    const rowHtml = (r) => {
      const pinned = rowPins.includes(rowId(r));
      const label = `<td class="k"><div class="k-row">${pinBtn('row', rowId(r), pinned, r.k)}<span>${esc(r.k)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></div></td>`;
      if (r.snip) return `<tr>${label}<td><pre class="snip inrow" title="Click to copy">${esc(r.v)}</pre></td></tr>`;
      return `<tr>${label}<td class="v"${r.lv ? ` data-live="${r.lv}"` : ''} title="Click to copy">${esc(r.lv ? live[r.lv]() : r.v)}</td></tr>`;
    };
    const flat = new Map();
    all.forEach((g) => g.rows.forEach((r) => flat.set(rowId(r), r)));
    const pinnedRows = rowPins.map((id) => flat.get(id)).filter(Boolean);
    const groups = all.filter((g) => coordEdit || !typeHidden.has(g.title));
    let html = pinnedRows.length ? `<div class="vgroup pinned-group"><h3>Pinned</h3><table class="vals"><tbody>${pinnedRows.map((r) => rowHtml(r)).join('')}</tbody></table></div>` : '';
    html += groups.map((g) => `
      <div class="vgroup${typeHidden.has(g.title) ? ' off' : ''}"><h3>${coordEdit ? `<label class="sw"><input type="checkbox" data-toggle="${esc(g.title)}" ${typeHidden.has(g.title) ? '' : 'checked'}><span></span></label>` : ''}${esc(g.title)}</h3>
        <div class="pc-body"><div class="pc-inner"><table class="vals"><tbody>${g.rows.map((r) => rowHtml(r)).join('')}</tbody></table></div></div>
      </div>`).join('');
    if (!groups.length && !pinnedRows.length) html = '<p class="muted pad">All groups are hidden. Use Edit to choose which to show.</p>';
    box.innerHTML = html;
  }

  function renderCoords() {
    const box = $('#coordsBody');
    $$('#tab-coords [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === coordView));
    const eb = $('#coordEdit');
    eb.textContent = coordEdit ? 'Done' : 'Edit';
    eb.setAttribute('aria-pressed', coordEdit);
    const hint = $('#viewHint');
    hint.hidden = !coordEdit;
    hint.textContent = coordView === 'program' ? 'Tick the programs to show.' : 'Tick the groups to show.';
    if (state.lat == null) {
      box.innerHTML = '<p class="muted" style="padding:12px 0">No site selected yet. Search for a place, paste coordinates, click the map, or use your GPS.</p>';
      return;
    }
    if (coordView === 'type') renderByType(box);
    else renderProgramCards(box);
  }
  const renderValues = renderCoords;

  $$('#tab-coords [data-view]').forEach((b) => b.addEventListener('click', () => {
    if (coordView === b.dataset.view) return;
    coordView = b.dataset.view;
    try { localStorage.setItem('astrosite.view', coordView); } catch (e) { /* ignore */ }
    renderCoords();
    animateIn($('#coordsBody'));
  }));

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pin]');
    if (!b) return;
    e.stopPropagation();
    const id = b.dataset.pin;
    if (b.dataset.pinKind === 'prog') {
      progPins = progPins.includes(id) ? progPins.filter((x) => x !== id) : [...progPins, id];
      saveList('astrosite.pins', progPins);
      toast(progPins.includes(id) ? `Pinned ${id}` : `Unpinned ${id}`);
    } else {
      rowPins = rowPins.includes(id) ? rowPins.filter((x) => x !== id) : [...rowPins, id];
      saveList('astrosite.rowPins', rowPins);
      toast(rowPins.includes(id) ? 'Pinned to the top' : 'Unpinned');
    }
    const sc = $('#tab-coords').scrollTop;
    renderCoords();
    animateIn($('#coordsBody'));
    $('#tab-coords').scrollTop = sc;
  });

  // Edit mode: switch programs (By program) or groups (By type) on and off
  $('#coordEdit').addEventListener('click', () => {
    coordEdit = !coordEdit;
    renderCoords();
    animateIn($('#coordsBody'));
  });
  $('#coordsBody').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-toggle]');
    if (!cb) return;
    const set = coordView === 'type' ? typeHidden : progHidden;
    if (cb.checked) set.delete(cb.dataset.toggle); else set.add(cb.dataset.toggle);
    saveSet(coordView === 'type' ? 'astrosite.typeHidden' : 'astrosite.progHidden', set);
    const host = cb.closest('.pcard, .vgroup');
    if (host) host.classList.toggle('off', !cb.checked);
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
        rows: [['latDec', 'Latitude'], ['lonDec', 'Longitude'], ['elevM', 'Elevation'], ['latSpace'], ['lonSpace']],
      },
      {
        name: 'ASTAP',
        short: 'ASTAP',
        snippetLabel: 'FITS site keywords',
        where: 'ASTAP reads the site from the FITS header (SITELAT / SITELONG / SITEELEV) for airmass, annotation and photometry. Use these in its header editor or wherever it asks for latitude / longitude; it accepts decimal or space-separated DMS.',
        rows: [['latDec', 'SITELAT'], ['lonDec', 'SITELONG'], ['latSpace'], ['lonSpace'], ['elevM', 'SITEELEV']],
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
        rows: [['pairDec'], ['latDec'], ['lonDec'], ['latDMSa'], ['lonDMSa'], ['elevM']],
      },
      {
        name: 'PixInsight',
        short: 'PixInsight',
        snippetLabel: 'OBSGEO keywords',
        where: 'ImageSolver / SPFC / observation metadata use OBSGEO-L/B/H (also SITELONG / SITELAT). Observer-location dialogs take signed DMS.',
        rows: [['lonSpace', 'Longitude'], ['latSpace', 'Latitude'], ['elevM', 'Height']],
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
        rows: [['latDec', 'SITELAT'], ['lonDec', 'SITELONG'], ['elevM', 'SITEELEV']],
      },
      {
        name: 'Stellarium',
        short: 'Stellarium',
        where: 'Location window (F6) — Latitude, Longitude, Altitude.',
        rows: [['latDMS', 'Latitude'], ['lonDMS', 'Longitude'], ['elevM', 'Altitude'], ['latDec'], ['lonDec']],
      },
      {
        name: 'KStars / Ekos / INDI',
        short: 'KStars / INDI',
        snippetLabel: 'INDI indi_setprop command',
        where: 'KStars Geographic dialog takes signed colon-separated DMS (East +). INDI drivers use GEOGRAPHIC_COORD with longitude 0–360° East.',
        rows: [['latColon', 'KStars Latitude'], ['lonColon', 'KStars Longitude'], ['latDec', 'INDI LAT'], ['lon360', 'INDI LONG'], ['elevM', 'INDI ELEV']],
        snippet: `indi_setprop "Telescope Simulator.GEOGRAPHIC_COORD.LAT;LONG;ELEV=${fixed(lat, 6)};${fixed(A.mod(lon, 360), 6)};${elevR}"`,
      },
      {
        name: 'ASCOM drivers / SGPro / APT / SharpCap / MaxIm DL',
        short: 'ASCOM · SGPro · APT · SharpCap · MaxIm',
        where: 'ASCOM SiteLatitude / SiteLongitude / SiteElevation are decimal degrees, East positive. Most Windows capture suites accept decimal; MaxIm and APT also accept DMS.',
        rows: [['latDec', 'SiteLatitude'], ['lonDec', 'SiteLongitude'], ['elevM', 'SiteElevation'], ['latSpace'], ['lonSpace']],
      },
      {
        name: 'LX200 / OnStep / Meade serial',
        short: 'LX200 / OnStep',
        snippetLabel: 'LX200 serial commands',
        where: 'Classic LX200 protocol: latitude ±DD*MM, longitude DDD*MM measured West-positive (0–360).',
        rows: [['lxLat', ':St'], ['lxLon', ':Sg']],
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
    const FM = formats();
    const visible = programs().filter((p) => coordEdit || !progHidden.has(p.name));
    const pinned = progPins.map((n) => visible.find((p) => p.name === n)).filter(Boolean);
    const rest = visible.filter((p) => !progPins.includes(p.name));
    if (!visible.length) { box.innerHTML = '<p class="muted pad">All programs are hidden. Use Edit to choose which to show.</p>'; return; }
    const card = (p) => {
      const on = !progHidden.has(p.name);
      const isPinned = progPins.includes(p.name);
      return `
      <section class="pcard${on ? '' : ' off'}${isPinned ? ' pinned' : ''}">
        <header>${coordEdit ? `<label class="sw"><input type="checkbox" data-toggle="${esc(p.name)}" ${on ? 'checked' : ''}><span></span></label>` : ''}<h4>${esc(p.name)}</h4>${pinBtn('prog', p.name, isPinned, p.name)}</header>
        <div class="pc-body"><div class="pc-inner">
        <div class="where">${esc(p.where)}</div>
        ${p.rows ? `<table class="vals"><tbody>${p.rows.map(([key, field]) => `<tr><td class="k">${esc(FM[key].label)}${field ? `<code class="field" title="Field / keyword name in ${esc(p.name)}">${esc(field)}</code>` : ''}</td><td class="v" title="Click to copy">${esc(FM[key].v)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${p.snippet ? `<pre class="snip" title="Click to copy">${esc(p.snippet)}</pre>` : ''}
        </div></div>
      </section>`;
    };
    box.innerHTML = (pinned.length ? `<div class="pin-head">Pinned</div>${pinned.map(card).join('')}${rest.length ? '<div class="pin-head">Other programs</div>' : ''}` : '') + rest.map(card).join('');
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
    const [litC, darkC] = isNight() ? ['#ff8080', '#2a0000'] : ['#f2ecc8', '#2a3046'];
    return `<i class="mdisc" style="background:linear-gradient(${dir}, ${litC} ${lit}%, ${darkC} ${lit}%)"></i>`;
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
      return h;
    });
    // Drop hours that are already past (keep the previous hour for context)
    const cutoff = Date.now() - 2 * 3600000;
    while (hours.length > 24 && hours[0].t.getTime() < cutoff) hours.shift();
    const aodHours = hours.filter((h) => h.aod != null).length;
    return { hours, aodHours, model: 'Open-Meteo best match + CAMS aerosols' };
  }

  /* Colour scale (computed, not hand-drawn): each row maps its value to a 0–1 quality q, and q sets the
     lightness of one blue hue — darker = better. Any hour whose value is missing or relies on an estimated
     input is drawn solid red instead, with no gradient. */
  const isNight = () => document.body.classList.contains('night');
  // Colour scales are defined in OKLCH so lightness steps evenly; every blend happens in OKLab.
  const CK = window.ColorOK;
  const LIM_DAY = CK.hex('#b3261e'), LIM_NIGHT = CK.hex('#ff1f1f');
  const scaleCache = new Map();
  function shadeRgb(q, limited) {
    const night = isNight();
    if (limited) return night ? LIM_NIGHT : LIM_DAY;
    if (q == null || !isFinite(q)) return null;
    q = Math.max(0, Math.min(1, q));
    const key = `${night ? 'n' : 'd'}${Math.round(q * 1000)}`;
    if (!scaleCache.has(key)) {
      // worse → near-white (day) / bright red (night); better → deep blue / near-black red
      scaleCache.set(key, night ? CK.oklchToRgb(0.62 - q * 0.46, 0.25, 27) : CK.oklchToRgb(0.95 - q * 0.65, 0.015 + q * 0.115, 258));
    }
    return scaleCache.get(key);
  }
  const rgbStr = CK.str;
  const mixRgb = (a, b, t = 0.5) => CK.mix(a, b, t);
  function shade(q, limited) {
    const c = shadeRgb(q, limited);
    if (!c) return null;
    const L = CK.rgbToOklab(c)[0];
    const fg = isNight() ? (L > 0.45 ? '#000' : '#ffa0a0') : (L < 0.62 ? '#eef3ff' : '#0b1220');
    return { bg: rgbStr(c), fg, rgb: c };
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  const MODEL_SRC = 'https://github.com/electroluminescent/astro-site-coords/blob/main/js/forecast-model.js';
  const SUNCALC_SRC = 'https://github.com/mourner/suncalc';
  const omq = (vars) => `${OPEN_METEO}/forecast?latitude=${state.lat.toFixed(4)}&longitude=${state.lon.toFixed(4)}&timezone=auto&forecast_days=${FC_DAYS}&wind_speed_unit=ms&hourly=${vars}`;

  // Row definitions: cell(h) returns {q, txt|html, tip, lim, nodata, mark, warn2}
  function rowDefs() {
    const n = (v, d = 0) => (v == null ? '' : (+v).toFixed(d));
    const cloudy = (h) => (h.cloud != null && h.cloud >= SM.CLOUDY ? ' · sky cloudy' : '');
    return [
      { key: 'sun', label: 'Sun altitude', sub: '° · twilight', group: 'Darkness', src: () => SUNCALC_SRC,
        cell: (h) => ({ q: clamp01(-h.sunAlt / 18), txt: String(Math.round(h.sunAlt)),
          tip: `${h.sunAlt.toFixed(1)}° — ${h.sunAlt <= -18 ? 'astronomical night' : h.sunAlt <= -12 ? 'astronomical twilight' : h.sunAlt <= -6 ? 'nautical twilight' : h.sunAlt <= 0 ? 'civil twilight' : 'day'}` }) },
      { key: 'moonAlt', label: 'Moon altitude', sub: '° above horizon', group: 'Moonlight', src: () => SUNCALC_SRC,
        cell: (h) => (h.moonAlt > 0
          ? { q: 1 - clamp01(h.moonAlt / 60) * (0.35 + 0.65 * h.moonIllum), txt: String(Math.round(h.moonAlt)), tip: `${h.moonAlt.toFixed(1)}° above the horizon` }
          : { q: 1, txt: '', tip: `below the horizon (${h.moonAlt.toFixed(0)}°)` }) },
      { key: 'moonIllum', label: 'Moon illumination', sub: '% lit · phase', group: 'Moonlight', src: () => SUNCALC_SRC,
        cell: (h) => ({ q: 1 - h.moonIllum, html: `${moonDisc(h.moonIllum, h.moonPhase)}${Math.round(h.moonIllum * 100)}`, tip: `${Math.round(h.moonIllum * 100)}% lit — ${moonPhaseName(h.moonPhase)}` }) },
      { key: 'cloud', label: 'Cloud cover', sub: '% total', group: 'Sky', src: () => omq('cloud_cover'),
        cell: (h) => (h.cloud == null ? { nodata: true } : { q: 1 - h.cloud / 100, txt: n(h.cloud), tip: `${n(h.cloud)}%` }) },
      { key: 'cloudLow', label: 'Low cloud', sub: '% · below 2 km', group: 'Sky', src: () => omq('cloud_cover_low'),
        cell: (h) => (h.cloudLow == null ? { nodata: true } : { q: 1 - h.cloudLow / 100, txt: n(h.cloudLow), tip: `${n(h.cloudLow)}%` }) },
      { key: 'cloudMid', label: 'Mid cloud', sub: '% · 2–6 km', group: 'Sky', src: () => omq('cloud_cover_mid'),
        cell: (h) => (h.cloudMid == null ? { nodata: true } : { q: 1 - h.cloudMid / 100, txt: n(h.cloudMid), tip: `${n(h.cloudMid)}%` }) },
      { key: 'cloudHigh', label: 'High cloud', sub: '% · above 6 km', group: 'Sky', src: () => omq('cloud_cover_high'),
        cell: (h) => (h.cloudHigh == null ? { nodata: true } : { q: 1 - h.cloudHigh / 100, txt: n(h.cloudHigh), tip: `${n(h.cloudHigh)}%` }) },
      { key: 'trans', label: 'Transparency', sub: 'index · lower = clearer', group: 'Sky', src: () => MODEL_SRC,
        cell: (h) => {
          if (!h.trans) return { nodata: true };
          const t = h.trans;
          const lim = t.aodEst || t.pwvEst;
          return { q: clamp01(1 - t.index / 30), txt: String(Math.round(t.index)), lim,
            tip: `${t.index.toFixed(1)} — ${SM.TRANS_LABELS[t.rawCls]}${cloudy(h)} · water vapour ${t.pwv.toFixed(1)} mm${t.pwvEst ? ' (est.)' : ''} · aerosol ${t.aod.toFixed(2)}${t.aodEst ? ' (assumed — beyond aerosol forecast)' : ''}` };
        } },
      { key: 'see', label: 'Seeing', sub: 'arcsec (est.)', group: 'Sky', src: () => MODEL_SRC,
        cell: (h) => {
          if (!h.see) return { nodata: true };
          const lim = h.wd850 == null || h.wd500 == null || h.wd300 == null || h.gust == null;
          return { q: clamp01((4.5 - h.see.arcsec) / 3.5), txt: h.see.arcsec.toFixed(1), lim,
            tip: `~${h.see.arcsec.toFixed(1)}″ — ${SM.SEEING_LABELS[h.see.rawCls]}${cloudy(h)} · jet ${Math.round(U.wind(h.see.jet))} ${U.windU()}` };
        } },
      { key: 'fog', label: 'Mist / fog', sub: 'visibility', group: 'Ground', src: () => omq('visibility,temperature_2m,dew_point_2m'),
        cell: (h) => {
          const f = h.fog;
          if (f.vis == null && f.spread == null) return { nodata: true };
          const q = f.vis != null ? clamp01(Math.log10(Math.max(f.vis, 200) / 200) / 2) : clamp01(f.spread / 6);
          const v = U.vis(f.vis);
          return { q, txt: f.vis == null ? '' : v >= 20 ? '20+' : v.toFixed(v < 10 ? 1 : 0), lim: f.vis == null, mark: f.level >= 1,
            tip: `${f.label}${f.vis != null ? ` · ${v.toFixed(1)} ${U.visU()}` : ' · no visibility data (judged from dew-point spread)'}` };
        } },
      { key: 'wind', label: 'Wind speed', sub: '10 m', group: 'Ground', src: () => omq('wind_speed_10m'),
        cell: (h) => (h.wind == null ? { nodata: true } : { q: clamp01(1 - h.wind / 12), txt: String(Math.round(U.wind(h.wind))), tip: `${Math.round(U.wind(h.wind))} ${U.windU()}` }) },
      { key: 'wdir', label: 'Wind direction', sub: 'arrow = toward', group: 'Ground', src: () => omq('wind_direction_10m'),
        cell: (h) => (h.wdir == null ? { nodata: true } : { q: clamp01(1 - (h.wind || 0) / 12), lim: h.wind == null, html: `<i class="arr" style="transform:rotate(${(h.wdir + 180) % 360}deg)">↑</i>`, tip: `from ${compass(h.wdir)} (${Math.round(h.wdir)}°)` }) },
      { key: 'gust', label: 'Wind gusts', sub: '', group: 'Ground', src: () => omq('wind_gusts_10m'),
        cell: (h) => (h.gust == null ? { nodata: true } : { q: clamp01(1 - h.gust / 18), txt: String(Math.round(U.wind(h.gust))), tip: `${Math.round(U.wind(h.gust))} ${U.windU()}` }) },
      { key: 'temp', label: 'Temperature', sub: '2 m', group: 'Ground', src: () => omq('temperature_2m'),
        cell: (h) => (h.temp == null ? { nodata: true } : { q: clamp01(1 - (h.temp + 20) / 55), txt: String(Math.round(U.temp(h.temp))), tip: `${U.temp(h.temp).toFixed(1)} ${U.tempU()}` }) },
      { key: 'dew', label: 'Dew point', sub: '', group: 'Ground', src: () => omq('dew_point_2m'),
        cell: (h) => {
          if (h.dew == null) return { nodata: true };
          const sp = h.fog.spread;
          return { q: sp == null ? null : clamp01(sp / 8), txt: String(Math.round(U.temp(h.dew))), lim: h.temp == null, mark: h.dewRisk.level >= 1, warn2: h.dewRisk.level >= 2,
            tip: `${U.temp(h.dew).toFixed(1)} ${U.tempU()}${sp != null ? ` · spread ${U.spread(sp).toFixed(1)}° · ${h.dewRisk.label}` : ''}` };
        } },
      { key: 'rh', label: 'Humidity', sub: '%', group: 'Ground', src: () => omq('relative_humidity_2m'),
        cell: (h) => (h.rh == null ? { nodata: true } : { q: clamp01(1 - (h.rh - 30) / 70), txt: String(Math.round(h.rh)), tip: `${Math.round(h.rh)}%` }) },
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

  /* Collapsible sections in the forecast tab (state remembered) */
  const collapsedSecs = loadSet('astrosite.collapsed');
  // Sections remember their state; defaultCollapsed sections store "open" instead of "collapsed"
  function csWrap(id, title, body, defaultCollapsed = false) {
    const c = defaultCollapsed ? !collapsedSecs.has(`${id}:open`) : collapsedSecs.has(id);
    return `<section class="cs${c ? ' collapsed' : ''}" data-sec="${id}"${defaultCollapsed ? ' data-default-collapsed="1"' : ''}>
      <h5 class="sec cs-head" tabindex="0" role="button" aria-expanded="${!c}"><span class="chev" aria-hidden="true"></span>${title}</h5>
      <div class="cs-body"><div class="cs-inner">${body}</div></div></section>`;
  }
  function toggleSection(head) {
    const sec = head.closest('.cs');
    const id = sec.dataset.sec;
    const nowCollapsed = !sec.classList.contains('collapsed');
    sec.classList.toggle('collapsed', nowCollapsed);
    head.setAttribute('aria-expanded', !nowCollapsed);
    if (sec.dataset.defaultCollapsed) { if (nowCollapsed) collapsedSecs.delete(`${id}:open`); else collapsedSecs.add(`${id}:open`); }
    else if (nowCollapsed) collapsedSecs.add(id); else collapsedSecs.delete(id);
    saveSet('astrosite.collapsed', collapsedSecs);
  }
  $('#tonight').addEventListener('click', (e) => { const h = e.target.closest('.cs-head'); if (h) toggleSection(h); });
  $('#tonight').addEventListener('keydown', (e) => {
    const h = e.target.closest('.cs-head');
    if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSection(h); }
  });

  let fcKeyHandlerBound = false;
  let fcRowIndex = new Map();
  function tipFor(td) {
    const tr = td.parentElement;
    const r = fcRowIndex.get(tr.dataset.row);
    const h = state.fc && state.fc.hours[+td.dataset.c];
    if (!r || !h) return null;
    const c = r.cell(h);
    const when = `${fmtDay(h.t)} ${fmtTime(h.t)}`;
    if (c.nodata) return [`${r.label} · ${when}`, 'No data for this hour'];
    return [`${r.label} · ${when}`, c.tip || c.txt || '', ...(c.lim ? ['Limited data — an input is missing or estimated'] : [])];
  }

  function renderTonight() {
    const box = $('#tonight');
    if (state.lat == null) { box.innerHTML = '<p class="muted" style="padding:12px 0">Pick a location first.</p>'; return; }
    if (typeof SunCalc === 'undefined') { box.innerHTML = '<p class="muted">Ephemeris library failed to load.</p>'; return; }
    const fc = state.fc;
    if (!fc) {
      box.innerHTML = state.fcError
        ? `<p class="fc-note" style="margin:12px 0">Forecast unavailable: ${esc(state.fcError)}${OM.limited() ? ` — retrying after ${esc(new Date(OM.cooldownUntil()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ''}.</p>`
        : '<p class="muted" style="padding:12px 0">Loading the 14-day forecast…</p>';
      return;
    }

    const hours = fc.hours;
    if (state.pendingTime != null) {
      let best = 0, bd = Infinity;
      hours.forEach((h, i) => { const d = Math.abs(h.t.getTime() + 1800000 - state.pendingTime); if (d < bd) { bd = d; best = i; } });
      state.fcSel = best;
      state.pendingTime = null;
    }
    if (state.fcSel == null || state.fcSel >= hours.length) {
      // default: first hour after astronomical dusk tonight (or now if already dark)
      const now = Date.now();
      let i = hours.findIndex((h) => h.t.getTime() >= now - 3600000 && h.sunAlt <= -18);
      if (i < 0) i = hours.findIndex((h) => h.t.getTime() >= now - 3600000);
      state.fcSel = Math.max(0, i);
    }

    const fcHidden = loadSet('astrosite.fcHidden');
    const rows = rowDefs().filter((r) => state.fcEdit || !fcHidden.has(r.key));
    // Day header (local dates)
    const dayGroups = [];
    hours.forEach((h, i) => {
      const lbl = fmtDay(h.t);
      if (!dayGroups.length || dayGroups[dayGroups.length - 1].lbl !== lbl) dayGroups.push({ lbl, n: 0, start: i });
      dayGroups[dayGroups.length - 1].n++;
    });
    const dayStart = new Set(dayGroups.slice(1).map((g) => g.start));
    const ds = (i) => (dayStart.has(i) ? ' ds' : '');

    // Two tables: a fixed label table and a scrolling value table with identical row heights.
    // (No position:sticky cells — those make horizontal scrolling slow, notably in Firefox.)
    let lbl = '<table class="fc fc-labels"><thead>';
    let html = `<table class="fc fc-vals${state.showVals ? '' : ' novals'}"><thead>`;
    lbl += '<tr class="fc-days"><th colspan="2"></th></tr>';
    html += `<tr class="fc-days">${dayGroups.map((g) => `<th colspan="${g.n}" class="fc-day${ds(g.start)}"><span class="dl">${g.n >= 3 ? esc(g.lbl) : ''}</span></th>`).join('')}</tr>`;
    lbl += `<tr class="fc-hours"><th colspan="2" class="fc-lbl">Hour <span class="muted">(${esc(state.tz || 'local')})</span></th></tr></thead><tbody>`;
    html += `<tr class="fc-hours">${hours.map((h, i) => {
      const dark = h.sunAlt <= -18 ? 'd4' : h.sunAlt <= -12 ? 'd3' : h.sunAlt <= -6 ? 'd2' : h.sunAlt <= 0 ? 'd1' : 'd0';
      return `<th data-c="${i}" class="${dark}${ds(i)}">${fmtHour(h.t)}</th>`;
    }).join('')}</tr></thead><tbody>`;
    let lastGroup = '';
    rows.forEach((r) => {
      if (r.group !== lastGroup) {
        lbl += `<tr class="fc-group"><th colspan="2" class="fc-lbl">${esc(r.group)}</th></tr>`;
        html += `<tr class="fc-group"><td colspan="${hours.length}"></td></tr>`;
        lastGroup = r.group;
      }
      const unit = r.key === 'wind' || r.key === 'gust' ? U.windU() : r.key === 'temp' || r.key === 'dew' ? U.tempU() : r.key === 'fog' ? U.visU() : '';
      const sub = [r.sub, unit].filter(Boolean).join(' · ');
      const off = fcHidden.has(r.key);
      const chk = state.fcEdit ? `<input type="checkbox" class="rowchk" data-row="${r.key}" ${off ? '' : 'checked'} aria-label="Show ${esc(r.label)}">` : '';
      lbl += `<tr class="fc-row${off ? ' off' : ''}" data-row="${r.key}"><th class="fc-lbl">${chk}<a href="${esc(r.src())}" target="_blank" rel="noopener" title="Open the data source for ${esc(r.label)} in a new tab">${esc(r.label)}</a></th><th class="fc-sub">${esc(sub)}</th></tr>`;
      html += `<tr class="fc-row${off ? ' off' : ''}" data-row="${r.key}">`;
      // Per-row colours (for smooth gradients each cell blends from the midpoint with its left neighbour,
      // through its own exact colour at its centre, to the midpoint with its right neighbour)
      const cellsRow = hours.map((h) => r.cell(h));
      const rgbRow = smoothData() ? cellsRow.map((c) => (c.nodata ? shadeRgb(null, true) : shadeRgb(c.q, c.lim))) : null;
      const bgFor = (i, flat) => {
        if (!rgbRow || !rgbRow[i]) return flat;
        const cur = rgbRow[i];
        const left = rgbRow[i - 1] ? mixRgb(rgbRow[i - 1], cur) : cur;
        const right = rgbRow[i + 1] ? mixRgb(cur, rgbRow[i + 1]) : cur;
        const stops = `${rgbStr(left)} 0%,${rgbStr(cur)} 50%,${rgbStr(right)} 100%`;
        return `linear-gradient(90deg,${stops});background:linear-gradient(in oklab 90deg,${stops})`;
      };
      hours.forEach((h, i) => {
        const c = cellsRow[i];
        if (c.nodata) {
          const nd = shade(null, true);
          html += `<td data-c="${i}" class="nd${ds(i)}" style="background:${bgFor(i, nd.bg)};color:${nd.fg}">–</td>`;
          return;
        }
        const col = shade(c.q, c.lim);
        const cls = [c.mark ? (c.warn2 ? 'mk2' : 'mk') : '', c.lim ? 'lim' : '', dayStart.has(i) ? 'ds' : ''].filter(Boolean).join(' ');
        const style = col ? ` style="background:${bgFor(i, col.bg)};color:${col.fg}"` : '';
        html += `<td data-c="${i}"${cls ? ` class="${cls}"` : ''}${style}>${c.html || esc(c.txt || '')}</td>`;
      });
      html += '</tr>';
    });
    lbl += '</tbody></table>';
    html += '</tbody></table>';
    fcRowIndex = new Map(rows.map((r) => [r.key, r]));

    const tzLabel = state.tz ? `${state.tz} (${offsetString(state.utcOffset)})` : `approx. ${offsetString(siteOffsetSec())}`;
    const scaleBar = () => `<span class="scale">${[0, 0.25, 0.5, 0.75, 1].map((q) => `<i style="background:${shade(q, false).bg}"></i>`).join('')}</span>`;

    const gridHtml = `
      <div class="fc-nav">
        <div class="fc-nav-btns">
          <button class="btn small" data-nav="prev" title="Previous night (Page Up)">◀ Prev night</button>
          <button class="btn small" data-nav="tonight">Tonight</button>
          <button class="btn small" data-nav="next" title="Next night (Page Down)">Next night ▶</button>
        </div>
        <div class="fc-nav-right">
        <button class="btn small${state.fcEdit ? ' on' : ''}" id="fcEditBtn" aria-pressed="${state.fcEdit}" title="Choose which rows to show">${state.fcEdit ? 'Done' : 'Edit rows'}</button>
        <label class="chk"><input type="checkbox" id="fcVals" ${state.showVals ? 'checked' : ''}> Show values</label>
        </div>
      </div>
      <div class="fc-timeline">
        <input type="range" class="fc-slider" min="0" max="${hours.length - 1}" value="${state.fcSel}" aria-label="Scroll through the forecast hours">
        <div class="fc-ticks" aria-hidden="true">${dayGroups.map((g) => {
          const pct = (g.start / Math.max(1, hours.length - 1)) * 100;
          const lbl = fmtDay(hours[g.start].t).split(' ').slice(0, 2).join(' ');
          return `<span style="left:calc(${pct.toFixed(3)}% + ${(8 - pct * 0.16).toFixed(2)}px)"><i></i>${g.n >= 6 ? `<b>${esc(lbl)}</b>` : ''}</span>`;
        }).join('')}</div>
      </div>
      <div class="fc-wrap">
        <div class="fc-left">${lbl}</div>
        <div class="fc-scroll" tabindex="0" aria-label="Hourly forecast grid; use arrow keys to move between hours">${html}</div>
      </div>

      <div class="fc-legend">
        <span>${scaleBar()} worse → better</span>
        <span><i class="red-swatch"></i> missing or estimated data</span>
        <span class="muted">${esc(tzLabel)}</span>
      </div>
`;
    box.innerHTML = `
      ${csWrap('grid', `Forecast · ${FC_DAYS} days`, gridHtml)}
      <div id="fcDetail"></div>
      <div id="fcNight"></div>
      ${csWrap('about', 'About these forecasts', `<div class="fc-about">
        <p><b>Cloud cover</b> (total and low / mid / high layers), <b>visibility</b>, <b>wind</b>, <b>temperature</b>, <b>dew point</b> and <b>humidity</b> come straight from the Open-Meteo best-match weather models (14 days). Long-range hours come from coarser global models, so treat days 8–14 as a trend.</p>
        <p><b>Transparency</b> follows Astrospheric's scale: index 0–5 excellent, 6–9 above average, 10–13 average, 14–23 below average, 24–27 poor, above 27 cloudy. It's estimated here from precipitable water vapour, CAMS aerosol optical depth (smoke, dust, haze), high-cloud fraction and surface pressure (elevation).</p>
        <p><b>Seeing</b> is an estimate in arcseconds from jet-stream speed (300 / 200 hPa), vertical wind shear between 850, 500 and 300 hPa, and surface gusts. Ratings: excellent &lt;1.4″, above average &lt;1.9″, average &lt;2.6″, below average &lt;3.4″, poor beyond that. Values are shown even under cloud; the tooltip notes when the sky is cloudy (≥ ${SM.CLOUDY}%).</p>
        <p><b>Mist / fog</b> uses forecast visibility: under 1 km is fog, 1–5 km is mist. An orange mark means radiation fog or heavy dew is likely (temperature within 2 °C of the dew point; amber within 4 °C).</p>
        <p><b>Colours</b> are generated per value: each row converts its value to a 0–1 quality score with a fixed formula, and that score sets the lightness of a single blue (darker = better). <b>Solid red</b> marks an hour whose value is missing or relies on an estimated input, for example typical aerosol levels beyond the aerosol forecast range. Hover over any cell for its exact value; click a row label to open its data source.</p>
      </div>`, true)}
      ${csWrap('links', 'Open this site in', `<div class="links">
        <a href="https://clearoutside.com/forecast/${state.lat.toFixed(2)}/${state.lon.toFixed(2)}" target="_blank" rel="noopener">Clear Outside</a>
        <a href="https://www.astrospheric.com/" target="_blank" rel="noopener">Astrospheric</a>
        <a href="https://lightpollutionmap.app/?lat=${state.lat.toFixed(5)}&lng=${state.lon.toFixed(5)}" target="_blank" rel="noopener">Light Pollution Map</a>
        <a href="https://www.openstreetmap.org/?mlat=${state.lat.toFixed(6)}&mlon=${state.lon.toFixed(6)}#map=14/${state.lat.toFixed(5)}/${state.lon.toFixed(5)}" target="_blank" rel="noopener">OpenStreetMap</a>
      </div>`)}`;

    const scroller = $('.fc-scroll', box);
    const slider = $('.fc-slider', box);
    scroller.addEventListener('click', (e) => {
      if (e.target.closest('a, input')) return;
      const cell = e.target.closest('[data-c]');
      if (cell) selectHour(+cell.dataset.c, false);
    });
    slider.addEventListener('input', () => selectHour(+slider.value, true));
    $('#fcEditBtn', box).addEventListener('click', () => {
      state.fcEdit = !state.fcEdit;
      const sl = scroller.scrollLeft;
      renderTonight();
      $('.fc-scroll').scrollLeft = sl;
      animateIn($('.fc-scroll'));
    });
    $('.fc-wrap', box).addEventListener('change', (e) => {
      const cb = e.target.closest('input.rowchk');
      if (!cb) return;
      const set = loadSet('astrosite.fcHidden');
      if (cb.checked) set.delete(cb.dataset.row); else set.add(cb.dataset.row);
      saveSet('astrosite.fcHidden', set);
      $$(`tr[data-row="${cb.dataset.row}"]`, box).forEach((tr) => tr.classList.toggle('off', !cb.checked));
      placeMarkers(state.fcSel);
      syncLayerOptions();
    });
    $('#fcVals', box).addEventListener('change', (e) => {
      state.showVals = e.target.checked;
      try { localStorage.setItem('astrosite.fcvals', state.showVals ? '1' : '0'); } catch (err) { /* ignore */ }
      $('table.fc-vals', box).classList.toggle('novals', !state.showVals);
    });
    let tipEl = $('#fcTip');
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.id = 'fcTip'; tipEl.className = 'fc-tip'; tipEl.hidden = true; document.body.appendChild(tipEl); }
    let tipTd = null, tipFrame = 0, scrolling = false, scrollTimer = 0, lastXY = [0, 0], tipSize = [0, 0];
    const hideTip = () => { if (!tipEl.hidden) tipEl.hidden = true; tipTd = null; };
    const drawTip = () => {
      tipFrame = 0;
      if (scrolling || !tipTd) return;
      const [x0, y0] = lastXY, pad = 14;
      let x = x0 + pad, y = y0 + pad;
      if (x + tipSize[0] > window.innerWidth - 8) x = x0 - tipSize[0] - pad;
      if (y + tipSize[1] > window.innerHeight - 8) y = y0 - tipSize[1] - pad;
      tipEl.style.transform = `translate(${x}px, ${y}px)`;
    };
    scroller.addEventListener('mouseover', (e) => {
      if (scrolling) return;
      const td = e.target.closest('td[data-c]');
      if (!td) { hideTip(); return; }
      if (td === tipTd) return;
      const lines = tipFor(td);
      if (!lines) { hideTip(); return; }
      tipTd = td;
      tipEl.innerHTML = `<b>${esc(lines[0])}</b>${lines.slice(1).map((l) => `<div>${esc(l)}</div>`).join('')}`;
      if (tipEl.hidden) tipEl.hidden = false;
      tipSize = [tipEl.offsetWidth, tipEl.offsetHeight];
      lastXY = [e.clientX, e.clientY];
      if (!tipFrame) tipFrame = requestAnimationFrame(drawTip);
    });
    scroller.addEventListener('mousemove', (e) => {
      if (!tipTd) return;
      lastXY = [e.clientX, e.clientY];
      if (!tipFrame) tipFrame = requestAnimationFrame(drawTip);
    }, { passive: true });
    scroller.addEventListener('mouseleave', hideTip);
    scroller.addEventListener('scroll', () => {
      if (!scrolling) { scrolling = true; hideTip(); }
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { scrolling = false; }, 120);
    }, { passive: true });
    scroller.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, PageDown: 'next', PageUp: 'prev', Home: 'tonight' }[e.key];
      if (step == null) return;
      e.preventDefault();
      if (typeof step === 'number') selectHour(state.fcSel + step, true);
      else navNight(step);
    });
    $$('[data-nav]', box).forEach((b) => b.addEventListener('click', () => navNight(b.dataset.nav)));
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

  // One frame around the whole selected column, and a yellow "now" bar, drawn as overlays in the scroller
  function placeMarkers(i) {
    const box = $('#tonight');
    const scroller = $('.fc-scroll', box);
    if (!scroller) return;
    const table = $('table.fc-vals', scroller);
    const th = $(`thead tr.fc-hours [data-c="${i}"]`, table);
    const hoursRow = $('thead tr.fc-hours', table);
    if (!th || !hoursRow) return;
    let sel = $('.fc-sel', scroller), now = $('.fc-now', scroller);
    if (!sel) { sel = document.createElement('div'); sel.className = 'fc-sel'; scroller.appendChild(sel); }
    if (!now) { now = document.createElement('div'); now.className = 'fc-now'; scroller.appendChild(now); }
    const top = hoursRow.offsetTop;
    const height = table.offsetHeight - top;
    Object.assign(sel.style, { left: `${th.offsetLeft}px`, width: `${th.offsetWidth}px`, top: `${top}px`, height: `${height}px` });
    const hours = state.fc.hours;
    const nowMs = Date.now();
    const k = hours.findIndex((h, j) => j + 1 < hours.length && hours[j + 1].t.getTime() > nowMs && h.t.getTime() <= nowMs);
    if (k >= 0) {
      const thK = $(`thead tr.fc-hours [data-c="${k}"]`, table);
      const frac = (nowMs - hours[k].t.getTime()) / 3600000;
      now.hidden = false;
      Object.assign(now.style, { left: `${thK.offsetLeft + frac * thK.offsetWidth - 1}px`, top: `${$('thead tr.fc-days', table).offsetTop}px`, height: `${table.offsetHeight}px` });
      now.title = `Now · ${fmtTime(new Date())}`;
    } else now.hidden = true;
  }

  function selectHour(i, scroll, instant, alignNight) {
    const hours = state.fc.hours;
    i = Math.max(0, Math.min(hours.length - 1, i));
    state.fcSel = i;
    const box = $('#tonight');
    placeMarkers(i);
    const slider = $('.fc-slider', box);
    if (slider && +slider.value !== i) slider.value = i;
    if (scroll) {
      const scroller = $('.fc-scroll', box);
      const th = $(`thead [data-c="${i}"]`, box);
      const lblW = 0;
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
    if (wxActive()) scheduleWx(60);
    const nightBefore = lastNightKey;
    renderNightSummary(hours[i].t);
    if (lastNightKey !== nightBefore && !instant) animateIn($('#fcNight'));
  }

  function renderHourDetail(h) {
    const el = $('#fcDetail');
    if (!el) return;
    const v = (x, d = 0) => (x == null ? '—' : (+x).toFixed(d));
    const limTag = (b) => (b ? ' <span class="limtag">limited</span>' : '');
    const cl = h.cloud != null && h.cloud >= SM.CLOUDY ? ' (sky cloudy)' : '';
    const seeTxt = h.see ? `~${h.see.arcsec.toFixed(1)}″ · ${SM.SEEING_LABELS[h.see.rawCls]}${cl}` : '—';
    const trTxt = h.trans ? `index ${h.trans.index.toFixed(1)} · ${SM.TRANS_LABELS[h.trans.rawCls]}${cl}` : '—';
    const items = [
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
    el.innerHTML = csWrap('hour', `${esc(fmtDay(h.t))} · ${fmtTime(h.t)}`,
      `<table class="vals fc-detail"><tbody>${items.map(([k, val]) => `<tr><td class="k">${esc(k)}</td><td>${val}</td></tr>`).join('')}</tbody></table>`);
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
    el.innerHTML = csWrap('night', `Night of ${esc(fmtDay(noon))}`, `
      <div class="tn-grid">
        ${cell('Sunset', fmtTime(s.ev.sunset), `Civil dusk ${fmtTime(s.ev.dusk)}`)}
        ${cell('Sunrise', fmtTime(s.mo.sunrise), `Civil dawn ${fmtTime(s.mo.dawn)}`)}
        ${cell('Astro dusk (−18°)', fmtTime(s.ev.night), `Nautical dusk ${fmtTime(s.ev.nauticalDusk)}`)}
        ${cell('Astro dawn (−18°)', fmtTime(s.mo.nightEnd), `Nautical dawn ${fmtTime(s.mo.nauticalDawn)}`)}
        ${cell('Darkness', fmtDur(s.astroDark), isNaN(s.ev.night) ? 'No astronomical darkness' : `${fmtDur(s.moonFree)} moon-free`)}
        ${cell('Moon', `${Math.round(s.illum.fraction * 100)}%`, `${moonPhaseName(s.illum.phase)} · ${moonTxt}`)}
      </div>`);
  }

  /* ---------------- Saved (favourite) locations ---------------- */
  let favs = [];
  try { favs = JSON.parse(localStorage.getItem('astrosite.favs') || '[]').filter((f) => isFinite(f.lat) && isFinite(f.lon)); } catch (e) { favs = []; }
  const sameSpot = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;
  const saveFavs = () => { try { localStorage.setItem('astrosite.favs', JSON.stringify(favs)); } catch (e) { toast('Could not save — browser storage unavailable'); } };
  const currentFavIdx = () => (state.lat == null ? -1 : favs.findIndex((f) => sameSpot(f, state)));

  let homeRenderedKey = null;
  const homeRenderKey = () => favs.map((f) => `${f.name}@${(+f.lat).toFixed(4)},${(+f.lon).toFixed(4)}`).join('|');
  function updateFavStar() {
    if (!$('#tab-home').hidden && homeRenderedKey !== null && homeRenderedKey !== homeRenderKey()) setTimeout(renderHome, 0);
    const star = $('#favToggle');
    if (!star) return;
    star.hidden = state.lat == null;
    const on = currentFavIdx() >= 0;
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', on);
    star.title = on ? 'Remove from saved locations' : 'Save this location';
  }

  $('#favToggle').addEventListener('click', () => {
    const i = currentFavIdx();
    if (i >= 0) { favs.splice(i, 1); toast('Removed from saved locations'); }
    else {
      favs.push({
        name: state.name || 'Unnamed site', lat: +state.lat.toFixed(7), lon: +state.lon.toFixed(7),
        elev: state.elev != null ? Math.round(state.elev) : null, elevSource: state.elevSource || '',
        bortle: state.lp && !state.lp.outOfBounds ? state.lp.bortle : null, saved: new Date().toISOString(),
      });
      toast(`Saved “${state.name || 'Unnamed site'}”`);
    }
    saveFavs(); updateFavStar();
    if (!$('#tab-home').hidden) renderHome();
  });

  $('#favDownload').addEventListener('click', () => {
    if (!favs.length) { toast('Nothing to download yet'); return; }
    const data = { app: 'Astro Planner', format: 1, exported: new Date().toISOString(), locations: favs };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `astro-planner-saved-locations-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#favUpload').addEventListener('click', () => $('#favFile').click());
  $('#favFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.locations;
      if (!Array.isArray(list)) throw new Error('no locations list found');
      let added = 0, skipped = 0;
      list.forEach((f) => {
        const lat = parseFloat(f.lat ?? f.latitude), lon = parseFloat(f.lon ?? f.longitude);
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped++; return; }
        const item = {
          name: String(f.name || 'Unnamed site').slice(0, 120), lat, lon,
          elev: isFinite(parseFloat(f.elev ?? f.elevation_m)) ? parseFloat(f.elev ?? f.elevation_m) : null,
          elevSource: String(f.elevSource || ''), bortle: f.bortle ? String(f.bortle).slice(0, 4) : null, saved: f.saved || new Date().toISOString(),
        };
        if (favs.some((x) => sameSpot(x, item))) { skipped++; return; }
        favs.push(item); added++;
      });
      saveFavs(); updateFavStar();
      if (!$('#tab-home').hidden) renderHome();
      toast(`Imported ${added} location${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (duplicates or invalid)` : ''}`);
    } catch (err) {
      toast(`Couldn't import: ${err.message}`);
    }
  });

  function setUnits(u) {
    state.units = u === 'imperial' ? 'imperial' : 'metric';
    try { localStorage.setItem('astrosite.units', state.units); } catch (err) { /* ignore */ }
    $$('#unitsSeg button').forEach((b) => b.classList.toggle('on', b.dataset.units === state.units));
    if (state.fc) {
      const sc = $('.fc-scroll'); const sl = sc ? sc.scrollLeft : 0;
      renderTonight();
      if ($('.fc-scroll')) $('.fc-scroll').scrollLeft = sl;
    }
    if (typeof renderWx === 'function') renderWx();
  }

  /* ---------------- Home: saved locations with a combined-conditions timeline ---------------- */
  const HOME_VARS = ['cloud_cover', 'cloud_cover_high', 'dew_point_2m', 'surface_pressure', 'total_column_integrated_water_vapour',
    'wind_gusts_10m', 'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_500hPa', 'wind_direction_500hPa',
    'wind_speed_300hPa', 'wind_direction_300hPa', 'wind_speed_200hPa'];
  let homeCache = { key: '', at: 0, data: null, pending: null };
  const homeKey = () => favs.map((f) => `${(+f.lat).toFixed(3)},${(+f.lon).toFixed(3)}`).join('|');

  async function loadHomeData() {
    const key = homeKey();
    if (!favs.length) return null;
    if (homeCache.key === key && homeCache.data && Date.now() - homeCache.at < 3600000) return homeCache.data;
    if (homeCache.pending && homeCache.key === key) return homeCache.pending;
    homeCache.key = key;
    const lats = favs.map((f) => (+f.lat).toFixed(4)).join(','), lons = favs.map((f) => (+f.lon).toFixed(4)).join(',');
    const q = `latitude=${lats}&longitude=${lons}&timezone=GMT`;
    homeCache.pending = (async () => {
      const [fcR, aqR] = await Promise.all([
        OM.cached(`home.${key}`, 3600000, () => OM.request('forecast', `${q}&forecast_days=${FC_DAYS}&wind_speed_unit=ms&hourly=${HOME_VARS.join(',')}`, { locations: favs.length, vars: HOME_VARS.length, days: FC_DAYS })),
        OM.cached(`homeaq.${key}`, 3600000, () => OM.request('aq', `${q}&forecast_days=7&hourly=aerosol_optical_depth`, { locations: favs.length, vars: 1, days: 7 })).catch(() => ({ data: null })),
      ]);
      const fc = fcR.data, aq = aqR.data;
      homeCache.stale = !!fcR.stale;
      const fcs = Array.isArray(fc) ? fc : [fc];
      const aqs = aq ? (Array.isArray(aq) ? aq : [aq]) : [];
      const now = Date.now() - 3600000;
      const data = favs.map((f, k) => {
        const H = fcs[k] && fcs[k].hourly;
        if (!H) return { hours: [] };
        const aodMap = new Map();
        const A2 = aqs[k] && aqs[k].hourly;
        if (A2 && A2.time && A2.aerosol_optical_depth) A2.time.forEach((t, i) => { if (A2.aerosol_optical_depth[i] != null) aodMap.set(Date.parse(`${t}:00Z`), A2.aerosol_optical_depth[i]); });
        const hours = [];
        H.time.forEach((t, i) => {
          const ms = Date.parse(`${t}:00Z`);
          if (ms < now) return;
          const g = (name) => (H[name] ? H[name][i] : null);
          const h = {
            t: new Date(ms), cloud: g('cloud_cover'), cloudHigh: g('cloud_cover_high'), dew: g('dew_point_2m'), pressure: g('surface_pressure'),
            tcwv: g('total_column_integrated_water_vapour'), gust: g('wind_gusts_10m'),
            ws850: g('wind_speed_850hPa'), wd850: g('wind_direction_850hPa'), ws500: g('wind_speed_500hPa'), wd500: g('wind_direction_500hPa'),
            ws300: g('wind_speed_300hPa'), wd300: g('wind_direction_300hPa'), ws200: g('wind_speed_200hPa'), aod: aodMap.has(ms) ? aodMap.get(ms) : null,
          };
          h.sunAlt = SunCalc.getPosition(h.t, f.lat, f.lon).altitude * A.R2D;
          h.see = SM.seeing(h);
          h.trans = SM.transparency(h);
          // One colour per hour from the three sky-quality drivers
          h.night = h.sunAlt <= -12;
          if (h.cloud != null) {
            const trQ = h.trans ? clamp01(1 - h.trans.index / 30) : 0.6;
            const seQ = h.see ? clamp01((4.5 - h.see.arcsec) / 3.5) : 0.6;
            h.q = Math.pow(1 - h.cloud / 100, 1.5) * (0.6 + 0.25 * trQ + 0.15 * seQ);
            h.lim = !h.trans || !h.see || h.trans.aodEst || h.trans.pwvEst;
          }
          hours.push(h);
        });
        return { hours };
      });
      homeCache.data = data; homeCache.at = Date.now(); homeCache.pending = null;
      return data;
    })().catch((e) => { homeCache.pending = null; throw e; });
    return homeCache.pending;
  }

  const localDay = (d) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric' }).format(d);
  const localTime = (d) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

  // Summaries per location: next 24 h (hourly) and next 14 nights (one value per night)
  function homeSeries(hours) {
    const now = Date.now();
    const h24 = hours.filter((h) => h.q != null && h.t.getTime() >= now - 1800000 && h.t.getTime() < now + 24 * 3600000);
    const byNight = new Map();
    hours.forEach((h) => {
      if (h.q == null) return;
      const d = new Date(h.t.getTime() - 12 * 3600000); // evening date (browser-local) of the night this hour belongs to
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!byNight.has(key)) byNight.set(key, { day: new Date(d.getFullYear(), d.getMonth(), d.getDate()), all: [], dark: [] });
      const n = byNight.get(key);
      n.all.push(h); if (h.night) n.dark.push(h);
    });
    const nights = [...byNight.values()].slice(0, 14).map((n) => {
      const set = n.dark.length ? n.dark : n.all;
      const avg = (f) => { const v = set.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      return {
        day: n.day, hours: set, q: avg((h) => h.q), lim: set.some((h) => h.lim), cloud: avg((h) => h.cloud),
        trans: avg((h) => (h.trans ? h.trans.index : null)), see: avg((h) => (h.see ? h.see.arcsec : null)),
        mid: set[Math.floor(set.length / 2)].t,
      };
    });
    return { h24, nights };
  }

  function drawGradient(canvas, stops, ticks) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const cs = getComputedStyle(document.body);
    ctx.fillStyle = cs.getPropertyValue('--bg-3');
    ctx.fillRect(0, 0, w, hgt);
    if (stops.length) {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      const pts = stops.map((st) => ({ x: Math.max(0, Math.min(1, st.x)), c: shadeRgb(st.q, st.lim) }));
      // canvas gradients interpolate in sRGB, so add OKLab-blended sub-stops between data points
      pts.forEach((pt, k) => {
        g.addColorStop(pt.x, rgbStr(pt.c));
        const nx = pts[k + 1];
        if (nx) for (let j = 1; j < 6; j++) g.addColorStop(pt.x + ((nx.x - pt.x) * j) / 6, rgbStr(mixRgb(pt.c, nx.c, j / 6)));
      });
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hgt);
    }
    ctx.fillStyle = cs.getPropertyValue('--text');
    ctx.globalAlpha = 0.55;
    ticks.forEach((tk) => { const x = Math.round(tk.x * w); ctx.fillRect(x, 0, 1, tk.major ? 5 : 3); ctx.fillRect(x, hgt - (tk.major ? 5 : 3), 1, tk.major ? 5 : 3); });
    ctx.globalAlpha = 1;
  }

  const localHour = (d) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false }).format(d);

  async function renderHome() {
    const list = $('#homeList'), axis = $('#homeAxis'), status = $('#homeStatus'), legend = $('#homeLegend');
    refreshSettings();
    homeRenderedKey = homeRenderKey();
    if (!favs.length) {
      list.innerHTML = '<p class="muted pad">No saved locations yet. Pick a site and press ☆ next to its name in the header.</p>';
      axis.innerHTML = ''; legend.innerHTML = ''; status.textContent = '';
      return;
    }
    list.innerHTML = favs.map((f, i) => `<div class="hl-row" data-i="${i}">
        <div class="hl-namebox">
          <button class="hl-name" data-go="${i}" title="Open ${esc(f.name || 'site')}"><span>${esc(f.name || 'Unnamed site')}</span><small>${f.bortle ? `Bortle ~${esc(f.bortle)}` : `${(+f.lat).toFixed(2)}, ${(+f.lon).toFixed(2)}`}</small></button>
          <span class="hl-tools"><button class="hl-ren" data-ren="${i}" title="Rename" aria-label="Rename ${esc(f.name || 'site')}">✎</button><button class="hl-rm" data-rm="${i}" title="Remove" aria-label="Remove ${esc(f.name || 'site')}">×</button></span>
        </div>
        <canvas class="hl-strip" data-i="${i}" data-kind="h24"></canvas>
        <canvas class="hl-strip" data-i="${i}" data-kind="d14"></canvas>
      </div>`).join('');
    status.textContent = 'Loading forecasts…';
    let data;
    try { data = await loadHomeData(); } catch (e) { status.textContent = `Couldn't load forecasts (${e.message})`; return; }
    if (!data || !$('#homeList .hl-strip')) return;
    status.textContent = homeCache.stale ? 'Showing cached forecasts (service limit reached)' : '';
    const now = Date.now();
    const h0 = Math.floor(now / 3600000) * 3600000, h1 = h0 + 24 * 3600000;
    const series = data.map((d) => homeSeries(d.hours));
    homeCache.series = series;
    const days = (series.find((s2) => s2.nights.length) || { nights: [] }).nights.map((n) => n.day);
    const nD = Math.max(1, days.length);
    homeCache.h24range = [h0, h1];
    const hourTicks = []; for (let k = 0; k <= 24; k++) hourTicks.push({ x: k / 24, major: new Date(h0 + k * 3600000).getHours() % 6 === 0 });
    const dayTicks = []; for (let k = 0; k <= nD; k++) dayTicks.push({ x: k / nD, major: true });
    $$('#homeList .hl-strip').forEach((cv) => {
      const sr = series[+cv.dataset.i];
      if (!sr) return;
      if (cv.dataset.kind === 'h24') {
        drawGradient(cv, sr.h24.map((h) => ({ x: (h.t.getTime() + 1800000 - h0) / (h1 - h0), q: h.q, lim: h.lim })), hourTicks);
      } else {
        drawGradient(cv, sr.nights.map((n, k) => ({ x: (k + 0.5) / nD, q: n.q, lim: n.lim })), dayTicks);
      }
    });
    const stripW = ($('#homeList .hl-strip[data-kind="d14"]') || {}).clientWidth || 200;
    const dayEvery = Math.max(1, Math.ceil(44 / (stripW / nD)));
    axis.innerHTML = `<span class="hl-axis-pad"></span>
      <div class="hl-axis-track"><em>Next 24 h</em>${[0, 6, 12, 18].map((k) => `<span style="left:${(k / 24) * 100}%"><b>${esc(localHour(new Date(h0 + k * 3600000)))}</b></span>`).join('')}</div>
      <div class="hl-axis-track"><em>Next 14 nights</em>${days.map((d, k) => (k % dayEvery === 0 ? `<span style="left:${((k + 0.5) / nD) * 100}%"><b class="c">${esc(localDay(d))}</b></span>` : '')).join('')}</div>`;
    const bar = [0, 0.25, 0.5, 0.75, 1].map((q) => `<i style="background:${shade(q, false).bg}"></i>`).join('');
    legend.innerHTML = `<span class="scale">${bar}</span> worse → better (cloud, transparency, seeing) <i class="red-swatch"></i> estimated inputs <span class="muted">· nights averaged over dark hours · your time zone</span>`;
  }

  // Hover tooltips and click-through on the strips
  function homeHit(cv, clientX) {
    const r = cv.getBoundingClientRect();
    const fx = (clientX - r.left) / r.width;
    const sr = homeCache.series && homeCache.series[+cv.dataset.i];
    if (!sr) return null;
    if (cv.dataset.kind === 'h24') {
      const [h0, h1] = homeCache.h24range;
      const ms = h0 + fx * (h1 - h0);
      const h = sr.h24.find((x) => ms >= x.t.getTime() && ms < x.t.getTime() + 3600000);
      return h ? { kind: 'h', h, time: h.t.getTime() } : null;
    }
    const n = sr.nights[Math.min(sr.nights.length - 1, Math.floor(fx * sr.nights.length))];
    return n ? { kind: 'n', n, time: n.mid.getTime() } : null;
  }
  $('#homeList').addEventListener('mousemove', (e) => {
    const cv = e.target.closest('.hl-strip');
    const tip = $('#fcTip') || (() => { const t = document.createElement('div'); t.id = 'fcTip'; t.className = 'fc-tip'; t.hidden = true; document.body.appendChild(t); return t; })();
    const hit = cv && homeHit(cv, e.clientX);
    if (!hit) { tip.hidden = true; return; }
    const f = favs[+cv.dataset.i];
    let head, lines;
    if (hit.kind === 'h') {
      const h = hit.h;
      head = `${f.name || 'Site'} · ${localTime(h.t)}`;
      lines = [`Conditions ${Math.round(h.q * 100)} / 100${h.lim ? ' (estimated inputs)' : ''}${h.night ? '' : ' · not dark'}`,
        `Cloud ${h.cloud ?? '—'}% · high ${h.cloudHigh ?? '—'}%`,
        h.trans ? `Transparency ${h.trans.index.toFixed(1)} · ${SM.TRANS_LABELS[h.trans.rawCls]}` : 'Transparency —',
        h.see ? `Seeing ~${h.see.arcsec.toFixed(1)}″ · ${SM.SEEING_LABELS[h.see.rawCls]}` : 'Seeing —'];
    } else {
      const n = hit.n;
      head = `${f.name || 'Site'} · night of ${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(n.day)}`;
      lines = [`Conditions ${Math.round(n.q * 100)} / 100${n.lim ? ' (estimated inputs)' : ''}`,
        `Cloud ${n.cloud == null ? '—' : Math.round(n.cloud)}% (night average)`,
        `Transparency ${n.trans == null ? '—' : n.trans.toFixed(1)} · Seeing ~${n.see == null ? '—' : n.see.toFixed(1)}″`];
    }
    tip.innerHTML = `<b>${esc(head)}</b>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 14;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - 14;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  });
  $('#homeList').addEventListener('mouseleave', () => { const t = $('#fcTip'); if (t) t.hidden = true; });
  function homeRename(i) {
    const box = $(`#homeList .hl-row[data-i="${i}"] .hl-namebox`);
    if (!box) return;
    const f = favs[i];
    box.innerHTML = `<input class="ren-input" type="text" maxlength="120" value="${esc(f.name || '')}" aria-label="New name">`;
    const inp = $('.ren-input', box);
    inp.focus(); inp.select();
    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      const name = inp.value.trim();
      if (save && name && name !== f.name) {
        f.name = name; saveFavs();
        if (state.lat != null && sameSpot(f, state)) { state.name = name; renderHead(); renderCoords(); updateHash(); }
        toast(`Renamed to “${name}”`);
      }
      renderHome();
    };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
    inp.addEventListener('blur', () => commit(true));
  }
  $('#homeList').addEventListener('click', (e) => {
    if (e.target.closest('.ren-input')) return;
    const ren = e.target.closest('[data-ren]');
    if (ren) { homeRename(+ren.dataset.ren); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = 'Remove?'; rm.classList.add('armed'); setTimeout(() => { if (rm.isConnected) { delete rm.dataset.armed; rm.textContent = '×'; rm.classList.remove('armed'); } }, 3000); return; }
      const f = favs.splice(+rm.dataset.rm, 1)[0];
      saveFavs(); updateFavStar(); renderHome();
      toast(`Removed “${f.name || 'site'}”`);
      return;
    }
    const go = e.target.closest('[data-go]');
    const cv = e.target.closest('.hl-strip');
    const i = go ? +go.dataset.go : cv ? +cv.dataset.i : -1;
    if (i < 0) return;
    const f = favs[i];
    const hit = cv && homeHit(cv, e.clientX);
    if (hit) state.pendingTime = hit.time;
    const t = $('#fcTip'); if (t) t.hidden = true;
    setLocation(f.lat, f.lon, { name: f.name, zoom: 12, elev: /GPS/.test(f.elevSource || '') ? f.elev : null, elevSource: f.elevSource });
    activateTab(hit ? 'tonight' : 'coords');
  });
  let homeResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(homeResizeTimer);
    homeResizeTimer = setTimeout(() => { if (!$('#tab-home').hidden && homeCache.data) renderHome(); }, 200);
  });

  OM.onLimit((until) => {
    toast(`Open-Meteo free limit reached — using cached data until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    renderCaption();
    if (!$('#tab-home').hidden) refreshSettings();
  });

  /* ---------------- Settings backup: everything the browser remembers ---------------- */
  const CFG_PREFIX = 'astrosite.';
  function refreshSettings() {
    const n = Object.keys(localStorage).filter((k) => k.startsWith(CFG_PREFIX)).length;
    $('#cfgCount').textContent = `${n} stored setting${n === 1 ? '' : 's'}`;
    $('#favSummary').textContent = favs.length ? `${favs.length} saved location${favs.length === 1 ? '' : 's'}` : 'None saved';
    $$('#unitsSeg button').forEach((b) => b.classList.toggle('on', b.dataset.units === state.units));
    $$('#qualitySeg button').forEach((b) => b.classList.toggle('on', b.dataset.quality === mapQuality));
    $$('.hq-only').forEach((el) => { el.hidden = mapQuality !== 'high'; });
    $('#smoothMapChk').checked = smoothMapPref;
    $('#smoothDataChk').checked = smoothDataPref;
    $('#appVersion').textContent = APP_VERSION;
    const u = OM.usage();
    $('#omUsage').textContent = `≈ ${u.hour.toLocaleString()} calls this hour · ${u.day.toLocaleString()} today (this browser) · ECCC GeoMet map fields: ${GeoMet.requests()} requests this session${OM.limited() ? ` · limit reached, resuming ${new Date(OM.cooldownUntil()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`;
    const ki = $('#omKey'); if (document.activeElement !== ki) ki.value = OM.apiKey();
  }
  $$('#unitsSeg button').forEach((b) => b.addEventListener('click', () => setUnits(b.dataset.units)));
  $$('#qualitySeg button').forEach((b) => b.addEventListener('click', () => {
    mapQuality = b.dataset.quality === 'high' ? 'high' : 'standard';
    try { localStorage.setItem('astrosite.quality', mapQuality); } catch (e) { /* ignore */ }
    $$('#qualitySeg button').forEach((x) => x.classList.toggle('on', x.dataset.quality === mapQuality));
    refreshSettings();
    applySmoothing({ refetch: true });
  }));
  function applySmoothing(opts = {}) {
    if (map.hasLayer(lpLayer)) { lpSetOn(true); lpHQ.redraw(); }
    if (wxActive()) { if (opts.refetch) wx.grid = null; scheduleWx(0); }
    if (state.fc && !$('#tab-tonight').hidden) {
      const sc = $('.fc-scroll'); const sl = sc ? sc.scrollLeft : 0;
      renderTonight();
      if ($('.fc-scroll')) $('.fc-scroll').scrollLeft = sl;
    }
  }
  $('#smoothMapChk').addEventListener('change', (e) => {
    smoothMapPref = e.target.checked;
    try { localStorage.setItem('astrosite.smoothMap', smoothMapPref ? '1' : '0'); } catch (err) { /* ignore */ }
    applySmoothing();
  });
  $('#smoothDataChk').addEventListener('change', (e) => {
    smoothDataPref = e.target.checked;
    try { localStorage.setItem('astrosite.smoothData', smoothDataPref ? '1' : '0'); } catch (err) { /* ignore */ }
    applySmoothing();
  });
  $('#resetWidth').addEventListener('click', () => { setPanelWidth(PANEL_DEFAULT, true); toast('Sidebar width reset'); });
  $('#omKey').addEventListener('change', (e) => {
    OM.setApiKey(e.target.value);
    toast(e.target.value.trim() ? 'Open-Meteo API key saved — using the customer endpoints' : 'Open-Meteo API key removed');
    refreshSettings();
  });
  $('#cfgExport').addEventListener('click', () => {
    const settings = {};
    Object.keys(localStorage).filter((k) => k.startsWith(CFG_PREFIX)).sort().forEach((k) => { settings[k.slice(CFG_PREFIX.length)] = localStorage.getItem(k); });
    const data = { app: 'Astro Planner', kind: 'config', format: 1, exported: new Date().toISOString(), settings };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `astro-planner-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#cfgImport').addEventListener('click', () => $('#cfgFile').click());
  $('#cfgFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !/^Astro ?(Site|Planner)$/.test(data.app || '') || typeof data.settings !== 'object' || !data.settings) throw new Error('not an Astro Planner config file');
      let n = 0;
      Object.entries(data.settings).forEach(([k, v]) => {
        if (!/^[\w.-]{1,40}$/.test(k) || typeof v !== 'string' || v.length > 500000) return;
        localStorage.setItem(CFG_PREFIX + k, v); n++;
      });
      toast(`Restored ${n} settings — reloading…`);
      setTimeout(() => { history.replaceState(null, '', location.pathname); location.reload(); }, 700);
    } catch (err) {
      toast(`Couldn't import config: ${err.message}`);
    }
  });
  $('#cfgReset').addEventListener('click', () => {
    const b = $('#cfgReset');
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Click again to confirm';
      setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reset all settings'; }, 3000);
      return;
    }
    Object.keys(localStorage).filter((k) => k.startsWith(CFG_PREFIX)).forEach((k) => localStorage.removeItem(k));
    history.replaceState(null, '', location.pathname); location.reload();
  });

  /* ---------------- Export ---------------- */
  function exportRows() {
    const rows = [];
    byType().forEach((g) => g.rows.forEach((r) => {
      if (r.snip) return;
      rows.push([g.title, r.k + (r.sub ? ` (${r.sub})` : ''), r.lv ? live[r.lv]() : r.v]);
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
      if (state.name) p.set('name', state.name);
      p.set('z', map.getZoom());
      history.replaceState(null, '', `#${p.toString()}`);
      try {
        localStorage.setItem('astrosite.last', JSON.stringify({
          lat: state.lat, lon: state.lon, name: state.name, sub: state.sub, z: map.getZoom(),
          elev: /GPS/.test(state.elevSource) ? state.elev : null,
          elevSource: state.elevSource,
        }));
      } catch (e) { /* storage unavailable */ }
    }, 300);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return false;
    setLocation(lat, lon, {
      zoom: parseInt(p.get('z'), 10) || 11,
      name: p.get('name') || '',
    });
    return true;
  }
  map.on('zoomend', updateHash);

  /* ---------------- Tabs, night mode ---------------- */
  /* ---------------- Transitions ---------------- */
  function animateIn(el) {
    if (!el) return;
    el.classList.remove('anim-in');
    void el.offsetWidth; // restart the animation
    el.classList.add('anim-in');
  }
  function moveInk() {
    const active = $('.tab.active');
    const ink = $('.tab-ink');
    if (!active || !ink) return;
    ink.style.transform = `translateX(${active.offsetLeft}px)`;
    ink.style.width = `${active.offsetWidth}px`;
  }

  function activateTab(name, opts = {}) {
    const t = $(`.tab[data-tab="${name}"]`);
    if (!t) return;
    const was = t.classList.contains('active');
    $$('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    $$('.tab-body').forEach((b) => { b.hidden = b.id !== `tab-${name}`; });
    if (name === 'tonight') renderTonight();
    if (name === 'home') renderHome();
    if (!was && !opts.instant) animateIn($(`#tab-${name}`));
    moveInk();
    try { localStorage.setItem('astrosite.tab', name); } catch (e) { /* ignore */ }
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => { if (!t.classList.contains('active')) activateTab(t.dataset.tab); }));
  requestAnimationFrame(moveInk);

  /* ---------------- Resizable sidebar (width remembered) ---------------- */
  const PANEL_DEFAULT = 600, PANEL_MIN = 360;
  const panelMax = () => Math.max(PANEL_MIN, window.innerWidth - 320);
  let invalidateTimer;
  function setPanelWidth(w, save) {
    w = Math.round(Math.max(PANEL_MIN, Math.min(panelMax(), w)));
    document.documentElement.style.setProperty('--panel-w', `${w}px`);
    clearTimeout(invalidateTimer);
    invalidateTimer = setTimeout(() => { map.invalidateSize(); moveInk(); }, 60);
    if (save) { try { localStorage.setItem('astrosite.panelw', w); } catch (e) { /* ignore */ } }
    return w;
  }
  try { const w = parseInt(localStorage.getItem('astrosite.panelw'), 10); if (w) setPanelWidth(w, false); } catch (e) { /* ignore */ }
  const resizer = $('#resizer');
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => setPanelWidth(window.innerWidth - ev.clientX, false);
    const up = (ev) => {
      setPanelWidth(window.innerWidth - ev.clientX, true);
      document.body.classList.remove('resizing');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('dblclick', () => { setPanelWidth(PANEL_DEFAULT, true); toast('Sidebar width reset'); });
  resizer.addEventListener('keydown', (e) => {
    const cur = $('#panel').offsetWidth;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPanelWidth(cur + 24, true); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setPanelWidth(cur - 24, true); }
  });
  window.addEventListener('resize', () => { moveInk(); const cur = $('#panel').offsetWidth; if (cur > panelMax()) setPanelWidth(panelMax(), false); });

  function setNight(on) {
    const changed = document.body.classList.contains('night') !== on;
    document.body.classList.toggle('night', on);
    if (changed && !$('#tab-home').hidden && homeCache.data) renderHome();
    if (changed && state.fc && !$('#tab-tonight').hidden) {
      const sc = $('.fc-scroll'); const sl = sc ? sc.scrollLeft : 0;
      renderTonight();
      if ($('.fc-scroll')) $('.fc-scroll').scrollLeft = sl;
    }
    $$('#schemeSeg button').forEach((b) => b.classList.toggle('on', (b.dataset.scheme === 'night') === on));
    try { localStorage.setItem('astrosite.night', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  $$('#schemeSeg button').forEach((b) => b.addEventListener('click', () => setNight(b.dataset.scheme === 'night')));
  try { if (localStorage.getItem('astrosite.night') === '1') setNight(true); } catch (e) { /* ignore */ }

  /* ---------------- Map layers panel: light pollution, live satellite IR, forecast overlays ---------------- */
  map.createPane('satPane'); map.getPane('satPane').style.zIndex = 245; map.getPane('satPane').style.pointerEvents = 'none';
  map.createPane('wxPane'); map.getPane('wxPane').style.zIndex = 260; map.getPane('wxPane').style.pointerEvents = 'none';

  const satTime = () => {
    const d = new Date(Date.now() - 40 * 60000);
    d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 10), 0, 0);
    return d.toISOString().slice(0, 17) + '00Z';
  };
  const SAT_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{time}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
  // Geostationary IR sources and their sub-satellite longitudes (each pixel uses the satellite with the best view)
  const SAT_SRC = [
    { layer: 'GOES-East_ABI_Band13_Clean_Infrared', lon: -75.2 },
    { layer: 'GOES-West_ABI_Band13_Clean_Infrared', lon: -137.2 },
    { layer: 'Himawari_AHI_Band13_Clean_Infrared', lon: 140.7 },
  ];
  const lonDist = (a, b) => Math.abs(A.mod(a - b + 180, 360) - 180);

  // GIBS "Clean Longwave Infrared Window Band" palette → brightness temperature (°C), from the layer's colormap
  const IR_PAL = (() => {
    const P = [[255, 255, 255, -91.6]];
    for (let i = 0; i < 11; i++) P.push([Math.round(127 + 12.8 * i), Math.round(12.7 * i), Math.round(127 + 7.6 * i), -90.6 + i]);
    [230, 204, 177, 155, 129, 102, 76, 54, 27, 5].forEach((v, i) => P.push([v, v, v, -79.6 + i]));
    for (let i = 0; i < 10; i++) P.push([Math.round(25.5 * (i + 1)), 0, 0, -69.6 + i]);
    for (let i = 0; i < 10; i++) P.push([255, Math.round(25.5 * (i + 1)), 0, -59.6 + i]);
    for (let i = 0; i < 10; i++) P.push([Math.round(255 - 25.5 * (i + 1)), 255, 0, -49.6 + i]);
    [[234, 10], [212, 19], [191, 29], [170, 38], [149, 48], [128, 58], [106, 67], [85, 77], [64, 86]].forEach(([g, b], i) => P.push([0, g, b, -39.6 + i]));
    [[42, 96], [21, 105], [0, 115], [0, 125]].forEach(([g, b], i) => P.push([0, g, b, -30.85 + 0.5 * i]));
    for (let i = 0; i < 20; i++) P.push([0, Math.round(12.75 * (i + 1)), Math.round(122 + 7 * i), -28.85 + 0.5 * i]);
    return P;
  })();
  const COLD_GREY = new Map([230, 204, 177, 155, 129, 102, 76, 54, 27, 5].map((v, i) => [v, -79.6 + i]));
  const warmGrey = (g) => -18.85 + ((197 - g) / 1.2895) * 0.5;
  // The palette reuses ten grey levels for −80…−70 °C cloud tops. A pixel with one of those greys is read as cold only when
  // its surroundings look like a cold-top pattern (colours, other cold greys) and not like a smooth warm-grey ramp.
  function greyIsCold(d, x, y, g) {
    let coldHint = false;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = y + dy; if (yy < 0 || yy > 255) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx; if ((!dx && !dy) || xx < 0 || xx > 255) continue;
        const o = (yy * 256 + xx) * 4; if (d[o + 3] <= 128) continue;
        const r = d[o], gg = d[o + 1], b = d[o + 2];
        if (r !== gg || gg !== b) { coldHint = true; continue; }
        const diff = Math.abs(gg - g);
        if (diff >= 1 && diff <= 3 && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return false; // warm ramp neighbour
        if (gg > 197 || (diff > 3 && COLD_GREY.has(gg))) coldHint = true;
      }
    }
    return coldHint;
  }
  const irMemo = new Map();
  function irTemp(r, g, b) {
    if (r === g && g === b && g <= 197) return COLD_GREY.has(g) ? COLD_GREY.get(g) : warmGrey(g); // warm grey ramp
    const key = (r << 16) | (g << 8) | b;
    let t = irMemo.get(key);
    if (t === undefined) {
      // resampled overview tiles contain blended colours: take the nearest palette entry (or the grey ramp)
      let best = Infinity;
      const m = (r + g + b) / 3, dg = (r - m) ** 2 + (g - m) ** 2 + (b - m) ** 2;
      if (m <= 197) { best = dg; t = warmGrey(m); }
      for (const [pr, pg, pb, pt] of IR_PAL) {
        const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (d < best) { best = d; t = pt; }
      }
      irMemo.set(key, t);
    }
    return t;
  }
  // Brightness temperature → cloud fraction, relative to the surface (forecast 2 m temperature):
  // within ~3 °C of the surface = clear; ~20 °C or more colder = overcast.
  const irCloud = (bt, tsfc) => Math.max(0, Math.min(1, (tsfc - bt - 3) / 17));

  // 2 m temperature (°C) across the forecast lattice at the current hour, for the satellite cloud estimate
  function sfcTempField() {
    const g = wx.grid;
    if (!g) return null;
    const ti = Math.round((floorHour(Date.now()) - g.times[0]) / 3600000);
    if (ti < 0 || ti >= g.times.length) return null;
    const key = `t2m|${ti}`;
    g.cache = g.cache || new Map();
    if (g.cache.has(key)) return g.cache.get(key);
    const v = new Float32Array(g.pts.length).fill(NaN);
    let any = false;
    g.pts.forEach((p, k) => { const h = wxHour(p, ti); if (h && h.temp != null) { v[k] = h.temp; any = true; } });
    const f = any ? { g, v, id: `${g.zoom}|${g.c0}|${g.r0}|${g.sp}|${ti}` } : null;
    g.cache.set(key, f);
    return f;
  }
  function sfcTempAt(f, X, Y, z) {
    // X, Y: projected pixel coordinates at zoom z
    const { g, v } = f, s = 2 ** (g.zoom - z);
    const fc = Math.max(0, Math.min(g.cols - 1, (X * s) / g.sp - g.c0)), fr = Math.max(0, Math.min(g.rows - 1, (Y * s) / g.sp - g.r0));
    const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(g.cols - 1, c0 + 1), r1 = Math.min(g.rows - 1, r0 + 1), tx = fc - c0, ty = fr - r0;
    let acc = 0, wsum = 0;
    [[r0, c0, (1 - tx) * (1 - ty)], [r0, c1, tx * (1 - ty)], [r1, c0, (1 - tx) * ty], [r1, c1, tx * ty]].forEach(([r, c, w]) => {
      const x = v[r * g.cols + c];
      if (w > 0 && isFinite(x)) { acc += x * w; wsum += w; }
    });
    return wsum > 0 ? acc / wsum : NaN;
  }

  // Live satellite cloud layer: IR tiles decoded to brightness temperature, converted to cloud fraction and drawn
  // with the same colour scale as the forecast cloud-cover layer.
  const loadImg = (url) => new Promise((res) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
  const SatCloudLayer = L.GridLayer.extend({
    options: { pane: 'satPane', maxNativeZoom: 6, maxZoom: 19, tileSize: 256, time: '', updateWhenZooming: false,
      attribution: 'Satellite IR: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a> (NOAA GOES, JMA Himawari)' },
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      tile.className = 'sat-tile';
      const n = 2 ** coords.z, xw = A.mod(coords.x, n);
      const lonW = (xw / n) * 360 - 180, lonE = ((xw + 1) / n) * 360 - 180;
      const srcs = SAT_SRC.filter((s) => lonDist((lonW + lonE) / 2, s.lon) <= 81 + (lonE - lonW) / 2);
      Promise.all(srcs.map((s) => loadImg(L.Util.template(SAT_URL, { layer: s.layer, time: this.options.time, z: coords.z, x: xw, y: coords.y })))).then((imgs) => {
        const N = 256 * 256, bt = new Float32Array(N).fill(NaN);
        const cv = document.createElement('canvas'); cv.width = cv.height = 256;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        const px = imgs.map((im) => { if (!im) return null; cx.clearRect(0, 0, 256, 256); cx.drawImage(im, 0, 0, 256, 256); try { return cx.getImageData(0, 0, 256, 256).data; } catch (e) { return null; } });
        // per column: sources ordered by viewing angle (nearest sub-satellite longitude first)
        for (let x = 0; x < 256; x++) {
          const lon = lonW + ((x + 0.5) / 256) * (lonE - lonW);
          const order = srcs.map((s, i) => [lonDist(lon, s.lon), i]).sort((a, b) => a[0] - b[0]).map((a) => a[1]);
          for (let y = 0; y < 256; y++) {
            const o = (y * 256 + x) * 4;
            for (const i of order) {
              const d = px[i];
              if (d && d[o + 3] > 128) {
                const r = d[o], g = d[o + 1], b = d[o + 2];
                bt[y * 256 + x] = r === g && g === b && COLD_GREY.has(g) ? (greyIsCold(d, x, y, g) ? COLD_GREY.get(g) : warmGrey(g)) : irTemp(r, g, b);
                break;
              }
            }
          }
        }
        tile._bt = medianBT(bt);
        tile._coords = coords;
        tile._sig = '';
        this._colour(tile);
        done(null, tile);
      });
      return tile;
    },
    _colour(tile) {
      if (!tile._bt) return;
      const tf = sfcTempField(), smooth = smoothMap(), night = isNight();
      const sig = `${tf ? tf.id : '-'}|${smooth}|${night}`;
      if (tile._sig === sig) return;
      tile._sig = sig;
      const { x, y, z } = tile._coords;
      const ctx = tile.getContext('2d'), img = ctx.createImageData(256, 256), d = img.data;
      const lut = []; for (let i = 0; i <= 100; i++) lut.push(shadeRgb(i / 100, false));
      const miss = shadeRgb(null, true);
      // fallback surface temperature when no forecast is loaded: the warmest 5 % of the tile
      let fallback = NaN;
      if (!tf) { const s = Array.from(tile._bt).filter(isFinite).sort((a, b) => a - b); if (s.length) fallback = s[Math.floor(s.length * 0.95)]; }
      for (let py = 0; py < 256; py += 4) {
        for (let px = 0; px < 256; px += 4) {
          const ts = tf ? sfcTempAt(tf, x * 256 + px + 2, y * 256 + py + 2, z) : fallback;
          for (let yy = py; yy < py + 4; yy++) {
            for (let xx = px; xx < px + 4; xx++) {
              const k = yy * 256 + xx, b = tile._bt[k], o = k * 4;
              let rgb;
              if (!isFinite(b) || !isFinite(ts)) rgb = miss;
              else {
                let q = 1 - irCloud(b, ts);
                if (!smooth) q = Math.round(q * 10) / 10;
                rgb = lut[Math.round(q * 100)];
              }
              d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    recolour() { Object.values(this._tiles || {}).forEach((t) => this._colour(t.el)); },
  });
  // 3×3 median of brightness temperature: removes isolated misreads from blended overview pixels
  function medianBT(bt) {
    const out = new Float32Array(bt.length), w = [];
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        w.length = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < 256 && xx >= 0 && xx < 256) { const v = bt[yy * 256 + xx]; if (isFinite(v)) w.push(v); }
        }
        if (!w.length || !isFinite(bt[y * 256 + x])) { out[y * 256 + x] = NaN; continue; }
        w.sort((a, b) => a - b);
        out[y * 256 + x] = w[w.length >> 1];
      }
    }
    return out;
  }
  const satLayer = new SatCloudLayer({ time: satTime(), opacity: 0.75 });
  setInterval(() => { if (map.hasLayer(satLayer)) { satLayer.options.time = satTime(); satLayer.redraw(); } }, 10 * 60000);

  const WX_KEYS = ['cloud', 'cloudLow', 'cloudMid', 'cloudHigh', 'trans', 'see', 'fog', 'wind', 'gust', 'temp', 'dew', 'rh'];
  const WX_NAMES = { cloud: 'Cloud cover', cloudLow: 'Low cloud', cloudMid: 'Mid cloud', cloudHigh: 'High cloud', trans: 'Transparency', see: 'Seeing', fog: 'Mist / fog', wind: 'Wind', gust: 'Gusts', temp: 'Temperature', dew: 'Dew point', rh: 'Humidity' };
  // keys: active forecast layers in the order they were switched on (last = top, carries value labels)
  const wx = { keys: [], layers: new Map(), vals: false, grid: null, labels: null, req: 0, manualTime: null, timer: 0, loading: false };
  // Opacity per overlay (0–1), default 50 %, remembered (and exported with the config)
  let layerOpacity = {};
  try { layerOpacity = JSON.parse(localStorage.getItem('astrosite.layerOpacity') || '{}') || {}; } catch (e) { layerOpacity = {}; }
  const opOf = (k) => (isFinite(layerOpacity[k]) ? layerOpacity[k] : 0.5);
  const saveOpacity = () => { try { localStorage.setItem('astrosite.layerOpacity', JSON.stringify(layerOpacity)); } catch (e) { /* ignore */ } };
  const wxActive = () => wx.keys.length > 0;
  try {
    const saved = JSON.parse(localStorage.getItem('astrosite.wxLayers') || 'null');
    const legacy = localStorage.getItem('astrosite.wxLayer');
    wx.keys = (Array.isArray(saved) ? saved : legacy ? [legacy] : []).filter((k) => WX_KEYS.includes(k));
    wx.vals = localStorage.getItem('astrosite.wxVals') === '1';
  } catch (e) { /* ignore */ }
  const saveWxKeys = () => { try { localStorage.setItem('astrosite.wxLayers', JSON.stringify(wx.keys)); localStorage.removeItem('astrosite.wxLayer'); } catch (e) { /* ignore */ } };

  const LayersControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar wx-ctl');
      let collapsed = false;
      try { collapsed = localStorage.getItem('astrosite.layersCollapsed') === '1'; } catch (e) { /* ignore */ }
      const row = (attr, k, label, title) => `<tr data-row="${k}"><td><button type="button" class="lyr" ${attr}="${k}" aria-pressed="false"${title ? ` title="${esc(title)}"` : ''}>${label}</button></td>
        <td><input type="range" min="0" max="100" value="${Math.round(opOf(k) * 100)}" data-op="${k}" aria-label="${esc(label)} opacity" title="Opacity"></td></tr>`;
      div.innerHTML = `
        <button type="button" class="lyr-title" aria-expanded="${!collapsed}">Layers <span class="chev" aria-hidden="true"></span></button>
        <div class="lyr-body${collapsed ? ' closed' : ''}"><div class="lyr-inner">
          <div class="base-row"><span>Base map</span><div class="seg base-seg" role="group" aria-label="Base map">${Object.keys(baseLayers).map((n) => `<button type="button" data-base="${n}" class="${n === currentBase ? 'on' : ''}">${n === 'Satellite' ? 'Sat' : n}</button>`).join('')}</div></div>
          <table class="lyr-table"><tbody>
            ${row('data-lyr', 'lp', 'Light pollution', 'Light Pollution Atlas 2025 (D. Lorenz)').replace('<tr ', '<tr class="lyr-lp" ')}
            <tr class="lyr-head"><td colspan="2">Forecast <span class="muted">· selected hour</span></td></tr>
            ${WX_KEYS.map((k) => row('data-wx', k, WX_NAMES[k], k === 'cloud' ? 'At the current hour this shows live satellite infrared imagery' : '')).join('')}
            <tr class="lyr-foot"><td colspan="2"><div class="lyr-foot-in"><label class="chk"><input type="checkbox" class="wx-vals" ${wx.vals ? 'checked' : ''}> Values on top layer</label><a href="${window.LightPollution.colorsUrl}" target="_blank" rel="noopener" title="Light-pollution colour key">LP key</a></div></td></tr>
          </tbody></table>
        </div></div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      const title = div.querySelector('.lyr-title'), body = div.querySelector('.lyr-body');
      title.addEventListener('click', () => {
        const open = body.classList.contains('closed');
        body.classList.toggle('closed', !open); title.setAttribute('aria-expanded', open);
        try { localStorage.setItem('astrosite.layersCollapsed', open ? '0' : '1'); } catch (e) { /* ignore */ }
      });
      div.querySelectorAll('[data-base]').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
      const lpBtn = div.querySelector('[data-lyr="lp"]');
      const setLp = (on) => {
        lpSetOn(on);
        lpBtn.setAttribute('aria-pressed', on);
        try { localStorage.setItem('astrosite.lpmap', on ? '1' : '0'); } catch (e) { /* ignore */ }
      };
      lpBtn.addEventListener('click', () => setLp(!map.hasLayer(lpLayer)));
      div.querySelectorAll('[data-wx]').forEach((b) => {
        b.setAttribute('aria-pressed', wx.keys.includes(b.dataset.wx));
        b.addEventListener('click', () => {
          const k = b.dataset.wx;
          if (wx.keys.includes(k)) { wx.keys = wx.keys.filter((x) => x !== k); removeWxLayer(k); }
          else wx.keys.push(k);
          b.setAttribute('aria-pressed', wx.keys.includes(k));
          saveWxKeys();
          scheduleWx(0);
        });
      });
      div.querySelectorAll('[data-op]').forEach((r) => r.addEventListener('input', () => {
        const k = r.dataset.op, o = r.value / 100;
        layerOpacity[k] = o;
        saveOpacity();
        if (k === 'lp') lpSetOpacity(o);
        else {
          const st = wx.layers.get(k);
          if (st && st.overlay) st.overlay.setOpacity(o);
          if (k === 'cloud') satLayer.setOpacity(o);
        }
      }));
      div.querySelector('.wx-vals').addEventListener('change', (e) => {
        wx.vals = e.target.checked;
        try { localStorage.setItem('astrosite.wxVals', wx.vals ? '1' : '0'); } catch (err) { /* ignore */ }
        renderWx();
      });
      // legacy single light-pollution opacity → per-layer table
      try {
        const legacy = localStorage.getItem('astrosite.lpopacity');
        if (legacy && !isFinite(layerOpacity.lp)) { layerOpacity.lp = legacy / 100; saveOpacity(); div.querySelector('[data-op="lp"]').value = legacy; }
      } catch (e) { /* ignore */ }
      lpSetOpacity(opOf('lp'));
      try { if (localStorage.getItem('astrosite.lpmap') === '1') setTimeout(() => setLp(true), 0); } catch (e) { /* ignore */ }
      syncLayerOptions();
      if (wxActive()) setTimeout(() => scheduleWx(0), 0);
      return div;
    },
  });
  // Rows switched off in the forecast table are removed from the map overlays (and turned off if showing)
  function syncLayerOptions() {
    const hidden = loadSet('astrosite.fcHidden');
    document.querySelectorAll('.lyr-table tr[data-row]').forEach((tr) => {
      const k = tr.dataset.row;
      if (!WX_KEYS.includes(k)) return;
      tr.hidden = hidden.has(k);
      if (hidden.has(k) && wx.keys.includes(k)) {
        wx.keys = wx.keys.filter((x) => x !== k);
        removeWxLayer(k);
        const b = tr.querySelector('[data-wx]'); if (b) b.setAttribute('aria-pressed', 'false');
        saveWxKeys();
        scheduleWx(0);
      }
    });
  }
  map.addControl(new LayersControl());

  // Caption with time stepping and legend
  const wxCap = document.createElement('div');
  wxCap.className = 'wx-caption'; wxCap.hidden = true;
  $('.map-wrap').appendChild(wxCap);
  wxCap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    const step = +b.dataset.step;
    if (state.fc && state.fcSel != null) selectHour(state.fcSel + step, !$('#tab-tonight').hidden);
    else { wx.manualTime = (wx.manualTime || floorHour(Date.now())) + step * 3600000; scheduleWx(0); }
  });

  const floorHour = (ms) => Math.floor(ms / 3600000) * 3600000;
  const isoHour = (ms) => new Date(ms).toISOString().slice(0, 13) + ':00';
  function wxTime() {
    if (state.fc && state.fcSel != null && state.fc.hours[state.fcSel]) return state.fc.hours[state.fcSel].t.getTime();
    return wx.manualTime || floorHour(Date.now());
  }
  const isNowHour = (t) => floorHour(t) === floorHour(Date.now());
  function scheduleWx(delay = 400) {
    clearTimeout(wx.timer);
    wx.timer = setTimeout(updateWx, delay);
  }
  map.on('moveend', () => { if (wxActive()) scheduleWx(600); });

  function viewCovered(pl) {
    if (!wx.grid) return false;
    const dense = !pl.om.length && !pl.needAq;
    const sp = latticeSp(dense);
    if (wx.grid.zoom !== map.getZoom() || wx.grid.sp !== sp || wx.grid.dense !== dense || !wx.grid.bounds.contains(map.getBounds())) return false;
    // Open-Meteo data for all active layers must have been requested for this grid
    return wx.grid.omSig === `${pl.om.join(',')}|${pl.needAq ? 1 : 0}`;
  }

  async function updateWx() {
    if (!wxActive()) { clearWx(); return; }
    const t = floorHour(wxTime());
    const id = ++wx.req;
    const pl = await wxPlan(t);
    if (id !== wx.req) return;
    wx.plan = pl;
    // (live satellite cloud cover also uses the grid: 2 m temperature is its clear-sky reference)
    if (viewCovered(pl) && wx.grid.times.includes(t)) {
      const have = wx.grid.gm && wx.grid.gm.get(t);
      if (!pl.model || (have && have.model === pl.model && pl.gm.every((v) => have.vals[v]))) { renderWx(); return; }
      wx.loading = true; renderCaption();
      const err = await fetchGm(wx.grid, pl, id);
      if (id !== wx.req) return;
      if (err) toast(`Some ECCC forecast data unavailable: ${err.message}`);
      wx.loading = false; renderWx();
      return;
    }
    wx.loading = true; renderCaption();
    try {
      const grid = await fetchWxGrid(t, pl, id);
      if (id !== wx.req) return;
      grid.omSig = `${pl.om.join(',')}|${pl.needAq ? 1 : 0}`;
      wx.grid = grid;
      if (grid.error && !grid.error.limit) toast(`Some forecast data unavailable: ${grid.error.message}`);
    } catch (err) {
      if (id === wx.req) { toast(`Forecast overlay unavailable: ${err.message}`); wx.grid = null; }
    } finally {
      if (id === wx.req) { wx.loading = false; renderWx(); }
    }
  }

  // Variables each map layer needs (only these are requested)
  const WX_VARS = {
    cloud: ['cloud_cover', 'temperature_2m'], cloudLow: ['cloud_cover_low'], cloudMid: ['cloud_cover_mid'], cloudHigh: ['cloud_cover_high'],
    trans: ['cloud_cover', 'cloud_cover_high', 'total_column_integrated_water_vapour', 'surface_pressure', 'dew_point_2m'],
    see: ['cloud_cover', 'wind_gusts_10m', 'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_500hPa', 'wind_direction_500hPa', 'wind_speed_300hPa', 'wind_direction_300hPa', 'wind_speed_200hPa'],
    fog: ['visibility', 'temperature_2m', 'dew_point_2m', 'wind_speed_10m'],
    wind: ['wind_speed_10m'], gust: ['wind_gusts_10m'], temp: ['temperature_2m'], dew: ['dew_point_2m', 'temperature_2m'], rh: ['relative_humidity_2m'],
  };
  const PT_TTL = 3 * 3600000;          // model output changes every few hours
  // 7-day windows: Open-Meteo charges the same for up to 14 days, so stepping through the week never refetches
  const WIN_DAYS = 7;
  // Aerosol (CAMS, ~0.4°) is fetched once per coarse cell and shared by every lattice point inside it
  const aqCell = (p) => `${(Math.round(p.lat / 0.4) * 0.4).toFixed(1)},${(Math.round(p.lon / 0.4) * 0.4).toFixed(1)}`;
  const aqEntry = (k) => ptEntry(`aq${k}`);
  const ptMem = new Map();
  function ptEntry(key) {
    if (ptMem.has(key)) return ptMem.get(key);
    const c = OM.cacheGet(`pt.${key}`, PT_TTL);
    const e = c && c.fresh ? c.data : null;
    if (e) ptMem.set(key, e);
    return e;
  }
  function ptSave(key, e) { e.at = Date.now(); ptMem.set(key, e); OM.cacheSet(`pt.${key}`, e); }

  // Lattice spacing in screen px, fixed per zoom so panning reuses points. Doubling keeps points nested across zooms.
  // Never finer than ~0.1° (model resolution) and never more than ~120 points per view.
  // When ECCC GeoMet serves every active layer the points cost nothing, so the lattice is much denser.
  function latticeSp(dense) {
    let sp = dense ? (mapQuality === 'high' ? 30 : 40) : (mapQuality === 'high' ? 120 : 160);
    const degPerPx = 360 / (256 * 2 ** map.getZoom());
    while (sp * degPerPx < 0.1) sp *= 2;
    const pb = map.getPixelBounds();
    const maxPts = dense ? 2500 : 120;
    while (((Math.ceil(pb.max.x / sp) - Math.floor(pb.min.x / sp) + 1) * (Math.ceil(pb.max.y / sp) - Math.floor(pb.min.y / sp) + 1)) > maxPts) sp *= 2;
    return sp;
  }

  /* ---- Direct model data from ECCC MSC GeoMet (RDPS 10 km / GDPS 15 km): one request per layer per hour ---- */
  const GM_MODEL_NAME = { RDPS: 'RDPS 10 km', GDPS: 'GDPS 15 km' };
  // CMC astronomy indices replace the derived seeing/transparency where RDPS covers the hour
  const GM_EXTRA = { see: ['cmc_seeing', 'cloud_cover'], trans: ['cmc_transparency', 'cloud_cover'] };
  function viewBox() {
    const b = map.getBounds();
    let w = b.getWest(), e = b.getEast();
    if (e - w >= 360) return null;
    const shift = Math.floor((w + 180) / 360) * 360; w -= shift; e -= shift;
    if (e > 180) return null; // view crosses the date line
    return { w, e, s: Math.max(-89, b.getSouth()), n: Math.min(89, b.getNorth()) };
  }
  // What GeoMet serves for hour t in this view, and what Open-Meteo still has to provide
  async function wxPlan(t) {
    const box = viewBox();
    let model = null;
    if (box) { try { model = await GeoMet.modelFor(t, box); } catch (e) { model = null; } }
    const gmVars = new Set(), omVars = new Set();
    wx.keys.forEach((k) => {
      if (model === 'RDPS' && GM_EXTRA[k]) { GM_EXTRA[k].forEach((v) => gmVars.add(v)); return; }
      (WX_VARS[k] || []).forEach((v) => (GeoMet.serves(model, v) ? gmVars : omVars).add(v));
    });
    const needAq = wx.keys.includes('trans') && !(model === 'RDPS');
    return { t, model: gmVars.size ? model : null, gm: [...gmVars].sort(), om: [...omVars].sort(), needAq, box };
  }
  const planSig = (pl) => `${pl.model || '-'}|${pl.gm.join(',')}|${pl.om.join(',')}|${pl.needAq ? 1 : 0}`;
  let gmNoted = false;
  async function fetchGm(g, pl, id) {
    if (!pl.model || !pl.gm.length) return null;
    g.gm = g.gm || new Map();
    const have = g.gm.get(pl.t);
    if (have && have.model === pl.model && pl.gm.every((v) => have.vals[v])) return null;
    const b = g.bounds;
    const spDeg = (g.sp * 360) / (256 * 2 ** g.zoom);
    const { box, res } = GeoMet.snapBox({ w: Math.max(-180, b.getWest()), e: Math.min(180, b.getEast()), s: b.getSouth(), n: b.getNorth() }, spDeg, pl.model);
    const entry = have && have.model === pl.model ? have : { model: pl.model, vals: {} };
    // brief settle time so stepping quickly through hours only fetches the hour that ends up shown
    if (id != null) { await new Promise((r) => setTimeout(r, 150)); if (id !== wx.req) return null; }
    let error = null;
    await Promise.all(pl.gm.filter((v) => !entry.vals[v]).map(async (v) => {
      try {
        const f = await GeoMet.field(pl.model, v, pl.t, box, res, () => id != null && id !== wx.req);
        const a = new Float32Array(g.pts.length);
        g.pts.forEach((p, i) => { a[i] = GeoMet.sample(f, p.lat, p.lon); });
        entry.vals[v] = a;
      } catch (err) { if (!/superseded/.test(err.message)) error = err; }
    }));
    if (id != null && id !== wx.req) return null;
    g.gm.set(pl.t, entry);
    g.cache = new Map(); // fields derived from points must be rebuilt
    if (!gmNoted) { gmNoted = true; map.attributionControl.addAttribution('Forecast fields: <a href="https://eccc-msc.github.io/open-data/msc-geomet/readme_en/" target="_blank" rel="noopener">ECCC MSC GeoMet</a> (RDPS/GDPS)'); }
    return error;
  }
  async function fetchWxGrid(t, pl, id) {
    const zoom = map.getZoom();
    const dense = !pl.om.length && !pl.needAq;
    const sp = latticeSp(dense);
    const pb = map.getPixelBounds();
    const c0 = Math.floor(pb.min.x / sp), c1 = Math.ceil(pb.max.x / sp), r0 = Math.floor(pb.min.y / sp), r1 = Math.ceil(pb.max.y / sp);
    const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
    const pts = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ll = map.unproject([c * sp, r * sp], zoom);
        const lat = Math.max(-85, Math.min(85, ll.lat)), lon = A.mod(ll.lng + 180, 360) - 180;
        pts.push({ lat, lon, r: r - r0, c: c - c0, i: pts.length, key: `${lat.toFixed(3)},${lon.toFixed(3)}` });
      }
    }
    const nw = map.unproject([(c0 - 0.5) * sp, (r0 - 0.5) * sp], zoom), se = map.unproject([(c1 + 0.5) * sp, (r1 + 0.5) * sp], zoom);
    const bounds = L.latLngBounds(se, nw);
    // Day-aligned windows (previous day → next day, UTC) so stepping hours, panning and reloads reuse cached data
    const DAY = 86400000;
    const start = Math.floor(t / DAY) * DAY - DAY, end = start + WIN_DAYS * DAY - 3600000;
    const times = []; for (let x = start; x <= end; x += 3600000) times.push(x);
    const need = pl.om;
    const needAq = pl.needAq;

    // Which points are missing which data?
    const covers = (e) => e && e.start <= start && e.end >= end;
    const groups = new Map();
    const aqMissing = [];
    pts.forEach((p) => {
      const e = ptEntry(p.key);
      const missing = covers(e) ? need.filter((v) => !(e.vars && e.vars[v])) : need;
      if (missing.length) {
        const sig = missing.join(',');
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(p);
      }
      if (needAq && !covers(aqEntry(aqCell(p)))) aqMissing.push({ key: aqCell(p), lat: +aqCell(p).split(',')[0], lon: +aqCell(p).split(',')[1] });
    });
    const unique = (list) => [...new Map(list.map((p) => [p.key, p])).values()];
    const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
    const win = `timezone=GMT&start_hour=${isoHour(start)}&end_hour=${isoHour(end)}`;
    let error = null;
    const jobs = [];
    groups.forEach((list, sig) => chunks(unique(list), 100).forEach((ch) => jobs.push(async () => {
      const vars = sig.split(',');
      const q = `latitude=${ch.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${ch.map((p) => p.lon.toFixed(3)).join(',')}&${win}&wind_speed_unit=ms&hourly=${vars.join(',')}`;
      const res = await OM.request('forecast', q, { locations: ch.length, vars: vars.length, days: WIN_DAYS });
      const arr = Array.isArray(res) ? res : [res];
      ch.forEach((p, i) => {
        const H = arr[i] && arr[i].hourly;
        if (!H) return;
        const t0 = Date.parse(`${H.time[0]}:00Z`), t1 = Date.parse(`${H.time[H.time.length - 1]}:00Z`);
        let e = ptEntry(p.key);
        if (!covers(e)) e = { start: t0, end: t1, vars: {}, aod: null };
        vars.forEach((v) => { if (H[v]) e.vars[v] = H[v]; });
        ptSave(p.key, e);
      });
    })));
    chunks(unique(aqMissing), 100).forEach((ch) => jobs.push(async () => {
      const q = `latitude=${ch.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${ch.map((p) => p.lon.toFixed(3)).join(',')}&${win}&hourly=aerosol_optical_depth`;
      const res = await OM.request('aq', q, { locations: ch.length, vars: 1, days: WIN_DAYS });
      const arr = Array.isArray(res) ? res : [res];
      ch.forEach((p, i) => {
        const H = arr[i] && arr[i].hourly;
        if (!H) return;
        ptSave(`aq${p.key}`, { start, end, v: H.aerosol_optical_depth });
      });
    }));
    for (const job of jobs) {
      try { await job(); } catch (err) { error = err; if (err.limit) break; }
    }
    const g = { pts, cols, rows, bounds, zoom, times, sp, c0, r0, error, dense };
    const gErr = await fetchGm(g, pl, id);
    if (gErr && !g.error) g.error = gErr;
    return g;
  }

  const GM_TO_H = { cloud_cover: 'cloud', temperature_2m: 'temp', dew_point_2m: 'dew', relative_humidity_2m: 'rh', wind_speed_10m: 'wind', wind_gusts_10m: 'gust', cmc_seeing: 'cmcSee', cmc_transparency: 'cmcTrans' };
  function wxHour(p, ti) {
    const t = wx.grid.times[ti];
    const gmT = wx.grid.gm && wx.grid.gm.get(t);
    const e = ptEntry(p.key) || (gmT ? { start: t, vars: {} } : null);
    if (!e) return null;
    const i = Math.round((t - e.start) / 3600000);
    const V = e.vars || {};
    const g = (k) => (V[k] && i >= 0 && i < V[k].length ? V[k][i] : null);
    const aq = aqEntry(aqCell(p));
    const ai = aq ? Math.round((t - aq.start) / 3600000) : -1;
    const h = {
      t: new Date(t), cloud: g('cloud_cover'), cloudLow: g('cloud_cover_low'), cloudMid: g('cloud_cover_mid'), cloudHigh: g('cloud_cover_high'),
      vis: g('visibility'), temp: g('temperature_2m'), dew: g('dew_point_2m'), rh: g('relative_humidity_2m'),
      wind: g('wind_speed_10m'), gust: g('wind_gusts_10m'), wdir: g('wind_direction_10m'), precip: null,
      pressure: g('surface_pressure'), tcwv: g('total_column_integrated_water_vapour'),
      ws850: g('wind_speed_850hPa'), wd850: g('wind_direction_850hPa'), ws500: g('wind_speed_500hPa'), wd500: g('wind_direction_500hPa'),
      ws300: g('wind_speed_300hPa'), wd300: g('wind_direction_300hPa'), ws200: g('wind_speed_200hPa'),
      aod: aq && ai >= 0 && ai < aq.v.length ? aq.v[ai] : null,
    };
    if (gmT) {
      h.src = gmT.model;
      Object.entries(gmT.vals).forEach(([v, a]) => { const x = a[p.i]; if (!Number.isNaN(x)) h[GM_TO_H[v]] = x; });
    }
    h.see = SM.seeing(h); h.trans = SM.transparency(h); h.fog = SM.fog(h); h.dewRisk = SM.dewRisk(h.fog.spread);
    return h;
  }

  function removeWxLayer(k) {
    markLayer(k, false);
    const st = wx.layers.get(k);
    if (st) { cancelAnimationFrame(st.anim || 0); if (st.overlay) map.removeLayer(st.overlay); wx.layers.delete(k); }
    if (k === 'cloud') map.removeLayer(satLayer);
  }
  function clearWx() {
    [...wx.layers.keys()].forEach(removeWxLayer);
    map.removeLayer(satLayer);
    if (wx.labels) { map.removeLayer(wx.labels); wx.labels = null; }
    wxCap.hidden = true;
  }

  function renderCaption() {
    if (!wxActive()) { wxCap.hidden = true; return; }
    const t = wxTime();
    const names = wx.keys.map((k) => (k === 'cloud' && isNowHour(t) ? 'Cloud cover (live satellite)' : WX_NAMES[k]));
    const bar = [0, 0.25, 0.5, 0.75, 1].map((q) => `<i style="background:${shade(q, false).bg}"></i>`).join('');
    const pl = wx.plan && wx.plan.t === floorHour(t) ? wx.plan : null;
    const srcNote = pl && pl.model
      ? `<span class="src-note" title="${esc(`Model fields fetched directly from ECCC MSC GeoMet (${GM_MODEL_NAME[pl.model]})${pl.om.length ? `; ${pl.om.join(', ')} from Open-Meteo` : ''}`)}">${esc(`ECCC ${GM_MODEL_NAME[pl.model]}${pl.om.length || pl.needAq ? ' + Open-Meteo' : ''}`)}</span>`
      : '<span class="src-note" title="Forecast from Open-Meteo">Open-Meteo</span>';
    wxCap.innerHTML = `<button data-step="-1" title="Previous hour" aria-label="Previous hour">◀</button>
      <span><b>${esc(names.join(' + '))}</b> · ${esc(state.tz ? `${fmtDay(new Date(t))} ${fmtTime(new Date(t))}` : localTime(new Date(t)))} · ${srcNote}${wx.loading ? ' · loading…' : ''}${OM.limited() ? ` · <span class="lim-note" title="Free Open-Meteo hourly limit reached; showing cached data">limit — cached until ${esc(new Date(OM.cooldownUntil()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>` : ''}</span>
      <button data-step="1" title="Next hour" aria-label="Next hour">▶</button>
      <span class="scale" title="worse → better">${bar}</span>`;
    wxCap.hidden = false;
  }

  function rowDefsSafe() {
    // rowDefs builds source links from the site; use a neutral location when none is selected
    if (state.lat != null) return rowDefs();
    const saved = [state.lat, state.lon];
    state.lat = 0; state.lon = 0;
    try { return rowDefs(); } finally { [state.lat, state.lon] = saved; }
  }

  // Canvas-backed image overlay: we draw frames straight into the element (no image re-encoding)
  const CanvasOverlay = L.ImageOverlay.extend({
    _initImage() {
      const c = this._image = this._canvas;
      L.DomUtil.addClass(c, 'leaflet-image-layer');
      if (this._zoomAnimated) L.DomUtil.addClass(c, 'leaflet-zoom-animated');
      if (this.options.className) L.DomUtil.addClass(c, this.options.className);
      c.onselectstart = L.Util.falseFn;
      c.onmousemove = L.Util.falseFn;
    },
  });

  // CMC astronomy indices (RDPS): seeing 1 (> 4″) … 5 (< 0.4″), transparency 1 (poor) … 5 (excellent); 0 = too cloudy to rate
  const CMC_SEE = ['Too cloudy to rate', 'Bad (> 4″)', 'Poor (2–4″)', 'Average (1–2″)', 'Good (0.4–1″)', 'Excellent (< 0.4″)'];
  const CMC_TRANS = ['Too cloudy to rate', 'Poor', 'Below average', 'Average', 'Above average', 'Excellent'];
  function mapCell(def, h) {
    const idx = def.key === 'see' ? h.cmcSee : def.key === 'trans' ? h.cmcTrans : null;
    if (idx == null || !isFinite(idx)) return def.cell(h);
    const i = Math.max(0, Math.min(5, Math.round(idx)));
    const names = def.key === 'see' ? CMC_SEE : CMC_TRANS;
    return { q: i ? (i - 1) / 4 : 0, txt: i ? String(i) : '☁', tip: `${i}/5 — ${names[i]} (CMC ${def.key === 'see' ? 'seeing' : 'sky transparency'} index, RDPS)` };
  }

  // Values for every grid point at one forecast hour (cached per layer/units/theme)
  function wxField(ti, def) {
    const g = wx.grid;
    const key = `${def.key}|${ti}|${state.units}|${isNight() ? 'n' : 'd'}`;
    g.cache = g.cache || new Map();
    if (g.cache.has(key)) return g.cache.get(key);
    const n = g.pts.length;
    const f = { q: new Float32Array(n), lim: new Uint8Array(n), nd: new Uint8Array(n), labels: [] };
    g.pts.forEach((p, k) => {
      const h = wxHour(p, ti);
      const c = h ? mapCell(def, h) : { nodata: true };
      if (c.nodata || c.q == null) { f.nd[k] = 1; f.q[k] = 0.5; } else f.q[k] = c.q;
      f.lim[k] = c.lim ? 1 : 0;
      if (!c.nodata) f.labels.push({ p, html: c.html || esc(c.txt || '') });
    });
    g.cache.set(key, f);
    return f;
  }

  const crs = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

  // Paint a field (q / lim / nodata per grid point) into the overlay canvas
  function paintField(cv, f) {
    const g = wx.grid;
    const ctx = cv.getContext('2d');
    if (mapQuality !== 'high') {
      const img = ctx.createImageData(g.cols, g.rows);
      for (let k = 0; k < g.pts.length; k++) {
        const p = g.pts[k];
        const rgb = f.nd[k] ? shadeRgb(null, true) : shadeRgb(f.q[k], f.lim[k]);
        const o = (p.r * g.cols + p.c) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return;
    }
    const S = 10, W = cv.width, H = cv.height;
    const img = ctx.createImageData(W, H);
    const qAt = (r, c) => f.q[Math.max(0, Math.min(g.rows - 1, r)) * g.cols + Math.max(0, Math.min(g.cols - 1, c))];
    const smooth = smoothMap();
    // colour lookup table over q (fast per-pixel colouring)
    const LUT = 256, lutN = [], lutL = shadeRgb(null, true);
    for (let i = 0; i < LUT; i++) lutN.push(shadeRgb(i / (LUT - 1), false));
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / S - 0.5, r1 = Math.floor(fy), ty = fy - r1;
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / S - 0.5, c1 = Math.floor(fx), tx = fx - c1;
        const v0 = crs(qAt(r1 - 1, c1 - 1), qAt(r1 - 1, c1), qAt(r1 - 1, c1 + 1), qAt(r1 - 1, c1 + 2), tx);
        const v1 = crs(qAt(r1, c1 - 1), qAt(r1, c1), qAt(r1, c1 + 1), qAt(r1, c1 + 2), tx);
        const v2 = crs(qAt(r1 + 1, c1 - 1), qAt(r1 + 1, c1), qAt(r1 + 1, c1 + 1), qAt(r1 + 1, c1 + 2), tx);
        const v3 = crs(qAt(r1 + 2, c1 - 1), qAt(r1 + 2, c1), qAt(r1 + 2, c1 + 1), qAt(r1 + 2, c1 + 2), tx);
        let q = Math.max(0, Math.min(1, crs(v0, v1, v2, v3, ty)));
        if (!smooth) q = Math.round(q * 10) / 10; // stepped colour bands
        const nk = Math.max(0, Math.min(g.rows - 1, Math.round(fy))) * g.cols + Math.max(0, Math.min(g.cols - 1, Math.round(fx)));
        const rgb = f.nd[nk] || f.lim[nk] ? lutL : lutN[Math.round(q * (LUT - 1))];
        const o = (y * W + x) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function ensureOverlay(k, z) {
    const g = wx.grid;
    const hq = mapQuality === 'high';
    const W = hq ? g.cols * 10 : g.cols, H = hq ? g.rows * 10 : g.rows;
    let st = wx.layers.get(k);
    if (!st) { st = {}; wx.layers.set(k, st); }
    if (st.overlay && (st.overlay._canvas.width !== W || st.overlay._canvas.height !== H)) { map.removeLayer(st.overlay); st.overlay = null; }
    if (!st.overlay) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ov = new CanvasOverlay('', g.bounds, { pane: 'wxPane', opacity: opOf(k), className: 'wx-img', interactive: false });
      ov._canvas = cv;
      st.overlay = ov.addTo(map);
    } else {
      st.overlay.setBounds(g.bounds);
      st.overlay.setOpacity(opOf(k));
      if (!map.hasLayer(st.overlay)) st.overlay.addTo(map);
    }
    st.overlay._canvas.style.zIndex = String(z);
    return st;
  }

  function drawLabels(f) {
    if (wx.labels) { map.removeLayer(wx.labels); wx.labels = null; }
    if (!wx.vals || !f) return;
    wx.labels = L.layerGroup(f.labels.map(({ p, html }) => L.marker([p.lat, p.lon], {
      pane: 'wxPane', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'wx-lbl', html: `<span>${html}</span>`, iconSize: [36, 16], iconAnchor: [18, 8] }),
    }))).addTo(map);
  }

  // Button state: red when the layer has no data at all for this view and hour
  function markLayer(k, missing) {
    const b = document.querySelector(`.wx-ctl [data-wx="${k}"]`);
    if (b) { b.classList.toggle('nodata', !!missing); b.title = missing ? `${WX_NAMES[k]}: no data for this area and hour` : (k === 'cloud' ? 'At the current hour this shows live satellite infrared imagery' : ''); }
  }
  function emptyField() {
    const n = wx.grid ? wx.grid.pts.length : 0;
    return { q: new Float32Array(n).fill(0.5), lim: new Uint8Array(n), nd: new Uint8Array(n).fill(1), labels: [] };
  }
  function paintMissing(k, z) {
    if (!wx.grid) { markLayer(k, true); return; }
    const st = ensureOverlay(k, z);
    cancelAnimationFrame(st.anim || 0);
    paintField(st.overlay._canvas, emptyField());
    st.shown = null;
    markLayer(k, true);
  }

  function renderOneLayer(k, z, t, isTop) {
    const g = wx.grid;
    const st0 = wx.layers.get(k);
    // Cloud cover at the current hour: live satellite infrared instead of the forecast
    if (k === 'cloud' && isNowHour(t)) {
      if (st0) { cancelAnimationFrame(st0.anim || 0); if (st0.overlay) map.removeLayer(st0.overlay); st0.shown = null; }
      if (!map.hasLayer(satLayer)) { satLayer.options.time = satTime(); satLayer.setOpacity(opOf('cloud')); satLayer.addTo(map); } else satLayer.recolour();
      if (isTop) drawLabels(null);
      markLayer(k, false);
      return;
    }
    if (k === 'cloud') map.removeLayer(satLayer);
    if (!g) {
      if (!wx.loading) {
        // no data at all (request failed): clear any stale picture and flag the layer
        const st = wx.layers.get(k);
        if (st && st.overlay) { cancelAnimationFrame(st.anim || 0); map.removeLayer(st.overlay); st.overlay = null; st.shown = null; }
        markLayer(k, true);
      }
      return;
    }
    const ti = g.times.indexOf(t);
    if (ti < 0) { paintMissing(k, z); if (isTop) drawLabels(null); return; }
    const def = rowDefsSafe().find((r) => r.key === k);
    const st = ensureOverlay(k, z);
    const cv = st.overlay._canvas;
    cancelAnimationFrame(st.anim || 0);
    const from = st.shown;
    const fi = from != null && st.shownGrid === g ? g.times.indexOf(from) : -1;
    const hours = Math.abs(ti - fi);
    // GeoMet fields are fetched per hour, so those layers blend straight from the shown hour to the new one
    const pl = wx.plan;
    const gmLayer = !!(g.gm && g.gm.get(t) && pl && pl.model && ((pl.model === 'RDPS' && GM_EXTRA[k]) || (WX_VARS[k] || []).some((v) => pl.gm.includes(v))));
    if (mapQuality === 'high' && fi >= 0 && hours > 0 && hours <= 48) {
      // Progress the field through every hour between the two times, blending between consecutive hours
      const duration = gmLayer ? 450 : Math.min(2400, 300 + 140 * hours);
      const dir = ti > fi ? 1 : -1;
      const t0 = performance.now();
      const n = g.pts.length;
      const mix = { q: new Float32Array(n), lim: new Uint8Array(n), nd: new Uint8Array(n), labels: [] };
      if (isTop && wx.labels) { map.removeLayer(wx.labels); wx.labels = null; }
      const step = (now) => {
        const pr = Math.min(1, (now - t0) / duration);
        const e = pr < 0.5 ? 2 * pr * pr : 1 - Math.pow(-2 * pr + 2, 2) / 2; // ease in-out
        const pos = fi + dir * e * hours;
        let a = Math.floor(pos), fr = pos - a, fa, fb;
        if (gmLayer) { fa = wxField(fi, def); fb = wxField(ti, def); fr = e; } else {
          fa = wxField(Math.max(0, Math.min(g.times.length - 1, a)), def);
          fb = wxField(Math.max(0, Math.min(g.times.length - 1, a + 1)), def);
        }
        for (let i = 0; i < n; i++) {
          mix.q[i] = fa.q[i] + (fb.q[i] - fa.q[i]) * fr;
          mix.lim[i] = fr < 0.5 ? fa.lim[i] : fb.lim[i];
          mix.nd[i] = fr < 0.5 ? fa.nd[i] : fb.nd[i];
        }
        paintField(cv, mix);
        if (pr < 1) st.anim = requestAnimationFrame(step);
        else { const f = wxField(ti, def); paintField(cv, f); if (isTop) drawLabels(f); }
      };
      st.anim = requestAnimationFrame(step);
    } else {
      const f = wxField(ti, def);
      paintField(cv, f);
      if (isTop) drawLabels(f);
    }
    const fin = wxField(ti, def);
    markLayer(k, fin.nd.every((v) => v === 1));
    st.shown = t; st.shownGrid = g;
  }

  function renderWx() {
    if (!wxActive()) { clearWx(); return; }
    renderCaption();
    const t = floorHour(wxTime());
    [...wx.layers.keys()].forEach((k) => { if (!wx.keys.includes(k)) removeWxLayer(k); });
    wx.keys.forEach((k, i) => renderOneLayer(k, i + 1, t, i === wx.keys.length - 1));
  }

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
        elev: s.elev != null && isFinite(s.elev) && /GPS/.test(s.elevSource || '') ? s.elev : null, elevSource: s.elevSource,
      });
      return true;
    } catch (e) { return false; }
  }
  try {
    if (localStorage.getItem('astrosite.units') === 'imperial') state.units = 'imperial';
    if (localStorage.getItem('astrosite.fcvals') === '0') state.showVals = false;
  } catch (e) { /* ignore */ }

  renderAll();
  let startTab = 'coords';
  try { startTab = localStorage.getItem('astrosite.tab') || (favs.length ? 'home' : 'coords'); } catch (e) { /* ignore */ }
  activateTab(startTab, { instant: true });
  if (!readHash() && !restoreLast()) {
    setTimeout(() => input.focus(), 50);
  }
})();
