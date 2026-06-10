// ============================================================================
// lib/join-url.js
// URL « Rejoindre » affichée sur l'écran :
// - localhost (dev)  → IP LAN pour les téléphones (NEXT_PUBLIC_DEV_JOIN_URL)
// - production / LAN → origine courante + /player
// ============================================================================

const DEFAULT_DEV_LAN =
  process.env.NEXT_PUBLIC_DEV_JOIN_URL || "http://192.168.1.118:3000/player";

function isLocalhost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Résout l'URL /player à afficher sur le panneau « Rejoindre ».
 * @param {Location|null|undefined} location — window.location côté client
 */
export function resolvePlayerJoinUrl(location) {
  if (location && location.hostname) {
    if (isLocalhost(location.hostname)) {
      return DEFAULT_DEV_LAN;
    }
    const origin = location.origin || `${location.protocol}//${location.host}`;
    return `${origin.replace(/\/$/, "")}/player`;
  }

  // Build / SSR (Vercel injecte VERCEL_URL)
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site) {
    return `${site.replace(/\/$/, "")}/player`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/player`;
  }
  return DEFAULT_DEV_LAN;
}

/** QR dynamique aligné sur l'URL joueur (dev ou prod). */
export function getJoinQrImageUrl(playerJoinUrl) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(playerJoinUrl)}`;
}
