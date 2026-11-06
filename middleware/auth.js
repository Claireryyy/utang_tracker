const jwt = require('jsonwebtoken');

module.exports = function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.purpose !== 'session') throw new Error('wrong token type');
    req.ownerId = Number(p.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
};