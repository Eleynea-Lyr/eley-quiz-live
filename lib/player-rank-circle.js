// ============================================================================
// lib/player-rank-circle.js — Ronds or / argent / bronze (podium joueurs)
// ============================================================================

export const PLAYER_RANK_CIRCLE = {
  1: "#e8c547",
  2: "#b8bec8",
  3: "#c9844a",
};

export function tierToPlayerRank(tier) {
  if (tier === "gold") return 1;
  if (tier === "silver") return 2;
  if (tier === "bronze") return 3;
  return null;
}

export default function PlayerRankCircle({ rank, size = 13 }) {
  const fill = PLAYER_RANK_CIRCLE[rank];
  if (!fill) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block" }}
    >
      <circle
        cx="6"
        cy="6"
        r="5.2"
        fill={fill}
        stroke="rgba(13, 5, 37, 0.22)"
        strokeWidth="0.6"
      />
    </svg>
  );
}
