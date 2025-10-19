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
    client = new MongoClient(uri, {
      directConnection: true,
      connectTimeoutMS: 30000,
      serverSelectionTimeoutMS: 30000,
      // Pas de socketTimeout pour éviter d'interrompre les requêtes longues
    });
    await client.connect();
    console.log("Connecté à MongoDB");
    console.log(`URI: ${uri.replace(/:\\?[^@]*@/, ':****@')} | DB: ${dbName}`);
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


function getCollection() {
  return collection;
}

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


