# 🏺 MauriCraft & Style — Guide complet v2.0

## Architecture du projet

```
mauricraft-final/
├── server.js              ← Serveur Node.js (toutes les APIs)
├── package.json
├── .env                   ← Vos secrets MongoDB + admin password
├── .gitignore
├── uploads/               ← Photos produits (créé automatiquement)
└── public/
    ├── index.html         ← Le site vitrine (clients)
    ├── vendor.html        ← Espace vendeur  → /vendor
    └── admin.html         ← Panneau admin   → /admin
```

## Les 3 pages

| Page | URL | Pour qui |
|---|---|---|
| Site vitrine | `http://localhost:3000` | Les clients qui achètent |
| Espace vendeur | `http://localhost:3000/vendor` | Les vendeurs qui ajoutent leurs produits |
| Panneau admin | `http://localhost:3000/admin` | Vous, pour valider les produits et boutiques |

---

## Installation (2 commandes)

```bash
npm install
npm run dev
```

C'est tout. Votre MongoDB Atlas est déjà configuré dans `.env`.

---

## Comment ça marche — Le parcours complet

### 1. Un vendeur veut rejoindre MauriCraft

1. Il visite le site et clique **"Vendre sur MauriCraft"**
2. Il remplit le formulaire d'inscription (nom, WhatsApp, ville, catégories)
3. Vous recevez une notification WhatsApp
4. Vous allez sur `/admin` → **"Vendeurs à valider"** → Approuver
5. Le vendeur reçoit un message WhatsApp de confirmation

### 2. Le vendeur ajoute ses produits

1. Il va sur `/vendor` et entre son numéro WhatsApp
2. Il remplit le formulaire : nom, prix, catégorie, photo, description
3. Il clique **"Soumettre pour validation"**
4. Vous recevez une notification WhatsApp
5. Vous allez sur `/admin` → **"Produits à valider"** → Approuver
6. Le produit apparaît sur le site vitrine

### 3. Un client achète

1. Il ajoute au panier, choisit son mode de paiement
2. Il est redirigé vers WhatsApp avec le récapitulatif complet
3. La commande est enregistrée en base avec statut "pending"
4. Vous gérez la livraison depuis `/admin` → **"Commandes"**

---

## API complète

```
# Site vitrine
GET  /api/products              → produits approuvés
GET  /api/products?category=melahfa
GET  /api/products?search=bazin
POST /api/orders                → créer une commande

# Espace vendeur (/vendor)
POST /api/vendor/login          → connexion par WhatsApp
GET  /api/vendor/me/products    → mes produits
POST /api/vendor/me/products    → ajouter un produit + photo
DEL  /api/vendor/me/products/:id

# Inscription vendeur
POST /api/vendors               → demande de boutique

# Admin (/admin)
POST /api/admin/login
GET  /api/admin/dashboard
GET  /api/admin/pending         → produits + vendeurs en attente
PUT  /api/admin/products/:id/approve
PUT  /api/vendors/:id/approve
GET  /api/vendors               → tous les vendeurs
GET  /api/products              → tous les produits
GET  /api/orders                → toutes les commandes
```

---

## Variables d'environnement (.env)

```env
MONGODB_URI=mongodb+srv://...   ← votre Atlas (déjà rempli)
PORT=3000
ADMIN_PASSWORD=...              ← mot de passe pour /admin
WA_NUMBER=221782352549          ← votre numéro WhatsApp
```

---

## Déploiement sur Vercel

```bash
npm install -g vercel
vercel
```

Puis dans le dashboard Vercel → Settings → Environment Variables :
ajoutez `MONGODB_URI`, `ADMIN_PASSWORD`, `WA_NUMBER`.
