/**
 * Serveur Express de visualisation biodiversité (Brésil)
 * ------------------------------------------------------
 * - Sert l'UI statique (Leaflet + panneaux)
 * - Expose des API optimisées MongoDB pour:
 *   - /api/observations: requête dynamique (taxonomie + année + tri + limit)
 *   - /api/coords: coordonnées simples (utilitaires)
 *   - /api/years/minmax: bornes rapides des années sous filtres taxo
 *   - /api/taxonomy/values: valeurs distinctes d’un niveau (cascade)
 *
 * Notes d’implémentation:
 * - Les perfs reposent sur des index composés ESR (Égalité → Sort → Range)
 *   créés au démarrage (voir db.js). Pas de hints forcés (sauf min/max year).
 * - On garde les champs canoniques (decimalLatitude, decimalLongitude, scientificName,
 *   locality, countryCode, year) pour simplifier et fiabiliser les tris/filters.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const { connectToMongo, getCollection, closeMongo } = require('./db');

const app = express();
const PORT = process.env.PORT || 3005;

// Sert tous les fichiers statiques depuis le dossier courant (index.html, script.js, styles.css, img/)
app.use(express.static(__dirname));
// Parseur JSON pour les POST (ajout de document)
app.use(express.json({ limit: '1mb' }));

// Démarrer la connexion Mongo en arrière-plan (reconnexion automatique gérée dans db.js)
connectToMongo();

// =================== Cache de grille (globale, pré-calculée) ===================
// Objectif: calculer périodiquement une grille de richesse spécifique (nb d'espèces distinctes
// par cellule) côté serveur pour offrir une superposition instantanée.
// Structure: clé sizeDeg (string) -> { cells, scanned, updatedAt, capped, metric: 'speciesRichness' }
const gridCache = new Map();
let isComputingCache = false;

async function computeGlobalGrid(sizeDeg = 0.25, cap = 35000000) {
  const collection = getCollection();
  if (!collection) {
    console.warn('[grid-cache] Collection indisponible, report du calcul');
    return false;
  }
  if (isComputingCache) {
    console.log('[grid-cache] Calcul déjà en cours, skip');
    return false;
  }
  isComputingCache = true;
  const key = String(sizeDeg);
  console.log(`[grid-cache] Démarrage calcul global (richesse spécifique) sizeDeg=${key}, cap=${cap}`);
  try {
    // Requête Mongo: ne récupérer que les docs avec coords numériques (projection minimale)
    const findQuery = {
      filter: {
        decimalLatitude: { $type: 'number' },
        decimalLongitude: { $type: 'number' }
      },
      options: { projection: { _id: 0, decimalLatitude: 1, decimalLongitude: 1, scientificName: 1 } }
    };
    const cursor = collection.find(findQuery.filter, findQuery.options);
    // Map cellule -> Set de hash d'espèces distinctes (scientificName)
    const uniq = new Map();
    let scanned = 0;
    // Fonctions utilitaires de discrétisation et de géométrie
    const cellKeyFromLatLng = (lat, lng) => {
      const i = Math.floor((lat + 90) / sizeDeg);
      const j = Math.floor((lng + 180) / sizeDeg);
      return `${i}:${j}`;
    };
    const boundsFromKey = (k) => {
      const [iStr, jStr] = k.split(':');
      const i = Number(iStr); const j = Number(jStr);
      const lat0 = -90 + i * sizeDeg;
      const lng0 = -180 + j * sizeDeg;
      return [[lat0, lng0], [lat0 + sizeDeg, lng0 + sizeDeg]];
    };
    const t0 = Date.now();
    let lastLog = t0;
    const LOG_EVERY = 200000; // fréquence de logs en documents
    const LOG_MS = 3000; // et/ou toutes les 3s
    // Hash 53-bit rapide pour réduire l'empreinte mémoire vs strings
    const hash53 = (s) => {
      let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
      for (let i = 0, ch; i < s.length; i++) {
        ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      h1 = (h1 ^ (h2 >>> 16)) >>> 0;
      h2 = (h2 ^ (h1 >>> 16)) >>> 0;
      return (h2 * 0x200000 + (h1 >>> 11)) * 1 + (h1 & 0x7ff);
    };
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      scanned++;
      if (scanned > cap) break;
      const lat = doc.decimalLatitude;
      const lng = doc.decimalLongitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      const sn = typeof doc.scientificName === 'string' ? doc.scientificName.trim().toLowerCase() : '';
      if (!sn) continue; // on ne compte que les espèces identifiées
      const key = cellKeyFromLatLng(lat, lng);
      let set = uniq.get(key);
      if (!set) { set = new Set(); uniq.set(key, set); }
      set.add(hash53(sn));

      if (scanned % LOG_EVERY === 0) {
        const now = Date.now();
        if (now - lastLog >= LOG_MS) {
          const secs = (now - t0) / 1000;
          const rate = scanned / Math.max(1, secs);
          console.log(`[grid-cache] progress scanned=${scanned} cells=${uniq.size} rate=${rate.toFixed(1)} doc/s elapsed=${secs.toFixed(1)}s`);
          lastLog = now;
        }
      }
    }
    const cells = [];
    for (const [k, set] of uniq.entries()) {
      cells.push({ key: k, count: set.size, bounds: boundsFromKey(k) });
    }
    cells.sort((a,b) => b.count - a.count);
    gridCache.set(key, { cells, scanned, updatedAt: new Date().toISOString(), capped: scanned >= cap, metric: 'speciesRichness' });
    const t1 = Date.now();
    console.log(`[grid-cache] Calcul terminé (richesse spécifique) sizeDeg=${key} cells=${cells.length} scanned=${scanned} time=${((t1-t0)/1000).toFixed(1)}s`);
    return true;
  } catch (e) {
    console.error('[grid-cache] Erreur calcul:', e);
    return false;
  } finally {
    isComputingCache = false;
  }
}

// Lancer un warm-up au démarrage (après un petit délai pour laisser Mongo se connecter)
setTimeout(() => { computeGlobalGrid(0.25, 35000000); }, 5000);
// Recalcul périodique: toutes les heures
setInterval(() => { computeGlobalGrid(0.25, 35000000); }, 60 * 60 * 1000);

// Mapping util: cast robuste vers number (gère string, virgule, etc.)
function toNumberOrNull(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return null;
  if (typeof v === 'string') {
    const cleaned = v.trim().replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}


// Normalise un document Mongo en observation “canonique” pour la carte
function mapDocToObservation(doc) {
  // Simplified mapping: only accept decimalLatitude/decimalLongitude, scientificName, locality, countryCode, year
  const lat = toNumberOrNull(doc.decimalLatitude);
  const lng = toNumberOrNull(doc.decimalLongitude);
  const scientificName = doc.scientificName || '';
  const locality = doc.locality || '';
  const countryCode = doc.countryCode || '';
  const year = (typeof doc.year === 'number' || typeof doc.year === 'string') ? doc.year : undefined;
  return {
    decimalLatitude: lat,
    decimalLongitude: lng,
    scientificName,
    locality,
    countryCode,
    year,
    _id: doc._id,
    __rawFields: undefined,
  };
}


/**
 * *************************
 * ******** ROUTES *********
 * *************************
 */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint de debug pour vérifier le fichier réellement servi

