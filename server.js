require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));