const express = require('express');
const { z } = require('zod');
const pool = require('../db');
const auth = require('../middleware/auth');
const { checkDue, sendToOwner } = require('../jobs/duereminders');
 
const router = express.Router();
router.use(auth);
 
const subSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});


router.get('/key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY)
    return res.status(503).json({ error: 'Notifications are not set up on the server yet.' });
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});


router.post('/subscribe', async (req, res) => {
  const p = subSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid subscription.' });
  const { endpoint, keys } = p.data;
  await pool.query(
    `INSERT INTO push_subscriptions (owner_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.ownerId, endpoint, keys.p256dh, keys.auth]
  );
  res.status(201).json({ message: 'Subscribed.' });
});
 
// POST /api/push/test  -> sends a test notification to this owner's devices
router.post('/test', async (req, res) => {
  const sent = await sendToOwner(req.ownerId, {
    title: 'Notifications are on',
    body: 'You will get due-date alerts here.',
    tag: 'test',
    url: '/',
  });
  res.json({ sent });
});
 
// POST /api/push/check-now  -> runs the due-date check immediately (testing only)
router.post('/check-now', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  await checkDue();
  res.json({ message: 'Check finished.' });
});
 
module.exports = router;