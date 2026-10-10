require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const serverless = require('serverless-http');

// Safe Firebase init
let db, usersCollection, productsCollection, withdrawalsCollection;
try {
  const fbApp = admin.apps.length? admin.app() : admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
  db = getFirestore(fbApp, 'rhinoverse');
  console.log("✅ Using Firestore Database: rhinoverse");
  usersCollection = db.collection('users');
  productsCollection = db.collection('products');
  withdrawalsCollection = db.collection('withdrawals');
} catch(e){ console.error("Firebase init error", e.message); }

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'rhinoverse-secret-2025';
const WELCOME_BONUS = parseInt(process.env.WELCOME_BONUS) || 3000;
const CHECKIN_REWARD = parseInt(process.env.CHECKIN_REWARD) || 100;
const WITHDRAW_FEE = parseFloat(process.env.WITHDRAW_FEE) || 0.15;
const WITHDRAW_MIN = parseInt(process.env.WITHDRAW_MIN) || 5000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors({ origin: '*' }));
app.use(express.json());

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }
async function findUser(loginId) {
  const byUsername = await usersCollection.where('username', '==', loginId).get();
  if (!byUsername.empty) { const doc = byUsername.docs[0]; return { id: doc.id,...doc.data() }; }
  const byPhone = await usersCollection.where('phone', '==', loginId).get();
  if (!byPhone.empty) { const doc = byPhone.docs[0]; return { id: doc.id,...doc.data() }; }
  return null;
}
async function getUserById(id) {
  const doc = await usersCollection.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id,...doc.data() };
}
async function saveUser(user) { await usersCollection.doc(user.id).set(user); return user; }
async function initProducts() {
  try{
    const snapshot = await productsCollection.limit(1).get();
    if (snapshot.empty) {
      const defaultProducts = [
        { id: 1, name: 'Rhino Calf', price: 20000, dailyIncome: 5000, cycleDays: 60, badge: 'Starter' },
        { id: 2, name: 'Rhino Skin', price: 50000, dailyIncome: 12000, cycleDays: 60, badge: 'Armor' },
        { id: 3, name: 'Rhino Horn', price: 100000, dailyIncome: 25000, cycleDays: 60, badge: 'Attack' },
        { id: 4, name: 'Rhino Vision', price: 130000, dailyIncome: 32000, cycleDays: 60, badge: 'HOT' },
        { id: 5, name: 'Rhino Charge', price: 500000, dailyIncome: 70000, cycleDays: 60, badge: 'HOT' },
        { id: 6, name: 'Rhino King', price: 1000000, dailyIncome: 150000, cycleDays: 60, badge: 'Alpha' },
        { id: 7, name: 'Rhino Legacy', price: 2000000, dailyIncome: 320000, cycleDays: 60, badge: 'Conservation' },
      ];
      for (const p of defaultProducts) { await productsCollection.doc(p.id.toString()).set(p); }
    }
  }catch(e){ console.log("initProducts skipped", e.message); }
}
initProducts();

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try { const decoded = jwt.verify(token, JWT_SECRET); req.userId = decoded.id; next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/api/health', (req, res) => { res.json({ status: 'healthy', db:'rhinoverse', time: new Date().toISOString() }); });
app.get('/', (req, res) => { res.json({ status: 'Rhinoverse Backend Running' }); });

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
    if (!phone ||!password) return res.status(400).json({ error: 'Phone and password required' });
    const user = await findUser(phone);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, user: { id: user.id, username: user.username, phone: user.phone, wallets: user.wallets } });
  } catch (error) { res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/me', authenticate, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password,...safeUser } = user; res.json(safeUser);
});
app.get('/api/products', async (req, res) => {
  const snapshot = await productsCollection.get();
  const products = snapshot.docs.map(doc => ({ id: parseInt(doc.id),...doc.data() })); res.json(products);
});
app.post('/api/rent', authenticate, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'Product ID required' });
    const user = await getUserById(req.userId); if (!user) return res.status(404).json({ error: 'User not found' });
    const productDoc = await productsCollection.doc(productId.toString()).get();
    if (!productDoc.exists) return res.status(404).json({ error: 'Product not found' });
    const product = productDoc.data();
    if (user.products.some(p => p.productId === productId)) return res.status(400).json({ error: 'Already owned' });
    if (user.wallets.recharge < product.price) return res.status(400).json({ error: 'Insufficient recharge balance' });
    user.wallets.recharge -= product.price;
    user.products.push({ productId: product.id, purchasedAt: new Date().toISOString(), totalEarned: 0 });
    const commissionRates = { 1: 0.30, 2: 0.02, 3: 0.01 }; let uplineChain = []; let currentUser = user; let level = 1;
    while (currentUser.upline && level <= 3) { const upline = await findUser(currentUser.upline); if (!upline) break; uplineChain.push({ user: upline, level: level }); currentUser = upline; level++; }
    for (const entry of uplineChain) { const rate = commissionRates[entry.level] || 0; const commission = Math.round(product.price * rate); if (commission > 0) { entry.user.wallets.withdrawal += commission; entry.user.commissions[entry.level] = (entry.user.commissions[entry.level] || 0) + commission; await saveUser(entry.user); } }
    await saveUser(user);
    res.json({ message: 'Product rented', product: product.name, newBalance: user.wallets.recharge });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Rental failed' }); }
});
app.post('/api/checkin', authenticate, async (req, res) => {
  const user = await getUserById(req.userId); if (!user) return res.status(404).json({ error: 'User not found' });
  const today = new Date().toISOString().split('T')[0];
  if (user.lastCheckin === today) return res.status(400).json({ error: 'Already checked in today' });
  user.wallets.withdrawal += CHECKIN_REWARD; user.lastCheckin = today; await saveUser(user);
  res.json({ message: `Check-in successful! +${CHECKIN_REWARD} UGX added`, newBalance: user.wallets.withdrawal });
});
app.post('/api/withdraw', authenticate, async (req, res) => {
  const { amount } = req.body; if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
  if (amount < WITHDRAW_MIN) return res.status(400).json({ error: `Minimum withdrawal is ${WITHDRAW_MIN} UGX` });
  const user = await getUserById(req.userId); if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.products.length === 0) return res.status(400).json({ error: 'You must own at least one product to withdraw' });
  if (user.wallets.withdrawal < amount) return res.status(400).json({ error: 'Insufficient withdrawal balance' });
  const fee = Math.round(amount * WITHDRAW_FEE); const netAmount = amount - fee; user.wallets.withdrawal -= amount; await saveUser(user);
  const withdrawalId = generateId();
  await withdrawalsCollection.doc(withdrawalId).set({ id: withdrawalId, userId: user.id, username: user.username, amount, fee, netAmount, status: 'pending', requestedAt: new Date().toISOString(), approvedAt: null });
  res.json({ message: 'Withdrawal request submitted', requested: amount, fee, net: netAmount, status: 'pending' });
});
app.get('/api/team', authenticate, async (req, res) => {
  const user = await getUserById(req.userId); if (!user) return res.status(404).json({ error: 'User not found' });
  const level1 = user.downlines || []; let level2 = [], level3 = [];
  for (const u1 of level1) { const u1user = await findUser(u1); if (u1user && u1user.downlines) level2 = level2.concat(u1user.downlines); }
  for (const u2 of level2) { const u2user = await findUser(u2); if (u2user && u2user.downlines) level3 = level3.concat(u2user.downlines); }
  res.json({ username: user.username, downlines: { level1, level2, level3 }, commissions: user.commissions, totalTeamIncome: (user.commissions[1] || 0) + (user.commissions[2] || 0) + (user.commissions[3] || 0), activeMembers: level1.length + level2.length + level3.length });
});
app.get('/api/admin/withdrawals', async (req, res) => {
  const provided = req.headers['admin-password']; if (provided!== ADMIN_PASSWORD) return res.status(403).json({ error: 'Admin access denied' });
  const snapshot = await withdrawalsCollection.where('status', '==', 'pending').get();
  const pending = snapshot.docs.map(doc => ({ id: doc.id,...doc.data() })); res.json(pending);
});
app.post('/api/admin/withdraw/:id', async (req, res) => {
  const provided = req.headers['admin-password']; if (provided!== ADMIN_PASSWORD) return res.status(403).json({ error: 'Admin access denied' });
  const { id } = req.params; const { action } = req.body; const docRef = withdrawalsCollection.doc(id); const doc = await docRef.get();
  if (!doc.exists) return res.status(404).json({ error: 'Withdrawal not found' });
  const withdrawal = doc.data(); if (withdrawal.status!== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') { await docRef.update({ status: 'approved', approvedAt: new Date().toISOString() }); res.json({ message: 'Approved' }); }
  else if (action === 'reject') { const user = await getUserById(withdrawal.userId); if (user) { user.wallets.withdrawal += withdrawal.amount; await saveUser(user); } await docRef.update({ status: 'rejected' }); res.json({ message: 'Rejected and refunded' }); }
  else res.status(400).json({ error: 'Invalid action' });
});

module.exports = app;
module.exports.handler = serverless(app);
