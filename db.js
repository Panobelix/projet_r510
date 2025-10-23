/**
 * Connexion MongoDB + Indexation
 * -------------------------------
 * - Gère la connexion (reconnexion exponentielle au besoin)
 * - Expose la collection principale
 * - Crée les index nécessaires aux requêtes dynamiques (ESR)
 *   Familles:
 *   1) Simples: decimalLongitude, decimalLatitude, year (+ lon-lat de base)
 *   2) Taxonomie -> Tri: égalités taxo en tête puis champ de tri
 *   3) Taxonomie -> Tri -> Year: ESR complet pour plage d'années
 *   4) Taxonomie -> Year: tri par année avec égalités taxo
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const dbName = process.env.MONGO_DB || process.env.MONGO_COLLECTION || "projet_bdd";
const uri = process.env.MONGO_URI;
let client;
let collection;
let reconnectTimer = null;
let lastMongoError = null;

async function connectToMongo(attempt = 1) {
  const maxDelay = 30000;
  const baseDelay = 3000;
  const delay = Math.min(maxDelay, baseDelay * attempt);
  try {
    // Configuration client: connexion directe, timeouts raisonnables
    client = new MongoClient(uri, {
      directConnection: true,
      connectTimeoutMS: 30000,
      serverSelectionTimeoutMS: 30000,
    });

    await client.connect();
    console.log("Connecté à MongoDB");
    const db = client.db(dbName);
  collection = db.collection("faune&flore"); // NOTE: nom de collection avec & (valide pour Mongo)

    // Assurer des index utiles pour les tris/filtrages fréquents
    try {
      // 1) Index simples utiles (tri rapide sans year/taxo + utilitaires)
      await Promise.all([
        collection.createIndex({ decimalLongitude: 1 }, { name: 'idx_decimalLongitude_1' }).catch(() => {}),
        collection.createIndex({ decimalLatitude: 1 }, { name: 'idx_decimalLatitude_1' }).catch(() => {}),
        collection.createIndex({ year: 1 }, { name: 'idx_year_1' }).catch(() => {}),
        // Index composés de base
        collection.createIndex({ decimalLongitude: 1, decimalLatitude: 1 }, { name: 'idx_lon1_lat1' }).catch(() => {}),
        collection.createIndex({ decimalLatitude: 1, decimalLongitude: 1 }, { name: 'idx_lat1_lon1' }).catch(() => {})
      ]);

      // 2) Famille "Taxonomie -> Tri" (Egalité -> Tri)
      // Hypothèse: sélection hiérarchique côté UI (pas de trous), ce qui autorise cette chaîne.
      await Promise.all([
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, _id: 1 },
          { name: 'idx_taxo_all__id_1' }
        ).catch(() => {}),
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, decimalLongitude: 1 },
          { name: 'idx_taxo_all_lon_1', partialFilterExpression: { decimalLongitude: { $type: 'number' } } }
        ).catch(() => {}),
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, decimalLatitude: 1 },
          { name: 'idx_taxo_all_lat_1', partialFilterExpression: { decimalLatitude: { $type: 'number' } } }
        ).catch(() => {})
      ]);

      // 3) Famille "Taxonomie -> Tri -> Plage(year)" (ESR complet) pour les requêtes avec filtre d'année
      await Promise.all([
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, _id: 1, year: 1 },
          { name: 'idx_taxo_all__id_1_year_1' }
        ).catch(() => {}),
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, decimalLongitude: 1, year: 1 },
          { name: 'idx_taxo_all_lon_1_year_1', partialFilterExpression: { decimalLongitude: { $type: 'number' } } }
        ).catch(() => {}),
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, decimalLatitude: 1, year: 1 },
          { name: 'idx_taxo_all_lat_1_year_1', partialFilterExpression: { decimalLatitude: { $type: 'number' } } }
        ).catch(() => {}),
        // Support de tri par 'year' quand égalités taxo présentes
        collection.createIndex(
          { kingdom: 1, phylum: 1, class: 1, order: 1, family: 1, genus: 1, species: 1, scientificName: 1, year: 1 },
          { name: 'idx_taxo_all_year_1' }
        ).catch(() => {})
      ]);

      console.log('Indexes ensured (simples + taxo->tri + taxo->tri->year + taxo->year)');
    } catch (e) {
      console.warn('Index ensure failed (non-bloquant):', e?.message || e);
    }

    // Logs de cycle de vie pour diagnostiquer la connectivité
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

// Planifie une reconnexion avec délai (anti-boucle frénétique)
function scheduleReconnect(nextAttempt = 2, wait = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToMongo(nextAttempt);
  }, wait);
}

// Expose la collection active (null tant que non connectée)
function getCollection() {
  return collection;
}

// Ferme proprement le client Mongo
async function closeMongo() {
  try {
    if (client) {
      await client.close();
    }
  } catch (e) {
    console.error('Erreur lors de la fermeture de MongoDB:', e);
  } finally {
    client = null;
    collection = null;
  }
}

module.exports = { connectToMongo, getCollection, closeMongo };


