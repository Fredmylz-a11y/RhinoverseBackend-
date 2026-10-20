const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Admin-Secret','x-admin-secret'] }));
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
  console.error('Named Firestore database rhinoverse unavailable:', e.message);
  throw e;
}
const usersCollection = db.collection('users');
const transactionsCollection = db.collection('transactions');
const rentalsCollection = db.collection('rentals');
const earningsCollection = db.collection('earnings');
const withdrawalsCollection = db.collection('withdrawals');
const ticketsCollection = db.collection('supportTickets');
const bonusCodesCollection = db.collection('bonusCodes');

const SERVER_TIME = admin.firestore.FieldValue.serverTimestamp;
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
const amountOf = (u, key) => Number(u[key] ?? (key === 'rechargeBalance' ? u.wallets?.recharge : u.wallets?.withdrawal) ?? 0);
const setWallets = (u, recharge, earnings) => ({
  rechargeBalance: recharge, earningsBalance: earnings,
  wallets: { ...(u.wallets || {}), recharge, withdrawal: earnings }
});

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

app.get('/api/health', async (req, res) => {
  try { await usersCollection.limit(1).get(); res.json({ status: 'healthy', db: 'rhinoverse', currency:'UGX' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/', (req, res) => res.json({ status: 'Running', db: 'rhinoverse', currency:'UGX', full: true }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));

app.get('/api/products/my', authenticate, async (req, res) => {
  try { const user = await findUserById(req.user.id); if (!user) return res.status(404).json({ error: 'User not found' }); res.json({ products: user.products || [], data: user.products || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/wallet/balance', authenticate, async (req, res) => {
  try { const user = await findUserById(req.user.id); if (!user) return res.status(404).json({ error: 'User not found' }); res.json({ recharge: user.wallets?.recharge || 0, withdrawal: user.wallets?.withdrawal || 0, rechargeWallet: user.wallets?.recharge || 0, withdrawalWallet: user.wallets?.withdrawal || 0, balance: user.wallets?.recharge || 0, data: user.wallets, wallets: user.wallets, currency:'UGX' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/wallet', authenticate, async (req, res) => {
  try { const user = await findUserById(req.user.id); res.json({...user.wallets, currency:'UGX'}); } catch (e) { res.status(500).json({ error: e.message }); }
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
      id: userId, username, phone, password: hashed, referrer: referrer || null, upline: referrer || null,
      registered: SERVER_TIME(), createdAt: SERVER_TIME(), rechargeBalance: 0, earningsBalance: WELCOME_BONUS,
      wallets: { recharge: 0, withdrawal: WELCOME_BONUS }, products: [], commissions: {1:0,2:0,3:0}, totalEarnings: 0,
      downlines: [], level1: [], level2: [], level3: [], lastCheckin: null, checkinStreak: 0
    };
    if (referrer) {
      const r = await findUser(referrer);
      if (r) {
        const rId = r._docId || r.id; const rData = await findUserById(rId) || r;
        await usersCollection.doc(rId).update({ level1: [...(rData.level1||[]), username], downlines: [...(rData.downlines||[]), username] });
        if (rData.upline) {
          const u2 = await findUser(rData.upline);
          if (u2) { const u2Id = u2._docId || u2.id; await usersCollection.doc(u2Id).update({ level2: [...(u2.level2||[]), username] });
            if (u2.upline) { const u3 = await findUser(u2.upline); if (u3) { const u3Id = u3._docId || u3.id; await usersCollection.doc(u3Id).update({ level3: [...(u3.level3||[]), username] }); } }
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
    const { phone, password } = req.body; const user = await findUser(phone);
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

// RENT - deducts from recharge wallet UGX
app.post('/api/rent', authenticate, async (req,res) => {
  try {
    const product = PRODUCTS.find(p => String(p.id) === String(req.body?.productId));
    if (!product) return res.status(400).json({error:'Invalid product'});
    const userRef = usersCollection.doc(req.user.id), rentalRef = rentalsCollection.doc(), txRef = transactionsCollection.doc();
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef); if(!snap.exists) throw new Error('User not found');
      const u=snap.data(), recharge=amountOf(u,'rechargeBalance'), earnings=amountOf(u,'earningsBalance');
      if(recharge < product.price) throw new Error(`Insufficient recharge balance. You have UGX ${recharge}, need UGX ${product.price}. Please recharge.`);
      const rentedAt = new Date(), expiresAt = new Date(rentedAt.getTime() + product.cycleDays*86400000);
      const rental = {userId:req.user.id,productId:product.id,name:product.name,price:product.price,dailyIncome:product.dailyIncome,duration:product.cycleDays,status:'active',rentedAt:admin.firestore.Timestamp.fromDate(rentedAt),expiresAt:admin.firestore.Timestamp.fromDate(expiresAt),lastPayoutDate:null,createdAt:SERVER_TIME(), currency:'UGX'};
      const userProducts=[...(u.products||[]),{productId:product.id,name:product.name,price:product.price,dailyIncome:product.dailyIncome,duration:product.cycleDays,active:true,rentalId:rentalRef.id,rentedAt:admin.firestore.Timestamp.fromDate(rentedAt),expiresAt:admin.firestore.Timestamp.fromDate(expiresAt)}];
      tx.update(userRef,{...setWallets(u,recharge-product.price,earnings),products:userProducts});
      tx.set(rentalRef,rental); tx.set(txRef,{userId:req.user.id,type:'rent',amount:-product.price,productId:product.id,status:'success',createdAt:SERVER_TIME(), currency:'UGX'});
      return {rentalId:rentalRef.id,balance:recharge-product.price};
    });
    res.status(201).json({message:'Rented successfully, daily income will start in UGX', currency:'UGX', ...result});
  } catch(e) { res.status(400).json({error:e.message}); }
});

app.post('/api/buy', authenticate, async (req, res) => {
  try {
    const { productId } = req.body; const product = PRODUCTS.find(p => p.id === Number(productId));
    if (!product) return res.status(400).json({ error: 'Invalid product' });
    const userDoc = await usersCollection.doc(req.user.id).get(); const user = userDoc.data();
    if (amountOf(user,'rechargeBalance') < product.price) return res.status(400).json({ error: 'Insufficient recharge balance' });
    const newProduct = {...product, purchaseDate: new Date().toISOString(), expiryDate: new Date(Date.now()+product.cycleDays*86400000).toISOString(), earned:0, active:true };
    await db.runTransaction(async tx=>{
      const snap = await tx.get(usersCollection.doc(req.user.id));
      const u = snap.data();
      tx.update(usersCollection.doc(req.user.id), {...setWallets(u, amountOf(u,'rechargeBalance')-product.price, amountOf(u,'earningsBalance')), products:[...(u.products||[]), newProduct]});
    });
    res.json({ message: 'Product purchased', product: newProduct, currency:'UGX' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/checkin', authenticate, async (req, res) => {
  try {
    const userDoc = await usersCollection.doc(req.user.id).get(); const user = userDoc.data();
    const now = new Date(); const last = user.lastCheckin? new Date(user.lastCheckin): null;
    if (last && now.toDateString() === last.toDateString()) return res.status(400).json({ error: 'Already checked in today' });
    let dailyTotal = 0;
    const updatedProducts = (user.products||[]).map(p => {
      if (p.active) { const expiry = new Date(p.expiryDate); if (now < expiry) { dailyTotal += p.dailyIncome; return {...p, earned:(p.earned||0)+p.dailyIncome}; } else return {...p, active:false}; }
      return p;
    });
    const updatedWallets = {...user.wallets, withdrawal:(user.wallets.withdrawal||0)+dailyTotal};
    await usersCollection.doc(req.user.id).update({ products: updatedProducts, wallets: updatedWallets, lastCheckin: now.toISOString(), totalEarnings:(user.totalEarnings||0)+dailyTotal });
    res.json({ message: 'Check-in successful', earned: dailyTotal, wallets: updatedWallets, currency:'UGX' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// MARZPAY RECHARGE - FIXED NO 501, UGX, TEST MODE
app.post('/api/create-marz-payment', authenticate, async(req,res)=>{
  const amount=Number(req.body?.amount);
  if(!Number.isFinite(amount)||amount<100) return res.status(400).json({error:'Minimum recharge is 100 UGX'});
  try {
    const reference = generateId();
    const checkoutEndpoint = process.env.MARZPAY_CHECKOUT_ENDPOINT;
    
    if(!checkoutEndpoint){
      // TEST MODE - works without keys, auto-credits in UGX
      const txRef = await transactionsCollection.add({userId:req.user.id,type:'recharge',amount,status:'pending',provider:'marzpay',reference,currency:'UGX',createdAt:SERVER_TIME()});
      setTimeout(async()=>{
        try{
          const userRef=usersCollection.doc(req.user.id);
          await db.runTransaction(async t=>{
            const snap=await t.get(userRef); if(!snap.exists) return;
            const u=snap.data();
            t.update(userRef, setWallets(u, amountOf(u,'rechargeBalance')+amount, amountOf(u,'earningsBalance')));
            t.update(txRef,{status:'success', completedAt:SERVER_TIME()});
          });
        }catch(e){console.error(e);}
      },2000);
      return res.json({payment_url:`/wallet?test=1`, paymentUrl:`/wallet?test=1`, reference, testMode:true, currency:'UGX', message:`Test mode: UGX ${amount} will auto-credit in 2 sec`});
    }

    // LIVE MODE with real MarasoftPay
    const response=await fetch(checkoutEndpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.MARZPAY_API_KEY||''}`},body:JSON.stringify({amount,currency:'UGX',reference,custom_userId:req.user.id,webhook_url:process.env.MARZPAY_WEBHOOK_URL, amountInKobo: amount*100})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) return res.status(502).json({error:'MARZ Pay checkout failed', details:data});
    const url=data.payment_url||data.paymentUrl||data.checkout_url;
    if(!url) return res.status(502).json({error:'Provider response did not contain a payment URL', details:data});
    await transactionsCollection.add({userId:req.user.id,type:'recharge',amount,status:'pending',provider:'marzpay',reference,currency:'UGX',createdAt:SERVER_TIME()});
    res.json({payment_url:url, paymentUrl:url, reference, currency:'UGX'});
  }catch(e){console.error('MARZ Pay checkout failed',e); res.status(502).json({error:'Could not create payment: '+e.message});}
});

app.post('/api/marzpay/recharge', authenticate, async(req,res)=>{
  req.url='/api/create-marz-payment';
  return app(req,res);
});

// WEBHOOK - FIXED NO 501
app.post('/api/marz-webhook', async(req,res)=>{
  try{
    console.log('Webhook:', JSON.stringify(req.body).slice(0,800));
    const body = req.body || {};
    const reference = body.merchant_ref || body.reference || body.merchant_reference || body.tx_ref || body.data?.merchant_ref || body.data?.reference;
    const statusRaw = String(body.status || body.transaction_status || body.data?.status || '').toLowerCase();
    const amountRaw = Number(body.amount || body.data?.amount || 0);
    const amountUGX = amountRaw >= 1000 ? amountRaw/100 : amountRaw;
    
    if(!reference) return res.json({received:true, message:'No reference'});
    if(!['successful','success','completed','paid','approved'].includes(statusRaw)){
      return res.json({received:true, status:statusRaw});
    }

    const snap = await transactionsCollection.where('reference','==',reference).limit(1).get();
    if(snap.empty) return res.status(404).json({error:'Transaction not found'});
    const txDoc = snap.docs[0];
    if(txDoc.data().status === 'success') return res.json({success:true, message:'Already completed'});

    if(process.env.MARZPAY_SECRET){
      const sig = req.headers['x-marasoftpay-signature'] || req.headers['secret-hash'] || '';
      if(sig){
        console.log('Signature present:', sig.slice(0,15));
      }
    }

    const userId = txDoc.data().userId;
    const txAmount = Number(txDoc.data().amount);
    const finalAmount = amountUGX || txAmount;

    const userRef = usersCollection.doc(userId);
    await db.runTransaction(async t=>{
      const us = await t.get(userRef); if(!us.exists) throw new Error('User not found');
      const u=us.data();
      t.update(userRef, setWallets(u, amountOf(u,'rechargeBalance')+finalAmount, amountOf(u,'earningsBalance')));
      t.update(txDoc.ref, {status:'success', completedAt: SERVER_TIME(), webhookData: body, currency:'UGX'});
    });

    console.log(`UGX ${finalAmount} credited to ${userId}`);
    res.json({success:true, credited: finalAmount, reference, currency:'UGX'});
  }catch(e){ console.error('Webhook error', e); res.status(500).json({error:e.message}); }
});

app.post('/api/marzpay/callback', async(req,res)=>{
  req.url='/api/marz-webhook';
  req.method='POST';
  return app._router.handle(req,res);
});

// WITHDRAWALS
app.post('/api/withdrawals', authenticate, async (req,res) => {
  try {
    const amount=Number(req.body?.amount), minWithdraw=Number(process.env.MIN_WITHDRAWAL || 1000);
    if(!Number.isFinite(amount)||amount<minWithdraw) return res.status(400).json({error:`Minimum withdrawal is ${minWithdraw} UGX`});
    const userRef=usersCollection.doc(req.user.id), withdrawalRef=withdrawalsCollection.doc(), txRef=transactionsCollection.doc();
    await db.runTransaction(async tx=>{const snap=await tx.get(userRef);if(!snap.exists)throw new Error('User not found');const u=snap.data(),earnings=amountOf(u,'earningsBalance');if(!u.boundAccount)throw new Error('Bind an account before withdrawing');if(earnings<amount)throw new Error('Insufficient earnings balance');tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings-amount),pendingWithdrawal:Number(u.pendingWithdrawal||0)+amount});tx.create(withdrawalRef,{userId:req.user.id,amount,status:'pending',bindAccountId:u.boundAccount.id,createdAt:SERVER_TIME(), currency:'UGX'});tx.create(txRef,{userId:req.user.id,type:'withdrawal',amount,status:'pending',createdAt:SERVER_TIME(),withdrawalId:withdrawalRef.id, currency:'UGX'});});
    res.status(202).json({message:'Withdrawal pending review', withdrawalId:withdrawalRef.id, status:'pending', currency:'UGX'});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/marzpay/withdraw', authenticate, async(req,res)=>{
  req.url='/api/withdrawals'; 
  return app._router.handle(req,res);
});

// ADMIN - FIXED NO 501
app.post('/api/admin/withdrawals/:id/:action', async(req,res)=>{
  if(!process.env.ADMIN_API_SECRET || req.headers['x-admin-secret']!==process.env.ADMIN_API_SECRET) return res.status(401).json({error:'Unauthorized'});
  const {id,action}=req.params;if(!['approve','reject'].includes(action))return res.status(400).json({error:'Invalid action'});
  try {
    const wr=withdrawalsCollection.doc(id), snap=await wr.get();if(!snap.exists)return res.status(404).json({error:'Withdrawal not found'});const w=snap.data();if(w.status!=='pending')return res.status(409).json({error:'Withdrawal is not pending'});
    if(action==='approve') { 
      const payoutEndpoint = process.env.MARZPAY_PAYOUT_ENDPOINT;
      if(payoutEndpoint){
        try{
          const payoutRes = await fetch(payoutEndpoint, {method:'POST', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.MARZPAY_API_KEY||''}`}, body:JSON.stringify({amount:w.amount, currency:'UGX', reference:id, userId:w.userId})});
          const payoutData = await payoutRes.json().catch(()=>({}));
          if(!payoutRes.ok) return res.status(502).json({error:'Payout provider failed', details:payoutData});
          await wr.update({status:'approved', providerResponse:payoutData, updatedAt:SERVER_TIME(), currency:'UGX'});
          return res.json({message:'Withdrawal approved - UGX '+w.amount+' sent to provider', currency:'UGX'});
        }catch(e){ return res.status(502).json({error:'Payout request failed: '+e.message}); }
      } else {
        await wr.update({status:'approved', updatedAt:SERVER_TIME(), manual:true, currency:'UGX'});
        return res.json({message:'Withdrawal approved manually in UGX - pay user manually. Set MARZPAY_PAYOUT_ENDPOINT to automate', currency:'UGX'});
      }
    }
    const ur=usersCollection.doc(w.userId);await db.runTransaction(async tx=>{const us=await tx.get(ur);if(!us.exists)throw new Error('User not found');const u=us.data();tx.update(ur,{...setWallets(u,amountOf(u,'rechargeBalance'),amountOf(u,'earningsBalance')+Number(w.amount)),pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(w.amount))});tx.update(wr,{status:'rejected',updatedAt:SERVER_TIME()});});res.json({message:'Withdrawal rejected and funds returned', currency:'UGX'});
  }catch(e){console.error('Admin withdrawal action failed',e);res.status(500).json({error:e.message});}
});

app.post('/api/daily-payout', async(req,res)=>{
  if(process.env.CRON_SECRET && req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return res.status(401).json({error:'Unauthorized'});
  try {const now=new Date(), day=now.toISOString().slice(0,10), snap=await rentalsCollection.where('status','==','active').get();let paid=0, skipped=0;
    for(const rentalDoc of snap.docs){const r=rentalDoc.data();if(!r.userId||!r.dailyIncome||!r.rentedAt){skipped++;continue;}const userRef=usersCollection.doc(r.userId), payoutRef=earningsCollection.doc(`${rentalDoc.id}_${day}`), txRef=transactionsCollection.doc(`${rentalDoc.id}_${day}`);
      await db.runTransaction(async tx=>{const [us,existing]=await Promise.all([tx.get(userRef),tx.get(payoutRef)]);if(existing.exists)return; if(!us.exists)return;const u=us.data(),end=r.expiresAt?.toDate?.()||new Date(r.expiresAt);if(now>=end){tx.update(rentalDoc.ref,{status:'expired',updatedAt:SERVER_TIME()});return;}const earnings=amountOf(u,'earningsBalance'),income=Number(r.dailyIncome);tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings+income),totalEarnings:Number(u.totalEarnings||0)+income});tx.create(payoutRef,{userId:r.userId,rentalId:rentalDoc.id,amount:income,date:day,createdAt:SERVER_TIME(), currency:'UGX'});tx.create(txRef,{userId:r.userId,type:'earning',amount:income,rentalId:rentalDoc.id,status:'success',createdAt:SERVER_TIME(), currency:'UGX'});tx.update(rentalDoc.ref,{lastPayoutDate:day});paid++;});
    } console.log('Daily payout finished',{day,paid,skipped});res.json({day,paid,skipped, currency:'UGX'});
  }catch(e){console.error('Daily payout failed',e);res.status(500).json({error:e.message});}
});

app.get('/api/investments/my-products', authenticate, async (req,res) => {
  try { const user=await findUserById(req.user.id); if(!user) return res.status(404).json({error:'User not found'}); res.json({products:user.products||[], data:user.products||[]}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/user/bind-account', authenticate, async (req,res) => {
  try { const {bankName,accountNumber,holderName}=req.body||{}; if(![bankName,accountNumber,holderName].every(v=>typeof v==='string'&&v.trim())) return res.status(400).json({error:'Bank name, account number and holder name are required'}); if(accountNumber.trim().length<4||accountNumber.trim().length>40) return res.status(400).json({error:'Invalid account number'}); const account={id:generateId(),bankName:bankName.trim(),accountNumber:accountNumber.trim(),holderName:holderName.trim(),createdAt:new Date().toISOString()}; await usersCollection.doc(req.user.id).update({boundAccount:account}); res.json({message:'Account bound successfully',account:{...account,accountNumber:'••••'+accountNumber.trim().slice(-4)}}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/transactions/history', authenticate, async(req,res)=>{try{const snap=await transactionsCollection.where('userId','==',req.user.id).get();const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({transactions:rows,data:rows, currency:'UGX'});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/auth/change-password', authenticate, async(req,res)=>{try{const {oldPassword,newPassword}=req.body||{};if(!oldPassword||typeof newPassword!=='string'||newPassword.length<6) return res.status(400).json({error:'Enter your current password and a new password of at least 6 characters'});const ref=usersCollection.doc(req.user.id),snap=await ref.get();if(!snap.exists)return res.status(404).json({error:'User not found'});if(!await bcrypt.compare(oldPassword,snap.data().password))return res.status(400).json({error:'Current password is incorrect'});await ref.update({password:await bcrypt.hash(newPassword,10)});res.json({message:'Password changed successfully'});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/support/tickets', authenticate, async(req,res)=>{try{const snap=await ticketsCollection.where('userId','==',req.user.id).get();const tickets=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({tickets,data:tickets});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/support/tickets', authenticate, async(req,res)=>{try{const subject=String(req.body?.subject||'').trim(),message=String(req.body?.message||'').trim();if(!subject||!message)return res.status(400).json({error:'Subject and message are required'});const ticket={userId:req.user.id,subject:subject.slice(0,160),message:message.slice(0,5000),status:'open',createdAt:new Date().toISOString()};const ref=await ticketsCollection.add(ticket);res.status(201).json({message:'Support ticket submitted',ticket:{id:ref.id,...ticket}});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/team', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get(); const user = doc.data(); res.json({ level1: user.level1||[], level2: user.level2||[], level3: user.level3||[], downlines: user.downlines||[], commissions: user.commissions||{} });
});
app.post('/api/bonus/redeem', authenticate, async (req,res) => {
  try { const code=String(req.body?.code||'').trim().toUpperCase(); if(!code) return res.status(400).json({error:'Enter a bonus code'}); const userRef=usersCollection.doc(req.user.id); const codeRef=bonusCodesCollection.doc(code); const result=await db.runTransaction(async tx=>{const [u,c]=await Promise.all([tx.get(userRef),tx.get(codeRef)]); if(!u.exists) throw new Error('User not found'); if(!c.exists||!c.data().active) throw new Error('Invalid or expired bonus code'); const ud=u.data(), cd=c.data(); if((ud.redeemedBonusCodes||[]).includes(code)) throw new Error('Bonus code already redeemed'); const amount=Number(cd.amount); if(!Number.isFinite(amount)||amount<=0) throw new Error('Bonus code is not configured correctly'); const wallets={...(ud.wallets||{}),withdrawal:Number(ud.wallets?.withdrawal||0)+amount}; tx.update(userRef,{wallets,redeemedBonusCodes:[...(ud.redeemedBonusCodes||[]),code]}); tx.create(transactionsCollection.doc(),{userId:req.user.id,type:'bonus',amount,status:'success',createdAt:new Date().toISOString(),reference:code, currency:'UGX'}); return amount;}); res.json({message:'Bonus code redeemed successfully',credited:result, currency:'UGX'}); }
  catch(e){res.status(400).json({error:e.message});}
});

module.exports = app;
