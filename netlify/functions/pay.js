// Netlify Function: REAL payments. A tick / star / chat unlock is written ONLY by this server,
// and ONLY after Razorpay itself says the money was captured. No owner approval is needed and
// nobody can unlock anything by tapping a button.
//
// Required environment variables (Netlify -> Site configuration -> Environment variables):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET      from dashboard.razorpay.com -> Settings -> API Keys
//   FIREBASE_SA_EMAIL, FIREBASE_SA_KEY        from a Firebase service account (see PAYMENTS-SETUP.txt)
// Optional:
//   RAZORPAY_WEBHOOK_SECRET                   only if you add the webhook (backup, see PAYMENTS-SETUP.txt)
const crypto = require('crypto');

const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyADZGM-ZTIxtgr-SytkgtRQRs1iN27ATEw';
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'nextfounder-52b98';
const RZP_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RZP_HOOK = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const SA_EMAIL = process.env.FIREBASE_SA_EMAIL || '';
const SA_KEY = (process.env.FIREBASE_SA_KEY || '').replace(/\\n/g, '\n');
const configured = () => !!(RZP_ID && RZP_SECRET && SA_EMAIL && SA_KEY);

// Prices are decided HERE (rupees). Keep in sync with PRICE in index.html (display only).
const PRICE = { tick: 49, feat: 99, udm: 74, course: 99 };
const NAMES = { tick: 'Blue tick', feat: 'Featured star (30 days)', udm: 'User-to-user chat' };

