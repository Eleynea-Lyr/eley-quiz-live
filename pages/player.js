// ============================================================================
// /pages/player.js — Refactoré avec imports depuis /lib
// Scope : Vue joueur avec inscription, réponses temps réel, scoring instantané
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { db, auth } from "../lib/firebase";
import { signInAnonymously, signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  updateDoc,
  where,
  serverTimestamp,
} from "firebase/firestore";

// Imports depuis les fichiers utilitaires
import {
  REVEAL_DURATION_SEC,
  COUNTDOWN_START_SEC,
  ROUND_START_INTRO_SEC,
  ROUND_BOUNDARY_GAP_SEC,
  UI_MASK_MS,
  RATE_LIMIT_ENABLED,
  MAX_WRONG_ATTEMPTS,
  RATE_LIMIT_WINDOW_MS,
  COOLDOWN_MS,
  LOCK_PHRASES,
  BAR_H,
  SAFE_TOP,
  TOP_GUTTER_RUNNING,
  TOP_GUTTER_IDLE,
  BUZZER_STATES,
  DEFAULT_BUZZER_POINTS,
  DEFAULT_SCORING_TABLE,
  FAIR_BUZZ_WINDOW_MS,
} from "../lib/constants";

import {
  getTimeSec,
  formatHMS,
  normalizeName,
  normalizeNameAlpha,
  roundIndexOfTime,
  nextRoundStartAfter,
  matchesWithMode,
  getAnswerMode,
  isAliasName,
  validateName,
  validateTeamName,
  normalizeTeamName,
  messageForRank,
  addSmartLineBreaks,
} from "../lib/utils";

import {
  useMobileVH,
  recordFirstCorrectAndPredict,
  registerBuzzerPress,
  resolveBuzzFairWindow,
  recordQcmWrongChoice,
  createTeamTx,
  joinTeamTx,
  leaveTeamTx,
} from "../lib/firebase-helpers";

import {
  ELEYBUZZ_PLAYER_MESSAGES,
  PLAYER_PAGE_CREATION_JOUEUR,
  PLAYER_PAGE_EQUIPE,
  PLAYER_PAGE_CREATION_EQUIPE,
  PLAYER_PAGE_REJOINDRE_EQUIPE,
  PLAYER_PAGE_ATTENTE,
  PLAYER_PAGE_FIN,
  PLAYER_PAGE_QUIZ,
  SCREEN_MESSAGES,
  mergePageMessages,
  formatMsg,
} from "../lib/messages";

import {
  isQcmQuestion,
  getQcmCorrectIndex,
  getQcmOptionsForDisplay,
  getShuffledQcmIndices,
} from "../lib/qcm";
import {
  BRAND,
  BRAND_PAGE_BOTTOM,
  IMAGE_FRAME_BG,
  FONT_FAMILY,
  BAR_BLUE,
  BAR_RED,
  HANDLE_COLOR,
  badgeSuccess,
  badgeError,
  cardStyle,
  questionTextStyle,
  BUZZER_BLUE_PRESSED,
  pageTextSecondary,
  PAGE_TEXT,
  btnPrimaryStyle,
  btnSecondaryStyle,
  btnDangerStyle,
  btnGhostDangerStyle,
  inputFieldStyle,
} from "../lib/brand-theme";
import BrandShell from "../lib/BrandShell";
import { getTeamBadgeStyle } from "../lib/team-color";
import PlayerScorePanel from "../lib/PlayerScorePanel";
import PlayerRoundBreakPanel from "../lib/PlayerRoundBreakPanel";
import PlayerCorrectPointsFeedback from "../lib/PlayerCorrectPointsFeedback";

// ---------------------------------------------------------------------------
// Splash (écran neutre, plein écran, fond homogène)
// ---------------------------------------------------------------------------
function Splash() {
  return <BrandShell aria-hidden="true" />;
}

function HudTeamStar({ size, style = {} }) {
  const dim = size ?? "var(--eley-hud-icon)";
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block", ...style }}
    >
      <path
        fill={BRAND.orangeLight}
        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
      />
    </svg>
  );
}

function HudPlayerIcon({ size, style = {} }) {
  const dim = size ?? "var(--eley-hud-icon)";
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block", ...style }}
    >
      <path
        fill={BRAND.yellow}
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      />
    </svg>
  );
}

const PLAYER_SHELL_PAD = {
  padding: "var(--eley-shell-pad)",
  paddingTop: `calc(var(--eley-shell-pad) + env(safe-area-inset-top, 0px))`,
  paddingBottom: `calc(var(--eley-shell-pad) + env(safe-area-inset-bottom, 0px))`,
  minHeight: "max(100dvh, calc(var(--vh, 1vh) * 100))",
  overflowX: "hidden",
};

const PLAYER_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--eley-title-page)",
  fontWeight: 800,
  lineHeight: 1.12,
};

const PLAYER_HINT_STYLE = {
  opacity: 0.9,
  margin: "0 0 10px",
  fontSize: "var(--eley-text-hint)",
  fontWeight: 600,
  textAlign: "left",
};

function PlayerLabelWithIcon({ children }) {
  return (
    <p style={{ ...PLAYER_HINT_STYLE }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <HudPlayerIcon size="var(--eley-icon-label)" />
        <span>{children}</span>
      </span>
    </p>
  );
}

function TitleWithTrailingStar({ text, starSize = "0.78em" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.35em",
        flexWrap: "wrap",
      }}
    >
      <span>{text}</span>
      <HudTeamStar size={starSize} />
    </span>
  );
}

function PlayerPageShell({ titleLine1, titleLine2, titleLine2Icon, children }) {
  const titleLine2Trimmed = String(titleLine2 ?? "").trim();
  const showTeamStar = titleLine2Icon === "star";

  const renderTitleText = (text, withStar) => (
    withStar ? <TitleWithTrailingStar text={text} /> : text
  );

  return (
    <BrandShell
      style={{
        display: "flex",
        flexDirection: "column",
        ...PLAYER_SHELL_PAD,
      }}
    >
      <div
        style={{
          position: "relative",
          zIndex: 3,
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          minHeight: 0,
        }}
      >
        <h1 style={PLAYER_TITLE_STYLE}>
          {titleLine2Trimmed ? (
            <>
              {titleLine1}
              <br />
              {renderTitleText(titleLine2Trimmed, showTeamStar)}
            </>
          ) : (
            renderTitleText(titleLine1, showTeamStar)
          )}
        </h1>
      </div>
      <div
        style={{
          position: "relative",
          zIndex: 3,
          width: "min(var(--eley-content-narrow), 100%)",
          maxWidth: "100%",
          margin: "0 auto",
          flexShrink: 0,
        }}
      >
        {children}
      </div>
      <div style={{ flex: 1, minHeight: 0 }} aria-hidden="true" />
    </BrandShell>
  );
}

/** Contenu centré verticalement au milieu de l'écran (pause, comptes à rebours) */
function PlayerCenterStage({ children }) {
  return (
    <>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          width: "100%",
          minHeight: 0,
        }}
      >
        <div style={{ width: "100%", maxWidth: "min(var(--eley-center-stage-max), 92vw)", margin: "0 auto" }}>
          {children}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }} aria-hidden="true" />
    </>
  );
}

const PLAYER_TITLE_HEADER = {
  width: "100%",
  textAlign: "center",
  flexShrink: 0,
};

/** Podium / scores — centrés, légèrement remontés (fin de manche, fin de quiz) */
const PLAYER_PODIUM_CENTER = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  minHeight: 0,
  paddingBottom: "var(--eley-podium-block-lift)",
  textAlign: "center",
};

function teamPrimaryBtnStyle({ busy, disabled }) {
  return {
    ...btnPrimaryStyle,
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    display: "block",
    padding: "var(--eley-btn-pad-y) var(--eley-btn-pad-x)",
    background: busy ? BRAND.yellow : disabled ? BRAND.mauveLight : BRAND.blue,
    color: busy ? BRAND.mauveDark : "#ffffff",
    cursor: busy || disabled ? "not-allowed" : "pointer",
  };
}

function teamDangerBtnStyle({ busy, disabled }) {
  return {
    ...btnDangerStyle,
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    display: "block",
    padding: "var(--eley-btn-pad-y) var(--eley-btn-pad-x)",
    background: busy ? BRAND.yellow : BRAND.red,
    color: busy ? BRAND.mauveDark : "#ffffff",
    cursor: busy || disabled ? "not-allowed" : "pointer",
  };
}

// ---------------------------------------------------------------------------
// Reset complet de l'état "par joueur / par question"
// ---------------------------------------------------------------------------
function resetRuntimeForPlayer({
  answeredAtRef,
  lastAnswerQidRef,
  lastInstantWinQidRef,
  setInstantWin,
  setResult,
  setAnswer,
  setWrongTimes,
  setCooldownUntilMs,
  setLockPhraseIndex,
}) {
  if (answeredAtRef?.current) answeredAtRef.current = {};
  if (lastAnswerQidRef) lastAnswerQidRef.current = null;
  if (lastInstantWinQidRef) lastInstantWinQidRef.current = null;

  // États UI
  setInstantWin?.(null);
  setResult?.(null);
  setAnswer?.("");
  setWrongTimes?.([]);
  setCooldownUntilMs?.(null);
  setLockPhraseIndex?.(null);
}

// ============================================================================
// /pages/player.js — Partie 2/6
// Scope : État React + abonnements Firestore + timers (boot, joueur, quiz, config,
//         leaderboard, correction d’horloge serveur, rAF timer).
// ============================================================================

/* Partie 2/4 — état React + abonnements Firestore + timers*/

/* =============================== COMPOSANT =============================== */

