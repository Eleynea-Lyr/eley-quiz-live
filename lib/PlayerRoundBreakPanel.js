// ============================================================================

// lib/PlayerRoundBreakPanel.js — Fin de manche / fin de quiz : podium compact + ta place

// ============================================================================



import { BRAND, BRAND_PAGE_BOTTOM, FONT_FAMILY, PAGE_TEXT_MUTED } from "./brand-theme";
import { getTeamBadgeStyle } from "./team-color";
import PlayerRankCircle from "./player-rank-circle";
import TeamTrophyIcon from "./TeamTrophyIcon";



const SECTION_GAP = "var(--eley-section-gap-md)";

const PLAYERS_SECTION_GAP = "var(--eley-section-gap-lg)";



/** Rang en phrase — équipe (féminin) */

function teamRankInSentence(rank) {

  if (rank == null) return null;

  if (rank === 1) return "1ère";

  if (rank === 2) return "2ème";

  if (rank === 3) return "3ème";

  return `${rank}ème`;

}



/** Rang en phrase — joueur */

function playerRankInSentence(rank) {

  if (rank == null) return null;

  if (rank === 1) return "1er";

  if (rank === 2) return "2ème";

  if (rank === 3) return "3ème";

  return `${rank}ème`;

}



function TeamStarIcon({ size = "var(--eley-icon-inline)" }) {

  return (

    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>

      <path

        fill={BRAND.orangeLight}

        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"

      />

    </svg>

  );

}



function PlayerHeadIcon({ size = "var(--eley-icon-inline)" }) {

  return (

    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>

      <path

        fill={BRAND.yellow}

        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"

      />

    </svg>

  );

}



function podiumRows(rankedRows, scoreKey) {

  return (rankedRows || [])

    .filter((row) => row._rank <= 3 && Number(row[scoreKey] ?? row.score ?? 0) > 0)

    .map((row) => ({

      id: row.id,

      rank: row._rank,

      name: row.name || "(sans nom)",

      score: Number(row[scoreKey] ?? row.score ?? 0),

      color: row.color || null,

    }));

}



function TeamPodiumList({ rows }) {

  if (!rows.length) {

    return (

      <div style={{ fontSize: "var(--eley-text-caption)", opacity: 0.75, marginTop: 6, textAlign: "left" }}>

        Aucun point pour l&apos;instant.

      </div>

    );

  }



  return (

    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>

      {rows.map((row) => {

        const teamStyle = getTeamBadgeStyle(row.color);

        return (

          <div

            key={`${row.id}-${row.rank}`}

            style={{

              display: "flex",

              alignItems: "center",

              gap: 10,

              fontSize: "var(--eley-text-body-sm)",

              fontWeight: 600,

            }}

          >

            <div

              style={{

                display: "inline-flex",

                alignItems: "center",

                gap: 6,

                flex: 1,

                minWidth: 0,

                padding: "5px 10px",

                borderRadius: 10,

                ...teamStyle,

              }}

            >

              <span style={{ flexShrink: 0, lineHeight: 1 }} aria-hidden="true">
                <TeamTrophyIcon rank={row.rank} size={16} teamColor={row.color} />
              </span>

              <span

                style={{

                  minWidth: 0,

                  overflow: "hidden",

                  textOverflow: "ellipsis",

                  whiteSpace: "nowrap",

                }}

              >

                {row.name}

              </span>

            </div>

            <span

              style={{

                flexShrink: 0,

                fontVariantNumeric: "tabular-nums",

                color: PAGE_TEXT_MUTED,

                opacity: 0.92,

              }}

            >

              {row.score} pts

            </span>

          </div>

        );

      })}

    </div>

  );

}



function PlayerPodiumList({ rows }) {

  if (!rows.length) {

    return (

      <div style={{ fontSize: "var(--eley-text-caption)", opacity: 0.75, marginTop: 6, textAlign: "left" }}>

        Aucun point pour l&apos;instant.

      </div>

    );

  }



  return (

    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>

      {rows.map((row) => (

        <div

          key={`${row.id}-${row.rank}`}

          style={{

            display: "flex",

            alignItems: "center",

            gap: 8,

            fontSize: "var(--eley-text-body-sm)",

            fontWeight: 600,

            color: PAGE_TEXT_MUTED,

          }}

        >

          <PlayerRankCircle rank={row.rank} />

          <span

            style={{

              flex: 1,

              minWidth: 0,

              overflow: "hidden",

              textOverflow: "ellipsis",

              whiteSpace: "nowrap",

              textAlign: "left",

            }}

          >

            {row.name}

          </span>

          <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", opacity: 0.92 }}>

            {row.score} pts

          </span>

        </div>

      ))}

    </div>

  );

}



