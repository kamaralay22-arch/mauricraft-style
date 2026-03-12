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

    if (req.method === 'POST') {
      const vendor = req.body;
      vendor.createdAt = new Date();
      vendor.verified = false;
      const result = await db.collection('vendors').insertOne(vendor);
      return res.status(201).json(result);
    }

    if (req.method === 'GET') {
      const vendors = await db.collection('vendors').find({}).toArray();
      return res.status(200).json(vendors);
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}Ajout API vendeurs
