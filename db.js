require('dotenv').config();
const { MongoClient } = require('mongodb');
const uri = process.env.MONGO_URI;
const dbName = 'projet_bdd';

let client;
let db;

async function connectDB() {
  if (!client) {
    client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
    await client.connect();
    db = client.db(dbName);
    console.log('Connecté à MongoDB');
  }
  return db;
}

async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('Déconnexion de MongoDB');
  }
}

module.exports = { connectDB, closeDB };
