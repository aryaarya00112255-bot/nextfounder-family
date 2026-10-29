// Netlify Function: automatic WhatsApp messages (WhatsApp Cloud API). Does nothing until env vars are set:
//   WA_TOKEN (permanent access token), WA_PHONE_ID (phone number id), WA_TEMPLATE (approved template name, 1 body variable {{1}}), WA_LANG (default en)
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyADZGM-ZTIxtgr-SytkgtRQRs1iN27ATEw';
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'nextfounder-52b98';
const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const out = (c, o) => ({ statusCode: c, headers: H, body: JSON.stringify(o) });
const num = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d.length >= 11 ? d : ''; };
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return out(200, {});
  if (event.httpMethod !== 'POST') return out(405, { error: 'POST only' });
  if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID || !process.env.WA_TEMPLATE) return out(200, { configured: false });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return out(400, { error: 'bad json' }); }
  const { token, kind } = b; const text = String(b.text || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, 900);
  if (!token || !text) return out(400, { error: 'missing' });
  const v = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, { method: 'POST', headers: H, body: JSON.stringify({ idToken: token }) });
  if (!v.ok) return out(401, { error: 'not signed in' });
  const uid = ((await v.json()).users || [{}])[0].localId; if (!uid) return out(401, { error: 'not signed in' });
  const auth = { Authorization: 'Bearer ' + token };
  let phones = [];
  if (kind === 'welcome') {
    const r = await fetch(`${FS}/private/${uid}`, { headers: auth }); const d = r.ok ? await r.json() : null;
    phones = [num(d && d.fields && d.fields.phone && d.fields.phone.stringValue)];
  } else if (kind === 'broadcast') {
    const o = await fetch(`${FS}/settings/owner`); const od = o.ok ? await o.json() : null;
    if (!od || od.fields.uid.stringValue !== uid) return out(403, { error: 'owner only' });
    const r = await fetch(`${FS}/private?pageSize=300`, { headers: auth }); const d = r.ok ? await r.json() : {};
    phones = (d.documents || []).filter(x => !x.name.endsWith('/' + uid)).map(x => num(x.fields && x.fields.phone && x.fields.phone.stringValue));
  } else return out(400, { error: 'bad kind' });
  phones = [...new Set(phones.filter(Boolean))]; let sent = 0, failed = 0;
  for (const to of phones) {
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${process.env.WA_PHONE_ID}/messages`, { method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: process.env.WA_TEMPLATE, language: { code: process.env.WA_LANG || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }) });
      if (r.ok) sent++; else failed++;
    } catch (e) { failed++; }
  }
  return out(200, { configured: true, sent, failed, total: phones.length });
};
