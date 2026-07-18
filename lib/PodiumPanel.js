// ============================================================================

// lib/PodiumPanel.js — Podium central (fins de manche / quiz), distinct du classement latéral

// ============================================================================



import { BRAND, FONT_FAMILY, cardStyle, PAGE_TEXT } from "./brand-theme";

import { getTeamRowTint, getTeamBadgeStyle, getPlayerRowTint } from "./team-color";

import PlayerRankCircle, { tierToPlayerRank } from "./player-rank-circle";



const TIER_META = {

  gold: { medalTeams: "🥇", label: "Or" },

  silver: { medalTeams: "🥈", label: "Argent" },

  bronze: { medalTeams: "🥉", label: "Bronze" },

};



function buildRows(podium, view, scoreKey) {

  const safe = podium || { gold: [], silver: [], bronze: [] };

  const rows = [];

  for (const tier of ["gold", "silver", "bronze"]) {

    const meta = TIER_META[tier];

    const medal = meta.medalTeams;

    for (const entry of safe[tier] || []) {

      rows.push({

        id: entry.id,

        name: entry.name || "(sans nom)",

        score: entry[scoreKey] ?? entry.score ?? 0,

        tier,

        medal,

        playerRank: tierToPlayerRank(tier),

        teamColor: entry.color || entry.teamColor || null,

      });

    }

  }

  return rows;

}



const SIZE_STYLES = {

  lg: { baseFont: 17, width: "min(560px, 94%)", pad: "12px 14px", medal: 28, medalCol: 48 },

  md: { baseFont: 15, width: "min(560px, 94%)", pad: "12px 14px", medal: 28, medalCol: 48 },

  screen: { baseFont: 18, width: "min(460px, 82%)", pad: "12px 14px", medal: 40, medalCol: 62 },

};

/** Équipe sans couleur — emprise identique, trait invisible */
const NEUTRAL_ROW_TINT = {
  background: cardStyle.background,
  borderLeft: "12px solid transparent",
};



export default function PodiumPanel({

  podium,

  view = "teams",

  scoreKey = "score",

  size = "md",

  emptyMessage = "Aucun point n'a été marqué.",

}) {

  const rows = buildRows(podium, view, scoreKey);

  const sz = SIZE_STYLES[size] || SIZE_STYLES.md;

  const { baseFont, width, pad, medal, medalCol } = sz;



  if (rows.length === 0) {

    return (

      <div style={{ opacity: 0.9, fontSize: baseFont, marginTop: 8, color: PAGE_TEXT }}>

        {emptyMessage}

      </div>

    );

  }



  return (

    <div

      style={{

        ...cardStyle,

        width,

        maxWidth: "100%",

        margin: "8px auto 0",

        padding: 0,

        overflow: "hidden",

        textAlign: "left",

        fontFamily: FONT_FAMILY,

      }}

    >

      {rows.map((row, idx) => {

        const fontSize = baseFont;

        const rowTint =

          view === "teams" && row.teamColor

            ? getTeamRowTint(row.teamColor)

            : view === "players"

              ? getPlayerRowTint()

              : NEUTRAL_ROW_TINT;

        const nameColor =

          view === "teams" && row.teamColor

            ? getTeamBadgeStyle(row.teamColor).color

            : BRAND.mauveDark;

        const iconSlotStyle = {

          width: medalCol,

          minWidth: medalCol,

          height: medalCol,

          minHeight: medalCol,

          display: "flex",

          alignItems: "center",

          justifyContent: "center",

          flexShrink: 0,

        };



        return (

          <div

            key={`${row.id}-${row.tier}-${idx}`}

            style={{

              display: "grid",

              gridTemplateColumns: `${medalCol}px 1fr auto`,

              gap: 8,

              alignItems: "center",

              padding: pad,

              minHeight: medalCol + 24,

              boxSizing: "border-box",

              borderBottom:

                idx < rows.length - 1 ? `1px solid rgba(93, 24, 60, 0.2)` : "none",

              color: BRAND.mauveDark,

              ...rowTint,

            }}

          >

            <span style={iconSlotStyle}>

              {view === "teams" ? (

                <span style={{ fontSize: medal, lineHeight: 1 }} aria-hidden="true">{row.medal}</span>

              ) : (

                <PlayerRankCircle rank={row.playerRank} size={medal} />

              )}

            </span>

            <span

              style={{

                fontWeight: 800,

                fontSize,

                overflow: "hidden",

                textOverflow: "ellipsis",

                whiteSpace: "nowrap",

                color: nameColor,

              }}

              title={row.name}

            >

              {row.name}

            </span>

            <span

              style={{

                fontWeight: 800,

                fontSize,

                fontVariantNumeric: "tabular-nums",

                textAlign: "right",

              }}

            >

              {row.score}

            </span>

          </div>

        );

      })}

    </div>

  );

}


