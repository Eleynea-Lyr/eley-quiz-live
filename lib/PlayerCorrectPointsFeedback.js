// ============================================================================
// lib/PlayerCorrectPointsFeedback.js — Points gagnés (équipe + joueur) après bonne réponse
// ============================================================================

import { BRAND, PAGE_TEXT } from "./brand-theme";
import { getTeamBadgeStyle } from "./team-color";
import PlayerRankCircle from "./player-rank-circle";
import TeamTrophyIcon from "./TeamTrophyIcon";

function TeamStarIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path
        fill={BRAND.orangeLight}
        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
      />
    </svg>
  );
}

function PlayerHeadIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path
        fill={BRAND.yellow}
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      />
    </svg>
  );
}

export default function PlayerCorrectPointsFeedback({
  teamName,
  teamColor,
  teamPoints,
  teamRank,
  playerPoints,
  playerRank,
  playerScoredPrefix = "Tu marques",
  pointLabel = "point",
  pointsLabel = "points",
  showTeamBlock = true,
}) {
  const teamStyle = getTeamBadgeStyle(teamColor);
  const playerPtsLabel = playerPoints > 1 ? pointsLabel : pointLabel;
  const teamPtsLabel = teamPoints > 1 ? pointsLabel : pointLabel;
  const showTeam =
    showTeamBlock && teamName && Number.isFinite(teamPoints) && teamPoints > 0;

  return (
    <div
      style={{
        marginTop: 14,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 22,
      }}
    >
      {showTeam && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 10,
            fontSize: "var(--eley-text-body-sm)",
            fontWeight: 700,
            ...teamStyle,
          }}
        >
          <TeamStarIcon />
          <span>{teamName}</span>
          <span>
            +{teamPoints} {teamPtsLabel}
          </span>
          {teamRank >= 1 && teamRank <= 3 ? (
            <TeamTrophyIcon rank={teamRank} size={16} />
          ) : null}
        </div>
      )}

      {Number.isFinite(playerPoints) && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: "var(--eley-text-body-sm)",
            fontWeight: 600,
            color: PAGE_TEXT,
          }}
        >
          <PlayerHeadIcon />
          <span>
            {playerScoredPrefix} {playerPoints} {playerPtsLabel}
          </span>
          {playerRank >= 1 && playerRank <= 3 ? (
            <PlayerRankCircle rank={playerRank} size={13} />
          ) : null}
        </div>
      )}
    </div>
  );
}
