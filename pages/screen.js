// ============================================================================
// /pages/screen.js — Refactoré avec imports depuis /lib
// Scope : Écran de scène/projection avec leaderboard temps réel
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/firebase";
import {
  collection, doc, getDocs, onSnapshot, query,
  where
} from "firebase/firestore";

// Imports depuis les fichiers utilitaires
import {
  REVEAL_DURATION_SEC,
  COUNTDOWN_START_SEC,
  ROUND_START_INTRO_SEC,
  ROUND_BOUNDARY_GAP_SEC,
  UI_MASK_MS,
  BAR_H,
  SCREEN_IMG_MAX,
  DEFAULT_LEADERBOARD_TOP_N,
  DEFAULT_SCORING_TABLE,
  BUZZER_STATES,
} from "../lib/constants";

import {
  getTimeSec,
  formatHMS,
  roundIndexOfTime,
  nextRoundStartAfter,
  normalizeNameAlpha,
  addSmartLineBreaks,
} from "../lib/utils";

import {
  useMobileVH,
  ensureAwardsForQuestionTx,
  getScoringTable,
} from "../lib/firebase-helpers";
import AuthGate from "../lib/AuthGate";

import {
  SCREEN_PAGE_ATTENTE,
  SCREEN_PAGE_QUIZ,
  SCREEN_PAGE_PODIUM,
  ELEYBUZZ_SCREEN_MESSAGES,
  mergePageMessages,
} from "../lib/messages";
import { isQcmQuestion, getQcmOptionsForDisplay } from "../lib/qcm";
import { resolvePlayerJoinUrl, getJoinQrImageUrl } from "../lib/join-url";
import {
  BRAND,
  FONT_FAMILY,
  PAGE_TEXT,
  BAR_BLUE,
  BAR_RED,
  HANDLE_COLOR,
  badgeSuccess,
  badgeError,
  cardStyle,
  questionTextStyle,
  pageTextSecondary,
  asidePanelStyle,
  podiumCardStyle,
  IMAGE_FRAME_BG,
} from "../lib/brand-theme";
import BrandShell from "../lib/BrandShell";
import PodiumPanel from "../lib/PodiumPanel";
import PlayerRankCircle from "../lib/player-rank-circle";
import TeamTrophyIcon from "../lib/TeamTrophyIcon";

// Colonne gauche (image générique)
const LEFT_GENERIC_IMG_SRC = "/Chibi_Eley.png";

const SCREEN_IMAGE_EDGE_LEFT = 0;
const SCREEN_IMAGE_EDGE_TOP = 0;
/** Même retrait bas que le logo WelcomeMark (bas droite) */
const SCREEN_CORNER_BOTTOM = "max(14px, env(safe-area-inset-bottom, 0px))";
const SCREEN_CORNER_LEFT = "max(14px, env(safe-area-inset-left, 0px))";
const SCREEN_QR_INSET = 9;

const SCREEN_SHELL_STYLE = {
  display: "flex",
  flexDirection: "row",
  position: "relative",
  isolation: "isolate",
  backgroundColor: "#000000",
};

const SCREEN_STAGE_WRAP = {
  marginTop: 8,
  marginBottom: 4,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
};

/** Titres fin de manche / quiz — alignés en haut de la colonne */
const SCREEN_TITLE_HEADER = {
  width: "100%",
  textAlign: "center",
  flexShrink: 0,
};

/** Podium + note de bas de page — centrés, légèrement remontés */
const SCREEN_PODIUM_CENTER = {
  ...SCREEN_STAGE_WRAP,
  flex: 1,
  justifyContent: "center",
  marginTop: 0,
  marginBottom: 0,
  width: "100%",
  minHeight: 0,
  paddingBottom: "var(--eley-podium-block-lift)",
};

/** Décale le podium vers la droite pour le centrer visuellement (moitié du panneau classement) */
const SCREEN_OPTICAL_SHIFT = "min(172px, 17vw)";

const SCREEN_MAIN_COLUMN = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  alignSelf: "stretch",
  position: "relative",
  zIndex: 2,
  padding: "40px 24px",
  fontFamily: FONT_FAMILY,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  textAlign: "center",
};

/** Bloc fin de manche / fin de quiz — titre en haut, podium centré */
function ScreenPodiumBlock({ opticalShift = false, title, children }) {
  return (
    <div
      style={{
        width: "100%",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minHeight: 0,
        transform: opticalShift ? `translateX(${SCREEN_OPTICAL_SHIFT})` : undefined,
      }}
    >
      <div style={SCREEN_TITLE_HEADER}>{title}</div>
      <div style={{ ...SCREEN_PODIUM_CENTER, width: "100%" }}>{children}</div>
    </div>
  );
}

/** Question, révélation, pause — même centrage visuel que fin de manche */
function ScreenQuizStageBlock({ opticalShift = false, alignTop = false, children }) {
  const stageStyle = alignTop
    ? {
        ...SCREEN_PODIUM_CENTER,
        justifyContent: "flex-start",
        paddingTop: 0,
        paddingBottom: 12,
        width: "100%",
      }
    : { ...SCREEN_PODIUM_CENTER, width: "100%" };

  return (
    <div
      style={{
        width: "100%",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minHeight: 0,
        transform: opticalShift ? `translateX(${SCREEN_OPTICAL_SHIFT})` : undefined,
      }}
    >
      <div style={stageStyle}>{children}</div>
    </div>
  );
}

const SCREEN_ON_DARK_BORDER = "1px solid rgba(255, 251, 245, 0.28)";

/** Compte à rebours / intro — même échelle que « Podium provisoire » */
const SCREEN_COUNTDOWN_LABEL = {
  ...pageTextSecondary,
  fontSize: "var(--eley-screen-countdown-label)",
  fontWeight: 700,
  marginBottom: 10,
  lineHeight: 1.3,
  textAlign: "center",
  width: "100%",
};

const SCREEN_COUNTDOWN_NUMBER = {
  fontSize: "var(--eley-screen-countdown-number)",
  fontWeight: 800,
  lineHeight: 1,
  color: PAGE_TEXT,
  textAlign: "center",
  width: "100%",
};

const SCREEN_REVEAL_LABEL = {
  ...pageTextSecondary,
  fontSize: "var(--eley-screen-text-reveal-label)",
  fontWeight: 700,
  marginBottom: 10,
  lineHeight: 1.3,
  maxWidth: "min(920px, 95%)",
  marginLeft: "auto",
  marginRight: "auto",
  textAlign: "center",
  whiteSpace: "nowrap",
  overflowWrap: "normal",
  wordBreak: "normal",
};

const SCREEN_SECONDARY_TEXT = {
  ...pageTextSecondary,
  fontSize: "var(--eley-screen-secondary)",
  lineHeight: 1.45,
  textAlign: "center",
};

const SCREEN_LIVE_CAPTION = {
  ...pageTextSecondary,
  fontSize: "var(--eley-screen-countdown-label)",
  fontWeight: 700,
  marginBottom: 8,
  textAlign: "center",
};

const SCREEN_QCM_STAGE_WRAP = {
  ...SCREEN_STAGE_WRAP,
  marginTop: 0,
  marginBottom: 0,
};

const SCREEN_QCM_QUESTION_STYLE = {
  fontSize: "var(--eley-screen-qcm-question)",
  fontWeight: 800,
  lineHeight: 1.22,
  maxWidth: "min(860px, 92%)",
  margin: "0 0 6px",
};

const SCREEN_QCM_GRID = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "clamp(6px, 1.1vw, 10px)",
  maxWidth: "min(720px, 86%)",
  margin: "6px auto 4px",
  fontSize: "var(--eley-screen-qcm-option)",
  fontWeight: 600,
  lineHeight: 1.28,
  width: "100%",
};

const SCREEN_QCM_OPTION = {
  padding: "clamp(5px, 1vw, 9px) clamp(8px, 1.4vw, 12px)",
  borderRadius: 8,
  border: SCREEN_ON_DARK_BORDER,
  background: "rgba(255, 251, 245, 0.12)",
  textAlign: "center",
  color: PAGE_TEXT,
};

const SCREEN_LIVE_ROW_H = 24;

const SCREEN_LIVE_ROW_W = "min(520px, 92%)";

const SCREEN_LIVE_ROW = {
  display: "grid",
  gridTemplateColumns: "36px minmax(0, 1fr) auto",
  columnGap: 8,
  alignItems: "center",
  width: SCREEN_LIVE_ROW_W,
  margin: "0 auto",
  padding: "3px 10px",
  minHeight: SCREEN_LIVE_ROW_H,
  boxSizing: "border-box",
};

const SCREEN_LIVE_MEDAL = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "var(--eley-screen-qcm-option)",
  lineHeight: 1,
};

