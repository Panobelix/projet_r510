/**
 * Script client (Leaflet + UI)
 * ----------------------------
 * - Initialise la carte et ses calques
 * - Gère les panneaux (taxonomie, dates, limite/tri, filtres rapides)
 * - Interroge l'API /api/observations selon les filtres courants
 * - Affiche un overlay de chargement et permet d'annuler les requêtes
 * - Superpose une grille biodiversité pré-calculée
 */
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

// Instanciation de la carte Leaflet
const map = L.map('map', {
  center: [-14.2350, -51.9253],
  zoom: 4,
  layers: [sat]
});
L.control.layers({ 'OpenStreetMap': osm, 'Satellite': sat, 'Topographique': topo }).addTo(map);
// Supprimer le préfixe "Leaflet |" du contrôle d'attribution (on conserve les crédits fournisseurs)
try { if (map.attributionControl && map.attributionControl.setPrefix) map.attributionControl.setPrefix(false); } catch {}

// Couche principale des marqueurs (observations)
const markers = L.layerGroup().addTo(map);
// Couche dédiée pour la visualisation latitude-diversité (séparée des marqueurs d'observations)
let latDivLayer = L.layerGroup();
let latDivActive = false;
const statusDiv = document.getElementById('requete');
const loadingOverlay = document.getElementById('loading-overlay');
const cancelBtn = document.getElementById('btn-cancel-requests');
const toastContainer = document.getElementById('toast-container');
let lastLargeWarn = 0; // throttle pour l'alerte >10k
// Affiche/Cache l'overlay de chargement
let cancelRequested = false;
const showLoader = () => {
  cancelRequested = false;
  if (loadingOverlay) loadingOverlay.classList.add('active');
};
const hideLoader = () => {
  if (loadingOverlay) loadingOverlay.classList.remove('active');
};

