/* School Online — service worker
 * Rôle : ouvrir l'application même avec une connexion lente ou coupée, sans jamais servir de données privées.
 * - Page principale : réseau d'abord (toujours la dernière version), copie en cache si le réseau est lent (> 3 s) ou absent.
 * - Images et fichiers du site : copie en cache immédiate, mise à jour en arrière-plan.
 * - Bibliothèques externes connues (Firebase, Chart.js, Lucide, polices) : mises en cache pour le hors-ligne.
 * - JAMAIS mis en cache : Firestore, authentification, reCAPTCHA / App Check, IA (Puter), requêtes autres que GET.
 * - Notifications push : réception des messages Firebase Cloud Messaging et ouverture de l'application au toucher.
 * Pour forcer un nettoyage complet après une évolution de ce fichier, change CACHE_VERSION.
 */
const CACHE_VERSION = 'v2';
const SHELL_CACHE = 'so-shell-' + CACHE_VERSION;
const STATIC_CACHE = 'so-static-' + CACHE_VERSION;
const CDN_CACHE = 'so-cdn-' + CACHE_VERSION;
const KEEP_CACHES = [SHELL_CACHE, STATIC_CACHE, CDN_CACHE];
const NAV_TIMEOUT_MS = 3000;
const STATIC_MAX_ENTRIES = 80;

const SCOPE = self.registration.scope;                      // ex. https://mon-site.vercel.app/
const SCOPE_PATH = new URL(SCOPE).pathname;                 // ex. /
const SHELL_URL = new URL('index.html', SCOPE).href;

const PRECACHE_SAME_ORIGIN = ['manifest.json', 'favicon.png', 'logo.png', 'icons/icon-192.png'];
const PRECACHE_CDN = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.js'
];

const OFFLINE_HTML = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Hors connexion</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;text-align:center;padding:24px}' +
  'h1{font-size:20px;margin:0 0 8px}p{color:#64748b;margin:0 0 20px;line-height:1.5}button{background:#1a9640;color:#fff;border:0;border-radius:12px;padding:14px 22px;font-size:15px;font-weight:700}' +
  '@media(prefers-color-scheme:dark){body{background:#0b1220;color:#f1f5f9}p{color:#94a3b8}}</style></head><body><div><h1>Tu es hors connexion</h1>' +
  '<p>School Online n\'a pas encore pu être enregistré sur ton téléphone.<br>Reconnecte-toi à internet une première fois, puis réessaie.</p>' +
  '<button onclick="location.reload()">Réessayer</button></div></body></html>';

