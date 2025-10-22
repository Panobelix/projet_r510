require('dotenv').config();
const express = require('express');
const path = require('path');
const { connectToMongo, getCollection, closeMongo } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json()); // JSON body parsing for future POST endpoints
app.use(express.static(__dirname));

// Démarrer la connexion Mongo en arrière-plan
connectToMongo();

// =================== Constantes ===================
const TAXO_LEVELS = ['kingdom','phylum','class','order','family','genus','species','scientificName'];

// =================== Cache de grille (globale, pré-calculée) ===================
// Clé: sizeDeg en string -> { cells, scanned, updatedAt }
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
  console.log(`[grid-cache] Démarrage calcul global sizeDeg=${key}, cap=${cap}`);
  try {
    // Requête Mongo explicite (hors endpoint mais cohérent)
    const findQuery = {
      filter: {
        decimalLatitude: { $type: 'number' },
        decimalLongitude: { $type: 'number' }
      },
      options: { projection: { _id: 0, decimalLatitude: 1, decimalLongitude: 1 } }
    };
    const cursor = collection.find(findQuery.filter, findQuery.options);
    const map = new Map();
    let scanned = 0;
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
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      scanned++;
      if (scanned > cap) break;
      const lat = doc.decimalLatitude;
      const lng = doc.decimalLongitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      const key = cellKeyFromLatLng(lat, lng);
      map.set(key, (map.get(key) || 0) + 1);

      if (scanned % LOG_EVERY === 0) {
        const now = Date.now();
        if (now - lastLog >= LOG_MS) {
          const secs = (now - t0) / 1000;
          const rate = scanned / Math.max(1, secs);
          console.log(`[grid-cache] progress scanned=${scanned} cells=${map.size} rate=${rate.toFixed(1)} doc/s elapsed=${secs.toFixed(1)}s`);
          lastLog = now;
        }
      }
    }
    const cells = [];
    for (const [k, count] of map.entries()) {
      cells.push({ key: k, count, bounds: boundsFromKey(k) });
    }
    cells.sort((a,b) => b.count - a.count);
    gridCache.set(key, { cells, scanned, updatedAt: new Date().toISOString(), capped: scanned >= cap });
    const t1 = Date.now();
    console.log(`[grid-cache] Calcul terminé sizeDeg=${key} cells=${cells.length} scanned=${scanned} time=${((t1-t0)/1000).toFixed(1)}s`);
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

// Mapping util to support multiple field names and cast to numbers
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


// Try to extract lat/lng from a generic object with varied key names
function latLngFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { lat: null, lng: null };
  const keys = Object.keys(obj);
  // map keys case-insensitive
  const get = (names) => {
    const foundKey = keys.find(k => names.includes(k.toLowerCase()));
    return foundKey !== undefined ? obj[foundKey] : undefined;
  };
  const latRaw = get(['lat','latitude','y','latitud']);
  const lngRaw = get(['lng','lon','long','longitude','x','longitud']);
  return { lat: toNumberOrNull(latRaw), lng: toNumberOrNull(lngRaw) };
}


