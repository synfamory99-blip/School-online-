/* School Online — expéditeur de notifications push (Cloudflare Worker, plan gratuit)
 *
 * Toutes les minutes (tâche planifiée), ce programme :
 *   1. regarde les nouvelles notifications créées dans l'application (réponse du forum, mention, réaction)
 *      et les envoie sur le téléphone de l'élève concerné ;
 *   2. envoie les rappels programmés (séance de révision dans 15 minutes, devoir ou examen qui approche).
 *
 * Il passe par Firebase Cloud Messaging (gratuit). Aucun serveur à payer, aucune dépendance externe.
 *
 * Réglages à faire dans Cloudflare (voir GUIDE_NOTIFICATIONS_PUSH.md) :
 *   - Secret    SERVICE_ACCOUNT_JSON : contenu du fichier « clé de compte de service » téléchargé dans Firebase
 *   - Variable  PROJECT_ID           : identifiant du projet Firebase (ex. schoolonline-42025)
 *   - Déclencheur planifié (Cron)    : * * * * *
 *
 * Limites du plan gratuit Cloudflare (10 ms de calcul, 50 appels sortants par exécution) :
 * on se limite donc à ~10 notifications et ~8 rappels par minute ; le reste est traité à la minute suivante.
 */
const SCOPES = 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging';
const MAX_SUBREQUESTS = 45;            // plafond Cloudflare gratuit : 50
const MAX_NOTIFS_PER_RUN = 10;
const MAX_SCHEDULES_PER_RUN = 8;
const MAX_PUSH_PER_USER_PER_RUN = 3;   // limite le « spam » vers un même élève
const STALE_EVENT_MS = 20 * 60 * 1000; // un rappel manqué de plus de 20 min n'est plus envoyé
const UID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const LINK_RE = /^(page|forum):[A-Za-z0-9_-]{1,100}$/;

/* ---------- Encodage Firestore (REST) ---------- */
function fromValue(v){
  if(!v) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('doubleValue' in v) return v.doubleValue;
  if('booleanValue' in v) return v.booleanValue;
  if('timestampValue' in v) return v.timestampValue;
  if('nullValue' in v) return null;
  if('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if('mapValue' in v){ const o = {}, f = v.mapValue.fields || {}; for(const k of Object.keys(f)) o[k] = fromValue(f[k]); return o; }
  return null;
}
function toValue(x){
  if(x === null || x === undefined) return { nullValue: null };
  if(typeof x === 'string') return { stringValue: x };
  if(typeof x === 'boolean') return { booleanValue: x };
  if(typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if(Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  const fields = {};
  for(const k of Object.keys(x)) fields[k] = toValue(x[k]);
  return { mapValue: { fields } };
}
function docToObj(doc){
  const o = {}, f = doc.fields || {};
  for(const k of Object.keys(f)) o[k] = fromValue(f[k]);
  o.__id = String(doc.name || '').split('/').pop();
  return o;
}

/* ---------- Authentification Google (compte de service, signature RS256 avec Web Crypto) ---------- */
function b64url(input){
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = '';
  for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem){
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
async function signJwt(sa, nowSec){
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(header + '.' + claims));
  return header + '.' + claims + '.' + b64url(sig);
}
let tokenCache = null;   // le jeton vaut 1 h : on le garde tant que l'instance du Worker reste en vie

function makeApi(env, f){
  const sa = JSON.parse(env.SERVICE_ACCOUNT_JSON);
  const base = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents`;
  let used = 0;
  const call = async (url, opts)=>{
    if(++used > MAX_SUBREQUESTS) throw new Error('BUDGET');
    return f(url, opts);
  };
  const api = {
    get used(){ return used; },
    async token(){
      if(tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.value;
      const jwt = await signJwt(sa, Math.floor(Date.now() / 1000));
      const res = await call(sa.token_uri || 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
      });
      if(!res.ok) throw new Error('AUTH ' + res.status);
      const j = await res.json();
      tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
      return tokenCache.value;
    },
    async authed(url, opts){
      const t = await api.token();
      return call(url, { ...opts, headers: { ...(opts && opts.headers), Authorization: 'Bearer ' + t } });
    },
    async getDoc(path){
      const res = await api.authed(`${base}/${path}`, { method: 'GET' });
      if(res.status === 404) return null;
      if(!res.ok) throw new Error('GET ' + res.status);
      return docToObj(await res.json());
    },
    async patchDoc(path, data){
      const mask = Object.keys(data).map(k=> 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
      const fields = {};
      for(const k of Object.keys(data)) fields[k] = toValue(data[k]);
      const res = await api.authed(`${base}/${path}?${mask}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
      if(!res.ok) throw new Error('PATCH ' + res.status);
    },
    async query(structuredQuery){
      const res = await api.authed(`${base}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }) });
      if(!res.ok) throw new Error('QUERY ' + res.status);
      return (await res.json()).filter(r=> r.document).map(r=> docToObj(r.document));
    },
    async sendFcm(token, data){
      const res = await api.authed(`https://fcm.googleapis.com/v1/projects/${env.PROJECT_ID}/messages:send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, data, webpush: { headers: { TTL: '86400', Urgency: 'high' } } } })
      });
      if(res.ok) return 'ok';
      let err = {};
      try { err = (await res.json()).error || {}; } catch(e){}
      const code = ((err.details || []).find(d=> d.errorCode) || {}).errorCode;
      // on ne supprime un appareil que si Google dit clairement que son identifiant n'existe plus
      if(res.status === 404 || code === 'UNREGISTERED' || (err.status === 'INVALID_ARGUMENT' && /registration token/i.test(err.message || ''))) return 'dead';
      return 'error';
    }
  };
  return api;
}

