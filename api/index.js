cd /sdcard/Download/rhinoverse-backend-correct

cat > api/index.js << 'ENDJS'
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'rhinoverse-secret-2024';
const WELCOME_BONUS = 3000;

// Firebase init - FIXED FOR NAMED DATABASE 'rhinoverse'
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore('rhinoverse');
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
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const PRODUCTS = [
  { id: 1, name: 'Rhino Calf', price: 20000, dailyIncome: 5000, cycleDays: 60, totalIncome: 300000 },
  { id: 2, name: 'Rhino Skin', price: 50000, dailyIncome: 12000, cycleDays: 60, totalIncome: 720000, badge: 'Armor' },
  { id: 3, name: 'Rhino Horn', price: 100000, dailyIncome: 25000, cycleDays: 60, totalIncome: 1500000 },
  { id: 4, name: 'Rhino Guard', price: 200000, dailyIncome: 50000, cycleDays: 60, totalIncome: 3000000 },
  { id: 5, name: 'Rhino Prime', price: 500000, dailyIncome: 90000, cycleDays: 60, totalIncome: 5400000 },
  { id: 6, name: 'Rhino King', price: 1000000, dailyIncome: 150000, cycleDays: 60, totalIncome: 9000000, badge: 'Alpha' },
  { id: 7, name: 'Rhino Legend', price: 2000000, dailyIncome: 300000, cycleDays: 60, totalIncome: 18000000, badge: 'Legend' },
];

const COMMISSION_RATES = { 1: 0.15, 2: 0.05, 3: 0.02 };

// Health - NOW TESTS REAL DB
app.get('/api/health', async (req, res) => {
  try {
    await usersCollection.limit(1).get();
    res.json({ status: 'healthy', db: 'rhinoverse', databaseId: 'rhinoverse', project: process.env.FIREBASE_PROJECT_ID, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message, code: e.code, project: process.env.FIREBASE_PROJECT_ID });
  }
});

app.get('/', (req, res) => res.json({ status: 'Rhinoverse Backend Running', database: 'rhinoverse', version: '2.0' }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, phone, password, referrer } = req.body;
    if (!username ||!phone ||!password) return res.status(400).json({ error: 'Missing required fields' });
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Invalid username: 3-20 chars letters numbers _' });
    if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: 'Phone must be format 07xxxxxxxx' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });

    const existing = await findUser(username);
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    const existingPhone = await findUser(phone);
    if (existingPhone) return res.status(400).json({ error: 'Phone already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = generateId();

    const newUser = {
      id: userId,
      username,
      phone,
      password: hashedPassword,
      referrer: referrer || null,
      upline: null,
      registered: new Date().toISOString(),
      wallets: { recharge: 0, withdrawal: WELCOME_BONUS },
      products: [],
      commissions: { 1: 0, 2: 0, 3: 0 },
      totalEarnings: 0,
      downlines: [],
      level1: [],
      level2: [],
      level3: [],
      lastCheckin: null,
      checkinStreak: 0,
    };

    if (referrer) {
      const referrerUser = await findUser(referrer);
      if (referrerUser) {
        newUser.upline = referrer;
        // Add to referrer's downlines
        const rDocId = referrerUser._docId || referrerUser.id;
        const rData = await findUserById(rDocId) || referrerUser;
        const updatedLevel1 = [...(rData.level1 || []), username];
        const updatedDownlines = [...(rData.downlines || []), username];
        await usersCollection.doc(rDocId).update({ level1: updatedLevel1, downlines: updatedDownlines });

        // Level 2
        if (rData.upline) {
          const upline2 = await findUser(rData.upline);
          if (upline2) {
            const u2Id = upline2._docId || upline2.id;
            await usersCollection.doc(u2Id).update({ level2: [...(upline2.level2 || []), username] });
            // Level 3
            if (upline2.upline) {
              const upline3 = await findUser(upline2.upline);
              if (upline3) {
                const u3Id = upline3._docId || upline3.id;
                await usersCollection.doc(u3Id).update({ level3: [...(upline3.level3 || []), username] });
              }
            }
          }
        }
      }
    }

    await usersCollection.doc(userId).set(newUser);
    const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registration successful', token, user: { id: userId, username, phone, wallets: newUser.wallets } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone ||!password) return res.status(400).json({ error: 'Missing phone or password' });
    const user = await findUser(phone);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, user: { id: user.id, username: user.username, phone: user.phone, wallets: user.wallets } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed: ' + error.message });
  }
});