function mapDocToObservation(doc) {
  // Try common latitude/longitude field names
  let lat = toNumberOrNull(
    doc.decimalLatitude ?? doc.latitude ?? doc.lat ?? doc.Latitude ?? doc.LAT
  );
  let lng = toNumberOrNull(
    doc.decimalLongitude ?? doc.longitude ?? doc.lon ?? doc.lng ?? doc.Longitude ?? doc.LON
  );

  // GeoJSON Point support: { location: { type: 'Point', coordinates: [lng, lat] } }
  if ((lat === null || lng === null) && doc.location && Array.isArray(doc.location.coordinates)) {
    const c = doc.location.coordinates;
    if (c.length >= 2) {
      lng = toNumberOrNull(c[0]);
      lat = toNumberOrNull(c[1]);
    }
  }
  if ((lat === null || lng === null) && doc.geometry && Array.isArray(doc.geometry.coordinates)) {
    const c = doc.geometry.coordinates;
    if (c.length >= 2) {
      lng = toNumberOrNull(c[0]);
      lat = toNumberOrNull(c[1]);
    }
  }
  // location as object with lat/lng
  if ((lat === null || lng === null) && doc.location && !Array.isArray(doc.location)) {
    const p = latLngFromObject(doc.location);
    lat = lat ?? p.lat; lng = lng ?? p.lng;
  }
  // generic nested objects: coord/coords/geo/geoloc/position/point
  const nestedCandidates = [doc.coord, doc.coords, doc.geo, doc.geoloc, doc.position, doc.point, doc.centre, doc.center];
  for (const candidate of nestedCandidates) {
    if (lat !== null && lng !== null) break;
    const p = latLngFromObject(candidate);
    if (lat === null && p.lat !== null) lat = p.lat;
    if (lng === null && p.lng !== null) lng = p.lng;
  }
  // location as string "lat,lng" or "lng,lat"
  if ((lat === null || lng === null) && typeof doc.location === 'string') {
    const parts = doc.location.split(/\s*,\s*/);
    if (parts.length >= 2) {
      const a0 = toNumberOrNull(parts[0]);
      const a1 = toNumberOrNull(parts[1]);
      if (a0 !== null && a1 !== null) {
        if (Math.abs(a0) <= 90 && Math.abs(a1) <= 180) { lat = a0; lng = a1; }
        else { lng = a0; lat = a1; }
      }
    }
  }
  // Generic arrays: coordinates/coord/coords possibly [lat, lng] or [lng, lat]
  const arr = doc.coordinates || doc.coord || doc.coords;
  if ((lat === null || lng === null) && Array.isArray(arr) && arr.length >= 2) {
    const a0 = toNumberOrNull(arr[0]);
    const a1 = toNumberOrNull(arr[1]);
    if (a0 !== null && a1 !== null) {
      // Heuristic: if first looks like latitude (<=90), assume [lat, lng], else [lng, lat]
      if (Math.abs(a0) <= 90 && Math.abs(a1) <= 180) {
        lat = a0; lng = a1;
      } else {
        lng = a0; lat = a1;
      }
    }
  }

  return {
    decimalLatitude: lat,
    decimalLongitude: lng,
    scientificName: doc.scientificName,
    locality: doc.locality,
    year: doc.year ?? null,
    countryCode: doc.countryCode ?? null,
    _id: doc._id,
    __rawFields: undefined,
  };
}


/*
 * *************************
 * ******** ROUTES *********
 * *************************
 */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint principal: renvoie des observations filtrées (et mappées) pour la carte