/* ---------- Messages ---------- */
function clean(s, n){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
function buildData(n){
  return { title: clean(n.title, 120) || 'School Online', body: clean(n.body, 300), link: LINK_RE.test(n.link || '') ? n.link : '', tag: clean(n.tag, 80) };
}
function validTokens(state){
  return ((state && state.tokens) || []).filter(x=> x && typeof x.t === 'string' && x.t.length > 20 && x.t.length < 4096);
}
/* Envoie à tous les appareils de l'élève ; retourne les identifiants d'appareils à retirer */
async function sendToDevices(api, tokens, data){
  const dead = [];
  let sent = 0;
  for(const t of tokens){
    const r = await api.sendFcm(t.t, data);
    if(r === 'ok') sent++;
    else if(r === 'dead') dead.push(t.t);
  }
  return { sent, dead };
}
async function dropTokens(api, uid, state, dead){
  if(!dead.length) return;
  await api.patchDoc('pushState/' + uid, { tokens: validTokens(state).filter(t=> !dead.includes(t.t)) });
}

/* ---------- 1) Nouvelles notifications de l'application ---------- */
async function pushNotifications(api, summary){
  const cur = await api.getDoc('system/pushCursor');
  if(!cur || !cur.lastCreatedAt){
    await api.patchDoc('system/pushCursor', { lastCreatedAt: new Date(Date.now()).toISOString() });   // premier passage : on ne renvoie pas l'historique
    summary.initialized = true;
    return;
  }
  const docs = await api.query({
    from: [{ collectionId: 'notifications' }],
    where: { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: cur.lastCreatedAt } } },
    orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }],
    limit: MAX_NOTIFS_PER_RUN
  });
  const perUser = {}, seenTags = new Set();
  let lastDone = null;
  try {
    for(const n of docs){
      const uid = n.toUid;
      if(UID_RE.test(uid || '') && uid !== n.fromUid && n.read !== true){
        const tag = clean((n.type || 'n') + '_' + (n.refId || n.__id), 80);
        const key = uid + '|' + tag;
        perUser[uid] = (perUser[uid] || 0);
        if(!seenTags.has(key) && perUser[uid] < MAX_PUSH_PER_USER_PER_RUN){
          const state = await api.getDoc('pushState/' + uid);
          const tokens = validTokens(state);
          const prefs = (state && state.prefs) || {};
          const cat = clean(n.category, 20) || 'general';
          if(tokens.length && prefs[cat] !== false){
            seenTags.add(key); perUser[uid]++;
            const r = await sendToDevices(api, tokens, buildData({ ...n, tag }));
            summary.sent += r.sent;
            await dropTokens(api, uid, state, r.dead);
          } else summary.skipped++;
        } else summary.skipped++;
      } else summary.skipped++;
      lastDone = n.createdAt;
    }
  } finally {
    if(lastDone && lastDone !== cur.lastCreatedAt) await api.patchDoc('system/pushCursor', { lastCreatedAt: lastDone }).catch(()=>{});
  }
}

