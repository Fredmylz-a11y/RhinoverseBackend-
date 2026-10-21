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

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be set to a strong random secret (32+ characters)');
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
  console.error('Named Firestore database rhinoverse unavailable:', e.message);
  throw e;
}
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
    const referralCode = (String(username).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'RHINO') + generateId().slice(0, 4).toUpperCase();
    const newUser = {
      id: userId, username, phone, password: hashed, referralCode,
      referrer: referrer || null, upline: referrer || null,
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
    const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registration successful', token, user: { id: userId, username, phone, referralCode, wallets: newUser.wallets } });
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


// User account, history and support APIs. Payment-provider actions fail closed until credentials/API URL are configured.
const transactionsCollection = db.collection('transactions');
const ticketsCollection = db.collection('supportTickets');
const bonusCodesCollection = db.collection('bonusCodes');
const MARZPAY_API_BASE = (process.env.MARZPAY_API_BASE || 'https://wallet.wearemarz.com/api/v1').replace(/\/$/, '');
const marzConfigured = () => Boolean(process.env.MARZPAY_API_KEY && process.env.MARZPAY_API_SECRET);
const marzHeaders = () => ({ Authorization: 'Basic ' + Buffer.from(`${process.env.MARZPAY_API_KEY}:${process.env.MARZPAY_API_SECRET}`).toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' });
const normalizePhone = v => { const d=String(v||'').replace(/[^0-9+]/g,''); if(/^\+256[0-9]{9}$/.test(d)) return d; if(/^256[0-9]{9}$/.test(d)) return '+'+d; if(/^0[0-9]{9}$/.test(d)) return '+256'+d.slice(1); return null; };
app.get('/api/investments/my-products', authenticate, async (req,res) => {
  try { const user=await findUserById(req.user.id); if(!user) return res.status(404).json({error:'User not found'}); res.json({products:user.products||[], data:user.products||[]}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/user/bind-account', authenticate, async (req,res) => {
  try { const {bankName,accountNumber,holderName}=req.body||{}; if(![bankName,accountNumber,holderName].every(v=>typeof v==='string'&&v.trim())) return res.status(400).json({error:'Bank name, account number and holder name are required'}); if(accountNumber.trim().length<4||accountNumber.trim().length>40) return res.status(400).json({error:'Invalid account number'}); const account={id:generateId(),bankName:bankName.trim(),accountNumber:accountNumber.trim(),holderName:holderName.trim(),createdAt:new Date().toISOString()}; await usersCollection.doc(req.user.id).update({boundAccount:account}); res.json({message:'Account bound successfully',account:{...account,accountNumber:'••••'+accountNumber.trim().slice(-4)}}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/bonus/redeem', authenticate, async (req,res) => {
  try { const code=String(req.body?.code||'').trim().toUpperCase(); if(!code) return res.status(400).json({error:'Enter a bonus code'}); const userRef=usersCollection.doc(req.user.id); const codeRef=bonusCodesCollection.doc(code); const result=await db.runTransaction(async tx=>{const [u,c]=await Promise.all([tx.get(userRef),tx.get(codeRef)]); if(!u.exists) throw new Error('User not found'); if(!c.exists||!c.data().active) throw new Error('Invalid or expired bonus code'); const ud=u.data(), cd=c.data(); if((ud.redeemedBonusCodes||[]).includes(code)) throw new Error('Bonus code already redeemed'); const amount=Number(cd.amount); if(!Number.isFinite(amount)||amount<=0) throw new Error('Bonus code is not configured correctly'); const wallets={...(ud.wallets||{}),withdrawal:Number(ud.wallets?.withdrawal||0)+amount}; tx.update(userRef,{wallets,redeemedBonusCodes:[...(ud.redeemedBonusCodes||[]),code]}); tx.create(transactionsCollection.doc(),{userId:req.user.id,type:'bonus',amount,status:'success',createdAt:new Date().toISOString(),reference:code}); return amount;}); res.json({message:'Bonus code redeemed successfully',credited:result}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/transactions/history', authenticate, async(req,res)=>{try{const snap=await transactionsCollection.where('userId','==',req.user.id).get();const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({transactions:rows,data:rows});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/auth/change-password', authenticate, async(req,res)=>{try{const {oldPassword,newPassword}=req.body||{};if(!oldPassword||typeof newPassword!=='string'||newPassword.length<6) return res.status(400).json({error:'Enter your current password and a new password of at least 6 characters'});const ref=usersCollection.doc(req.user.id),snap=await ref.get();if(!snap.exists)return res.status(404).json({error:'User not found'});if(!await bcrypt.compare(oldPassword,snap.data().password))return res.status(400).json({error:'Current password is incorrect'});await ref.update({password:await bcrypt.hash(newPassword,10)});res.json({message:'Password changed successfully'});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/support/tickets', authenticate, async(req,res)=>{try{const snap=await ticketsCollection.where('userId','==',req.user.id).get();const tickets=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({tickets,data:tickets});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/support/tickets', authenticate, async(req,res)=>{try{const subject=String(req.body?.subject||'').trim(),message=String(req.body?.message||'').trim();if(!subject||!message)return res.status(400).json({error:'Subject and message are required'});const ticket={userId:req.user.id,subject:subject.slice(0,160),message:message.slice(0,5000),status:'open',createdAt:new Date().toISOString()};const ref=await ticketsCollection.add(ticket);res.status(201).json({message:'Support ticket submitted',ticket:{id:ref.id,...ticket}});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/checkin/daily', authenticate, async(req,res,next)=>{req.url='/api/checkin';next();});
app.get('/api/team', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  const user = doc.data();
  res.json({ level1: user.level1||[], level2: user.level2||[], level3: user.level3||[], downlines: user.downlines||[], commissions: user.commissions||{} });
});


// Named database only: all money mutations are server-side transactions.
const rentalsCollection = db.collection('rentals');
const earningsCollection = db.collection('earnings');
const withdrawalsCollection = db.collection('withdrawals');
const SERVER_TIME = admin.firestore.FieldValue.serverTimestamp;
const amountOf = (u, key) => Number(u[key] ?? (key === 'rechargeBalance' ? u.wallets?.recharge : u.wallets?.withdrawal) ?? 0);
const setWallets = (u, recharge, earnings) => ({
  rechargeBalance: recharge, earningsBalance: earnings,
  wallets: { ...(u.wallets || {}), recharge, withdrawal: earnings }
});

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
  try {
    const amount=Number(req.body?.amount), minWithdraw=Number(process.env.MIN_WITHDRAWAL || 1000);
    if(!Number.isFinite(amount)||amount<minWithdraw) return res.status(400).json({error:`Minimum withdrawal is ${minWithdraw} UGX`});
    const userRef=usersCollection.doc(req.user.id), withdrawalRef=withdrawalsCollection.doc(), txRef=transactionsCollection.doc();
    await db.runTransaction(async tx=>{const snap=await tx.get(userRef);if(!snap.exists)throw new Error('User not found');const u=snap.data(),earnings=amountOf(u,'earningsBalance');if(!u.boundAccount)throw new Error('Bind an account before withdrawing');if(earnings<amount)throw new Error('Insufficient earnings balance');tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings-amount),pendingWithdrawal:Number(u.pendingWithdrawal||0)+amount});tx.create(withdrawalRef,{userId:req.user.id,amount,status:'pending',bindAccountId:u.boundAccount.id,phoneNumber:u.phone,transactionId:txRef.id,createdAt:SERVER_TIME()});tx.create(txRef,{userId:req.user.id,type:'withdrawal',amount,status:'pending',createdAt:SERVER_TIME(),withdrawalId:withdrawalRef.id});});
    console.log('Withdrawal queued',withdrawalRef.id);res.status(202).json({message:'Withdrawal pending review',withdrawalId:withdrawalRef.id,status:'pending'});
  }catch(e){console.error('Withdrawal request failed',e);res.status(400).json({error:e.message});}
});

// Admin-only operations require a separately configured secret; never expose it to the browser.
app.post('/api/admin/withdrawals/:id/:action', async(req,res)=>{
  if(!process.env.ADMIN_API_SECRET || req.headers['x-admin-secret']!==process.env.ADMIN_API_SECRET) return res.status(401).json({error:'Unauthorized'});
  const {id,action}=req.params;if(!['approve','reject'].includes(action))return res.status(400).json({error:'Invalid action'});
  try {const wr=withdrawalsCollection.doc(id), snap=await wr.get();if(!snap.exists)return res.status(404).json({error:'Withdrawal not found'});const w=snap.data();if(w.status!=='pending')return res.status(409).json({error:'Withdrawal is not pending'});
    if(action==='approve') {
      if(!marzConfigured()) return res.status(503).json({error:'Configure MARZPAY_API_KEY and MARZPAY_API_SECRET in Vercel first'});
      const user = await findUserById(w.userId); const phone = normalizePhone(user?.phone || w.phoneNumber);
      if(!phone) return res.status(400).json({error:'A valid Uganda mobile number is required for payout'});
      const refId = require('crypto').randomUUID();
      const pr = await fetch(`${MARZPAY_API_BASE}/send-money`, {method:'POST',headers:marzHeaders(),body:JSON.stringify({amount:Number(w.amount),phone_number:phone,reference:refId,country:'UG',description:`Rhinoverse withdrawal ${id}`,callback_url:process.env.MARZPAY_WEBHOOK_URL})});
      const pdata = await pr.json().catch(()=>({}));
      if(!pr.ok || pdata.status==='error') { console.error('MARZPay payout rejected',pr.status,pdata); return res.status(502).json({error:'MARZ Pay rejected payout. Withdrawal remains pending; check merchant permissions and wallet balance.'}); }
      await db.runTransaction(async tx=>{const latest=await tx.get(wr); if(!latest.exists||latest.data().status!=='pending') throw new Error('Withdrawal is no longer pending'); tx.update(wr,{status:'processing',provider:'marzpay',providerReference:refId,providerTransactionId:pdata.data?.transaction?.uuid||null,updatedAt:SERVER_TIME()}); const tr=db.collection('transactions').doc(latest.data().transactionId); tx.set(tr,{status:'processing',provider:'marzpay',providerReference:refId,providerTransactionId:pdata.data?.transaction?.uuid||null,updatedAt:SERVER_TIME()},{merge:true});});
      return res.status(202).json({message:'Payout submitted to MARZ Pay; awaiting final provider status',status:'processing',reference:refId});
    }
    const ur=usersCollection.doc(w.userId);await db.runTransaction(async tx=>{const us=await tx.get(ur);if(!us.exists)throw new Error('User not found');const u=us.data();tx.update(ur,{...setWallets(u,amountOf(u,'rechargeBalance'),amountOf(u,'earningsBalance')+Number(w.amount)),pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(w.amount))});tx.update(wr,{status:'rejected',updatedAt:SERVER_TIME()});});res.json({message:'Withdrawal rejected and funds returned'});
  }catch(e){console.error('Admin withdrawal action failed',e);res.status(500).json({error:e.message});}
});

// Scheduled caller must provide CRON_SECRET. Run once per day from Vercel Cron or a trusted scheduler.
app.post('/api/daily-payout', async(req,res)=>{
  if(!process.env.CRON_SECRET || req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return res.status(401).json({error:'Unauthorized'});
  try {const now=new Date(), day=now.toISOString().slice(0,10), snap=await rentalsCollection.where('status','==','active').get();let paid=0, skipped=0;
    for(const rentalDoc of snap.docs){const r=rentalDoc.data();if(!r.userId||!r.dailyIncome||!r.rentedAt){skipped++;continue;}const userRef=usersCollection.doc(r.userId), payoutRef=earningsCollection.doc(`${rentalDoc.id}_${day}`), txRef=transactionsCollection.doc(`${rentalDoc.id}_${day}`);
      await db.runTransaction(async tx=>{const [us,existing]=await Promise.all([tx.get(userRef),tx.get(payoutRef)]);if(existing.exists)return; if(!us.exists)return;const u=us.data(),end=r.expiresAt?.toDate?.()||new Date(r.expiresAt);if(now>=end){tx.update(rentalDoc.ref,{status:'expired',updatedAt:SERVER_TIME()});return;}const earnings=amountOf(u,'earningsBalance'),income=Number(r.dailyIncome);tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings+income),totalEarnings:Number(u.totalEarnings||0)+income});tx.create(payoutRef,{userId:r.userId,rentalId:rentalDoc.id,amount:income,date:day,createdAt:SERVER_TIME()});tx.create(txRef,{userId:r.userId,type:'earning',amount:income,rentalId:rentalDoc.id,status:'success',createdAt:SERVER_TIME()});tx.update(rentalDoc.ref,{lastPayoutDate:day});paid++;});
    } console.log('Daily payout finished',{day,paid,skipped});res.json({day,paid,skipped});
  }catch(e){console.error('Daily payout failed',e);res.status(500).json({error:e.message});}
});

// MARZ Pay collections use the Merchant API contract in the supplied guide.
app.post('/api/create-marz-payment', authenticate, async (req,res) => {
  try {
    if(!marzConfigured()) return res.status(503).json({error:'MARZ Pay is not configured. Add MARZPAY_API_KEY and MARZPAY_API_SECRET to backend environment variables.'});
    const amount=Number(req.body?.amount), phone=normalizePhone(req.body?.phoneNumber || req.body?.phone || (await findUserById(req.user.id))?.phone);
    if(!Number.isFinite(amount)||!Number.isInteger(amount)||amount<500||amount>10000000) return res.status(400).json({error:'Recharge must be between 500 and 10,000,000 UGX'});
    if(!phone) return res.status(400).json({error:'Enter a valid Uganda mobile number (+256...)'});
    const user=await findUserById(req.user.id); if(!user) return res.status(404).json({error:'User not found'});
    const reference=require('crypto').randomUUID();
    const payload={amount,phone_number:phone,reference,country:'UG',description:`Rhinoverse wallet recharge ${reference}`,callback_url:process.env.MARZPAY_WEBHOOK_URL};
    const response=await fetch(`${MARZPAY_API_BASE}/collect-money`,{method:'POST',headers:marzHeaders(),body:JSON.stringify(payload)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok || result.status==='error' || !result.data?.transaction) { console.error('[MARZPAY] collection rejected',response.status,result); return res.status(502).json({error:result.message||'MARZ Pay could not initiate the mobile-money prompt'}); }
    const providerTx=result.data.transaction;
    await transactionsCollection.doc(reference).set({userId:req.user.id,type:'recharge',amount,currency:'UGX',status:'pending',provider:'marzpay',reference,providerTransactionId:providerTx.uuid||null,phoneNumber:phone,createdAt:SERVER_TIME()});
    return res.status(202).json({message:'Approve the MTN or Airtel payment prompt on your phone. Your wallet updates after confirmation.',status:providerTx.status||'processing',reference,transactionId:providerTx.uuid||null});
  } catch(e) { console.error('[MARZPAY] collection error',e); return res.status(502).json({error:'Could not contact MARZ Pay. No wallet credit was applied.'}); }
});

// Provider callbacks may be direct or wrapped in {data: ...}. Verify final status with the
// provider API before any wallet credit; reference-only/browser redirects are never trusted.
app.post('/api/marz-webhook', async(req,res)=>{
  try {
    const body=req.body||{}, event=body.event_type, payload=body.data||body;
    const transaction=payload.transaction||{}, collection=payload.collection||{};
    const reference=transaction.provider_reference || transaction.reference || collection.reference || payload.reference;
    if(!reference) return res.status(400).json({error:'Missing transaction reference'});
    const localRef=transactionsCollection.doc(String(reference)); const localSnap=await localRef.get();
    if(!localSnap.exists) return res.status(200).json({received:true,ignored:true});
    const local=localSnap.data();
    if(local.type==='recharge') {
      if(!marzConfigured()) return res.status(503).json({error:'Provider verification is not configured'});
      const uuid=local.providerTransactionId || transaction.uuid;
      if(!uuid) return res.status(202).json({received:true,pending:true});
      const verify=await fetch(`${MARZPAY_API_BASE}/collect-money/${encodeURIComponent(uuid)}`,{headers:marzHeaders()});
      const v=await verify.json().catch(()=>({}));
      if(!verify.ok) return res.status(502).json({error:'Could not verify collection status'});
      const vt=v.data?.transaction||v.transaction||v.data||v;
      const status=String(vt.status||'').toLowerCase();
      if(['completed','successful','success'].includes(status)) {
        const providerAmount=Number(vt.amount?.raw ?? v.data?.collection?.amount?.raw ?? collection.amount?.raw);
        const currency=vt.amount?.currency || v.data?.collection?.amount?.currency || 'UGX';
        if(!Number.isFinite(providerAmount)||providerAmount!==Number(local.amount)||currency!=='UGX') return res.status(409).json({error:'Provider amount or currency does not match the pending recharge'});
        await db.runTransaction(async tx=>{const [tr,ur]=await Promise.all([tx.get(localRef),tx.get(usersCollection.doc(local.userId))]);if(!tr.exists||!ur.exists)throw new Error('Transaction or user not found');if(tr.data().status==='success')return; if(tr.data().status!=='pending')throw new Error('Recharge is not pending');const u=ur.data(),r=amountOf(u,'rechargeBalance'),e=amountOf(u,'earningsBalance');tx.update(usersCollection.doc(local.userId),setWallets(u,r+providerAmount,e));tx.update(localRef,{status:'success',confirmedAt:SERVER_TIME(),providerStatus:status});});
      } else if(['failed','cancelled'].includes(status)) await localRef.set({status,providerStatus:status,updatedAt:SERVER_TIME()},{merge:true});
      return res.status(200).json({received:true,status});
    }
    if(local.type==='withdrawal' && ['disbursement.completed','disbursement.failed','disbursement.cancelled'].includes(event)) {
      const withdrawals= db.collection('withdrawals'); const q=await withdrawals.where('transactionId','==',localRef.id).limit(1).get();
      if(!q.empty){const wr=q.docs[0].ref;await db.runTransaction(async tx=>{const [ts,ws]=await Promise.all([tx.get(localRef),tx.get(wr)]);if(!ws.exists||['success','failed','rejected'].includes(ts.data()?.status))return;const success=event==='disbursement.completed';tx.update(localRef,{status:success?'success':'failed',updatedAt:SERVER_TIME()});tx.update(wr,{status:success?'completed':'failed',updatedAt:SERVER_TIME()});if(!success){const ur=usersCollection.doc(local.userId),us=await tx.get(ur);if(us.exists){const u=us.data();tx.update(ur,{...setWallets(u,amountOf(u,'rechargeBalance'),amountOf(u,'earningsBalance')+Number(local.amount)),pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(local.amount))});}}});}
    }
    return res.status(200).json({received:true});
  } catch(e){console.error('[MARZPAY] webhook processing error',e);return res.status(500).json({error:'Webhook processing failed'});}
});

module.exports = app;