const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const out = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---------- Firestore (server access through a service account, no npm packages) ----------
let TOK = { t: '', exp: 0 };
async function adminToken() {
  if (TOK.t && Date.now() < TOK.exp - 60000) return TOK.t;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), SA_KEY);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + body + '.' + b64u(sig)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('service account login failed: ' + (j.error_description || j.error || r.status));
  TOK = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return TOK.t;
}
// The Firestore database id can be "(default)" or "default" (this project uses "default"). Find out once and remember.
let DBID = '';
async function dbBase() {
  const base = id => 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/' + id + '/documents';
  if (!DBID) {
    const t = await adminToken();
    for (const id of ['(default)', 'default']) {
      const r = await fetch(base(id) + '/settings/owner', { headers: { Authorization: 'Bearer ' + t } });
      if (r.status === 404) { const j = await r.clone().json().catch(() => ({})); if (j.error && /database[^"]*does not exist/i.test(j.error.message || '')) continue; }
      DBID = id; break;
    }
    if (!DBID) DBID = '(default)';
  }
  return base(DBID);
}
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') { const f = {}; for (const k of Object.keys(v)) f[k] = toFs(v[k]); return { mapValue: { fields: f } }; }
  return { stringValue: String(v) };
}
function fromFs(f) {
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('nullValue' in f) return null;
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(fromFs);
  if ('mapValue' in f) { const o = {}; for (const k of Object.keys(f.mapValue.fields || {})) o[k] = fromFs(f.mapValue.fields[k]); return o; }
  return undefined;
}
async function fsGetDoc(path) {
  const r = await fetch((await dbBase()) + '/' + path, { headers: { Authorization: 'Bearer ' + await adminToken() } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('firestore read ' + path + ' failed: ' + r.status);
  const d = await r.json(), data = {};
  for (const k of Object.keys(d.fields || {})) data[k] = fromFs(d.fields[k]);
  return { data, updateTime: d.updateTime };
}
// write only the given fields; precond = { exists:false } or { updateTime } for safe concurrent writes
async function fsSetFields(path, obj, precond) {
  const keys = Object.keys(obj), fields = {};
  keys.forEach(k => fields[k] = toFs(obj[k]));
  let q = keys.map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  if (precond && precond.exists === false) q += '&currentDocument.exists=false';
  if (precond && precond.updateTime) q += '&currentDocument.updateTime=' + encodeURIComponent(precond.updateTime);
  const r = await fetch((await dbBase()) + '/' + path + '?' + q, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + await adminToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (r.status === 409 || r.status === 412) return 'conflict';
  if (r.status === 400) { const j = await r.json().catch(() => ({})); if (j.error && /precondition/i.test(j.error.status || j.error.message || '')) return 'conflict'; throw new Error('firestore write ' + path + ' failed: 400 ' + JSON.stringify(j.error || {})); }
  if (!r.ok) throw new Error('firestore write ' + path + ' failed: ' + r.status);
  return 'ok';
}
async function fsAdd(path, obj) {
  const fields = {}; Object.keys(obj).forEach(k => fields[k] = toFs(obj[k]));
  await fetch((await dbBase()) + '/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + await adminToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}

// ---------- who is calling ----------
async function verifyUser(idToken) {
  const v = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
  if (!v.ok) return null;
  const u = ((await v.json()).users || [])[0];
  return u ? u.localId : null;
}

// ---------- Razorpay ----------
async function rzp(method, path, body) {
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(RZP_ID + ':' + RZP_SECRET).toString('base64'), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.description) || ('razorpay ' + r.status)); e.status = r.status; throw e; }
  return j;
}

// ---------- price + coupon (decided on the server, the app cannot cheat) ----------
async function quote(item, couponCode) {
  if (item === 'tick' || item === 'feat') { const f = await fsGetDoc('settings/features'); if (!(f && f.data.subsOn)) return { err: 'This subscription is not available right now' }; }
  let base, iname;
  if (PRICE[item] && item !== 'course') { base = PRICE[item]; iname = NAMES[item]; }
  else if (/^course_\d+$/.test(item)) {
    const c = await fsGetDoc('settings/' + item);
    if (!c || c.data.kind !== 'course') return { err: 'Unknown item' };
    base = PRICE.course; iname = 'Course: ' + String(c.data.title || '').slice(0, 60);
  } else return { err: 'Unknown item' };
  let amt = base, coupon = '';
  const code = String(couponCode || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code) {
    const d = await fsGetDoc('coupons/' + code), c = d && d.data;
    const k = item.startsWith('course_') ? 'course' : item;
    if (c && c.active && !(c.expires && Date.now() > c.expires) && !(c.max && (c.used || 0) >= c.max) && !(c.items && c.items !== 'all' && c.items !== k)) {
      amt = Math.max(1, c.type === 'pct' ? Math.round(base * (100 - c.value) / 100) : base - c.value);
      coupon = code;
    }
  }
  return { base, amt, iname, coupon };
}

// ---------- grant (runs once per order, safe to call many times) ----------
async function ownerUid() { const o = await fsGetDoc('settings/owner'); return o && o.data.uid; }
async function pushTo(uid, title, body) {
  try {
    const push = require('./push.js');
    if (!push._sendOne) return;
    const d = await fsGetDoc('push/' + encodeURIComponent(uid)); if (!d) return;
    const raws = [].concat(d.data.subs || []); if (d.data.sub) raws.push(d.data.sub);
    const seen = new Set();
    for (const raw of raws) { try { const s = JSON.parse(raw); if (seen.has(s.endpoint)) continue; seen.add(s.endpoint); await push._sendOne(s, JSON.stringify({ title, body, tag: 'pay-' + Date.now(), room: '' })); } catch (e) { /* one dead device must not stop the rest */ } }
  } catch (e) { /* push is a bonus */ }
}
async function grant(order, payment) {
  const n = order.notes || {}, uid = n.uid, item = n.item, rno = n.rno;
  if (!uid || !item || !rno) return { ok: false, why: 'order has no owner info' };
  if (!(order.amount_paid >= order.amount)) return { ok: false, why: 'not fully paid' };
  const done = await fsGetDoc('payments/' + rno);
  if (done && done.data.status === 'approved') return { ok: true, already: true, rno, item };

  // 1) the unlock itself. "rnos" makes a repeat of the same order do nothing.
  for (let i = 0; i < 6; i++) {
    const cur = await fsGetDoc('badges/' + uid), b = (cur && cur.data) || {};
    if ((b.rnos || []).includes(rno)) break;
    const nb = { rno, ts: Date.now(), rnos: [...(b.rnos || []), rno].slice(-40) };
    if (item === 'tick') nb.tick = true;
    else if (item === 'udm') nb.udm = true;
    else if (item === 'feat') nb.feat = Math.max(Date.now(), b.feat || 0) + 30 * 864e5;
    else nb.courses = [...new Set([...(b.courses || []), item])];
    const r = await fsSetFields('badges/' + uid, nb, cur ? { updateTime: cur.updateTime } : { exists: false });
    if (r === 'ok') break;
    if (i === 5) throw new Error('could not save the unlock, will retry');
  }

  // 2) receipt (also what the buyer sees in Payment history)
  const rec = {
    uid, name: String(n.name || '').slice(0, 60), item, iname: String(n.iname || NAMES[item] || item).slice(0, 80),
    base: Number(n.base) || 0, disc: (Number(n.base) || 0) - Math.round(order.amount / 100), amt: Math.round(order.amount / 100),
    coupon: n.coupon || '', utr: String((payment && payment.acquirer_data && (payment.acquirer_data.upi_transaction_id || payment.acquirer_data.rrn)) || ''),
    status: 'approved', ts: Date.now(), dts: Date.now(), rno, via: 'razorpay', pid: payment ? payment.id : '', order: order.id
  };
  // Only ONE caller can create the receipt. If the app and the webhook arrive at the same moment, the loser stops
  // here, so the coupon is counted once and the buyer/owner get one notification, not two.
  if (await fsSetFields('payments/' + rno, rec, { exists: false }) === 'conflict') return { ok: true, already: true, rno, item };

  // 3) coupon usage, notifications (never allowed to fail the unlock)
  try { if (rec.coupon) { const c = await fsGetDoc('coupons/' + rec.coupon); if (c) await fsSetFields('coupons/' + rec.coupon, { used: (c.data.used || 0) + 1 }); } } catch (e) { }
  const T = { tick: 'Blue tick activated!', feat: 'Featured star activated!', udm: 'User chat unlocked!' }[item] || 'Course unlocked!';
  try { await fsAdd('notifs/' + uid + '/items', { title: T, text: 'Receipt ' + rno + ' - Rs ' + rec.amt + ' - Thank you!', type: 'pay', ts: Date.now(), read: false, done: true }); } catch (e) { }
  pushTo(uid, T, 'Receipt ' + rno + ' - Rs ' + rec.amt);
  try { const ow = await ownerUid(); if (ow && ow !== uid) { await fsAdd('notifs/' + ow + '/items', { title: (rec.name || 'A member') + ' paid Rs ' + rec.amt, text: rec.iname + ' - ' + rno + ' - activated automatically', type: 'pay', ts: Date.now(), read: false, from: uid, rno, done: true }); await pushTo(ow, (rec.name || 'A member') + ' paid Rs ' + rec.amt, rec.iname); } } catch (e) { }
  return { ok: true, rno, item, amt: rec.amt };
}
// look at an order at Razorpay and unlock if (and only if) the money is really in
async function settle(orderId, mustBe) {
  const order = await rzp('GET', '/orders/' + encodeURIComponent(orderId));
  if (mustBe && (order.notes || {}).uid !== mustBe) return { ok: false, why: 'not your order' };
  if (order.status !== 'paid') return { ok: true, paid: false, status: order.status };
  const ps = await rzp('GET', '/orders/' + encodeURIComponent(orderId) + '/payments');
  const pay = ((ps && ps.items) || []).find(p => p.status === 'captured');
  if (!pay) return { ok: true, paid: false, status: 'processing' };
  const g = await grant(order, pay);
  return { ...g, paid: !!g.ok };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { ...H, 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (event.httpMethod === 'GET') return out(200, { configured: configured(), key: configured() ? RZP_ID : '' });
  if (event.httpMethod !== 'POST') return out(405, { error: 'method' });
  try {
    // ----- Razorpay webhook (backup path: works even if the buyer closed the app) -----
    const sigH = event.headers && (event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature']);
    if (sigH) {
      if (!RZP_HOOK || !configured()) return out(503, { error: 'webhook not configured' });
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
      const want = crypto.createHmac('sha256', RZP_HOOK).update(raw).digest('hex');
      const a = Buffer.from(want), b = Buffer.from(String(sigH));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return out(401, { error: 'bad signature' });
      const ev = JSON.parse(raw), oid = (((ev.payload || {}).payment || {}).entity || {}).order_id || (((ev.payload || {}).order || {}).entity || {}).id;
      if (oid && /^(payment\.captured|order\.paid)$/.test(ev.event || '')) await settle(oid, null);
      return out(200, { ok: true });
    }

    if (!configured()) return out(200, { error: 'not_configured' });
    const q = JSON.parse(event.body || '{}');
    const uid = q.token ? await verifyUser(q.token) : null;
    if (!uid) return out(401, { error: 'not signed in' });

    if (q.action === 'create') {
      const item = String(q.item || ''), z = await quote(item, q.coupon);
      if (z.err) return out(400, { error: z.err });
      const rno = 'NF' + Date.now().toString().slice(-9) + String(Math.floor(Math.random() * 90) + 10);
      const order = await rzp('POST', '/orders', {
        amount: z.amt * 100, currency: 'INR', receipt: rno,
        notes: { uid, item, rno, coupon: z.coupon, base: z.base, iname: z.iname, name: String(q.name || '').slice(0, 40) }
      });
      return out(200, { key: RZP_ID, order: order.id, amt: z.amt, base: z.base, rno, iname: z.iname });
    }
    if (q.action === 'status') {
      const oid = String(q.order || '');
      if (!/^order_[A-Za-z0-9]+$/.test(oid)) return out(400, { error: 'bad order' });
      return out(200, await settle(oid, uid));
    }
    return out(400, { error: 'unknown action' });
  } catch (e) {
    return out(500, { error: 'server error', why: String(e && e.message || e).slice(0, 200) });
  }
};
exports._grant = grant; exports._quote = quote; exports._settle = settle;