/* ---------- 2) Rappels programmés (séances, devoirs, évaluations) ---------- */
async function pushSchedules(api, summary){
  const now = Date.now();
  const docs = await api.query({
    from: [{ collectionId: 'pushState' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'nextAt' }, op: 'GREATER_THAN', value: { integerValue: '0' } } },
      { fieldFilter: { field: { fieldPath: 'nextAt' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(now) } } }
    ] } },
    orderBy: [{ field: { fieldPath: 'nextAt' }, direction: 'ASCENDING' }],
    limit: MAX_SCHEDULES_PER_RUN
  });
  for(const st of docs){
    const uid = st.__id;
    if(!UID_RE.test(uid)) continue;
    const events = Array.isArray(st.events) ? st.events.filter(e=> e && typeof e.id === 'string' && typeof e.at === 'number') : [];
    const sent = new Set(Array.isArray(st.sentIds) ? st.sentIds : []);
    const past = events.filter(e=> e.at <= now && !sent.has(e.id));
    const due = past.filter(e=> now - e.at <= STALE_EVENT_MS).slice(0, MAX_PUSH_PER_USER_PER_RUN);
    const prefs = st.prefs || {};
    const tokens = validTokens(st);
    let dead = [];
    if(tokens.length && prefs.reminders !== false){
      for(const e of due){
        const r = await sendToDevices(api, tokens, buildData({ title: e.title, body: e.body, link: e.link, tag: 'rappel_' + e.id }));
        summary.sent += r.sent; dead = dead.concat(r.dead);
        summary.reminders++;
      }
    } else summary.skipped += due.length;
    past.forEach(e=> sent.add(e.id));                           // envoyé, périmé ou désactivé : on n'y revient pas
    const upcoming = events.filter(e=> e.at > now && !sent.has(e.id)).map(e=> e.at);
    const patch = { sentIds: Array.from(sent).slice(-200), nextAt: upcoming.length ? Math.min.apply(null, upcoming) : 0 };
    if(dead.length) patch.tokens = tokens.filter(t=> !dead.includes(t.t));
    await api.patchDoc('pushState/' + uid, patch);
  }
}

async function run(env, f){
  const summary = { sent: 0, skipped: 0, reminders: 0, initialized: false, errors: [] };
  if(!env || !env.SERVICE_ACCOUNT_JSON || !env.PROJECT_ID){ summary.errors.push('CONFIG'); console.log(JSON.stringify(summary)); return summary; }
  let api;
  try { api = makeApi(env, f || fetch); } catch(e){ summary.errors.push('SERVICE_ACCOUNT_JSON invalide'); console.log(JSON.stringify(summary)); return summary; }
  for(const [name, part] of [['notifications', pushNotifications], ['rappels', pushSchedules]]){
    try { await part(api, summary); }
    catch(e){ summary.errors.push(name + ' : ' + (e && e.message ? e.message : e)); }   // une erreur sur une partie n'empêche pas l'autre
  }
  summary.subrequests = api.used;
  console.log(JSON.stringify(summary));
  return summary;
}

export default {
  async scheduled(event, env, ctx){ ctx.waitUntil(run(env)); },
  async fetch(){ return new Response('School Online : expéditeur de notifications en marche.', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
};
export { run, fromValue, toValue, signJwt, b64url, pemToDer, buildData };
