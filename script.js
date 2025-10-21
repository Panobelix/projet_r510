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
const cancelBtn = document.getElementById('btn-cancel-requests');
// Affiche/Cache l'overlay de chargement
let cancelRequested = false;
const showLoader = () => {
  cancelRequested = false;
  if (loadingOverlay) loadingOverlay.classList.add('active');
};
const hideLoader = () => {
  if (loadingOverlay) loadingOverlay.classList.remove('active');
};

// Gestion d'annulation des requêtes via AbortController
const activeControllers = new Set();
function fetchWithCancel(url, init = {}) {
  const controller = new AbortController();
  activeControllers.add(controller);
  const merged = { ...init, signal: controller.signal };
  return fetch(url, merged).finally(() => {
    activeControllers.delete(controller);
  });
}

// Bouton "Annuler" sous l'overlay
if (cancelBtn) {
  cancelBtn.addEventListener('click', () => {
    let aborted = 0;
    for (const c of activeControllers) {
      try { c.abort(); aborted++; } catch {}
    }
    activeControllers.clear();
    cancelRequested = true;
    hideLoader();
    if (statusDiv) statusDiv.textContent = 'Requête annulée';
    console.warn('[cancel] Aborted requests:', aborted);
  });
}
// Ne rien charger au démarrage tant qu'aucun filtre n'est sélectionné
if (statusDiv) statusDiv.textContent = 'Sélectionnez un filtre taxonomique pour afficher la carte.';

// (Progress UI removed) We'll log progress to console instead.

// ----- Panel Documents (limite de résultats pour /api/observations) -----
const docLimitInput = document.getElementById('doc-limit');
const docLimitLabel = document.getElementById('doc-limit-label');
const rangeSingleEl = document.querySelector('.range-single');
let docLimit = 500; // défaut au lancement

function getDocLimit() { return docLimit; }

function updateDocLimitTrack() {
  if (!rangeSingleEl || !docLimitInput) return;
  const min = Number(docLimitInput.min) || 0;
  const max = Number(docLimitInput.max) || 1;
  const val = Number(docLimitInput.value) || min;
  const pct = ((val - min) / Math.max(1, max - min)) * 100;
  rangeSingleEl.style.setProperty('--value-pct', pct + '%');
  rangeSingleEl.style.setProperty('--active-color', val >= 5000 ? '#e53935' : '#2f80ff');
}

function initDocLimitPanel() {
  if (!docLimitInput) return;
  // Valeur par défaut
  docLimitInput.value = String(docLimit);
  if (docLimitLabel) docLimitLabel.textContent = String(docLimit);
  updateDocLimitTrack();

  // Mise à jour temps réel de l’affichage
  docLimitInput.addEventListener('input', () => {
    docLimit = Math.max(1, Number(docLimitInput.value) || docLimit);
    if (docLimitLabel) docLimitLabel.textContent = String(docLimit);
    updateDocLimitTrack();
  });
  // Déclencher une mise à jour de la carte au relâchement
  docLimitInput.addEventListener('change', async () => {
    const filters = { ...getCurrentTaxFilters(), ...getCurrentYearFilter() };
    showLoader();
    try {
      await updateMapForFilters(filters);
      // La grille biodiversité ne dépend pas de docLimit: ne rien faire ici
    } finally {
      hideLoader();
    }
  });
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

// Réinitialise et désactive tous les sélecteurs taxonomiques situés en dessous du niveau donné.
function resetBelow(level) {
  const idx = levels.indexOf(level);
  for (let i = idx + 1; i < levels.length; i++) {
    const s = selects[levels[i]];
    if (!s) continue;
    s.innerHTML = '<option value="">—</option>';
    s.disabled = true;
  }
}

// Remplit un <select> avec une option vide puis les valeurs fournies et l'active.
function populateSelect(el, values) {
  el.innerHTML = '<option value="">—</option>' + values.map(v => `<option value="${v.replaceAll('"','&quot;')}">${v}</option>`).join('');
  el.disabled = false;
}

// Récupère depuis l'API les valeurs distinctes pour un niveau taxonomique donné en appliquant les filtres.
async function fetchTaxValues(level, currentFilters) {
  const params = new URLSearchParams({ level });
  for (const k of levels) {
    if (currentFilters[k]) params.set(k, currentFilters[k]);
  }
  try {
    const resp = await fetchWithCancel('/api/taxonomy/values?' + params.toString());
    const data = await resp.json();
    return Array.isArray(data.values) ? data.values : [];
  } catch (e) {
    if (e?.name === 'AbortError') return [];
    throw e;
  }
}

// Charge les observations selon les filtres, met à jour les marqueurs sur la carte et gère le loader.
async function updateMapForFilters(filters) {
  const params = new URLSearchParams({ limit: String(getDocLimit()) });
  for (const k of Object.keys(filters)) {
    if (filters[k] !== undefined && filters[k] !== null && filters[k] !== '') params.set(k, filters[k]);
  }
  showLoader();
  try {
    const url = '/api/observations?' + params.toString();
    console.debug('[fetch] GET', url);
  const resp = await fetchWithCancel(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    if (cancelRequested) return; // si annulé pendant le chargement
    const data = await resp.json();
    markers.clearLayers();
    if (Array.isArray(data.results)) {
      console.debug('[fetch] results:', data.results.length);
      // Dessin en boucles avec vérification d'annulation pour garder l'UI réactive
      for (let i = 0; i < data.results.length; i++) {
        if (cancelRequested) { markers.clearLayers(); return; }
        const obs = data.results[i];
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
        // yield occasionnellement pour laisser l'UI respirer
        if (i % 1000 === 0) await new Promise(r => setTimeout(r, 0));
      }
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
    if (err?.name === 'AbortError') {
      console.warn('updateMapForFilters: requête annulée');
    } else {
      console.error('Erreur updateMapForFilters:', err);
      if (statusDiv) statusDiv.textContent = 'Erreur lors du chargement des observations';
    }
  } finally {
    hideLoader();
  }
}

// getCurrentYearFilter sera défini plus bas, après la déclaration des variables du panneau date

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
      if (bioGridActive) await refreshBioGridGlobal();
      return;
    }

    // Sinon, afficher avec les filtres partiels (ex: genus)
    await updateMapForFilters({ ...filters, ...getCurrentYearFilter() });
    if (bioGridActive) await refreshBioGridGlobal();
  } catch (e) {
    console.error('Erreur filtre taxonomique:', e);
  }
}