// (app.listen déplacé en bas du fichier après la déclaration de toutes les routes)


// Endpoint principal: renvoie des observations filtrées (et mappées) pour la carte
// - Filtres: égalités taxo (kingdom..scientificName), plage year, coords numériques
// - Tri: _id | decimalLongitude | decimalLatitude | year
// - Limit: borne le nombre de documents renvoyés
app.get('/api/observations', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {

  // Récupération de la limite de documents et vérification de la validité de la valeur
  const limitParam = parseInt(req.query.limit, 10);
  const hasLimit = Number.isFinite(limitParam) && limitParam > 0;
  const limit = hasLimit ? limitParam : undefined;

    // Requête Mongo explicite (style mongosh)
    const taxonomyLevels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
  const sortField = String(req.query.sortField || '_id').trim();
  const sortDirStr = String(req.query.sortDir || 'asc').trim().toLowerCase();
  const sortDir = sortDirStr === 'desc' ? -1 : 1;
  const taxFiltersCount = taxonomyLevels.reduce((n,lvl)=> n + (req.query[lvl] ? 1 : 0), 0);
  const hasTaxFilters = taxFiltersCount > 0;
  const qYearMin = req.query.yearMin ? Number(req.query.yearMin) : null;
  const qYearMax = req.query.yearMax ? Number(req.query.yearMax) : null;
  const hasYearFilter = Number.isFinite(qYearMin) || Number.isFinite(qYearMax);
    const explainRequested = (() => {
      const v = String(req.query.explain || '').trim().toLowerCase();
      return v === '1' || v === 'true';
    })();

    // Construire la requête “style mongosh”: filter + options (projection, sort, limit)
    const findQuery = {
      filter: (() => {
        const f = {};
        for (const lvl of taxonomyLevels) {
          const val = req.query[lvl];
          if (val) f[lvl] = String(val);
        }
        const yMin = qYearMin;
        const yMax = qYearMax;
        if (Number.isFinite(yMin) || Number.isFinite(yMax)) {
          f.year = {};
          if (Number.isFinite(yMin)) f.year.$gte = yMin;
          if (Number.isFinite(yMax)) f.year.$lte = yMax;
        }
        // Tous les documents retournés doivent avoir des coordonnées numériques
        f.decimalLatitude = { ...(f.decimalLatitude || {}), $type: 'number' };
        f.decimalLongitude = { ...(f.decimalLongitude || {}), $type: 'number' };
        return f;
      })(),
      options: {
        projection: {
          // champs utiles pour la carte/popup (format unifié)
          decimalLatitude: 1,
          decimalLongitude: 1,
          scientificName: 1,
          locality: 1,
          countryCode: 1,
          year: 1
        },
        sort: (() => {
          // Autoriser uniquement quelques champs contrôlés; pas de $natural
          const allowed = new Set(['_id','decimalLongitude','decimalLatitude','year']);
          if (allowed.has(sortField)) {
            return { [sortField]: sortDir };
          }
          return { _id: sortDir };
        })(),
        // Donner un indice au planificateur pour utiliser l'index si pertinent
        hint: undefined,
        allowDiskUse: true,
        limit: (hasLimit && Number.isFinite(limit)) ? limit : undefined
      }
    };

    // Optionnel: fournir un plan pour diagnostiquer l'utilisation de l'index (debug UI: explain=1)
    let planSummary = null;
    if (explainRequested) {
      try {
        const explain = await collection.find(findQuery.filter, { ...findQuery.options, limit: 0 }).explain('executionStats');
        const qp = explain?.queryPlanner;
        const es = explain?.executionStats;
        const winning = qp?.winningPlan || null;
        // Extraire un indexName si présent dans le plan
        const extractIndexName = (node) => {
          if (!node || typeof node !== 'object') return null;
          if (node.indexName) return node.indexName;
          return extractIndexName(node.inputStage) || extractIndexName(node.inputStages?.[0]) || null;
        };
        planSummary = {
          indexHint: findQuery.options.hint || null,
          winningPlan: winning ? { stage: winning.stage || winning?.inputStage?.stage || undefined, indexName: extractIndexName(winning) } : null,
          totalDocsExamined: es?.totalDocsExamined,
          totalKeysExamined: es?.totalKeysExamined,
          executionTimeMillis: es?.executionTimeMillis,
        };
      } catch (e) {
        planSummary = { error: String(e?.message || e) };
      }
    }

    // Chemin standard: laisser Mongo exécuter tri + limit (les indexes couvrent les cas courants)
    const results = [];
    let scanned = 0;
    const cursor = collection.find(findQuery.filter, findQuery.options);
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      scanned++;
      const obs = mapDocToObservation(doc);
      if (typeof obs.decimalLatitude === 'number' && typeof obs.decimalLongitude === 'number') {
        results.push(obs);
      }
      if (hasLimit && results.length >= limit) break;
    }
    res.json({ results, limit: hasLimit ? limit : null, count: results.length, scanned, plan: planSummary, windowedByYear: false });
  } catch (err) {
    console.error('Erreur /api/observations :', err);
    res.status(500).send('Erreur lors de la récupération des observations.');
  }
});