app.get('/api/observations', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
  // Aucune limite imposée côté serveur: géré par le slider (limit) côté client.
  const limitParam = parseInt(req.query.limit, 10);
  const hasLimit = Number.isFinite(limitParam) && limitParam > 0;
  const limit = hasLimit ? limitParam : undefined;

    // Requête Mongo explicite (style mongosh)
    const taxonomyLevels = TAXO_LEVELS;
    const findQuery = {
      filter: (() => {
        const f = {};
        for (const lvl of taxonomyLevels) {
          const val = req.query[lvl];
          if (val) f[lvl] = String(val);
        }
        const yMin = req.query.yearMin ? Number(req.query.yearMin) : null;
        const yMax = req.query.yearMax ? Number(req.query.yearMax) : null;
        if (Number.isFinite(yMin) || Number.isFinite(yMax)) {
          f.year = {};
          if (Number.isFinite(yMin)) f.year.$gte = yMin;
          if (Number.isFinite(yMax)) f.year.$lte = yMax;
        }
        return f;
      })(),
      options: {
        projection: {
          // champs utiles pour la carte/popup + diverses variantes pour coordonnées
          decimalLatitude: 1, decimalLongitude: 1,
          scientificName: 1,
          // champs nécessaires pour popup
          year: 1,
          locality: 1, ville: 1, commune: 1, location: 1,
          countryCode: 1
        }
      }
    };

    const cursor = collection.find(findQuery.filter, findQuery.options);
    const results = [];
    let scanned = 0;
    // Itérer tant qu'on n'a pas trouvé le nombre demandé d'observations avec coordonnées valides
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      scanned++;
      const obs = mapDocToObservation(doc);
      if (typeof obs.decimalLatitude === 'number' && typeof obs.decimalLongitude === 'number') {
        results.push(obs);
      }
      if (hasLimit && results.length >= limit) break;
    }
    res.json({ results, limit: hasLimit ? limit : null, count: results.length, scanned });
  } catch (err) {
    console.error('Erreur /api/observations :', err);
    res.status(500).send('Erreur lors de la récupération des observations.');
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

// Endpoint d'agrégation serveur: renvoie des cellules de grille (compte de points) dans un bbox
// GET /api/coords/grid?south=&west=&north=&east=&sizeDeg=1.0&maxDocs=300000&...filtres
app.get('/api/coords/grid', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    // BBox normalisé
    const south = Number(req.query.south ?? -90);
    const west = Number(req.query.west ?? -180);
    const north = Number(req.query.north ?? 90);
    const east = Number(req.query.east ?? 180);
    const hasBbox = [south, west, north, east].every(Number.isFinite) && south <= north && west <= east;

    // Taille de cellule (degrés)
    let sizeDeg = Number(req.query.sizeDeg ?? 1.0);
    if (!Number.isFinite(sizeDeg) || sizeDeg <= 0) sizeDeg = 1.0;
    // clamp raisonnable
    sizeDeg = Math.max(0.005, Math.min(sizeDeg, 10));

        // Cap du nombre de documents à parcourir
        let maxDocs = Number(req.query.maxDocs ?? 35000000);
        if (!Number.isFinite(maxDocs) || maxDocs <= 0) maxDocs = 35000000;

    // Filtres taxonomiques (voir findQuery ci-dessous pour application effective)
    // Filtre année
    const yMin = req.query.yearMin ? Number(req.query.yearMin) : null;
    const yMax = req.query.yearMax ? Number(req.query.yearMax) : null;
    if (Number.isFinite(yMin) || Number.isFinite(yMax)) {
      match.year = {};
      if (Number.isFinite(yMin)) match.year.$gte = yMin;
      if (Number.isFinite(yMax)) match.year.$lte = yMax;
    }

  // Requête Mongo explicite (projection inline et filtre construit dynamiquement)
  const findQuery = {
    filter: (() => {
      const f = {};
      // Filtres taxonomiques
      for (const lvl of TAXO_LEVELS) {
        const val = req.query[lvl];
        if (val) f[lvl] = String(val);
      }
      // Types numériques requis
      f.decimalLatitude = { ...(f.decimalLatitude || {}), $type: 'number' };
      f.decimalLongitude = { ...(f.decimalLongitude || {}), $type: 'number' };
      // Filtre année
      const yMin = req.query.yearMin ? Number(req.query.yearMin) : null;
      const yMax = req.query.yearMax ? Number(req.query.yearMax) : null;
      if (Number.isFinite(yMin) || Number.isFinite(yMax)) {
        f.year = {};
        if (Number.isFinite(yMin)) f.year.$gte = yMin;
        if (Number.isFinite(yMax)) f.year.$lte = yMax;
      }
      // BBox
      if (hasBbox) {
        f.decimalLatitude.$gte = south;
        f.decimalLatitude.$lte = north;
        f.decimalLongitude.$gte = west;
        f.decimalLongitude.$lte = east;
      }
      return f;
    })(),
    options: { projection: { _id: 0, decimalLatitude: 1, decimalLongitude: 1, year: 1 } }
  };
  const cursor = collection.find(findQuery.filter, findQuery.options);
  const t0 = Date.now();
  let lastLog = t0;
  const LOG_EVERY = 100000;
  const LOG_MS = 3000;

    // Agrégation côté Node
    const map = new Map(); // key -> count
    let scanned = 0;
    // utilitaires
    const cellKeyFromLatLng = (lat, lng) => {
      const i = Math.floor((lat + 90) / sizeDeg);
      const j = Math.floor((lng + 180) / sizeDeg);
      return `${i}:${j}`;
    };
    const boundsFromKey = (key) => {
      const [iStr, jStr] = key.split(':');
      const i = Number(iStr); const j = Number(jStr);
      const lat0 = -90 + i * sizeDeg;
      const lat1 = lat0 + sizeDeg;
      const lng0 = -180 + j * sizeDeg;
      const lng1 = lng0 + sizeDeg;
      return [[lat0, lng0], [lat1, lng1]];
    };

    // Itérer en flux pour éviter l'explosion mémoire
    // Utiliser for await si supporté
    // eslint-disable-next-line no-restricted-syntax
    for await (const doc of cursor) {
      scanned++;
      if (scanned > maxDocs) break;
      const lat = doc.decimalLatitude;
      const lng = doc.decimalLongitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (hasBbox) {
        if (lat < south || lat > north || lng < west || lng > east) continue;
      }
      const key = cellKeyFromLatLng(lat, lng);
      map.set(key, (map.get(key) || 0) + 1);

      if (scanned % LOG_EVERY === 0) {
        const now = Date.now();
        if (now - lastLog >= LOG_MS) {
          const secs = (now - t0) / 1000;
          const rate = scanned / Math.max(1, secs);
          console.log(`[grid-endpoint] progress scanned=${scanned} cells=${map.size} rate=${rate.toFixed(1)} doc/s elapsed=${secs.toFixed(1)}s sizeDeg=${sizeDeg}${hasBbox ? ' bbox' : ''}`);
          lastLog = now;
        }
      }
    }

    const cells = [];
    for (const [key, count] of map.entries()) {
      cells.push({ key, count, bounds: boundsFromKey(key) });
    }
    cells.sort((a,b) => b.count - a.count);
    const t1 = Date.now();
    console.log(`[grid-endpoint] done scanned=${scanned} cells=${cells.length} capped=${scanned>=maxDocs} time=${((t1-t0)/1000).toFixed(1)}s sizeDeg=${sizeDeg}${hasBbox ? ' bbox' : ''}`);
    res.json({
      bbox: { south, west, north, east },
      sizeDeg,
      cells,
      scanned,
      capped: scanned >= maxDocs
    });
  } catch (err) {
    console.error('Erreur /api/coords/grid :', err);
    res.status(500).send('Erreur lors de l\'agrégation de la grille.');
  }
});

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
app.get('/api/years/minmax', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const pipeline = [
      { $match: (() => {
        const m = {};
        for (const lvl of ['kingdom','phylum','class','order','family','genus','species','scientificName']) {
          const val = req.query[lvl];
          if (val) m[lvl] = String(val);
        }
        return m;
      })() },
      { $group: { _id: null, min: { $min: '$year' }, max: { $max: '$year' } } },
      /* faire en sorte que ca prenne aussi les champs eventdate si year absent */
    ];
    // Requête Mongo explicite
    const aggregateQuery = { pipeline };
    const agg = await collection.aggregate(aggregateQuery.pipeline).toArray();
    if (!agg.length || agg[0].min === undefined || agg[0].max === undefined) {
      return res.json({ minYear: null, maxYear: null });
    }
    res.json({ minYear: agg[0].min, maxYear: agg[0].max });
  } catch (err) {
    console.error('Erreur /api/years/minmax :', err);
    res.status(500).send('Erreur lors du calcul des bornes année.');
  }
});