// Initialise le panneau taxonomique (remplit kingdom, attache les événements, gère le bouton reset).
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
          // Piste bleue pleine largeur par défaut après reset
          updateDualRangeTrack();
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
const rangeDualEl = document.querySelector('.range-dual');

let yearBounds = { min: null, max: null };
let yearFilterTouched = false;

// Met à jour la piste bleue entre les deux poignées en fonction des valeurs courantes
function updateDualRangeTrack() {
  if (!rangeDualEl || !yearMinInput || !yearMaxInput) return;
  if (yearBounds.min === null || yearBounds.max === null) return;
  const lo = Math.min(Number(yearMinInput.value), Number(yearMaxInput.value));
  const hi = Math.max(Number(yearMinInput.value), Number(yearMaxInput.value));
  const span = Math.max(1, Number(yearBounds.max) - Number(yearBounds.min));
  const minPct = ((lo - Number(yearBounds.min)) / span) * 100;
  const maxPct = ((hi - Number(yearBounds.min)) / span) * 100;
  rangeDualEl.style.setProperty('--min-pct', `${minPct}%`);
  rangeDualEl.style.setProperty('--max-pct', `${maxPct}%`);
}

// Construit le filtre d'années à partir des sliders si l'utilisateur a interagi, sinon retourne vide.
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

// Interroge l'API pour obtenir les bornes (min/max) des années en fonction des filtres fournis.
async function fetchYearBounds(currentFilters) {
  // On récupère les bornes de l’attribut 'year' selon les filtres (ou globalement)
  const params = new URLSearchParams();
  const levels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
  for (const k of levels) {
    if (currentFilters?.[k]) params.set(k, currentFilters[k]);
  }
  const resp = await fetchWithCancel('/api/taxonomy/values?level=year&' + params.toString());
  const data = await resp.json();
  // Si l’API ne supporte pas encore level=year, on basculera sur une approche fallback ci-dessous
  return data.values || [];
}

// Configure les sliders d'années (min/max/valeurs) et met à jour les étiquettes affichées.
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
  // Initialiser la piste active (pleine largeur au départ)
  updateDualRangeTrack();
}

// Lit les sélecteurs taxonomiques et retourne un objet contenant les filtres actifs.
function getCurrentTaxFilters() {
  const filters = {};
  for (const lvl of levels) {
    const val = selects[lvl]?.value || '';
    if (val) filters[lvl] = val;
  }
  return filters;
}

