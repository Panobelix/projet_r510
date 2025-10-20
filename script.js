const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
});
const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: '© Esri & contributors'
});
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17,
  attribution: '© OpenTopoMap'
});

const map = L.map('map', {
  center: [-14.2350, -51.9253],
  zoom: 4,
  layers: [sat]
});
L.control.layers({ 'OpenStreetMap': osm, 'Satellite': sat, 'Topographique': topo }).addTo(map);

// ✅ featureGroup pour pouvoir utiliser getBounds()
const markers = L.featureGroup().addTo(map);

const statusDiv = document.getElementById('requete');
const loadingOverlay = document.getElementById('loading-overlay');
const btnCorr = document.getElementById('btn-correlation');

// Affiche l'overlay de chargement en ajoutant la classe 'active'.
const showLoader = () => loadingOverlay && loadingOverlay.classList.add('active');
// Cache l'overlay de chargement en retirant la classe 'active'.
const hideLoader = () => loadingOverlay && loadingOverlay.classList.remove('active');
// Text status initial
if (statusDiv) statusDiv.textContent = 'Sélectionnez un filtre taxonomique pour afficher la carte.';

// Utilitaire : ajuste les bounds seulement si on a des couches
function safeFitBounds(featureGroup, padding = 0.2) {
  const layers = featureGroup.getLayers();
  if (!layers || layers.length === 0) return false;
  try {
    map.fitBounds(featureGroup.getBounds().pad(padding));
    return true;
  } catch (e) {
    console.warn('safeFitBounds erreur:', e);
    return false;
  }
}

// --------- Panneau taxonomique (sélection hiérarchique) ---------
const selects = {
  kingdom: document.getElementById('select-kingdom'),
  phylum: document.getElementById('select-phylum'),
  class: document.getElementById('select-class'),
  order: document.getElementById('select-order'),
  family: document.getElementById('select-family'),
  genus: document.getElementById('select-genus'),
  species: document.getElementById('select-species'),
  scientificName: document.getElementById('select-scientificName'),
};
const levels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];

function resetBelow(level) {
  const idx = levels.indexOf(level);
  for (let i = idx + 1; i < levels.length; i++) {
    const s = selects[levels[i]];
    if (!s) continue;
    s.innerHTML = '<option value="">—</option>';
    s.disabled = true;
  }
}

function populateSelect(el, values) {
  if (!el) return;
  el.innerHTML = '<option value="">—</option>' + values.map(v => `<option value="${String(v).replaceAll('"','&quot;')}">${v}</option>`).join('');
  el.disabled = false;
}

