const webpush = require('web-push');
const pool = require('../db');
 
const TZ = process.env.APP_TZ || 'Asia/Manila';
const DAY = 24 * 60 * 60 * 1000;
const MORNING_HOUR = 8; // daily overdue reminder goes out from 8 AM
 
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
 
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
const hourOf = (d) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d)) % 24;
const when = (d) =>
  new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });
 
async function sendToOwner(ownerId, payload) {
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id = $1',
    [ownerId]
  );
  for (const s of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410)
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); // phone unsubscribed
      else console.error('Push failed:', e.statusCode || e.message);
    }
  }
  return rows.length;
}
 
let running = false;
 
async function checkDue() {
  if (running || !process.env.VAPID_PUBLIC_KEY) return;
  running = true;
  try {
    const now = new Date();
    const today = dayKey(now);
    const { rows } = await pool.query(`
      SELECT c.id, c.owner_id, c.name, c.due_at, c.notified_soon_for, c.last_alert_due,
             to_char(c.last_overdue_reminder, 'YYYY-MM-DD') AS last_overdue,
             COALESCE(SUM(CASE t.type WHEN 'utang' THEN t.amount ELSE -t.amount END), 0)::float8 AS balance
        FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id
       WHERE c.due_at IS NOT NULL
       GROUP BY c.id
      HAVING COALESCE(SUM(CASE t.type WHEN 'utang' THEN t.amount ELSE -t.amount END), 0) > 0`);
 
    for (const c of rows) {
      const due = new Date(c.due_at);
      const sameDue = (x) => x && new Date(x).getTime() === due.getTime();
      let alert = null;
      let set = null;
 
      if (now < due) {
        // 1) due within the next 24 hours
        if (due - now <= DAY && !sameDue(c.notified_soon_for)) {
          alert = { title: 'Payment due soon', body: `${c.name} owes ${peso(c.balance)}. Due ${when(due)}.` };
          set = ['notified_soon_for = $2', [due]];
        }
      } else if (!sameDue(c.last_alert_due)) {
        // 2) the due time has passed
        alert = { title: 'Payment due now', body: `${c.name} owes ${peso(c.balance)}. Was due ${when(due)}.` };
        set = ['last_alert_due = $2, last_overdue_reminder = $3', [due, today]];
      } else if (c.last_overdue !== today && hourOf(now) >= MORNING_HOUR && dayKey(due) < today) {
        // 3) one reminder each morning while still unpaid
        alert = { title: 'Payment overdue', body: `${c.name} still owes ${peso(c.balance)}. Overdue since ${when(due)}.` };
        set = ['last_overdue_reminder = $2', [today]];
      }
 
      if (!alert) continue;
      // mark first, then send, so overlapping runs can never send twice
      await pool.query(`UPDATE customers SET ${set[0]} WHERE id = $1`, [c.id, ...set[1]]);
      await sendToOwner(c.owner_id, { ...alert, tag: `due-${c.id}`, url: '/' });
    }
  } finally {
    running = false;
  }
}
 
module.exports = { checkDue, sendToOwner };