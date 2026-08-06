// ============================================================================
// lib/TeamTrophyIcon.js — Petites coupes SVG or / argent / bronze (podium équipes)
// ============================================================================

export const TEAM_TROPHY_COLORS = {
  1: { cup: "#f0d060", accent: "#d4a82e", base: "#c49a28" },
  2: { cup: "#d0d5de", accent: "#9aa3b2", base: "#868f9e" },
  3: { cup: "#e09a5c", accent: "#c4743a", base: "#a85f32" },
};

/** Petite coupe teintée selon le rang (1–3). */
export default function TeamTrophyIcon({ rank, size = 16, style = {} }) {
  const palette = TEAM_TROPHY_COLORS[rank];
  if (!palette) return null;
  const { cup, accent, base } = palette;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block", ...style }}
    >
      {/* Anses */}
      <path
        fill={accent}
        d="M5.2 4.2c-1.9.2-3.2 1.6-3.2 3.4 0 2.1 1.6 3.5 3.8 3.5h.7V9.6H5.8c-1.3 0-2.2-.8-2.2-2 0-1 .7-1.8 1.6-1.9V4.2z"
      />
      <path
        fill={accent}
        d="M18.8 4.2c1.9.2 3.2 1.6 3.2 3.4 0 2.1-1.6 3.5-3.8 3.5h-.7V9.6h.7c1.3 0 2.2-.8 2.2-2 0-1-.7-1.8-1.6-1.9V4.2z"
      />
      {/* Coupe */}
      <path
        fill={cup}
        d="M7 3.2h10v1.4c0 3.6-2.2 6.6-5 6.6s-5-3-5-6.6V3.2z"
      />
      {/* Reflet */}
      <path
        fill="rgba(255,255,255,0.28)"
        d="M8.2 4.2h1.6c0 2.4.7 4.4 1.8 5.4-.9-.4-1.6-1.4-2.1-2.8-.3-.9-.5-1.9-.5-2.6z"
      />
      {/* Nœud + pied */}
      <rect x="10.6" y="11" width="2.8" height="1.4" rx="0.5" fill={accent} />
      <rect x="11.1" y="12.2" width="1.8" height="4.6" rx="0.6" fill={accent} />
      {/* Socle */}
      <path fill={base} d="M8.4 18.4h7.2c.7 0 1.2.5 1.2 1.1v.9H7.2v-.9c0-.6.5-1.1 1.2-1.1z" />
      <rect x="6.8" y="20.2" width="10.4" height="1.6" rx="0.7" fill={base} />
    </svg>
  );
}