/* ---------- Utilitaires ---------- */
function sleep(ms){ return new Promise(resolve=> setTimeout(resolve, ms)); }
function fetchCors(url){ return fetch(url, { mode: 'cors', credentials: 'omit' }); }
function signature(res){
  if(!res || !res.headers) return null;
  return res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length') || null;
}
function isShellPath(pathname){ return pathname === SCOPE_PATH || pathname === SCOPE_PATH + 'index.html'; }
function isStaticAsset(pathname){ return /\.(png|jpe?g|webp|gif|svg|ico|json|woff2?)$/i.test(pathname); }
function cdnRule(url){
  const h = url.hostname, p = url.pathname;
  if(h === 'www.gstatic.com') return p.indexOf('/firebasejs/') === 0 ? 'immutable' : null;   // jamais gstatic/recaptcha
  if(h === 'fonts.gstatic.com') return 'immutable';
  if(h === 'fonts.googleapis.com') return 'swr';
  if(h === 'cdn.jsdelivr.net') return /@\d+\.\d+\.\d+/.test(p) ? 'immutable' : 'swr';
  if(h === 'unpkg.com') return /@\d+\.\d+\.\d+\//.test(p) ? 'immutable' : 'swr';           // lucide@latest => mise à jour en arrière-plan
  return null;                                                                                // tout le reste : aucun cache
}
async function notifyClients(){
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c=> c.postMessage({ type: 'SO_UPDATE_AVAILABLE' }));
}
async function trim(cacheName, max){
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for(let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}


/* ---------- Notifications push (Firebase Cloud Messaging) ----------
 * Les messages envoyés par le Worker sont des messages « données seules » : c'est ce fichier qui affiche la notification.
 * La configuration Firebase ci-dessous est publique (la même que dans index.html) ; elle ne donne aucun droit d'écriture.
 * Si le chargement échoue (hors ligne à la toute première installation), le reste du service worker fonctionne normalement. */
const FIREBASE_PUBLIC_CONFIG = {
  apiKey: "AIzaSyB7ri8515Mbp6bmvcZ9vO5MHAtYDg64rdk",
  authDomain: "schoolonline-42025.firebaseapp.com",
  projectId: "schoolonline-42025",
  storageBucket: "schoolonline-42025.firebasestorage.app",
  messagingSenderId: "56095642715",
  appId: "1:56095642715:web:b535fe51bfd6f3e2c35b7e"
};
try {
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
  firebase.initializeApp(FIREBASE_PUBLIC_CONFIG);
  firebase.messaging().onBackgroundMessage(payload=>{
    const d = (payload && payload.data) || {};
    const link = /^(page|forum):[A-Za-z0-9_-]{1,100}$/.test(d.link || '') ? d.link : '';
    return self.registration.showNotification(String(d.title || 'School Online').slice(0, 120), {
      body: String(d.body || '').slice(0, 300),
      icon: new URL('icons/icon-192.png', SCOPE).href,
      tag: d.tag ? String(d.tag).slice(0, 80) : undefined,      // même sujet = une seule notification qui se met à jour
      lang: 'fr',
      data: { link }
    });
  });
} catch(e){ /* push indisponible : sans conséquence pour le hors-ligne */ }

/* Toucher la notification : on ouvre (ou on ramène devant) l'application, sur le bon écran */
self.addEventListener('notificationclick', event=>{
  const link = (event.notification && event.notification.data && event.notification.data.link) || '';
  if(!link && !(event.notification && event.notification.tag)) return;   // pas une notification de School Online
  event.notification.close();
  event.waitUntil((async()=>{
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = list.find(c=> c.url.indexOf(SCOPE) === 0);
    if(target){
      try { await target.focus(); } catch(e){}
      target.postMessage({ type: 'SO_OPEN', link });
      return;
    }
    await self.clients.openWindow(SCOPE + (link ? '?open=' + encodeURIComponent(link) : ''));
  })());
});

/* ---------- Installation / activation ---------- */
self.addEventListener('install', event=>{
  event.waitUntil((async()=>{
    // chaque ressource est facultative : un fichier absent ne doit jamais empêcher l'installation
    try {
      const res = await fetch(new Request(SCOPE, { cache: 'reload' }));
      if(res.ok) await (await caches.open(SHELL_CACHE)).put(SHELL_URL, res);
    } catch(e){}
    const st = await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE_SAME_ORIGIN.map(p=> st.add(new Request(new URL(p, SCOPE).href, { cache: 'reload' })).catch(()=>{})));
    const cdn = await caches.open(CDN_CACHE);
    await Promise.all(PRECACHE_CDN.map(u=> fetchCors(u).then(r=>{ if(r.ok) return cdn.put(u, r); }).catch(()=>{})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event=>{
  event.waitUntil((async()=>{
    const names = await caches.keys();
    await Promise.all(names.filter(n=> n.indexOf('so-') === 0 && !KEEP_CACHES.includes(n)).map(n=> caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ---------- Stratégies ---------- */
async function handleNavigation(event){
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_URL);
  const oldSig = signature(cached);
  const network = (async()=>{
    const res = await fetch(event.request);
    if(res.type === 'opaqueredirect') return res;
    if(res.ok) await cache.put(SHELL_URL, res.clone());
    return res;
  })();
  event.waitUntil(network.catch(()=>{}));                      // laisse la mise à jour du cache se terminer

  if(!cached){
    try { return await network; }
    catch(e){ return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
  }
  const winner = await Promise.race([
    network.then(r=>({ r, from: 'net' }), ()=>({ r: null, from: 'err' })),
    sleep(NAV_TIMEOUT_MS).then(()=>({ r: null, from: 'timeout' }))
  ]);
  if(winner.r && (winner.r.ok || winner.r.type === 'opaqueredirect')) return winner.r;   // réseau assez rapide : version la plus récente
  if(winner.from === 'timeout'){
    // réseau lent : on ouvre tout de suite la copie, puis on prévient la page si une version plus récente est arrivée
    network.then(r=>{ const s = signature(r); if(r.ok && s && oldSig && s !== oldSig) return notifyClients(); }).catch(()=>{});
  }
  return cached;
}
async function staleWhileRevalidate(event, cacheName, request){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const update = fetch(request).then(async res=>{
    if(res.ok){ await cache.put(request, res.clone()); if(cacheName === STATIC_CACHE) await trim(cacheName, STATIC_MAX_ENTRIES); }
    return res;
  }).catch(()=> null);
  event.waitUntil(update);
  if(cached) return cached;
  return (await update) || Response.error();
}
async function cdnCacheFirst(request){
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request.url);
  if(cached) return cached;
  try {
    const res = await fetchCors(request.url);                  // en mode "cors" on peut vérifier que la réponse est bonne avant de la garder
    if(res.ok){ await cache.put(request.url, res.clone()); return res; }
  } catch(e){}
  return fetch(request);
}
async function cdnSwr(event, request){
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request.url);
  const update = fetchCors(request.url).then(async res=>{ if(res.ok){ await cache.put(request.url, res.clone()); return res; } return null; }).catch(()=> null);
  event.waitUntil(update);
  if(cached) return cached;
  return (await update) || fetch(request);
}

self.addEventListener('fetch', event=>{
  const req = event.request;
  if(req.method !== 'GET') return;                              // écritures : jamais interceptées
  const url = new URL(req.url);
  if(req.mode === 'navigate'){
    if(url.origin === self.location.origin && isShellPath(url.pathname)) event.respondWith(handleNavigation(event));
    return;
  }
  if(url.origin === self.location.origin){
    if(/\/sw\.js$/.test(url.pathname)) return;
    if(isStaticAsset(url.pathname)) event.respondWith(staleWhileRevalidate(event, STATIC_CACHE, req));
    return;
  }
  const rule = cdnRule(url);
  if(rule === 'immutable') event.respondWith(cdnCacheFirst(req));
  else if(rule === 'swr') event.respondWith(cdnSwr(event, req));
  // Firestore, Auth, App Check, reCAPTCHA, Puter (IA)... : on ne s'en occupe pas, la requête part normalement
});