export default function Player() {
  useMobileVH();

  // Anti-sélection / anti long-press sur toute la page Player (sauf inputs)
  useEffect(() => {
    document.body.classList.add("eley-player-page");
    return () => document.body.classList.remove("eley-player-page");
  }, []);

  /* ======================= ÉTATS & RÉFS (TOP-LEVEL) ======================= */

  const lastNavSeqRef = useRef(null);
  const uiFreezeUntilRef = useRef(0);
  const playerReloadSeqRef = useRef(null);

  // Mémo: ce joueur a répondu pour la 1ʳᵉ fois *après* le dernier Back sur ce qid
  const answeredAfterBackRef = useRef({}); // { [qid]: boolean }

  // Leaderboard (fin de quiz)
  const [playersLB, setPlayersLB] = useState([]);
  const [teamsLB, setTeamsLB] = useState([]);

  // Id local (persisté)
  const myIdRef = useRef(null);
  useEffect(() => {
    try {
      myIdRef.current =
        localStorage.getItem("playerId") ||
        localStorage.getItem("playerID") ||
        localStorage.getItem("player_id") ||
        null;
    } catch { }
  }, []);

  // Identité Firebase (connexion anonyme) — sert d'identifiant fiable pour le joueur.
  // L'uid devient l'id du document joueur, ce qui permet aux règles Firestore de
  // garantir qu'un joueur ne modifie QUE son propre document.
  const authUidRef = useRef(null);
  const authReadyRef = useRef(null);

  // Attend que Firebase ait fini de restaurer une éventuelle session persistée
  // (IMPORTANT : évite de se connecter en anonyme trop tôt et d'écraser une
  // session existante — ex. l'admin connecté dans le même navigateur).
  const waitForAuthReady = () => {
    if (!authReadyRef.current) {
      authReadyRef.current = new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, (u) => {
          unsub();
          resolve(u);
        });
      });
    }
    return authReadyRef.current;
  };

  const ensureAuth = async () => {
    const restored = await waitForAuthReady();
    if (restored?.uid) {
      authUidRef.current = restored.uid;
      return restored.uid;
    }
    if (auth.currentUser?.uid) {
      authUidRef.current = auth.currentUser.uid;
      return auth.currentUser.uid;
    }
    const cred = await signInAnonymously(auth);
    authUidRef.current = cred.user.uid;
    return cred.user.uid;
  };

  /**
   * Nouvelle identité Firebase anonyme.
   * Important : vider les cookies ne déconnecte PAS Firebase (IndexedDB).
   * Sans signOut, « nouveau joueur » réutilise le même uid et écrase le doc
   * encore ouvert sur un autre device.
   */
  const ensureFreshAnonymousAuth = async () => {
    try {
      await signOut(auth);
    } catch {
      /* ignore */
    }
    authUidRef.current = null;
    authReadyRef.current = null;
    const cred = await signInAnonymously(auth);
    authUidRef.current = cred.user.uid;
    return cred.user.uid;
  };

  useEffect(() => {
    ensureAuth().catch((e) =>
      console.error("[Player] Connexion anonyme échouée :", e)
    );
  }, []);

  // Instant win (affichage immédiat + anti double-appel)
  const [instantWin, setInstantWin] = useState(null);
  const [questionTeamAward, setQuestionTeamAward] = useState(null);
  const lastInstantWinQidRef = useRef(null);
  const questionCorrectCountRef = useRef({});

  // Boot flags
  const [hydrated, setHydrated] = useState(false);              // localStorage lu
  const [stateLoaded, setStateLoaded] = useState(false);        // 1er /quiz/state reçu
  const [playerDocLoaded, setPlayerDocLoaded] = useState(false);// 1er doc joueur reçu
  const [configLoaded, setConfigLoaded] = useState(false);      // 1er /quiz/config reçu (messages)
  const [splashReleased, setSplashReleased] = useState(false);  // Splash affiché 1x

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
  const [cooldownMs, setCooldownMs] = useState(COOLDOWN_MS);
  const [buzzerPoints, setBuzzerPoints] = useState(DEFAULT_BUZZER_POINTS);
  const [activeQuizKey, setActiveQuizKey] = useState(null);
  const [scoringTable, setScoringTable] = useState(DEFAULT_SCORING_TABLE);

  // Joueur / inscription
  const [playerId, setPlayerId] = useState(null);
  const [playerName, setPlayerName] = useState("");
  const [inputName, setInputName] = useState("");
  const [nameLocked, setNameLocked] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isKicked, setIsKicked] = useState(false);
  const [rejectedNames, setRejectedNames] = useState([]);
  const selfRenameRef = useRef(false); // true si le joueur a déclenché un renommage
  const welcomeInputRef = useRef(null);

  // Équipe
  const [teamId, setTeamId] = useState(null);
  const [teamName, setTeamName] = useState("");
  const [teamColor, setTeamColor] = useState(null); // Couleur de l'équipe
  const [teamMemberCount, setTeamMemberCount] = useState(0); // Nombre de membres dans l'équipe
  const [teamQuizScore, setTeamQuizScore] = useState(0); // Score équipe quiz
  const [needsTeamSelection, setNeedsTeamSelection] = useState(false);
  const [teamInputName, setTeamInputName] = useState("");
  const [availableTeams, setAvailableTeams] = useState([]);
  const [teamSelectionMode, setTeamSelectionMode] = useState(null); // "create" | "join" | null
  const [teamSearchQuery, setTeamSearchQuery] = useState(""); // Pour filtrer les équipes

  // Sentinelle fin de manche (posée côté Admin)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Réponse / saisie
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
  const [qcmFailed, setQcmFailed] = useState(false);
  const [qcmBusy, setQcmBusy] = useState(false);
  const answerInputRef = useRef(null);
  const lastAnswerQidRef = useRef(null); // sécurité anti-stale

  // Horodatage (elapsedSec) de la 1ʳᵉ bonne réponse par question
  const answeredAtRef = useRef({}); // { [qid]: number }

  // ---- Détection Back (rewind) ----
  const prevElapsedSecRef = useRef(null);
  const prevQuestionIdRef = useRef(null);
  const prevQidRef = useRef(null);
  // Mémo Back : question concernée + si le joueur avait DÉJÀ trouvé avant le Back
  const backInfoRef = useRef({ lastBackQid: null, hadCorrectBeforeBack: false });
  const [backTick, setBackTick] = useState(0); // force un re-render lors d'un Back

  // Reset complet de la session locale (utilisé après un reset Admin + nouveau join)
  const resetLocalSessionState = () => {
    // Oublier toutes les questions pour lesquelles on avait déjà bien répondu
    answeredAtRef.current = {};

    // Oublier les infos de "Back" (question précédente, médaille, etc.)
    prevElapsedSecRef.current = null;
    prevQuestionIdRef.current = null;
    prevQidRef.current = null;
    backInfoRef.current = { lastBackQid: null, hadCorrectBeforeBack: false };

    // Forcer un petit "tick" pour invalider les dérivés éventuels du Back
    setBackTick((x) => x + 1);
    setQcmFailed(false);
  };

  // Anti-spam
  const [wrongTimes, setWrongTimes] = useState([]); // timestamps ms des erreurs
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [lockPhraseIndex, setLockPhraseIndex] = useState(null);

  // EleyBuzz state
  const [isBuzzerMode, setIsBuzzerMode] = useState(false);
  const [buzzerState, setBuzzerState] = useState("idle");
  const [firstPlayerId, setFirstPlayerId] = useState(null);
  const [canBuzz, setCanBuzz] = useState(true);
  const [buzzerMessage, setBuzzerMessage] = useState(null);
  const [buzzerMessageType, setBuzzerMessageType] = useState(null);
  const [lastWrongPenalty, setLastWrongPenalty] = useState(null);
  // En attente locale après un tap (bleu) — le gagnant jaune vient UNIQUEMENT de Firestore
  const [isBuzzing, setIsBuzzing] = useState(false);
  const buzzerOpenSeqRef = useRef(0);
  const buzzerStateRef = useRef("idle");
  const fairBuzzTimerRef = useRef(null);

  // Score Final state
  const [showFinalScore, setShowFinalScore] = useState(false);
  const [finalPodiumTitle, setFinalPodiumTitle] = useState(SCREEN_MESSAGES.finalPodiumTitle);

  // Messages personnalisables depuis Firestore
  const [playerNomJoueurMessages, setPlayerNomJoueurMessages] = useState(PLAYER_PAGE_CREATION_JOUEUR);
  const [playerEquipeMessages, setPlayerEquipeMessages] = useState(PLAYER_PAGE_EQUIPE);
  const [playerCreationEquipeMessages, setPlayerCreationEquipeMessages] = useState(PLAYER_PAGE_CREATION_EQUIPE);
  const [playerRejoindreEquipeMessages, setPlayerRejoindreEquipeMessages] = useState(PLAYER_PAGE_REJOINDRE_EQUIPE);
  const [playerAttenteMessages, setPlayerAttenteMessages] = useState(PLAYER_PAGE_ATTENTE);
  const [playerFinMessages, setPlayerFinMessages] = useState(PLAYER_PAGE_FIN);
  const [playerQuizMessages, setPlayerQuizMessages] = useState(PLAYER_PAGE_QUIZ);
  const [playerEleyBuzzMessages, setPlayerEleyBuzzMessages] = useState(ELEYBUZZ_PLAYER_MESSAGES);

  // Reset déclenché via URL ?reset=1 (avant start)
  const pendingResetRef = useRef(false);

  // Offset horloge serveur ← d.serverNow (écrit par Admin)
  const serverDeltaRef = useRef(0);        // ms
  const [serverDeltaTick, setServerDeltaTick] = useState(0); // force un léger re-render si besoin

  /* =============================== EFFECTS =============================== */

  // 1) Charger identité locale + cache rejets + gestion param ?reset=1
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("reset") === "1") {
      pendingResetRef.current = true;
      url.searchParams.delete("reset");
      window.history.replaceState({}, "", url.toString());
    } else {
      const pid = localStorage.getItem("playerId");
      const pname = localStorage.getItem("playerName");
      if (pid) setPlayerId(pid);
      if (pname) setPlayerName(pname);
    }

    try {
      const raw = localStorage.getItem("rejectedNamesCache");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setRejectedNames(arr);
      }
    } catch { }
    setHydrated(true);
  }, []);

  // 2) Si ?reset=1 et quiz pas lancé → autoriser rename (suppr doc + reset local)
  useEffect(() => {
    if (!pendingResetRef.current) return;
    if (isRunning) {
      pendingResetRef.current = false; // quiz lancé → ignorer
      return;
    }
    pendingResetRef.current = false;
    resetAndDeletePlayer();
  }, [isRunning]);

  // 3) Suivre mon doc joueur (kick, nom, rejectedNames, lock)
  useEffect(() => {
    if (!playerId) return;

    const playersCol = collection(doc(db, "quiz", "state"), "players");
    const ref = doc(playersCol, playerId);

    const unsub = onSnapshot(ref, (snap) => {
      if (!snap.exists()) {
        const selfInitiated = selfRenameRef.current === true;
        selfRenameRef.current = false;

        localStorage.removeItem("playerId");
        localStorage.removeItem("playerName");
        startTransition(() => {
          setPlayerId(null);
          setPlayerName("");
          setInputName("");
          setError("");
          setIsKicked(false);
          setTeamId(null);
          setTeamName("");
          setTeamColor(null);
          setTeamMemberCount(0);
          setTeamQuizScore(0);
          setNeedsTeamSelection(false);
          setCanBuzz(true);
          setIsBuzzing(false);
          setBuzzerState("idle");
          setFirstPlayerId(null);
        });
        if (fairBuzzTimerRef.current != null) {
          clearTimeout(fairBuzzTimerRef.current);
          fairBuzzTimerRef.current = null;
        }
        if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        if (!selfInitiated) {
          localStorage.removeItem("rejectedNamesCache");
          startTransition(() => setRejectedNames([]));
        }
        // Remise à zéro locale pour éviter "déjà répondu" après reset
        resetRuntimeForPlayer({
          answeredAtRef,
          lastAnswerQidRef,
          lastInstantWinQidRef,
          setInstantWin,
          setResult,
          setAnswer,
          setWrongTimes,
          setCooldownUntilMs,
          setLockPhraseIndex,
        });
        return;
      }

      const d = snap.data() || {};

      // Si le nom est refusé, permettre au joueur de changer son nom sur la même ligne
      if (d.nameStatus === "rejected") {
        startTransition(() => {
          setIsKicked(false);
          setError("Nom refusé : trouve un autre nom plus adapté à la soirée :)");
          setInputName("");
          // Ne pas réinitialiser playerId ni playerName pour garder les scores
          // Le joueur pourra changer son nom via handleNameSubmit
        });
        // Ne pas supprimer playerId du localStorage pour conserver les scores
        return; // Sortir tôt pour éviter de mettre à jour playerName avec le nom refusé
      }

      startTransition(() => {
        setIsKicked(!!d.isKicked);
        if (d.isKicked) {
          setError("Vous avez été retiré de la partie.");
        } else {
          setError("");
        }
      });

      // Ne mettre à jour playerName que si le nom est accepté (pas refusé)
      if (typeof d.name === "string") {
        startTransition(() => {
          setPlayerName(d.name);
        });
        localStorage.setItem("playerName", d.name);
      }
      startTransition(() => setNameLocked(!!d.nameLocked));

      // EleyBuzz: canBuzz depuis le doc joueur
      // IMPORTANT: Si canBuzz est undefined/null, on considère qu'il est true (par défaut)
      // Cela permet aux nouveaux joueurs de buzzer immédiatement
      const canBuzzValue = d.canBuzz;
      startTransition(() => {
        // Si canBuzz est explicitement false, on le respecte
        // Sinon (undefined, null, true), on considère qu'il est true
        setCanBuzz(canBuzzValue !== false);
      });
      
      // Lire la dernière pénalité appliquée pour l'affichage
      const penaltyValue = Number.isFinite(d.lastWrongPenalty) ? d.lastWrongPenalty : null;
      startTransition(() => {
        setLastWrongPenalty(penaltyValue);
      });

      let serverRejected = Array.isArray(d.rejectedNames) ? d.rejectedNames : [];
      const isAliasNameLocal = (raw) => /^player\s*\d+$/i.test(String(raw || "").trim());
      serverRejected = serverRejected.filter((n) => !isAliasNameLocal(n));

      let prev = [];
      try {
        const raw = localStorage.getItem("rejectedNamesCache");
        prev = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(prev)) prev = [];
      } catch {
        prev = [];
      }
      const union = Array.from(new Set([...prev.filter((n) => !isAliasNameLocal(n)), ...serverRejected]));
      localStorage.setItem("rejectedNamesCache", JSON.stringify(union));
      startTransition(() => setRejectedNames(union));

      // Charger l'équipe du joueur
      const playerTeamId = d.teamId || null;
      if (playerTeamId) {
        setTeamId(playerTeamId);
        // Charger le nom de l'équipe
        const teamsCol = collection(doc(db, "quiz", "state"), "teams");
        getDoc(doc(teamsCol, playerTeamId))
          .then((teamSnap) => {
            if (teamSnap.exists()) {
              const teamData = teamSnap.data();
              setTeamName(teamData.name || "");
              setTeamColor(teamData.color || null);
              setTeamMemberCount((teamData.memberIds || []).length);
              setTeamQuizScore(Number(teamData.teamQuizScore || 0));
              setNeedsTeamSelection(false);
            } else {
              // L'équipe n'existe plus, forcer la sélection d'une nouvelle
              setTeamId(null);
              setTeamName("");
              setTeamColor(null);
              setTeamMemberCount(0);
              setNeedsTeamSelection(true);
            }
          })
          .catch((e) => {
            console.error("Error loading team:", e);
            setTeamId(null);
            setTeamName("");
            setTeamColor(null);
            setTeamMemberCount(0);
            setNeedsTeamSelection(true);
          });
      } else {
        setTeamId(null);
        setTeamName("");
        setTeamColor(null);
        setTeamMemberCount(0);
        // Un joueur DOIT avoir une équipe, forcer la sélection
        setNeedsTeamSelection(true);
      }

      startTransition(() => setPlayerDocLoaded(true));
    });

    return () => unsub();
  }, [playerId, isRunning]);

  // 3.5) Écouter les changements de l'équipe du joueur en temps réel pour le score équipe
  // IMPORTANT: Ce listener est UNIQUEMENT pour mettre à jour le score équipe.
  // Il n'influence JAMAIS la logique de détection "déjà répondu" qui est basée uniquement
  // sur les submissions individuelles du joueur (answers/{qid}/submissions/{playerId}).
  useEffect(() => {
    if (!playerId) return;
    // Si pas d'équipe, on ne peut pas écouter, mais on ne bloque pas le reste
    if (!teamId) {
      setTeamQuizScore(0);
      return;
    }

    const teamsCol = collection(doc(db, "quiz", "state"), "teams");
    const teamRef = doc(teamsCol, teamId);
    const unsub = onSnapshot(teamRef, (teamSnap) => {
      if (!teamSnap.exists()) {
        // L'équipe n'existe plus
        setTeamId(null);
        setTeamName("");
        setTeamColor(null);
        setTeamMemberCount(0);
        setTeamQuizScore(0);
        setNeedsTeamSelection(true);
        return;
      }

      // Mettre à jour les données de l'équipe (y compris pendant le quiz pour le score en temps réel)
      // Ceci est COMPLÈTEMENT décorrélé de la logique de détection "déjà répondu"
      const teamData = teamSnap.data();
      setTeamName(teamData.name || "");
      setTeamColor(teamData.color || null);
      setTeamMemberCount((teamData.memberIds || []).length);
      setTeamQuizScore(Number(teamData.teamQuizScore || 0));
    }, (e) => {
      console.error("Error listening to team:", e);
    });

    return () => unsub();
  }, [playerId, teamId]);

  // 4) Si aucun playerId → considérer le doc joueur "chargé"
  useEffect(() => {
    if (!playerId) startTransition(() => setPlayerDocLoaded(true));
  }, [playerId]);

  // 5) Abonnement principal /quiz/state
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};

      // startMs reconstruit depuis l'ancrage (anchorAt + anchorOffsetSec) si présent.
      // Fallback: startAt (Timestamp) puis startEpochMs (legacy).
      let startMs = null;

      if (d.anchorAt && typeof d.anchorAt.seconds === "number") {
        const anchorMs =
          d.anchorAt.seconds * 1000 + Math.floor((d.anchorAt.nanoseconds || d.anchorAt.nanos || 0) / 1e6);
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
        uiFreezeUntilRef.current = performance.now() + UI_MASK_MS;
      }

      // Mise à jour du delta d'horloge si Admin publie serverNow
      if (d.serverNow && typeof d.serverNow.seconds === "number") {
        const serverNowMs =
          d.serverNow.seconds * 1000 + Math.floor((d.serverNow.nanoseconds || d.serverNow.nanos || 0) / 1e6);
        const instantDelta = serverNowMs - Date.now(); // (+) = ma clock est en retard, (-) = en avance
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

        // Tick léger pour réactualiser si besoin d’afficher qqch basé sur Date.now()
        setServerDeltaTick((t) => (t + 1) & 0xfff);
      }

        // Kick admin « Reset buzzers » : reload une fois si playerReloadSeq augmente
        const newReloadSeq = Number.isFinite(d.playerReloadSeq)
          ? Number(d.playerReloadSeq)
          : 0;
        if (playerReloadSeqRef.current === null) {
          playerReloadSeqRef.current = newReloadSeq;
        } else if (newReloadSeq > playerReloadSeqRef.current) {
          playerReloadSeqRef.current = newReloadSeq;
          try {
            window.location.reload();
          } catch {
            /* ignore */
          }
          return;
        }

        startTransition(() => {
        setIsRunning(!!d.isRunning);
        setIsPaused(!!d.isPaused);
        setShowFinalScore(!!d.showFinalScore);
      });

      // EleyBuzz : setState synchrone (pas dans startTransition).
      // Sinon un snapshot périmé peut réappliquer un faux firstPlayerId → double jaune.
      {
        const newIsBuzzerMode = !!d.isBuzzerMode;
        const newBuzzerState = typeof d.buzzerState === "string" ? d.buzzerState : "idle";
        const newFirstPlayerId = typeof d.firstPlayerId === "string" ? d.firstPlayerId : null;
        const newOpenSeq = Number.isFinite(d.buzzerOpenSeq) ? Number(d.buzzerOpenSeq) : 0;

        buzzerStateRef.current = newBuzzerState;

        if (newOpenSeq !== buzzerOpenSeqRef.current) {
          buzzerOpenSeqRef.current = newOpenSeq;
          if (fairBuzzTimerRef.current != null) {
            clearTimeout(fairBuzzTimerRef.current);
            fairBuzzTimerRef.current = null;
          }
          setIsBuzzing(false);
        }

        setIsBuzzerMode(newIsBuzzerMode);
        setBuzzerState(newBuzzerState);
        setFirstPlayerId(newFirstPlayerId);

        if (!newIsBuzzerMode) {
          setCanBuzz(true);
        }

        if (newBuzzerState === BUZZER_STATES.IDLE || newFirstPlayerId) {
          setIsBuzzing(false);
        }

        setBuzzerMessage(typeof d.buzzerMessage === "string" ? d.buzzerMessage : null);
        setBuzzerMessageType(typeof d.buzzerMessageType === "string" ? d.buzzerMessageType : null);

        const bp = Number.isFinite(d.buzzerPoints) ? d.buzzerPoints : DEFAULT_BUZZER_POINTS;
        setBuzzerPoints(bp);
      }

      if (!startMs) {
        startTransition(() => {
          setQuizStartMs(null);
          setPauseAtMs(null);
          setElapsedSec(0);
          setAnswer("");
          setResult(null);
        });
      } else {
        startTransition(() => {
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
        });
      }

      startTransition(() => {
        setLastAutoPausedRoundIndex(
          Number.isInteger(d.lastAutoPausedRoundIndex) ? d.lastAutoPausedRoundIndex : null
        );
      });

      startTransition(() => setStateLoaded(true));
    });
    return () => unsub();
  }, []);

  // 6) Reset local (blocklist + runtime) à chaque reset global
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};
      const t = d.playersResetAt;
      if (t && typeof t.seconds === "number") {
        const ms = t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
        const prev = Number(localStorage.getItem("playersResetAt") || 0);

        // Nouveau reset détecté côté Admin → on resynchronise le joueur local
        if (!Number.isFinite(prev) || ms > prev) {
          localStorage.setItem("playersResetAt", String(ms));
          localStorage.removeItem("rejectedNamesCache");

          // 1) Purge de la blocklist locale
          startTransition(() => {
            setRejectedNames([]);
          });

          // 2) Reset complet du runtime de la session (comme après un F5)
          resetRuntimeForPlayer({
            answeredAtRef,
            lastAnswerQidRef,
            lastInstantWinQidRef,
            setInstantWin,
            setResult,
            setAnswer,
            setWrongTimes,
            setCooldownUntilMs,
            setLockPhraseIndex,
          });

          // 3) Reset des marqueurs de Back & dérivés locaux
          resetLocalSessionState();
          
          // 4) Réinitialiser les états EleyBuzz locaux (débloquer le joueur)
          startTransition(() => {
            setCanBuzz(true);
            setIsBuzzing(false);
            setBuzzerState("idle");
            setFirstPlayerId(null);
            setBuzzerMessage(null);
            setBuzzerMessageType(null);
            setLastWrongPenalty(null);
            setTeamId(null);
            setTeamName("");
            setTeamColor(null);
            setTeamMemberCount(0);
            setNeedsTeamSelection(false);
          });
          if (fairBuzzTimerRef.current != null) {
            clearTimeout(fairBuzzTimerRef.current);
            fairBuzzTimerRef.current = null;
          }
        }
      }
    });
    return () => unsub();
  }, []);


  // 7) Charger les messages personnalisés depuis Firestore
  useEffect(() => {
    const configRef = doc(db, "quiz", "config");
    const unsub = onSnapshot(configRef, (snap) => {
      const data = snap.data() || {};
      setPlayerNomJoueurMessages(mergePageMessages(PLAYER_PAGE_CREATION_JOUEUR, data.playerNomJoueur));
      setPlayerEquipeMessages(mergePageMessages(PLAYER_PAGE_EQUIPE, data.playerEquipe));
      setPlayerCreationEquipeMessages(mergePageMessages(PLAYER_PAGE_CREATION_EQUIPE, data.playerCreationEquipe));
      setPlayerRejoindreEquipeMessages(mergePageMessages(PLAYER_PAGE_REJOINDRE_EQUIPE, data.playerRejoindreEquipe));
      setPlayerAttenteMessages(() => {
        const merged = mergePageMessages(PLAYER_PAGE_ATTENTE, data.playerAttente);
        if (data.playerAttente?.titleLine1) return merged;
        if (typeof data.playerAttente?.title === "string" && data.playerAttente.title.trim()) {
          return { ...merged, titleLine1: data.playerAttente.title.trim() };
        }
        return merged;
      });
      setPlayerEleyBuzzMessages(mergePageMessages(ELEYBUZZ_PLAYER_MESSAGES, data.playerEleyBuzz));
      setPlayerFinMessages(mergePageMessages(PLAYER_PAGE_FIN, data.playerFin));
      setPlayerQuizMessages(mergePageMessages(PLAYER_PAGE_QUIZ, data.playerQuizPage || data.playerQuiz));
      setConfigLoaded(true);
    });
    return () => unsub();
  }, []);

  // 8) Récupérer les questions du quiz ACTIF
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // Pas de quiz actif → pas de questions (évite le mélange)
        if (!activeQuizKey) {
          if (!cancelled) setQuestionsList([]);
          return;
        }

        const q = query(
          collection(db, "LesQuestions"),
          where("quizKey", "==", activeQuizKey)
        );
        const snapshot = await getDocs(q);
        if (!cancelled) {
          setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        }
      } catch (e) {
        console.error("[Player] load questions failed:", e);
        if (!cancelled) setQuestionsList([]);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [activeQuizKey]);


  // 8) Config (manches + fin + durée de révélation + quiz actif)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data() || {};
      startTransition(() => {
        // Quiz actif
        const activeKey =
          typeof d?.activeQuizKey === "string" && d.activeQuizKey.trim()
            ? d.activeQuizKey.trim()
            : null;
        setActiveQuizKey(activeKey);

        // Fin de quiz & manches
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
        const cm = Number.isFinite(d?.cooldownMs) ? d.cooldownMs : COOLDOWN_MS;
        setCooldownMs(cm);
        setScoringTable(
          Array.isArray(d?.scoringTable) && d.scoringTable.length > 0
            ? d.scoringTable
            : DEFAULT_SCORING_TABLE
        );

        // Messages personnalisables depuis Firestore
        const customFinalPodiumTitle = typeof d?.screenQuiz?.finalPodiumTitle === "string" && d.screenQuiz.finalPodiumTitle.trim() !== ""
          ? d.screenQuiz.finalPodiumTitle
          : SCREEN_MESSAGES.finalPodiumTitle;
        setFinalPodiumTitle(customFinalPodiumTitle);

        // Liste globale des noms refusés
        const globalRejected = Array.isArray(d?.globalRejectedNames) ? d.globalRejectedNames : [];
        const isAliasNameLocal = (raw) => /^player\s*\d+$/i.test(String(raw || "").trim());
        const filteredGlobal = globalRejected.filter((n) => !isAliasNameLocal(n));
        
        // Fusionner avec la liste locale (depuis localStorage)
        let prev = [];
        try {
          const raw = localStorage.getItem("rejectedNamesCache");
          prev = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(prev)) prev = [];
        } catch {
          prev = [];
        }
        const union = Array.from(new Set([...prev.filter((n) => !isAliasNameLocal(n)), ...filteredGlobal]));
        localStorage.setItem("rejectedNamesCache", JSON.stringify(union));
        startTransition(() => setRejectedNames(union));
      });
    });
    return () => unsub();
  }, []);


  // 8.5) Abonnement players → alimente le leaderboard local
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
          isKicked: !!v.isKicked,
        };
      });
      startTransition(() => setPlayersLB(arr));
    });
    return () => unsub();
  }, []);

  // 8.6) Abonnement teams → alimente le leaderboard des équipes
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
          isKicked: !!v.isKicked,
        };
      });
      startTransition(() => setTeamsLB(arr));
    });
    return () => unsub();
  }, []);

  // 9) Timer local (avec clamp fin de quiz) — rAF throttle ~10 FPS
  useEffect(() => {
    if (!quizStartMs) {
      startTransition(() => setElapsedSec(0));
      return;
    }
    if (isPaused && pauseAtMs) {
      const e = Math.floor((pauseAtMs - quizStartMs) / 1000);
      const clamped = Number.isFinite(quizEndSec) ? Math.min(e, quizEndSec) : e;
      startTransition(() => setElapsedSec(clamped < 0 ? 0 : clamped));
      return;
    }
    if (!isRunning) {
      startTransition(() => setElapsedSec(0));
      return;
    }

    const computeNow = () =>
      Math.floor(((Date.now() + serverDeltaRef.current) - quizStartMs) / 1000);

    // Première mise à jour immédiate
    const first = computeNow();
    if (Number.isFinite(quizEndSec) && first >= quizEndSec) {
      startTransition(() => setElapsedSec(Math.max(0, quizEndSec)));
      return;
    }
    startTransition(() => setElapsedSec(first < 0 ? 0 : first));

    let rafId;
    let last = 0;
    const TARGET_MS = 1000 / 10; // 10 FPS

    const loop = (t) => {
      if (!last || t - last >= TARGET_MS) {
        last = t;
        const raw = computeNow();

        if (Number.isFinite(quizEndSec) && raw >= quizEndSec) {
          startTransition(() => setElapsedSec(Math.max(0, quizEndSec)));
          return; // stoppe la boucle (pas de nouvelle frame)
        }

        startTransition(() => setElapsedSec(raw < 0 ? 0 : raw));
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec, serverDeltaTick]);

  // ============================================================================
  // /pages/player.js — Partie 3/6
  // Scope : Dérivés & calculs d’écran (phases, bornes de manche/question),
  //         préchargement images, anti-spam dérivés, focus, watcher Back,
  //         handlers de réponse, “instant win”, ranking & helpers nom.
  // ============================================================================

  /* ===================== DÉRIVÉS & HANDLERS (PARTIE 3/4) ===================== */
  /* ===================== Dérivés & calculs d'écran ===================== */

  const sorted = [...questionsList].sort((a, b) => getTimeSec(a) - getTimeSec(b));

  // --- Début/fin de la manche courante
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

  // --- Question courante bornée à la manche
  let activeIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (!Number.isFinite(t) || t < currentRoundStart) continue;
    if (t <= elapsedSec && t < currentRoundEnd) activeIndex = i;
    else if (t >= currentRoundEnd) break;
  }
  const currentQuestion = activeIndex >= 0 ? sorted[activeIndex] : null;

  // Prochaine question (t > elapsed)
  let nextTimeSec = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (Number.isFinite(t) && t > elapsedSec) { nextTimeSec = t; break; }
  }

  const uiMasked = performance.now() < uiFreezeUntilRef.current;

  // --- Prochaine échéance (min question / frontière de manche / fin de quiz)
  const GAP = 1;
  const nextRoundStart = nextRoundStartAfter(elapsedSec, roundOffsetsSec);
  const nextRoundBoundary = Number.isFinite(nextRoundStart) ? Math.max(0, nextRoundStart - GAP) : null;

  const ROUND_DEADZONE_SEC = ROUND_BOUNDARY_GAP_SEC;
  const secondsToRoundBoundary = Number.isFinite(nextRoundStart) ? nextRoundStart - elapsedSec : null;
  const inRoundBoundaryWindow =
    !uiMasked &&
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= ROUND_DEADZONE_SEC &&
    secondsToRoundBoundary >= -0.25;

  // Manche qui est en train de se terminer pendant la fenêtre morte
  const boundaryRoundIndex =
    Number.isFinite(nextRoundStart)
      ? roundIndexOfTime(Math.max(0, nextRoundStart - 0.001), roundOffsetsSec)
      : null;

  let effectiveNextTimeSec = null;

  // On re-considère la frontière de manche (nextRoundBoundary) comme un
  // "événement" à part entière pour retrouver le compte à rebours
  // "Fin de la manche X dans :".
  let nextKind = null; // "question" | "end" | "round"
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



  // --- Bornes de la question courante
  const qStart = Number.isFinite(getTimeSec(currentQuestion)) ? getTimeSec(currentQuestion) : null;
  const boundary = effectiveNextTimeSec;
  const qEnd = boundary != null ? boundary - revealDurationSec : null;

  // 1re question de la manche courante ?
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

  // Fenêtre d’intro (début de manche)
  const introStart = isFirstQuestionOfRound ? qStart : null;
  const introEnd = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + roundStartIntroSec
    : null;

  // Force une courte intro si on “rase” la frontière (UX)
  const forceIntroByBoundary =
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= 0.20 &&
    secondsToRoundBoundary >= -0.12;

  const isRoundIntroPhase = !uiMasked && Boolean(
    (
      isFirstQuestionOfRound &&
      !isPaused &&
      !(isPaused && Number.isInteger(lastAutoPausedRoundIndex)) &&
      introStart != null &&
      elapsedSec >= introStart &&
      elapsedSec < introEnd
    )
    || forceIntroByBoundary
  );

  // Le temps utile de réponse commence après l'intro
  const qStartEffective = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + roundStartIntroSec
    : qStart;

  // Compte à rebours d’intro (1..N)
  const introCountdownSec = isRoundIntroPhase
    ? Math.max(1, Math.ceil((introEnd ?? 0) - elapsedSec))
    : null;

  // Numéro de manche pour l’UI
  const roundIdxForCurrentQuestion = Number.isFinite(qStart)
    ? roundIndexOfTime(Math.max(0, qStart), roundOffsetsSec)
    : null;
  const roundNumberForIntro = roundIdxForCurrentQuestion != null ? roundIdxForCurrentQuestion + 1 : null;

  // Fin de manche (pause posée par l’Admin)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;

  // On ne considère "Fin de manche" que si :
  //  - la pause vient bien d'une auto-pause (endedRoundIndex != null)
  //  - ET qu'on est encore dans la fenêtre de temps de cette manche
  let isRoundBreak = false;
  if (isPaused && endedRoundIndex != null) {
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



  // --- Phases
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


  const isQuestionPhase = !uiMasked && Boolean(
    currentQuestion &&
    qStartEffective != null &&
    nextEvent != null &&
    elapsedSec >= qStartEffective &&
    elapsedSec < revealStart &&
    !isPaused &&
    !isRoundBreak
  );

  const isRevealAnswerPhase = !uiMasked && Boolean(
    currentQuestion &&
    revealStart != null &&
    countdownStart != null &&
    elapsedSec >= revealStart &&
    elapsedSec < countdownStart &&
    !isPaused &&
    !isRoundBreak
  );

  const isCountdownPhase = !uiMasked && Boolean(
    currentQuestion &&
    countdownStart != null &&
    nextEvent != null &&
    elapsedSec >= countdownStart &&
    elapsedSec < nextEvent &&
    !isPaused &&
    !isRoundBreak
  );

  // Décompte (jamais 0)
  const secondsToNext = nextEvent != null ? nextEvent - elapsedSec : null;
  const countdownSec = isCountdownPhase
    ? Math.max(1, Math.min(countdownStartSec, Math.ceil(secondsToNext)))
    : null;

  // Libellé du décompte
  let countdownLabel = "Prochaine question dans :";
  if (nextKind === "end") countdownLabel = "Fin du quiz dans :";
  if (nextKind === "round") {
    const endingIdx = Number.isFinite(nextEvent)
      ? roundIndexOfTime(Math.max(0, nextEvent - 0.001), roundOffsetsSec)
      : null;
    countdownLabel = `Fin de la manche ${endingIdx != null ? endingIdx + 1 : ""} dans :`;
  }

  const holdRoundBoundaryCountdown =
    !uiMasked && inRoundBoundaryWindow && !isRoundBreak && !isPaused;
  const showCountdownUi = Boolean(isCountdownPhase || holdRoundBoundaryCountdown);
  const displayCountdownSec = holdRoundBoundaryCountdown
    ? 1
    : countdownSec;

  // Barre de progression
  const canShowTimeBar = Boolean(
    isQuestionPhase && qStartEffective != null && qEnd != null && qEnd > qStartEffective
  );
  const progress = canShowTimeBar
    ? Math.min(1, Math.max(0, (elapsedSec - qStartEffective) / (qEnd - qStartEffective)))
    : 0;

  // Messages d’attente
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;

  // Reset UI complet à chaque changement de question
  const currentQuestionId = currentQuestion?.id ?? null;
  useEffect(() => {
    lastAnswerQidRef.current = null;
    lastInstantWinQidRef.current = null;
    setInstantWin(null);
    setResult(null);
    setAnswer("");
    setWrongTimes([]);
    setCooldownUntilMs(null);
    setLockPhraseIndex(null);

    // Reset détection Back pour la nouvelle question
    prevElapsedSecRef.current = null;
    prevQuestionIdRef.current = null;
    backInfoRef.current = { lastBackQid: null, hadCorrectBeforeBack: false };
  }, [currentQuestionId]);

  // Init “answeredAfterBackRef” pour la q courante
  useEffect(() => {
    const qid = currentQuestionId;
    if (qid) {
      if (typeof answeredAfterBackRef.current[qid] !== "boolean") {
        answeredAfterBackRef.current[qid] = false;
      }
    } else {
      answeredAfterBackRef.current = {};
    }
  }, [currentQuestionId]);

  // Réponse primaire affichée au reveal
  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);

  // --- Préchargement image du reveal (anti-flicker)
  const [preloadedImage, setPreloadedImage] = useState(null);
  const currentImageUrl = currentQuestion
    ? (currentQuestion.imageReponseUrl || currentQuestion.imageUrl || null)
    : null;


  useEffect(() => {
    setPreloadedImage(null);
    const url = currentImageUrl;
    if (!url) return;

    let cancelled = false;
    const img = new Image();
    img.src = url;

    const markReady = () => { if (!cancelled) setPreloadedImage(url); };

    if (typeof img.decode === "function") {
      img.decode().then(markReady).catch(markReady);
    } else {
      img.onload = markReady;
      img.onerror = () => { if (!cancelled) setPreloadedImage(null); };
    }
    return () => { cancelled = true; };
  }, [currentImageUrl]);

  // Prefetch “idle” des 2 prochaines images
  useEffect(() => {
    if (!currentQuestionId || !Array.isArray(sorted) || !sorted.length) return;

    const idx = sorted.findIndex((q) => q?.id === currentQuestionId);
    if (idx < 0) return;

    const nextUrls = [];
    for (let k = idx + 1; k < sorted.length && nextUrls.length < 2; k++) {
      const u = sorted[k]?.imageReponseUrl || sorted[k]?.imageUrl;
      if (typeof u === "string" && u.trim()) nextUrls.push(u);
    }
    if (!nextUrls.length) return;

    const run = () => {
      nextUrls.forEach((url) => {
        try {
          const im = new Image();
          im.loading = "eager";
          im.decoding = "async";
          im.src = url;
          if (im.decode) im.decode().catch(() => { });
        } catch { }
      });
    };

    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 1200 });
      return () => {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(id);
        }
      };
    } else {
      const t = setTimeout(run, 150);
      return () => clearTimeout(t);
    }
  }, [currentQuestionId, sorted]);

  // Compteur de bonnes réponses (pour prédire rang/points sans attendre la transaction)
  useEffect(() => {
    if (!currentQuestionId) return;
    const qRef = doc(db, "answers", currentQuestionId);
    return onSnapshot(qRef, (snap) => {
      const c = snap.exists() ? Number(snap.data()?.correctCount) || 0 : 0;
      questionCorrectCountRef.current[currentQuestionId] = c;
    });
  }, [currentQuestionId]);

  // Flags globaux + statut joueur courant
  const showPreStart = !(quizStartMs && isRunning);
  const isQuizEnded = typeof quizEndSec === "number" && elapsedSec >= quizEndSec;

  const qid = currentQuestionId;
  const hadCorrectEver = qid ? (answeredAtRef.current[qid] != null) : false;
  const justAnsweredAfterBack = qid ? (answeredAfterBackRef.current[qid] === true) : false;

  // ✅ Bonne réponse “affichable maintenant”
  const showGoodNow = useMemo(() => {
    if (!qid) return false;
    const gotNow = (result === "correct" && lastAnswerQidRef.current === qid);
    const noBackSince = backInfoRef.current.lastBackQid !== qid;

    const tAnswer = answeredAtRef.current[qid];

    // -1 → F5 après bonne réponse dans le “run” actuel → on garde "Bonne réponse !"
    const isReloadedFreshCorrect = tAnswer === -1 && noBackSince;
    // -2 → F5 après Back (bonne réponse d'un “run” précédent)
    //      → on NE le compte PAS comme "Bonne réponse !" mais comme "déjà répondu".

    return (gotNow && noBackSince) || justAnsweredAfterBack || isReloadedFreshCorrect;
  }, [qid, result, justAnsweredAfterBack, backTick]);



  // Splash : relâcher après boot initial (+ messages Firestore pour éviter un flash des défauts)
  // Nouveau joueur : attendre config. Joueur déjà inscrit : attendre config + état quiz + doc joueur.
  const initialBootReady = hydrated && configLoaded && (
    playerId ? (stateLoaded && playerDocLoaded) : true
  );
  useEffect(() => {
    if (initialBootReady) setSplashReleased(true);
  }, [initialBootReady]);

  // Anti-spam (dérivés)
  const nowMs = Date.now() + cooldownTick;
  const isLocked = RATE_LIMIT_ENABLED && cooldownUntilMs != null && nowMs < cooldownUntilMs;
  const lockRemainingSec = isLocked ? Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000)) : 0;
  const lockText =
    lockPhraseIndex != null && LOCK_PHRASES[lockPhraseIndex]
      ? LOCK_PHRASES[lockPhraseIndex]
      : LOCK_PHRASES[0];

  const gainedPoints =
    instantWin && instantWin.qid === currentQuestionId ? instantWin.points : null;

  useEffect(() => {
    if (!teamId || !currentQuestionId) {
      setQuestionTeamAward(null);
      return;
    }
    const awardRef = doc(db, "answers", currentQuestionId, "teamAwards", teamId);
    return onSnapshot(awardRef, (snap) => {
      if (!snap.exists()) {
        setQuestionTeamAward(null);
        return;
      }
      const d = snap.data() || {};
      setQuestionTeamAward({
        points: Number.isFinite(d.points) ? d.points : 0,
        rank: Number.isFinite(d.rank) ? d.rank : null,
        firstPlayerId: typeof d.firstPlayerId === "string" ? d.firstPlayerId : null,
      });
    });
  }, [teamId, currentQuestionId]);

  const teamQuestionPoints =
    questionTeamAward?.points
    ?? (instantWin?.qid === currentQuestionId ? instantWin.teamPoints : null);
  const teamQuestionRank =
    questionTeamAward?.rank
    ?? (instantWin?.qid === currentQuestionId ? instantWin.teamRank : null);

  const isTeamScorerForQuestion = Boolean(
    playerId
    && Number.isFinite(teamQuestionPoints)
    && teamQuestionPoints > 0
    && (
      questionTeamAward?.firstPlayerId === playerId
      || (
        !questionTeamAward?.firstPlayerId
        && instantWin?.qid === currentQuestionId
        && Number(instantWin?.teamPoints) > 0
      )
    )
  );

  const showTeamOnReveal = Boolean(
    teamName
    && Number.isFinite(teamQuestionPoints)
    && teamQuestionPoints > 0
  );

  const questionPointsFeedback =
    Number.isFinite(gainedPoints) && (hadCorrectEver || showGoodNow) ? (
      <PlayerCorrectPointsFeedback
        teamName={teamName}
        teamColor={teamColor}
        teamPoints={teamQuestionPoints}
        teamRank={teamQuestionRank}
        playerPoints={gainedPoints}
        playerRank={instantWin?.rank}
        showTeamBlock={isTeamScorerForQuestion}
        playerScoredPrefix={playerQuizMessages.playerScored || playerQuizMessages.pointsEarned}
        pointLabel={playerQuizMessages.point}
        pointsLabel={playerQuizMessages.points}
      />
    ) : null;

  const revealPointsFeedback =
    Number.isFinite(gainedPoints) && hadCorrectEver ? (
      <PlayerCorrectPointsFeedback
        teamName={teamName}
        teamColor={teamColor}
        teamPoints={teamQuestionPoints}
        teamRank={teamQuestionRank}
        playerPoints={gainedPoints}
        playerRank={instantWin?.rank}
        showTeamBlock={showTeamOnReveal}
        playerScoredPrefix={playerQuizMessages.playerScored || playerQuizMessages.pointsEarned}
        pointLabel={playerQuizMessages.point}
        pointsLabel={playerQuizMessages.points}
      />
    ) : null;

  // 🔁 Recharger l'état "bonne réponse" après un F5
  // IMPORTANT: Cette fonction vérifie UNIQUEMENT la soumission INDIVIDUELLE de CE joueur.
  // Elle ne vérifie JAMAIS les soumissions d'autres joueurs ou les awards d'équipe.
  useEffect(() => {
    const qid = currentQuestionId;
    if (!qid || !playerId) return;

    // Si on connaît déjà localement le fait que la question est correcte, ne rien faire
    if (answeredAtRef.current[qid] != null) return;

    let cancelled = false;
    (async () => {
      try {
        // Vérification UNIQUEMENT de la soumission INDIVIDUELLE de CE joueur
        // answers/{qid}/submissions/{playerId} - pas de vérification d'équipe ici
        const subRef = doc(db, "answers", qid, "submissions", playerId);
        const snap = await getDoc(subRef);
        if (cancelled || !snap.exists()) return;

        const data = snap.data() || {};
        if (data.qcmFailed) {
          setQcmFailed(true);
          return;
        }
        // Si CE joueur n'a pas répondu correctement, on ne marque rien
        // Même si d'autres joueurs de l'équipe ont répondu
        if (!data.isCorrect) return;

        // Par défaut : F5 après bonne réponse dans le “run” actuel
        let sentinel = -1;

        // Si on a les timings, on essaie de savoir si la bonne réponse
        // appartenait à un “run” précédent (avant un Back).
        const first = data.firstCorrectAt;
        const qStart = getTimeSec(currentQuestion);
        if (
          first &&
          typeof first.seconds === "number" &&
          Number.isFinite(quizStartMs) &&
          Number.isFinite(qStart)
        ) {
          const firstMs =
            first.seconds * 1000 +
            Math.floor((first.nanoseconds || first.nanos || 0) / 1e6);
          const approxElapsedAtCorrect = (firstMs - quizStartMs) / 1000;

          // Si, dans la timeline actuelle, la bonne réponse semble dater
          // d'avant le début de la question, c'est qu'elle vient d'un “ancien run”.
          if (approxElapsedAtCorrect < qStart - 0.5) {
            sentinel = -2; // “déjà répondu” avant le Back
          }
        }

        // 1) On marque le fait qu'on a déjà bien répondu
        answeredAtRef.current[qid] = sentinel;

        // 2) On restaure les points/rang si disponibles (peu importe le type de sentinel)
        const predictedRank = Number.isFinite(data.predictedRank) ? data.predictedRank : null;
        const predictedPoints = Number.isFinite(data.predictedPoints) ? data.predictedPoints : null;

        let teamPoints = null;
        let teamRank = null;
        if (teamId) {
          try {
            const teamAwardRef = doc(db, "answers", qid, "teamAwards", teamId);
            const teamAwardSnap = await getDoc(teamAwardRef);
            if (teamAwardSnap.exists()) {
              const ta = teamAwardSnap.data() || {};
              teamPoints = Number.isFinite(ta.points) ? ta.points : null;
              teamRank = Number.isFinite(ta.rank) ? ta.rank : null;
            }
          } catch (e) {
            console.error("[Player] reload team award failed:", e);
          }
        }

        if (Number.isFinite(predictedPoints) && predictedPoints > 0) {
          lastInstantWinQidRef.current = qid;
          setInstantWin({
            qid,
            rank: predictedRank,
            points: predictedPoints,
            teamPoints,
            teamRank,
            at: Date.now(),
          });
        }

        // 3) Tick pour forcer la mise à jour des dérivés (showGoodNow, etc.)
        setBackTick((t) => t + 1);
      } catch (e) {
        console.error("[Player] reload previous correct state failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentQuestionId, playerId, currentQuestion, quizStartMs, teamId]);


  // “Déjà correct” (persiste même après un Back)
  // IMPORTANT: Cette logique est UNIQUEMENT basée sur les réponses INDIVIDUELLES du joueur.
  // Elle ne dépend JAMAIS de l'équipe ou des réponses d'autres joueurs.
  // Elle vérifie uniquement:
  // 1. answeredAtRef: marqué quand CE joueur répond correctement
  // 2. lastAnswerQidRef: mis à jour quand CE joueur répond correctement
  // 3. instantWin: créé quand CE joueur répond correctement
  // 4. result: vient de la soumission de CE joueur
  const alreadyCorrect = useMemo(() => {
    const qid = currentQuestionId;
    if (!qid) return false;
    // Vérifications basées UNIQUEMENT sur les réponses individuelles de CE joueur
    if (answeredAtRef.current[qid] != null) return true;
    if (lastAnswerQidRef.current === qid) return true;
    if (instantWin && instantWin.qid === qid) return true;
    return result === "correct";
  }, [currentQuestionId, instantWin, result]);



  // Ouverture/affichage input ou QCM
  const answersOpen = Boolean(isQuestionPhase && !isLocked);
  const isQcm = isQcmQuestion(currentQuestion);
  const showTextInput = Boolean(answersOpen && !hadCorrectEver && !justAnsweredAfterBack && !isQcm);
  const showQcmChoices = Boolean(answersOpen && !hadCorrectEver && !justAnsweredAfterBack && isQcm && !qcmFailed);
  const showQcmFailed = Boolean(answersOpen && isQcm && qcmFailed && !hadCorrectEver && !justAnsweredAfterBack);

  const qcmOptions = useMemo(
    () => (isQcm ? getQcmOptionsForDisplay(currentQuestion) : []),
    [isQcm, currentQuestion]
  );
  const qcmCorrectIndex = isQcm ? getQcmCorrectIndex(currentQuestion) : null;
  const qcmShuffledIndices = useMemo(() => {
    if (!isQcm || !currentQuestionId) return [0, 1, 2, 3];
    return getShuffledQcmIndices(currentQuestionId, playerId);
  }, [isQcm, currentQuestionId, playerId]);

  useEffect(() => {
    setQcmFailed(false);
    setQcmBusy(false);
  }, [currentQuestionId]);

  // Focus auto si input texte visible et masque levé
  useEffect(() => {
    if (!uiMasked && showTextInput) {
      const el = answerInputRef.current;
      if (el && document.activeElement !== el) {
        requestAnimationFrame(() => el.focus());
      }
    }
  }, [uiMasked, showTextInput, currentQuestionId]);

  // --- Watcher Back : elapsedSec recule sur même qid → Back détecté
  useEffect(() => {
    const qid = currentQuestionId;

    // reset si on change de question
    if (qid && prevQidRef.current && prevQidRef.current !== qid) {
      backInfoRef.current = { lastBackQid: null, hadCorrectBeforeBack: false };
    }

    // détection Back : recul d’au moins ~1s
    if (
      qid &&
      prevQidRef.current === qid &&
      typeof prevElapsedSecRef.current === "number" &&
      elapsedSec < prevElapsedSecRef.current - 0.9
    ) {
      const tAnswer = answeredAtRef.current[qid];
      const hadAlready =
        Number.isFinite(tAnswer) && Number.isFinite(prevElapsedSecRef.current)
          ? tAnswer <= prevElapsedSecRef.current
          : tAnswer != null;
      backInfoRef.current = { lastBackQid: qid, hadCorrectBeforeBack: !!hadAlready };
      answeredAfterBackRef.current[qid] = false;
      setBackTick((t) => t + 1);
    }

    prevQidRef.current = qid;
    prevElapsedSecRef.current = elapsedSec;
  }, [elapsedSec, currentQuestionId, result]);

  // Ticker cooldown (anti-spam)
  useEffect(() => {
    if (!cooldownUntilMs) return;
    const id = setInterval(() => setCooldownTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [cooldownUntilMs]);

  // GESTION DE LA PUNITION : Le joueur est puni si canBuzz est false (source de vérité Firestore)
  // Une fois puni, on reste puni jusqu'à ce que le buzzer revienne à IDLE (nouvelle question)

  // Réinitialiser les états EleyBuzz locaux quand le mode est désactivé
  useEffect(() => {
    if (!isBuzzerMode) {
      startTransition(() => {
        setIsBuzzing(false);
        setCanBuzz(true);
      });
    }
  }, [isBuzzerMode]);

  /* ============================ Vérification & Handlers ============================ */


  const keepInputFocus = (e) => {
    // Empêche toute prise de focus par le bouton (sinon iOS range le clavier)
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();

    const el = answerInputRef?.current;
    if (el) {
      // 1) Focus immédiat (dans le même gesture)
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }

      // 2) Re-focus “double tick” pour WKWebView (certains iOS l’ignorent sinon)
      requestAnimationFrame(() => {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        const v = el.value || "";
        try { el.setSelectionRange(v.length, v.length); } catch { }
      });

      // 3) Fallback ultra-fiable (petit délai) pour Chrome iOS
      setTimeout(() => {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      }, 30);
    }
  };



  const commitInstantWinForCorrect = useCallback((qid) => {
    if (!qid || !playerId || lastInstantWinQidRef.current === qid) return;

    const priorCount = questionCorrectCountRef.current[qid] ?? 0;
    const predictedRank = priorCount + 1;
    const predictedPoints = scoringTable[predictedRank - 1]
      ?? scoringTable[scoringTable.length - 1]
      ?? 0;

    lastInstantWinQidRef.current = qid;
    setInstantWin({
      qid,
      rank: predictedRank,
      points: predictedPoints,
      teamPoints: null,
      teamRank: null,
      at: Date.now(),
    });

    recordFirstCorrectAndPredict({ db, qid, playerId })
      .then(({ predictedRank: rank, predictedPoints: points, teamPoints, teamRank }) => {
        setInstantWin({
          qid,
          rank,
          points,
          teamPoints: teamPoints ?? null,
          teamRank: teamRank ?? null,
          at: Date.now(),
        });
      })
      .catch((e) => {
        console.error("[instantWin] error:", e);
      });
  }, [playerId, scoringTable]);



  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;
    const mode = getAnswerMode(currentQuestion);
    const list = Array.isArray(currentQuestion.answers) ? currentQuestion.answers : [];
    const isCorrect = list.some((acc) => matchesWithMode(answer, acc, mode));


    if (isCorrect) {
      const qid = currentQuestion?.id || null;
      lastAnswerQidRef.current = qid;
      setResult("correct");
      setAnswer("");

      if (qid) commitInstantWinForCorrect(qid);

      // Horodatage de la 1re bonne réponse (robuste aux Back)
      if (qid && Number.isFinite(elapsedSec)) {
        if (answeredAtRef.current[qid] == null) {
          answeredAtRef.current[qid] = elapsedSec;
        }
      }

      if (qid) {
        // Marque “réponse après Back” si applicable
        if (
          backInfoRef.current.lastBackQid === qid &&
          backInfoRef.current.hadCorrectBeforeBack === false
        ) {
          answeredAfterBackRef.current[qid] = true;
        }
      }
    } else {
      // Ferme volontairement le clavier — c’est le SEUL cas où on le fait
      requestAnimationFrame(() => {
        const el = answerInputRef?.current;
        if (el) {
          try { el.blur(); } catch { }
        }
      });

      setResult("wrong");
      setAnswer("");

      setWrongTimes((prev) => {
        const now = Date.now();
        const pruned = prev.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        const nextArr = [...pruned, now];
        if (RATE_LIMIT_ENABLED && nextArr.length >= MAX_WRONG_ATTEMPTS && !isLocked) {
          setCooldownUntilMs(now + cooldownMs);
          setLockPhraseIndex(() => Math.floor(Math.random() * LOCK_PHRASES.length));
          return [];
        }
        return nextArr;
      });

      setTimeout(() => {
        const el = answerInputRef.current;
        if (el) {
          el.focus();
          el.classList.remove("shake");
          el.classList.remove("flashWrong");
          void el.offsetWidth; // reflow
          el.classList.add("shake");
          el.classList.add("flashWrong");
        }
      }, 0);

      setTimeout(() => setResult(null), 400);
    }
  };

  const handleQcmChoice = async (originalIndex) => {
    if (!currentQuestion || !playerId || qcmBusy) return;
    if (!showQcmChoices) return;

    const correctIndex = getQcmCorrectIndex(currentQuestion);
    const qid = currentQuestion.id;

    if (originalIndex === correctIndex) {
      lastAnswerQidRef.current = qid;
      setResult("correct");
      commitInstantWinForCorrect(qid);

      if (qid && Number.isFinite(elapsedSec)) {
        if (answeredAtRef.current[qid] == null) {
          answeredAtRef.current[qid] = elapsedSec;
        }
      }
      if (
        backInfoRef.current.lastBackQid === qid &&
        backInfoRef.current.hadCorrectBeforeBack === false
      ) {
        answeredAfterBackRef.current[qid] = true;
      }
      return;
    }

    setQcmBusy(true);
    try {
      await recordQcmWrongChoice({
        db,
        qid,
        playerId,
        selectedIndex: originalIndex,
      });
      setQcmFailed(true);
    } catch (e) {
      console.error("[Player] handleQcmChoice error:", e);
    } finally {
      setQcmBusy(false);
    }
  };

  // Handler EleyBuzz — fenêtre d'équité (~80 ms) puis tirage parmi les candidats
  const handleBuzzerPress = async () => {
    if (!playerId || !isBuzzerMode || buzzerStateRef.current !== BUZZER_STATES.OPEN) return;
    
    // Vérifier canBuzz (si le joueur a donné une mauvaise réponse, il ne peut plus buzzer)
    if (!canBuzz) return;

    const attemptOpenSeq = buzzerOpenSeqRef.current;

    const clearBuzzPending = () => {
      setIsBuzzing(false);
    };

    // Attente locale immédiate (reste bleu — le jaune attend Firestore)
    if (!isBuzzing) {
      setIsBuzzing(true);
    }

    try {
      const result = await registerBuzzerPress(db, playerId, attemptOpenSeq);

      // Réponse arrivée trop tard (buzzer refermé, rouvert, ou autre session)
      if (
        buzzerOpenSeqRef.current !== attemptOpenSeq ||
        (buzzerStateRef.current !== BUZZER_STATES.OPEN &&
          buzzerStateRef.current !== BUZZER_STATES.LOCKED)
      ) {
        clearBuzzPending();
        return;
      }

      if (result.ok) {
        const windowSeq = Number(result.windowSeq);
        const openSeq = Number(result.openSeq);
        if (Number.isFinite(windowSeq) && Number.isFinite(openSeq)) {
          if (fairBuzzTimerRef.current != null) {
            clearTimeout(fairBuzzTimerRef.current);
          }
          // 1er candidat : résout à 80ms. Les autres : filet de secours +200ms si le 1er a crashé.
          const delay = result.shouldResolve
            ? FAIR_BUZZ_WINDOW_MS
            : FAIR_BUZZ_WINDOW_MS + 200;
          fairBuzzTimerRef.current = setTimeout(() => {
            fairBuzzTimerRef.current = null;
            resolveBuzzFairWindow(db, openSeq, windowSeq).catch((e) =>
              console.error("[Player] resolveBuzzFairWindow:", e)
            );
          }, delay);
        }
        return;
      }

      if (
        result.reason === "already-taken" ||
        result.reason === "stale-open-seq" ||
        result.reason === "buzzer-not-open"
      ) {
        clearBuzzPending();
        return;
      }

      clearBuzzPending();
    } catch (e) {
      console.error("[Player] handleBuzzerPress error:", e);
      clearBuzzPending();
    }
  };

  const handleAnswerSubmit = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (isLocked) return;
    const trimmed = (answer ?? "").trim();
    if (!trimmed) return;

    checkAnswer();

    // iOS: garder le clavier ouvert & vider le champ de manière fiable
    requestAnimationFrame(() => {
      const el = answerInputRef.current;
      if (el) {
        try { el.value = ""; } catch { }
        // Ré-assigne le state si jamais un IME garde une valeur fantôme
        if (answer !== "") setAnswer("");
        el.focus();
        try { el.setSelectionRange(0, 0); } catch { }
      }
    });
  };



  // === Classement (TOP-LEVEL; pas dans une condition) ===
  const ranking = useMemo(() => {
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => ({
        ...p,
        _nameKey: normalizeNameAlpha(p.name || ""),
        score: Number(p.score || 0),
      }));
    rows.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score; // score desc
      return a._nameKey.localeCompare(b._nameKey);
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
    return rows;
  }, [playersLB]);

  const meRow = useMemo(() => {
    if (playerId) {
      const byId = ranking.find((p) => p.id === playerId);
      if (byId) return byId;
    }
    if (myIdRef.current) {
      const byRef = ranking.find((p) => p.id === myIdRef.current);
      if (byRef) return byRef;
    }
    if (playerName) {
      const key = normalizeNameAlpha(playerName);
      const byName = ranking.find((p) => normalizeNameAlpha(p.name || "") === key);
      if (byName) return byName;
    }
    return null;
  }, [ranking, playerId, playerName]);

  const myRank = useMemo(() => (meRow ? meRow._rank : null), [meRow]);
  // Score depuis Firestore (mis à jour en temps réel par recordFirstCorrectAndPredict)
  const myScore = useMemo(() => (meRow ? meRow.score : 0), [meRow]);
  const myBuzzScore = useMemo(() => (meRow ? Number(meRow.buzzScore || 0) : 0), [meRow]);
  const myEndMessage = useMemo(() => {
    return Number(myScore) > 0
      ? messageForRank(myRank)
      : "Merci pour ta participation !";
  }, [myRank, myScore]);

  // Classement des équipes
  const teamsRanking = useMemo(() => {
    const rows = (teamsLB || [])
      .filter((t) => !t.isKicked)
      .map((t) => ({
        ...t,
        _nameKey: normalizeNameAlpha(t.name || ""),
        score: Number(t.teamQuizScore || 0),
      }));
    rows.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a._nameKey.localeCompare(b._nameKey);
    });
    let lastScore = null;
    let lastRank = 0;
    rows.forEach((t, i) => {
      const sc = Number(t.score || 0);
      if (i === 0) {
        t._rank = 1;
        lastScore = sc;
        lastRank = 1;
      } else if (sc === lastScore) {
        t._rank = lastRank;
      } else {
        t._rank = i + 1;
        lastScore = sc;
        lastRank = t._rank;
      }
    });
    return rows;
  }, [teamsLB]);

  // Trouver l'équipe du joueur et son rang
  const myTeamRow = useMemo(() => {
    if (!teamId) return null;
    return teamsRanking.find((t) => t.id === teamId) || null;
  }, [teamId, teamsRanking]);

  // Rang équipe (1–3 → coupe SVG côté PlayerScorePanel)
  const myTeamRank = useMemo(() => (myTeamRow ? myTeamRow._rank : null), [myTeamRow]);
  const myTeamScore = useMemo(() => (myTeamRow ? myTeamRow.score : 0), [myTeamRow]);
  // Classement final (Quiz + EleyBuzz) pour le Score Final
  const finalRanking = useMemo(() => {
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => {
        const scoreQuiz = Number(p.score || 0);
        const buzzScore = Number(p.buzzScore || 0);
        const scoreFinal = scoreQuiz + buzzScore;
        return {
          ...p,
          scoreQuiz,
          buzzScore,
          scoreFinal,
          _nameKey: normalizeNameAlpha(p.name || ""),
        };
      });
    rows.sort((a, b) => {
      if (a.scoreFinal !== b.scoreFinal) return b.scoreFinal - a.scoreFinal;
      return a._nameKey.localeCompare(b._nameKey);
    });
    // Rangs avec égalités
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
    return rows;
  }, [playersLB]);

  const myFinalRow = useMemo(() => {
    if (playerId) {
      const byId = finalRanking.find((p) => p.id === playerId);
      if (byId) return byId;
    }
    if (myIdRef.current) {
      const byRef = finalRanking.find((p) => p.id === myIdRef.current);
      if (byRef) return byRef;
    }
    if (playerName) {
      const key = normalizeNameAlpha(playerName);
      const byName = finalRanking.find((p) => normalizeNameAlpha(p.name || "") === key);
      if (byName) return byName;
    }
    return null;
  }, [finalRanking, playerId, playerName]);

  const myFinalScore = useMemo(() => (myFinalRow ? myFinalRow.scoreFinal : 0), [myFinalRow]);
  const myFinalRank = useMemo(() => (myFinalRow ? myFinalRow._rank : null), [myFinalRow]);
  const showPlayerFinalRankCircle = myFinalRank != null && myFinalRank <= 3 && Number(myFinalScore) > 0;

  /* ===== Helpers Firestore pour le nom ===== */
  async function nameExists(nameNorm, excludeId = null) {
    const playersCol = collection(doc(db, "quiz", "state"), "players");
    const q = query(playersCol, where("nameNorm", "==", nameNorm));
    const snap = await getDocs(q);
    return snap.docs.some((d) => d.id !== excludeId);
  }

  async function handleNameSubmit(e) {
    e?.preventDefault?.();
    setError("");

    const v = validateName(inputName);
    if (!v.ok) {
      if (v.reason === "length") setError("Le nom doit faire entre 1 et 12 caractères.");
      else if (v.reason === "charset") setError("Utilise uniquement lettres FR, chiffres, espaces, apostrophes (' ') et tirets.");
      else if (v.reason === "politics") setError("Évite les noms à caractère politique. Merci !");
      else if (v.reason === "moderation") setError("Nom inadapté au tout public.");
      else setError("Nom invalide.");
      setInputName(""); // Vider le champ pour permettre une nouvelle saisie
      return;
    }

    const nameIsAlias = isAliasName(inputName);
    const nameNorm = normalizeName(v.value);
    if (!nameIsAlias && Array.isArray(rejectedNames) && rejectedNames.includes(nameNorm)) {
      setError("Nom refusé par l’animateur. Merci d’en choisir un autre.");
      setInputName("");
      return;
    }

    setBusy(true);
    try {
      if (await nameExists(nameNorm, playerId || null)) {
        setError("Ce nom est déjà pris.");
        return;
      }
      const playersCol = collection(doc(db, "quiz", "state"), "players");

      if (!playerId) {
        // Identité neuve à chaque inscription (pas la session IndexedDB résiduelle)
        const uid = await ensureFreshAnonymousAuth();
        await setDoc(doc(playersCol, uid), {
          name: v.value,
          nameNorm,
          createdAt: serverTimestamp(),
          score: 0,
          buzzScore: 0,
          isKicked: false,
          nameStatus: "ok",
          rejectedNames: Array.isArray(rejectedNames) ? rejectedNames : [],
          canBuzz: true, // Initialiser canBuzz à true pour permettre le buzzer
          teamId: null, // Pas d'équipe au départ
          ownerUid: uid, // Propriétaire du document (cohérent avec l'id)
        });
        setPlayerId(uid);
        localStorage.setItem("playerId", uid);
        localStorage.setItem("playerName", v.value);
        setPlayerName(v.value);
        setInputName("");
        // Déclencher l'écran de sélection d'équipe
        setNeedsTeamSelection(true);
      } else {
        await updateDoc(doc(playersCol, playerId), {
          name: v.value,
          nameNorm,
          nameStatus: "ok",
        });
        setPlayerName(v.value);
        setInputName("");
        setError("");
      }
    } catch (err) {
      console.error(err);
      setError("Impossible d’enregistrer le nom. Réessaie.");
    } finally {
      setBusy(false);
    }
  }

  // Fonctions pour les équipes
  async function loadAvailableTeams() {
    try {
      const teamsCol = collection(doc(db, "quiz", "state"), "teams");
      const q = query(
        teamsCol,
        where("isKicked", "==", false),
        where("nameStatus", "!=", "rejected")
      );
      const snap = await getDocs(q);
      const teams = snap.docs.map((d) => ({
        id: d.id,
        name: d.data().name || "",
        color: d.data().color || null,
        memberCount: (d.data().memberIds || []).length,
      }));
      setAvailableTeams(teams);
    } catch (e) {
      console.error("loadAvailableTeams error:", e);
      setAvailableTeams([]);
    }
  }

  async function handleCreateTeam(e) {
    e?.preventDefault?.();
    setError("");

    if (teamId) {
      setTeamSelectionMode(null);
      setTeamInputName("");
      setError(playerEquipeMessages.mustLeaveBeforeCreate);
      return;
    }

    const v = validateTeamName(teamInputName);
    if (!v.ok) {
      if (v.reason === "length") setError("Le nom doit faire entre 1 et 18 caractères.");
      else if (v.reason === "charset") setError("Utilise uniquement lettres FR, chiffres, espaces, apostrophes (' ') et tirets.");
      else if (v.reason === "politics") setError("Évite les noms à caractère politique. Merci !");
      else if (v.reason === "moderation") setError("Nom inadapté au tout public.");
      else setError("Nom invalide.");
      setTeamInputName("");
      return;
    }

    const nameNorm = normalizeTeamName(v.value);
    setBusy(true);
    try {
      const result = await createTeamTx(db, v.value, playerId, nameNorm);
      if (result.ok) {
        setTeamId(result.teamId);
        setTeamName(v.value);
        setTeamColor(result.color || null);
        // Charger le nombre de membres depuis Firestore pour avoir la valeur exacte
        const teamsCol = collection(doc(db, "quiz", "state"), "teams");
        getDoc(doc(teamsCol, result.teamId))
          .then((teamSnap) => {
            if (teamSnap.exists()) {
              const teamData = teamSnap.data();
              setTeamMemberCount((teamData.memberIds || []).length);
            }
          })
          .catch((e) => console.error("Error loading team member count:", e));
        setNeedsTeamSelection(false);
        setTeamInputName("");
      } else {
        if (result.reason === "name-exists") {
          setError("Ce nom d'équipe est déjà pris.");
        } else {
          setError("Impossible de créer l'équipe. Réessaie.");
        }
      }
    } catch (err) {
      console.error(err);
      setError("Impossible de créer l'équipe. Réessaie.");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinTeam(selectedTeamId) {
    if (!selectedTeamId || !playerId) return;
    setBusy(true);
    setError("");
    try {
      const result = await joinTeamTx(db, selectedTeamId, playerId);
      if (result.ok) {
        const team = availableTeams.find((t) => t.id === selectedTeamId);
        if (team) {
          setTeamId(selectedTeamId);
          setTeamName(team.name);
          setTeamColor(team.color || null);
          // Charger le nombre de membres depuis Firestore
          const teamsCol = collection(doc(db, "quiz", "state"), "teams");
          getDoc(doc(teamsCol, selectedTeamId))
            .then((teamSnap) => {
              if (teamSnap.exists()) {
                const teamData = teamSnap.data();
                setTeamMemberCount((teamData.memberIds || []).length);
              }
            })
            .catch((e) => console.error("Error loading team member count:", e));
        }
        setNeedsTeamSelection(false);
      } else {
        if (result.reason === "team-not-found") {
          setError("Équipe introuvable.");
        } else if (result.reason === "team-unavailable") {
          setError("Cette équipe n'est plus disponible.");
        } else {
          setError("Impossible de rejoindre l'équipe. Réessaie.");
        }
      }
    } catch (err) {
      console.error(err);
      setError("Impossible de rejoindre l'équipe. Réessaie.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLeaveTeam() {
    if (!playerId) return;
    setBusy(true);
    setError("");
    try {
      const result = await leaveTeamTx(db, playerId);
      if (result.ok) {
        setTeamId(null);
        setTeamName("");
        setTeamColor(null);
        setTeamMemberCount(0);
        setNeedsTeamSelection(true);
        // Les équipes sont chargées en temps réel via onSnapshot, pas besoin de loadAvailableTeams
      } else {
        setError("Impossible de quitter l'équipe. Réessaie.");
      }
    } catch (err) {
      console.error(err);
      setError("Impossible de quitter l'équipe. Réessaie.");
    } finally {
      setBusy(false);
    }
  }

  // Écouter les équipes en temps réel pendant la sélection
  // IMPORTANT: Permettre la sélection d'équipe même si le quiz est en cours
  useEffect(() => {
    if (!needsTeamSelection || !playerId) return;

    const teamsCol = collection(doc(db, "quiz", "state"), "teams");
    // Firestore ne supporte pas !=, donc on récupère toutes les équipes non kickées
    // et on filtre côté client pour exclure les équipes rejetées
    const q = query(
      teamsCol,
      where("isKicked", "==", false)
    );
    const unsub = onSnapshot(q, (snap) => {
      const teams = snap.docs
        .filter((d) => {
          const data = d.data();
          // Filtrer côté client : exclure les équipes rejetées
          return data.nameStatus !== "rejected";
        })
        .map((d) => ({
          id: d.id,
          name: d.data().name || "",
          color: d.data().color || null,
          memberCount: (d.data().memberIds || []).length,
        }));
      setAvailableTeams(teams);
    }, (e) => {
      console.error("onSnapshot teams error:", e);
      setAvailableTeams([]);
    });

    return () => unsub();
  }, [needsTeamSelection, playerId, isRunning]);

  async function resetAndDeletePlayer() {
    try {
      selfRenameRef.current = true;
      // Couper la session Firebase : sinon un « nouveau nom » réutilise le même uid
      try {
        await signOut(auth);
      } catch {
        /* ignore */
      }
      authUidRef.current = null;
      authReadyRef.current = null;
    } catch (e) {
      console.error("Réinitialisation joueur échouée :", e);
    } finally {
      localStorage.removeItem("playerId");
      localStorage.removeItem("playerName");
      startTransition(() => {
        setPlayerId(null);
        setPlayerName("");
        setInputName("");
        setError("");
        setTeamId(null);
        setTeamName("");
        setTeamColor(null);
        setTeamMemberCount(0);
        setNeedsTeamSelection(false);
        setTeamSelectionMode(null);
        setIsBuzzing(false);
        setFirstPlayerId(null);
      });
      if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }

  const isWelcomeScreen =
    !playerId ||
    !playerName ||
    (typeof error === "string" && error.startsWith("Nom refusé"));

  // Accueil : pas de clavier auto — ouverture au tap sur le champ uniquement
  useEffect(() => {
    if (!isWelcomeScreen) return;
    welcomeInputRef.current?.blur();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [isWelcomeScreen]);

  // Style “no transition” pendant le masque UI
  useEffect(() => {
    if (!uiMasked) return;
    const tag = document.createElement("style");
    tag.setAttribute("data-ui-mask", "1");
    tag.textContent = `*{transition:none!important;animation:none!important}`;
    document.head.appendChild(tag);
    return () => { tag.remove(); };
  }, [uiMasked]);

  // ============================================================================
  // /pages/player.js — Partie 4/6
  // Scope : Début du rendu — flags d’UI, Splash, inscription, écran “kické”,
  //         attente pré-start. Le “main screen” arrive dans la partie 5/6.
  // ============================================================================

  /* ============================ RENDER (PARTIE 4/4) ============================ */

  // Style compact pour la question (évite le chevauchement en haut)
  const questionH2Style = { ...questionTextStyle, lineBreak: "loose" };

  const countdownLabelStyle = {
    ...pageTextSecondary,
    fontSize: "var(--eley-countdown-label)",
    fontWeight: 600,
    marginBottom: 8,
    textAlign: "center",
    width: "100%",
    lineHeight: 1.35,
  };

  const countdownNumberStyle = {
    fontSize: "var(--eley-countdown-number)",
    fontWeight: 800,
    lineHeight: 1,
    textAlign: "center",
    width: "100%",
    color: PAGE_TEXT,
  };

  const pauseTitleStyle = {
    fontSize: "var(--eley-pause-title)",
    fontWeight: 800,
    margin: 0,
    textAlign: "center",
    width: "100%",
  };

  const pauseSubtitleStyle = {
    ...pageTextSecondary,
    marginTop: 10,
    fontSize: "var(--eley-pause-subtitle)",
    fontWeight: 600,
    textAlign: "center",
    width: "100%",
    lineHeight: 1.4,
  };

  // Flags d’état pour le bouton d’inscription
  const normInput = normalizeName(inputName);

  // Refusé par l’admin ET ce n’est PAS un alias "Player N"
  const isRejectedInput =
    Array.isArray(rejectedNames) &&
    rejectedNames.includes(normInput) &&
    !isAliasName(inputName);

  // Cas particulier: après un refus immédiat du nom courant
  const isSameAsRejectedCurrent =
    typeof error === "string" &&
    error.startsWith("Nom refusé") &&
    normalizeName(inputName) === normalizeName(playerName || "") &&
    !isAliasName(inputName);

  const isSubmitDisabled = busy || isRejectedInput || isSameAsRejectedCurrent;

  // Splash avant 1er boot complet
  if (!splashReleased) return <Splash />;

  // HUD : équipe en haut à gauche, joueur + buzz en haut à droite
  const PlayerHud = () => {
    if (!playerName || !teamId) return null;

    const truncatedPlayerName =
      playerName.length > 12 ? `${playerName.substring(0, 12)}…` : playerName;
    const truncatedTeamName =
      teamName && teamName.length > 18 ? `${teamName.substring(0, 18)}…` : teamName;
    const teamTint = getTeamBadgeStyle(teamColor);
    const topOffset = `calc(var(--eley-hud-top) + ${SAFE_TOP})`;
    const hudBadgeRadius = "var(--eley-hud-radius)";
    const hudFixed = {
      position: "fixed",
      top: topOffset,
      zIndex: 20,
    };

    return (
      <>
        {truncatedTeamName && (
          <div
            style={{
              ...hudFixed,
              left: "var(--eley-hud-side)",
              maxWidth: "calc(55vw - var(--eley-hud-max-offset))",
              borderRadius: hudBadgeRadius,
              padding: "var(--eley-hud-pad-team-y) var(--eley-hud-pad-team-x)",
              fontFamily: FONT_FAMILY,
              fontSize: "var(--eley-hud-font-team)",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: "var(--eley-hud-gap)",
              ...teamTint,
            }}
            aria-label="Équipe"
            title={teamName || "Équipe"}
          >
            <HudTeamStar />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              {truncatedTeamName}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0, opacity: 0.95 }}>
              • {teamQuizScore}
            </span>
          </div>
        )}

        <div
          style={{
            ...hudFixed,
            right: "var(--eley-hud-side)",
            maxWidth: "calc(45vw - var(--eley-hud-max-offset))",
            background: BRAND_PAGE_BOTTOM,
            border: "2px solid rgba(255, 251, 245, 0.22)",
            borderRadius: hudBadgeRadius,
            padding: "var(--eley-hud-pad-player-y) var(--eley-hud-pad-player-x)",
            fontFamily: FONT_FAMILY,
            fontSize: "var(--eley-hud-font-player)",
            color: "#ffffff",
            textAlign: "right",
          }}
          aria-label="Joueur"
          title={nameLocked ? "Nom verrouillé" : playerName}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              flexWrap: "nowrap",
              gap: 5,
              fontWeight: 700,
              fontSize: "var(--eley-hud-font-player-inner)",
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <HudPlayerIcon />
              {truncatedPlayerName}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              • {myScore != null ? myScore : 0}
            </span>
            <span
              aria-hidden="true"
              style={{
                width: 2,
                alignSelf: "stretch",
                minHeight: "0.9em",
                background: "rgba(255, 251, 245, 0.22)",
                flexShrink: 0,
                margin: "0 1px 0 5px",
              }}
            />
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              <span aria-hidden="true" style={{ color: BRAND.yellow }}>⚡</span>
              {myBuzzScore != null ? myBuzzScore : 0}
            </span>
            {nameLocked && <span style={{ opacity: 0.7, flexShrink: 0 }}>🔒</span>}
          </div>
        </div>
      </>
    );
  };

  // 1) Écran d'inscription (nom refusé ou pas encore inscrit, ou nom réinitialisé)
  if (isWelcomeScreen) {
    const nom = playerNomJoueurMessages;
    return (
      <PlayerPageShell titleLine1={nom.welcomeLine1} titleLine2={nom.welcomeLine2}>
          <PlayerLabelWithIcon>{nom.chooseNameLabel}</PlayerLabelWithIcon>

          <form onSubmit={handleNameSubmit}>
            <input
              ref={welcomeInputRef}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="text"
              enterKeyHint="send"
              type="text"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              maxLength={12}
              placeholder={nom.namePlaceholder}
              style={{
                ...inputFieldStyle,
                width: "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                display: "block",
                padding: "var(--eley-input-pad-y) var(--eley-input-pad-x)",
                fontSize: "var(--eley-text-input)",
              }}
            />
            <div style={{ fontSize: "var(--eley-text-caption)", opacity: 0.72, marginTop: 6, textAlign: "left" }}>
              {nom.maxCharsHint}
            </div>

            {error && (
              <div style={{ marginTop: 8, color: BRAND.red, fontWeight: 600 }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitDisabled}
              style={{
                ...teamPrimaryBtnStyle({ busy, disabled: isSubmitDisabled }),
                marginTop: 12,
              }}
              title={
                isRejectedInput || isSameAsRejectedCurrent
                  ? "Ce nom a été refusé — choisis-en un autre."
                  : "Valider le nom"
              }
              aria-disabled={isSubmitDisabled ? "true" : "false"}
            >
              {busy ? nom.enterButtonBusy : nom.enterButton}
            </button>

            {Array.isArray(rejectedNames)
              && rejectedNames.includes(normalizeName(inputName))
              && !isAliasName(inputName) && (
                <div style={{ marginTop: 6, color: BRAND.orangeDark, fontWeight: 600 }}>
                  {nom.nameRejectedByAdmin}
                </div>
              )}
          </form>
      </PlayerPageShell>
    );
  }

  // Fonction pour supprimer l'équipe si le joueur est seul
  async function handleDeleteTeam() {
    if (!playerId || !teamId) return;
    setBusy(true);
    setError("");
    try {
      const result = await leaveTeamTx(db, playerId);
      if (result.ok) {
        setTeamId(null);
        setTeamName("");
        setTeamColor(null);
        setTeamMemberCount(0);
        setTeamSelectionMode(null);
        // L'équipe sera supprimée automatiquement par leaveTeamTx si le joueur était seul
      } else {
        setError("Impossible de supprimer l'équipe. Réessaie.");
      }
    } catch (err) {
      console.error(err);
      setError("Impossible de supprimer l'équipe. Réessaie.");
    } finally {
      setBusy(false);
    }
  }

  // 1.5) Écran de sélection d'équipe (après l'inscription)
  // IMPORTANT: Un joueur DOIT avoir une équipe pour jouer, même si le quiz est en cours
  if ((needsTeamSelection || !teamId) && playerId) {
    const isSoloInTeam = teamId && teamMemberCount === 1;
    const eq = playerEquipeMessages;
    const cre = playerCreationEquipeMessages;
    const rej = playerRejoindreEquipeMessages;

    const pageTitle =
      teamSelectionMode === "create"
        ? { line1: cre.titleLine1, line2: cre.titleLine2 }
        : teamSelectionMode === "join"
          ? { line1: rej.titleLine1, line2: rej.titleLine2 }
          : { line1: eq.titleLine1, line2: eq.titleLine2 };

    const pageHint =
      teamSelectionMode === "create"
        ? cre.hint
        : teamSelectionMode === "join"
          ? rej.hint
          : isSoloInTeam
            ? null
            : eq.choiceHint;

    const displayedError =
      teamSelectionMode === "join" && teamId && (!error || error === eq.mustLeaveBeforeCreate)
        ? rej.alreadyInTeamWarning
        : error;

    return (
      <PlayerPageShell
        titleLine1={pageTitle.line1}
        titleLine2={pageTitle.line2}
        titleLine2Icon="star"
      >
        {pageHint && <p style={PLAYER_HINT_STYLE}>{pageHint}</p>}

        {displayedError && (
          <div style={{ marginBottom: 12, color: BRAND.red, fontSize: "var(--eley-text-error)", fontWeight: 600 }}>
            {displayedError}
          </div>
        )}

        {isSoloInTeam && !teamSelectionMode && (
          <>
            <p style={{ ...PLAYER_HINT_STYLE, fontWeight: 500, lineHeight: 1.45 }}>
              {eq.soloIntro}{" "}
              <b style={{ color: teamColor || BRAND.yellow }}>{teamName}</b>.
            </p>
            <p style={{ ...PLAYER_HINT_STYLE, fontWeight: 500, marginTop: 0 }}>
              {eq.soloHint}
            </p>
            <button
              type="button"
              onClick={handleDeleteTeam}
              disabled={busy}
              style={teamDangerBtnStyle({ busy, disabled: busy })}
            >
              {busy
                ? eq.deleteTeamButtonBusy
                : formatMsg(eq.deleteTeamButton, { teamName })}
            </button>
            <button
              type="button"
              onClick={() => {
                setNeedsTeamSelection(false);
                setError("");
              }}
              disabled={busy}
              style={{
                ...btnSecondaryStyle,
                marginTop: 12,
                width: "100%",
                padding: "var(--eley-btn-compact-y) var(--eley-btn-compact-x)",
              }}
            >
              {eq.cancelButton}
            </button>
          </>
        )}

        {teamSelectionMode === "create" && !isSoloInTeam && !teamId && (
          <form onSubmit={handleCreateTeam}>
            <input
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              enterKeyHint="send"
              type="text"
              value={teamInputName}
              onChange={(e) => setTeamInputName(e.target.value)}
              maxLength={18}
              placeholder={cre.namePlaceholder}
              style={{
                ...inputFieldStyle,
                width: "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                display: "block",
                padding: "var(--eley-input-pad-y) var(--eley-input-pad-x)",
                fontSize: "var(--eley-text-input)",
                textTransform: "uppercase",
              }}
              autoFocus
            />
            <div style={{ fontSize: "var(--eley-text-caption)", ...pageTextSecondary, marginTop: 6, textAlign: "left" }}>
              {cre.maxCharsHint}
            </div>
            <button
              type="submit"
              disabled={busy || !teamInputName.trim()}
              style={{
                ...btnPrimaryStyle,
                marginTop: 12,
                width: "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                display: "block",
                padding: "var(--eley-btn-pad-y) var(--eley-btn-pad-x)",
                background: busy ? BRAND.yellow : BRAND.blue,
                color: busy ? BRAND.mauveDark : "#ffffff",
                cursor: busy || !teamInputName.trim() ? "not-allowed" : "pointer",
              }}
            >
              {busy ? cre.submitButtonBusy : cre.submitButton}
            </button>
            <button
              type="button"
              onClick={() => {
                setTeamSelectionMode(null);
                setTeamInputName("");
                setError("");
              }}
              style={{
                ...btnSecondaryStyle,
                marginTop: 12,
                width: "100%",
                padding: "var(--eley-btn-compact-y) var(--eley-btn-compact-x)",
              }}
            >
              {cre.cancelButton}
            </button>
          </form>
        )}

        {teamSelectionMode === "join" && !isSoloInTeam && (
          <>
            <input
              type="text"
              placeholder={rej.searchPlaceholder}
              value={teamSearchQuery}
              onChange={(e) => setTeamSearchQuery(e.target.value)}
              style={{
                ...inputFieldStyle,
                width: "100%",
                padding: "var(--eley-input-pad-y) var(--eley-input-pad-x)",
                fontSize: "var(--eley-text-input)",
                marginBottom: 12,
              }}
              autoFocus
            />

            {(() => {
              const filteredTeams = teamSearchQuery.trim()
                ? availableTeams.filter((team) =>
                    team.name.toLowerCase().includes(teamSearchQuery.toLowerCase())
                  )
                : availableTeams;

              if (filteredTeams.length === 0) {
                return (
                  <div style={{ opacity: 0.7, marginBottom: 12, textAlign: "left" }}>
                    {teamSearchQuery.trim()
                      ? formatMsg(rej.noResults, { query: teamSearchQuery })
                      : rej.noTeamsAvailable}
                  </div>
                );
              }

              return (
                <div style={{ maxHeight: "40vh", overflowY: "auto", marginBottom: 12 }}>
                  {filteredTeams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => handleJoinTeam(team.id)}
                      disabled={busy}
                      style={{
                        ...cardStyle,
                        width: "100%",
                        marginBottom: 8,
                        padding: "var(--eley-card-pad-y)",
                        textAlign: "left",
                        cursor: busy ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        opacity: busy ? 0.7 : 1,
                      }}
                    >
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          background: team.color || "#6b7280",
                          display: "inline-block",
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{team.name}</div>
                        <div style={{ fontSize: "var(--eley-text-caption)", opacity: 0.7 }}>
                          {team.memberCount}{" "}
                          {team.memberCount > 1 ? rej.memberPlural : rej.memberSingular}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              );
            })()}

            <button
              type="button"
              onClick={() => {
                setTeamSelectionMode(null);
                setTeamSearchQuery("");
                setError("");
              }}
              style={{
                ...btnSecondaryStyle,
                width: "100%",
                padding: "var(--eley-btn-compact-y) var(--eley-btn-compact-x)",
              }}
            >
              {rej.cancelButton}
            </button>
          </>
        )}

        {!teamSelectionMode && !isSoloInTeam && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button
              type="button"
              onClick={() => {
                if (teamId) {
                  setTeamSelectionMode(null);
                  setTeamInputName("");
                  setError(eq.mustLeaveBeforeCreate);
                  return;
                }
                setError("");
                setTeamSelectionMode("create");
              }}
              disabled={busy}
              style={teamPrimaryBtnStyle({ busy, disabled: busy })}
            >
              {eq.createButton}
            </button>
            <button
              type="button"
              onClick={() => {
                setTeamSearchQuery("");
                setTeamSelectionMode("join");
                setError(teamId ? rej.alreadyInTeamWarning : "");
              }}
              disabled={busy}
              style={{
                ...btnSecondaryStyle,
                width: "100%",
                padding: "var(--eley-btn-pad-y) var(--eley-btn-pad-x)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {eq.joinButton}
            </button>
            {teamId && teamName && teamMemberCount > 1 && (
              <button
                type="button"
                onClick={handleLeaveTeam}
                disabled={busy}
                style={{
                  ...btnGhostDangerStyle,
                  marginTop: 8,
                  width: "100%",
                  padding: "var(--eley-btn-compact-y) var(--eley-btn-compact-x)",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {formatMsg(eq.leaveTeamButton, { teamName })}
              </button>
            )}
          </div>
        )}
      </PlayerPageShell>
    );
  }

  // 2) Écran bloquant si le joueur a été retiré
  if (isKicked && playerId) {
    return (
      <BrandShell
        style={{
          display: "grid",
          placeItems: "center",
          padding: "var(--eley-shell-pad)",
          textAlign: "center",
          overflowX: "hidden",
        }}
      >
        <div style={{ width: "min(380px, 100%)", margin: "0 auto" }}>
          <h1 style={{ fontSize: "var(--eley-title-md)", fontWeight: 800, margin: 0 }}>
            ELEY&nbsp;Quiz — Accès retiré
          </h1>
          <p style={{ opacity: 0.85, marginTop: 12 }}>
            Vous avez été retiré de la partie par l'animateur.
          </p>
          <div style={{ fontSize: "var(--eley-text-caption)", opacity: 0.7, marginTop: 8 }}>
            (Si c'est une erreur, rapprochez-vous de l'animateur.)
          </div>
        </div>
      </BrandShell>
    );
  }

  // ============================================================================
  // EleyBuzz Mode — Early return si mode buzzer actif (priorité sur showPreStart)
  // Permet d'accéder à EleyBuzz même si le quiz n'a pas encore démarré
  // ============================================================================
  if (isBuzzerMode && playerId) {
    // Jaune / gris / rouge : uniquement l'état Firestore (pas d'optimiste « je suis gagnant »)
    const effectiveBuzzerState = buzzerState || BUZZER_STATES.IDLE;
    
    // Punition = canBuzz false tant que ce n'est pas une nouvelle question (IDLE)
    // Ne jamais masquer la punition avec un état local « pending »
    const isPunished = !canBuzz && effectiveBuzzerState !== BUZZER_STATES.IDLE;
    
    // Clics si ouvert, autorisé, et pas déjà en attente locale
    const canPressBuzzer =
      effectiveBuzzerState === BUZZER_STATES.OPEN && canBuzz && !isBuzzing;

    return (
      <BrandShell
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "var(--eley-shell-pad)",
            textAlign: "center",
            position: "relative",
          }}
        >
        {/* Bandeau joueur en haut */}
        {playerName && teamId && <PlayerHud />}

        <h1 style={{ fontSize: "var(--eley-title-md)", fontWeight: 800, margin: 0, marginBottom: 24 }}>
          ⚡ EleyBuzz ⚡
        </h1>

        {/* BLOC PRINCIPAL ELEYBUZZ : Gère Punition OU Buzzer de manière exclusive */}
        {(() => {
          // Message « bravo » partagé (gagnant + autres) — priorité sur punition / buzzer
          if (buzzerMessageType === "correct" && firstPlayerId) {
            const winner = (playersLB || []).find((p) => p.id === firstPlayerId);
            const winnerName = winner?.name || "Un joueur";
            const isWinner = playerId === firstPlayerId;
            const celebrationText = isWinner
              ? `${playerEleyBuzzMessages.correctAnswer}, ${playerEleyBuzzMessages.youWin} ${buzzerPoints} ${playerEleyBuzzMessages.pts}`
              : `${winnerName} ${playerEleyBuzzMessages.otherScored} ${buzzerPoints} ${playerEleyBuzzMessages.pts}`;

            return (
              <div
                style={{
                  fontSize: "var(--eley-text-eleybuzz)",
                  fontWeight: 800,
                  padding: "var(--eley-buzz-pad-y) var(--eley-buzz-pad-x)",
                  borderRadius: 12,
                  maxWidth: "min(600px, 95%)",
                  lineHeight: 1.5,
                  fontFamily: FONT_FAMILY,
                  ...(isWinner
                    ? { ...badgeSuccess, padding: "var(--eley-buzz-pad-y) var(--eley-buzz-pad-x)", borderRadius: 12 }
                    : {
                        ...cardStyle,
                        border: `2px solid ${BRAND.blue}`,
                        padding: "var(--eley-buzz-pad-y) var(--eley-buzz-pad-x)",
                      }),
                }}
              >
                {celebrationText}
              </div>
            );
          }

          // 1. DÉTECTION STRICTE DE LA PUNITION - PRIORITÉ ABSOLUE
          // isPunished est déjà calculé AVANT ce bloc (ligne ~2041)
          // Cela garantit qu'on ne regarde même pas l'état du buzzer si le joueur est puni
          
          // Si le joueur a donné une mauvaise réponse, afficher un buzzer rouge avec message
          // Si le joueur est puni (canBuzz === false et buzzer pas en IDLE)
          // Cela signifie qu'il a donné une mauvaise réponse et ne peut plus buzzer jusqu'à la prochaine question
          if (isPunished) {
            // Afficher le buzzer rouge avec le message
            return (
              <div style={{ marginBottom: 24, textAlign: "center" }}>
                {/* Buzzer rouge */}
                <button
                  disabled
                  style={{
                    width: "min(280px, 80vw)",
                    height: "min(280px, 80vw)",
                    maxWidth: 300,
                    maxHeight: 300,
                    borderRadius: "50%",
                    border: `4px solid ${BRAND.mauveDark}`,
                    background: BRAND.red,
                    color: "#ffffff",
                    fontSize: "var(--eley-title-lg)",
                    fontWeight: 800,
                    cursor: "default",
                    touchAction: "manipulation",
                    WebkitTapHighlightColor: "transparent",
                    WebkitTouchCallout: "none",
                    userSelect: "none",
                    boxShadow: `0 8px 24px rgba(13, 5, 37, 0.35)`,
                    marginBottom: 24,
                  }}
                >
                  BUZZER
                </button>
                
                {/* Message de mauvaise réponse */}
                <div 
                  style={{ 
                    opacity: 0.95, 
                    fontSize: "var(--eley-text-body)", 
                    color: BRAND.red,
                    fontWeight: 700,
                    textShadow: `0 0 1px ${BRAND.mauveDark}`,
                    lineHeight: 1.6,
                  }}
                >
                  Mauvaise réponse{lastWrongPenalty ? `, tu perds ${lastWrongPenalty} point${lastWrongPenalty > 1 ? 's' : ''}` : ''}. Attends la prochaine question pour rejouer !
                </div>
              </div>
            );
          }

          // 2. SI PAS PUNI (canBuzz = true) : GESTION DU BUZZER
          
          // État IDLE : message d'attente
          if (effectiveBuzzerState === BUZZER_STATES.IDLE) {
            return (
              <div 
                style={{ opacity: 0.85, fontSize: "var(--eley-text-body)", lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ 
                  __html: addSmartLineBreaks(playerEleyBuzzMessages.idle)
                }}
              />
            );
          }

          // États OPEN, LOCKED : Affichage du buzzer
          // Déterminer la couleur et l'état du buzzer
          const getBuzzerStyle = () => {
            // Garde-fou pour la production : s'assurer que effectiveBuzzerState est valide
            if (!effectiveBuzzerState || typeof effectiveBuzzerState !== 'string') {
              // Fallback si l'état n'est pas valide (peut arriver en production)
              return {
                background: BRAND.mauveLight,
                border: BRAND.mauveDark,
                shadow: "0 8px 24px rgba(13, 5, 37, 0.25)",
                isClickable: false,
                isAnimating: false,
              };
            }

            // Si OPEN : bleu (actif)
            if (effectiveBuzzerState === BUZZER_STATES.OPEN) {
              return {
                background: BRAND.blue,
                border: BRAND.mauveDark,
                shadow: "0 8px 24px rgba(16, 170, 209, 0.4)",
                isClickable: canPressBuzzer,
                isAnimating: false,
              };
            }
            
            // Si LOCKED : déterminer selon qui a buzzé (Firestore uniquement)
            if (effectiveBuzzerState === BUZZER_STATES.LOCKED) {
              if (firstPlayerId && playerId && firstPlayerId === playerId) {
                return {
                  background: BRAND.yellow,
                  border: BRAND.mauveDark,
                  shadow: "0 8px 24px rgba(254, 237, 106, 0.45)",
                  isClickable: false,
                  isAnimating: false,
                };
              }
              
              return {
                background: BRAND.mauveLight,
                border: BRAND.mauveDark,
                shadow: "0 8px 24px rgba(13, 5, 37, 0.25)",
                isClickable: false,
                isAnimating: false,
              };
            }
            
            // Fallback : bleu
            return {
              background: BRAND.blue,
              border: BRAND.mauveDark,
              shadow: "0 8px 24px rgba(16, 170, 209, 0.4)",
              isClickable: false,
              isAnimating: false,
            };
          };
          
          const buzzerStyle = getBuzzerStyle();
          // Tap envoyé, gagnant pas encore connu (fenêtre d'équité)
          const isWaitingVerification =
            isBuzzing &&
            !firstPlayerId &&
            effectiveBuzzerState === BUZZER_STATES.OPEN;
          
          return (
            <>
              {/* Buzzer toujours visible (sauf IDLE) */}
              <button
                onTouchStart={(e) => {
                  // Animation visuelle seulement pour les buzzers bleus (OPEN)
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  
                  if (canAnimate) {
                    e.preventDefault();
                    // Animation immédiate
                    e.currentTarget.style.transform = "scale(0.95)";
                    e.currentTarget.style.background = BUZZER_BLUE_PRESSED;
                    
                    // Appeler handleBuzzerPress seulement si cliquable
                    if (buzzerStyle.isClickable) {
                      handleBuzzerPress();
                    }
                  }
                }}
                onClick={(e) => {
                  // Animation visuelle seulement pour les buzzers bleus (OPEN)
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  
                  if (canAnimate) {
                    e.preventDefault();
                    
                    // Appeler handleBuzzerPress seulement si cliquable
                    if (buzzerStyle.isClickable) {
                      handleBuzzerPress();
                    }
                  }
                }}
                disabled={effectiveBuzzerState === BUZZER_STATES.LOCKED} // Désactivé seulement en LOCKED
                style={{
                  width: "min(280px, 80vw)",
                  height: "min(280px, 80vw)",
                  maxWidth: 300,
                  maxHeight: 300,
                  borderRadius: "50%",
                  border: `4px solid ${buzzerStyle.border}`,
                  background: buzzerStyle.background,
                  color: (() => {
                    // Griser le texte seulement si le buzzer est verrouillé ET que ce n'est pas le premier joueur
                    const isGreyedOut = effectiveBuzzerState === BUZZER_STATES.LOCKED && 
                                       firstPlayerId && 
                                       firstPlayerId !== playerId;
                    if (isGreyedOut) return "rgba(255,251,245,0.5)";
                    if (buzzerStyle.background === BRAND.yellow) return BRAND.mauveDark;
                    return "#ffffff";
                  })(),
                  fontSize: "var(--eley-title-lg)",
                  fontWeight: 800,
                  cursor: effectiveBuzzerState === BUZZER_STATES.OPEN ? "pointer" : "default",
                  touchAction: "manipulation",
                  WebkitTapHighlightColor: "transparent",
                  WebkitTouchCallout: "none",
                  userSelect: "none",
                  transition: "transform 100ms ease, background 100ms ease, color 100ms ease",
                  boxShadow: buzzerStyle.shadow,
                  // Pas d'animation automatique, seulement au clic/touch
                }}
                onMouseDown={(e) => {
                  // Animation visuelle seulement pour les buzzers bleus (OPEN)
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(0.95)";
                    e.currentTarget.style.background = BUZZER_BLUE_PRESSED;
                  }
                }}
                onMouseUp={(e) => {
                  // Réinitialiser seulement si on était en OPEN
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.background = buzzerStyle.background;
                  }
                }}
                onMouseLeave={(e) => {
                  // Réinitialiser seulement si on était en OPEN
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.background = buzzerStyle.background;
                  }
                }}
                onTouchEnd={(e) => {
                  // Réinitialiser seulement si on était en OPEN
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.background = buzzerStyle.background;
                  }
                }}
                title={
                  buzzerStyle.isClickable 
                    ? "Appuie pour buzzer !" 
                    : (firstPlayerId && playerId && firstPlayerId === playerId)
                      ? "À toi de répondre !" 
                      : "Le buzzer est verrouillé"
                }
              >
                BUZZER
              </button>
              
              {/* Messages de bonne/mauvaise réponse (affichés en dessous) - seulement en LOCKED */}
              {effectiveBuzzerState === BUZZER_STATES.LOCKED && !isWaitingVerification && (
                <div 
                  style={{ 
                    marginTop: 24,
                    opacity: 0.9, 
                    fontSize: "var(--eley-icon-label)",
                    fontWeight: (playerId && firstPlayerId && playerId === firstPlayerId) ? 700 : 400,
                    lineHeight: 1.6,
                  }}
                >
                  {playerId && firstPlayerId && playerId === firstPlayerId
                    ? playerEleyBuzzMessages.yourTurn
                    : (firstPlayerId && playerId && firstPlayerId !== playerId
                        ? (playerEleyBuzzMessages.tooSlow || playerEleyBuzzMessages.locked)
                        : null)}
                </div>
              )}
            </>
          );
        })()}

      </BrandShell>
    );
  }

  // ============================================================================
  // Score Final Mode — Early return si mode score final actif (priorité sur tout)
  // ============================================================================
  if (showFinalScore && playerId) {
    return (
      <BrandShell
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--eley-shell-pad)",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "var(--eley-title-md)", fontWeight: 800, margin: 0, marginBottom: 24 }}>
          Fin de la soirée, voici les scores
        </h1>

        <PlayerScorePanel
          teamName={teamName}
          teamColor={teamColor}
          teamScore={teamQuizScore}
          teamRank={myTeamRank}
          playerName={playerName}
          playerScore={myFinalScore}
          buzzScore={myBuzzScore}
          showBuzz={Number(myBuzzScore) !== 0}
          showTeam={Boolean(teamId)}
        />
        {myFinalRank != null && (
          <div style={{ marginTop: 10, fontSize: "var(--eley-text-meta)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
            {showPlayerFinalRankCircle ? <PlayerRankCircle rank={myFinalRank} size={13} /> : null}
            Classement personnel : {myFinalRank === 1 ? "1er" : myFinalRank === 2 ? "2ème" : myFinalRank === 3 ? "3ème" : `${myFinalRank}ème`}
          </div>
        )}
      </BrandShell>
    );
  }

  // 3) Écran d'attente une fois inscrit (avant lancement par l'Admin)
  // (Affiché seulement si EleyBuzz n'est pas actif)
  if (showPreStart && playerId) {
    const att = playerAttenteMessages;
    const attenteLinkStyle = {
      marginTop: 12,
      fontSize: "var(--eley-text-attente-link)",
      fontWeight: 600,
      opacity: 0.92,
      textAlign: "center",
      width: "100%",
      lineHeight: 1.45,
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "center",
      gap: "0.25em",
    };
    const attenteLinkBtnStyle = {
      color: BRAND.blue,
      background: "transparent",
      border: "none",
      cursor: "pointer",
      font: "inherit",
      fontWeight: 700,
      padding: 0,
      display: "inline-flex",
      alignItems: "center",
      verticalAlign: "middle",
    };

    return (
      <BrandShell
        style={{
          display: "flex",
          flexDirection: "column",
          ...PLAYER_SHELL_PAD,
          position: "relative",
          overflowX: "hidden",
        }}
      >
        {playerName && teamId && <PlayerHud />}

        <div
          style={{
            position: "relative",
            zIndex: 3,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            minHeight: 0,
          }}
        >
          <h1 style={PLAYER_TITLE_STYLE}>
            {att.titleLine1}
            <br />
            {att.titleLine2}
          </h1>
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 3,
            width: "min(var(--eley-content-narrow), 100%)",
            maxWidth: "100%",
            margin: "0 auto",
            flexShrink: 0,
            textAlign: "center",
          }}
        >
          {!nameLocked && !isRunning ? (
            <>
              <div style={attenteLinkStyle}>
                {att.changeNameHint}{" "}
                <button type="button" onClick={resetAndDeletePlayer} style={attenteLinkBtnStyle}>
                  <span style={{ textDecoration: "underline" }}>{att.changeNameButton}</span>
                  <HudPlayerIcon size="var(--eley-icon-inline)" style={{ marginLeft: 5 }} />
                </button>
              </div>
              {teamId && teamName && (
                <div style={attenteLinkStyle}>
                  {att.changeTeamHint}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setNeedsTeamSelection(true);
                      setTeamSelectionMode(null);
                    }}
                    style={attenteLinkBtnStyle}
                  >
                    <span style={{ textDecoration: "underline" }}>{att.changeTeamButton}</span>
                    <HudTeamStar size="var(--eley-icon-inline)" style={{ marginLeft: 5 }} />
                  </button>
                </div>
              )}
            </>
          ) : (
            nameLocked && (
              <div style={{ ...attenteLinkStyle, opacity: 0.75, fontWeight: 500 }}>
                {att.nameLocked}
              </div>
            )
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0 }} aria-hidden="true" />
      </BrandShell>
    );
  }

  // ============================================================================
  // /pages/player.js — Partie 5/6
  // Scope : Écran principal pendant le quiz — overlay anti-flicker, timer,
  //         badge nom, fin de quiz / fin de manche / pause, phases (question /
  //         reveal / décompte), barre de temps, image, score, saisie + anti-spam,
  //         bannière de bonne réponse, styles d'animations.
  // ============================================================================

  // 4) Écran principal pendant le quiz
  return (
    <BrandShell
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "max(100dvh, calc(var(--vh, 1vh) * 100))",
        padding: "var(--eley-page-pad)",
        paddingTop: isRunning
          ? `calc(${TOP_GUTTER_RUNNING} + var(--eley-page-pad) + ${SAFE_TOP})`
          : `calc(${TOP_GUTTER_IDLE} + var(--eley-page-pad) + ${SAFE_TOP})`,
        paddingBottom: `calc(var(--eley-page-pad) + env(safe-area-inset-bottom, 0px) + 72px)`,
        textAlign: "center",
        position: "relative",
        overflowX: "hidden",
      }}
    >
      {/* Voile anti-flicker */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "#000000",
          opacity: uiMasked ? 0.96 : 0,
          transition: "opacity 120ms ease",
          pointerEvents: "none",
          zIndex: 50,
        }}
      />

      {/* Bandeau joueur en haut */}
      {playerName && teamId && <PlayerHud />}

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          width: "100%",
          position: "relative",
          zIndex: 3,
        }}
      >

      {/* ====================== Branches principales d’affichage ====================== */}

      {/* Fin du quiz : message perso + classement */}
      {isQuizEnded ? (
        <>
          <div style={PLAYER_TITLE_HEADER}>
            <h2 style={{ fontSize: "var(--eley-quiz-end-title)", margin: 0 }}>
              {playerFinMessages.endOfQuizTitle}
            </h2>
          </div>

          <div style={PLAYER_PODIUM_CENTER}>
            <PlayerRoundBreakPanel
              teamsRanking={teamsRanking}
              ranking={ranking}
              teamId={teamId}
              teamName={teamName}
              teamRank={myTeamRank}
              teamScore={myTeamScore}
              playerName={playerName}
              playerRank={myRank}
              playerScore={myScore}
              teamsSectionTitle={playerFinMessages.finalPodiumTeams}
              playersSectionTitle={playerFinMessages.finalPodiumPlayers}
              nothingDecidedText=""
            />
          </div>
        </>
      ) : isRoundBreak ? (
        <>
          <div style={PLAYER_TITLE_HEADER}>
            <h2 style={{ fontSize: "var(--eley-round-break-title)", fontWeight: 800, margin: 0 }}>
              {playerFinMessages.endOfRoundTitle} {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
            </h2>
          </div>

          <div style={PLAYER_PODIUM_CENTER}>
            <PlayerRoundBreakPanel
              teamsRanking={teamsRanking}
              ranking={ranking}
              teamId={teamId}
              teamName={teamName}
              teamRank={myTeamRank}
              teamScore={myTeamScore}
              playerName={playerName}
              playerRank={myRank}
              playerScore={myScore}
              teamsSectionTitle={playerFinMessages.provisionalPodiumTeams}
              playersSectionTitle={playerFinMessages.provisionalPodiumPlayers}
              nothingDecidedText={playerFinMessages.nothingDecided}
            />
          </div>
        </>
      ) : holdRoundBoundaryCountdown ? (
        <PlayerCenterStage>
          <div style={countdownLabelStyle}>{countdownLabel}</div>
          <div style={countdownNumberStyle}>{displayCountdownSec}</div>
        </PlayerCenterStage>
      ) : isPaused ? (
        <PlayerCenterStage>
          <h2 style={pauseTitleStyle}>On revient dans un instant…</h2>
          <div style={pauseSubtitleStyle}>
            Le quiz est momentanément en pause.
          </div>
        </PlayerCenterStage>
      ) : currentQuestion ? (
        isRoundIntroPhase ? (
          <PlayerCenterStage>
            <div style={countdownLabelStyle}>
              {roundNumberForIntro ? `La manche ${roundNumberForIntro} commence dans :` : "La manche commence dans :"}
            </div>
            <div style={countdownNumberStyle}>
              {introCountdownSec}
            </div>
          </PlayerCenterStage>
        ) : showCountdownUi ? (
          <PlayerCenterStage>
            <div style={countdownLabelStyle}>
              {countdownLabel}
            </div>
            <div style={countdownNumberStyle}>
              {displayCountdownSec}
            </div>
          </PlayerCenterStage>
        ) : (
        <>
          {/* ======================== Phases de la question ======================== */}

          {isQuestionPhase ? (
            <>
              {/* Phase question */}
              <h2 
                style={questionH2Style}
                dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
              />

              {/* Image question (optionnelle) — tailles via --eley-img-question-* */}
              {currentQuestion?.imageQuestionUrl ? (
                <div
                  style={{
                    width: currentQuestion.imageQuestionLarge
                      ? "var(--eley-img-question-lg)"
                      : "var(--eley-img-question-sm)",
                    height: currentQuestion.imageQuestionLarge
                      ? "var(--eley-img-question-lg)"
                      : "var(--eley-img-question-sm)",
                    maxWidth: "100%",
                    margin: "16px auto",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: IMAGE_FRAME_BG,
                    border: `1px solid ${BRAND.mauveDark}`,
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  <img
                    src={currentQuestion.imageQuestionUrl}
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
            </>
          ) : isRevealAnswerPhase ? (

            // Révélation de la réponse
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div style={{
                ...pageTextSecondary,
                fontSize: "var(--eley-text-meta)",
                fontWeight: 600,
                marginBottom: 8,
                lineHeight: 1.4,
                maxWidth: "min(600px, 95%)",
                marginLeft: "auto",
                marginRight: "auto",
                textAlign: "center",
              }}>
                {playerQuizMessages.revealAnswer}
              </div>
              <h2
                style={{
                  ...questionTextStyle,
                  fontSize: "var(--eley-text-reveal)",
                  color: BRAND.yellow,
                }}
                dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(primaryAnswer) }}
              />
            </div>
          ) : (
            // Fallback conservateur
            <h2 
              style={questionH2Style}
              dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
            />
          )}

          {/* -------------------------- Barre de temps -------------------------- */}
          {canShowTimeBar && (
            <div
              style={{
                width: "min(620px, 92%)",
                height: BAR_H,
                margin: "12px auto 10px",
                background: BAR_BLUE,
                borderRadius: 9999,
                overflow: "hidden",
                position: "relative",
                visibility: uiMasked ? "hidden" : "visible", // cache tant que masque actif
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

          {/* ----------------------- Image pendant le reveal ----------------------- */}
          {isRevealAnswerPhase && !isRoundBreak && preloadedImage ? (
            <div
              style={{
                width: "var(--eley-img-reveal)",
                height: "var(--eley-img-reveal)",
                maxWidth: "100%",
                margin: "16px auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: IMAGE_FRAME_BG,
                border: `1px solid ${BRAND.mauveDark}`,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <img
                src={preloadedImage}
                alt="Réponse visuelle — œuvre"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  imageRendering: "auto",
                  visibility: preloadedImage ? "visible" : "hidden",
                }}
                loading="eager"
                decoding="async"
              />
            </div>
          ) : null}

          {isRevealAnswerPhase && revealPointsFeedback ? (
            <div style={{ textAlign: "center" }}>{revealPointsFeedback}</div>
          ) : null}

          {/* -------------------- QCM (4 propositions, ordre mélangé) -------------------- */}
          {showQcmChoices && (
            <div
              style={{
                marginTop: 16,
                width: "min(var(--eley-content-wide), 92vw)",
                maxWidth: "100%",
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                {qcmShuffledIndices.map((origIdx) => {
                  const label = qcmOptions[origIdx] || "";
                  const isCorrectPick =
                    result === "correct" && origIdx === qcmCorrectIndex;
                  const disabled = qcmBusy || hadCorrectEver || isCorrectPick;

                  return (
                    <button
                      key={origIdx}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleQcmChoice(origIdx)}
                      style={{
                        width: "100%",
                        padding: "var(--eley-choice-pad-y) var(--eley-choice-pad-x)",
                        borderRadius: 12,
                        border: `2px solid ${isCorrectPick ? BRAND.mauveDark : BRAND.mauveDark}`,
                        background: isCorrectPick ? BRAND.green : "rgba(255, 251, 245, 0.95)",
                        color: BRAND.mauveDark,
                        fontSize: "var(--eley-text-choice)",
                        fontFamily: FONT_FAMILY,
                        fontWeight: 600,
                        textAlign: "left",
                        cursor: disabled ? "not-allowed" : "pointer",
                        touchAction: "manipulation",
                        WebkitTapHighlightColor: "transparent",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bannière QCM raté (sans propositions — discret pour les voisins) */}
          {isQuestionPhase && showQcmFailed && (
            <div style={{ marginTop: 16, textAlign: "center" }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "var(--eley-btn-compact-y) var(--eley-btn-pad-x)",
                  borderRadius: 10,
                  ...badgeError,
                }}
              >
                Mauvaise réponse
              </div>
            </div>
          )}

          {/* -------------------- Saisie texte + anti-spam / cooldown -------------------- */}
          <form onSubmit={handleAnswerSubmit}>
            {showTextInput ? (
              <input
                ref={answerInputRef}
                className="answerInput"
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  // Capte Enter pour éviter un submit natif qui fermerait le clavier
                  if (e.key === "Enter" && !isLocked) {
                    e.preventDefault();
                    const trimmed = (answer ?? "").trim();
                    if (trimmed.length > 0) {
                      handleAnswerSubmit();
                      // Re-focus immédiat pour conserver le clavier ouvert
                      const el = answerInputRef?.current;
                      if (el) {
                        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
                        try { el.setSelectionRange(0, 0); } catch { }
                      }
                    }
                  }
                }}

                placeholder="Votre réponse"
                style={{
                  ...inputFieldStyle,
                  width: "min(var(--eley-content-wide), 100%)",
                  maxWidth: "92vw",
                  padding: "var(--eley-input-pad-y) var(--eley-input-pad-x)",
                  marginTop: "16px",
                  fontSize: "var(--eley-text-input)",
                  visibility: uiMasked ? "hidden" : "visible",
                }}
                autoFocus={!uiMasked}
                inputMode="text"
                enterKeyHint="send"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
              />



            ) : isLocked && isQuestionPhase ? (
              <p
                style={{
                  color: BRAND.yellow,
                  fontWeight: 800,
                  fontSize: "var(--eley-text-body)",
                  marginTop: 16,
                }}
              >
                {lockText} ({lockRemainingSec}s)
              </p>
            ) : null}
          </form>

          {/* Bouton "Valider" — visible sur toutes plateformes quand l'input est visible */}
          {showTextInput && (
            <div style={{ marginTop: 10, textAlign: "center" }}>
              <button
                type="button"
                onMouseDown={keepInputFocus}
                onTouchStart={keepInputFocus}
                onClick={handleAnswerSubmit}
                disabled={isLocked || !((answer ?? "").trim().length > 0)}
                style={{
                  ...btnPrimaryStyle,
                  width: "auto",
                  minWidth: "120px",
                  padding: "var(--eley-btn-pad-y) 24px",
                  boxSizing: "border-box",
                  display: "inline-block",
                  background: isLocked ? BRAND.mauveLight : BRAND.blue,
                  cursor: isLocked ? "not-allowed" : "pointer",
                }}
                aria-disabled={isLocked ? "true" : "false"}
                title={isLocked ? "En cooldown anti-spam" : "Valider la réponse"}
              >
                Valider
              </button>
            </div>
          )}





          {/* Bannière "bonne réponse" persistante pendant la phase question */}
          {isQuestionPhase && (hadCorrectEver || showGoodNow) && (
            <div style={{ marginTop: 8, textAlign: "center" }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "var(--eley-btn-compact-y) var(--eley-btn-pad-x)",
                  borderRadius: 10,
                  ...badgeSuccess,
                }}
              >
                {showGoodNow ? playerQuizMessages.correctAnswer : playerQuizMessages.alreadyCorrect}
              </div>
              {questionPointsFeedback}
            </div>
          )}
        </>
        )
      ) : (
        // ============================== Fallbacks ==============================
        <>
          {!isRunning && <p>En attente du démarrage…</p>}

          {isRunning && earliestTimeSec != null && elapsedSec < earliestTimeSec && (
            <p>En attente de la première question (à {formatHMS(earliestTimeSec)})…</p>
          )}

          {isRunning && earliestTimeSec == null && (
            <p>Aucune question planifiée (ajoute des timecodes dans l’admin).</p>
          )}

          {isRunning && earliestTimeSec != null && elapsedSec >= earliestTimeSec && !currentQuestion && (
            <p>Patiente… (synchronisation)</p>
          )}
        </>
      )}

      </div>

      {/* ============================== Styles locaux ============================== */}
      <style jsx>{`
        /* Input réponse — fond clair, texte mauve foncé */
.answerInput {
  color: #0d0525 !important;
  caret-color: #0d0525 !important;
  -webkit-text-fill-color: #0d0525 !important;
  font-family: "Source Sans 3", system-ui, sans-serif !important;
  background: rgba(255, 251, 245, 0.95) !important;
  border: 1px solid #0d0525 !important;
  border-radius: 10px;
}

.answerInput::placeholder {
  color: rgba(93, 24, 60, 0.75);
}

.answerInput.flashWrong {
  color: #0d0525 !important;
  -webkit-text-fill-color: #0d0525 !important;
}

.answerInput:-webkit-autofill {
  -webkit-text-fill-color: #0d0525 !important;
  caret-color: #0d0525 !important;
  background: rgba(255, 251, 245, 0.95) !important;
  transition: background-color 99999s ease-out 0s;
}


        .answerInput.shake { animation: shake 250ms ease-in-out; }
        @keyframes shake {
          0% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
          100% { transform: translateX(0); }
        }
        .answerInput.flashWrong { animation: flashWrong 220ms ease-out; }
        @keyframes flashWrong {
          0% {
            box-shadow:
              0 0 0 3px rgba(255, 0, 0, 0.95) inset,
              0 0 0 9999px rgba(255, 0, 0, 0.28) inset,
              0 0 10px rgba(255, 0, 0, 0.85);
            background-color: rgba(255, 0, 0, 0.35);
            border-color: rgba(255, 0, 0, 1);
          }
          60% {
            box-shadow:
              0 0 0 2px rgba(255, 0, 0, 0.75) inset,
              0 0 0 9999px rgba(255, 0, 0, 0.18) inset,
              0 0 6px rgba(255, 0, 0, 0.6);
            background-color: rgba(255, 0, 0, 0.18);
          }
          100% {
            box-shadow: none;
            background-color: inherit;
            border-color: inherit;
          }
        }
      `}</style>
    </BrandShell>
  );
}
