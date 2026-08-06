// ============================================================================
// lib/PlayerScorePanel.js — Récap perso (fin de manche / quiz) sur Player
// ============================================================================

import { BRAND, FONT_FAMILY, cardStyle, textSecondary } from "./brand-theme";
import { getTeamBadgeStyle } from "./team-color";
import TeamTrophyIcon from "./TeamTrophyIcon";

function rankLabel(rank) {
  if (rank == null) return null;
  if (rank === 1) return "1ère place";
  if (rank === 2) return "2ème place";
  if (rank === 3) return "3ème place";
  return `${rank}ème place`;
}

export default function PlayerScorePanel({
  teamName,
  teamColor,
  teamScore,
  teamRank,
  teamMedal: _teamMedal,
  playerName,
  playerScore,
  buzzScore = 0,
  showBuzz = true,
  showTeam = true,
}) {
  const teamStyle = getTeamBadgeStyle(teamColor);
  const rankText = rankLabel(teamRank);
  const showTrophy = Number(teamScore) > 0 && teamRank >= 1 && teamRank <= 3;

  const panelWidth = {
    width: "min(var(--eley-content-score), 92%)",
    maxWidth: "100%",
    marginLeft: "auto",
    marginRight: "auto",
    fontFamily: FONT_FAMILY,
    textAlign: "left",
  };

  return (
    <div
      style={{
        ...panelWidth,
        marginTop: 16,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {showTeam && teamName && (
        <div
          style={{
            ...cardStyle,
            padding: "var(--eley-card-pad-y) var(--eley-card-pad-x)",
            ...teamStyle,
          }}
        >
          <div style={{ fontSize: "var(--eley-text-label-sm)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, opacity: 0.85 }}>
            Équipe
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              fontWeight: 700,
              fontSize: "var(--eley-text-hint)",
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
              }}
            >
              {showTrophy ? <TeamTrophyIcon rank={teamRank} size={18} /> : <span aria-hidden="true">⭐</span>}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{teamName}</span>
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              <b>{teamScore ?? 0}</b> pts
            </span>
          </div>
          {rankText && (
            <div style={{ fontSize: "var(--eley-text-caption)", marginTop: 6, fontWeight: 600 }}>{rankText}</div>
          )}
        </div>
      )}

      <div style={{ ...cardStyle, padding: "var(--eley-card-pad-y) var(--eley-card-pad-x)", color: BRAND.mauveDark }}>
        <div style={{ fontSize: "var(--eley-text-label-sm)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, ...textSecondary }}>
          Toi
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            fontSize: "var(--eley-text-hint)",
          }}
        >
          <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            👤 {playerName}
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, flexShrink: 0 }}>
            {playerScore ?? 0} pts
          </span>
        </div>
        {showBuzz && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 8,
              fontSize: "var(--eley-text-body-sm)",
            }}
          >
            <span style={{ fontWeight: 600 }}>⚡ Buzz</span>
            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, color: BRAND.mauveDark }}>
              {buzzScore ?? 0} pts
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