const SCREEN_LIVE_NAME = {
  fontSize: "var(--eley-screen-text-question)",
  fontWeight: 700,
  textAlign: "left",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const SCREEN_LIVE_PTS = {
  fontVariantNumeric: "tabular-nums",
  fontWeight: 800,
  fontSize: "var(--eley-screen-countdown-label)",
  textAlign: "right",
  paddingLeft: 16,
  flexShrink: 0,
  whiteSpace: "nowrap",
};

/** Emplacement fixe sous la barre de temps — évite que la question remonte quand les 3 premiers arrivent */
const SCREEN_LIVE_SLOT = {
  width: "100%",
  minHeight: 28 + 4 + 3 * SCREEN_LIVE_ROW_H + 2 * 4,
  marginTop: 4,
  flexShrink: 0,
};

function ScreenQuestionLiveSlot({ liveFirsts, playersById, scoringTable, captionText }) {
  return (
    <div style={SCREEN_LIVE_SLOT} aria-live="polite">
      <div style={{ minHeight: "1.35em", marginBottom: 4 }}>
        {liveFirsts.length > 0 ? <div style={SCREEN_LIVE_CAPTION}>{captionText}</div> : null}
      </div>
      <div style={{ display: "grid", gap: 4, width: "100%" }}>
        {[0, 1, 2].map((idx) => {
          const e = liveFirsts[idx];
          if (!e) {
            return (
              <div
                key={`live-slot-${idx}`}
                style={{ ...podiumCardStyle, ...SCREEN_LIVE_ROW, visibility: "hidden" }}
                aria-hidden="true"
              >
                <span style={SCREEN_LIVE_MEDAL}>🥇</span>
                <span style={SCREEN_LIVE_NAME}>—</span>
                <span style={SCREEN_LIVE_PTS}>+0 pts</span>
              </div>
            );
          }
          const rank = idx + 1;
          const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉";
          const pts = scoringTable[idx] ?? 0;
          const name = playersById[e.playerId]?.name || "(…)";

          return (
            <div
              key={e.playerId}
              style={{
                ...podiumCardStyle,
                ...SCREEN_LIVE_ROW,
              }}
            >
              <span style={SCREEN_LIVE_MEDAL}>{medal}</span>
              <b style={SCREEN_LIVE_NAME}>{name}</b>
              <span style={SCREEN_LIVE_PTS}>+{pts} pts</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SCREEN_TITLE_XL = {
  fontSize: "var(--eley-screen-title-xl)",
  fontWeight: 800,
  marginTop: 6,
  marginBottom: 8,
  lineHeight: 1.12,
  color: PAGE_TEXT,
};

const SCREEN_TITLE_LG = {
  fontSize: "var(--eley-screen-title-lg)",
  fontWeight: 800,
  margin: 0,
  lineHeight: 1.15,
  color: PAGE_TEXT,
};

const SCREEN_TITLE_MD = {
  fontSize: "var(--eley-screen-title-md)",
  fontWeight: 700,
  marginTop: 10,
  marginBottom: 8,
  lineHeight: 1.2,
  color: PAGE_TEXT,
};

const SCREEN_PODIUM_WIDTH = "min(460px, 82%)";

const SCREEN_PODIUM_CAPTION = {
  fontSize: "var(--eley-screen-title-md)",
  fontWeight: 700,
  margin: 0,
  marginBottom: 8,
  lineHeight: 1.2,
  color: PAGE_TEXT,
  width: SCREEN_PODIUM_WIDTH,
  maxWidth: "100%",
  alignSelf: "center",
  display: "flex",
  justifyContent: "center",
  boxSizing: "border-box",
};

/** Préfixe commun + suffixe variable — « Voici… » au même endroit, phrase centrée sur le podium */
function splitSharedPodiumCaption(teamsText, playersText) {
  const a = String(teamsText ?? "").trim();
  const b = String(playersText ?? "").trim();
  let i = 0;
  const minLen = Math.min(a.length, b.length);
  while (i < minLen && a[i] === b[i]) i += 1;
  const prefix = a.slice(0, i).trimEnd();
  const teamsSuffix = a.slice(i).trimStart();
  const playersSuffix = b.slice(i).trimStart();
  return {
    prefix,
    teamsSuffix,
    playersSuffix,
    shared: prefix.length >= 3 && (teamsSuffix.length > 0 || playersSuffix.length > 0),
  };
}

function ScreenPodiumCaption({ teamsText, playersText, view }) {
  const parts = useMemo(
    () => splitSharedPodiumCaption(teamsText, playersText),
    [teamsText, playersText]
  );
  const activeText = view === "teams" ? teamsText : playersText;

  if (!parts.shared) {
    return (
      <h2 style={SCREEN_PODIUM_CAPTION}>
        <span style={{ whiteSpace: "nowrap" }}>{activeText}</span>
      </h2>
    );
  }

  return (
    <h2 style={SCREEN_PODIUM_CAPTION}>
      <span
        style={{
          whiteSpace: "nowrap",
          display: "inline-flex",
          alignItems: "baseline",
          gap: "0.22em",
        }}
      >
        <span>{parts.prefix}</span>
        <span style={{ display: "inline-grid" }}>
          <span style={{ gridArea: "1/1", visibility: view === "teams" ? "visible" : "hidden" }}>
            {parts.teamsSuffix}
          </span>
          <span style={{ gridArea: "1/1", visibility: view === "players" ? "visible" : "hidden" }}>
            {parts.playersSuffix}
          </span>
        </span>
      </span>
    </h2>
  );
}

const SCREEN_RANKING_TITLE_TEAMS = "Classement des équipes";
const SCREEN_RANKING_TITLE_PLAYERS = "Classement des joueurs";

function ScreenRankingTeamStarIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path
        fill={BRAND.orangeLight}
        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
      />
    </svg>
  );
}

function ScreenRankingPlayerHeadIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path
        fill={BRAND.yellow}
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      />
    </svg>
  );
}

/** Titre classement latéral — icône + suffixe fixe (équipes / joueurs) */
function ScreenRankingAsideTitle({ view }) {
  const parts = useMemo(
    () => splitSharedPodiumCaption(SCREEN_RANKING_TITLE_TEAMS, SCREEN_RANKING_TITLE_PLAYERS),
    []
  );

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {view === "teams" ? <ScreenRankingTeamStarIcon /> : <ScreenRankingPlayerHeadIcon />}
      <span
        style={{
          whiteSpace: "nowrap",
          display: "inline-flex",
          alignItems: "baseline",
          gap: "0.22em",
        }}
      >
        <span>{parts.prefix}</span>
        <span style={{ display: "inline-grid" }}>
          <span style={{ gridArea: "1/1", visibility: view === "teams" ? "visible" : "hidden" }}>
            {parts.teamsSuffix}
          </span>
          <span style={{ gridArea: "1/1", visibility: view === "players" ? "visible" : "hidden" }}>
            {parts.playersSuffix}
          </span>
        </span>
      </span>
    </span>
  );
}

/** Podium central + légende + note — identique fin de manche / fin de quiz */
function ScreenPodiumContent({
  view,
  captionTeamsText,
  captionPlayersText,
  podium,
  scoreKey = "score",
  emptyMessage,
  footnote,
}) {
  return (
    <>
      <ScreenPodiumCaption
        teamsText={captionTeamsText}
        playersText={captionPlayersText}
        view={view}
      />
      <PodiumPanel
        podium={podium}
        view={view}
        scoreKey={scoreKey}
        size="screen"
        emptyMessage={emptyMessage}
      />
      {footnote ? <div style={SCREEN_PODIUM_FOOTNOTE}>{footnote}</div> : null}
    </>
  );
}

const SCREEN_FOOTNOTE = {
  opacity: 0.85,
  marginTop: 10,
  fontSize: "var(--eley-screen-footnote)",
  lineHeight: 1.45,
  maxWidth: SCREEN_PODIUM_WIDTH,
  color: PAGE_TEXT,
};

/** Note sous le podium — alignée à gauche sur la même largeur que PodiumPanel (screen) */
const SCREEN_PODIUM_FOOTNOTE = {
  ...SCREEN_FOOTNOTE,
  width: SCREEN_PODIUM_WIDTH,
  maxWidth: "100%",
  alignSelf: "center",
  textAlign: "left",
  boxSizing: "border-box",
};

/** Classement latéral — même grille équipes / joueurs (réf. vue équipes) */
const SCREEN_LB_ROW = {
  gridTemplateColumns: "28px 1fr auto",
  gap: 8,
  padding: "8px 10px",
  minHeight: 40,
  boxSizing: "border-box",
};
const SCREEN_LB_DOT = { width: 10, height: 10, borderRadius: 3, flex: "0 0 auto" };
const SCREEN_LB_TRAIL_ICON = {
  width: 28,
  minWidth: 28,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 20,
  lineHeight: 1,
};

function screenRoundTitle(endOfRoundLabel, roundIndex) {
  const base = String(endOfRoundLabel || "Fin de la manche").trim();
  const n = roundIndex != null ? roundIndex + 1 : "";
  return n ? `${base} ${n}` : base;
}

function ScreenMultiline({ text, as: Tag = "span", style }) {
  const parts = String(text ?? "").split("\n");
  return (
    <Tag style={style}>
      {parts.map((line, i) => (
        <span key={i}>
          {line}
          {i < parts.length - 1 ? <br /> : null}
        </span>
      ))}
    </Tag>
  );
}

// Panneau "Rejoindre" (inline)
function JoinPanelInline({ size = "md", joinUrl }) {
  const isScreenTop = size === "screenTop";
  const isLg = size === "lg";
  const qrMax = isLg ? 320 : isScreenTop ? 210 : 160;
  const panelStyle = {
    marginTop: 0,
    width: isScreenTop ? "max-content" : isLg ? "100%" : 320,
    maxWidth: isScreenTop ? "100%" : undefined,
    boxSizing: "border-box",
    padding: isScreenTop ? SCREEN_QR_INSET : 12,
    ...cardStyle,
    boxShadow: "0 2px 12px rgba(13, 5, 37, 0.12)",
    color: BRAND.mauveDark,
    fontFamily: FONT_FAMILY,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  };
  return (
    <div style={panelStyle} aria-hidden="true">
      <div
        style={{
          fontWeight: 700,
          marginBottom: isScreenTop ? 4 : 6,
          fontSize: isScreenTop ? 13 : undefined,
          maxWidth: isScreenTop ? qrMax : undefined,
        }}
      >
        Rejoindre :
      </div>
      <div
        style={{
          fontFamily: "monospace",
          fontSize: isScreenTop ? 11 : 16,
          userSelect: "all",
          lineHeight: 1.35,
          wordBreak: "break-all",
          maxWidth: isScreenTop ? qrMax : undefined,
        }}
      >
        {joinUrl}
      </div>
      <img
        src={getJoinQrImageUrl(joinUrl)}
        alt=""
        style={{
          display: "block",
          marginTop: isScreenTop ? 7 : 10,
          width: isScreenTop ? qrMax : "100%",
          maxWidth: isScreenTop ? qrMax : qrMax,
          height: "auto",
        }}
      />
    </div>
  );
}

function ScreenTopImage({ imageUrl }) {
  if (!imageUrl) return null;

  const imgWidth = "min(58vw, 420px)";
  const imgHeight = "clamp(230px, 32vh, 400px)";

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        left: SCREEN_IMAGE_EDGE_LEFT,
        top: SCREEN_IMAGE_EDGE_TOP,
        zIndex: 0,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          background: IMAGE_FRAME_BG,
          padding: 3,
          boxSizing: "border-box",
          boxShadow:
            "0 0 32px 16px rgba(0, 0, 0, 0.62), 0 0 64px 32px rgba(0, 0, 0, 0.38)",
        }}
      >
        <img
          src={imageUrl}
          alt=""
          style={{
            display: "block",
            width: imgWidth,
            maxWidth: "100vw",
            height: imgHeight,
            objectFit: "cover",
            border: "none",
            borderRadius: 0,
            verticalAlign: "top",
          }}
          loading="lazy"
          decoding="async"
        />
      </div>
    </div>
  );
}

function ScreenBottomQr({ joinUrl }) {
  return (
    <aside
      aria-label="QR code — rejoindre le quiz"
      style={{
        position: "fixed",
        left: SCREEN_CORNER_LEFT,
        bottom: SCREEN_CORNER_BOTTOM,
        zIndex: 2,
        maxWidth: "clamp(240px, 24vw, 320px)",
        pointerEvents: "auto",
      }}
    >
      <JoinPanelInline size="screenTop" joinUrl={joinUrl} />
    </aside>
  );
}

function ScreenSideDecor({ leftImageUrl, joinUrl }) {
  return (
    <>
      <ScreenTopImage imageUrl={leftImageUrl} />
      <ScreenBottomQr joinUrl={joinUrl} />
    </>
  );
}


// Splash (plein bleu foncé au boot)
function Splash() {
  return <BrandShell aria-hidden="true" />;
}

// ============================================================================
// /pages/screen.js — Partie 2/5
// Scope : Composant Screen — états/refs, abonnements Firestore (questions,
// joueurs, config, état global) et timer local synchronisé.
// ============================================================================