// Création d'un document (ajout depuis l'UI)
// Body attendu: JSON arbitraire mais on normalise quelques champs canoniques
// - decimalLatitude / decimalLongitude: convertis en Number et requis
// - year: converti en Number si fourni
// Réponse: { insertedId }
app.post('/api/documents', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const body = req.body || {};
    // Cloner l'objet et normaliser quelques champs
    const doc = { ...body };
    // Champs numériques canoniques
    if (doc.decimalLatitude !== undefined) doc.decimalLatitude = toNumberOrNull(doc.decimalLatitude);
    if (doc.decimalLongitude !== undefined) doc.decimalLongitude = toNumberOrNull(doc.decimalLongitude);
    if (doc.year !== undefined && doc.year !== null && doc.year !== '') {
      const y = Number(String(doc.year).trim());
      doc.year = Number.isFinite(y) ? y : doc.year; // si non num, on laisse tel quel
    }
    // Validation minimale: coords numériques requises
    if (typeof doc.decimalLatitude !== 'number' || typeof doc.decimalLongitude !== 'number') {
      return res.status(400).json({ error: 'Champs decimalLatitude et decimalLongitude numériques requis.' });
    }
    // Hygiène basique sur quelques strings
    const strFields = ['kingdom','phylum','class','order','family','genus','species','infraspecificEpithet','taxonRank','scientificName','verbatimScientificName','countryCode','locality'];
    for (const f of strFields) {
      if (doc[f] !== undefined && doc[f] !== null) {
        doc[f] = String(doc[f]).trim();
      }
    }
    // Insertion
    const result = await collection.insertOne(doc);
    return res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error('Erreur /api/documents (POST) :', err);
    return res.status(500).send("Erreur lors de l'ajout du document.");
  }
});