// Endpoint pour récupérer les valeurs distinctes d'un niveau taxonomique, avec filtres amont (égalité stricte)
app.get('/api/taxonomy/values', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const level = String(req.query.level || '').trim();
    if (!TAXO_LEVELS.includes(level)) {
      return res.status(400).json({ error: 'Paramètre level invalide', allowed: TAXO_LEVELS });
    }
    // Construire le pipeline avec filtre inline (style mongosh)
    const idx = TAXO_LEVELS.indexOf(level);
    const pipeline = [
      { $match: (() => {
        const f = {};
        for (let i = 0; i < idx; i++) {
          const prev = TAXO_LEVELS[i];
          const val = req.query[prev];
          if (val) f[prev] = String(val);
        }
        return f;
      })() },
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

// Fermeture propre
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
  console.log('Routes disponibles: /, /api/observations, /api/coords, /api/coords/grid, /api/years/minmax, /api/taxonomy/values');
});




// Endpoint : corrélation latitude-diversité
app.get('/api/correlation/latitude-diversite', async (req, res) => {
  const collection = getCollection();
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }

  try {
    const SAMPLE_SIZE = 200000; 
    const BINSIZE = 5;

    const pipeline = [
      { $sample: { size: SAMPLE_SIZE } },
      { $project: { latitude: '$decimalLatitude', name: '$scientificName' } },
      { $match: { latitude: { $type: 'number' }, name: { $exists: true, $ne: '' } } },
      {
        $project: {
          latBin: { $multiply: [{ $floor: { $divide: ['$latitude', BINSIZE] } }, BINSIZE] },
          name: 1
        }
      },
      {
        $group: {
          _id: '$latBin',
          species: { $addToSet: '$name' }
        }
      },
      {
        $project: {
          latitude: '$_id',
          diversite: { $size: '$species' },
          _id: 0
        }
      },
      { $sort: { latitude: 1 } }
    ];

    const cursor = collection.aggregate(pipeline, { allowDiskUse: true });
    const data = await cursor.toArray();
    res.json({ correlation: data, sampled: SAMPLE_SIZE });
  } catch (err) {
    console.error('Erreur /api/correlation/latitude-diversite :', err);
    res.status(500).send('Erreur lors du calcul de la corrélation latitude-diversité.');
  }
});