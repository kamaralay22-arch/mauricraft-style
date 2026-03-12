import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
let client;

async function connectDB() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db('mauricraft');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = await connectDB();

    if (req.method === 'GET') {
      const products = await db.collection('products').find({}).toArray();
      return res.status(200).json(products);
    }

    if (req.method === 'POST') {
      const product = req.body;
      product.createdAt = new Date();
      const result = await db.collection('products').insertOne(product);
      return res.status(201).json(result);
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}Ajout API produits