const summaryStyle = {

  marginTop: 12,

  fontSize: "var(--eley-text-summary)",

  fontWeight: 600,

  lineHeight: 1.45,

  color: "#ffffff",

  textAlign: "left",

  opacity: 0.92,

};



const summaryHighlightStyle = {

  color: BRAND.yellow,

  fontWeight: 700,

};



function PointsHighlight({ score }) {

  const pts = Number(score ?? 0);

  const suffix = pts > 1 ? " points" : " point";

  return (

    <>

      <span style={summaryHighlightStyle}>{pts}</span>

      {suffix}

    </>

  );

}



function MyTeamSummary({ rank, score }) {

  const rankWord = teamRankInSentence(rank);

  if (!rankWord) return null;

  return (

    <p style={summaryStyle}>

      Ton équipe est <span style={summaryHighlightStyle}>{rankWord}</span> avec <PointsHighlight score={score} />.

    </p>

  );

}



function MyPlayerSummary({ rank, score, nothingDecidedText }) {

  const rankWord = playerRankInSentence(rank);

  if (!rankWord) return null;

  return (

    <p style={summaryStyle}>

      Tu es <span style={summaryHighlightStyle}>{rankWord}</span> avec <PointsHighlight score={score} />.

      {nothingDecidedText ? (

        <>

          <br />

          {nothingDecidedText}

        </>

      ) : null}

    </p>

  );

}



const sectionTitleStyle = {

  fontSize: "var(--eley-text-section)",

  fontWeight: 700,

  opacity: 0.88,

  textAlign: "left",

  display: "inline-flex",

  alignItems: "center",

  gap: 7,

  flexWrap: "wrap",

  position: "relative",

  zIndex: 1,

};



const sectionTitleRuleStyle = {

  width: "100vw",

  marginLeft: "calc(50% - 50vw)",

  height: 3,

  marginTop: 10,

  marginBottom: 4,

  background: BRAND_PAGE_BOTTOM,

  border: "none",

  borderRadius: 0,

};



function SectionBlock({ title, titleIcon, children, summary, first = false, gapBefore = 18 }) {

  return (

    <div style={{ marginTop: first ? 0 : gapBefore }}>

      <div>

        <div aria-hidden="true" style={{ ...sectionTitleRuleStyle, marginTop: 0, marginBottom: 10 }} />

        <div style={sectionTitleStyle}>

          <span>{title}</span>

          {titleIcon}

        </div>

      </div>

      {children}

      {summary}

    </div>

  );

}



export default function PlayerRoundBreakPanel({

  teamsRanking,

  ranking,

  teamId,

  teamName,

  teamRank,

  teamScore,

  playerName,

  playerRank,

  playerScore,

  teamsSectionTitle = "Podium provisoire des équipes",

  playersSectionTitle = "Podium provisoire des joueurs",

  nothingDecidedText = "Mais rien n'est encore joué !",
  activeView = "both",
}) {
  const teamsPodium = podiumRows(teamsRanking, "score");
  const playersPodium = podiumRows(ranking, "score");

  const showTeams =
    activeView === "teams"
    || (activeView === "both" && teamId && teamName);
  const showPlayers =
    activeView === "players"
    || (activeView === "both" && playerName);

  return (

    <div

      style={{

        width: "min(var(--eley-content-narrow), 92%)",

        maxWidth: "100%",

        margin: "0 auto",

        paddingTop: 0,

        fontFamily: FONT_FAMILY,

        textAlign: "center",

      }}

    >

      {showTeams && (
        <SectionBlock
          first
          title={teamsSectionTitle}
          titleIcon={<TeamStarIcon size={15} />}
          summary={teamId && teamName ? <MyTeamSummary rank={teamRank} score={teamScore} /> : null}
        >
          <TeamPodiumList rows={teamsPodium} />
        </SectionBlock>
      )}

      {showPlayers && (
        <SectionBlock
          title={playersSectionTitle}
          titleIcon={<PlayerHeadIcon size={15} />}
          gapBefore={showTeams ? PLAYERS_SECTION_GAP : 0}
          first={!showTeams}
          summary={(

            <MyPlayerSummary

              rank={playerRank}

              score={playerScore}

              nothingDecidedText={nothingDecidedText}

            />

          )}

        >

          <PlayerPodiumList rows={playersPodium} />

        </SectionBlock>

      )}

    </div>

  );

}


