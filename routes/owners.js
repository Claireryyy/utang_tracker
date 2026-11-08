const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const norm = (s) => s.replace(/\D/g, '');

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(80),
  age: z.coerce.number().int().min(1, 'Enter a valid age.').max(120, 'Enter a valid age.'),
  phone: z.string().min(7, 'Enter a valid contact number.'),
  photo: z
    .string()
    .max(300000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'Photo must be a JPEG image.')
    .optional(),
});

const pinSchema = z.object({
  current: z.string().min(1, 'Enter your current PIN.'),
  pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits.'),
});

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

// PUT /api/owner  (name, age, phone, optional photo)
router.put('/', async (req, res) => {
  const p = profileSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const d = p.data;
  const phone = norm(d.phone);
  if (phone.length < 7) return res.status(400).json({ error: 'Enter a valid contact number.' });
  try {
    await pool.query(
      'UPDATE owners SET name=$1, age=$2, phone=$3, photo_url=COALESCE($4, photo_url) WHERE id=$5',
      [d.name, d.age, phone, d.photo ?? null, req.ownerId]
    );
    res.json({ message: 'Profile updated.' });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'That contact number is used by another account.' });
    throw e;
  }
});

// PUT /api/owner/pin  (wrong current PIN returns 400, not 401, so the app doesn't log you out)
router.put('/pin', pinLimiter, async (req, res) => {
  const p = pinSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const q = await pool.query('SELECT pin_hash FROM owners WHERE id=$1', [req.ownerId]);
  const ok = q.rows[0] && (await bcrypt.compare(p.data.current, q.rows[0].pin_hash));
  if (!ok) return res.status(400).json({ error: 'Current PIN is incorrect.' });
  await pool.query('UPDATE owners SET pin_hash=$1 WHERE id=$2', [
    await bcrypt.hash(p.data.pin, 10),
    req.ownerId,
  ]);
  res.json({ message: 'PIN changed successfully!' });
});

module.exports = router;