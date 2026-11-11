require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const pool = require('./db');
const auth = require('./middleware/auth');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '400kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/db-check', async (req, res) => {
  try {
    const r = await pool.query('SELECT now()');
    res.json({ ok: true, time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/owner', require('./routes/owners'));
app.use('/api/push', require('./routes/push'));

app.get('/api/me', auth, async (req, res) => {
  const q = await pool.query(
    'SELECT id, name, age, phone, photo_url FROM owners WHERE id = $1',
    [req.ownerId]
  );
  res.json(q.rows[0]);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const cron = require('node-cron');
const { checkDue } = require('./jobs/duereminders');
cron.schedule('*/5 * * * *', () => checkDue().catch(console.error));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

