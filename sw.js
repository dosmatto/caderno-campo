// sw.js — deixa o app abrir sem internet na lavoura (guarda as telas e as bibliotecas).
const CACHE = 'caderno-campo-v4';
const ARQUIVOS = [
  './', 'index.html', 'app.js', 'geo.js', 'nuvem.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// rede primeiro (pega versão nova quando tem sinal); sem sinal, usa o que está guardado
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // dados da nuvem (Supabase) nunca passam pelo cache: vão direto para a rede
  if (new URL(e.request.url).hostname.endsWith('.supabase.co')) return;
  e.respondWith(
    // no-cache: revalida com o servidor, para o celular pegar a versão nova assim que houver sinal
    fetch(e.request, { cache: 'no-cache' }).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
