const express = require('express');
const { z } = require('zod');
const pool = require('../db');
const auth = require('../middleware/auth');
 
const router = express.Router();
router.use(auth);
router.param('id', (req, res, next, v) =>
  /^\d+$/.test(v) ? next() : res.status(400).json({ error: 'Invalid id.' })
);
 
// Demo accounts are capped so nobody can fill the database
async function demoCap(req, res, next) {
  if (!req.isDemo) return next();
  const q = await pool.query(
    `SELECT (SELECT COUNT(*) FROM customers WHERE owner_id = $1)::int AS c,
            (SELECT COUNT(*) FROM transactions t JOIN customers c ON c.id = t.customer_id
              WHERE c.owner_id = $1)::int AS t`,
    [req.ownerId]
  );
  if (q.rows[0].c >= 15 || q.rows[0].t >= 80)
    return res.status(400).json({ error: 'This demo is full. Log out and start a new demo to keep trying.' });
  next();
}
 
const money = z.coerce
  .number()
  .positive('Enter an amount greater than zero.')
  .max(1000000, 'Amount is too large.');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date.');
const dueAt = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)) && new Date(v) > new Date(), 'Choose a future due date and time.');
const note = z
  .string()
  .trim()
  .min(1, 'Please enter the list of orders.')
  .max(200, 'The list of orders is too long (200 characters max).');
const phone = z.string().trim().max(30).default('');
const name = z.string().trim().min(1, 'Please enter the customer’s name.').max(80);
const clientId = z.string().max(64).optional(); // unique id made by the phone, so a retry never saves twice
 
const newCustomer = z.object({ name, phone, note, date: day, amount: money, dueAt, clientId });
const newUtang = z.object({ note, date: day, amount: money, dueAt, clientId });
const newPayment = z.object({ amount: money, date: day, clientId });
const editCustomer = z.object({ name, phone, dueAt: dueAt.optional() });
 
const fail = (res, p) => res.status(400).json({ error: p.error.issues[0].message });
const round2 = (n) => Math.round(n * 100) / 100;
const isOver = (balance, due) => Boolean(balance > 0 && due && new Date(due) <= new Date());
 
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
const send = (res, out) => res.status(out.status).json(out.error ? { error: out.error } : out.body);
const dupName = (res) => res.status(409).json({ error: 'A customer with this name already exists.' });
const alreadySaved = async (client, ownerId, cid) =>
  (
    await client.query(
      `SELECT 1 FROM transactions t JOIN customers c ON c.id = t.customer_id
        WHERE t.client_id = $1 AND c.owner_id = $2`,
      [cid, ownerId]
    )
  ).rowCount > 0;
 
// GET /api/customers?search=
router.get('/', async (req, res) => {
  const s = String(req.query.search || '').trim().replace(/[\\%_]/g, '\\$&');
  const q = await pool.query(
    `SELECT c.id, c.name, c.phone, c.due_at,
            COALESCE(SUM(CASE t.type WHEN 'utang' THEN t.amount ELSE -t.amount END),0)::float8 AS balance
       FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id
      WHERE c.owner_id = $1 AND c.name ILIKE $2
      GROUP BY c.id ORDER BY c.name`,
    [req.ownerId, `%${s}%`]
  );
  res.json(
    q.rows.map((r) => ({ ...r, balance: round2(r.balance), overdue: isOver(r.balance, r.due_at) }))
  );
});
 
// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  const c = await pool.query(
    `SELECT c.id, c.name, c.phone, c.due_at,
            COALESCE(SUM(CASE WHEN t.type='utang' THEN t.amount END),0)::float8 AS total_utang,
            COALESCE(SUM(CASE WHEN t.type='payment' THEN t.amount END),0)::float8 AS total_paid
       FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id
      WHERE c.id = $1 AND c.owner_id = $2 GROUP BY c.id`,
    [req.params.id, req.ownerId]
  );
  const r = c.rows[0];
  if (!r) return res.status(404).json({ error: 'Customer not found.' });
  const t = await pool.query(
    `SELECT id, type, amount::float8 AS amount, to_char(tx_date,'YYYY-MM-DD') AS tx_date, note
       FROM transactions WHERE customer_id = $1 ORDER BY tx_date DESC, id DESC LIMIT 50`,
    [req.params.id]
  );
  const balance = round2(r.total_utang - r.total_paid);
  res.json({ ...r, balance, overdue: isOver(balance, r.due_at), transactions: t.rows });
});
 
