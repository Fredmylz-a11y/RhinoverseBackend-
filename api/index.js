const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Admin-Secret','X-MarzPay-Timestamp','X-MarzPay-Signature'] }));
app.use(express.json());
app.disable('etag');
app.use((req,res,next)=>{res.set('Cache-Control','no-store'); next();});

const JWT_SECRET = process.env.JWT_SECRET;
const WELCOME_BONUS = 3000;
let db = null;
let firebaseInitError = null;
const requiredFirebaseEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missingFirebaseEnv = requiredFirebaseEnv.filter((key) => !process.env[key]);
if (!missingFirebaseEnv.length) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }) });
    }
    const { getFirestore } = require('firebase-admin/firestore');
    db = getFirestore(admin.app(), 'rhinoverse');
    console.log('Connected to Firestore database: rhinoverse');
  } catch (e) {
    firebaseInitError = e.message;
    console.error('Firebase initialization failed:', e.message);
  }
} else {
  firebaseInitError = `Missing environment variables: ${missingFirebaseEnv.join(', ')}`;
}

if (!db) {
  app.get('/', (_req, res) => res.status(503).json({ status: 'misconfigured', service: 'rhinoverse-backend' }));
  app.get('/api/health', (_req, res) => res.status(503).json({
    status: 'misconfigured', database: 'rhinoverse', error: firebaseInitError || 'Firestore initialization failed',
    missingEnvironment: missingFirebaseEnv,
  }));
} else {
  const usersCollection = db.collection('users');
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
const findUser = async (identifier) => {
  let snap = await usersCollection.where('username', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  snap = await usersCollection.where('phone', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  snap = await usersCollection.where('referralCode', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  return null;
};
const findUserById = async (id) => {
  const doc = await usersCollection.doc(id).get();
  if (!doc.exists) return null;
  return {...doc.data(), _docId: doc.id };
};
const authenticate = async (req, res, next) => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: 'Backend authentication is not configured. Set a strong JWT_SECRET (at least 32 characters) in Vercel.' });
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please log in again.' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Your session has expired. Please log in again.' }); }
};

// FIXED PRODUCTS WITH IMBB LINKS - WILL NOT BREAK FRONTEND
const PRODUCTS = [
  { id: 1, name: 'Rhino Calf', price: 20000, dailyIncome: 5000, cycleDays: 60, totalIncome: 300000, image: 'https://i.ibb.co/DPsRqfjD/rhino-calf.jpg' },
  { id: 2, name: 'Rhino Skin', price: 50000, dailyIncome: 12000, cycleDays: 60, totalIncome: 720000, badge: 'Armor', image: 'https://i.ibb.co/XxXJPjLV/rhino-skin.jpg' },
  { id: 3, name: 'Rhino Horn', price: 100000, dailyIncome: 25000, cycleDays: 60, totalIncome: 1500000, image: 'https://i.ibb.co/gMT53xct/rhino-horn.jpg' },
  { id: 4, name: 'Rhino Guard', price: 200000, dailyIncome: 50000, cycleDays: 60, totalIncome: 3000000, image: 'https://i.ibb.co/TxWZ8kNM/rhino-charge.jpg' },
  { id: 5, name: 'Rhino Prime', price: 500000, dailyIncome: 90000, cycleDays: 60, totalIncome: 5400000, image: 'https://i.ibb.co/QvW9G5cf/rhino-charge-2.jpg' },
  { id: 6, name: 'Rhino King', price: 1000000, dailyIncome: 150000, cycleDays: 60, totalIncome: 9000000, badge: 'Alpha', image: 'https://i.ibb.co/cK9Sv7jz/rhino-king.jpg' },
  { id: 7, name: 'Rhino Legend', price: 2000000, dailyIncome: 300000, cycleDays: 60, totalIncome: 18000000, badge: 'Legend', image: 'https://i.ibb.co/yFWRM9MH/rhino-gold.jpg' },
];

const COMMISSION_RATES = { 1: 0.30, 2: 0.02, 3: 0.01 };

