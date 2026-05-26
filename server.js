// ============================================================
// Birthday Gift Payment Server — PayHero + Firebase Admin
// Deploy on Render. Set these environment variables:
//   PAYHERO_AUTH_TOKEN       → Basic auth token from PayHero dashboard
//   PAYHERO_CHANNEL_ID       → Your PayHero payment channel ID
//   PAYHERO_PROVIDER         → e.g. m-pesa
//   RENDER_URL               → Your Render URL (no trailing slash)
//   FIREBASE_SERVICE_ACCOUNT → JSON string of Firebase service account key
// ============================================================

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const admin   = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Firebase Admin SDK ────────────────────────────────────────
let db = null;
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('[Firebase] Admin SDK initialized');
} catch (e) {
  console.warn('[Firebase] NOT initialized:', e.message);
  console.warn('[Firebase] Set FIREBASE_SERVICE_ACCOUNT env var on Render');
}

// ── PayHero Config ────────────────────────────────────────────
const PAYHERO_AUTH_TOKEN = process.env.PAYHERO_AUTH_TOKEN;
const PAYHERO_CHANNEL    = process.env.PAYHERO_CHANNEL_ID;
const PAYHERO_BASE_URL   = 'https://backend.payhero.co.ke/api/v2';

function getAuthToken() {
  if (!PAYHERO_AUTH_TOKEN) throw new Error('PAYHERO_AUTH_TOKEN not set');
  return PAYHERO_AUTH_TOKEN.startsWith('Basic ') ? PAYHERO_AUTH_TOKEN : 'Basic ' + PAYHERO_AUTH_TOKEN;
}

console.log('[PayHero] Channel ID:', PAYHERO_CHANNEL);
console.log('[PayHero] Auth Token set:', PAYHERO_AUTH_TOKEN ? 'YES' : 'NO');

// ── In-memory payment store ───────────────────────────────────
// WARNING: Resets on every Render restart.
// Firestore (pendingPayments) is the persistent source of truth.
const paymentStore = {};

// Payment timeout: PENDING > 2 minutes → auto FAILED
const PAYMENT_TIMEOUT_MS = 120000;

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'birthday-payment-api' }));