// Get User
app.get('/api/user', authenticate, async (req, res) => {
  try {
    const userDoc = await usersCollection.doc(req.user.id).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const user = userDoc.data();
    delete user.password;
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Buy Product
app.post('/api/buy', authenticate, async (req, res) => {
  try {
    const { productId } = req.body;
    const product = PRODUCTS.find(p => p.id === Number(productId));
    if (!product) return res.status(400).json({ error: 'Invalid product' });

    const userDoc = await usersCollection.doc(req.user.id).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const user = userDoc.data();

    if (user.wallets.recharge < product.price) return res.status(400).json({ error: 'Insufficient recharge balance' });

    const newProduct = {...product, purchaseDate: new Date().toISOString(), expiryDate: new Date(Date.now() + product.cycleDays * 24 * 60 * 60 * 1000).toISOString(), earned: 0, active: true };
    const updatedProducts = [...(user.products || []), newProduct];
    const updatedWallets = {...user.wallets, recharge: user.wallets.recharge - product.price };

    await usersCollection.doc(req.user.id).update({ products: updatedProducts, wallets: updatedWallets });

    // Commission to upline
    if (user.upline) {
      const upline1 = await findUser(user.upline);
      if (upline1) {
        const commission1 = product.price * COMMISSION_RATES[1];
        const u1Id = upline1._docId || upline1.id;
        const u1Doc = await usersCollection.doc(u1Id).get();
        const u1Data = u1Doc.data();
        await usersCollection.doc(u1Id).update({
          'wallets.withdrawal': (u1Data.wallets.withdrawal || 0) + commission1,
          commissions: {...u1Data.commissions, 1: (u1Data.commissions?.[1] || 0) + commission1 }
        });
      }
    }

    res.json({ message: 'Product purchased', product: newProduct });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Daily Checkin / Claim
app.post('/api/checkin', authenticate, async (req, res) => {
  try {
    const userDoc = await usersCollection.doc(req.user.id).get();
    const user = userDoc.data();
    const now = new Date();
    const last = user.lastCheckin? new Date(user.lastCheckin) : null;
    if (last && now.toDateString() === last.toDateString()) return res.status(400).json({ error: 'Already checked in today' });

    let dailyTotal = 0;
    const updatedProducts = (user.products || []).map(p => {
      if (p.active) {
        const expiry = new Date(p.expiryDate);
        if (now < expiry) { dailyTotal += p.dailyIncome; return {...p, earned: (p.earned || 0) + p.dailyIncome }; }
        else { return {...p, active: false }; }
      }
      return p;
    });

    const updatedWallets = {...user.wallets, withdrawal: (user.wallets.withdrawal || 0) + dailyTotal };
    await usersCollection.doc(req.user.id).update({ products: updatedProducts, wallets: updatedWallets, lastCheckin: now.toISOString(), totalEarnings: (user.totalEarnings || 0) + dailyTotal });

    res.json({ message: 'Check-in successful', earned: dailyTotal, wallets: updatedWallets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team / Referrals
app.get('/api/team', authenticate, async (req, res) => {
  try {
    const userDoc = await usersCollection.doc(req.user.id).get();
    const user = userDoc.data();
    res.json({ level1: user.level1 || [], level2: user.level2 || [], level3: user.level3 || [], downlines: user.downlines || [], commissions: user.commissions || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
