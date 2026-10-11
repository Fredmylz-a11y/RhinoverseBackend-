const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
app.disable('etag');
app.use((req,res,next)=>{res.set('Cache-Control','no-store'); next();});

const JWT_SECRET = process.env.JWT_SECRET || 'rhinoverse-secret-2024';
const WELCOME_BONUS = 3000;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

let db;
try {
  const { getFirestore } = require('firebase-admin/firestore');
  db = getFirestore(admin.app(), 'rhinoverse');
  console.log('Connected to Firestore database: rhinoverse');
} catch (e) {
  console.error('Fallback DB', e.message);
  db = admin.firestore();
}
const usersCollection = db.collection('users');

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

const findUser = async (identifier) => {
  let snap = await usersCollection.where('username', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  snap = await usersCollection.where('phone', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  return null;
};

const findUserById = async (id) => {
  const doc = await usersCollection.doc(id).get();
  if (!doc.exists) return null;
  return {...doc.data(), _docId: doc.id };
};

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const PRODUCTS = [
  { id: 1, name: 'Rhino Calf', price: 20000, dailyIncome: 5000, cycleDays: 60, totalIncome: 300000, image: 'calf' },
  { id: 2, name: 'Rhino Skin', price: 50000, dailyIncome: 12000, cycleDays: 60, totalIncome: 720000, badge: 'Armor' },
  { id: 3, name: 'Rhino Horn', price: 100000, dailyIncome: 25000, cycleDays: 60, totalIncome: 1500000 },
  { id: 4, name: 'Rhino Guard', price: 200000, dailyIncome: 50000, cycleDays: 60, totalIncome: 3000000 },
  { id: 5, name: 'Rhino Prime', price: 500000, dailyIncome: 90000, cycleDays: 60, totalIncome: 5400000 },
  { id: 6, name: 'Rhino King', price: 1000000, dailyIncome: 150000, cycleDays: 60, totalIncome: 9000000, badge: 'Alpha' },
  { id: 7, name: 'Rhino Legend', price: 2000000, dailyIncome: 300000, cycleDays: 60, totalIncome: 18000000, badge: 'Legend' },
];

const COMMISSION_RATES = { 1: 0.15, 2: 0.05, 3: 0.02 };

app.get('/api/health', async (req, res) => {
  try {
    await usersCollection.limit(1).get();
    res.json({ status: 'healthy', db: 'rhinoverse', project: process.env.FIREBASE_PROJECT_ID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/', (req, res) => res.json({ status: 'Running', db: 'rhinoverse', full: true }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));

// COMPATIBILITY ROUTES FOR FRONTEND m-nu.vercel.app
app.get('/api/products/my', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ products: user.products || [], data: user.products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wallet/balance', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      recharge: user.wallets?.recharge || 0,
      withdrawal: user.wallets?.withdrawal || 0,
      rechargeWallet: user.wallets?.recharge || 0,
      withdrawalWallet: user.wallets?.withdrawal || 0,
      balance: user.wallets?.recharge || 0,
      data: user.wallets,
      wallets: user.wallets
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wallet', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    res.json(user.wallets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, phone, password, referrer } = req.body;
    if (!username ||!phone ||!password) return res.status(400).json({ error: 'Missing fields' });
    if (await findUser(username)) return res.status(400).json({ error: 'Username taken' });
    if (await findUser(phone)) return res.status(400).json({ error: 'Phone exists' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = generateId();
    const newUser = {
      id: userId, username, phone, password: hashed,
      referrer: referrer || null, upline: referrer || null,
      registered: new Date().toISOString(),
      wallets: { recharge: 0, withdrawal: WELCOME_BONUS },
      products: [], commissions: {1:0,2:0,3:0}, totalEarnings: 0,
      downlines: [], level1: [], level2: [], level3: [],
      lastCheckin: null, checkinStreak: 0
    };
    if (referrer) {
      const r = await findUser(referrer);
      if (r) {
        const rId = r._docId || r.id;
        const rData = await findUserById(rId) || r;
        await usersCollection.doc(rId).update({
          level1: [...(rData.level1||[]), username],
          downlines: [...(rData.downlines||[]), username]
        });
        if (rData.upline) {
          const u2 = await findUser(rData.upline);
          if (u2) {
            const u2Id = u2._docId || u2.id;
            await usersCollection.doc(u2Id).update({ level2: [...(u2.level2||[]), username] });
            if (u2.upline) {
              const u3 = await findUser(u2.upline);
              if (u3) {
                const u3Id = u3._docId || u3.id;
                await usersCollection.doc(u3Id).update({ level3: [...(u3.level3||[]), username] });
              }
            }
          }
        }
      }
    }
    await usersCollection.doc(userId).set(newUser);
    const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registration successful', token, user: { id: userId, username, phone, wallets: newUser.wallets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await findUser(phone);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, message: 'Login successful', user: { id: user.id, username: user.username, phone: user.phone, wallets: user.wallets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });
  const u = doc.data(); delete u.password; res.json(u);
});

app.post('/api/buy', authenticate, async (req, res) => {
  try {
    const { productId } = req.body;
    const product = PRODUCTS.find(p => p.id === Number(productId));
    if (!product) return res.status(400).json({ error: 'Invalid product' });
    const userDoc = await usersCollection.doc(req.user.id).get();
    const user = userDoc.data();
    if (user.wallets.recharge < product.price) return res.status(400).json({ error: 'Insufficient recharge balance' });
    const newProduct = {...product, purchaseDate: new Date().toISOString(), expiryDate: new Date(Date.now()+product.cycleDays*86400000).toISOString(), earned:0, active:true };
    await usersCollection.doc(req.user.id).update({
      products: [...(user.products||[]), newProduct],
      wallets: {...user.wallets, recharge: user.wallets.recharge - product.price}
    });
    res.json({ message: 'Product purchased', product: newProduct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/checkin', authenticate, async (req, res) => {
  try {
    const userDoc = await usersCollection.doc(req.user.id).get();
    const user = userDoc.data();
    const now = new Date();
    const last = user.lastCheckin? new Date(user.lastCheckin): null;
    if (last && now.toDateString() === last.toDateString()) return res.status(400).json({ error: 'Already checked in today' });
    let dailyTotal = 0;
    const updatedProducts = (user.products||[]).map(p => {
      if (p.active) {
        const expiry = new Date(p.expiryDate);
        if (now < expiry) { dailyTotal += p.dailyIncome; return {...p, earned:(p.earned||0)+p.dailyIncome}; }
        else return {...p, active:false};
      }
      return p;
    });
    const updatedWallets = {...user.wallets, withdrawal:(user.wallets.withdrawal||0)+dailyTotal};
    await usersCollection.doc(req.user.id).update({ products: updatedProducts, wallets: updatedWallets, lastCheckin: now.toISOString(), totalEarnings:(user.totalEarnings||0)+dailyTotal });
    res.json({ message: 'Check-in successful', earned: dailyTotal, wallets: updatedWallets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/team', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  const user = doc.data();
  res.json({ level1: user.level1||[], level2: user.level2||[], level3: user.level3||[], downlines: user.downlines||[], commissions: user.commissions||{} });
});

module.exports = app;
