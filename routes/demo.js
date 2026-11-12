const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
 
const router = express.Router();
 
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many demos started from this network. Please try again later.' },
});
 
const DAY = 24 * 60 * 60 * 1000;
const ago = (d) => new Date(Date.now() - d * DAY);
const ahead = (d) => new Date(Date.now() + d * DAY);
const day = (d) => d.toISOString().slice(0, 10);
 
// [name, phone, due date, [[type, amount, days ago, list of orders], ...]]
const SAMPLE = [
  ['Aling Nena', '09171112233', ago(2), [['utang', 350, 9, 'rice 5kg, cooking oil, sugar'], ['payment', 100, 5, null], ['utang', 120, 3, 'canned sardines x4, noodles']]], // overdue
  ['Mang Tonyo', '09182223344', ahead(0.5), [['utang', 210, 4, 'cigarettes, coffee sachets, bread']]], // due in 12 hours
  ['Joy Santos', '09173334455', ahead(6), [['utang', 170, 2, 'soap, shampoo sachets, biscuits']]],
  ['Kuya Ben', '09284445566', ahead(12), [['utang', 480, 6, 'rice 10kg, eggs, soy sauce'], ['payment', 200, 1, null]]],
  ['Ate Liza', '09195556677', null, [['utang', 150, 10, 'softdrinks x6'], ['payment', 150, 3, null]]], // fully paid
];
 
// POST /api/demo  -> creates a temporary owner with sample data and logs them in
router.post('/', limiter, async (req, res) => {
  // The fake number and random PIN hash mean nobody can log in to a demo account by typing a PIN.
  const phone = '0000' + String(crypto.randomInt(0, 1e7)).padStart(7, '0');
  const pinHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 8);
  const recHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 8);
 
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      `INSERT INTO owners (name, age, phone, pin_hash, recovery_hash, is_demo)
       VALUES ('Demo Owner', 40, $1, $2, $3, true) RETURNING id`,
      [phone, pinHash, recHash]
    );
    const ownerId = o.rows[0].id;
    for (const [name, cphone, due, txs] of SAMPLE) {
      const c = await client.query(
        'INSERT INTO customers (owner_id, name, phone, due_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [ownerId, name, cphone, due]
      );
      for (const [type, amount, daysAgo, note] of txs) {
        await client.query(
          'INSERT INTO transactions (customer_id, type, amount, tx_date, note) VALUES ($1,$2,$3,$4,$5)',
          [c.rows[0].id, type, amount, day(ago(daysAgo)), note]
        );
      }
    }
    await client.query('COMMIT');
    const token = jwt.sign({ purpose: 'session', demo: true }, process.env.JWT_SECRET, {
      subject: String(ownerId),
      expiresIn: '24h',
    });
    res.status(201).json({ token, name: 'Demo Owner' });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});
 
module.exports = router;