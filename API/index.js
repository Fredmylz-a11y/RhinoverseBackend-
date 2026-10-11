const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'rhinoverse-secret-2024';
const WELCOME_BONUS = 3000;

// Firebase init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();
const usersCollection = db.collection('users');

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
const findUser = async (identifier) => {
  let snap = await usersCollection.where('username', '==', identifier).limit(1).get();
  if (!snap.empty) return snap.docs[0].data();
  snap = await usersCollection.where('phone', '==', identifier).limit(1).get();
  if (!snap.empty) return snap.docs[0].data();
  return null;
};

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const PRODUCTS = [
  { id: 1, name: 'Rhino Calf', price: 20000, dailyIncome: 5000, cycleDays: 60 },
  { id: 2, name: 'Rhino Skin', price: 50000, dailyIncome: 12000, cycleDays: 60, badge: 'Armor' },
  { id: 3, name: 'Rhino Horn', price: 100000, dailyIncome: 25000, cycleDays: 60 },
  { id: 4, name: 'Rhino Guard', price: 200000, dailyIncome: 50000, cycleDays: 60 },
  { id: 5, name: 'Rhino Prime', price: 500000, dailyIncome: 90000, cycleDays: 60 },
  { id: 6, name: 'Rhino King', price: 1000000, dailyIncome: 150000, cycleDays: 60, badge: 'Alpha' },
  { id: 7, name: 'Rhino Legend', price: 2000000, dailyIncome: 300000, cycleDays: 60 },
];

app.get('/api/health', (req, res) => res.json({ status: 'healthy', db: 'rhinoverse', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ status: 'Rhinoverse Backend Running' }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, phone, password, referrer } = req.body;
    if (!username ||!phone ||!password) return res.status(400).json({ error: 'Missing required fields' });
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Invalid username' });
    if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: 'Phone must start with 07' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    const existing = await findUser(username);
    if (existing) return res.status(400).json({ error: 'Username taken' });
    const existingPhone = await findUser(phone);
    if (existingPhone) return res.status(400).json({ error: 'Phone already registered' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = generateId();
    const newUser = {
      id: userId, username, phone, password: hashedPassword, referrer: referrer || null, upline: null,
      registered: new Date().toISOString(),
      wallets: { recharge: 0, withdrawal: WELCOME_BONUS },
      products: [], commissions: { 1: 0, 2: 0, 3: 0 }, downlines: [], lastCheckin: null,
    };
    if (referrer) {
      const referrerUser = await findUser(referrer);
      if (referrerUser) {
        if (!referrerUser.downlines.includes(username)) {
          referrerUser.downlines.push(username);
          await usersCollection.doc(referrerUser.id).update({ downlines: referrerUser.downlines });
        }
        newUser.upline = referrer;
      }
    }
    await usersCollection.doc(userId).set(newUser);
    const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registration successful', token, user: { id: userId, username, phone, wallets: newUser.wallets } });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Registration failed: ' + error.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone ||!password) return res.status(400).json({ error: 'Missing fields' });
    const user = await findUser(phone);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, user: { id: user.id, username: user.username, phone: user.phone, wallets: user.wallets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'User not found' });
  res.json(doc.data());
});

app.get('/api/user', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  res.json(doc.data());
});

app.get('/api/profile', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  res.json(doc.data());
});

app.get('/api/products', async (req, res) => res.json(PRODUCTS));

app.get('/api/wallet', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  res.json(doc.data().wallets);
});

