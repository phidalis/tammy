// ============================================================
// Birthday Gift Payment Server — PayHero + Firebase
// Deploy on Render. Set these environment variables:
//   PAYHERO_AUTH_TOKEN  → Basic auth token from PayHero dashboard
//   PAYHERO_CHANNEL_ID  → Your PayHero payment channel ID
//   PAYHERO_PROVIDER    → e.g. m-pesa
//   RENDER_URL          → Your Render URL (no trailing slash)
//                         e.g. https://birthday-api.onrender.com
// ============================================================

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Auth token directly from env (already base64 encoded) ────
function getAuthToken() {
  const token = process.env.PAYHERO_AUTH_TOKEN;
  if (!token) throw new Error('PAYHERO_AUTH_TOKEN not set');
  // If user pasted the raw token without "Basic " prefix, add it
  return token.startsWith('Basic ') ? token : 'Basic ' + token;
}

// ── In-memory pending payments store ─────────────────────────
const pending = {};

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'birthday-payment-api' }));

// ─────────────────────────────────────────────────────────────
// POST /pay  — initiate STK push
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
  const channelId   = parseInt(process.env.PAYHERO_CHANNEL_ID);
  const provider    = process.env.PAYHERO_PROVIDER || 'm-pesa';

  try {
    const { data } = await axios.post(
      'https://backend.payhero.co.ke/api/v2/payments',
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

    if (!data.success) {
      return res.status(502).json({ success: false, error: data.message || 'STK push failed' });
    }

    // Store pending record
    pending[reference] = {
      name, giftId, giftName,
      amount:            parseInt(amount),
      phone:             tel,
      checkoutRequestId: data.CheckoutRequestID,
      status:            'PENDING',
      mpesaRef:          null,
    };

    return res.json({
      success:           true,
      reference,
      checkoutRequestId: data.CheckoutRequestID,
      message:           'STK push sent! Check your phone.',
    });

  } catch (err) {
    console.error('[/pay] error:', err?.response?.data || err.message);
    return res.status(502).json({ success: false, error: 'Payment initiation failed. Try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /status/:reference  — poll transaction status
// ─────────────────────────────────────────────────────────────
app.get('/status/:reference', async (req, res) => {
  const { reference } = req.params;
  const record = pending[reference];

  if (!record) {
    return res.status(404).json({ success: false, error: 'Reference not found' });
  }

  // Already have a terminal status from callback — return immediately
  if (record.status === 'SUCCESS' || record.status === 'FAILED') {
    return res.json({ success: true, ...record });
  }

  // Otherwise query PayHero for live status
  try {
    const { data } = await axios.get(
      `https://backend.payhero.co.ke/api/v2/transaction-status/${reference}`,
      { headers: { Authorization: getAuthToken() } }
    );

    const status = (data.status || '').toUpperCase();

    if (status === 'SUCCESS') {
      record.status   = 'SUCCESS';
      record.mpesaRef = data.provider_reference || data.MpesaReceiptNumber || null;
    } else if (status === 'FAILED') {
      record.status = 'FAILED';
    }

    return res.json({ success: true, ...record });

  } catch (err) {
    console.error('[/status] error:', err?.response?.data || err.message);
    return res.json({ success: true, ...record });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /callback  — PayHero posts here when payment completes
// ─────────────────────────────────────────────────────────────
app.post('/callback', (req, res) => {
  console.log('[callback]', JSON.stringify(req.body));

  try {
    const body      = req.body;
    const reference = body.ExternalReference || body.external_reference;
    const status    = (body.status || '').toUpperCase();

    if (reference && pending[reference]) {
      pending[reference].status   = status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
      pending[reference].mpesaRef = body.MpesaReceiptNumber || body.provider_reference || null;
      console.log(`[callback] ${reference} → ${pending[reference].status}`);
    }
  } catch (e) {
    console.error('[callback] parse error:', e.message);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🎀 Birthday payment server running on port ${PORT}`));
