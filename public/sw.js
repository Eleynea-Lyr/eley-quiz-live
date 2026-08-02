/*
 * Service worker minimaliste pour la PWA "Quiz d'Eley".
 *
 * Stratégie : NETWORK-FIRST, et UNIQUEMENT pour les requêtes GET de même origine.
 * - On ne touche JAMAIS aux requêtes cross-origin (Firebase / Firestore / Storage)
 *   ni aux requêtes non-GET : elles passent directement au réseau, intactes.
 * - On privilégie toujours le réseau (donc pas de contenu périmé en live).
 * - Le cache ne sert que de filet de secours si le réseau est indisponible.
 */

const CACHE = "eley-quiz-shell-v2";

self.addEventListener("install", () => {
  // Activer immédiatement la nouvelle version du SW
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Nettoyer les anciens caches lors d'une mise à jour
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Ignorer tout ce qui n'est pas un GET de même origine
  // (laisse passer Firebase, websockets, POST, etc. sans intervention)
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        // Mettre à jour la copie de secours en arrière-plan
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          const copy = fresh.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return fresh;
      } catch {
        // Réseau indisponible → filet de secours depuis le cache
        const cached = await caches.match(req);
        if (cached) return cached;
        throw new Error("Network error and no cache available");
      }
    })()
  );
});
