require('dotenv').config();

// ── Sécurité ─────────────────────────────────────────────────
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const JWT_SECRET  = process.env.JWT_SECRET  || 'mauricraft-secret-change-moi';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

// ── Framework & utilitaires ──────────────────────────────────
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const multer       = require('multer');
const rateLimit    = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
const fs           = require('fs');

// ── Compression gzip ─────────────────────────────────────────
let compression;
try { compression = require('compression'); } catch(e) { compression = null; }

const app  = express();
const PORT = process.env.PORT || 3000;
const WA_NUMBER = process.env.WA_NUMBER || '22249000000';

// ── CORS sécurisé ─────────────────────────────────────────────
const allowedOrigins = [
  `http://localhost:${PORT}`,
  `http://localhost:3000`,
  `http://127.0.0.1:3000`,
  /^http:\/\/192\.168\.\d+\.\d+/,  // réseau local WiFi (mobile)
  /^http:\/\/10\.\d+\.\d+\.\d+/,   // réseau local alternatif
  'https://mauricraft.mr',
  'https://www.mauricraft.mr'
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // Postman, curl
    const allowed = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (allowed) callback(null, true);
    else callback(new Error('CORS non autorisé'));
  }
}));

if (compression) app.use(compression());

// ── Dossier uploads local (fallback) ────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── Middlewares ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// Anti brute-force sur le login : 10 tentatives / 15 min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' }
});

// ── Cloudinary + Multer ──────────────────────────────────────
let cloudinary = null;
let cloudinaryStorage = null;

try {
  cloudinary = require('cloudinary').v2;
  const { CloudinaryStorage } = require('multer-storage-cloudinary');

  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    cloudinaryStorage = new CloudinaryStorage({
      cloudinary,
      params: {
        folder: 'mauricraft',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }]
      }
    });
    console.log('✅ Cloudinary configuré');
  }
} catch(e) { console.warn('⚠️ Cloudinary non installé — upload local utilisé'); }

// Fallback local si Cloudinary pas configuré
const upload = cloudinaryStorage
  ? require('multer')({ storage: cloudinaryStorage, limits: { fileSize: 5 * 1024 * 1024 } })
  : require('multer')({
      dest: UPLOADS_DIR,
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        /jpeg|jpg|png|webp/.test(file.mimetype) ? cb(null, true) : cb(new Error('Image uniquement'));
      }
    });

// ════════════════════════════════════════════════════════════
//   MONGODB
// ════════════════════════════════════════════════════════════
let db;
async function connectDB() {
  if (db) return db;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('✅ MongoDB Atlas connecté !');
  db = client.db('mauricraft');
  await db.collection('products').createIndex({ category: 1 });
  await db.collection('products').createIndex({ name: 'text', description: 'text' });
  return db;
}

// ════════════════════════════════════════════════════════════
//   MIDDLEWARES D'AUTHENTIFICATION
// ════════════════════════════════════════════════════════════

// ── Admin via JWT ────────────────────────────────────────────
function adminOnly(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Non authentifié. Connectez-vous.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé — rôle admin requis.' });
    }
    req.admin = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
    }
    return res.status(401).json({ error: 'Token invalide.' });
  }
}

// ── Vendeur via JWT ──────────────────────────────────────────
async function vendorOnly(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Token vendeur manquant.' });
  }

  try {
    const payload  = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'vendor') {
      return res.status(403).json({ error: 'Accès refusé — rôle vendeur requis.' });
    }
    const database = await connectDB();
    const vendor   = await database.collection('vendors').findOne({
      _id: new ObjectId(payload.vendorId), status: 'approved'
    });
    if (!vendor) return res.status(403).json({ error: 'Session invalide ou boutique suspendue.' });
    req.vendor = vendor;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
    }
    return res.status(401).json({ error: 'Token invalide.' });
  }
}

// ════════════════════════════════════════════════════════════
//   PROTECTION DES PAGES HTML — redirige si non connecté
// ════════════════════════════════════════════════════════════

// Middleware qui vérifie le cookie/token pour les pages admin/vendor
function requireAdminPage(req, res, next) {
  // On laisse passer — la vérification se fait côté JS dans la page
  // (les APIs sont protégées côté serveur, c'est ce qui compte)
  next();
}

// ════════════════════════════════════════════════════════════
//   API ADMIN — AUTHENTIFICATION
// ════════════════════════════════════════════════════════════

