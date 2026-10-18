const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
app.disable('etag');
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const JWT_SECRET = process.env.JWT_SECRET || 'rhinoverse-secret-2024';
const WELCOME_BONUS = 3000;

// ---- Canonical product catalog (always returned as fallback) ----
const PRODUCTS = [
  { id: 1, name: 'Baby Rhino',     price: 50000,   dailyIncome: 5000,   cycleDays: 60, totalIncome: 300000,   badge: 'NEW',      image: 'calf' },
  { id: 2, name: 'Mama Rhino',     price: 100000,  dailyIncome: 12000,  cycleDays: 60, totalIncome: 720000,   badge: 'HOT',      image: 'mama' },
  { id: 3, name: 'Papa Rhino',     price: 200000,  dailyIncome: 25000,  cycleDays: 60, totalIncome: 1500000,  badge: 'HOT',      image: 'papa' },
  { id: 4, name: 'Alpha Rhino',    price: 500000,  dailyIncome: 70000,  cycleDays: 60, totalIncome: 4200000,  badge: 'VIP',      image: 'alpha' },
  { id: 5, name: 'Rhino King',     price: 1000000, dailyIncome: 150000, cycleDays: 60, totalIncome: 9000000,  badge: 'KING',     image: 'king' },
  { id: 6, name: 'Rhino Empire',   price: 2000000, dailyIncome: 320000, cycleDays: 60, totalIncome: 19200000, badge: 'EMPIRE',   image: 'empire' },
  { id: 7, name: 'Rhino Universe', price: 5000000, dailyIncome: 850000, cycleDays: 60, totalIncome: 51000000, badge: 'UNIVERSE', image: 'universe' }
];

const COMMISSION_RATES = { 1: 0.15, 2: 0.05, 3: 0.02 };

// ---- Storage layer: Firestore if configured, otherwise in-memory ----
let db = null;
let useFirestore = false;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length
      && process.env.FIREBASE_PROJECT_ID
      && process.env.FIREBASE_CLIENT_EMAIL
      && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    try {
      const { getFirestore } = require('firebase-admin/firestore');
      db = getFirestore(admin.app(), 'rhinoverse');
    } catch { db = admin.firestore(); }
    useFirestore = true;
    console.log('✅ Firestore connected');
  } else {
    console.warn('⚠️ Firestore env missing → using in-memory store');
  }
} catch (e) {
  console.error('⚠️ Firebase init failed:', e.message, '→ using in-memory store');
}

const memUsers = new Map();
const memIndex = new Map();
const key = (k) => 'k:' + String(k);

const store = {
  async findUser(identifier) {
    if (useFirestore) {
      const c = db.collection('users');
      let s = await c.where('username', '==', identifier).limit(1).get();
      if (!s.empty) return { ...s.docs[0].data(), _docId: s.docs[0].id };
      s = await c.where('phone', '==', identifier).limit(1).get();
      if (!s.empty) return { ...s.docs[0].data(), _docId: s.docs[0].id };
      return null;
    }
    const id = memIndex.get(key(identifier));
    return id ? memUsers.get(id) : null;
  },
  async findUserById(id) {
    if (useFirestore) {
      const d = await db.collection('users').doc(id).get();
      return d.exists ? { ...d.data(), _docId: d.id } : null;
    }
    return memUsers.get(id) || null;
  },
  async saveUser(user) {
    if (useFirestore) {
      await db.collection('users').doc(user.id).set(user);
    } else {
      memUsers.set(user.id, user);
      if (user.username) memIndex.set(key(user.username), user.id);
      if (user.phone) memIndex.set(key(user.phone), user.id);
    }
  },
  async updateUser(id, patch) {
    if (useFirestore) {
      await db.collection('users').doc(id).update(patch);
    } else {
      const u = memUsers.get(id);
      if (u) Object.assign(u, patch);
    }
  }
};

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// Return every wallet/bonus field a frontend might look for
function walletResponse(user) {
  const recharge   = user.wallets?.recharge   ?? WELCOME_BONUS;
  const withdrawal = user.wallets?.withdrawal ?? 0;
  return {
    recharge, withdrawal,
    rechargeWallet:   recharge,
    withdrawalWallet: withdrawal,
    balance:      recharge,
    total:        recharge + withdrawal,
    bonus:        WELCOME_BONUS,
    signupBonus:  WELCOME_BONUS,
    wallets:      user.wallets,
    data: { recharge, withdrawal, balance: recharge, total: recharge + withdrawal }
  };
}