async function fetchTaxValues(level, currentFilters) {
  const params = new URLSearchParams({ level });
  for (const k of levels) {
    if (currentFilters && currentFilters[k]) params.set(k, currentFilters[k]);
  }
  const resp = await fetch('/api/taxonomy/values?' + params.toString());
  if (!resp.ok) throw new Error(`tax values HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.values) ? data.values : [];
}

async function updateMapForFilters(filters) {
  const params = new URLSearchParams({ limit: '1000' });
  for (const k of Object.keys(filters || {})) {
    if (filters[k] !== undefined && filters[k] !== null && filters[k] !== '') params.set(k, filters[k]);
  }
  showLoader();
  try {
    const url = '/api/observations?' + params.toString();
    console.debug('[fetch] GET', url);
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    markers.clearLayers();
    if (Array.isArray(data.results)) {
      console.debug('[fetch] results:', data.results.length);
      data.results.forEach(obs => {
        const lat = obs.decimalLatitude;
        const lng = obs.decimalLongitude;
        if (typeof lat === 'number' && typeof lng === 'number') {
          L.circleMarker([lat, lng], {
            radius: 6,
            color: '#0078ff',
            fillColor: '#3fa7ff',
            fillOpacity: 0.7
          }).addTo(markers)
            .bindPopup(`Lat: ${lat}, Lng: ${lng}<br>${obs.scientificName || ''}<br>${obs.locality || ''}`);
        }
      });
      const all = markers.getLayers();
      if (all.length > 0) {
        safeFitBounds(markers, 0.2);
      }
      if (statusDiv) statusDiv.textContent = `${all.length} observations affichées`;
    } else {
      if (statusDiv) statusDiv.textContent = '0 observations';
    }
  } catch (err) {
    console.error('Erreur updateMapForFilters:', err);
    if (statusDiv) statusDiv.textContent = 'Erreur lors du chargement des observations';
  } finally {
    hideLoader();
  }
}

// Gestionnaire appelé quand un sélecteur taxonomique change : met à jour les sélecteurs descendants et la carte.
async function onTaxChange(levelChanged) {
  try {
    const filters = {};
    for (const lvl of levels) {
      const val = selects[lvl]?.value || '';
      if (val) filters[lvl] = val;
      if (lvl === levelChanged) break;
    }
    resetBelow(levelChanged);

    const idx = levels.indexOf(levelChanged);
    if (idx >= 0 && idx < levels.length - 1) {
      const next = levels[idx + 1];
      const values = await fetchTaxValues(next, filters);
      if (values.length) populateSelect(selects[next], values);
    }

    if (selects.scientificName && selects.scientificName.value) {
      await updateMapForFilters({ scientificName: selects.scientificName.value, ...getCurrentYearFilter() });
      return;
    }

    await updateMapForFilters({ ...filters, ...getCurrentYearFilter() });
  } catch (e) {
    console.error('Erreur filtre taxonomique:', e);
  }
}

async function initTaxonomyPanel() {
  showLoader();
  try {
    const kingdoms = await fetchTaxValues('kingdom', {});
    if (kingdoms.length) populateSelect(selects.kingdom, kingdoms);
    for (const lvl of levels) {
      const el = selects[lvl];
      if (!el) continue;
      el.addEventListener('change', () => onTaxChange(lvl));
    }
    const resetBtn = document.getElementById('btn-reset-taxonomy');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        for (const lvl of levels) {
          const el = selects[lvl];
          if (!el) continue;
          el.value = '';
        }
        resetBelow('kingdom');
        if (typeof yearFilterTouched !== 'undefined') yearFilterTouched = false;
        if (yearMinInput && yearMaxInput && yearBounds.min !== null && yearBounds.max !== null) {
          yearMinInput.value = String(yearBounds.min);
          yearMaxInput.value = String(yearBounds.max);
          if (yearMinLabel) yearMinLabel.textContent = String(yearBounds.min);
          if (yearMaxLabel) yearMaxLabel.textContent = String(yearBounds.max);
        }
        await updateMapForFilters({});
      });
    }
  } catch (e) {
    console.error('Erreur init taxonomie:', e);
  } finally {
    hideLoader();
  }
}

// ----- Panneau dates -----
const yearMinInput = document.getElementById('year-min');
const yearMaxInput = document.getElementById('year-max');
const yearMinLabel = document.getElementById('year-min-label');
const yearMaxLabel = document.getElementById('year-max-label');

let yearBounds = { min: null, max: null };
let yearFilterTouched = false;

function getCurrentYearFilter() {
  if (!yearFilterTouched) return {};
  if (!yearMinInput || !yearMaxInput) return {};
  const yMin = Number(yearMinInput.value);
  const yMax = Number(yearMaxInput.value);
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return {};
  const lo = Math.min(yMin, yMax);
  const hi = Math.max(yMin, yMax);
  return { yearMin: String(lo), yearMax: String(hi) };
}

async function fetchYearBounds(currentFilters) {
  const params = new URLSearchParams();
  const lvls = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
  for (const k of lvls) {
    if (currentFilters?.[k]) params.set(k, currentFilters[k]);
  }
  const resp = await fetch('/api/taxonomy/values?level=year&' + params.toString());
  const data = await resp.json();
  return data.values || [];
}

function setYearControls(minYear, maxYear) {
  if (!yearMinInput || !yearMaxInput) return;
  yearMinInput.min = String(minYear);
  yearMinInput.max = String(maxYear);
  yearMaxInput.min = String(minYear);
  yearMaxInput.max = String(maxYear);
  yearMinInput.value = String(minYear);
  yearMaxInput.value = String(maxYear);
  if (yearMinLabel) yearMinLabel.textContent = String(minYear);
  if (yearMaxLabel) yearMaxLabel.textContent = String(maxYear);
  yearBounds = { min: minYear, max: maxYear };
}

function getCurrentTaxFilters() {
  const filters = {};
  for (const lvl of levels) {
    const val = selects[lvl]?.value || '';
    if (val) filters[lvl] = val;
  }
  return filters;
}

async function initDatePanel() {
  try {
    const filters = getCurrentTaxFilters();
    const params = new URLSearchParams(filters);
    const resp = await fetch('/api/years/minmax?' + params.toString());
    const data = await resp.json();
    const now = new Date().getFullYear();
    const minYear = Number.isFinite(Number(data.minYear)) ? Number(data.minYear) : now - 50;
    const maxYear = Number.isFinite(Number(data.maxYear)) ? Number(data.maxYear) : now;
    setYearControls(minYear, maxYear);
  } catch (e) {
    console.error('Erreur init panel date:', e);
    const now = new Date().getFullYear();
    setYearControls(now - 50, now);
  }

  const onInput = (e) => {
    if (!yearMinInput || !yearMaxInput) return;
    let yMin = Number(yearMinInput.value);
    let yMax = Number(yearMaxInput.value);
    if (yMin > yMax) {
      if (e && e.target === yearMinInput) yMax = yMin; else yMin = yMax;
      yearMinInput.value = String(yMin);
      yearMaxInput.value = String(yMax);
    }
    if (yearMinLabel) yearMinLabel.textContent = String(yMin);
    if (yearMaxLabel) yearMaxLabel.textContent = String(yMax);
  };

  const onChange = async () => {
    if (!yearMinInput || !yearMaxInput) return;
    yearFilterTouched = true;
    const filters = getCurrentTaxFilters();
    const yMin = Number(yearMinInput.value);
    const yMax = Number(yearMaxInput.value);
    filters.yearMin = String(Math.min(yMin, yMax));
    filters.yearMax = String(Math.max(yMin, yMax));
    showLoader();
    try {
      await updateMapForFilters(filters);
    } finally {
      hideLoader();
    }
  };

  if (yearMinInput) {
    yearMinInput.addEventListener('input', onInput);
    yearMinInput.addEventListener('change', onChange);
  }
  if (yearMaxInput) {
    yearMaxInput.addEventListener('input', onInput);
    yearMaxInput.addEventListener('change', onChange);
  }
}

// ----- Corrélation latitude-diversité -----
async function showLatitudeDiversityCorrelation() {
  showLoader();
  try {
    const resp = await fetch('/api/correlation/latitude-diversite');
    if (!resp.ok) throw new Error('Erreur HTTP');
    const data = await resp.json();
    if (!Array.isArray(data.correlation)) throw new Error('Format invalide');

    markers.clearLayers();

    data.correlation.forEach(d => {
      if (typeof d.latitude !== 'number' || typeof d.diversite !== 'number') return;

      // Limiter les latitudes au Brésil (~-34 à 5)
      const lat = Math.max(-34, Math.min(5, d.latitude));

      // Longitude approximative pour le Brésil (~-74 à -34) avec dispersion
      const lng = Math.max(-74, Math.min(-34, -55 + (Math.random() - 0.5) * 10));

      const diversite = d.diversite;

      // Couleur selon le niveau de diversité
      const color =
        diversite > 1000 ? '#ff0000' :
        diversite > 500  ? '#ff7f00' :
        diversite > 100  ? '#ffff00' :
                          '#00ff00';

      L.circleMarker([lat, lng], {
        radius: Math.max(3, Math.min(10, diversite / 10)),
        color,
        fillColor: color,
        fillOpacity: 0.6
      })
      .addTo(markers)
      .bindPopup(`Latitude ~${lat}°<br>Diversité: ${diversite}`);
    });

    const all = markers.getLayers();
    if (all.length > 0) {
      const group = L.featureGroup(all);
      map.fitBounds(group.getBounds().pad(0.3));
      if (statusDiv) statusDiv.textContent = 'Corrélation latitude-diversité affichée';
    } else {
      if (statusDiv) statusDiv.textContent = 'Aucune donnée de corrélation disponible';
    }
  } catch (err) {
    console.error('Erreur corrélation:', err);
    if (statusDiv) statusDiv.textContent = 'Erreur corrélation latitude-diversité';
  } finally {
    hideLoader();
  }
}

if (btnCorr) {
  btnCorr.addEventListener('click', showLatitudeDiversityCorrelation);
}

// Initialiser panneaux
initTaxonomyPanel();
initDatePanel();
