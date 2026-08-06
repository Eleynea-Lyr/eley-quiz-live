// ============================================================================
// lib/player-rank-circle.js — Médailles or / argent / bronze (podium joueurs)
// ============================================================================

export const PLAYER_RANK_MEDAL = {
  1: "🥇",
  2: "🥈",
  3: "🥉",
};

/** @deprecated alias — couleurs historiques des pastilles */
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

export function medalEmojiForRank(rank) {
  return PLAYER_RANK_MEDAL[rank] || "";
}

/** Médaille emoji selon le rang (1–3). Conservé sous ce nom pour les imports existants. */
export default function PlayerRankCircle({ rank, size = 13, style = {} }) {
  const medal = PLAYER_RANK_MEDAL[rank];
  if (!medal) return null;
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0,
        display: "inline-block",
        fontSize: size,
        lineHeight: 1,
        ...style,
      }}
    >
      {medal}
    </span>
  );
}
