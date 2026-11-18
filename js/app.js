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
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
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
  const LPControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar lp-ctl');
      div.innerHTML = `<button type="button" class="lp-toggle" aria-pressed="false" title="Toggle light-pollution map">Light pollution</button>
        <div class="lp-extra" hidden><input type="range" min="10" max="100" value="50" aria-label="Overlay opacity"><a href="${window.LightPollution.colorsUrl}" target="_blank" rel="noopener">key</a></div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      const btn = div.querySelector('.lp-toggle');
      const extra = div.querySelector('.lp-extra');
      const range = div.querySelector('input');
      const set = (on) => {
        if (on) lpLayer.addTo(map); else map.removeLayer(lpLayer);
        btn.setAttribute('aria-pressed', on); extra.hidden = !on;
        try { localStorage.setItem('astrosite.lpmap', on ? '1' : '0'); } catch (e) { /* ignore */ }
      };
      btn.addEventListener('click', () => set(!map.hasLayer(lpLayer)));
      range.addEventListener('input', () => {
        lpLayer.setOpacity(range.value / 100);
        try { localStorage.setItem('astrosite.lpopacity', range.value); } catch (e) { /* ignore */ }
      });
      try {
        const op = localStorage.getItem('astrosite.lpopacity');
        if (op) { range.value = op; lpLayer.setOpacity(op / 100); }
        if (localStorage.getItem('astrosite.lpmap') === '1') setTimeout(() => set(true), 0);
      } catch (e) { /* ignore */ }
      return div;
    },
  });
  map.addControl(new LPControl());
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
        state.elev = 0; state.elevSource = 'unavailable';
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

  function renderHead() {
    const nameEl = $('#siteName');
    if (document.activeElement !== nameEl) nameEl.value = state.name || '';
    $('#siteSub').textContent = state.lat == null ? 'Search, click the map, or use your location to begin' : (state.sub || `${fixed(state.lat, 5)}, ${fixed(state.lon, 5)}`);
    $('#elevInput').textContent = state.elev == null ? '…' : Math.round(state.elev);
    $('#elevSrc').textContent = state.elevSource === 'loading' ? 'looking up…' : state.elevSource;
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
        <table class="vals"><tbody>${g.rows.map((r) => rowHtml(r)).join('')}</tbody></table>
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
        <div class="where">${esc(p.where)}</div>
        ${p.rows ? `<table class="vals"><tbody>${p.rows.map(([key, field]) => `<tr><td class="k">${esc(FM[key].label)}${field ? `<code class="field" title="Field / keyword name in ${esc(p.name)}">${esc(field)}</code>` : ''}</td><td class="v" title="Click to copy">${esc(FM[key].v)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${p.snippet ? `<pre class="snip" title="Click to copy">${esc(p.snippet)}</pre>` : ''}
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
  function shade(q, limited) {
    const night = isNight();
    if (limited) return night ? { bg: '#ff1f1f', fg: '#000' } : { bg: '#b3261e', fg: '#fff' };
    if (q == null || !isFinite(q)) return null;
    q = Math.max(0, Math.min(1, q));
    if (night) {
      // monochrome red: worse = brighter red, better = darker (keeps "darker is better")
      const L = 46 - q * 42; // 46% → 4%
      return { bg: `hsl(0 100% ${L}%)`, fg: L > 26 ? '#000' : '#ffa0a0' };
    }
    const L = 88 - q * 70; // 88% (worst, near white) → 18% (best)
    const S = 25 + q * 50;
    return { bg: `hsl(216 ${S}% ${L}%)`, fg: L < 55 ? '#eef3ff' : '#0b1220' };
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
  function csWrap(id, title, body) {
    const c = collapsedSecs.has(id);
    return `<section class="cs${c ? ' collapsed' : ''}" data-sec="${id}">
      <h5 class="sec cs-head" tabindex="0" role="button" aria-expanded="${!c}"><span class="chev" aria-hidden="true"></span>${title}</h5>
      <div class="cs-body"><div class="cs-inner">${body}</div></div></section>`;
  }
  function toggleSection(head) {
    const sec = head.closest('.cs');
    const id = sec.dataset.sec;
    const nowCollapsed = !sec.classList.contains('collapsed');
    sec.classList.toggle('collapsed', nowCollapsed);
    head.setAttribute('aria-expanded', !nowCollapsed);
    if (nowCollapsed) collapsedSecs.add(id); else collapsedSecs.delete(id);
    saveSet('astrosite.collapsed', collapsedSecs);
  }
  $('#tonight').addEventListener('click', (e) => { const h = e.target.closest('.cs-head'); if (h) toggleSection(h); });
  $('#tonight').addEventListener('keydown', (e) => {
    const h = e.target.closest('.cs-head');
    if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSection(h); }
  });

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

    let html = `<table class="fc${state.showVals ? '' : ' novals'}"><thead>`;
    html += `<tr class="fc-days"><th class="fc-lbl" colspan="2"></th>${dayGroups.map((g) => `<th colspan="${g.n}" class="fc-day${ds(g.start)}"><span class="dl">${g.n >= 3 ? esc(g.lbl) : ''}</span></th>`).join('')}</tr>`;
    html += `<tr class="fc-hours"><th class="fc-lbl" colspan="2">Hour <span class="muted">(${esc(state.tz || 'local')})</span></th>${hours.map((h, i) => {
      const dark = h.sunAlt <= -18 ? 'd4' : h.sunAlt <= -12 ? 'd3' : h.sunAlt <= -6 ? 'd2' : h.sunAlt <= 0 ? 'd1' : 'd0';
      return `<th data-c="${i}" class="${dark}${ds(i)}">${fmtHour(h.t)}</th>`;
    }).join('')}</tr></thead><tbody>`;
    let lastGroup = '';
    rows.forEach((r) => {
      if (r.group !== lastGroup) {
        html += `<tr class="fc-group"><th class="fc-lbl" colspan="2">${esc(r.group)}</th><td colspan="${hours.length}"></td></tr>`;
        lastGroup = r.group;
      }
      const unit = r.key === 'wind' || r.key === 'gust' ? U.windU() : r.key === 'temp' || r.key === 'dew' ? U.tempU() : r.key === 'fog' ? U.visU() : '';
      const sub = [r.sub, unit].filter(Boolean).join(' · ');
      const off = fcHidden.has(r.key);
      const chk = state.fcEdit ? `<input type="checkbox" class="rowchk" data-row="${r.key}" ${off ? '' : 'checked'} aria-label="Show ${esc(r.label)}">` : '';
      html += `<tr class="fc-row${off ? ' off' : ''}" data-row="${r.key}"><th class="fc-lbl">${chk}<a href="${esc(r.src())}" target="_blank" rel="noopener" title="Open the data source for ${esc(r.label)} in a new tab">${esc(r.label)}</a></th><th class="fc-sub">${esc(sub)}</th>`;
      hours.forEach((h, i) => {
        const c = r.cell(h);
        const when = `${fmtDay(h.t)} ${fmtTime(h.t)}`;
        if (c.nodata) {
          const nd = shade(null, true);
          html += `<td data-c="${i}" class="nd${ds(i)}" style="background:${nd.bg};color:${nd.fg}" data-tip="${esc(`${r.label} · ${when}\nNo data for this hour`)}">–</td>`;
          return;
        }
        const col = shade(c.q, c.lim);
        const cls = [c.mark ? (c.warn2 ? 'mk2' : 'mk') : '', c.lim ? 'lim' : '', dayStart.has(i) ? 'ds' : ''].filter(Boolean).join(' ');
        const style = col ? ` style="background:${col.bg};color:${col.fg}"` : '';
        const tip = `${r.label} · ${when}\n${c.tip || c.txt || ''}${c.lim ? '\nLimited data — an input is missing or estimated' : ''}`;
        html += `<td data-c="${i}"${cls ? ` class="${cls}"` : ''}${style} data-tip="${esc(tip)}">${c.html || esc(c.txt || '')}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

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
        <div class="seg" role="group" aria-label="Units">
          <button data-units="metric" class="${state.units === 'metric' ? 'on' : ''}">Metric</button>
          <button data-units="imperial" class="${state.units === 'imperial' ? 'on' : ''}">Imperial</button>
        </div>
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
      <div class="fc-scroll" tabindex="0" aria-label="Hourly forecast grid; use arrow keys to move between hours">${html}</div>

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
      <details class="fc-about">
        <summary>About these forecasts</summary>
        <p><b>Cloud cover</b> (total and low / mid / high layers), <b>visibility</b>, <b>wind</b>, <b>temperature</b>, <b>dew point</b> and <b>humidity</b> come straight from the Open-Meteo best-match weather models (14 days). Long-range hours come from coarser global models, so treat days 8–14 as a trend.</p>
        <p><b>Transparency</b> follows Astrospheric's scale: index 0–5 excellent, 6–9 above average, 10–13 average, 14–23 below average, 24–27 poor, above 27 cloudy. It's estimated here from precipitable water vapour, CAMS aerosol optical depth (smoke, dust, haze), high-cloud fraction and surface pressure (elevation).</p>
        <p><b>Seeing</b> is an estimate in arcseconds from jet-stream speed (300 / 200 hPa), vertical wind shear between 850, 500 and 300 hPa, and surface gusts. Ratings: excellent &lt;1.4″, above average &lt;1.9″, average &lt;2.6″, below average &lt;3.4″, poor beyond that. Values are shown even under cloud; the tooltip notes when the sky is cloudy (≥ ${SM.CLOUDY}%).</p>
        <p><b>Mist / fog</b> uses forecast visibility: under 1 km is fog, 1–5 km is mist. An orange mark means radiation fog or heavy dew is likely (temperature within 2 °C of the dew point; amber within 4 °C).</p>
        <p><b>Colours</b> are generated per value: each row converts its value to a 0–1 quality score with a fixed formula, and that score sets the lightness of a single blue (darker = better). <b>Solid red</b> marks an hour whose value is missing or relies on an estimated input, for example typical aerosol levels beyond the aerosol forecast range. Hover over any cell for its exact value; click a row label to open its data source.</p>
      </details>
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
    scroller.addEventListener('change', (e) => {
      const cb = e.target.closest('input.rowchk');
      if (!cb) return;
      const set = loadSet('astrosite.fcHidden');
      if (cb.checked) set.delete(cb.dataset.row); else set.add(cb.dataset.row);
      saveSet('astrosite.fcHidden', set);
      cb.closest('tr').classList.toggle('off', !cb.checked);
      placeMarkers(state.fcSel);
    });
    $('#fcVals', box).addEventListener('change', (e) => {
      state.showVals = e.target.checked;
      try { localStorage.setItem('astrosite.fcvals', state.showVals ? '1' : '0'); } catch (err) { /* ignore */ }
      $('table.fc', box).classList.toggle('novals', !state.showVals);
    });
    let tipEl = $('#fcTip');
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.id = 'fcTip'; tipEl.className = 'fc-tip'; tipEl.hidden = true; document.body.appendChild(tipEl); }
    const moveTip = (e) => {
      const pad = 14;
      let x = e.clientX + pad, y = e.clientY + pad;
      const r = tipEl.getBoundingClientRect();
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
      tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
    };
    scroller.addEventListener('mouseover', (e) => {
      const td = e.target.closest('td[data-tip]');
      if (!td) { tipEl.hidden = true; return; }
      const [head, ...rest] = td.dataset.tip.split('\n');
      tipEl.innerHTML = `<b>${esc(head)}</b>${rest.map((l) => `<div>${esc(l)}</div>`).join('')}`;
      tipEl.hidden = false;
      moveTip(e);
    });
    scroller.addEventListener('mousemove', (e) => { if (!tipEl.hidden) moveTip(e); });
    scroller.addEventListener('mouseleave', () => { tipEl.hidden = true; });
    scroller.addEventListener('scroll', () => { tipEl.hidden = true; });
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

  // One frame around the whole selected column, and a yellow "now" bar, drawn as overlays in the scroller
  function placeMarkers(i) {
    const box = $('#tonight');
    const scroller = $('.fc-scroll', box);
    if (!scroller) return;
    const table = $('table.fc', scroller);
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

  function updateFavStar() {
    const star = $('#favToggle');
    if (!star) return;
    star.hidden = state.lat == null;
    const on = currentFavIdx() >= 0;
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', on);
    star.title = on ? 'Remove from saved locations' : 'Save this location';
    $('#favCount').textContent = favs.length ? favs.length : '';
  }

  function renderFavs() {
    const ul = $('#favsList');
    if (!favs.length) {
      ul.innerHTML = '<li class="empty">No saved locations yet. Pick a site and press ☆ next to its name.</li>';
      return;
    }
    ul.innerHTML = favs.map((f, i) => `<li data-i="${i}"${state.lat != null && sameSpot(f, state) ? ' class="cur"' : ''}>
        <button class="go" data-i="${i}"><span class="fn">${esc(f.name || 'Unnamed site')}</span>
          <span class="fs">${(+f.lat).toFixed(5)}, ${(+f.lon).toFixed(5)}${f.elev != null ? ` · ${Math.round(f.elev)} m` : ''}${f.bortle ? ` · Bortle ~${esc(f.bortle)}` : ''}</span></button>
        <button class="rm" data-rm="${i}" title="Remove" aria-label="Remove ${esc(f.name || 'site')}">×</button>
      </li>`).join('');
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
    saveFavs(); updateFavStar(); renderFavs();
  });

  const favsBtn = $('#favsBtn'), favsPop = $('#favsPop');
  favsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = favsPop.hidden;
    favsPop.hidden = !open;
    favsBtn.setAttribute('aria-expanded', open);
    if (open) renderFavs();
  });
  document.addEventListener('click', (e) => { if (!favsPop.hidden && !e.target.closest('.favs-wrap')) { favsPop.hidden = true; favsBtn.setAttribute('aria-expanded', false); } });
  $('#favsList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const f = favs[+rm.dataset.rm];
      favs.splice(+rm.dataset.rm, 1); saveFavs(); renderFavs(); updateFavStar();
      toast(`Removed “${f.name || 'site'}”`);
      return;
    }
    const go = e.target.closest('.go');
    if (!go) return;
    const f = favs[+go.dataset.i];
    favsPop.hidden = true;
    setLocation(f.lat, f.lon, {
      name: f.name, zoom: 12,
      elev: /GPS/.test(f.elevSource || '') ? f.elev : null, elevSource: f.elevSource,
    });
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
      saveFavs(); renderFavs(); updateFavStar();
      toast(`Imported ${added} location${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (duplicates or invalid)` : ''}`);
    } catch (err) {
      toast(`Couldn't import: ${err.message}`);
    }
  });

  /* ---------------- Settings backup: everything the browser remembers ---------------- */
  const CFG_PREFIX = 'astrosite.';
  const cfgBtn = $('#cfgBtn'), cfgPop = $('#cfgPop');
  cfgBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = cfgPop.hidden;
    cfgPop.hidden = !open;
    cfgBtn.setAttribute('aria-expanded', open);
    if (open) {
      const n = Object.keys(localStorage).filter((k) => k.startsWith(CFG_PREFIX)).length;
      $('#cfgCount').textContent = `${n} stored`;
    }
  });
  document.addEventListener('click', (e) => { if (!cfgPop.hidden && !e.target.closest('.cfg-wrap')) { cfgPop.hidden = true; cfgBtn.setAttribute('aria-expanded', false); } });
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

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    if (t.classList.contains('active')) return;
    $$('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    $$('.tab-body').forEach((b) => { b.hidden = b.id !== `tab-${t.dataset.tab}`; });
    if (t.dataset.tab === 'tonight') renderTonight();
    animateIn($(`#tab-${t.dataset.tab}`));
    moveInk();
  }));
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
  if (!readHash() && !restoreLast()) {
    setTimeout(() => input.focus(), 50);
  }
})();