app.get('/api/health', async (req, res) => {
  try {
    await usersCollection.limit(1).get();
    res.json({ status: 'healthy', db: 'rhinoverse', project: process.env.FIREBASE_PROJECT_ID, authenticationConfigured: Boolean(JWT_SECRET && JWT_SECRET.length >= 32), marzPayConfigured: marzPayConfigured(), marzPayBase: MARZPAY_API_BASE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/', (req, res) => res.json({ status: 'Running', db: 'rhinoverse', full: true }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));
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
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: 'Backend authentication is not configured. Set a strong JWT_SECRET in Vercel.' });
  try {
    const { username, phone, password } = req.body;
    let { referrer } = req.body;
    if (!username || !phone || !password) return res.status(400).json({ error: 'Missing fields' });
    if (await findUser(username)) return res.status(400).json({ error: 'Username taken' });
    if (await findUser(phone)) return res.status(400).json({ error: 'Phone exists' });
    let referrerUser = null;
    if (typeof referrer === 'string') referrer = referrer.trim();
    if (referrer) {
      referrerUser = await findUser(referrer);
      if (!referrerUser) return res.status(400).json({ error: 'Referral code not found. Check the invitation code and try again.' });
      if (referrerUser.phone === phone || referrerUser.username?.toLowerCase() === username.toLowerCase()) return res.status(400).json({ error: 'You cannot refer yourself.' });
      referrer = referrerUser.referralCode || referrerUser.username;
    } else {
      referrer = null;
    }
    const hashed = await bcrypt.hash(password, 10);
    const userId = generateId();
    const referralCode = (String(username).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'RHINO') + generateId().slice(0, 4).toUpperCase();
    const newUser = {
      id: userId, username, phone, password: hashed, referralCode,
      referrer, upline: referrer,
      registered: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      rechargeBalance: 0, earningsBalance: WELCOME_BONUS,
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
    await transactionsCollection.doc(`welcome_${userId}`).set({userId,type:'welcome_bonus',amount:WELCOME_BONUS,status:'success',currency:'UGX',createdAt:new Date().toISOString(),reference:`WELCOME_${userId}`});
    const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registration successful', token, user: { id: userId, username, phone, referralCode, wallets: newUser.wallets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/login', async (req, res) => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: 'Backend authentication is not configured. Set a strong JWT_SECRET in Vercel.' });
  try {
    const { phone, password } = req.body;
    const user = await findUser(phone);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, message: 'Login successful', user: { id: user.id, username: user.username, phone: user.phone, referralCode: user.referralCode || null, wallets: user.wallets } });
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
    const userRef = usersCollection.doc(req.user.id);
    const now = new Date();
    const CHECKIN_REWARD = 100;
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      const user = snap.data();
      const last = user.lastCheckin ? new Date(user.lastCheckin) : null;
      const elapsed = last ? now.getTime() - last.getTime() : Infinity;
      if (elapsed < 24 * 60 * 60 * 1000) {
        const remainingMs = 24 * 60 * 60 * 1000 - elapsed;
        const remainingHours = Math.floor(remainingMs / 3600000);
        const remainingMinutes = Math.ceil((remainingMs % 3600000) / 60000);
        throw new Error(`You have already checked in. Try again in ${remainingHours}h ${remainingMinutes}m.`);
      }
      let productIncome = 0;
      const updatedProducts = (user.products || []).map(p => {
        if (!p.active) return p;
        const expiry = new Date(p.expiryDate);
        if (Number.isFinite(expiry.getTime()) && now < expiry) {
          productIncome += Number(p.dailyIncome || 0);
          return { ...p, earned: Number(p.earned || 0) + Number(p.dailyIncome || 0) };
        }
        return { ...p, active: false };
      });
      const earned = CHECKIN_REWARD + productIncome;
      const recharge = amountOf(user, 'rechargeBalance');
      const withdrawal = amountOf(user, 'earningsBalance') + earned;
      const txRef = transactionsCollection.doc(`checkin_${req.user.id}_${now.getTime()}`);
      tx.update(userRef, {
        ...setWallets(user, recharge, withdrawal), products: updatedProducts,
        lastCheckin: now.toISOString(), totalEarnings: Number(user.totalEarnings || 0) + earned,
        updatedAt: SERVER_TIME()
      });
      tx.create(txRef, { userId: req.user.id, type: 'daily_checkin', amount: CHECKIN_REWARD, status: 'success', currency: 'UGX', createdAt: SERVER_TIME(), reference: `CHECKIN_${req.user.id}_${now.toISOString()}` });
      return { earned, productIncome, wallets: { ...(user.wallets || {}), recharge, withdrawal } };
    });
    res.json({ message: `Check-in successful! You received 100 UGX${result.productIncome ? ` plus ${result.productIncome.toLocaleString()} UGX product income` : ''}.`, earned: result.earned, checkinReward: CHECKIN_REWARD, productIncome: result.productIncome, wallets: result.wallets });
  } catch (e) {
    const alreadyChecked = String(e.message || '').includes('already checked in');
    res.status(alreadyChecked ? 400 : 500).json({ error: e.message || 'Check-in failed.' });
  }
});
const MARZPAY_API_BASE = (process.env.MARZPAY_API_BASE || 'https://wallet.wearemarz.com/api/v1').replace(/\/$/, '');
const marzPayConfigured = () => Boolean(process.env.MARZPAY_API_KEY && process.env.MARZPAY_API_SECRET);
const transactionsCollection = db.collection('transactions');
const ticketsCollection = db.collection('supportTickets');
const bonusCodesCollection = db.collection('bonusCodes');
const withdrawalsCollection = db.collection('withdrawals');
const SERVER_TIME = admin.firestore.FieldValue.serverTimestamp;
const amountOf = (u, key) => { const nested = key === 'rechargeBalance' ? u.wallets?.recharge : u.wallets?.withdrawal; return Number(nested ?? u[key] ?? 0); };
const setWallets = (u, recharge, earnings) => ({
  rechargeBalance: recharge, earningsBalance: earnings,
  wallets: { ...(u.wallets || {}), recharge, withdrawal: earnings }
});
const ugPhoneE164 = (value) => {
  let digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('256')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^7\d{8}$/.test(digits)) throw new Error('Enter a valid Uganda MTN/Airtel number, e.g. 07XXXXXXXX.');
  return `+256${digits}`;
};
const marzPayRequest = async (path, method = 'GET', payload) => {
  if (!marzPayConfigured()) throw new Error('MARZ Pay credentials are missing. Configure MARZPAY_API_KEY and MARZPAY_API_SECRET in backend Vercel environment variables.');
  const auth = Buffer.from(`${process.env.MARZPAY_API_KEY}:${process.env.MARZPAY_API_SECRET}`).toString('base64');
  const response = await fetch(`${MARZPAY_API_BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 500) }; }
  if (!response.ok || data.status === 'error') {
    const error = new Error(data.message || data.error || `MARZ Pay request failed (${response.status})`);
    error.status = response.status;
    error.providerResponse = data;
    throw error;
  }
  return data;
};
const unwrapped = (payload) => payload?.data?.data || payload?.data || payload || {};
const transactionFrom = (payload) => {
  const root = unwrapped(payload);
  return root.transaction || payload?.transaction || {};
};
const statusFrom = (payload) => {
  const root = unwrapped(payload), tx = transactionFrom(payload);
  return String(tx.status || root.collection?.status || root.disbursement?.status || root.transfer?.status || root.withdrawal?.status || payload?.event_type || (!payload?.data ? payload?.status : '') || '').toLowerCase();
};
const rawAmountFrom = (payload) => {
  const root = unwrapped(payload), tx = transactionFrom(payload);
  const candidates = [tx.amount?.raw, tx.amount, root.collection?.amount?.raw, root.withdrawal?.amount?.raw, root.transfer?.amount?.raw];
  const found = candidates.find(v => v !== undefined && v !== null && v !== '');
  return Number(found);
};
const currencyFrom = (payload) => {
  const root = unwrapped(payload), tx = transactionFrom(payload);
  return String(tx.amount?.currency || root.collection?.amount?.currency || root.withdrawal?.amount?.currency || root.transfer?.amount?.currency || '').toUpperCase();
};
const successfulStatus = (status) => ['completed', 'successful', 'success', 'paid'].includes(String(status || '').toLowerCase().split('.').pop());
const failedStatus = (status) => ['failed', 'failure', 'cancelled', 'canceled', 'rejected'].includes(String(status || '').toLowerCase().split('.').pop());
async function settleRecharge(reference, providerStatusPayload) {
  const txRef = transactionsCollection.doc(reference);
  const txSnap = await txRef.get();
  if (!txSnap.exists) throw new Error('Recharge reference was not found.');
  const transaction = txSnap.data();
  const providerTx = transactionFrom(providerStatusPayload);
  const status = statusFrom(providerStatusPayload);
  const amount = rawAmountFrom(providerStatusPayload);
  const currency = currencyFrom(providerStatusPayload);
  if (providerTx.reference !== reference && providerTx.provider_reference !== reference) throw new Error('MARZ Pay reference does not match this recharge.');
  if (!Number.isFinite(amount) || amount !== Number(transaction.amount)) throw new Error('MARZ Pay amount could not be verified against this recharge.');
  if (currency !== 'UGX') throw new Error('MARZ Pay status did not confirm UGX currency; recharge was not credited.');
  if (successfulStatus(status)) {
    const depositor = await findUserById(transaction.userId);
    const uplines = [];
    let nextReferrer = depositor?.referrer || depositor?.upline || null;
    for (let level = 1; level <= 3 && nextReferrer; level++) {
      const referrerUser = await findUser(nextReferrer);
      if (!referrerUser) break;
      const referrerId = referrerUser._docId || referrerUser.id;
      if (!referrerId || referrerId === transaction.userId || uplines.some(x => x.id === referrerId)) break;
      uplines.push({ id: referrerId, level, username: referrerUser.username || '' });
      nextReferrer = referrerUser.referrer || referrerUser.upline || null;
    }
    await db.runTransaction(async (tx) => {
      const currentTx = await tx.get(txRef);
      if (!currentTx.exists) throw new Error('Recharge reference was not found.');
      if (currentTx.data().status === 'success') return;
      const userRef = usersCollection.doc(transaction.userId);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found for this recharge.');
      const refSnaps = await Promise.all(uplines.map(x => tx.get(usersCollection.doc(x.id))));
      const u = userSnap.data();
      const newBalance = amountOf(u, 'rechargeBalance') + Number(transaction.amount);
      const earnings = amountOf(u, 'earningsBalance');
      tx.update(userRef, { ...setWallets(u, newBalance, earnings), updatedAt: SERVER_TIME() });
      for (let i = 0; i < uplines.length; i++) {
        if (!refSnaps[i].exists) continue;
        const recipient = refSnaps[i].data();
        const level = uplines[i].level;
        const commission = Math.floor(Number(transaction.amount) * COMMISSION_RATES[level]);
        if (commission <= 0) continue;
        const recipientRef = usersCollection.doc(uplines[i].id);
        const recipientEarnings = amountOf(recipient, 'earningsBalance');
        const commissions = { 1:0, 2:0, 3:0, ...(recipient.commissions || {}) };
        commissions[level] = Number(commissions[level] || 0) + commission;
        tx.update(recipientRef, {
          ...setWallets(recipient, amountOf(recipient,'rechargeBalance'), recipientEarnings + commission),
          commissions,
          totalTeamIncome: Number(recipient.totalTeamIncome || 0) + commission,
          totalCommission: Number(recipient.totalCommission || 0) + commission,
          updatedAt: SERVER_TIME()
        });
        tx.create(transactionsCollection.doc(`commission_${reference}_L${level}_${uplines[i].id}`), {
          userId: uplines[i].id, type:'referral_commission', amount:commission, level,
          sourceUserId:transaction.userId, sourceRechargeReference:reference, status:'success',
          currency:'UGX', createdAt:SERVER_TIME(), reference:`${reference}_L${level}`
        });
      }
      tx.update(txRef, { status: 'success', providerStatus: status, creditedAt: SERVER_TIME(), providerTransactionId: providerTx.uuid || null, updatedAt: SERVER_TIME() });
    });
    return { status: 'success', credited: true };
  }
  if (failedStatus(status)) {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(txRef);
      if (!current.exists || current.data().status === 'success') return;
      tx.update(txRef, { status: 'failed', providerStatus: status, updatedAt: SERVER_TIME() });
    });
    const latest = await txRef.get();
    return { status: latest.data()?.status === 'success' ? 'success' : 'failed', credited: latest.data()?.status === 'success' };
  }
  await db.runTransaction(async (tx) => {
    const current = await tx.get(txRef);
    if (!current.exists || current.data().status === 'success') return;
    tx.update(txRef, { status: 'pending', providerStatus: status || 'processing', updatedAt: SERVER_TIME() });
  });
  const latest = await txRef.get();
  return { status: latest.data()?.status === 'success' ? 'success' : 'pending', credited: latest.data()?.status === 'success' };
}
app.get('/api/investments/my-products', authenticate, async (req,res) => {
  try { const user=await findUserById(req.user.id); if(!user) return res.status(404).json({error:'User not found'}); res.json({products:user.products||[], data:user.products||[]}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/user/bind-account', authenticate, async (req,res) => {
  try {
    const bankName=String(req.body?.bankName||'').trim(), accountNumber=String(req.body?.accountNumber||'').trim(), holderName=String(req.body?.holderName||'').trim();
    if(!bankName||!accountNumber||!holderName) return res.status(400).json({error:'Bank name, account number and account holder name are required'});
    if(accountNumber.length<4||accountNumber.length>40) return res.status(400).json({error:'Invalid account number'});
    const account={id:crypto.randomUUID(),bankName,accountNumber,holderName,createdAt:new Date().toISOString()};
    await usersCollection.doc(req.user.id).update({boundAccount:account});
    res.json({message:'Account bound successfully',account:{...account,accountNumber:`••••${accountNumber.slice(-4)}`}});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/bonus/redeem', authenticate, async (req,res) => {
  try {
    const code=String(req.body?.code||'').trim().toUpperCase();
    if(!code) return res.status(400).json({error:'Enter a bonus code'});
    const userRef=usersCollection.doc(req.user.id), codeRef=bonusCodesCollection.doc(code);
    const result=await db.runTransaction(async tx=>{
      const [u,c]=await Promise.all([tx.get(userRef),tx.get(codeRef)]);
      if(!u.exists) throw new Error('User not found');
      if(!c.exists||!c.data().active) throw new Error('Invalid or expired bonus code');
      const ud=u.data(), cd=c.data();
      if((ud.redeemedBonusCodes||[]).includes(code)) throw new Error('Bonus code already redeemed');
      const amount=Number(cd.amount); if(!Number.isFinite(amount)||amount<=0) throw new Error('Bonus code is not configured correctly');
      const earnings=amountOf(ud,'earningsBalance')+amount;
      tx.update(userRef,{...setWallets(ud,amountOf(ud,'rechargeBalance'),earnings),redeemedBonusCodes:[...(ud.redeemedBonusCodes||[]),code]});
      tx.create(transactionsCollection.doc(),{userId:req.user.id,type:'bonus',amount,status:'success',currency:'UGX',createdAt:new Date().toISOString(),reference:code});
      return amount;
    });
    res.json({message:'Bonus code redeemed successfully',credited:result});
  } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/transactions/history', authenticate, async(req,res)=>{
  try {
    const snap=await transactionsCollection.where('userId','==',req.user.id).get();
    const asIso=(value)=>value?.toDate?.()?.toISOString?.() || (value instanceof Date ? value.toISOString() : value);
    const rows=snap.docs.map(d=>{const row=d.data();return {id:d.id,...row,createdAt:asIso(row.createdAt),updatedAt:asIso(row.updatedAt),creditedAt:asIso(row.creditedAt)};}).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.json({transactions:rows,data:rows});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/auth/change-password', authenticate, async(req,res)=>{
  try { const {oldPassword,newPassword}=req.body||{}; if(!oldPassword||typeof newPassword!=='string'||newPassword.length<6) return res.status(400).json({error:'Enter your current password and a new password of at least 6 characters'}); const ref=usersCollection.doc(req.user.id),snap=await ref.get(); if(!snap.exists)return res.status(404).json({error:'User not found'}); if(!await bcrypt.compare(oldPassword,snap.data().password))return res.status(400).json({error:'Current password is incorrect'}); await ref.update({password:await bcrypt.hash(newPassword,10)}); res.json({message:'Password changed successfully'}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/support/tickets', authenticate, async(req,res)=>{
  try { const snap=await ticketsCollection.where('userId','==',req.user.id).get(); const tickets=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))); res.json({tickets,data:tickets}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/support/tickets', authenticate, async(req,res)=>{
  try { const subject=String(req.body?.subject||'').trim(),message=String(req.body?.message||'').trim(); if(!subject||!message)return res.status(400).json({error:'Subject and message are required'}); const ticket={userId:req.user.id,subject:subject.slice(0,160),message:message.slice(0,5000),status:'open',createdAt:new Date().toISOString()}; const ref=await ticketsCollection.add(ticket); res.status(201).json({message:'Support ticket submitted',ticket:{id:ref.id,...ticket}}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/checkin/daily', authenticate, async(req,res,next)=>{req.url='/api/checkin';next();});
async function initiateMarzRecharge(req, res) {
  let txRef=null;
  try {
    const amount=Number(req.body?.amount);
    if(!Number.isInteger(amount)||amount<500||amount>10000000) return res.status(400).json({error:'Recharge must be between 500 and 10,000,000 UGX.'});
    const user=await findUserById(req.user.id); if(!user) return res.status(404).json({error:'User not found'});
    const requestedPhone=req.body?.phone_number || req.body?.phone || user.phone;
    const phone=ugPhoneE164(requestedPhone), reference=crypto.randomUUID();
    const requestedNetwork=String(req.body?.network||'').trim().toUpperCase();
    if (requestedNetwork && !['MTN','AIRTEL'].includes(requestedNetwork)) return res.status(400).json({error:'Select MTN or Airtel.'});
    const callbackUrl=process.env.MARZPAY_CALLBACK_URL || process.env.MARZPAY_WEBHOOK_URL || (process.env.BACKEND_PUBLIC_URL ? `${process.env.BACKEND_PUBLIC_URL.replace(/\/$/,'')}/api/marzpay/webhook` : undefined);
    txRef=transactionsCollection.doc(reference);
    await txRef.create({userId:req.user.id,type:'recharge',amount,status:'creating',provider:'marzpay',reference,currency:'UGX',phoneNumber:phone,requestedNetwork:requestedNetwork||null,createdAt:new Date().toISOString()});
    const provider=await marzPayRequest('/collect-money','POST',{
      amount,phone_number:phone,reference,country:'UG',method:'mobile_money',description:`Rhinoverse wallet recharge ${reference}`,
      ...(callbackUrl?{callback_url:callbackUrl}:{}),metadata:[{rhinoverseUserId:req.user.id},{rhinoverseTransactionReference:reference},{requestedNetwork:requestedNetwork||'UNSPECIFIED'}]
    });
    const root=unwrapped(provider),providerTx=transactionFrom(provider),providerUuid=providerTx.uuid||root.uuid||null;
    const providerStatus=String(providerTx.status||'processing').toLowerCase();
    await db.runTransaction(async tx=>{
      const current=await tx.get(txRef); if(!current.exists)return;
      const patch={providerUuid,providerStatus,providerName:root.collection?.provider||null,updatedAt:SERVER_TIME()};
      if(current.data().status!=='success') patch.status=failedStatus(providerStatus)?'failed':'pending';
      tx.update(txRef,patch);
    });
    const latest=await txRef.get();
    if(latest.data()?.status==='failed') return res.status(502).json({error:'MARZ Pay did not accept the recharge. No wallet credit was made.',reference});
    return res.status(202).json({message:'Recharge started. Approve the MTN or Airtel payment prompt on your phone.',reference,providerUuid,status:'pending',amount,currency:'UGX',phoneNumber:phone,provider:root.collection?.provider||'mobile money'});
  } catch(e) {
    console.error('[MARZPAY] recharge initiation failed:', JSON.stringify({status:e.status||null,message:e.message||'Unknown provider error',providerResponse:e.providerResponse||null}));
    const definitiveProviderRejection=Number.isInteger(e.status)&&e.status>=400&&e.status<500;
    if(txRef) await db.runTransaction(async tx=>{const current=await tx.get(txRef);if(current.exists&&current.data().status!=='success')tx.update(txRef,{status:definitiveProviderRejection?'failed':'provider_unknown',errorMessage:String(e.message||'Provider result is uncertain; reconcile before retrying').slice(0,300),updatedAt:SERVER_TIME()});}).catch(()=>{});
    const message=e.status===401?'MARZ Pay rejected its API credentials. Verify the active API key and secret with MARZ Pay.':e.status===403?'MARZ Pay denied the collection request. Confirm Uganda collections are enabled for this account.':e.message?.startsWith('Enter a valid Uganda')?e.message:definitiveProviderRejection?'MARZ Pay rejected the recharge request. Check the provider configuration.':'MARZ Pay did not return a definitive result. Check the recharge status before trying again.';
    return res.status(definitiveProviderRejection?400:202).json(definitiveProviderRejection?{error:message,...(txRef?{reference:txRef.id,status:'failed'}:{})}:{message:'MARZ Pay response is uncertain. Do not retry yet; check the recharge status.',reference:txRef?.id||null,status:'provider_unknown',error:message});
  }
}
app.post('/api/create-marz-payment', authenticate, initiateMarzRecharge);
app.post('/api/marzpay/recharge', authenticate, initiateMarzRecharge);
app.get('/api/marzpay/recharge/:reference', authenticate, async (req,res) => {
  try {
    const reference=String(req.params.reference||'');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)) return res.status(400).json({error:'Invalid recharge reference'});
    const txRef=transactionsCollection.doc(reference),snap=await txRef.get();
    if(!snap.exists||snap.data().userId!==req.user.id||snap.data().type!=='recharge') return res.status(404).json({error:'Recharge was not found'});
    if(['success','failed'].includes(snap.data().status)) return res.json({reference,status:snap.data().status,credited:snap.data().status==='success'});
    if(!snap.data().providerUuid) return res.json({reference,status:'pending',credited:false,message:'Waiting for MARZ Pay transaction reference.'});
    const provider=await marzPayRequest(`/collect-money/${encodeURIComponent(snap.data().providerUuid)}`);
    const state=await settleRecharge(reference,provider);
    res.json({reference,...state,message:state.status==='success'?'Recharge credited successfully.':state.status==='failed'?'MARZ Pay reported that the recharge failed.':'Payment is still processing.'});
  } catch(e) {
    console.error('[MARZPAY] status check failed:',e.message);
    res.status(502).json({error:'Could not verify the recharge status with MARZ Pay. The wallet was not credited.'});
  }
});
const handleMarzPayWebhook = async (req,res) => {
  try {
    const payload=req.body||{},root=payload.data&&typeof payload.data==='object'?payload.data:payload;
    const providerTx=root.transaction||payload.transaction||{};
    const reference=String(providerTx.reference||root.reference||providerTx.provider_reference||'');
    const callbackUuid=String(providerTx.uuid||root.uuid||'');
    if(!reference||!callbackUuid) return res.status(400).json({error:'Missing MARZ Pay transaction reference or UUID'});
    const localRef=transactionsCollection.doc(reference),localSnap=await localRef.get();
    if(!localSnap.exists||localSnap.data().type!=='recharge') return res.status(404).json({error:'Unknown recharge reference'});
    if(localSnap.data().status==='success') return res.status(200).json({received:true,credited:true});
    const provider=await marzPayRequest(`/collect-money/${encodeURIComponent(localSnap.data().providerUuid||callbackUuid)}`);
    const state=await settleRecharge(reference,provider);
    return res.status(200).json({received:true,status:state.status,credited:state.credited});
  } catch(e) {
    console.error('[MARZPAY] webhook not reconciled:',e.message);
    return res.status(503).json({received:false,error:'Could not independently verify this callback with MARZ Pay; no wallet credit was made.'});
  }
};
app.post(['/api/marzpay/webhook','/api/marzpay/callback'], handleMarzPayWebhook);
app.get('/api/team', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const memberNames = {
      level1: Array.isArray(user.level1) ? user.level1 : [],
      level2: Array.isArray(user.level2) ? user.level2 : [],
      level3: Array.isArray(user.level3) ? user.level3 : []
    };
    const levels = {};
    for (const [level, names] of Object.entries(memberNames)) {
      levels[level] = await Promise.all([...new Set(names)].map(async name => {
        const member = await findUser(name);
        if (!member) return { username: name, joinedAt: null, status: 'Unknown' };
        return {
          username: member.username || name,
          joinedAt: member.createdAt || member.registered || null,
          status: member.status || (member.disabled ? 'Inactive' : 'Active')
        };
      }));
    }
    const commissions = {1:0,2:0,3:0,...(user.commissions || {})};
    const allMembers = [...levels.level1, ...levels.level2, ...levels.level3];
    for (const member of allMembers) {
      const record = await findUser(member.username);
      const products = record?.products || [];
      member.status = products.length > 0 || Boolean(record?.hasPurchasedProduct) ? 'Active' : 'Inactive';
    }
    const teamIncome = Number(user.totalTeamIncome ?? (Number(commissions[1]||0)+Number(commissions[2]||0)+Number(commissions[3]||0)));
    res.json({
      referralCode: user.referralCode || null,
      referralLink: `https://frontend-deploy-plum-nu.vercel.app/?ref=${encodeURIComponent(user.referralCode || '')}`,
      level1: levels.level1, level2: levels.level2, level3: levels.level3,
      downlines: user.downlines || [], commissions,
      totalInvitations: new Set(allMembers.map(m => m.username)).size,
      activeMembers: allMembers.filter(m => m.status === 'Active').length,
      totalTeamIncome: teamIncome,
      yourBonus: Number(user.yourBonus || 0)
    });
  } catch (e) {
    console.error('[TEAM] Could not load team:', e.message);
    res.status(500).json({ error: 'Could not load team data' });
  }
});
const rentalsCollection = db.collection('rentals');
const earningsCollection = db.collection('earnings');
app.post('/api/rent', authenticate, async (req,res) => {
  try {
    const product = PRODUCTS.find(p => String(p.id) === String(req.body?.productId));
    if (!product) return res.status(400).json({error:'Invalid product'});
    const userRef = usersCollection.doc(req.user.id), rentalRef = rentalsCollection.doc(), txRef = transactionsCollection.doc();
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef); if(!snap.exists) throw new Error('User not found');
      const u=snap.data(), recharge=amountOf(u,'rechargeBalance'), earnings=amountOf(u,'earningsBalance');
      if(recharge < product.price) throw new Error('Please recharge, insufficient balance');
      const rentedAt = new Date(), expiresAt = new Date(rentedAt.getTime() + product.cycleDays*86400000);
      const rental = {userId:req.user.id,productId:product.id,name:product.name,price:product.price,dailyIncome:product.dailyIncome,duration:product.cycleDays,status:'active',rentedAt:admin.firestore.Timestamp.fromDate(rentedAt),expiresAt:admin.firestore.Timestamp.fromDate(expiresAt),lastPayoutDate:null,createdAt:SERVER_TIME()};
      const userProducts=[...(u.products||[]),{productId:product.id,name:product.name,price:product.price,dailyIncome:product.dailyIncome,duration:product.cycleDays,active:true,rentalId:rentalRef.id,rentedAt:admin.firestore.Timestamp.fromDate(rentedAt),expiresAt:admin.firestore.Timestamp.fromDate(expiresAt)}];
      tx.update(userRef,{...setWallets(u,recharge-product.price,earnings),products:userProducts});
      tx.set(rentalRef,rental); tx.set(txRef,{userId:req.user.id,type:'rent',amount:-product.price,productId:product.id,status:'success',createdAt:SERVER_TIME()});
      return {rentalId:rentalRef.id,balance:recharge-product.price};
    });
    console.log('Rental created',req.user.id,product.id); res.status(201).json({message:'Rented successfully, daily income will start',...result});
  } catch(e) { console.error('Rent failed',e); res.status(400).json({error:e.message}); }
});
app.post('/api/withdrawals', authenticate, async (req,res) => {
  const minWithdraw = Number(process.env.MIN_WITHDRAWAL || 500);
  let withdrawalId = null;
  try {
    const amount=Number(req.body?.amount);
    if(!Number.isInteger(amount)||amount<minWithdraw) return res.status(400).json({error:`Minimum withdrawal is ${minWithdraw} UGX`});
    if(process.env.MARZPAY_ENABLE_LIVE_PAYOUTS!=='true') return res.status(503).json({error:'Automatic withdrawals are not enabled on the MARZ Pay merchant account yet. Enable MARZPAY_ENABLE_LIVE_PAYOUTS only after the provider confirms bank-transfer access, account permissions, fees and allowlisting.'});
    if(!marzPayConfigured()) return res.status(503).json({error:'MARZ Pay API credentials are not configured.'});
    const userRef=usersCollection.doc(req.user.id), withdrawalRef=withdrawalsCollection.doc(), txRef=transactionsCollection.doc();
    await db.runTransaction(async tx=>{
      const snap=await tx.get(userRef); if(!snap.exists) throw new Error('User not found');
      const u=snap.data(), earnings=amountOf(u,'earningsBalance'), account=u.boundAccount;
      const products=u.products||[];
      const hasPurchased=products.length>0 || Boolean(u.hasPurchasedProduct);
      if(!hasPurchased) throw new Error('Purchase at least one product before withdrawing.');
      if(!account?.bankName||!account?.accountNumber||!account?.holderName) throw new Error('Bind a valid payout account before requesting a withdrawal.');
      if(earnings<amount) throw new Error('Insufficient withdrawal balance.');
      tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings-amount),pendingWithdrawal:Number(u.pendingWithdrawal||0)+amount});
      tx.create(withdrawalRef,{userId:req.user.id,amount,status:'processing',bindAccountId:account.id,createdAt:SERVER_TIME(),updatedAt:SERVER_TIME(),currency:'UGX',automatic:true});
      tx.create(txRef,{userId:req.user.id,type:'withdrawal',amount,status:'processing',createdAt:SERVER_TIME(),withdrawalId:withdrawalRef.id,currency:'UGX'});
    });
    withdrawalId=withdrawalRef.id;
    const u=await findUserById(req.user.id), account=u?.boundAccount;
    try {
      await marzPayRequest('/bank-transfer/validate','POST',{bank_name:account.bankName,account_number:account.accountNumber});
      const result=await marzPayRequest('/bank-transfer','POST',{amount,description:`Rhinoverse withdrawal ${withdrawalId}`,bank_name:account.bankName,bank_account_number:account.accountNumber,bank_account_name:account.holderName,wallet_source:'main',...(account.bankBranch?{bank_branch:account.bankBranch}:{})});
      const root=unwrapped(result),providerTx=transactionFrom(result);
      const providerReference=String(providerTx.reference||root.reference||root.transfer?.reference||'');
      const status=String(providerTx.status||root.status||'pending').toLowerCase();
      if(!providerReference){await withdrawalsCollection.doc(withdrawalId).update({status:'provider_unknown',updatedAt:SERVER_TIME()});return res.status(202).json({message:'Provider did not return a transfer reference. Funds remain reserved while the transfer is reconciled.',status:'provider_unknown',withdrawalId});}
      if(successfulStatus(status)){await updateWithdrawalTransaction(withdrawalId,'paid',providerReference,{providerStatus:status,automatic:true});return res.json({message:'Withdrawal paid successfully.',status:'paid',withdrawalId,providerReference});}
      if(failedStatus(status)){await updateWithdrawalTransaction(withdrawalId,'failed_refunded',providerReference,{providerStatus:status,automatic:true});return res.status(502).json({error:'Provider reported a failed transfer; reserved funds were returned.',status:'failed_refunded',withdrawalId});}
      await withdrawalsCollection.doc(withdrawalId).update({status:'provider_pending',providerReference,providerStatus:status,updatedAt:SERVER_TIME()});
      return res.status(202).json({message:'Withdrawal sent to the payment provider and is awaiting confirmation.',status:'provider_pending',withdrawalId,providerReference});
    } catch(providerError) {
      const definitive=providerError.status&&providerError.status<500;
      if(definitive) {
        await updateWithdrawalTransaction(withdrawalId,'failed_refunded',null,{automatic:true,providerError:String(providerError.message||'Provider rejected transfer').slice(0,300)});
      } else {
        await withdrawalsCollection.doc(withdrawalId).update({status:'provider_unknown',providerError:String(providerError.message||'Provider response uncertain').slice(0,300),updatedAt:SERVER_TIME()});
      }
      return res.status(definitive?502:202).json({error:definitive?'Payment provider rejected the withdrawal; funds were returned.':'Provider response is uncertain. Funds remain reserved while status is reconciled.',status:definitive?'failed_refunded':'provider_unknown',withdrawalId});
    }
  } catch(e) { console.error('Automatic withdrawal request failed:',e.message); return res.status(400).json({error:e.message}); }
});
const adminSecretMatches = (provided) => {
  const secret=process.env.ADMIN_API_SECRET;
  if(!secret||!provided)return false;
  const a=Buffer.from(String(secret)),b=Buffer.from(String(provided));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
};
const requireAdminSecret = (req,res) => {
  if(!adminSecretMatches(req.headers['x-admin-secret'])) { res.status(401).json({error:'Admin access denied. Set ADMIN_API_SECRET on the backend and enter it in the admin panel.'}); return false; }
  return true;
};
app.get('/api/admin/withdrawals', async(req,res)=>{
  if(!requireAdminSecret(req,res)) return;
  try {
    const status=String(req.query.status||'pending'),snap=await withdrawalsCollection.get(),items=[];
    for(const doc of snap.docs) {
      const w=doc.data(); if(status!=='all'&&w.status!==status)continue;
      const u=await findUserById(w.userId),a=u?.boundAccount||{};
      items.push({id:doc.id,userId:w.userId,username:u?.username||'',phone:u?.phone||'',amount:Number(w.amount||0),currency:w.currency||'UGX',status:w.status,createdAt:w.createdAt?.toDate?.()?.toISOString?.()||w.createdAt||null,bankName:a.bankName||'',holderName:a.holderName||'',accountLast4:String(a.accountNumber||'').slice(-4),providerReference:w.providerReference||null,providerStatus:w.providerStatus||null});
    }
    items.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.json({success:true,data:items});
  } catch(e){res.status(500).json({error:'Unable to load withdrawal requests.'});}
});
async function updateWithdrawalTransaction(withdrawalId, status, providerReference, extra = {}) {
  const wRef=withdrawalsCollection.doc(withdrawalId);
  await db.runTransaction(async tx=>{
    const wSnap=await tx.get(wRef); if(!wSnap.exists)throw new Error('Withdrawal not found');
    const w=wSnap.data();
    if(['paid','rejected','failed_refunded'].includes(w.status))return;
    const uRef=usersCollection.doc(w.userId),uSnap=await tx.get(uRef);
    const historySnap=await tx.get(transactionsCollection.where('withdrawalId','==',withdrawalId).limit(1));
    if(!uSnap.exists)throw new Error('User not found');
    const u=uSnap.data();
    if(status==='rejected'||status==='failed_refunded') {
      const earnings=amountOf(u,'earningsBalance')+Number(w.amount||0);
      tx.update(uRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings),pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(w.amount||0))});
    } else if(status==='paid') {
      tx.update(uRef,{pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(w.amount||0))});
    }
    tx.update(wRef,{status,providerReference:providerReference||w.providerReference||null,...extra,updatedAt:SERVER_TIME()});
    if(!historySnap.empty)tx.update(historySnap.docs[0].ref,{status:status==='paid'?'success':status==='rejected'||status==='failed_refunded'?'failed':status,providerReference:providerReference||w.providerReference||null,updatedAt:SERVER_TIME()});
  });
}
async function refreshBankTransfer(withdrawalId) {
  const wRef=withdrawalsCollection.doc(withdrawalId),snap=await wRef.get();
  if(!snap.exists)throw new Error('Withdrawal not found');
  const w=snap.data(); if(!w.providerReference)throw new Error('No MARZ Pay transfer reference exists yet.');
  const data=await marzPayRequest(`/bank-transfer/${encodeURIComponent(w.providerReference)}`),status=statusFrom(data);
  if(successfulStatus(status))await updateWithdrawalTransaction(withdrawalId,'paid',w.providerReference,{providerStatus:status});
  else if(failedStatus(status))await updateWithdrawalTransaction(withdrawalId,'failed_refunded',w.providerReference,{providerStatus:status});
  else await wRef.update({status:'provider_pending',providerStatus:status||'pending',updatedAt:SERVER_TIME()});
  return {status:successfulStatus(status)?'paid':failedStatus(status)?'failed_refunded':'provider_pending',providerStatus:status||'pending'};
}
app.get('/api/withdrawals/:id/status', authenticate, async (req, res) => {
  try {
    const ref = withdrawalsCollection.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Withdrawal not found.' });
    const w = snap.data();
    if (w.userId !== req.user.id) return res.status(403).json({ error: 'Not allowed to view this withdrawal.' });
    let status = String(w.status || 'processing');
    let providerStatus = w.providerStatus || null;
    if (w.providerReference && !['paid', 'failed_refunded', 'rejected'].includes(status)) {
      try {
        const refreshed = await refreshBankTransfer(req.params.id);
        status = refreshed.status;
        providerStatus = refreshed.providerStatus;
      } catch (e) {
        console.error('[MARZPAY] withdrawal status check failed:', String(e.message || e).slice(0, 250));
      }
    }
    const latest = await ref.get();
    const current = latest.data() || w;
    res.json({ withdrawalId: latest.id, status: current.status || status, providerStatus: current.providerStatus || providerStatus, amount: Number(current.amount || 0), message: current.status === 'paid' ? 'Withdrawal paid successfully.' : current.status === 'failed_refunded' ? 'Payment failed; the reserved amount was returned to your wallet.' : 'Withdrawal is being processed by the payment provider.' });
  } catch (e) {
    res.status(500).json({ error: 'Unable to check withdrawal status.' });
  }
});
app.post('/api/admin/withdrawals/:id/refresh', async(req,res)=>{
  if(!requireAdminSecret(req,res))return;
  try{res.json({success:true,...await refreshBankTransfer(req.params.id)});}
  catch(e){res.status(502).json({error:e.message||'Unable to check MARZ Pay transfer status.'});}
});
app.post('/api/admin/withdrawals/:id/:action', async(req,res)=>{
  if(!requireAdminSecret(req,res))return;
  const {id,action}=req.params;
  if(!['approve','reject'].includes(action))return res.status(400).json({error:'Invalid action'});
  try {
    const wRef=withdrawalsCollection.doc(id),snap=await wRef.get();
    if(!snap.exists)return res.status(404).json({error:'Withdrawal not found'});
    const w=snap.data();
    if(w.status!=='pending')return res.status(409).json({error:`Withdrawal is ${w.status}, not pending.`});
    if(action==='reject') {
      await updateWithdrawalTransaction(id,'rejected',null,{adminReviewedAt:SERVER_TIME()});
      return res.json({message:'Withdrawal rejected. Reserved funds were returned to the user.',status:'rejected'});
    }
    if(process.env.MARZPAY_ENABLE_LIVE_PAYOUTS!=='true')return res.status(503).json({error:'Live bank payouts are disabled. Confirm bank-transfer access, IP allowlisting, permissions and fees before setting MARZPAY_ENABLE_LIVE_PAYOUTS=true.'});
    if(!marzPayConfigured())return res.status(503).json({error:'MARZ Pay API credentials are not configured.'});
    const user=await findUserById(w.userId),account=user?.boundAccount;
    if(!account?.bankName||!account?.accountNumber||!account?.holderName)return res.status(400).json({error:'The user has no complete bound bank account.'});
    await db.runTransaction(async tx=>{const cur=await tx.get(wRef);if(!cur.exists||cur.data().status!=='pending')throw new Error('Withdrawal is no longer pending');tx.update(wRef,{status:'processing',adminApprovedAt:SERVER_TIME(),updatedAt:SERVER_TIME()});});
    let result;
    try {
      await marzPayRequest('/bank-transfer/validate','POST',{bank_name:account.bankName,account_number:account.accountNumber});
      result=await marzPayRequest('/bank-transfer','POST',{amount:Number(w.amount),description:`Rhinoverse withdrawal ${id}`,bank_name:account.bankName,bank_account_number:account.accountNumber,bank_account_name:account.holderName,wallet_source:'main',...(account.bankBranch?{bank_branch:account.bankBranch}:{})});
    } catch(providerError) {
      if(providerError.status&&providerError.status<500)await wRef.update({status:'pending',providerError:String(providerError.message).slice(0,300),updatedAt:SERVER_TIME()});
      else await wRef.update({status:'provider_unknown',providerError:String(providerError.message).slice(0,300),updatedAt:SERVER_TIME()});
      return res.status(providerError.status&&providerError.status<500?502:202).json({error:'MARZ Pay did not return a confirmed bank-transfer result. The withdrawal remains reserved for reconciliation; do not approve it again until status is checked.'});
    }
    const root=unwrapped(result),providerTx=transactionFrom(result);
    const providerReference=String(providerTx.reference||root.reference||root.transfer?.reference||'');
    if(!providerReference) {await wRef.update({status:'provider_unknown',providerResponseReceived:true,updatedAt:SERVER_TIME()});return res.status(202).json({error:'MARZ Pay returned no bank-transfer reference. Funds remain reserved; reconcile before retrying.'});}
    const status=String(providerTx.status||'pending').toLowerCase();
    if(successfulStatus(status)){await updateWithdrawalTransaction(id,'paid',providerReference,{providerStatus:status,providerResponseReceived:true});return res.json({message:'MARZ Pay completed the bank transfer.',status:'paid',providerReference});}
    if(failedStatus(status)){await updateWithdrawalTransaction(id,'failed_refunded',providerReference,{providerStatus:status,providerResponseReceived:true});return res.status(502).json({error:'MARZ Pay reported that the bank transfer failed. Reserved funds were returned.',status:'failed_refunded'});}
    await wRef.update({status:'provider_pending',providerReference,providerStatus:status,providerResponseReceived:true,updatedAt:SERVER_TIME()});
    return res.status(202).json({message:'Bank transfer submitted to MARZ Pay and awaiting final status.',status:'provider_pending',providerReference});
  } catch(e){console.error('Admin withdrawal action failed:',e.message);return res.status(500).json({error:e.message||'Admin withdrawal action failed.'});}
});
app.post('/api/daily-payout', async(req,res)=>{
  if(!process.env.CRON_SECRET || req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return res.status(401).json({error:'Unauthorized'});
  try {const now=new Date(), day=now.toISOString().slice(0,10), snap=await rentalsCollection.where('status','==','active').get();let paid=0, skipped=0;
    for(const rentalDoc of snap.docs){const r=rentalDoc.data();if(!r.userId||!r.dailyIncome||!r.rentedAt){skipped++;continue;}const userRef=usersCollection.doc(r.userId), payoutRef=earningsCollection.doc(`${rentalDoc.id}_${day}`), txRef=transactionsCollection.doc(`${rentalDoc.id}_${day}`);
      await db.runTransaction(async tx=>{const [us,existing]=await Promise.all([tx.get(userRef),tx.get(payoutRef)]);if(existing.exists)return; if(!us.exists)return;const u=us.data(),end=r.expiresAt?.toDate?.()||new Date(r.expiresAt);if(now>=end){tx.update(rentalDoc.ref,{status:'expired',updatedAt:SERVER_TIME()});return;}const earnings=amountOf(u,'earningsBalance'),income=Number(r.dailyIncome);tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings+income),totalEarnings:Number(u.totalEarnings||0)+income});tx.create(payoutRef,{userId:r.userId,rentalId:rentalDoc.id,amount:income,date:day,createdAt:SERVER_TIME()});tx.create(txRef,{userId:r.userId,type:'earning',amount:income,rentalId:rentalDoc.id,status:'success',createdAt:SERVER_TIME()});tx.update(rentalDoc.ref,{lastPayoutDate:day});paid++;});
    } console.log('Daily payout finished',{day,paid,skipped});res.json({day,paid,skipped});
  }catch(e){console.error('Daily payout failed',e);res.status(500).json({error:e.message});}
});
}

module.exports = app;