// Nouveau endpoint: renvoie uniquement les coordonnées (et nom) de tous les documents ayant des coordonnées valides
app.get('/api/coords', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const isUnlimited = (String(req.query.unlimited || '').toLowerCase() === '1' || String(req.query.unlimited || '').toLowerCase() === 'true');
    const maxAllowed = 1000;
    const defaultLimit = 1000;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || defaultLimit, 10) || defaultLimit, maxAllowed));
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const skip = (page - 1) * limit;

    // Requête Mongo explicite (limité aux champs numériques requis)
    const findQuery = {
      filter: (() => ({
        decimalLatitude: { $type: 'number' },
        decimalLongitude: { $type: 'number' }
      }))(),
      options: { projection: { _id: 0, decimalLatitude: 1, decimalLongitude: 1 } }
    };
    const cursor = collection.find(findQuery.filter, findQuery.options);
    if (!isUnlimited) {
      cursor.skip(skip).limit(limit);
    }
    const docs = await cursor.toArray();
    const results = docs
      .filter(d => typeof d.decimalLatitude === 'number' && typeof d.decimalLongitude === 'number')
      .map(d => ({ lat: d.decimalLatitude, lng: d.decimalLongitude }));
    res.json({ results, page: isUnlimited ? 1 : page, limit: isUnlimited ? results.length : limit, count: results.length, unlimited: isUnlimited });
  } catch (err) {
    console.error('Erreur /api/coords :', err);
    res.status(500).send('Erreur lors de la récupération des coordonnées.');
  }
});

// NOTE: L'endpoint dynamique /api/coords/grid a été retiré (non utilisé). La grille globale
// en cache /api/coords/grid/cached reste disponible et calcule désormais la richesse spécifique.