// Toasts non bloquants (notifications in-app)
function showToast(message, type = 'info', timeoutMs = 4000) {
  if (!toastContainer) { try { alert(message); } catch {} return; }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-text">${escapeHtml(message)}</span>
    <button class="toast-close" title="Fermer">×</button>
  `;
  const btn = el.querySelector('.toast-close');
  btn?.addEventListener('click', () => el.remove());
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (timeoutMs > 0) setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, timeoutMs);
}

// Gestion centralisée d'annulation de requêtes via AbortController
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

// ----- Panneau Documents (limite de résultats pour /api/observations) -----
const docLimitInput = document.getElementById('doc-limit');
const docLimitLabel = document.getElementById('doc-limit-label');
const rangeSingleEl = document.querySelector('.range-single');

// Mapping exponentiel: valeur slider [0..SLIDER_MAX] -> [DOC_MIN..DOC_MAX]
const DOC_MIN = 100;
const DOC_MAX = 35000000;
const SLIDER_MAX = 1000;
let docLimit = 500; // défaut au lancement (valeur mappée)

function sliderToLimit(val) {
  const s = Math.max(0, Math.min(Number(val) || 0, SLIDER_MAX)) / SLIDER_MAX; // [0..1]
  const ratio = DOC_MAX / DOC_MIN;
  const mapped = Math.floor(DOC_MIN * Math.pow(ratio, s));
  return Math.max(DOC_MIN, Math.min(mapped, DOC_MAX));
}
function limitToSlider(limit) {
  const clamped = Math.max(DOC_MIN, Math.min(Number(limit) || DOC_MIN, DOC_MAX));
  const ratio = DOC_MAX / DOC_MIN;
  const s = Math.log(clamped / DOC_MIN) / Math.log(ratio); // [0..1]
  return Math.round(s * SLIDER_MAX);
}
// État courant du tri (par défaut: ID croissant)
let sortState = { field: '_id', dir: 'asc' };

function getDocLimit() { return docLimit; }

function fmt(n) {
  try { return Number(n).toLocaleString('fr-FR'); } catch { return String(n); }
}

function updateDocLimitTrack() {
  if (!rangeSingleEl || !docLimitInput) return;
  const pos = (Number(docLimitInput.value) || 0) / (Number(docLimitInput.max) || SLIDER_MAX);
  const pct = Math.max(0, Math.min(100, pos * 100));
  rangeSingleEl.style.setProperty('--value-pct', pct + '%');
  const over = docLimit >= 10000;
  // CSS variable fallback for older style; also toggle a helper class
  rangeSingleEl.style.setProperty('--active-color', over ? '#e53935' : '#2f80ff');
  if (over) rangeSingleEl.classList.add('overlimit'); else rangeSingleEl.classList.remove('overlimit');
}

// Initialise le panneau limite/tri et branche les actions UI
function initDocLimitPanel() {
  if (!docLimitInput) return;
  // Initialiser la position du slider en fonction de docLimit par défaut
  docLimitInput.min = '0';
  docLimitInput.max = String(SLIDER_MAX);
  docLimitInput.step = '1';
  docLimitInput.value = String(limitToSlider(docLimit));
  if (docLimitLabel) docLimitLabel.textContent = fmt(docLimit);
  updateDocLimitTrack();

  // Mise à jour temps réel de l’affichage
  docLimitInput.addEventListener('input', () => {
    // recalculer docLimit depuis la position du slider
    docLimit = sliderToLimit(docLimitInput.value);
    if (docLimitLabel) docLimitLabel.textContent = fmt(docLimit);
    updateDocLimitTrack();
  });
  // Déclencher une mise à jour de la carte au relâchement
  docLimitInput.addEventListener('change', async () => {
    if (docLimit > 10000) {
        showToast("Attention : plus de 10 000 documents demandés. Le chargement peut être très long.", 'warn', 5000);
      // Empêche un double toast: on vient d'avertir, ne ré-affiche pas dans updateMapForFilters
      try { lastLargeWarn = Date.now(); } catch {}
    }
    const filters = { ...getCurrentTaxFilters(), ...getCurrentYearFilter() };
    showLoader();
    try {
      await updateMapForFilters(filters);
      // La grille biodiversité ne dépend pas de docLimit: ne rien faire ici
    } finally {
      hideLoader();
    }
  });

  // Boutons de tri
  const sortButtons = document.querySelectorAll('.sort-groups .sort-mini-btn');
  const updateActiveSort = () => {
    sortButtons.forEach(btn => {
      const [f, d] = String(btn.dataset.sort || '').split(':');
      btn.classList.toggle('active', f === sortState.field && d === sortState.dir);
    });
  };
  sortButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const [field, dir] = String(btn.dataset.sort || '').split(':');
      if (!field || !dir) return;
      sortState = { field, dir };
      updateActiveSort();
      const filters = { ...getCurrentTaxFilters(), ...getCurrentYearFilter() };
      showLoader();
      try {
        await updateMapForFilters(filters);
        if (statusDiv) statusDiv.textContent = `Tri: ${field} ${dir}`;
      } finally {
        hideLoader();
      }
    });
  });
  updateActiveSort();
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
// Désactive + réinitialise tous les selects en dessous d'un niveau donné
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
// Récupère les valeurs distinctes d'un niveau taxo en tenant compte des filtres amont
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
// Charge les observations selon les filtres, met à jour les marqueurs et le statut
async function updateMapForFilters(filters) {
  // Avertir si on lance une requête avec un docLimit très élevé
  try {
    if (getDocLimit() > 10000) {
      const now = Date.now();
      if (now - lastLargeWarn > 30000) { // au max toutes les 30s
          showToast("Attention : plus de 10 000 documents demandés. Le chargement peut être très long.", 'warn', 5000);
        lastLargeWarn = now;
      }
    }
  } catch {}
  const params = new URLSearchParams({ limit: String(getDocLimit()) });
  // Tri
  if (sortState?.field && sortState?.dir) {
    params.set('sortField', sortState.field);
    params.set('sortDir', sortState.dir);
  }
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
            const marker = L.circleMarker([lat, lng], {
              radius: 6,
              color: '#0078ff',
              fillColor: '#3fa7ff',
              fillOpacity: 0.7
            }).addTo(markers);

            const sci = obs.scientificName || '';
            const yearTxt = (typeof obs.year === 'number' || typeof obs.year === 'string') ? String(obs.year) : '';
            const locTxt = obs.locality ? String(obs.locality) : '';
            const ccTxt = obs.countryCode ? String(obs.countryCode).toUpperCase() : '';

            const infoParts = [];
            infoParts.push(`<div><strong>Nom scientifique :</strong> <em>${escapeHtml(sci)}</em></div>`);
            if (yearTxt) infoParts.push(`<div><strong>Date de l'observation :</strong> ${escapeHtml(yearTxt)}</div>`);
            const cityLine = (locTxt || ccTxt) ? `<div><strong>Ville :</strong> ${escapeHtml(locTxt)}${ccTxt ? ', ' + escapeHtml(ccTxt) : ''}</div>` : '';
            if (cityLine) infoParts.push(cityLine);

            const popupHtml = `
              <div class="obs-popup" data-name="${escapeAttr(sci)}">
                <div class="img-container">Recherche image…</div>
                <div class="info">${infoParts.join('')}</div>
              </div>`;
            marker.bindPopup(popupHtml, { maxWidth: 260 });

            marker.on('popupopen', async (e) => {
              try {
                const container = e.popup.getElement()?.querySelector('.img-container');
                if (!container) return;
                const url = await fetchSpeciesImage(sci);
                if (url) {
                  container.innerHTML = `<img class="popup-photo" src="${url}" alt="Photo ${escapeAttr(sci)}"/>`;
                } else {
                  container.innerHTML = '';
                }
              } catch {}
            });
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

// Utilities d'échappement HTML (sécurité XSS dans les popups)
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, '&#96;');
}