// ─────────────────────────────────────────────────────────────
// POST /pay  — Initiate STK Push
// Body: { name, phone, amount, giftId, giftName }
// ─────────────────────────────────────────────────────────────
app.post('/pay', async (req, res) => {
  const { name, phone, amount, giftId, giftName } = req.body;

  if (!name || !phone || !amount || !giftId) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  // Normalise phone → 2547XXXXXXXX
  let tel = String(phone).replace(/\D/g, '');
  if (tel.startsWith('0'))  tel = '254' + tel.slice(1);
  if (tel.startsWith('+'))  tel = tel.slice(1);
  if (!/^2547\d{8}$/.test(tel)) {
    return res.status(400).json({ success: false, error: 'Enter a valid Safaricom number e.g. 0712345678' });
  }

  const reference   = 'BDAY-' + Date.now();
  const callbackUrl = `${process.env.RENDER_URL}/callback`;
  const channelId   = parseInt(PAYHERO_CHANNEL);
  const provider    = process.env.PAYHERO_PROVIDER || 'm-pesa';

  console.log('[Pay] KES', amount, 'from', tel, '| ref:', reference, '| gift:', giftId);

  try {
    const { data } = await axios.post(
      `${PAYHERO_BASE_URL}/payments`,
      {
        amount:             parseInt(amount),
        phone_number:       tel,
        channel_id:         channelId,
        provider:           provider,
        external_reference: reference,
        customer_name:      name,
        callback_url:       callbackUrl,
      },
      { headers: { 'Content-Type': 'application/json', Authorization: getAuthToken() } }
    );

    console.log('[Pay] PayHero response:', JSON.stringify(data));

    if (data.success === false) {
      return res.status(502).json({ success: false, error: data.error_message || data.message || 'STK push failed' });
    }

    const payheroRef = data.reference || data.CheckoutRequestID || data.id || data.transaction_id || null;

    // Store in memory
    const entry = {
      status:    'PENDING',
      amount:    parseInt(amount),
      name,
      giftId,
      giftName:  giftName || giftId,
      phone:     tel,
      payheroRef,
      mpesaRef:  null,
      createdAt: Date.now(),
    };
    paymentStore[reference] = Object.assign({}, entry);
    if (payheroRef) paymentStore[payheroRef] = Object.assign({}, entry, { extRef: reference });

    // Write pending record to Firestore — survives Render restarts
    if (db) {
      db.collection('pendingPayments').doc(reference).set({
        name, giftId, giftName: giftName || giftId,
        amount:    parseInt(amount),
        phone:     tel,
        status:    'PENDING',
        reference: payheroRef || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.warn('[Pay] pendingPayments write failed:', e.message));
    }

    return res.json({
      success:   true,
      reference,
      payheroRef,
      message:   'STK push sent! Check your phone.',
    });

  } catch (err) {
    const errData = err.response ? err.response.data : err.message;
    console.error('[Pay] Error:', errData);
    return res.status(502).json({ success: false, error: (errData && (errData.error_message || errData.message)) || 'Payment initiation failed. Try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /status/:reference  — Poll transaction status
//
// Resolution order:
//   1. In-memory store          (fastest — works if server didn't restart)
//   2. Firestore contributions  (did callback already record the contribution?)
//   3. Firestore pendingPayments timeout detection (survives restarts)
//   4. PayHero transaction-status API (live fallback)
//   5. PENDING (default)
// ─────────────────────────────────────────────────────────────
app.get('/status/:reference', async (req, res) => {
  const { reference } = req.params;

  // ── 1. Direct in-memory lookup ──────────────────────────────
  let payment = paymentStore[reference];

  // Cross-ref: if frontend queries by payheroRef, find the extRef entry
  if (!payment || payment.status === 'PENDING') {
    for (const key of Object.keys(paymentStore)) {
      const e = paymentStore[key];
      if (e.payheroRef === reference && (e.status === 'SUCCESS' || e.status === 'FAILED')) {
        payment = e;
        console.log('[Status] cross-found in store:', key, '->', e.status);
        break;
      }
    }
  }

  if (payment && payment.status === 'SUCCESS') {
    return res.json({ success: true, status: 'SUCCESS', amount: payment.amount, mpesaRef: payment.mpesaRef || null, name: payment.name, giftId: payment.giftId, giftName: payment.giftName });
  }
  if (payment && payment.status === 'FAILED') {
    return res.json({ success: true, status: 'FAILED', amount: payment.amount || 0 });
  }

  // ── 2 + 3. Firestore checks ─────────────────────────────────
  if (db) {
    try {
      let createdAt = payment && payment.createdAt;
      let name      = payment && payment.name;
      let giftId    = payment && payment.giftId;
      let giftName  = payment && payment.giftName;
      let amount    = payment && payment.amount;

      // Restore from pendingPayments if server restarted
      if (!payment) {
        const pendingDoc = await db.collection('pendingPayments').doc(reference).get();
        if (pendingDoc.exists) {
          const pd  = pendingDoc.data();
          createdAt = pd.createdAt && pd.createdAt.toMillis ? pd.createdAt.toMillis() : Date.now();
          name      = pd.name;
          giftId    = pd.giftId;
          giftName  = pd.giftName;
          amount    = pd.amount || 0;
          paymentStore[reference] = {
            status: 'PENDING', amount, name, giftId, giftName,
            payheroRef: pd.reference || null, createdAt,
          };
          payment = paymentStore[reference];
          console.log('[Status] Restored from Firestore pendingPayments:', reference);
        }
      }

      // Check if pendingPayments doc was deleted — means callback already ran & recorded contribution
      const pendingCheck = await db.collection('pendingPayments').doc(reference).get();
      if (!pendingCheck.exists && (name || giftId)) {
        // Contribution was already recorded — find it in contributions collection
        const contribsSnap = await db.collection('contributions')
          .where('extRef', '==', reference)
          .limit(1)
          .get();

        if (!contribsSnap.empty) {
          const contrib = contribsSnap.docs[0].data();
          console.log('[Status] pendingPayments deleted → SUCCESS for', reference);
          paymentStore[reference] = { status: 'SUCCESS', amount: contrib.amount, name: contrib.name, giftId: contrib.giftId, giftName: contrib.giftName, mpesaRef: contrib.mpesaRef || null, createdAt };
          return res.json({ success: true, status: 'SUCCESS', amount: contrib.amount, mpesaRef: contrib.mpesaRef || null, name: contrib.name, giftId: contrib.giftId, giftName: contrib.giftName });
        }

        // pendingPayments deleted but no contributions entry yet — still treat as pending briefly
        // unless we're past timeout
      }

      // Timeout: PENDING > 2 minutes → FAILED
      if (createdAt && (Date.now() - createdAt) > PAYMENT_TIMEOUT_MS) {
        console.log('[Status] TIMEOUT for', reference, '— marking FAILED');
        paymentStore[reference] = Object.assign({}, payment || {}, { status: 'FAILED' });
        db.collection('pendingPayments').doc(reference).delete().catch(() => {});
        return res.json({ success: true, status: 'FAILED', amount: amount || 0 });
      }

    } catch (fsErr) {
      console.warn('[Status] Firestore check error:', fsErr.message);
    }
  }

  // ── 4. PayHero transaction-status API (best-effort) ─────────
  if (PAYHERO_AUTH_TOKEN) {
    try {
      const queryRef = (payment && payment.payheroRef) || reference;

      const phRes = await axios.get(
        `${PAYHERO_BASE_URL}/transaction-status`,
        {
          params:  { reference: queryRef },
          headers: { Authorization: getAuthToken() },
          timeout: 8000,
        }
      );

      const phData       = phRes.data || {};
      console.log('[Status] PayHero transaction-status raw:', JSON.stringify(phData));

      // ResultCode: 0 = success. Use !== undefined because 0 is falsy.
      const resultCode   = phData.ResultCode !== undefined ? Number(phData.ResultCode) : null;
      const phStatusStr  = String(phData.Status || phData.status || phData.transaction_status || '').toLowerCase();
      const mpesaReceipt = phData.MpesaReceiptNumber || phData.MPESA_Reference || phData.mpesa_reference || '';
      const phAmount     = Number(phData.Amount || phData.amount || (payment && payment.amount) || 0);

      console.log('[Status] resultCode:', resultCode, '| status:', phStatusStr, '| mpesa:', mpesaReceipt);

      let resolvedStatus = 'PENDING';

      if (resultCode === 0 || mpesaReceipt || phStatusStr === 'success' || phStatusStr === 'complete' || phStatusStr === 'completed') {
        resolvedStatus = 'SUCCESS';
      }
      // Non-zero ResultCode = definite failure: 1032 cancelled, 1037 timeout, 2001 wrong PIN
      if ((resultCode !== null && resultCode !== 0) || ['failed','fail','cancelled','canceled','expired','timeout'].includes(phStatusStr)) {
        resolvedStatus = 'FAILED';
      }

      if (resolvedStatus !== 'PENDING') {
        const stored = paymentStore[reference] || {};
        paymentStore[reference] = {
          status:   resolvedStatus,
          amount:   phAmount,
          name:     stored.name || null,
          giftId:   stored.giftId || null,
          giftName: stored.giftName || null,
          mpesaRef: mpesaReceipt || null,
          createdAt: stored.createdAt || Date.now(),
        };

        if (resolvedStatus === 'SUCCESS') {
          // Write contribution to Firestore
          const s = paymentStore[reference];
          if (db && s.name && s.giftId && phAmount > 0) {
            writeContributionToFirestore(s.name, phAmount, s.giftId, s.giftName, mpesaReceipt || reference, reference)
              .catch(e => console.warn('[Status] Firestore contribution write failed:', e.message));
          }
        }
        db && db.collection('pendingPayments').doc(reference).delete().catch(() => {});

        return res.json({ success: true, status: resolvedStatus, amount: phAmount, mpesaRef: mpesaReceipt || null });
      }

    } catch (phErr) {
      console.warn('[Status] PayHero query failed:', phErr.message, phErr.response ? '| HTTP ' + phErr.response.status : '');
    }
  }

  // ── 5. Nothing resolved — still PENDING ─────────────────────
  console.log('[Status]', reference, '-> PENDING (no result from any source)');
  return res.json({ success: true, status: 'PENDING', amount: 0 });
});

// ── Shared Firestore contribution write ───────────────────────
async function writeContributionToFirestore(name, amount, giftId, giftName, mpesaRef, extRef) {
  if (!db) { console.warn('[Firebase] writeContribution skipped — db not initialized'); return; }

  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })
                + ' ' + now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short' });

  // Idempotency: don't double-write if callback already recorded it
  const existing = await db.collection('contributions')
    .where('extRef', '==', extRef)
    .limit(1)
    .get();
  if (!existing.empty) {
    console.log('[Firebase] Contribution already recorded for', extRef, '— skipping duplicate write');
    return;
  }

  await db.collection('contributions').add({
    name, amount, giftId, giftName,
    mpesaRef: mpesaRef || null,
    extRef:   extRef || null,
    time:     timeStr,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Update gift raised total in giftTotals collection (for real-time progress bar updates)
  const giftRef = db.collection('giftTotals').doc(giftId);
  await db.runTransaction(async t => {
    const doc = await t.get(giftRef);
    if (doc.exists) {
      t.update(giftRef, { raised: admin.firestore.FieldValue.increment(amount) });
    } else {
      t.set(giftRef, { giftId, raised: amount });
    }
  });

  console.log('[Firebase] Contribution recorded — KES', amount, 'for gift:', giftId, '| by:', name);
}

// ─────────────────────────────────────────────────────────────
// POST /callback  — PayHero webhook
//
// SUCCESS: { "status": true,  "response": { "ResultCode": 0,    "MpesaReceiptNumber": "SAE3Y...", "Amount": 10, "ExternalReference": "BDAY-...", ... } }
// FAILED:  { "status": false, "response": { "ResultCode": 1032, "ResultDesc": "Cancelled by user", "ExternalReference": "BDAY-...", ... } }
// ─────────────────────────────────────────────────────────────
app.post('/callback', async (req, res) => {
  console.log('[Callback] Received:', JSON.stringify(req.body));

  try {
    const body     = req.body;
    const response = body.response || body;

    const extRef      = response.ExternalReference || response.external_reference || response.User_Reference || '';
    const checkoutId  = response.CheckoutRequestID || response.checkout_request_id || '';
    const mpesaRef    = response.MpesaReceiptNumber || response.MPESA_Reference || response.mpesa_reference || '';

    // ResultCode is a NUMBER from PayHero/Safaricom — 0 = success
    // MUST use !== undefined, not ||, because 0 is falsy
    const resultCode = response.ResultCode !== undefined
      ? Number(response.ResultCode)
      : (body.ResultCode !== undefined ? Number(body.ResultCode) : null);

    const bodyStatusTrue = body.status === true;

    // Success: PayHero status:true AND ResultCode 0 (or absent on some successful callbacks)
    const isSuccess   = bodyStatusTrue && (resultCode === null || resultCode === 0);
    const finalStatus = isSuccess ? 'SUCCESS' : 'FAILED';

    // Recover existing store entries before parsing amount/name (needed as fallback)
    const existingByRef      = paymentStore[extRef]      || {};
    const existingByCheckout = paymentStore[checkoutId]  || {};

    // Amount: PayHero sometimes omits Amount in callback — recover from store
    let amount = Number(response.Amount || response.amount || 0);
    if (!amount || amount <= 0) {
      amount = existingByRef.amount || existingByCheckout.amount || 0;
      if (amount > 0) console.log('[Callback] Amount missing in callback — recovered from store:', amount);
    }

    // Recover name/giftId: store → Firestore pendingPayments
    let name     = existingByRef.name     || existingByCheckout.name     || null;
    let giftId   = existingByRef.giftId   || existingByCheckout.giftId   || null;
    let giftName = existingByRef.giftName || existingByCheckout.giftName || null;

    // If Render restarted and paymentStore is empty, recover from Firestore
    if ((!name || !giftId) && db && extRef) {
      try {
        const pendingDoc = await db.collection('pendingPayments').doc(extRef).get();
        if (pendingDoc.exists) {
          const pd = pendingDoc.data();
          name     = name     || pd.name;
          giftId   = giftId   || pd.giftId;
          giftName = giftName || pd.giftName;
          if ((!amount || amount <= 0) && pd.amount) {
            amount = pd.amount;
            console.log('[Callback] Amount recovered from pendingPayments:', amount);
          }
        }
      } catch(e) { /* ignore */ }
    }

    console.log('[Callback]',
      '| extRef:', extRef,
      '| checkoutId:', checkoutId,
      '| amount:', amount,
      '| ResultCode:', resultCode,
      '| body.status:', body.status,
      '| mpesa:', mpesaRef,
      '| name:', name,
      '| giftId:', giftId,
      '| => finalStatus:', finalStatus
    );

    const now = Date.now();
    if (extRef) {
      paymentStore[extRef] = {
        status: finalStatus, amount, name, giftId, giftName,
        mpesaRef: mpesaRef || null,
        createdAt: existingByRef.createdAt || now,
        payheroRef: existingByRef.payheroRef || checkoutId || null,
      };
    }
    if (checkoutId) {
      paymentStore[checkoutId] = {
        status: finalStatus, amount, name, giftId, giftName,
        mpesaRef: mpesaRef || null,
        createdAt: existingByCheckout.createdAt || now,
        payheroRef: checkoutId,
      };
    }

    if (isSuccess) {
      if (db && name && giftId && amount > 0) {
        writeContributionToFirestore(name, amount, giftId, giftName, 'MPESA: ' + (mpesaRef || extRef), extRef)
          .then(() => {
            if (extRef) db.collection('pendingPayments').doc(extRef).delete().catch(() => {});
          })
          .catch(e => console.error('[Firebase] Contribution write failed:', e.message));
      } else {
        // Payment succeeded but missing data — log for manual recovery
        console.error('[Callback] SUCCESS but COULD NOT RECORD — name:', name, '| giftId:', giftId, '| amount:', amount, '| extRef:', extRef, '| mpesa:', mpesaRef);
      }
    } else {
      console.log('[Callback] FAILED — ResultCode:', resultCode, '| name:', name);
      if (db && extRef) db.collection('pendingPayments').doc(extRef).delete().catch(() => {});
    }

  } catch (e) {
    console.error('[Callback] Parse error:', e.message);
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log('[Server] Running on port', PORT);
  console.log('[Server] PayHero:', PAYHERO_AUTH_TOKEN ? 'Configured' : 'MISSING AUTH TOKEN');
  console.log('[Server] Firebase:', db ? 'Connected' : 'NOT connected');
});
