/* ===========================================================
   Dette — Service Worker
   -----------------------------------------------------------
   Permet l'installation sur l'écran d'accueil et un démarrage
   instantané même sans réseau.

   Règle d'or : on ne met JAMAIS en cache les échanges avec
   Supabase (authentification, offres, demandes, photos). Ces
   données doivent toujours être fraîches et personnelles.

   Après modification de la liste COQUILLE, incrémenter VERSION
   pour forcer la mise à jour chez les utilisateurs.
   =========================================================== */

const VERSION = 'dette-v2';
const CACHE_COQUILLE = VERSION + '-coquille';
const CACHE_EXTERNE = VERSION + '-externe';

// Fichiers de l'application, mis en cache dès l'installation.
const COQUILLE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './supabase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

/* ---------- Installation ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_COQUILLE)
      .then((cache) => cache.addAll(COQUILLE))
      .then(() => self.skipWaiting())
  );
});

/* ---------- Activation : purge des anciennes versions ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- Interception des requêtes ---------- */

// Domaines dont les réponses ne doivent jamais être mises en cache.
function estDonneeVivante(url) {
  return (
    url.hostname.endsWith('supabase.co') ||   // API, auth, photos
    url.hostname.endsWith('tile.openstreetmap.org') || // tuiles de carte
    url.hostname.endsWith('google.com') ||    // redirection OAuth
    url.hostname.endsWith('googleusercontent.com') // avatars
  );
}

self.addEventListener('fetch', (event) => {
  const requete = event.request;
  if (requete.method !== 'GET') return;

  const url = new URL(requete.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (estDonneeVivante(url)) return; // laisse passer vers le réseau

  // Navigation : réseau d'abord, cache en secours (mode hors ligne)
  if (requete.mode === 'navigate') {
    event.respondWith(
      fetch(requete)
        .then((reponse) => {
          const copie = reponse.clone();
          caches.open(CACHE_COQUILLE).then((c) => c.put('./index.html', copie));
          return reponse;
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Fichiers de l'application : réseau d'abord, cache en secours.
  // (Cache d'abord serait plus rapide, mais servirait une version périmée
  //  après chaque « npm run build » — piège classique en développement.)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(requete)
        .then((reponse) => {
          if (reponse.ok) {
            const copie = reponse.clone();
            caches.open(CACHE_COQUILLE).then((c) => c.put(requete, copie));
          }
          return reponse;
        })
        .catch(() => caches.match(requete))
    );
    return;
  }

  // Librairies externes (Leaflet, supabase-js, police Inter) :
  // on sert le cache immédiatement et on rafraîchit en arrière-plan.
  event.respondWith(
    caches.open(CACHE_EXTERNE).then((cache) =>
      cache.match(requete).then((enCache) => {
        const reseau = fetch(requete)
          .then((reponse) => {
            if (reponse.ok || reponse.type === 'opaque') cache.put(requete, reponse.clone());
            return reponse;
          })
          .catch(() => enCache);
        return enCache || reseau;
      })
    )
  );
});

/* ---------- Mise à jour immédiate sur demande de la page ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
