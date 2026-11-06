const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /api/transactions?search=
router.get('/', async (req, res) => {
  const s = String(req.query.search || '').trim().replace(/[\\%_]/g, '\\$&');
  const q = await pool.query(
    `SELECT t.id, t.type, t.amount::float8 AS amount,
            to_char(t.tx_date,'YYYY-MM-DD') AS tx_date, t.note,
            c.id AS customer_id, c.name AS customer_name
       FROM transactions t JOIN customers c ON c.id = t.customer_id
      WHERE c.owner_id = $1 AND (c.name ILIKE $2 OR COALESCE(t.note,'') ILIKE $2)
      ORDER BY t.tx_date DESC, t.id DESC LIMIT 200`,
    [req.ownerId, `%${s}%`]
  );
  res.json(q.rows);
});

module.exports = router;