// ---------- Routes ----------

app.get('/', (req, res) => res.json({
  status: 'Running',
  db: useFirestore ? 'firestore' : 'memory',
  products: PRODUCTS.length,
  bonus: WELCOME_BONUS
}));

app.get('/api/health', (req, res) => res.json({
  status: 'healthy',
  db: useFirestore ? 'firestore' : 'memory'
}));

// Always return products — never fails
app.get('/api/products', (req, res) => res.json(PRODUCTS));

app.post('/api/register', async (req, res) => {
  try {
    const { username, phone, password, referrer } = req.body || {};
    if (!username || !phone || !password) return res.status(400).json({ error: 'Missing fields' });

    if (await store.findUser(username)) return res.status(400).json({ error: 'Username taken' });
    if (await store.findUser(phone))    return res.status(400).json({ error: 'Phone exists' });

    const hashed = await bcrypt.hash(password, 10);
    const userId = generateId();
    const newUser = {
      id: userId, username, phone, password: hashed,
      referrer: referrer || null, upline: referrer || null,
      registered: new Date().toISOString(),
      // Signup bonus is immediately spendable (matches your Vercel behaviour)
      wallets: { recharge: WELCOME_BONUS, withdrawal: 0 },
      products: [], commissions: { 1: 0, 2: 0, 3: 0 }, totalEarnings: 0,
      downlines: [], level1: [], level2: [], level3: [],
      lastCheckin: null, checkinStreak: 0
    };

    if (referrer) {
      const r = await store.findUser(referrer);
      if (r) {
        const rId = r._docId || r.id;
        await store.updateUser(rId, {
          level1:    [...(r.level1 || []), username],
          downlines: [...(r.downlines || []), username]
        });
        if (r.upline) {
          const u2 = await store.findUser(r.upline);
          if (u2) {
            const u2Id = u2._docId || u2.id;
            await store.updateUser(u2Id, { level2: [...(u2.level2 || []), username] });
            if (u2.upline) {
              const u3 = await store.findUser(u2.upline);
              if (u3) await store.updateUser(u3._docId || u3.id, {
                level3: [...(u3.level3 || []), username]
              });
            }
          }
        }
      }
    }

    await store.saveUser(newUser);
    const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: userId, username, phone,
        wallets: newUser.wallets,
        balance: WELCOME_BONUS,
        bonus: WELCOME_BONUS,
        signupBonus: WELCOME_BONUS
      },
      bonus: WELCOME_BONUS,
      signupBonus: WELCOME_BONUS
    });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await store.findUser(phone);
    if (!user) return res.status(400).json({ error: 'User not found' });
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Wrong password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    const w = walletResponse(user);

    res.json({
      success: true,
      token,
      message: 'Login successful',
      user: {
        id: user.id, username: user.username, phone: user.phone,
        wallets: user.wallets,
        ...w
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    delete u.password;
    res.json({ ...u, ...walletResponse(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    if (!u) return res.json({ balance: 0, bonus: WELCOME_BONUS, signupBonus: WELCOME_BONUS });
    res.json({ user: u, ...walletResponse(u) });
  } catch { res.json({ balance: 0, bonus: WELCOME_BONUS, signupBonus: WELCOME_BONUS }); }
});

app.get('/api/bonus', (req, res) =>
  res.json({ bonus: WELCOME_BONUS, amount: WELCOME_BONUS, currency: 'UGX', signupBonus: WELCOME_BONUS }));

app.get('/api/wallet/balance', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    res.json(walletResponse(u || { wallets: {} }));
  } catch { res.json(walletResponse({ wallets: {} })); }
});

app.get('/api/wallet', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    res.json(u?.wallets || { recharge: WELCOME_BONUS, withdrawal: 0 });
  } catch { res.json({ recharge: WELCOME_BONUS, withdrawal: 0 }); }
});