// RECHARGE - NEW
app.post('/api/recharge', authenticate, async (req, res) => {
  try {
    const { amount } = req.body;
    const amt = parseInt(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const ref = usersCollection.doc(req.user.id);
    const snap = await ref.get();
    const data = snap.data();
    data.wallets.recharge = (data.wallets.recharge || 0) + amt;
    await ref.update({ wallets: data.wallets });
    res.json({ message: `Recharged ${amt} UGX`, wallets: data.wallets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// RENT LOGIC SHARED
const handleRent = async (req, res) => {
  try {
    const { productId } = req.body;
    const product = PRODUCTS.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const ref = usersCollection.doc(req.user.id);
    const snap = await ref.get();
    const user = snap.data();
    if ((user.wallets.recharge || 0) < product.price) return res.status(400).json({ error: 'Insufficient recharge balance' });
    user.wallets.recharge -= product.price;
    user.products.push({...product, boughtAt: new Date().toISOString(), lastClaim: null });
    await ref.update({ wallets: user.wallets, products: user.products });
    res.json({ message: 'Rented successfully', wallets: user.wallets, products: user.products });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

app.post('/api/rent', authenticate, handleRent);
app.post('/api/buy', authenticate, handleRent);
app.post('/api/purchase', authenticate, handleRent);

app.post('/api/checkin', authenticate, async (req, res) => {
  const ref = usersCollection.doc(req.user.id);
  const snap = await ref.get();
  const user = snap.data();
  const today = new Date().toISOString().split('T')[0];
  if (user.lastCheckin === today) return res.status(400).json({ error: 'Already checked in today' });
  user.wallets.withdrawal = (user.wallets.withdrawal || 0) + 100;
  user.lastCheckin = today;
  await ref.update({ wallets: user.wallets, lastCheckin: today });
  res.json({ message: 'Check-in successful! +100 UGX added', newBalance: user.wallets.withdrawal });
});

app.post('/api/daily-checkin', authenticate, async (req, res) => {
  const ref = usersCollection.doc(req.user.id);
  const snap = await ref.get();
  const user = snap.data();
  const today = new Date().toISOString().split('T')[0];
  if (user.lastCheckin === today) return res.status(400).json({ error: 'Already checked in today' });
  user.wallets.withdrawal = (user.wallets.withdrawal || 0) + 100;
  user.lastCheckin = today;
  await ref.update({ wallets: user.wallets, lastCheckin: today });
  res.json({ message: 'Check-in successful! +100 UGX added', newBalance: user.wallets.withdrawal });
});

app.post('/api/withdraw', authenticate, async (req, res) => {
  try {
    const { amount, phone } = req.body;
    const amt = parseInt(amount);
    if (!amt || amt < 5000) return res.status(400).json({ error: 'Minimum withdrawal is 5000 UGX' });
    const ref = usersCollection.doc(req.user.id);
    const snap = await ref.get();
    const user = snap.data();
    if ((user.wallets.withdrawal || 0) < amt) return res.status(400).json({ error: 'Insufficient withdrawal balance' });
    user.wallets.withdrawal -= amt;
    await ref.update({ wallets: user.wallets });
    const withdrawId = generateId();
    await db.collection('withdrawals').doc(withdrawId).set({
      id: withdrawId, userId: user.id, username: user.username, phone: phone || user.phone, amount: amt, status: 'pending', createdAt: new Date().toISOString()
    });
    res.json({ message: 'Withdrawal requested', newBalance: user.wallets.withdrawal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/team', authenticate, async (req, res) => {
  try {
    const doc = await usersCollection.doc(req.user.id).get();
    const user = doc.data();
    res.json({ username: user.username, downlines: { level1: user.downlines || [], level2: [], level3: [] }, commissions: user.commissions, totalTeamIncome: 0, activeMembers: user.downlines.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/referrals', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  const user = doc.data();
  res.json({ username: user.username, downlines: { level1: user.downlines || [], level2: [], level3: [] }, commissions: user.commissions });
});

app.get('/api/admin/withdrawals', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey!== process.env.ADMIN_KEY && adminKey!== 'rhinoverse123') return res.status(403).json({ error: 'Admin access denied' });
  const snap = await db.collection('withdrawals').where('status', '==', 'pending').get();
  res.json(snap.docs.map(d => d.data()));
});

app.post('/api/admin/withdraw/:id', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey!== process.env.ADMIN_KEY && adminKey!== 'rhinoverse123') return res.status(403).json({ error: 'Admin access denied' });
  const { status } = req.body;
  await db.collection('withdrawals').doc(req.params.id).update({ status: status || 'approved' });
  res.json({ message: 'Updated' });
});

module.exports = app;