// Cache simple pour éviter de recharger plusieurs fois la même image
const speciesImageCache = new Map(); // name -> url|null

// Recherche d'une petite image d'espèce (Wikipedia FR/EN, fallback GBIF)
async function fetchSpeciesImage(scientificName) {
  if (!scientificName) return null;
  const key = scientificName.trim().toLowerCase();
  if (speciesImageCache.has(key)) return speciesImageCache.get(key);

  const tryWikiSummary = async (lang, title) => {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` + encodeURIComponent(title);
    try {
      const resp = await fetchWithCancel(url);
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.thumbnail?.source || null;
    } catch { return null; }
  };

  const tryWikiSearchThenSummary = async (lang, query) => {
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=` + encodeURIComponent(query) + `&srlimit=1&format=json&origin=*`;
    try {
      const s = await fetchWithCancel(searchUrl);
      if (!s.ok) return null;
      const sd = await s.json();
      const title = sd?.query?.search?.[0]?.title;
      if (!title) return null;
      return await tryWikiSummary(lang, title);
    } catch { return null; }
  };

  // 1) Wikipedia FR puis EN (summary direct, puis recherche)
  let img = await tryWikiSummary('fr', scientificName);
  if (!img) img = await tryWikiSummary('en', scientificName);
  if (!img) img = await tryWikiSearchThenSummary('fr', scientificName);
  if (!img) img = await tryWikiSearchThenSummary('en', scientificName);
  if (img) { speciesImageCache.set(key, img); return img; }

  // 2) Fallback GBIF: match -> speciesKey -> media
  try {
    // Trouver la clé d'espèce
    let speciesKey = null;
    try {
      const matchUrl = 'https://api.gbif.org/v1/species/match?name=' + encodeURIComponent(scientificName);
      const r = await fetchWithCancel(matchUrl);
      if (r.ok) {
        const md = await r.json();
        speciesKey = md?.usageKey || md?.speciesKey || null;
      }
    } catch {}
    if (!speciesKey) {
      const searchUrl = 'https://api.gbif.org/v1/species/search?q=' + encodeURIComponent(scientificName) + '&limit=1';
      const r2 = await fetchWithCancel(searchUrl);
      if (r2.ok) {
        const sd = await r2.json();
        speciesKey = sd?.results?.[0]?.key || null;
      }
    }
    if (speciesKey) {
      const mediaUrl = `https://api.gbif.org/v1/species/${speciesKey}/media`;
      const mr = await fetchWithCancel(mediaUrl);
      if (mr.ok) {
        const md = await mr.json();
        if (Array.isArray(md) && md.length) {
          const rec = md.find(x => (x?.type || '').toLowerCase().includes('still') || (x?.format || '').toLowerCase().includes('image')) || md[0];
          const url = rec?.identifier || rec?.references || null;
          if (url && /^https?:\/\//i.test(url)) {
            speciesImageCache.set(key, url);
            return url;
          }
        }
      }
    }
  } catch {}

  speciesImageCache.set(key, null);
  return null;
}

