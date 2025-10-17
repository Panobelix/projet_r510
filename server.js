require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Utiliser l'URI de connexion depuis l'environnement (prioritaire), sinon la construire
const dbName = process.env.MONGO_DB || process.env.MONGO_COLLECTION || "projet_bdd"; // Nom de la base
const mongoUser = process.env.MONGO_USER;
const mongoPass = process.env.MONGO_PASS;
const mongoHost = process.env.MONGO_HOST || 'localhost';
const mongoPort = process.env.MONGO_PORT || '27017';
const authSource = process.env.MONGO_AUTH_SOURCE || 'admin';

function buildMongoUri() {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;
  if (mongoUser && mongoPass) {
    const encodedPass = encodeURIComponent(mongoPass);
    return `mongodb://${mongoUser}:${encodedPass}@${mongoHost}:${mongoPort}/${dbName}?authSource=${authSource}`;
  }
  return `mongodb://${mongoHost}:${mongoPort}`;
}

const url = buildMongoUri();
let client;
let collection;
let reconnectTimer = null;
let lastMongoError = null;

async function connectToMongo(attempt = 1) {
  const maxDelay = 30000;
  const baseDelay = 3000;
  const delay = Math.min(maxDelay, baseDelay * attempt);
  try {
    client = new MongoClient(url, {
      directConnection: true,
      connectTimeoutMS: 30000,
      serverSelectionTimeoutMS: 30000,
      // Pas de socketTimeout pour éviter d'interrompre les requêtes longues
    });
    await client.connect();
    console.log("Connecté à MongoDB");
    console.log(`URI: ${url.replace(/:\\?[^@]*@/, ':****@')} | DB: ${dbName}`);
    const db = client.db(dbName);
    collection = db.collection("faune&flore");

    // Gérer les événements et tenter une reconnexion si nécessaire
    client.on?.('close', () => {
      console.warn('MongoDB: connexion fermée, tentative de reconnexion...');
      scheduleReconnect();
    });
    client.on?.('error', (e) => {
      console.error('MongoDB error:', e);
      lastMongoError = e;
    });
  } catch (err) {
    lastMongoError = err;
    console.error("Erreur de connexion à MongoDB :", err);
    scheduleReconnect(attempt + 1, delay);
  }
}

function scheduleReconnect(nextAttempt = 2, wait = 3000) {
  if (reconnectTimer) return; // éviter doublons
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToMongo(nextAttempt);
  }, wait);
}

connectToMongo();

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
    scientificName: doc.scientificName || doc.nom_scientifique || doc.name || '',
    locality: doc.locality || doc.ville || doc.commune || doc.location || '',
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

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});


// Endpoint principal: renvoie des observations filtrées (et mappées) pour la carte
app.get('/api/observations', async (req, res) => {
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const maxAllowed = 1000;
    const defaultLimit = 100;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || defaultLimit, 10) || defaultLimit, maxAllowed));
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const skip = (page - 1) * limit;

    // Filtres taxonomiques (égalité stricte)
    const taxonomyLevels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
    const query = {};
    for (const lvl of taxonomyLevels) {
      const val = req.query[lvl];
      if (val) query[lvl] = String(val);
    }

    // Filtre année (intervalle inclusif si fourni)
    const yMin = req.query.yearMin ? Number(req.query.yearMin) : null;
    const yMax = req.query.yearMax ? Number(req.query.yearMax) : null;
    if (Number.isFinite(yMin) || Number.isFinite(yMax)) {
      query.year = {};
      if (Number.isFinite(yMin)) query.year.$gte = yMin;
      if (Number.isFinite(yMax)) query.year.$lte = yMax;
    }

    const docs = await collection.find(query).skip(skip).limit(limit).toArray();
    const results = docs
      .map(mapDocToObservation)
      .filter(o => typeof o.decimalLatitude === 'number' && typeof o.decimalLongitude === 'number');
    res.json({ results, page, limit, count: results.length, matched: docs.length });
  } catch (err) {
    console.error('Erreur /api/observations :', err);
    res.status(500).send('Erreur lors de la récupération des observations.');
  }
});

// Endpoint min/max pour l'attribut 'year' selon les filtres taxonomiques courants
app.get('/api/years/minmax', async (req, res) => {
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const taxonomyLevels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
    const match = {};
    for (const lvl of taxonomyLevels) {
      const val = req.query[lvl];
      if (val) match[lvl] = String(val);
    }
    const pipeline = [
      { $match: match },
      { $group: { _id: null, min: { $min: '$year' }, max: { $max: '$year' } } },
    ];
    const agg = await collection.aggregate(pipeline).toArray();
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
  if (!collection) {
    return res.status(500).send("La connexion à la BDD n'est pas encore établie.");
  }
  try {
    const levels = ['kingdom','phylum','class','order','family','genus','species','scientificName'];
    const level = String(req.query.level || '').trim();
    if (!levels.includes(level)) {
      return res.status(400).json({ error: 'Paramètre level invalide', allowed: levels });
    }
    // Construire le filtre à partir des niveaux précédents
    const idx = levels.indexOf(level);
    const filter = {};
    for (let i = 0; i < idx; i++) {
      const prev = levels[i];
      const val = req.query[prev];
      if (val) filter[prev] = String(val);
    }
    const pipeline = [
      { $match: filter },
      { $sort: { [level]: 1 } },
      { $group: { _id: `$${level}` } },
      { $project: { value: '$_id', _id: 0 } }
    ];
    const agg = await collection.aggregate(pipeline).toArray();
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
    await client.close();
  } finally {
    process.exit(0);
  }
});