// POST /api/customers  (customer + first utang together)
router.post('/', demoCap, async (req, res) => {
  const p = newCustomer.safeParse(req.body);
  if (!p.success) return fail(res, p);
  const d = p.data;
  try {
    const out = await withTx(async (client) => {
      const c = await client.query(
        'INSERT INTO customers (owner_id, name, phone, due_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [req.ownerId, d.name, d.phone, d.dueAt]
      );
      await client.query(
        `INSERT INTO transactions (customer_id, type, amount, tx_date, note, client_id)
         VALUES ($1,'utang',$2,$3,$4,$5) ON CONFLICT (client_id) DO NOTHING`,
        [c.rows[0].id, d.amount, d.date, d.note, d.clientId || null]
      );
      return { status: 201, body: { id: c.rows[0].id, message: 'Saved information.' } };
    });
    send(res, out);
  } catch (e) {
    if (e.code === '23505') return dupName(res);
    throw e;
  }
});
 
// PUT /api/customers/:id
router.put('/:id', async (req, res) => {
  const p = editCustomer.safeParse(req.body);
  if (!p.success) return fail(res, p);
  const d = p.data;
  try {
    const q = await pool.query(
      `UPDATE customers SET name=$1, phone=$2, due_at=COALESCE($3::timestamptz, due_at)
        WHERE id=$4 AND owner_id=$5`,
      [d.name, d.phone, d.dueAt ?? null, req.params.id, req.ownerId]
    );
    if (!q.rowCount) return res.status(404).json({ error: 'Customer not found.' });
    res.json({ message: 'Saved.' });
  } catch (e) {
    if (e.code === '23505') return dupName(res);
    throw e;
  }
});
 
// DELETE /api/customers/:id
router.delete('/:id', async (req, res) => {
  const q = await pool.query('DELETE FROM customers WHERE id=$1 AND owner_id=$2', [
    req.params.id,
    req.ownerId,
  ]);
  if (!q.rowCount) return res.status(404).json({ error: 'Customer not found.' });
  res.json({ message: 'Deleted.' });
});
 
// POST /api/customers/:id/utang
router.post('/:id/utang', demoCap, async (req, res) => {
  const p = newUtang.safeParse(req.body);
  if (!p.success) return fail(res, p);
  const d = p.data;
  const out = await withTx(async (client) => {
    const own = await client.query('SELECT id FROM customers WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      req.params.id,
      req.ownerId,
    ]);
    if (!own.rowCount) return { status: 404, error: 'Customer not found.' };
    if (d.clientId && (await alreadySaved(client, req.ownerId, d.clientId)))
      return { status: 200, body: { message: 'Already saved.' } };
    await client.query(
      `INSERT INTO transactions (customer_id, type, amount, tx_date, note, client_id)
       VALUES ($1,'utang',$2,$3,$4,$5)`,
      [req.params.id, d.amount, d.date, d.note, d.clientId || null]
    );
    await client.query('UPDATE customers SET due_at=$1 WHERE id=$2', [d.dueAt, req.params.id]);
    return { status: 201, body: { message: 'New utang added!' } };
  });
  send(res, out);
});
 
// POST /api/customers/:id/payments
router.post('/:id/payments', demoCap, async (req, res) => {
  const p = newPayment.safeParse(req.body);
  if (!p.success) return fail(res, p);
  const d = p.data;
  const out = await withTx(async (client) => {
    const own = await client.query('SELECT id FROM customers WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      req.params.id,
      req.ownerId,
    ]);
    if (!own.rowCount) return { status: 404, error: 'Customer not found.' };
    if (d.clientId && (await alreadySaved(client, req.ownerId, d.clientId)))
      return { status: 200, body: { message: 'Already saved.' } };
    const b = await client.query(
      `SELECT COALESCE(SUM(CASE type WHEN 'utang' THEN amount ELSE -amount END),0)::text AS bal
         FROM transactions WHERE customer_id=$1`,
      [req.params.id]
    );
    const balC = Math.round(Number(b.rows[0].bal) * 100);
    const amtC = Math.round(d.amount * 100);
    if (amtC > balC)
      return { status: 400, error: `That is more than the pending utang of ₱${(balC / 100).toFixed(2)}.` };
    await client.query(
      `INSERT INTO transactions (customer_id, type, amount, tx_date, client_id) VALUES ($1,'payment',$2,$3,$4)`,
      [req.params.id, d.amount, d.date, d.clientId || null]
    );
    if (amtC === balC) await client.query('UPDATE customers SET due_at=NULL WHERE id=$1', [req.params.id]);
    return { status: 201, body: { message: 'Payment successful!', balance: (balC - amtC) / 100 } };
  });
  send(res, out);
});
 
module.exports = router;