// getCurrentYearFilter sera défini plus bas, après la déclaration des variables du panneau date

// Gestionnaire appelé quand un sélecteur taxonomique change : met à jour les sélecteurs descendants et la carte.
// Quand un select taxo change: met à jour les descendants et relance la carte
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
// Initialise le panneau taxonomie (peuple 'kingdom' et attache les listeners)
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
// Met à jour la piste active (entre les deux années) sur le slider double
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
// Construit le filtre d'années courant (si l'utilisateur a touché les sliders)
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
// (Optionnel) Récupère des bornes d'années; ici on utilise plutôt /api/years/minmax
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
// Positionne et (ré)initialise les sliders d'années
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
// Retourne les filtres taxonomiques actifs (sélecteurs non vides)
function getCurrentTaxFilters() {
  const filters = {};
  for (const lvl of levels) {
    const val = selects[lvl]?.value || '';
    if (val) filters[lvl] = val;
  }
  return filters;
}

// Initialise le panneau des dates : récupère les bornes, configure les sliders et attache les événements.
// Initialise le panneau dates: lit /api/years/minmax puis attache les sliders
async function initDatePanel() {
  // Fallback simple: déterminer les bornes min/max depuis un échantillon si l’API year n’existe pas
  try {
    const filters = getCurrentTaxFilters();
    const params = new URLSearchParams(filters);
    const resp = await fetchWithCancel('/api/years/minmax?' + params.toString());
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}${text ? ': ' + text : ''}`);
    }
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

const DEFAULT_BIOGRID_MAXDOCS = 35000000; // borne supérieure utilisée côté serveur
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

// Palette simple: rouge (faible), orange (moyen), vert (fort)
function colorForCount(c) {
  if (c > 100) return '#28a745';      // vert
  if (c >= 50) return '#ff9800';      // orange
  return '#e53935';                  // rouge
}
// Va chercher la grille globale en cache (ou signale si calcul en cours)
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

// Dessine les cellules rectangulaires de la grille biodiversité
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

// Rafraîchit la grille biodiversité si l'overlay est actif
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

// Active/désactive l'overlay biodiversité global (grille fixe)
async function toggleBiodiversityGrid(enable) {
  bioGridActive = enable;
  if (enable) {
    await refreshBioGridGlobal();
  } else {
    if (bioGridLayer && map.hasLayer(bioGridLayer)) map.removeLayer(bioGridLayer);
  }
}

// Attacher le bouton Filtre 1 au toggle de la grille biodiversité
// Bouton de filtre rapide f1: toggle de l'overlay biodiversité
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
    updateMarkerVisibilityForFilters();
  });
})();

// ---- Masquer/Afficher les marqueurs selon l'état des filtres rapides ----
let markersAttached = true;
function showMarkersLayer() { if (!markersAttached) { markers.addTo(map); markersAttached = true; } }
function hideMarkersLayer() { if (markersAttached) { try { map.removeLayer(markers); } catch {} markersAttached = false; } }
// Y a-t-il au moins un filtre rapide actif ?
function anyQuickFilterActive() {
  return !!document.querySelector('.filter-buttons .filter-btn.active');
}
function updateMarkerVisibilityForFilters() {
  if (anyQuickFilterActive()) hideMarkersLayer(); else showMarkersLayer();
}
// Branche les autres boutons de filtres rapides (f3, f4)
(function attachOtherQuickFilters() {
  const buttons = document.querySelectorAll('.filter-buttons .filter-btn');
  buttons.forEach(btn => {
    const key = btn.getAttribute('data-filter');
    if (key === 'f1' || key === 'f2') return; // f1 et f2 sont gérés séparément
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      updateMarkerVisibilityForFilters();
    });
  });
})();

// Attacher le bouton Filtre 2 pour afficher la corrélation latitude-diversité
// Filtre rapide f2: afficher une “corrélation latitude-diversité” (mock)
(function attachLatitudeDiversityButton() {
  const btn = document.querySelector('[data-filter="f2"]');
  if (!btn) return;
  const setActive = (on) => btn.classList.toggle('active', on);
  btn.addEventListener('click', async () => {
    // On active le filtre visuellement et on affiche la corrélation
    const wasActive = btn.classList.contains('active');
    // Si déjà actif, on le désactive et restaure les marqueurs
    if (wasActive) {
      setActive(false);
      // Retirer la couche lat-div si présente
      try { if (map.hasLayer(latDivLayer)) map.removeLayer(latDivLayer); } catch {}
      latDivActive = false;
      updateMarkerVisibilityForFilters();
      if (statusDiv) statusDiv.textContent = '';
      return;
    }
    setActive(true);
    // Si la couche est vide, appeler la fonction pour la peupler
    try {
      if (!latDivLayer || latDivLayer.getLayers().length === 0) {
        await showLatitudeDiversityCorrelation();
      }
      if (!map.hasLayer(latDivLayer)) latDivLayer.addTo(map);
      latDivActive = true;
    } finally {
      // masquer les marqueurs (car le filtre rapide est actif)
      updateMarkerVisibilityForFilters();
    }
  });
})();

// ---- Positionner les panneaux à gauche : date au-dessus de documents, au-dessus de taxonomie ----
// Positionne les panneaux (gauche) en pile: date au-dessus, puis limit, puis taxonomie
(function stackLeftPanels() {
  const datePanel = document.getElementById('date-panel');
  const limitPanel = document.getElementById('limit-panel');
  const speciesPanel = document.getElementById('species-panel');
  if (!speciesPanel) return;
  const GAP = 10; // 10px d'écart
  const MARGIN = 12;

  function positionNow() {
    const speciesRect = speciesPanel.getBoundingClientRect();
    if (limitPanel) {
      const limitRect = limitPanel.getBoundingClientRect();
      const limitTop = Math.max(MARGIN, speciesRect.top - limitRect.height - GAP);
      limitPanel.style.top = `${limitTop}px`;
      limitPanel.style.left = '12px';
      limitPanel.style.right = '';
      limitPanel.style.bottom = '';
    }
    if (datePanel) {
      const dateRect = datePanel.getBoundingClientRect();
      const baseRect = (limitPanel ? limitPanel.getBoundingClientRect() : speciesRect);
      const dateTop = Math.max(MARGIN, baseRect.top - dateRect.height - GAP);
      datePanel.style.top = `${dateTop}px`;
      datePanel.style.left = '12px';
      datePanel.style.right = '';
      datePanel.style.bottom = '';
    }
  }

  positionNow();
  window.addEventListener('resize', positionNow);
  if (window.ResizeObserver) {
    try {
      const ro = new ResizeObserver(() => positionNow());
      ro.observe(speciesPanel);
      if (limitPanel) ro.observe(limitPanel);
      if (datePanel) ro.observe(datePanel);
    } catch {}
  }
})();

// ---- Repositionner le panneau de filtres : milieu de la page à droite ----
// Positionne le panneau “Filtres rapides” à droite, centré verticalement
(function moveFilterPanelFixedTopRight() {
  const filterPanel = document.getElementById('filter-panel');
  if (!filterPanel) return;
  filterPanel.style.top = '50%';
  filterPanel.style.transform = 'translateY(-50%)';
  filterPanel.style.right = '12px';
  filterPanel.style.bottom = '';
})();

// ---- Panneau 'Ajouter un document' et modal ----
// Panneau “Ajouter un document” + modal (démo minimaliste)
(function initAddPanel() {
  const addPanel = document.getElementById('add-panel');
  const modal = document.getElementById('add-modal');
  const btnClose = document.getElementById('btn-add-close');
  const btnCancel = document.getElementById('btn-add-cancel');
  const form = document.getElementById('add-form');
  const extraList = document.getElementById('extra-list');
  const btnExtraAdd = document.getElementById('btn-extra-add');

  if (!addPanel || !modal || !form) return;
  const open = () => { modal.setAttribute('aria-hidden', 'false'); };
  const close = () => { modal.setAttribute('aria-hidden', 'true'); };
  addPanel.addEventListener('click', open);
  addPanel.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  btnClose?.addEventListener('click', close);
  btnCancel?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (modal.getAttribute('aria-hidden') === 'false' && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  btnExtraAdd?.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'extra-row';
    row.innerHTML = `
      <input placeholder="Clé (ex: year)" class="extra-key" />
      <input placeholder="Valeur" class="extra-val" />
      <button type="button" class="remove">Supprimer</button>
    `;
    row.querySelector('.remove')?.addEventListener('click', () => row.remove());
    extraList?.appendChild(row);
  });

  // Parse un nombre en tolérant les virgules et espaces
  function parseLocaleNumber(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {};
    for (const [k, v] of fd.entries()) payload[k] = String(v);
    // Ajout des champs optionnels
    extraList?.querySelectorAll('.extra-row')?.forEach(row => {
      const k = row.querySelector('.extra-key')?.value?.trim();
      const v = row.querySelector('.extra-val')?.value ?? '';
      if (k) payload[k] = String(v);
    });

    // Validation/normalisation côté client des coordonnées
    const lat = parseLocaleNumber(payload.decimalLatitude);
    const lng = parseLocaleNumber(payload.decimalLongitude);
    if (lat === null || lng === null) {
      showToast('Veuillez renseigner des coordonnées numériques (latitude/longitude).', 'error');
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      showToast('Coordonnées hors bornes: latitude [-90,90], longitude [-180,180].', 'error');
      return;
    }
    payload.decimalLatitude = lat;
    payload.decimalLongitude = lng;

    showLoader();
    try {
      const resp = await fetchWithCancel('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      console.log('Document créé:', data.insertedId);
      if (statusDiv) statusDiv.textContent = 'Document ajouté';
      close();
      // Rafraîchir la carte avec les filtres courants
      await updateMapForFilters({ ...getCurrentTaxFilters(), ...getCurrentYearFilter() });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error('Erreur ajout document:', err);
      if (statusDiv) statusDiv.textContent = 'Erreur lors de l\'ajout du document';
    } finally {
      hideLoader();
    }
  });
})();



// ----- Corrélation latitude-diversité -----
// Démo: génère des points fictifs pour illustrer une corrélation lat/diversité
async function showLatitudeDiversityCorrelation() {
  showLoader();
  try {
    // Use mock data for testing
    const mockData = {
      correlation: Array.from({ length: 40 }, (_, i) => ({
        latitude: -34 + (39 * i / 39), // From -34 to 5
        diversite: Math.floor(Math.random() * 2000) // Random diversity 0-2000
      }))
    };

    // Utiliser la couche dédiée pour ne pas être affecté par la logique qui cache la couche `markers`
    latDivLayer.clearLayers();

    mockData.correlation.forEach(d => {
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
      .addTo(latDivLayer)
      .bindPopup(`Latitude ~${lat}°<br>Diversité: ${diversite}`);
    });

    const all = latDivLayer.getLayers();
    if (all.length > 0) {
      // S'assurer que la couche est affichée
      if (!map.hasLayer(latDivLayer)) latDivLayer.addTo(map);
      latDivActive = true;
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