// POST /api/admin/login — connexion admin sécurisée
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Mot de passe requis.' });

    // Comparer avec le hash bcrypt stocké dans .env
    const hashStored = process.env.ADMIN_PASSWORD_HASH;

    let valid = false;
    if (hashStored && hashStored.startsWith('$2')) {
      // Hash bcrypt disponible → comparaison sécurisée
      valid = await bcrypt.compare(password, hashStored);
    } else {
      // Fallback : comparaison directe (mode développement)
      valid = (password === process.env.ADMIN_PASSWORD);
      console.warn('⚠️  Utilisez ADMIN_PASSWORD_HASH en production !');
    }

    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }

    // Générer un JWT signé
    const token = jwt.sign(
      { role: 'admin', iat: Date.now() },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    console.log('🔑 Connexion admin réussie');
    res.json({ success: true, token, expiresIn: JWT_EXPIRES });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/dashboard
app.get('/api/admin/dashboard', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const [totalProducts, pendingProducts, teasingProducts, totalVendors, pendingVendors, totalOrders, pendingOrders] =
      await Promise.all([
        database.collection('products').countDocuments({ status: 'active' }),
        database.collection('products').countDocuments({ status: 'pending' }),
        database.collection('products').countDocuments({ status: 'teasing' }),
        database.collection('vendors').countDocuments({ status: 'approved' }),
        database.collection('vendors').countDocuments({ status: 'pending' }),
        database.collection('orders').countDocuments({}),
        database.collection('orders').countDocuments({ status: 'pending' })
      ]);
    const revenue = await database.collection('orders').aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: null, total: { $sum: '$totalMRU' } } }
    ]).toArray();
    res.json({
      products: { total: totalProducts, pending: pendingProducts, teasing: teasingProducts },
      vendors:  { total: totalVendors,  pending: pendingVendors  },
      orders:   { total: totalOrders,   pending: pendingOrders   },
      revenue:  revenue[0]?.total || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/pending
app.get('/api/admin/pending', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const [products, vendors] = await Promise.all([
      database.collection('products').find({ status: { $in: ['pending', 'teasing'] } }).sort({ createdAt: -1 }).toArray(),
      database.collection('vendors').find({ status: 'pending' }).sort({ createdAt: -1 }).toArray()
    ]);
    res.json({ products, vendors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/products/:id/approve — status: pending → teasing → active
app.put('/api/admin/products/:id/approve', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const current  = await database.collection('products').findOne({ _id: new ObjectId(req.params.id) });
    if (!current) return res.status(404).json({ error: 'Produit introuvable.' });

    // Cycle : pending → teasing → active
    const nextStatus = current.status === 'pending' ? 'teasing'
      : current.status === 'teasing' ? 'active'
      : 'active';

    const product = await database.collection('products').findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: nextStatus, approved: nextStatus === 'active', approvedAt: nextStatus === 'active' ? new Date() : null } },
      { returnDocument: 'after' }
    );
    const msg = nextStatus === 'teasing'
      ? `⏳ "${product.name}" en teasing — visible en "Produits à venir".`
      : `✅ "${product.name}" actif — visible sur le site.`;
    res.json({ message: msg, product });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════
//   API PRODUITS
// ════════════════════════════════════════════════════════════

app.get('/api/products', async (req, res) => {
  try {
    const database = await connectDB();
    const { category, search, sort, limit = 20, page = 1, status } = req.query;

    // status=active → produits validés (visible publiquement)
    // status=teasing → produits "à venir" (visible en teasing)
    // status=all → admin seulement
    let filter = status === 'teasing'
      ? { status: 'teasing' }
      : status === 'all'
      ? {}
      : { status: 'active' }; // défaut public

    if (category && category !== 'all') filter.category = category;
    if (search) {
      filter.$or = [
        { name:        { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags:        { $in: [new RegExp(search, 'i')] } }
      ];
    }
    const sortMap = { newest: { createdAt: -1 }, price_asc: { price: 1 }, price_desc: { price: -1 }, rating: { rating: -1 } };
    const skip    = (parseInt(page) - 1) * parseInt(limit);
    const total   = await database.collection('products').countDocuments(filter);
    const products = await database.collection('products')
      .find(filter).sort(sortMap[sort] || { createdAt: -1 }).skip(skip).limit(parseInt(limit)).toArray();
    res.json({ products, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const database = await connectDB();
    const product  = await database.collection('products').findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    await database.collection('products').updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { views: 1 } });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products', upload.single('image'), async (req, res) => {
  try {
    const database = await connectDB();
    const { name, name_ar, description, desc_ar, category, price, vendor, emoji, tags, badge } = req.body;
    if (!name || !category) return res.status(400).json({ error: 'Nom et catégorie obligatoires.' });
    const product = {
      name, name_ar: name_ar || '', description: description || '', desc_ar: desc_ar || '',
      category: category.toLowerCase(), price: price ? Number(price) : null, currency: 'MRU',
      vendor: vendor || null, vendorVerified: false, emoji: emoji || '🏺',
      imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
      tags: tags ? tags.split(',').map(t => t.trim()) : [category],
      badge: badge || null, inStock: true, approved: false, views: 0, rating: null, createdAt: new Date()
    };
    const result = await database.collection('products').insertOne(product);
    res.status(201).json({ message: '✅ Produit soumis.', productId: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ PROTÉGÉ — seul l'admin peut modifier
app.put('/api/products/:id', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const { _id, ...update } = req.body;
    const result = await database.collection('products').findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...update, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    console.log(`✏️  Admin a modifié le produit ${req.params.id}`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ PROTÉGÉ — seul l'admin peut supprimer
app.delete('/api/products/:id', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    await database.collection('products').deleteOne({ _id: new ObjectId(req.params.id) });
    console.log(`🗑️  Admin a supprimé le produit ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════
//   API COMMANDES
// ════════════════════════════════════════════════════════════

app.post('/api/orders', async (req, res) => {
  try {
    const database = await connectDB();
    const { items, totalMRU, paymentMethod, buyerWhatsapp, buyerName, deliveryNote } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'Panier vide.' });
    const order = { items, totalMRU: Number(totalMRU), paymentMethod, buyerWhatsapp: buyerWhatsapp || '', buyerName: buyerName || 'Anonyme', deliveryNote: deliveryNote || '', status: 'pending', confirmedByDelivery: false, confirmedByBuyer: false, createdAt: new Date() };
    const result   = await database.collection('orders').insertOne(order);
    const payLabel = { bankily:'📱 Bankily', masrivi:'💳 Masrivi', sadead:'🏦 Sadead', cash:'💵 Livraison' }[paymentMethod] || paymentMethod;
    const lines    = items.map(i => `• ${i.emoji||'🏺'} ${i.productName} ×${i.qty} — ${(i.price*i.qty).toLocaleString()} MRU`).join('\n');
    const waMsg    = encodeURIComponent(`🏺 *MauriCraft — Commande #${result.insertedId.toString().slice(-6).toUpperCase()}*\n──────────────────\n${lines}\n──────────────────\n💰 *Total: ${Number(totalMRU).toLocaleString()} MRU*\n${payLabel}\n📦 ${deliveryNote || 'Livraison à préciser'}`);
    res.status(201).json({ orderId: result.insertedId, whatsappUrl: `https://wa.me/${process.env.WA_NUMBER}?text=${waMsg}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const orders = await database.collection('orders').find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/confirm-delivery', async (req, res) => {
  try {
    const database = await connectDB();
    await database.collection('orders').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { confirmedByDelivery: true, status: 'in_delivery' } });
    await maybeReleaseFunds(database, req.params.id);
    res.json({ message: 'Livraison confirmée.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/confirm-buyer', async (req, res) => {
  try {
    const database = await connectDB();
    await database.collection('orders').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { confirmedByBuyer: true } });
    await maybeReleaseFunds(database, req.params.id);
    res.json({ message: 'Réception confirmée.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function maybeReleaseFunds(database, orderId) {
  const order = await database.collection('orders').findOne({ _id: new ObjectId(orderId) });
  if (order && order.confirmedByDelivery && order.confirmedByBuyer) {
    await database.collection('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { status: 'delivered', deliveredAt: new Date() } });
    console.log(`💰 Escrow libéré — Commande ${orderId}`);
  }
}

// ════════════════════════════════════════════════════════════
//   API VENDEURS
// ════════════════════════════════════════════════════════════

app.post('/api/vendors', async (req, res) => {
  try {
    const database = await connectDB();
    const { name, whatsapp, email, shopName, city, category, description, categories } = req.body;
    if (!name || !whatsapp) return res.status(400).json({ error: 'Nom et WhatsApp obligatoires.' });

    const existing = await database.collection('vendors').findOne({ whatsapp });
    if (existing) {
      if (existing.status === 'rejected') {
        await database.collection('vendors').deleteOne({ _id: existing._id });
      } else {
        return res.status(409).json({ error: 'Ce numéro est déjà inscrit.', status: existing.status });
      }
    }

    const vendor = { name, whatsapp, email: email || '', shopName: shopName || name, city: city || 'Nouakchott', category: category || '', categories: Array.isArray(categories) ? categories : [categories].filter(Boolean), description: description || '', status: 'pending', verified: false, createdAt: new Date() };
    const result   = await database.collection('vendors').insertOne(vendor);
    const vendorId = result.insertedId;

    const msgAdmin   = encodeURIComponent(`🏺 *Nouvelle demande vendeur — MauriCraft*\n\n👤 ${name}\n🏪 ${shopName || name}\n📱 ${whatsapp}\n📍 ${city || 'Nouakchott'}\n\n✅ Valider : http://localhost:3000/admin\n🆔 ID : ${vendorId}`);
    const waAdminUrl   = `https://wa.me/${process.env.WA_NUMBER}?text=${msgAdmin}`;
    const msgVendeur   = encodeURIComponent(`🎉 *Bienvenue sur MauriCraft !*\n\nBonjour ${name} 👋\nVotre boutique *${shopName || name}* a bien été reçue.\n⏳ Validation sous *24–48h*.\n— L'équipe MauriCraft 🏺`);
    const waVendeurUrl = `https://wa.me/${whatsapp}?text=${msgVendeur}`;

    try {
      await mailer.sendMail({ from: `"MauriCraft" <${process.env.GMAIL_USER}>`, to: process.env.ADMIN_EMAIL, subject: `🏺 Nouveau vendeur — ${shopName || name}`, html: `<div style="font-family:Arial;max-width:500px;background:#0D1929;color:#FDFAF4;padding:32px;border-radius:12px;"><h2 style="color:#C9A84C;">🏺 Nouveau vendeur à valider</h2><p><b>Nom:</b> ${name}<br><b>Boutique:</b> ${shopName||name}<br><b>WhatsApp:</b> ${whatsapp}<br><b>Ville:</b> ${city||'Nouakchott'}</p><a href="http://localhost:3000/admin" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#C9A84C;color:#0D1929;font-weight:700;border-radius:8px;text-decoration:none;">✅ Valider sur Admin</a></div>` });
    } catch (e) { console.warn('⚠️ Email admin non envoyé:', e.message); }

    if (req.body.email) {
      try {
        await mailer.sendMail({ from: `"MauriCraft & Style" <${process.env.GMAIL_USER}>`, to: req.body.email, subject: `🎉 Bienvenue sur MauriCraft — ${shopName || name}`, html: `<div style="font-family:Arial;max-width:500px;background:#0D1929;color:#FDFAF4;padding:32px;border-radius:12px;"><h2 style="color:#C9A84C;">🎉 Bienvenue, ${name} !</h2><p>Votre boutique <b>${shopName||name}</b> a bien été reçue.<br>⏳ Validation sous <b>24–48h</b>.</p><p style="color:#C9A84C;">🎁 1er mois sans commission !</p></div>` });
      } catch (e) { console.warn('⚠️ Email vendeur non envoyé:', e.message); }
    }

    res.status(201).json({ message: '✅ Inscription reçue ! Validation sous 24–48h.', vendorId, adminNotifyUrl: waAdminUrl, vendorNotifyUrl: waVendeurUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/vendors/approved — liste publique des vendeurs approuvés
app.get('/api/vendors/approved', async (req, res) => {
  try {
    const database = await connectDB();
    const vendors = await database.collection('vendors')
      .find({ status: 'approved' })
      .project({ name: 1, shopName: 1, city: 1, categories: 1, category: 1, description: 1 })
      .sort({ approvedAt: -1 })
      .toArray();
    res.json(vendors);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vendors', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const vendors  = await database.collection('vendors').find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).toArray();
    res.json(vendors);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Route temporaire pour vider tous les vendeurs (debug)
app.delete('/api/debug/vendors/all', async (req, res) => {
  try {
    const database = await connectDB();
    const result = await database.collection('vendors').deleteMany({});
    res.json({ message: `✅ ${result.deletedCount} vendeur(s) supprimé(s).` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/vendors/:id/approve', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const vendor   = await database.collection('vendors').findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'approved', verified: true, approvedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const waMsg = encodeURIComponent(`🎉 Félicitations ${vendor.name} !\n\nVotre boutique *${vendor.shopName}* est approuvée sur MauriCraft 🏺\nVous pouvez maintenant ajouter vos produits. Bienvenue ! 🇲🇷`);
    res.json({ vendor, notifyVendorUrl: `https://wa.me/${vendor.whatsapp}?text=${waMsg}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/vendors/:id/reject — refuser un vendeur
app.put('/api/vendors/:id/reject', adminOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const vendor = await database.collection('vendors').findOne({ _id: new ObjectId(req.params.id) });
    if (!vendor) return res.status(404).json({ error: 'Vendeur introuvable.' });

    await database.collection('vendors').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'rejected', rejectedAt: new Date(), reason: req.body.reason || 'Refusé par admin.' } }
    );

    // Notifier le vendeur par email si disponible
    if (vendor.email) {
      try {
        await mailer.sendMail({
          from: `"MauriCraft & Style" <${process.env.GMAIL_USER}>`,
          to: vendor.email,
          subject: `❌ Demande MauriCraft refusée — ${vendor.shopName}`,
          html: `<div style="font-family:Arial;max-width:500px;background:#0D1929;color:#FDFAF4;padding:32px;border-radius:12px;">
            <h2 style="color:#C9A84C;">MauriCraft & Style</h2>
            <p>Bonjour <strong>${vendor.name}</strong>,</p>
            <p>Votre demande pour la boutique <strong>${vendor.shopName}</strong> a été refusée.</p>
            <p style="color:#aaa;">Raison : ${req.body.reason || 'Non conforme à nos critères.'}</p>
            <p>Vous pouvez soumettre une nouvelle demande à tout moment.</p>
          </div>`
        });
      } catch (e) { console.warn('⚠️ Email refus non envoyé:', e.message); }
    }

    // Notifier le vendeur par WhatsApp
    const waMsg = encodeURIComponent(`❌ Bonjour ${vendor.name}, votre demande pour la boutique *${vendor.shopName}* sur MauriCraft a été refusée.\n\nVous pouvez soumettre une nouvelle demande sur notre site.`);
    const waUrl = `https://wa.me/${vendor.whatsapp}?text=${waMsg}`;

    res.json({ success: true, notifyVendorUrl: waUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════
//   API VENDEUR — Authentification JWT
// ════════════════════════════════════════════════════════════

app.post('/api/vendor/login', loginLimiter, async (req, res) => {
  try {
    const database = await connectDB();
    const { whatsapp } = req.body;
    if (!whatsapp) return res.status(400).json({ error: 'Numéro WhatsApp requis.' });

    const vendor = await database.collection('vendors').findOne({ whatsapp: whatsapp.trim() });
    if (!vendor)                       return res.status(404).json({ error: 'Numéro non trouvé. Inscrivez-vous d\'abord.' });
    if (vendor.status === 'pending')   return res.status(403).json({ error: 'Boutique en attente de validation.' });
    if (vendor.status === 'suspended') return res.status(403).json({ error: 'Boutique suspendue. Contactez l\'admin.' });
    if (vendor.status !== 'approved')  return res.status(403).json({ error: 'Accès non autorisé.' });

    // Générer un JWT signé pour le vendeur
    const token = jwt.sign(
      { role: 'vendor', vendorId: vendor._id.toString(), whatsapp: vendor.whatsapp },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ success: true, token, vendor: { name: vendor.name, shopName: vendor.shopName, city: vendor.city } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vendor/me/products', vendorOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const products = await database.collection('products').find({ vendorId: req.vendor._id.toString() }).sort({ createdAt: -1 }).toArray();
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vendor/me/products', vendorOnly, upload.single('image'), async (req, res) => {
  try {
    const database = await connectDB();
    const { name, name_ar, description, desc_ar, category, price, emoji, tags, badge } = req.body;
    if (!name || !category) return res.status(400).json({ error: 'Nom et catégorie obligatoires.' });
    const imageUrl = req.file
      ? (req.file.path || `/uploads/${req.file.filename}`)  // Cloudinary donne .path, local donne .filename
      : null;
    const product = { name: name.trim(), name_ar: name_ar || '', description: description || '', desc_ar: desc_ar || '', category: category.toLowerCase(), price: price ? Number(price) : null, currency: 'MRU', vendor: req.vendor.shopName, vendorId: req.vendor._id.toString(), vendorVerified: req.vendor.verified || false, emoji: emoji || '🏺', imageUrl, tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [category], badge: badge || null, inStock: true, status: 'pending', approved: false, views: 0, rating: null, createdAt: new Date() };
    const result = await database.collection('products').insertOne(product);
    res.status(201).json({ message: '✅ Produit soumis ! En attente de validation (24-48h).', productId: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vendor/me/products/:id', vendorOnly, async (req, res) => {
  try {
    const database = await connectDB();
    const product  = await database.collection('products').findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.status(404).json({ error: 'Produit introuvable.' });
    if (product.vendorId !== req.vendor._id.toString()) return res.status(403).json({ error: 'Ce produit ne vous appartient pas.' });
    await database.collection('products').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', async (req, res) => {
  try {
    const database = await connectDB();
    const result   = await database.collection('users').insertOne({ ...req.body, createdAt: new Date() });
    res.status(201).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════
//   API IA — Style Assistant (Gemini)
// ════════════════════════════════════════════════════════════
app.post('/api/ai/style', async (req, res) => {
  try {
    const { query, lang } = req.body;
    if (!query) return res.status(400).json({ error: 'Question manquante.' });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'Clé API Gemini manquante dans .env' });
    }

    const langue = lang === 'ar' ? 'arabe' : 'français';
    const prompt = `Tu es l'Expert de Style de MauriCraft & Style, la marketplace de référence en Mauritanie. Ton rôle est d'offrir des conseils personnalisés, sophistiqués et culturellement riches.

Ton Identité :
• Tu es un expert en haute couture mauritanienne et artisanat local de TOUTES les communautés : Maures, Peuls (Halpulaaren), Wolof, Soninké.
• Ton ton est chaleureux, prestigieux et inspire la confiance (le 'Terrou' mauritanien).
• Tu maîtrises le vocabulaire : Bazin (Gagnila, Riche), Voile (Suisse, Italien), Melahfa, Darra, Broderies, Boubou Peul, Mussor Wolof, Faso dan fani Soninké.

Ta Mission :
1. Analyse la demande du client (Mariage, Tabaski, Bureau, Baptême, Quotidien, Eid).
2. Propose des associations de couleurs audacieuses et élégantes selon la communauté et l'occasion.
3. Suggère le type de tissu idéal (ex: Bazin riche pour un mariage, Lin ou Coton léger pour le quotidien).
4. Ajoute toujours une petite touche sur les accessoires (Sacs en cuir artisanal, Bijoux en argent mauritanien ou en or, babouches brodées).

Contraintes :
• Réponds en français impeccable (ou en arabe si la question est en arabe).
• Sois structuré avec des puces (•) pour la lisibilité.
• Ne dépasse pas 200 mots.
• Refuse poliment toute question hors mode et style vestimentaire.

Question du client : ${query}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Erreur Gemini API');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ response: text });
  } catch (err) {
    console.warn('⚠️ AI Style:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/vendor-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor-login.html')));
app.get('/vendor',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor.html')));
app.get('/admin',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[ERREUR]', err.message);
  res.status(500).json({ error: 'Erreur interne.' });
});

app.listen(PORT, async () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   🏺 MauriCraft & Style — v3.0 🔒 JWT    ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   🌐  http://localhost:${PORT}               ║`);
  console.log(`║   🔑  http://localhost:${PORT}/admin         ║`);
  console.log('╚══════════════════════════════════════════╝');

  // Test connexion MongoDB au démarrage
  try {
    await connectDB();
  } catch(e) {
    console.error('❌ MongoDB non connecté:', e.message);
  }

  if (!process.env.ADMIN_PASSWORD_HASH) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'MauriCraftAdmin2026', 12);
    console.log('\n⚠️  Ajoutez cette ligne dans votre .env :');
    console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
  } else {
    console.log('✅ Admin sécurisé (hash bcrypt configuré)');
  }
  if (process.env.GEMINI_API_KEY) console.log('✅ IA Style Assistant configuré (Gemini)');
  if (process.env.GMAIL_USER) console.log('✅ Email configuré :', process.env.GMAIL_USER);
  if (process.env.CLOUDINARY_CLOUD_NAME) console.log('✅ Cloudinary configuré');
  console.log('');
});
