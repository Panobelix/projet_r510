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

const markers = L.layerGroup().addTo(map);
const statusDiv = document.getElementById('requete');
const loadingOverlay = document.getElementById('loading-overlay');
const showLoader = () => loadingOverlay && loadingOverlay.classList.add('active');
const hideLoader = () => loadingOverlay && loadingOverlay.classList.remove('active');
// Ne rien charger au démarrage tant qu'aucun filtre n'est sélectionné
if (statusDiv) statusDiv.textContent = 'Sélectionnez un filtre taxonomique pour afficher la carte.';

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
  el.innerHTML = '<option value="">—</option>' + values.map(v => `<option value="${v.replaceAll('"','&quot;')}">${v}</option>`).join('');
  el.disabled = false;
}

async function fetchTaxValues(level, currentFilters) {
  const params = new URLSearchParams({ level });
  for (const k of levels) {
    if (currentFilters[k]) params.set(k, currentFilters[k]);
  }
  const resp = await fetch('/api/taxonomy/values?' + params.toString());
  const data = await resp.json();
  return Array.isArray(data.values) ? data.values : [];
}

async function updateMapForFilters(filters) {
  const params = new URLSearchParams({ limit: '1000' });
  for (const k of Object.keys(filters)) {
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
            .bindPopup(`Lat: ${lat}, Lng: ${lng}<br>${obs.scientificName}<br>${obs.locality || ''}`);
        }
      });
      const all = markers.getLayers();
      if (all.length > 0) {
        const group = L.featureGroup(all);
        map.fitBounds(group.getBounds().pad(0.2));
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

// getCurrentYearFilter sera défini plus bas, après la déclaration des variables du panneau date

async function onTaxChange(levelChanged) {
  try {
    const filters = {};
    for (const lvl of levels) {
      const val = selects[lvl]?.value || '';
      if (val) filters[lvl] = val;
      if (lvl === levelChanged) break;
    }
    resetBelow(levelChanged);

    // Charger les options du niveau suivant
    const idx = levels.indexOf(levelChanged);
    if (idx >= 0 && idx < levels.length - 1) {
      const next = levels[idx + 1];
      const values = await fetchTaxValues(next, filters);
      if (values.length) populateSelect(selects[next], values);
    }

    // Si scientificName est choisi, afficher uniquement ce nom
    if (selects.scientificName && selects.scientificName.value) {
      await updateMapForFilters({ scientificName: selects.scientificName.value, ...getCurrentYearFilter() });
      return;
    }

    // Sinon, afficher avec les filtres partiels (ex: genus)
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
    // Ecouteurs
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
        // Réinitialiser le filtre d'années
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
  // N'applique pas le filtre d'années tant que l'utilisateur n'a pas interagi
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
  // On récupère les bornes de l’attribut 'year' selon les filtres (ou globalement)
  const params = new URLSearchParams();
  const levels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
  for (const k of levels) {
    if (currentFilters?.[k]) params.set(k, currentFilters[k]);
  }
  const resp = await fetch('/api/taxonomy/values?level=year&' + params.toString());
  const data = await resp.json();
  // Si l’API ne supporte pas encore level=year, on basculera sur une approche fallback ci-dessous
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
  // Fallback simple: déterminer les bornes min/max depuis un échantillon si l’API year n’existe pas
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

  // Mise à jour des labels en direct pendant le glissé
  const onInput = (e) => {
    if (!yearMinInput || !yearMaxInput) return;
    let yMin = Number(yearMinInput.value);
    let yMax = Number(yearMaxInput.value);
    if (yMin > yMax) {
      // maintenir un intervalle valide pendant le drag
      if (e && e.target === yearMinInput) yMax = yMin; else yMin = yMax;
      yearMinInput.value = String(yMin);
      yearMaxInput.value = String(yMax);
    }
    if (yearMinLabel) yearMinLabel.textContent = String(yMin);
    if (yearMaxLabel) yearMaxLabel.textContent = String(yMax);
  };

  // Déclencher la requête uniquement au relâchement du slider
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

// Initialiser panneaux
initTaxonomyPanel();
initDatePanel();