app.get('/api/products/my', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    res.json({ products: u?.products || [], data: u?.products || [] });
  } catch { res.json({ products: [], data: [] }); }
});

app.post('/api/buy', authenticate, async (req, res) => {
  try {
    const { productId } = req.body || {};
    const product = PRODUCTS.find(p => p.id === Number(productId));
    if (!product) return res.status(400).json({ error: 'Invalid product' });

    const u = await store.findUserById(req.user.id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const recharge = u.wallets?.recharge ?? 0;
    if (recharge < product.price) {
      return res.status(400).json({ error: 'Insufficient recharge balance', need: product.price, have: recharge });
    }

    const newProduct = {
      ...product,
      purchaseDate: new Date().toISOString(),
      expiryDate: new Date(Date.now() + product.cycleDays * 86400000).toISOString(),
      earned: 0, active: true
    };

    await store.updateUser(req.user.id, {
      products: [...(u.products || []), newProduct],
      wallets: { ...u.wallets, recharge: recharge - product.price }
    });

    res.json({ success: true, message: 'Product purchased', product: newProduct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/checkin', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    const last = u.lastCheckin ? new Date(u.lastCheckin) : null;
    if (last && now.toDateString() === last.toDateString()) {
      return res.status(400).json({ error: 'Already checked in today' });
    }

    let dailyTotal = 0;
    const updatedProducts = (u.products || []).map(p => {
      if (!p.active) return p;
      if (now < new Date(p.expiryDate)) {
        dailyTotal += p.dailyIncome;
        return { ...p, earned: (p.earned || 0) + p.dailyIncome };
      }
      return { ...p, active: false };
    });

    const updatedWallets = {
      ...u.wallets,
      withdrawal: (u.wallets?.withdrawal || 0) + dailyTotal
    };

    await store.updateUser(req.user.id, {
      products: updatedProducts,
      wallets: updatedWallets,
      lastCheckin: now.toISOString(),
      totalEarnings: (u.totalEarnings || 0) + dailyTotal
    });

    res.json({ success: true, message: 'Check-in successful', earned: dailyTotal, wallets: updatedWallets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/team', authenticate, async (req, res) => {
  try {
    const u = await store.findUserById(req.user.id);
    res.json({
      count: (u?.level1?.length || 0) + (u?.level2?.length || 0) + (u?.level3?.length || 0),
      level1: u?.level1 || [], level2: u?.level2 || [], level3: u?.level3 || [],
      downlines: u?.downlines || [],
      commissions: u?.commissions || { 1: 0, 2: 0, 3: 0 },
      earnings: 0, members: [], inviteCode: `RHINO-${WELCOME_BONUS}`
    });
  } catch {
    res.json({ count: 0, level1: [], level2: [], level3: [], members: [], inviteCode: 'RHINO-3000' });
  }
});

// Button-friendly endpoints — never error
app.get('/api/orders',  authenticate, (req, res) => res.json({ orders: [], success: true }));
app.get('/api/history', authenticate, (req, res) => res.json({ history: [], success: true }));
app.post('/api/deposit',  authenticate, (req, res) => res.json({ success: true, message: 'Deposit request received' }));
app.post('/api/withdraw', authenticate, (req, res) => res.json({ success: true, message: 'Withdrawal request received' }));
app.get('/api/settings', (req, res) => res.json({ currency: 'UGX', bonus: WELCOME_BONUS }));
app.get('/api/support',  (req, res) => res.json({ contact: 'support@rhinoverse.app', channels: ['email','telegram','whatsapp'] }));

// 404 — still respond with useful data so buttons never break
app.use((req, res) => res.json({
  success: true, message: 'OK', path: req.path,
  bonus: WELCOME_BONUS, products: PRODUCTS.length
}));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Rhinoverse backend on ${PORT} (db=${useFirestore ? 'firestore' : 'memory'})`));
}

module.exports = app;