function ScreenInner() {
  useMobileVH();

  const [playerJoinUrl, setPlayerJoinUrl] = useState(() =>
    typeof window !== "undefined"
      ? resolvePlayerJoinUrl(window.location)
      : resolvePlayerJoinUrl(null)
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    setPlayerJoinUrl(resolvePlayerJoinUrl(window.location));
  }, []);

  /* ======================= ÉTATS & RÉFS (TOP-LEVEL) ======================= */

  const lastNavSeqRef = useRef(null);
  const uiMaskTimerRef = useRef(null);
  const [uiMasked, setUiMasked] = useState(false);

  // Flags de chargement
  const [stateLoaded, setStateLoaded] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [questionsLoaded, setQuestionsLoaded] = useState(false);

  // Données & timing globaux
  const [questionsList, setQuestionsList] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  const [quizEndSec, setQuizEndSec] = useState(null);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([]);
  const [revealDurationSec, setRevealDurationSec] = useState(REVEAL_DURATION_SEC);
  const [countdownStartSec, setCountdownStartSec] = useState(COUNTDOWN_START_SEC);
  const [roundStartIntroSec, setRoundStartIntroSec] = useState(ROUND_START_INTRO_SEC);
  const [activeQuizKey, setActiveQuizKey] = useState(null);

  // Image optionnelle au-dessus du QR (config: screenLeftImageUrl)
  const [leftImageUrl, setLeftImageUrl] = useState(null);

  // Messages personnalisables (Firestore /quiz/config → messages)
  const [screenAttenteMessages, setScreenAttenteMessages] = useState(SCREEN_PAGE_ATTENTE);
  const [screenQuizMessages, setScreenQuizMessages] = useState(SCREEN_PAGE_QUIZ);
  const [screenPodiumMessages, setScreenPodiumMessages] = useState(SCREEN_PAGE_PODIUM);
  const [screenEleyBuzzMessages, setScreenEleyBuzzMessages] = useState(ELEYBUZZ_SCREEN_MESSAGES);

  // Leaderboard
  const [playersLB, setPlayersLB] = useState([]);
  const [teamsLB, setTeamsLB] = useState([]);
  const [leaderboardTopN, setLeaderboardTopN] = useState(DEFAULT_LEADERBOARD_TOP_N);
  const [leaderboardView, setLeaderboardView] = useState("teams"); // "teams" | "players"
  const awardGuardRef = useRef({}); // utilisé plus tard pour l'attribution des points

  // Fin de manche (poussée par l’admin)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Offset d’horloge serveur (ms) — mis à jour via /quiz/state.serverNow
  const serverDeltaRef = useRef(0);
  const [serverDeltaTick, setServerDeltaTick] = useState(0); // re-render léger si besoin

  // Dernier reset global des joueurs (playersResetAt) déjà pris en compte
  const lastPlayersResetAtRef = useRef(0);

  const [syncHoleSince, setSyncHoleSince] = useState(null);


  // Table de points (pour afficher +30/+25/+20)
  const [scoringTable, setScoringTable] = useState(DEFAULT_SCORING_TABLE);

  // Top 3 live pour la question courante (pendant la phase "question")
  // Format: [{ playerId }]
  const [liveFirsts, setLiveFirsts] = useState([]);

  // EleyBuzz state
  const [isBuzzerMode, setIsBuzzerMode] = useState(false);
  const [buzzerState, setBuzzerState] = useState("idle");
  const [firstPlayerId, setFirstPlayerId] = useState(null);
  const [firstPlayerName, setFirstPlayerName] = useState(null);
  const [buzzerMessage, setBuzzerMessage] = useState(null);
  const [buzzerMessageType, setBuzzerMessageType] = useState(null);

  // Score Final state
  const [showFinalScore, setShowFinalScore] = useState(false);

  // Accès rapide aux noms des joueurs par id
  const playersById = useMemo(() => {
    const map = Object.create(null);
    for (const p of playersLB) map[p.id] = p;
    return map;
  }, [playersLB]);

  // Nom du gagnant EleyBuzz : résolu via la liste joueurs (firstPlayerName Firestore = legacy)
  const buzzerWinnerName = useMemo(() => {
    if (firstPlayerId) {
      const name = playersById[firstPlayerId]?.name;
      if (name) return name;
    }
    return firstPlayerName || null;
  }, [firstPlayerId, firstPlayerName, playersById]);

  // Charger la table de scoring une fois
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const t = await getScoringTable(db);
        if (mounted && Array.isArray(t)) setScoringTable(t);
      } catch {
        // fallback déjà en place via DEFAULT_SCORING_TABLE
      }
    })();
    return () => { mounted = false; };
  }, []);



  /* --------------------------- Charger les questions --------------------------- */
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // Pas de quiz actif connu → liste vide mais "loaded" (évite un splash infini)
        if (!activeQuizKey) {
          if (!cancelled) {
            setQuestionsList([]);
            setQuestionsLoaded(true);
          }
          return;
        }

        const q = query(
          collection(db, "LesQuestions"),
          where("quizKey", "==", activeQuizKey)
        );
        const snapshot = await getDocs(q);
        if (!cancelled) {
          setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
          setQuestionsLoaded(true);
        }
      } catch (e) {
        console.error("[Screen] load questions failed:", e);
        if (!cancelled) {
          setQuestionsList([]);
          setQuestionsLoaded(true);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [activeQuizKey]);


  /* ----------------------------- Écouter players ------------------------------ */
  useEffect(() => {
    const col = collection(doc(db, "quiz", "state"), "players");
    const unsub = onSnapshot(col, (snap) => {
      const arr = snap.docs.map((d) => {
        const v = d.data() || {};
        return {
          id: d.id,
          name: v.name || "",
          score: Number(v.score || 0),
          buzzScore: Number(v.buzzScore || 0),
          color: v.color || null,
          teamId: v.teamId || null,
          isKicked: !!v.isKicked,
          lastDelta: Number(v.lastDelta || 0),
          lastDeltaForQuestionId: v.lastDeltaForQuestionId || null,
          _nameKey: normalizeNameAlpha(v.name || ""),
        };
      });
      setPlayersLB(arr);
    });
    return () => unsub();
  }, []);

  /* ----------------------------- Écouter teams ------------------------------ */
  useEffect(() => {
    const col = collection(doc(db, "quiz", "state"), "teams");
    const unsub = onSnapshot(col, (snap) => {
      const arr = snap.docs.map((d) => {
        const v = d.data() || {};
        return {
          id: d.id,
          name: v.name || "",
          teamQuizScore: Number(v.teamQuizScore || 0),
          color: v.color || null,
          memberIds: Array.isArray(v.memberIds) ? v.memberIds : [],
          isKicked: !!v.isKicked,
        };
      });
      setTeamsLB(arr);
    });
    return () => unsub();
  }, []);

  /* ------------------------------- Écouter config ------------------------------ */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data() || {};

      // Quiz actif
      const activeKey =
        typeof d?.activeQuizKey === "string" && d.activeQuizKey.trim()
          ? d.activeQuizKey.trim()
          : null;
      setActiveQuizKey(activeKey);

      // taille du top
      const topN = Number.isFinite(d?.leaderboardTopN) ? d.leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N;
      setLeaderboardTopN(topN);

      // Vue du leaderboard (Équipes ou Joueurs)
      if (d?.leaderboardView === "players" || d?.leaderboardView === "teams") {
        setLeaderboardView(d.leaderboardView);
      } else {
        setLeaderboardView("teams"); // Par défaut : équipes
      }

      // bornes quiz & manches
      setQuizEndSec(typeof d?.endOffsetSec === "number" ? d.endOffsetSec : null);
      setRoundOffsetsSec(
        Array.isArray(d?.roundOffsetsSec)
          ? d.roundOffsetsSec.map((v) => (Number.isFinite(v) ? v : null))
          : []
      );
      const rv = Number.isFinite(d?.revealDurationSec) ? d.revealDurationSec : REVEAL_DURATION_SEC;
      setRevealDurationSec(rv);
      const cs = Number.isFinite(d?.countdownStartSec) ? d.countdownStartSec : COUNTDOWN_START_SEC;
      setCountdownStartSec(cs);
      const ris = Number.isFinite(d?.roundStartIntroSec) ? d.roundStartIntroSec : ROUND_START_INTRO_SEC;
      setRoundStartIntroSec(ris);

      // Image optionnelle au-dessus du QR (fallback sur LEFT_GENERIC_IMG_SRC si absent)
      setLeftImageUrl(
        typeof d?.screenLeftImageUrl === "string" && d.screenLeftImageUrl.trim() !== ""
          ? d.screenLeftImageUrl
          : (LEFT_GENERIC_IMG_SRC || null)
      );

      // Messages personnalisables depuis Firestore
      setScreenAttenteMessages(mergePageMessages(SCREEN_PAGE_ATTENTE, {
        ...d.screenAttente,
        title: d.screenAttente?.title ?? d.screenQuiz?.preStartTitle,
        message: d.screenAttente?.message ?? d.screenQuiz?.preStartMessage,
      }));
      setScreenQuizMessages(mergePageMessages(SCREEN_PAGE_QUIZ, {
        ...d.screenQuizPage,
        pauseTitle: d.screenQuizPage?.pauseTitle ?? d.screenQuiz?.pauseTitle,
        pauseSubtitle: d.screenQuizPage?.pauseSubtitle ?? d.screenQuiz?.pauseSubtitle,
      }));
      setScreenPodiumMessages(mergePageMessages(SCREEN_PAGE_PODIUM, {
        ...d.screenPodium,
        endOfRound: d.screenPodium?.endOfRound ?? d.screenQuizPage?.endOfRound ?? d.screenQuiz?.endOfRound,
        podiumTitle: d.screenPodium?.podiumTitle ?? d.screenQuiz?.podiumTitle,
        finalPodiumTitle: d.screenPodium?.finalPodiumTitle ?? d.screenQuiz?.finalPodiumTitle,
      }));
      setScreenEleyBuzzMessages(mergePageMessages(ELEYBUZZ_SCREEN_MESSAGES, d.screenEleyBuzz));

      setConfigLoaded(true);
    });
    return () => unsub();
  }, []);


  /* ------------------------------ Écouter /state ------------------------------ */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = (snap && snap.data()) || {};

      // Reset runtime local si un nouveau reset global est détecté
      const tReset = d.playersResetAt;
      if (tReset && typeof tReset.seconds === "number") {
        const ms =
          tReset.seconds * 1000 +
          Math.floor((tReset.nanoseconds || tReset.nanos || 0) / 1e6);

        // Nouveau reset vu → on vide toutes les sentinelles locales de session
        if (ms > lastPlayersResetAtRef.current) {
          lastPlayersResetAtRef.current = ms;

          // Gardes TX (awards), top live et timer local
          awardGuardRef.current = {};
          setLiveFirsts([]);
          setElapsedSec(0);
        }
      }

      // startMs depuis ancrage (anchorAt + anchorOffsetSec) si présent ; fallback legacy
      let startMs = null;
      if (d.anchorAt && typeof d.anchorAt.seconds === "number") {
        const anchorMs = d.anchorAt.seconds * 1000 + Math.floor((d.anchorAt.nanoseconds || d.anchorAt.nanos || 0) / 1e6);
        const offsetSec = Number.isFinite(d.anchorOffsetSec) ? d.anchorOffsetSec : 0;
        startMs = anchorMs - offsetSec * 1000;
      } else if (d.startAt && typeof d.startAt.seconds === "number") {
        startMs = d.startAt.seconds * 1000 + Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      } else if (typeof d.startEpochMs === "number") {
        startMs = d.startEpochMs;
      }

      // Gate visuelle sur changement de navigation
      const nextNavSeq = Number.isFinite(d.navSeq) ? d.navSeq : null;
      if (nextNavSeq != null && nextNavSeq !== lastNavSeqRef.current) {
        lastNavSeqRef.current = nextNavSeq;
        if (uiMaskTimerRef.current) clearTimeout(uiMaskTimerRef.current);
        setUiMasked(true);
        uiMaskTimerRef.current = setTimeout(() => {
          setUiMasked(false);
          uiMaskTimerRef.current = null;
        }, UI_MASK_MS);
      }

      // Delta d’horloge locale ← serveur (via heartbeat Admin)
      if (d.serverNow && typeof d.serverNow.seconds === "number") {
        const serverNowMs = d.serverNow.seconds * 1000 + Math.floor((d.serverNow.nanoseconds || d.serverNow.nanos || 0) / 1e6);
        const instantDelta = serverNowMs - Date.now(); // (>0) = mon device est en retard

        // Buffer des derniers deltas pour une correction “best-of”
        if (!serverDeltaRef.buffer) serverDeltaRef.buffer = [];
        serverDeltaRef.buffer.push(instantDelta);
        if (serverDeltaRef.buffer.length > 8) serverDeltaRef.buffer.shift();

        // On prend le percentile 90 (valeur haute sans aller à l’extrême)
        const sorted = [...serverDeltaRef.buffer].sort((a, b) => a - b);
        const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? instantDelta;

        // Lissage EMA vers cette valeur
        const prev = serverDeltaRef.current || 0;
        const alpha = 0.25;
        serverDeltaRef.current = prev * (1 - alpha) + p90 * alpha;

        // Tick optionnel (faible coût) si on relies des choses à Date.now()
        setServerDeltaTick((t) => (t + 1) & 0xfff);
      }

      setIsRunning(!!d.isRunning);
      setIsPaused(!!d.isPaused);

      // EleyBuzz state
      setIsBuzzerMode(!!d.isBuzzerMode);
      setBuzzerState(typeof d.buzzerState === "string" ? d.buzzerState : "idle");
      setFirstPlayerId(typeof d.firstPlayerId === "string" ? d.firstPlayerId : null);
      setFirstPlayerName(typeof d.firstPlayerName === "string" ? d.firstPlayerName : null);
      setBuzzerMessage(typeof d.buzzerMessage === "string" ? d.buzzerMessage : null);
      setBuzzerMessageType(typeof d.buzzerMessageType === "string" ? d.buzzerMessageType : null);
      setShowFinalScore(!!d.showFinalScore);

      if (!startMs) {
        setQuizStartMs(null);
        setPauseAtMs(null);
        setElapsedSec(0);
      } else {
        setQuizStartMs(startMs);
        if (d.pauseAt && typeof d.pauseAt.seconds === "number") {
          const pms = d.pauseAt.seconds * 1000 + Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
          setPauseAtMs(pms);
          if (d.isPaused) {
            const e = Math.floor((pms - startMs) / 1000);
            setElapsedSec(e < 0 ? 0 : e);
          }
        } else {
          setPauseAtMs(null);
        }
      }

      // Fin de manche (sentinelle posée côté admin)
      setLastAutoPausedRoundIndex(
        Number.isInteger(d.lastAutoPausedRoundIndex) ? d.lastAutoPausedRoundIndex : null
      );

      setStateLoaded(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => () => {
    if (uiMaskTimerRef.current) clearTimeout(uiMaskTimerRef.current);
  }, []);

  /* ------------------- Timer local (avec clamp fin de quiz) ------------------- */
  useEffect(() => {
    if (!quizStartMs) {
      setElapsedSec(0);
      return;
    }
    if (isPaused && pauseAtMs) {
      const e = Math.floor((pauseAtMs - quizStartMs) / 1000);
      const clamped = Number.isFinite(quizEndSec) ? Math.min(e, quizEndSec) : e;
      setElapsedSec(clamped < 0 ? 0 : clamped);
      return;
    }
    if (!isRunning) {
      setElapsedSec(0);
      return;
    }

    const computeNow = () =>
      Math.floor(((Date.now() + serverDeltaRef.current) - quizStartMs) / 1000);

    // Premier tick immédiat
    const first = computeNow();
    if (Number.isFinite(quizEndSec) && first >= quizEndSec) {
      setElapsedSec(Math.max(0, quizEndSec));
      return;
    }
    setElapsedSec(first < 0 ? 0 : first);

    // --- rAF 10 FPS ---
    let rafId;
    let lastTick = 0;

    const loop = (t) => {
      if (t - lastTick >= 100) { // ≈ 10 FPS
        lastTick = t;
        const raw = computeNow();
        if (Number.isFinite(quizEndSec) && raw >= quizEndSec) {
          setElapsedSec(Math.max(0, quizEndSec));
          cancelAnimationFrame(rafId);
          return;
        }
        setElapsedSec(raw < 0 ? 0 : raw);
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec, serverDeltaTick]);

  // ============================================================================
  // /pages/screen.js — Partie 3.5/5
  // Scope : leaderboard/podium (tri + égalités), dérivés & phases d’écran,
  // déclenchement d’attribution des points pendant la révélation.
  // ============================================================================

  /* ----------------------- Leaderboard (tri & top N) ----------------------- */
  const leaderboard = useMemo(() => {
    if (leaderboardView === "teams") {
      // Leaderboard par équipes
      const rows = (teamsLB || [])
        .filter((t) => !t.isKicked)
        .map((t) => ({
          id: t.id,
          name: t.name || "",
          score: Number(t.teamQuizScore || 0),
          _nameKey: normalizeNameAlpha(t.name || ""),
        }))
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a._nameKey.localeCompare(b._nameKey);
        });

      // Rangs avec égalités
      let lastScore = null;
      let lastRank = 0;
      rows.forEach((p, i) => {
        const sc = p.score;
        if (i === 0) {
          p._rank = 1;
          lastScore = sc;
          lastRank = 1;
        } else if (sc === lastScore) {
          p._rank = lastRank;
        } else {
          p._rank = i + 1;
          lastScore = sc;
          lastRank = p._rank;
        }
      });

      const top = Number.isFinite(leaderboardTopN) ? leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N;
      return rows.slice(0, top);
    } else {
      // Leaderboard par joueurs (comportement original)
      // IMPORTANT: Filtrer les joueurs qui n'ont pas d'équipe
      const rows = (playersLB || [])
        .filter((p) => !p.isKicked && p.teamId) // Un joueur doit avoir une équipe
        .slice();

      rows.sort((a, b) => {
        const sa = Number(a.score || 0);
        const sb = Number(b.score || 0);
        if (sa !== sb) return sb - sa; // score desc
        const ak = a._nameKey;
        const bk = b._nameKey;
        if (ak < bk) return -1;
        if (ak > bk) return 1;
        return 0;
      });

      // Rangs avec égalités
      let lastScore = null;
      let lastRank = 0;
      rows.forEach((p, i) => {
        const sc = Number(p.score || 0);
        if (i === 0) {
          p._rank = 1;
          lastScore = sc;
          lastRank = 1;
        } else if (sc === lastScore) {
          p._rank = lastRank;
        } else {
          p._rank = i + 1;
          lastScore = sc;
          lastRank = p._rank;
        }
      });

      const top = Number.isFinite(leaderboardTopN) ? leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N;
      return rows.slice(0, top);
    }
  }, [playersLB, teamsLB, leaderboardView, leaderboardTopN]);

  // Podium (fin de quiz) : basé sur les RANGS (1, 2, 3) comme dans le classement
  // Score final = score quiz uniquement (sans EleyBuzz pour la fin de quiz normale)
  const podium = useMemo(() => {
    if (leaderboardView === "teams") {
      // Podium par équipes
      const rows = (teamsLB || [])
        .filter((t) => !t.isKicked)
        .map((t) => {
          const scoreQuiz = Number(t.teamQuizScore || 0);
          return {
            id: t.id,
            name: t.name || "",
            score: scoreQuiz,
            color: t.color || null,
            _nameKey: normalizeNameAlpha(t.name || ""),
          };
        })
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a._nameKey.localeCompare(b._nameKey);
        });

      // Calcul des rangs "compétition" : 1,1,3,4… (basé sur score équipe quiz)
      let lastScore = null;
      let lastRank = 0;
      rows.forEach((p, i) => {
        const sc = p.score;
        if (i === 0) {
          p._rank = 1;
          lastScore = sc;
          lastRank = 1;
        } else if (sc === lastScore) {
          p._rank = lastRank;
        } else {
          p._rank = i + 1;
          lastScore = sc;
          lastRank = p._rank;
        }
      });

      const gold = rows.filter((p) => p.score > 0 && p._rank === 1);
      const silver = rows.filter((p) => p.score > 0 && p._rank === 2);
      const bronze = rows.filter((p) => p.score > 0 && p._rank === 3);

      return { gold, silver, bronze };
    } else {
      // Podium par joueurs (comportement original)
      // IMPORTANT: Filtrer les joueurs qui n'ont pas d'équipe
      const rows = (playersLB || [])
        .filter((p) => !p.isKicked && p.teamId) // Un joueur doit avoir une équipe
        .map((p) => {
          const scoreQuiz = Number(p.score || 0);
          return {
            id: p.id,
            name: p.name || "",
            score: scoreQuiz,
            _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
          };
        })
        .sort((a, b) => {
          // Tri par score quiz uniquement, puis nom
          if (a.score !== b.score) return b.score - a.score;
          return a._nameKey.localeCompare(b._nameKey);
        });

      // Calcul des rangs "compétition" : 1,1,3,4… (basé sur score quiz)
      let lastScore = null;
      let lastRank = 0;
      rows.forEach((p, i) => {
        const sc = p.score;
        if (i === 0) {
          p._rank = 1;
          lastScore = sc;
          lastRank = 1;
        } else if (sc === lastScore) {
          p._rank = lastRank;
        } else {
          p._rank = i + 1;
          lastScore = sc;
          lastRank = p._rank;
        }
      });

      // Groupes de médailles alignés sur le classement (basé sur score quiz)
      const gold = rows.filter((p) => p.score > 0 && p._rank === 1);
      const silver = rows.filter((p) => p.score > 0 && p._rank === 2);
      const bronze = rows.filter((p) => p.score > 0 && p._rank === 3);

      return { gold, silver, bronze };
    }
  }, [playersLB, teamsLB, leaderboardView]);

  // Podium final (Score Final) : équipes = teamQuizScore ; joueurs = score
  // (après « Score final » Admin, buzz déjà fusionné dans score et remis à 0)
  const finalPodium = useMemo(() => {
    if (leaderboardView === "teams") {
      // Podium final par équipes (jamais de bonus buzz)
      const rows = (teamsLB || [])
        .filter((t) => !t.isKicked)
        .map((t) => {
          const scoreFinal = Number(t.teamQuizScore || 0);
          return {
            id: t.id,
            name: t.name || "",
            scoreFinal: scoreFinal,
            color: t.color || null,
            _nameKey: normalizeNameAlpha(t.name || ""),
          };
        })
        .sort((a, b) => {
          if (a.scoreFinal !== b.scoreFinal) return b.scoreFinal - a.scoreFinal;
          return a._nameKey.localeCompare(b._nameKey);
        });

      // Calcul des rangs "compétition" : 1,1,3,4… (basé sur score équipe quiz)
      let lastScore = null;
      let lastRank = 0;
      rows.forEach((p, i) => {
        const sc = p.scoreFinal;
        if (i === 0) {
          p._rank = 1;
          lastScore = sc;
          lastRank = 1;
        } else if (sc === lastScore) {
          p._rank = lastRank;
        } else {
          p._rank = i + 1;
          lastScore = sc;
          lastRank = p._rank;
        }
      });

      const gold = rows.filter((p) => p.scoreFinal > 0 && p._rank === 1);
      const silver = rows.filter((p) => p.scoreFinal > 0 && p._rank === 2);
      const bronze = rows.filter((p) => p.scoreFinal > 0 && p._rank === 3);

      return { gold, silver, bronze, all: rows };
    } else {
      // Podium final par joueurs (comportement original : Quiz + EleyBuzz)
      // IMPORTANT: Filtrer les joueurs qui n'ont pas d'équipe
      const rows = (playersLB || [])
        .filter((p) => !p.isKicked && p.teamId) // Un joueur doit avoir une équipe
        .map((p) => {
          const scoreQuiz = Number(p.score || 0);
          const buzzScore = Number(p.buzzScore || 0);
          const scoreFinal = scoreQuiz + buzzScore;
          return {
            id: p.id,
            name: p.name || "",
            score: scoreQuiz,
            buzzScore: buzzScore,
            scoreFinal: scoreFinal,
            _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
          };
        })
        .sort((a, b) => {
          // Tri par score final (quiz + EleyBuzz), puis nom
          if (a.scoreFinal !== b.scoreFinal) return b.scoreFinal - a.scoreFinal;
          return a._nameKey.localeCompare(b._nameKey);
        });

      // Calcul des rangs "compétition" : 1,1,3,4… (basé sur scoreFinal)
      let lastScore = null;
      let lastRank = 0;
      rows.forEach((p, i) => {
        const sc = p.scoreFinal;
        if (i === 0) {
          p._rank = 1;
          lastScore = sc;
          lastRank = 1;
        } else if (sc === lastScore) {
          p._rank = lastRank;
        } else {
          p._rank = i + 1;
          lastScore = sc;
          lastRank = p._rank;
        }
      });

      // Groupes de médailles alignés sur le classement (basé sur scoreFinal)
      const gold = rows.filter((p) => p.scoreFinal > 0 && p._rank === 1);
      const silver = rows.filter((p) => p.scoreFinal > 0 && p._rank === 2);
      const bronze = rows.filter((p) => p.scoreFinal > 0 && p._rank === 3);

      return { gold, silver, bronze, all: rows };
    }
  }, [playersLB, teamsLB, leaderboardView]);


  /* ---------------- Dérivés & logique bornée par la manche ---------------- */
  const sorted = [...questionsList].sort((a, b) => getTimeSec(a) - getTimeSec(b));

  // Début/fin de la manche courante
  const currentRoundStart = (() => {
    let s = 0;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) s = t;
    }
    return s;
  })();
  const currentRoundEnd = (() => {
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && t > currentRoundStart) return t;
    }
    return Infinity;
  })();

  // Question courante = dernière question dans [roundStart, elapsedSec[
  let activeIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (!Number.isFinite(t) || t < currentRoundStart) continue;
    if (t <= elapsedSec && t < currentRoundEnd) activeIndex = i;
    else if (t >= currentRoundEnd) break;
  }
  const currentQuestion = activeIndex >= 0 ? sorted[activeIndex] : null;
  const currentQuestionId = currentQuestion?.id ?? null;

  /* ---------------- Prochaine échéance (question / manche / fin) ----------- */
  // Prochaine question (t > elapsedSec)
  let nextTimeSec = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (Number.isFinite(t) && t > elapsedSec) {
      nextTimeSec = t;
      break;
    }
  }

  // Prochaine frontière de manche (−GAP pour éviter chevauchement reveal)
  const GAP = 1;
  const nextRoundStart = nextRoundStartAfter(elapsedSec, roundOffsetsSec);
  const nextRoundBoundary = Number.isFinite(nextRoundStart) ? Math.max(0, nextRoundStart - GAP) : null;

  // Fenêtre morte à ± ~1s autour de la frontière
  const ROUND_DEADZONE_SEC = ROUND_BOUNDARY_GAP_SEC;
  const secondsToRoundBoundary = Number.isFinite(nextRoundStart) ? nextRoundStart - elapsedSec : null;
  const inRoundBoundaryWindow =
    !uiMasked &&
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= ROUND_DEADZONE_SEC &&
    secondsToRoundBoundary >= -0.25;

  const boundaryRoundIndex =
    Number.isFinite(nextRoundStart)
      ? roundIndexOfTime(Math.max(0, nextRoundStart - 0.001), roundOffsetsSec)
      : null;

  // Candidat minimal
  // On re-considère la frontière de manche (nextRoundBoundary) comme un
  // "événement" à part entière pour retrouver le compte à rebours
  // "Fin de la manche X dans :".
  let effectiveNextTimeSec = null;
  let nextKind = null; // "question" | "end" | "round"
  {
    const cands = [];
    if (Number.isFinite(nextTimeSec)) {
      cands.push({ t: nextTimeSec, k: "question" });
    }
    if (Number.isFinite(quizEndSec)) {
      cands.push({ t: quizEndSec, k: "end" });
    }
    if (Number.isFinite(nextRoundBoundary)) {
      cands.push({ t: nextRoundBoundary, k: "round" });
    }

    if (cands.length) {
      const best = cands.reduce((a, b) => (a.t < b.t ? a : b));
      effectiveNextTimeSec = best.t;
      nextKind = best.k;
    }
  }



  /* ------------------------- Phases & bornes locales ------------------------ */
  const qStart = Number.isFinite(getTimeSec(currentQuestion)) ? getTimeSec(currentQuestion) : null;

  // 1ʳᵉ question de la manche courante ?
  const firstQuestionTimeInCurrentRound = (() => {
    for (let i = 0; i < sorted.length; i++) {
      const t = getTimeSec(sorted[i]);
      if (!Number.isFinite(t)) continue;
      if (t >= currentRoundStart && t < currentRoundEnd) return t;
    }
    return null;
  })();
  const isFirstQuestionOfRound =
    Number.isFinite(qStart) &&
    Number.isFinite(firstQuestionTimeInCurrentRound) &&
    qStart === firstQuestionTimeInCurrentRound;

  const introStart = isFirstQuestionOfRound ? qStart : null;
  const introEnd = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + roundStartIntroSec
    : null;

  // Le temps "jouable" commence après l'intro
  const qStartEffective =
    isFirstQuestionOfRound && Number.isFinite(qStart)
      ? qStart + roundStartIntroSec
      : qStart;

  // Compte à rebours affiché 5..1
  const introCountdownSec = isFirstQuestionOfRound &&
    !uiMasked &&
    !isPaused &&
    introStart != null &&
    elapsedSec >= introStart &&
    introEnd != null &&
    elapsedSec < introEnd
    ? Math.max(1, Math.ceil(introEnd - elapsedSec))
    : null;

  // Numéro de manche (UI)
  const roundIdxForCurrentQuestion = Number.isFinite(qStart)
    ? roundIndexOfTime(Math.max(0, qStart), roundOffsetsSec)
    : null;
  const roundNumberForIntro = roundIdxForCurrentQuestion != null ? roundIdxForCurrentQuestion + 1 : null;

  // Pause de manche / fin de quiz
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;
  const isQuizEnded = typeof quizEndSec === "number" && elapsedSec >= quizEndSec;

  // On ne considère "Fin de manche" que si :
  //  - la pause vient bien d'une auto-pause (endedRoundIndex != null)
  //  - ET qu'on est encore dans la fenêtre de temps de cette manche
  let isRoundBreak = false;
  if (isPaused && endedRoundIndex != null && !isQuizEnded) {
    const endedRoundStartSec = Number.isFinite(roundOffsetsSec[endedRoundIndex])
      ? roundOffsetsSec[endedRoundIndex]
      : null;

    let endedRoundEndSec = null;
    if (endedRoundStartSec != null) {
      const nextStart = nextRoundStartAfter(endedRoundStartSec, roundOffsetsSec);
      if (Number.isFinite(nextStart)) {
        endedRoundEndSec = nextStart;
      } else if (Number.isFinite(quizEndSec)) {
        // Dernière manche : on borne par la fin de quiz si connue
        endedRoundEndSec = quizEndSec;
      }
    }

    const withinWindow =
      endedRoundStartSec != null &&
      elapsedSec >= endedRoundStartSec &&
      (endedRoundEndSec == null || elapsedSec <= endedRoundEndSec + 0.5);

    if (withinWindow) {
      isRoundBreak = true;
    }
  }




  // Phases bornées (anti-flash)
  // On force un minimum de temps "question" avant la révélation,
  // surtout pour la dernière question d'une manche / avant fin de quiz.
  const nextEvent = effectiveNextTimeSec;

  let revealStart = null;
  let countdownStart = null;

  if (nextEvent != null) {
    // Le décompte reste toujours sur les dernières countdownStartSec secondes.
    countdownStart = nextEvent - countdownStartSec;

    const hasQStart = Number.isFinite(qStartEffective);

    if (hasQStart) {
      const rawRevealStart = nextEvent - revealDurationSec;
      const MIN_QUESTION_PHASE_SEC = 3; // minimum de temps d'affichage de la question

      // On veut au moins MIN_QUESTION_PHASE_SEC entre qStartEffective et début de la révélation.
      const minFromQuestion = qStartEffective + MIN_QUESTION_PHASE_SEC;

      let candidate = rawRevealStart;

      // Si le calcul brut remonte trop loin (avant la question),
      // on remonte le début de la révélation juste après la phase "question".
      if (!Number.isFinite(candidate) || candidate < minFromQuestion) {
        candidate = minFromQuestion;
      }

      // Si jamais on est tellement serrés qu'on chevauche le décompte,
      // on colle la révélation juste avant le décompte.
      if (Number.isFinite(countdownStart) && candidate > countdownStart - 0.5) {
        candidate = countdownStart - 0.5;
      }

      // Filet de sécurité : on s'assure que la révélation commence
      // toujours *après* le début effectif de la question.
      if (candidate <= qStartEffective) {
        candidate = qStartEffective + 0.5;
      }

      revealStart = candidate;
    } else {
      // Cas de secours si jamais on n'a pas de qStartEffective (devrait être rare)
      revealStart = nextEvent - revealDurationSec;
    }
  }

  const isRoundIntroPhase = !uiMasked && Boolean(
    isFirstQuestionOfRound &&
    !isPaused &&
    !(isPaused && Number.isInteger(lastAutoPausedRoundIndex)) &&
    introStart != null &&
    elapsedSec >= introStart &&
    elapsedSec < (introEnd ?? -Infinity)
  );

  const isQuestionPhase = !uiMasked && Boolean(
    currentQuestion &&
    qStartEffective != null &&
    nextEvent != null &&
    elapsedSec >= qStartEffective &&
    elapsedSec < (revealStart ?? -Infinity) &&
    !isPaused &&
    !isRoundBreak
  );

  const isRevealAnswerPhase = !uiMasked && Boolean(
    currentQuestion &&
    (revealStart != null) &&
    (countdownStart != null) &&
    elapsedSec >= revealStart &&
    elapsedSec < countdownStart &&
    !isPaused &&
    !isRoundBreak
  );

  const isCountdownPhase = !uiMasked && Boolean(
    currentQuestion &&
    (countdownStart != null) &&
    (nextEvent != null) &&
    elapsedSec >= countdownStart &&
    elapsedSec < nextEvent &&
    !isPaused &&
    !isRoundBreak
  );

  /* ===== Attribution des points équipe : déclenchée immédiatement quand un award est créé ===== */
  useEffect(() => {
    const qid = currentQuestion?.id || null;
    if (!qid) return;

    // Écouter les awards pour cette question et déclencher l'attribution des points équipe immédiatement
    const awardsCol = collection(db, "answers", qid, "awards");
    let lastDocIds = new Set();
    
    // Initialiser avec les awards existants
    getDocs(awardsCol).then((snap) => {
      snap.docs.forEach(d => lastDocIds.add(d.id));
    }).catch((e) => {
      console.error("[Screen] Error initializing awards listener:", e);
    });

    const unsub = onSnapshot(awardsCol, (snap) => {
      // Détecter les nouveaux awards en comparant les IDs (plus fiable que le count)
      const currentDocIds = new Set(snap.docs.map(d => d.id));
      const newDocIds = Array.from(currentDocIds).filter(id => !lastDocIds.has(id));
      
      if (newDocIds.length > 0 && !awardGuardRef.current[qid]) {
        // Mettre à jour lastDocIds avant l'appel pour éviter les doubles détections
        lastDocIds = currentDocIds;
        
        awardGuardRef.current[qid] = "pending";
        // Appeler immédiatement (sans délai) pour accélérer l'attribution
        ensureAwardsForQuestionTx(db, qid).then(() => {
          // Succès, garder le guard pour éviter les doubles appels
          // Le guard sera réinitialisé quand on change de question
        }).catch((e) => {
          console.error("[Screen] awards TX error:", e);
          delete awardGuardRef.current[qid]; // autorise un retry si la TX échoue
        });
      } else if (snap.docs.length > 0) {
        // Mettre à jour lastDocIds même si on n'a pas déclenché d'appel
        lastDocIds = currentDocIds;
      }
    }, (e) => {
      console.error("[Screen] awards listener error:", e);
    });

    return () => {
      unsub();
      // Réinitialiser le guard quand on change de question
      delete awardGuardRef.current[qid];
    };
  }, [currentQuestion?.id]);

  /* ===== Attribution des points : déclenchée pendant la fenêtre de révélation (fallback) ===== */
  useEffect(() => {
    const qid = currentQuestion?.id || null;
    if (!qid) return;

    const inRevealWindow = isRevealAnswerPhase || isCountdownPhase;
    if (!inRevealWindow) return;

    // Anti double-run (par écran) pour ce qid
    if (awardGuardRef.current[qid]) return;
    awardGuardRef.current[qid] = "pending";

    ensureAwardsForQuestionTx(db, qid).catch((e) => {
      console.error("[Screen] awards TX error:", e);
      delete awardGuardRef.current[qid]; // autorise un retry si la TX échoue
    });
  }, [currentQuestion?.id, isRevealAnswerPhase, isCountdownPhase]);

  /* ---------------------- Variables d’UI dérivées ---------------------- */
  // Décompte (jamais 0s)
  const secondsToNext = nextEvent != null ? nextEvent - elapsedSec : null;
  const countdownSec = isCountdownPhase
    ? Math.max(1, Math.min(countdownStartSec, Math.ceil(secondsToNext)))
    : null;

  let countdownLabel = screenQuizMessages.nextQuestionIn;
  if (nextKind === "end") countdownLabel = screenQuizMessages.endOfQuizIn;
  if (nextKind === "round") {
    const endingIdx = Number.isFinite(nextEvent)
      ? roundIndexOfTime(Math.max(0, nextEvent - 0.001), roundOffsetsSec)
      : null;
    const base = screenQuizMessages.endOfRoundIn || screenPodiumMessages.endOfRound;
    countdownLabel = `${base} ${endingIdx != null ? endingIdx + 1 : ""} dans :`;
  }

  /** Évite le flash « Fin de manche + transition » entre le « 1 » et le podium */
  const holdRoundBoundaryCountdown =
    !uiMasked && inRoundBoundaryWindow && !isRoundBreak && !isPaused;
  const showCountdownUi = Boolean(isCountdownPhase || holdRoundBoundaryCountdown);
  const displayCountdownSec = holdRoundBoundaryCountdown
    ? 1
    : countdownSec;

  // Barre de progression
  const qEndLocal = nextEvent != null ? nextEvent - revealDurationSec : null;
  const canShowTimeBar = Boolean(
    isQuestionPhase && qStartEffective != null && qEndLocal != null && qEndLocal > qStartEffective
  );
  const progress = canShowTimeBar
    ? Math.min(1, Math.max(0, (elapsedSec - qStartEffective) / (qEndLocal - qStartEffective)))
    : 0;

  // Réponse principale affichée au reveal
  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);

  // Détecter si la réponse est courte (moins de 30 caractères) pour forcer une seule ligne
  // Exception : si elle contient ! ou ?, on permet les retours à la ligne après ces ponctuations
  const isShortAnswer = useMemo(() => {
    if (!primaryAnswer) return false;
    // Si la réponse contient ! ou ?, on ne force pas nowrap même si elle est courte
    if (/[!?]/.test(primaryAnswer)) return false;
    return primaryAnswer.length < 30;
  }, [primaryAnswer]);

  // URLs images (question / réponse) avec fallbacks :
  // - questionImgUrl : seulement les champs dédiés "image question" (jamais l'ancien 'image')
  // - answerImgUrl   : champs dédiés "image réponse", puis (legacy) 'imageUrl' / 'image'
  const questionImgUrl = useMemo(() => {
    const q = currentQuestion || {};
    // champs possibles côté Admin pour l'image de la question
    return (
      (typeof q.questionImageUrl === "string" && q.questionImageUrl.trim()) ||
      (typeof q.imageQuestionUrl === "string" && q.imageQuestionUrl.trim()) ||
      (typeof q.imageQuestion === "string" && q.imageQuestion.trim()) ||
      null
    );
  }, [currentQuestionId]);

  const answerImgUrl = useMemo(() => {
    const q = currentQuestion || {};
    // champs dédiés "image réponse", puis compat avec anciens champs
    return (
      (typeof q.answerImageUrl === "string" && q.answerImageUrl.trim()) ||
      (typeof q.imageReponseUrl === "string" && q.imageReponseUrl.trim()) ||
      (typeof q.imageReponse === "string" && q.imageReponse.trim()) ||
      (typeof q.imageUrl === "string" && q.imageUrl.trim()) || // legacy
      (typeof q.image === "string" && q.image.trim()) || // très legacy ("image" tout court)
      null
    );
  }, [currentQuestionId]);


  // Abonnement live aux 3 premiers joueurs ayant trouvé (pendant la phase question)
  useEffect(() => {
    // Reset à chaque nouvelle question ou si on sort de la phase "question"
    setLiveFirsts([]);
    const qid = currentQuestionId;
    if (!qid || !isQuestionPhase) return;

    // Helper local pour normaliser un temps en ms (comme dans ensureAwardsForQuestionTx)
    const toMs = (obj) => {
      if (!obj) return Infinity;
      if (typeof obj.toMillis === "function") return obj.toMillis();
      if (typeof obj.seconds === "number") {
        return obj.seconds * 1000 + Math.floor((obj.nanoseconds || obj.nanos || 0) / 1e6);
      }
      if (typeof obj === "number" && Number.isFinite(obj)) return Math.floor(obj);
      return Infinity;
    };

    try {
      const subsCol = collection(db, "answers", qid, "submissions");
      // ⚠️ Pas de orderBy ici (certains docs n'ont pas firstCorrectAt) → on trie côté client
      const q = query(subsCol, where("isCorrect", "==", true));
      const unsub = onSnapshot(q, (snap) => {
        const ranked = snap.docs
          .map((d) => {
            const data = d.data() || {};
            const t = Math.min(
              toMs(data.firstCorrectAt),
              typeof data.firstCorrectAtMs === "number" ? data.firstCorrectAtMs : Infinity,
              toMs(data.createdAt),
              toMs(data.updatedAt)
            );
            return { playerId: d.id, t };
          })
          .filter((x) => Number.isFinite(x.t))
          .sort((a, b) => a.t - b.t)
          .slice(0, 3);

        setLiveFirsts(ranked.map((x) => ({ playerId: x.playerId })));
      });
      return () => unsub();
    } catch (e) {
      console.error("[Screen] live podium subscription error:", e);
    }
  }, [currentQuestionId, isQuestionPhase]);



  // Infos attente
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;

  // Pré-start
  const showPreStart = !(quizStartMs && isRunning);

  // Watchdog de synchronisation :
  // si on reste coincé trop longtemps sans question alors que le quiz tourne,
  // on force un reload doux pour se recaler.
  useEffect(() => {
    const inSyncHole =
      isRunning &&
      !isPaused &&
      !isQuizEnded &&
      earliestTimeSec != null &&
      elapsedSec >= earliestTimeSec + 2 && // on laisse 2s de marge
      !currentQuestion;

    if (!inSyncHole) {
      if (syncHoleSince !== null) {
        setSyncHoleSince(null);
      }
      return;
    }

    // Première fois qu'on détecte le trou de synchro → on démarre le chrono
    if (syncHoleSince === null) {
      setSyncHoleSince(Date.now());
      return;
    }

    // Si ça dure plus de 5s → reload automatique
    const elapsedMs = Date.now() - syncHoleSince;
    if (elapsedMs > 5000) {
      try {
        window.location.reload();
      } catch {
        // no-op si le contexte ne permet pas le reload
      }
    }
  }, [
    isRunning,
    isPaused,
    isQuizEnded,
    earliestTimeSec,
    elapsedSec,
    currentQuestion,
    syncHoleSince,
  ]);


  // Variables spécifiques au leaderboard pendant reveal
  const currentQuestionIdForLB = currentQuestionId;
  const inRevealWindowForLB = Boolean(isRevealAnswerPhase || isCountdownPhase);

  // Préchargement image RÉPONSE (anti-flicker au reveal)
  useEffect(() => {
    const url = answerImgUrl;
    if (!url) return;

    const img = new Image();
    img.src = url;
    if (typeof img.decode === "function") {
      img.decode().catch(() => {});
    }
  }, [answerImgUrl, currentQuestionId]);

  // Préchargement image QUESTION (anti-flicker pendant la phase question)
  useEffect(() => {
    const url = questionImgUrl;
    if (!url) return;

    const img = new Image();
    img.src = url;
    if (typeof img.decode === "function") {
      img.decode().catch(() => {});
    }
  }, [questionImgUrl, currentQuestionId]);



  // UI mask : neutralise les transitions CSS le temps du voile
  useEffect(() => {
    if (!uiMasked) return;
    const tag = document.createElement("style");
    tag.setAttribute("data-ui-mask", "1");
    tag.textContent = `*{transition:none!important;animation:none!important}`;
    document.head.appendChild(tag);
    return () => { tag.remove(); };
  }, [uiMasked]);

  // ============================================================================
  // EleyBuzz Mode — Leaderboard (messages gérés côté Firestore par l'admin)
  // IMPORTANT: Ces hooks doivent être AVANT tous les early returns conditionnels
  // ============================================================================

  // Réinitialiser tous les états EleyBuzz locaux quand le mode est désactivé
  useEffect(() => {
    if (!isBuzzerMode) {
      setBuzzerMessage(null);
      setBuzzerMessageType(null);
    }
  }, [isBuzzerMode]);

  // Leaderboard EleyBuzz (trié par buzzScore)
  const buzzerLeaderboard = useMemo(() => {
    if (!isBuzzerMode) return [];
    
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => ({
        id: p.id,
        name: p.name || "",
        buzzScore: Number(p.buzzScore || 0),
        _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
      }))
      .sort((a, b) => {
        if (a.buzzScore !== b.buzzScore) return b.buzzScore - a.buzzScore;
        return a._nameKey.localeCompare(b._nameKey);
      });

    // Calcul des rangs avec égalités
    let lastScore = null;
    let lastRank = 0;
    rows.forEach((p, i) => {
      const sc = p.buzzScore;
      if (i === 0) {
        p._rank = 1;
        lastScore = sc;
        lastRank = 1;
      } else if (sc === lastScore) {
        p._rank = lastRank;
      } else {
        p._rank = i + 1;
        lastScore = sc;
        lastRank = p._rank;
      }
    });

    return rows;
  }, [isBuzzerMode, playersLB]);

  // Largeur bornée + retours à la ligne + descente légère
  // Aligné avec Player pour cohérence
  const screenQuestionStyle = {
    ...questionTextStyle,
    fontSize: "var(--eley-screen-text-question)",
    fontWeight: 800,
    lineHeight: 1.25,
    maxWidth: "min(920px, 95%)",
  };

  const screenRevealAnswerStyle = {
    ...screenQuestionStyle,
    margin: 0,
    fontSize: "var(--eley-screen-text-reveal-answer)",
    color: BRAND.yellow,
  };


  // ============================================================================
  // /pages/screen.js — Partie 4/5
  // Scope : RENDER — écrans pré-start / quiz (question, reveal, countdown),
  // pauses & fins de manche/quiz, colonne classement et panneaux "Rejoindre".
  // (⚠️ Ne PAS fermer la fonction ici — l'accolade finale arrive en partie 5.)
  // ============================================================================

  /* ============================ RENDER (PARTIE 4/4) ============================ */

  if (!stateLoaded || !configLoaded || !questionsLoaded) {
    return <Splash />; // plein écran de boot
  }

  // ============================================================================
  // EleyBuzz Mode — Early return si mode buzzer actif (priorité sur showPreStart)
  // ============================================================================
  if (isBuzzerMode) {
    // Priorité d'affichage : message « bravo » > états buzzer (idle/open/locked)
    const showingCorrectMessage = Boolean(
      buzzerMessage && buzzerMessageType === "correct"
    );

    return (
      <BrandShell
        style={SCREEN_SHELL_STYLE}
      >
        <ScreenSideDecor leftImageUrl={leftImageUrl} joinUrl={playerJoinUrl} />

        {/* Colonne centrale : Contenu EleyBuzz */}
        <div
          style={{
            flex: 1,
            padding: "40px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
            textAlign: "center",
            fontFamily: FONT_FAMILY,
          }}
        >
          <h1 style={{ fontSize: "clamp(1.5rem, 5vw, 2.2rem)", fontWeight: 800, margin: 0 }}>
            ⚡ EleyBuzz ⚡
          </h1>

          {/* État du buzzer — masqué pendant le message « bravo » */}
          {!showingCorrectMessage && buzzerState === BUZZER_STATES.IDLE && (
            <div 
              style={{ fontSize: "clamp(0.95rem, 3.5vw, 1.2rem)", maxWidth: "min(800px, 90%)", ...pageTextSecondary }}
              dangerouslySetInnerHTML={{ 
                __html: addSmartLineBreaks(screenEleyBuzzMessages.idle)
                  .replace(/\.\s+/g, ".<br>")
              }}
            />
          )}

          {!showingCorrectMessage && buzzerState === BUZZER_STATES.OPEN && (
            <div style={{ fontSize: "clamp(1rem, 3.5vw, 1.25rem)", color: BRAND.blue, fontWeight: 700 }}>
              Le buzzer est ouvert, préparez-vous à buzzer !
            </div>
          )}

          {!showingCorrectMessage && buzzerState === BUZZER_STATES.LOCKED && buzzerWinnerName && (
            <div>
              <div style={{ fontSize: "clamp(1.2rem, 4vw, 1.6rem)", fontWeight: 800, marginBottom: 8, color: BRAND.yellow, textShadow: `0 0 1px ${BRAND.mauveDark}` }}>
                {buzzerWinnerName} {screenEleyBuzzMessages.locked}
              </div>
              <div style={{ fontSize: "clamp(0.95rem, 3vw, 1.1rem)", ...pageTextSecondary }}>
                {screenEleyBuzzMessages.waitingAnswer}
              </div>
            </div>
          )}

          {/* Message « bravo » — priorité absolue */}
          {showingCorrectMessage && (
            <div
              style={{
                fontSize: "clamp(1.2rem, 4vw, 1.8rem)",
                fontWeight: 800,
                padding: "16px 28px",
                borderRadius: 12,
                ...badgeSuccess,
                animation: "fadeIn 200ms ease-in",
              }}
            >
              {buzzerMessage}
            </div>
          )}
        </div>

        {/* Colonne droite : Classement EleyBuzz */}
        <aside
          aria-label="Classement EleyBuzz"
          style={{
            width: 320,
            maxWidth: "clamp(280px, 30vw, 400px)",
            maxHeight: "calc(100vh - 24px)",
            ...asidePanelStyle,
            padding: "12px 12px 8px 12px",
            margin: 12,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignSelf: "flex-start",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: 0.2, color: BRAND.mauveDark }}>
                ⚡ EleyBuzz ⚡
              </h3>
            </div>

            {/* Petit bandeau bleu sous le titre */}
            <div
              style={{
                marginTop: 6,
                height: 3,
                borderRadius: 9999,
                background: BRAND.blue,
                border: `1px solid ${BRAND.mauveDark}`,
              }}
            />
          </div>

          <div
            role="list"
            style={{
              marginTop: 4,
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            {buzzerLeaderboard.length > 0 ? (
              buzzerLeaderboard.map((p) => {
                const rank = p._rank;
                const s = Number(p.buzzScore || 0);
                const medal = s > 0 && (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "");
                return (
                  <div
                    key={p.id}
                    role="listitem"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "28px 1fr auto",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderBottom: `1px solid ${BRAND.mauveLight}`,
                      background: rank <= 3 ? "rgba(254, 237, 106, 0.15)" : "transparent",
                    }}
                  >
                    <div style={{ textAlign: "right", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                      {rank}.
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span
                          title={p.name}
                          style={{
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {p.name || "(sans nom)"} {medal}
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        fontWeight: 800,
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: 0.2,
                        color: BRAND.yellow,
                      }}
                      aria-label="score"
                      title={`${p.buzzScore} points`}
                    >
                      {p.buzzScore}
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ opacity: 0.7, padding: 12, textAlign: "center" }}>
                {screenPodiumMessages.noPlayers}
              </div>
            )}
          </div>
        </aside>
      </BrandShell>
    );
  }

  // ============================================================================
  // Score Final Mode — Early return si mode score final actif
  // ============================================================================
  if (showFinalScore) {
    return (
      <BrandShell
        style={SCREEN_SHELL_STYLE}
      >
        <ScreenSideDecor leftImageUrl={leftImageUrl} joinUrl={playerJoinUrl} />

        <div style={SCREEN_MAIN_COLUMN}>
          <ScreenPodiumBlock opticalShift title={(
            <ScreenMultiline
              as="h1"
              text={screenPodiumMessages.finalEveningTitle}
              style={SCREEN_TITLE_XL}
            />
          )}
          >
            <ScreenPodiumContent
              view={leaderboardView}
              captionTeamsText={screenPodiumMessages.finalPodiumTeams}
              captionPlayersText={screenPodiumMessages.finalPodiumPlayers}
              podium={finalPodium}
              scoreKey="scoreFinal"
              emptyMessage={screenPodiumMessages.noPoints}
              footnote={screenPodiumMessages.quizEndThanks}
            />
          </ScreenPodiumBlock>
        </div>
      </BrandShell>
    );
  }

  // ============================================================================
  // Écran d'attente (showPreStart) — affiché seulement si EleyBuzz n'est pas actif
  // ============================================================================
  if (showPreStart) {
    return (
      <BrandShell
        style={SCREEN_SHELL_STYLE}
      >
        <ScreenSideDecor leftImageUrl={leftImageUrl} joinUrl={playerJoinUrl} />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <ScreenMultiline
            as="h1"
            text={screenAttenteMessages.title}
            style={{ ...SCREEN_TITLE_LG, marginBottom: 0 }}
          />
          <ScreenMultiline
            as="p"
            text={screenAttenteMessages.message}
            style={{ ...pageTextSecondary, marginTop: 12 }}
          />
        </div>
      </BrandShell>
    );
  }

  return (
    <BrandShell style={SCREEN_SHELL_STYLE}>
      {/* Voile anti-flicker */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "#000000",
          opacity: uiMasked ? 1 : 0,
          transition: "opacity 120ms ease",
          pointerEvents: "none",
          zIndex: 50,
        }}
      />

      <ScreenSideDecor leftImageUrl={leftImageUrl} joinUrl={playerJoinUrl} />

      <div style={SCREEN_MAIN_COLUMN}>
        {isQuizEnded ? (
          <ScreenPodiumBlock
            opticalShift
            title={<h1 style={SCREEN_TITLE_LG}>{screenPodiumMessages.endOfQuiz}</h1>}
          >
            <ScreenPodiumContent
              view={leaderboardView}
              captionTeamsText={screenPodiumMessages.finalPodiumTeams}
              captionPlayersText={screenPodiumMessages.finalPodiumPlayers}
              podium={podium}
              scoreKey="score"
              emptyMessage={screenPodiumMessages.noPoints}
              footnote={screenPodiumMessages.quizEndThanks}
            />
          </ScreenPodiumBlock>
        ) : isRoundBreak ? (
          <ScreenPodiumBlock
            opticalShift
            title={(
              <h1 style={SCREEN_TITLE_LG}>
                {screenRoundTitle(screenPodiumMessages.endOfRound, endedRoundIndex)}
              </h1>
            )}
          >
            <ScreenPodiumContent
              view={leaderboardView}
              captionTeamsText={screenPodiumMessages.provisionalPodiumTeams}
              captionPlayersText={screenPodiumMessages.provisionalPodiumPlayers}
              podium={podium}
              scoreKey="score"
              emptyMessage={screenPodiumMessages.noPointsYet}
              footnote={screenPodiumMessages.nothingDecided}
            />
          </ScreenPodiumBlock>
        ) : (
          <ScreenQuizStageBlock
            opticalShift
            alignTop={Boolean(currentQuestion && isQuestionPhase)}
          >
            {holdRoundBoundaryCountdown ? (
              <div style={SCREEN_STAGE_WRAP}>
                <div style={SCREEN_COUNTDOWN_LABEL}>{countdownLabel}</div>
                <div style={SCREEN_COUNTDOWN_NUMBER}>{displayCountdownSec}</div>
              </div>
            ) : isPaused ? (
              <div style={SCREEN_STAGE_WRAP}>
                <ScreenMultiline
                  as="h1"
                  text={screenQuizMessages.pauseTitle}
                  style={SCREEN_TITLE_LG}
                />
                <ScreenMultiline
                  as="div"
                  text={screenQuizMessages.pauseSubtitle}
                  style={{ ...pageTextSecondary, ...SCREEN_FOOTNOTE, marginTop: 8 }}
                />
              </div>
            ) : currentQuestion ? (
              <>
                {isRoundIntroPhase ? (
                  <div style={SCREEN_STAGE_WRAP}>
                    <div style={SCREEN_COUNTDOWN_LABEL}>
                      {roundNumberForIntro
                        ? `${screenQuizMessages.roundStarts} ${roundNumberForIntro} ${screenQuizMessages.roundStartsIn}`
                        : `${screenQuizMessages.roundStarts} ${screenQuizMessages.roundStartsIn}`}
                    </div>
                    <div style={SCREEN_COUNTDOWN_NUMBER}>
                      {introCountdownSec}
                    </div>
                  </div>
                ) : isQuestionPhase ? (
                  <div style={isQcmQuestion(currentQuestion) ? SCREEN_QCM_STAGE_WRAP : SCREEN_STAGE_WRAP}>
                    <h1
                      style={isQcmQuestion(currentQuestion) ? SCREEN_QCM_QUESTION_STYLE : screenQuestionStyle}
                      dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
                    />
                    {isQcmQuestion(currentQuestion) ? (
                      <div style={SCREEN_QCM_GRID}>
                        {getQcmOptionsForDisplay(currentQuestion).map((opt, idx) =>
                          opt ? (
                            <div key={idx} style={SCREEN_QCM_OPTION}>
                              {opt}
                            </div>
                          ) : null
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : isRevealAnswerPhase ? (
                  <div style={SCREEN_STAGE_WRAP}>
                    <div style={SCREEN_REVEAL_LABEL}>
                      {screenQuizMessages.revealAnswer}
                    </div>
                    <h1
                      style={{
                        ...screenRevealAnswerStyle,
                        whiteSpace: isShortAnswer ? "nowrap" : "normal",
                        maxWidth: isShortAnswer ? "none" : "min(1600px, 95%)",
                        marginLeft: "auto",
                        marginRight: "auto",
                        overflowWrap: isShortAnswer ? "normal" : "break-word",
                        wordBreak: "normal",
                        hyphens: "none",
                        textAlign: "center",
                        letterSpacing: "0.01em",
                      }}
                      dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(primaryAnswer) }}
                    />
                  </div>
                ) : showCountdownUi ? (
                  <div style={SCREEN_STAGE_WRAP}>
                    <div style={SCREEN_COUNTDOWN_LABEL}>
                      {countdownLabel}
                    </div>
                    <div style={SCREEN_COUNTDOWN_NUMBER}>
                      {displayCountdownSec}
                    </div>
                  </div>
                ) : (
                  <div style={SCREEN_STAGE_WRAP}>
                    <h1
                      style={screenQuestionStyle}
                      dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
                    />
                  </div>
                )}

                {isQuestionPhase && questionImgUrl ? (
                  <div
                    style={{
                      width: SCREEN_IMG_MAX,
                      height: SCREEN_IMG_MAX,
                      maxWidth: "100%",
                      margin: isQcmQuestion(currentQuestion) ? "8px auto 4px" : "16px auto 8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: IMAGE_FRAME_BG,
                      border: SCREEN_ON_DARK_BORDER,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    <img
                      src={questionImgUrl}
                      alt="Indice visuel — question"
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        imageRendering: "auto",
                      }}
                      loading="eager"
                      decoding="async"
                    />
                  </div>
                ) : null}

                {canShowTimeBar && (
                  <div
                    style={{
                      width: "min(700px, 92%)",
                      height: BAR_H,
                      margin: (isQuestionPhase && isQcmQuestion(currentQuestion))
                        ? "8px auto 6px"
                        : "12px auto 10px",
                      background: BAR_BLUE,
                      borderRadius: 9999,
                      overflow: "hidden",
                      position: "relative",
                      visibility: uiMasked ? "hidden" : "visible",
                    }}
                  >
                    <div
                      style={{
                        width: `${(progress * 100).toFixed(2)}%`,
                        height: "100%",
                        background: BAR_RED,
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: `calc(${(progress * 100).toFixed(2)}% - 1px)`,
                        top: -2,
                        bottom: -2,
                        width: 2,
                        background: HANDLE_COLOR,
                        opacity: 0.9,
                      }}
                    />
                  </div>
                )}

                {isQuestionPhase && (
                  <ScreenQuestionLiveSlot
                    liveFirsts={liveFirsts}
                    playersById={playersById}
                    scoringTable={scoringTable}
                    captionText={screenQuizMessages.congratsTo}
                  />
                )}

                {isRevealAnswerPhase && answerImgUrl ? (
                  <div
                    style={{
                      width: SCREEN_IMG_MAX,
                      height: SCREEN_IMG_MAX,
                      maxWidth: "100%",
                      margin: "16px auto",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: IMAGE_FRAME_BG,
                      border: SCREEN_ON_DARK_BORDER,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    <img
                      src={answerImgUrl}
                      alt="Révélation — œuvre"
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        imageRendering: "auto",
                      }}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <div style={SCREEN_STAGE_WRAP}>
                {!isRunning && <p style={SCREEN_SECONDARY_TEXT}>{screenQuizMessages.waiting}</p>}
                {isRunning && earliestTimeSec != null && elapsedSec < earliestTimeSec && (
                  <p style={SCREEN_SECONDARY_TEXT}>
                    {screenQuizMessages.waitingFirstQuestion} {formatHMS(earliestTimeSec)})…
                  </p>
                )}
                {isRunning && earliestTimeSec == null && (
                  <p style={SCREEN_SECONDARY_TEXT}>{screenQuizMessages.noQuestions}</p>
                )}
                {isRunning && earliestTimeSec != null && elapsedSec >= earliestTimeSec && !currentQuestion && (
                  <p style={SCREEN_SECONDARY_TEXT}>{screenQuizMessages.syncing}</p>
                )}
              </div>
            )}
          </ScreenQuizStageBlock>
        )}
      </div>

      {/* ===== Colonne scores (droite) ===== */}
      {/* Cachée quand showFinalScore est actif */}
      {!showFinalScore && (
      <aside
        aria-label="Classement"
        style={{
          width: 320,
          maxWidth: "clamp(280px, 30vw, 400px)",
          maxHeight: "calc(100vh - 24px)",
          position: "relative",
          zIndex: 3,
          flexShrink: 0,
          ...asidePanelStyle,
          padding: "12px 12px 8px 12px",
          margin: 12,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignSelf: "flex-start",
        }}
      >

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: 0.2, color: BRAND.mauveDark }}>
              <ScreenRankingAsideTitle view={leaderboardView} />
            </h3>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              {screenPodiumMessages.topN} {Number.isFinite(leaderboardTopN) ? leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N}
            </div>
          </div>

          {/* Petit bandeau bleu sous le titre "Classement / Top N" */}
          <div
            style={{
              marginTop: 6,
              height: 3,
              borderRadius: 9999,
              background: BRAND.blue,
              border: `1px solid ${BRAND.mauveDark}`,
            }}
          />
        </div>


        <div
          role="list"
          style={{
            marginTop: 4,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          {leaderboard.map((p, idx) => {
            const rank = Number(p._rank ?? (idx + 1));
            const s = Number(p.score || 0);
            const showTeamTrophy = s > 0 && rank <= 3 && leaderboardView === "teams";
            const showPlayerRankCircle = s > 0 && rank <= 3 && leaderboardView === "players";
            const showDelta = Boolean(
              inRevealWindowForLB &&
              currentQuestionIdForLB &&
              p.lastDeltaForQuestionId === currentQuestionIdForLB &&
              Number(p.lastDelta) > 0
            );

            const dotColor = (() => {
              if (leaderboardView === "teams") {
                const team = teamsLB.find((t) => t.id === p.id);
                return team?.color || "#64748b";
              }
              const player = playersLB.find((pl) => pl.id === p.id);
              if (player?.teamId) {
                const team = teamsLB.find((t) => t.id === player.teamId);
                return team?.color || player.color || "#64748b";
              }
              return player?.color || "#64748b";
            })();
            const nameColor = leaderboardView === "teams"
              ? (teamsLB.find((t) => t.id === p.id)?.color || BRAND.mauveDark)
              : BRAND.mauveDark;

            return (
              <div
                key={p.id}
                role="listitem"
                style={{
                  display: "grid",
                  ...SCREEN_LB_ROW,
                  alignItems: "center",
                  borderBottom: `1px solid ${BRAND.mauveLight}`,
                }}
              >
                <div style={{ textAlign: "right", opacity: 0.85, fontVariantNumeric: "tabular-nums", color: BRAND.mauveDark }}>
                  {rank}.
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 24 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        ...SCREEN_LB_DOT,
                        background: dotColor,
                        border: `1px solid ${BRAND.mauveDark}`,
                      }}
                    />
                    <span
                      title={p.name}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        color: nameColor,
                      }}
                    >
                      {p.name || "(sans nom)"}
                    </span>
                    <span aria-hidden="true" style={SCREEN_LB_TRAIL_ICON}>
                      {showTeamTrophy ? <TeamTrophyIcon rank={rank} size={20} teamColor={dotColor} /> : null}
                      {showPlayerRankCircle ? <PlayerRankCircle rank={rank} size={20} /> : null}
                    </span>
                  </div>

                  {showDelta && (
                    <span
                      style={{
                        display: "inline-block",
                        marginTop: 4,
                        padding: "2px 6px",
                        borderRadius: 9999,
                        background: BRAND.green,
                        border: `1px solid ${BRAND.mauveDark}`,
                        color: BRAND.mauveDark,
                        fontSize: 12,
                        fontWeight: 800,
                      }}
                    >
                      +{p.lastDelta}
                    </span>
                  )}
                </div>

                <div
                  style={{
                    fontWeight: 800,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: 0.2,
                    color: nameColor,
                  }}
                  aria-label="score"
                  title={`${p.score} points`}
                >
                  {Number(p.score || 0)}
                </div>
              </div>
            );
          })}

          {leaderboard.length === 0 && (
            <div style={{ opacity: 0.7, padding: 12, textAlign: "center" }}>
              {screenPodiumMessages.noPlayers}
            </div>
          )}
        </div>
      </aside>
      )}
    </BrandShell>
  );
}

export default function Screen() {
  return (
    <AuthGate
      title="Accès écran scène"
      subtitle="Réservé à l'écran de projection du quiz."
      accent={BRAND.blue}
    >
      <ScreenInner />
    </AuthGate>
  );
}
