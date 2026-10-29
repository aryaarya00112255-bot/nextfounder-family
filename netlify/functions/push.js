// Netlify Function: real push notifications (Web Push + VAPID), no npm dependencies.
// Optional env vars (defaults below work out of the box):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, FIREBASE_API_KEY, FIREBASE_PROJECT_ID
// NOTE: the built-in VAPID keys below belong to YOUR site. If you ever make this code public,
// generate new keys and set them as Netlify environment variables instead.
const crypto = require('crypto');
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyADZGM-ZTIxtgr-SytkgtRQRs1iN27ATEw';
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'nextfounder-52b98';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@nextfounder.app';
const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}
// RFC 8291 (aes128gcm) payload encryption
function encrypt(sub, payload, opt = {}) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (opt.asPriv) ecdh.setPrivateKey(opt.asPriv); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const salt = opt.salt || crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const hdr = Buffer.alloc(21); salt.copy(hdr, 0); hdr.writeUInt32BE(4096, 16); hdr[20] = 65;
  return Buffer.concat([hdr, asPub, ct]);
}
function vapidAuth(endpoint) {
  const pub = unb64u(VAPID_PUBLIC);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: VAPID_PRIVATE }, format: 'jwk' });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + VAPID_PUBLIC;
}
async function sendOne(sub, payload) {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(sub.endpoint) },
    body: encrypt(sub, payload)
  });
  return r.status;
}
async function fsGet(path, token) {
  for (const db of ['(default)', 'default']) {
    const r = await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/' + db + '/documents/' + path, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
    if (r.status === 404) { const j = await r.json().catch(() => ({})); if (j.error && /database/i.test(j.error.message || '')) continue; return null; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { ...H, 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (event.httpMethod === 'GET') return { statusCode: VAPID_PUBLIC ? 200 : 503, headers: H, body: JSON.stringify(VAPID_PUBLIC ? { key: VAPID_PUBLIC } : { error: 'push_not_configured' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method"}' };
  try {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { statusCode: 503, headers: H, body: JSON.stringify({ error: 'push_not_configured' }) };
    const { token, to, title, text, type, gid, test, room, mention } = JSON.parse(event.body || '{}');
    if (!token || !Array.isArray(to) || !to.length) return { statusCode: 400, headers: H, body: '{"error":"bad request"}' };
    const v = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
    if (!v.ok) { const ej = await v.json().catch(() => ({})); return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'not signed in', why: 'Firebase API key/lookup failed: HTTP ' + v.status + ' ' + ((ej.error && ej.error.message) || '') }) }; }
    const caller = ((await v.json()).users || [])[0].localId;
    const od = await fsGet('settings/owner', null);
    const owner = od && od.fields && od.fields.uid && od.fields.uid.stringValue;
    // only the owner may notify members; members may notify only the owner
    // owner may notify anyone; members may notify the owner and the other members of a group they belong to
    let gm = null;
    if (gid && caller !== owner) {
      const gd = await fsGet('groups/' + encodeURIComponent(String(gid)), token);
      const vals = gd && gd.fields && gd.fields.members && gd.fields.members.arrayValue && gd.fields.members.arrayValue.values;
      const list = (vals || []).map(x => x.stringValue);
      if (list.includes(caller)) gm = list;
    }
    const up = (room && String(room).startsWith('u_')) ? String(room).slice(2).split('_') : null;
    const targets = test === true ? [caller] : [...new Set(to.map(String))].filter(t => t !== caller && (caller === owner || t === owner || (gm && gm.includes(t)) || (up && up.includes(caller) && up.includes(t)))).slice(0, 100);
    const payload = JSON.stringify({ title: String(title || 'NextFounder').slice(0, 80), body: String(text || '').slice(0, 160), tag: (room && type !== 'test') ? String(room).slice(0, 80) : (type || 'n') + '-' + Date.now(), room: String(room || '').slice(0, 80) });
    let sent = 0, gone = 0, nosub = 0, muted = 0; const fails = [];
    // which preference switch controls this notification
    const rm = String(room || '');
    const pkey = rm.startsWith('g_') ? 'g' : rm.startsWith('u_') ? 'u' : rm.startsWith('dm_') ? 'dm' : type === 'announce' ? 'ann' : type === 'pay' ? 'pay' : '';
    await Promise.all(targets.map(async (t) => {
      try {
        const d = await fsGet('push/' + encodeURIComponent(t), token);
        const f = (d && d.fields) || {};
        const pf = (f.prefs && f.prefs.mapValue && f.prefs.mapValue.fields) || {};
        const off = k => pf[k] && pf[k].booleanValue === false;
        const paused = pf.dnd && pf.dnd.booleanValue === true;
        if (test !== true && (mention === true ? off('mt') : (paused || (pkey && off(pkey))))) { muted++; return; }
        const myPayload = off('pv') ? JSON.stringify({ ...JSON.parse(payload), body: 'You have a new message' }) : payload;
        const raws = ((f.subs && f.subs.arrayValue && f.subs.arrayValue.values) || []).map(x => x.stringValue);
        if (f.sub && f.sub.stringValue) raws.push(f.sub.stringValue);
        const seen = new Set(); let okd = false;
        for (const raw of raws) { try { const s = JSON.parse(raw); if (seen.has(s.endpoint)) continue; seen.add(s.endpoint);
          const st = await sendOne(s, myPayload); if (st >= 200 && st < 300) okd = true; else { fails.push(st); if (st === 404 || st === 410) gone++; } } catch (e) {} }
        if (!raws.length) nosub++;
        if (okd) sent++;
      } catch (e) { /* ignore single failures */ }
    }));
    return { statusCode: 200, headers: H, body: JSON.stringify({ sent, gone, nosub, muted, fails, targets: targets.length, hint: sent ? '' : (nosub ? 'Phone ka address Firestore (push collection) me save nahi hua: Firestore rules republish karo' : (fails.length ? 'Push service ne reject kiya: ' + fails.join(',') : 'Koi target nahi mila')) }) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: '{"error":"server error"}' };
  }
};
exports._encrypt = encrypt; exports._vapidAuth = vapidAuth;
exports._sendOne = sendOne;
