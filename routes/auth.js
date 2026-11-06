const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const pool = require('../db');

const router = express.Router();

const limiter = (limit, minutes, msg) =>
  rateLimit({
    windowMs: minutes * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: msg },
  });
const signupLimiter = limiter(10, 60, 'Too many sign-ups. Try again later.');
const loginLimiter = limiter(5, 15, 'Too many attempts. Try again in 15 minutes.');

const norm = (s) => s.replace(/\D/g, '');
const pin = z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits.');
const phone = z.string().min(7, 'Enter a valid contact number.');

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(80),
  age: z.coerce.number().int().min(1, 'Enter a valid age.').max(120, 'Enter a valid age.'),
  phone,
  pin,
  recovery: z.string().trim().min(1, 'Please answer the recovery question.'),
});
const loginSchema = z.object({ phone, pin });
const verifySchema = z.object({ phone, recovery: z.string().trim().min(1) });
const resetSchema = z.object({ resetToken: z.string().min(1), pin });

const fail = (res, parsed) =>
  res.status(400).json({ error: parsed.error.issues[0].message });
const sign = (id, purpose, expiresIn) =>
  jwt.sign({ purpose }, process.env.JWT_SECRET, { subject: String(id), expiresIn });

// POST /api/auth/signup
router.post('/signup', signupLimiter, async (req, res) => {
  const r = signupSchema.safeParse(req.body);
  if (!r.success) return fail(res, r);
  const { name, age, pin, recovery } = r.data;
  const phoneNum = norm(r.data.phone);
  if (phoneNum.length < 7) return res.status(400).json({ error: 'Enter a valid contact number.' });

  const pinHash = await bcrypt.hash(pin, 10);
  const recoveryHash = await bcrypt.hash(recovery.toLowerCase(), 10);
  try {
    await pool.query(
      'INSERT INTO owners (name, age, phone, pin_hash, recovery_hash) VALUES ($1,$2,$3,$4,$5)',
      [name, age, phoneNum, pinHash, recoveryHash]
    );
    res.status(201).json({ message: 'Account created! Tap OK to log in.' });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'This contact number already has an account.' });
    throw e;
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const r = loginSchema.safeParse(req.body);
  if (!r.success) return fail(res, r);
  const q = await pool.query('SELECT id, name, pin_hash FROM owners WHERE phone = $1', [
    norm(r.data.phone),
  ]);
  const owner = q.rows[0];
  const ok = owner && (await bcrypt.compare(r.data.pin, owner.pin_hash));
  if (!ok) return res.status(401).json({ error: 'Incorrect contact number or PIN.' });
  res.json({ token: sign(owner.id, 'session', '12h'), name: owner.name });
});

// POST /api/auth/forgot/verify
router.post('/forgot/verify', loginLimiter, async (req, res) => {
  const r = verifySchema.safeParse(req.body);
  if (!r.success) return fail(res, r);
  const q = await pool.query('SELECT id, recovery_hash FROM owners WHERE phone = $1', [
    norm(r.data.phone),
  ]);
  const owner = q.rows[0];
  const ok = owner && (await bcrypt.compare(r.data.recovery.toLowerCase(), owner.recovery_hash));
  if (!ok) return res.status(401).json({ error: 'Contact number or answer is incorrect.' });
  res.json({ resetToken: sign(owner.id, 'reset', '10m') });
});

// POST /api/auth/forgot/reset
router.post('/forgot/reset', loginLimiter, async (req, res) => {
  const r = resetSchema.safeParse(req.body);
  if (!r.success) return fail(res, r);
  try {
    const p = jwt.verify(r.data.resetToken, process.env.JWT_SECRET);
    if (p.purpose !== 'reset') throw new Error('wrong token type');
    const pinHash = await bcrypt.hash(r.data.pin, 10);
    await pool.query('UPDATE owners SET pin_hash = $1 WHERE id = $2', [pinHash, Number(p.sub)]);
    res.json({ message: 'PIN reset! Log in with your new PIN.' });
  } catch {
    res.status(401).json({ error: 'Reset link expired. Please verify again.' });
  }
});

module.exports = router;