// Endpoint cache: renvoie la grille globale pré-calculée (ou statut en cours)
// GET /api/coords/grid/cached?sizeDeg=0.25
app.get('/api/coords/grid/cached', async (req, res) => {
  const sizeDeg = Number(req.query.sizeDeg ?? 0.25);
  const key = String(Number.isFinite(sizeDeg) && sizeDeg > 0 ? sizeDeg : 0.25);
  const item = gridCache.get(key);
  if (item) {
    return res.json({
      cached: true,
      sizeDeg: Number(key),
      ...item
    });
  }
  // Pas dans le cache: ne pas déclencher le calcul ici; reporter le statut
  return res.json({ cached: false, computing: isComputingCache, sizeDeg: Number(key) });
});

// Endpoint min/max pour l'attribut 'year' selon les filtres taxonomiques courants
// - Deux requêtes indexées ultra-rapides (tri asc/desc + limit 1) avec hint { year: 1 }
app.get('/api/years/minmax', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    // Construction du filtre (égalité stricte sur niveaux taxonomiques) + 'year' numérique
    const levels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
    const filter = {};
    for (const lvl of levels) {
      const val = req.query[lvl];
      if (val) filter[lvl] = String(val);
    }
    filter.year = { $type: 'number' };

    // Stratégie ultra-rapide: deux recherches indexées avec tri et limite 1
    // Utilise l'index { year: 1 } si présent (créé au démarrage)
  const findOptsAsc = { projection: { _id: 0, year: 1 }, sort: { year: 1 }, hint: { year: 1 } };
  const findOptsDesc = { projection: { _id: 0, year: 1 }, sort: { year: -1 }, hint: { year: 1 } };

    const [minDoc] = await collection.find(filter, findOptsAsc).limit(1).toArray();
    const [maxDoc] = await collection.find(filter, findOptsDesc).limit(1).toArray();
    const minYear = minDoc?.year ?? null;
    const maxYear = maxDoc?.year ?? null;
    return res.json({ minYear, maxYear });
  } catch (err) {
    console.error('Erreur /api/years/minmax :', err);
    res.status(500).send('Erreur lors du calcul des bornes année.');
  }
});

// Endpoint pour récupérer les valeurs distinctes d'un niveau taxonomique, avec filtres amont (égalité stricte)
// - Pipeline compact: $match (contraintes amont) -> $sort -> $group -> $project
app.get('/api/taxonomy/values', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const levels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
    const level = String(req.query.level || '').trim();
    if (!levels.includes(level)) {
      return res.status(400).json({ error: 'Paramètre level invalide', allowed: levels });
    }
    // Construire le pipeline avec filtre inline (style mongosh)
    const idx = levels.indexOf(level);
    const pipeline = [
      { $match: (() => {
        const f = {};
        for (let i = 0; i < idx; i++) {
          const prev = levels[i];
          const val = req.query[prev];
          if (val) f[prev] = String(val);
        }
        return f;
      })() },
      { $sort: { [level]: 1 } },
      { $group: { _id: `$${level}` } },
      { $project: { value: '$_id', _id: 0 } }
    ];
    // Requête Mongo explicite
    const aggregateQuery = { pipeline };
    const agg = await collection.aggregate(aggregateQuery.pipeline).toArray();
    const values = agg.map(d => d.value);
    const cleaned = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(v => String(v));
    cleaned.sort((a,b) => a.localeCompare(b));
    res.json({ level, values: cleaned });
  } catch (err) {
    console.error('Erreur /api/taxonomy/values :', err);
    res.status(500).send('Erreur lors de la récupération des valeurs taxonomiques.');
  }
});

// Fermeture propre (SIGINT Ctrl+C): fermeture Mongo avant exit
process.on('SIGINT', async () => {
  console.log('Arrêt du serveur...');
  try {
    await closeMongo();
  } finally {
    process.exit(0);
  }
});

// Démarrage du serveur une fois toutes les routes enregistrées
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});