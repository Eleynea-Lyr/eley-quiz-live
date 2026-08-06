// ============================================================================
// lib/team-color.js — Teinte claire à partir de la couleur d'équipe
// ============================================================================

import { BRAND, BRAND_PAGE_BOTTOM } from "./brand-theme";

function parseHex(hex) {
  if (!hex || typeof hex !== "string") return null;
  const h = hex.replace("#", "").trim();
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function mix(hexA, hexB, amountB) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  if (!a || !b) return hexA || hexB || BRAND.mauveDark;
  const t = Math.max(0, Math.min(1, amountB));
  return toHex(
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  );
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Fond teinté + texte lisible pour le badge équipe */
export function getTeamBadgeStyle(teamColor) {
  const base = teamColor || BRAND.mauveDark;
  const rgb = parseHex(base);
  const bg = mix(base, "#ffffff", 0.7);
  const border = mix(base, BRAND.mauveDark, rgb && luminance(rgb) > 0.72 ? 0.35 : 0.15);
  const baseText =
    rgb && luminance(rgb) > 0.55
      ? mix(base, BRAND.mauveDark, 0.45)
      : base;
  const text = mix(baseText, BRAND.mauveDark, 0.12);

  return {
    background: bg,
    border: `2px solid ${border}`,
    color: text,
  };
}

/** Teinte très légère pour une ligne de podium */
export function getTeamRowTint(teamColor) {
  const base = teamColor || BRAND.mauveDark;
  return {
    background: mix(base, "#ffffff", 0.82),
    borderLeft: `12px solid ${base}`,
  };
}

/** Disque façon pastille info (i) + liséré équipe */
export function getTeamTrophyDiscStyle(teamColor) {
  const rim = teamColor || BRAND.mauveDark;
  return {
    // Même teinte que la pastille du bouton (i) : crème légère sur le violet page
    background: mix(BRAND_PAGE_BOTTOM, "#fffbf5", 0.22),
    border: `1.5px solid ${rim}`,
  };
}

/** Trait gauche podium joueur — gris clair (distinct du texte mauveDark) */
const PLAYER_PODIUM_STRIPE = "#9aa3b2";

/** Teinte neutre pour une ligne podium joueur */
export function getPlayerRowTint() {
  return {
    background: mix(PLAYER_PODIUM_STRIPE, "#ffffff", 0.88),
    borderLeft: `12px solid ${PLAYER_PODIUM_STRIPE}`,
  };
}