// Initialise le panneau des dates : récupère les bornes, configure les sliders et attache les événements.
async function initDatePanel() {
  // Fallback simple: déterminer les bornes min/max depuis un échantillon si l’API year n’existe pas
  try {
    const filters = getCurrentTaxFilters();
    const params = new URLSearchParams(filters);
  const resp = await fetchWithCancel('/api/years/minmax?' + params.toString());
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
    updateDualRangeTrack();
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
    updateDualRangeTrack();
    showLoader();
    try {
      await updateMapForFilters(filters);
      if (bioGridActive) await refreshBioGridGlobal();
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

  // Empêche les pouces de se chevaucher visuellement en bloquant l'autre handle si nécessaire
  const clampHandles = (e) => {
    if (!yearMinInput || !yearMaxInput) return;
    const min = Number(yearMinInput.min);
    const max = Number(yearMinInput.max);
    let yMin = Number(yearMinInput.value);
    let yMax = Number(yearMaxInput.value);
    yMin = Math.max(min, Math.min(yMin, max));
    yMax = Math.max(min, Math.min(yMax, max));
    if (e && e.target === yearMinInput && yMin > yMax) {
      yearMaxInput.value = String(yMin);
    } else if (e && e.target === yearMaxInput && yMax < yMin) {
      yearMinInput.value = String(yMax);
    }
  };
  yearMinInput?.addEventListener('input', clampHandles);
  yearMaxInput?.addEventListener('input', clampHandles);
}

// Initialiser panneaux
initTaxonomyPanel();
initDatePanel();
initDocLimitPanel();

// ================= Biodiversity Grid Overlay (fixe, global) =================
// On calcule une grille globale côté serveur une seule fois à l'activation.

let bioGridLayer = null;           // L.LayerGroup des rectangles de cellules
let bioGridActive = false;         // overlay actif
let bioGridCellSizeDeg = 0.25;      // taille de cellule en degrés (lat/lng), fixe (4x plus petit que 1.0)

const DEFAULT_BIOGRID_MAXDOCS = 35000000;
function getBioGridMaxDocs() {
  try {
    const urlVal = new URLSearchParams(window.location.search).get('maxDocs');
    const fromUrl = urlVal ? Number(urlVal) : NaN;
    if (Number.isFinite(fromUrl) && fromUrl > 0) return String(Math.floor(fromUrl));
  } catch {}
  try {
    const stored = localStorage.getItem('biogrid_maxDocs');
    const fromStore = stored ? Number(stored) : NaN;
    if (Number.isFinite(fromStore) && fromStore > 0) return String(Math.floor(fromStore));
  } catch {}
  return String(DEFAULT_BIOGRID_MAXDOCS);
}

function cellKeyFromLatLng(lat, lng, sizeDeg) {
  const i = Math.floor((lat + 90) / sizeDeg);
  const j = Math.floor((lng + 180) / sizeDeg);
  return `${i}:${j}`;
}

function boundsFromKey(key, sizeDeg) {
  const [iStr, jStr] = key.split(':');
  const i = Number(iStr); const j = Number(jStr);
  const lat0 = -90 + i * sizeDeg;
  const lat1 = lat0 + sizeDeg;
  const lng0 = -180 + j * sizeDeg;
  const lng1 = lng0 + sizeDeg;
  return [[lat0, lng0], [lat1, lng1]];
}

function colorForCount(c) {
  if (c > 100) return '#28a745';      // vert
  if (c >= 50) return '#ff9800';      // orange
  return '#e53935';                  // rouge
}
async function fetchGridCellsGlobal() {
  // Essayer d'abord le cache
  const cacheParams = new URLSearchParams({ sizeDeg: String(bioGridCellSizeDeg) });
  let url = '/api/coords/grid/cached?' + cacheParams.toString();
  console.debug('[bio-grid] GET', url);
  let resp = await fetchWithCancel(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  let data = await resp.json();
  if (data.cached && Array.isArray(data.cells)) {
    console.log('[bio-grid] cache hit:', data.cells.length, 'cellules, scanned=', data.scanned, 'updatedAt=', data.updatedAt);
    return data;
  }
  // Si calcul en cours ou cache manquant, prévenir l'utilisateur et arrêter
  const msg = 'Indisponible pour le moment: calcul de la grille en cours côté serveur. Réessaie dans quelques minutes.';
  console.warn('[bio-grid]', msg, data);
  if (statusDiv) statusDiv.textContent = msg;
  throw new Error('bio-grid-cache-not-ready');
}

function drawBioGridFromCells(cells) {
  const rects = [];
  for (const cell of cells) {
    const count = cell.count;
    if (!Number.isFinite(count) || count <= 0) continue;
    const color = colorForCount(count);
    const rect = L.rectangle(cell.bounds, {
      color,
      weight: 1,
      opacity: 0.8,
      fillColor: color,
      fillOpacity: 0.45,
      interactive: false
    });
    rects.push(rect);
  }
  if (bioGridLayer) {
    map.removeLayer(bioGridLayer);
    bioGridLayer = null;
  }
  bioGridLayer = L.layerGroup(rects);
  if (bioGridActive) bioGridLayer.addTo(map);
  console.log('[bio-grid] rectangles dessinés:', rects.length);
}

async function refreshBioGridGlobal() {
  if (!bioGridActive) return;
  showLoader();
  try {
    const data = await fetchGridCellsGlobal();
    if (statusDiv) statusDiv.textContent = `Grille biodiversité (fixe): ${data.cells.length} cellules (scan=${data.scanned}${data.capped ? ', cap' : ''})`;
    drawBioGridFromCells(data.cells);
  } catch (e) {
    console.error('Erreur refreshBioGridGlobal:', e);
  } finally {
    hideLoader();
  }
}

async function toggleBiodiversityGrid(enable) {
  bioGridActive = enable;
  if (enable) {
    await refreshBioGridGlobal();
  } else {
    if (bioGridLayer && map.hasLayer(bioGridLayer)) map.removeLayer(bioGridLayer);
  }
}

// Attacher le bouton Filtre 1 au toggle de la grille biodiversité
(function attachBiodiversityButton() {
  const btn = document.querySelector('[data-filter="f1"]');
  if (!btn) return;
  const setActive = (on) => {
    btn.classList.toggle('active', on);
  };
  btn.addEventListener('click', async () => {
    const newState = !bioGridActive;
    setActive(newState);
    await toggleBiodiversityGrid(newState);
    console.debug('[bio-grid] toggle ->', newState);
  });
})();

// ---- Positionner le panneau de filtres 20px au-dessus du panneau dates ----
(function positionFilterPanelRelativeToDateOrLimit() {
  const filterPanel = document.getElementById('filter-panel');
  const datePanel = document.getElementById('date-panel');
  const limitPanel = document.getElementById('limit-panel');
  if (!filterPanel) return;
  const GAP = 20; // 20px au-dessus
  const MARGIN = 12; // marge minimale au bord

  function positionNow() {
    // Base: au-dessus du panel le plus bas (limit > date)
    const baseEl = limitPanel || datePanel;
    if (!baseEl) return;
    const dateRect = baseEl.getBoundingClientRect();
    const filterRect = filterPanel.getBoundingClientRect();
    const targetTop = Math.max(MARGIN, dateRect.top - filterRect.height - GAP);
    filterPanel.style.top = `${targetTop}px`;
    filterPanel.style.bottom = '';
    filterPanel.style.right = '12px';
    // S'assurer qu'il reste visible même si la fenêtre est petite
    if (targetTop < MARGIN) filterPanel.style.top = `${MARGIN}px`;
  }

  // Position initiale et sur redimensionnement
  positionNow();
  window.addEventListener('resize', positionNow);
  // Repositionner si le panneau date change de taille
  if (window.ResizeObserver) {
    try {
      const ro = new ResizeObserver(() => positionNow());
      if (datePanel) ro.observe(datePanel);
      if (limitPanel) ro.observe(limitPanel);
    } catch {}
  }
})();

// ---- Positionner le panneau documents juste au-dessus du panneau dates ----
(function positionLimitPanelRelativeToDate() {
  const limitPanel = document.getElementById('limit-panel');
  const datePanel = document.getElementById('date-panel');
  if (!limitPanel || !datePanel) return;
  const GAP = 12;
  const MARGIN = 12;
  function positionNow() {
    const dateRect = datePanel.getBoundingClientRect();
    const limitRect = limitPanel.getBoundingClientRect();
    const targetTop = Math.max(MARGIN, dateRect.top - limitRect.height - GAP);
    limitPanel.style.top = `${targetTop}px`;
    limitPanel.style.right = '12px';
    limitPanel.style.bottom = '';
  }
  positionNow();
  window.addEventListener('resize', positionNow);
  if (window.ResizeObserver) {
    try {
      const ro = new ResizeObserver(() => positionNow());
      ro.observe(datePanel);
    } catch {}
  }
})();