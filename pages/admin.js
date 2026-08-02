// ============================================================================
// /pages/admin.js — Refactoré avec imports depuis /lib
// Scope : Interface d'administration complète (questions, joueurs, contrôles)
// ============================================================================

import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { db, storage } from "../lib/firebase";
import {
  collection,
  query,
  orderBy,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  addDoc,
  writeBatch,
  setDoc,
  serverTimestamp,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  runTransaction,
  where,
  increment,
  deleteField,
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import AuthGate from "../lib/AuthGate";
import StreamDeckRemotePanel from "../lib/StreamDeckRemotePanel";
import {
  sortedQuestionTimes,
  currentQuestionIndex,
  buildQuizMarkers,
  resolveNextMarker,
  firstMarkerOfRound,
  planBackSeek,
  getTransportUi,
  makeStreamDeckSecret,
} from "../lib/quiz-seek";

// Imports depuis les fichiers utilitaires
import {
  DEFAULT_SCORING_TABLE,
  DEFAULT_TEAM_SCORING_TABLE,
  DEFAULT_REVEAL_DURATION_SEC,
  DEFAULT_LEADERBOARD_TOP_N,
  TIME_MUSIC_MIN_SEC,
  DEFAULT_TIME_MUSIC_SEC,
  PLAYER_COLORS,
  DEFAULT_BUZZER_POINTS,
  BUZZER_CORRECT_MESSAGE_DURATION_MS,
  BUZZER_STATES,
  ROUND_BOUNDARY_GAP_SEC,
} from "../lib/constants";
import { DEFAULT_REVEAL_PHRASES, ELEYBUZZ_SCREEN_MESSAGES } from "../lib/messages";

import {
  parseHMS,
  formatHMS,
  parseCSV,
  toCSV,
  clampTimeMusicSec,
  normKey,
  pickColorDifferent,
  normalizeNameAlpha,
  normalizeTeamName,
  getTimeSec,
} from "../lib/utils";

import {
  QUESTION_TYPE_OPEN,
  QUESTION_TYPE_QCM,
  getQuestionType,
  normalizeQcmOptions,
  getQcmCorrectIndex,
  qcmAnswersFromOptions,
  validateQcmOptions,
} from "../lib/qcm";

import {
  deleteTeamTx,
  ensureAwardsForQuestionTx,
  awardBuzzerPoints,
  resetBuzzerState,
  openBuzzerForNewRound,
  recoverEleyBuzzPlayers,
  resetAllPlayerBuzzLocks,
  purgeAnswersTree,
} from "../lib/firebase-helpers";

// ============================================================================
// [1.4] Config par défaut (idempotent)
// ============================================================================

/* =================== CONFIG PAR DÉFAUT (IDEMPOTENT) =================== */
/**
 * S'assure que le doc "quiz/config" existe et contient au minimum :
 * - scoringTable
 * - revealDurationSec
 * - leaderboardTopN
 * - quizzes[] avec un quiz par défaut
 * - activeQuizKey
 * + backfill des questions existantes (quizKey par défaut si manquant).
 */
async function ensureConfigDefaults() {
  const cfgRef = doc(db, "quiz", "config");
  const snap = await getDoc(cfgRef);
  const data = snap.exists() ? snap.data() : {};
  const patch = {};

  // Defaults existants
  // Vérifier si la table de scoring est l'ancienne (commence par 30) et la mettre à jour
  const currentScoringTable = data.scoringTable;
  const isOldScoringTable = Array.isArray(currentScoringTable) && currentScoringTable[0] === 30;
  if (!("scoringTable" in data) || isOldScoringTable) {
    patch.scoringTable = DEFAULT_SCORING_TABLE;
  }
  if (!("teamScoringTable" in data)) patch.teamScoringTable = DEFAULT_TEAM_SCORING_TABLE;
  if (!("revealDurationSec" in data)) {
    patch.revealDurationSec = DEFAULT_REVEAL_DURATION_SEC;
  }
  if (!("leaderboardTopN" in data)) {
    patch.leaderboardTopN = DEFAULT_LEADERBOARD_TOP_N;
  }

  // === Gestion des quizzes ===
  // Clé par défaut pour le premier quiz (ancien onglet "Questions")
  const defaultQuizKey =
    typeof data.activeQuizKey === "string" && data.activeQuizKey
      ? data.activeQuizKey
      : "quiz-test";

  let quizzes = Array.isArray(data.quizzes)
    ? data.quizzes.filter((q) => q && q.key && q.name)
    : [];

  if (!quizzes.length) {
    // Premier quiz : "Quiz test"
    quizzes = [
      {
        key: defaultQuizKey,
        name: "Quiz test",
      },
    ];
    patch.quizzes = quizzes;
  } else if (!quizzes.some((q) => q.key === defaultQuizKey)) {
    // S'assurer que le quiz actif est bien présent dans la liste
    quizzes = [...quizzes, { key: defaultQuizKey, name: "Quiz test" }];
    patch.quizzes = quizzes;
  }

  if (!("activeQuizKey" in data) || !data.activeQuizKey) {
    patch.activeQuizKey = defaultQuizKey;
  }

  if (Object.keys(patch).length > 0) {
    await setDoc(cfgRef, patch, { merge: true });
  }

  // Backfill des questions existantes : leur attribuer quizKey = defaultQuizKey si manquant
  await backfillQuestionsQuizKey(defaultQuizKey);

  // Initialiser les valeurs EleyBuzz dans quiz/state si absentes
  try {
    const stateRef = doc(db, "quiz", "state");
    const stateSnap = await getDoc(stateRef);
    const stateData = stateSnap.exists() ? stateSnap.data() : {};
    const statePatch = {};

    // Initialiser isBuzzerMode si absent
    if (!("isBuzzerMode" in stateData)) {
      statePatch.isBuzzerMode = false;
    }

    // Initialiser buzzerState si absent
    if (!("buzzerState" in stateData)) {
      statePatch.buzzerState = "idle";
    }

    // Initialiser buzzerPoints si absent (configurable dans admin)
    if (!("buzzerPoints" in stateData)) {
      statePatch.buzzerPoints = DEFAULT_BUZZER_POINTS;
    }

    // Initialiser firstPlayerId et firstPlayerName à null si absents
    if (!("firstPlayerId" in stateData)) {
      statePatch.firstPlayerId = null;
    }
    if (!("firstPlayerName" in stateData)) {
      statePatch.firstPlayerName = null;
    }

    // Appliquer les patches si nécessaire
    if (Object.keys(statePatch).length > 0) {
      await setDoc(stateRef, statePatch, { merge: true });
    }
  } catch (e) {
    console.error("[ensureConfigDefaults] EleyBuzz init failed:", e);
    // Ne pas bloquer le reste de l'initialisation
  }
}

/**
 * Ajoute quizKey = defaultQuizKey à toutes les questions de LesQuestions
 * qui n'ont pas encore de quizKey.
 */
async function backfillQuestionsQuizKey(defaultQuizKey) {
  try {
    if (!defaultQuizKey) return;

    const colRef = collection(db, "LesQuestions");
    const snap = await getDocs(colRef);

    const docsToFix = snap.docs.filter((d) => {
      const data = d.data() || {};
      return !data.quizKey;
    });

    if (!docsToFix.length) return;

    console.log(
      "[Admin] backfill quizKey on",
      docsToFix.length,
      "questions"
    );

    // Batch par blocs de 400 pour rester safe côté Firestore
    while (docsToFix.length) {
      const chunk = docsToFix.splice(0, 400);
      const batch = writeBatch(db);

      chunk.forEach((docSnap) => {
        batch.update(doc(colRef, docSnap.id), { quizKey: defaultQuizKey });
      });

      await batch.commit();
    }
  } catch (e) {
    console.error("backfillQuestionsQuizKey error:", e);
  }
}

// ============================================================================
// [1.7] Toggle Pause / Reprendre — même logique que Back/Next/Start
// ============================================================================

/**
 * Bascule entre Pause et Reprise du quiz live.
 * - Reconstruit startMs à partir de anchorAt/anchorOffsetSec ou startAt/startEpochMs.
 * - Empêche Pause/Reprendre avant le départ ou après la fin.
 * - Lors de la reprise, ré-ancre exactement à l'elapsed au moment de la pause.
 */
async function togglePauseResume(db) {
  const stateRef = doc(db, "quiz", "state");
  const snap = await getDoc(stateRef);
  const d = snap.data() || {};

  // Reconstruit startMs depuis l’ancrage si présent ; fallback legacy
  let startMs = null;

  if (d.anchorAt && typeof d.anchorAt.seconds === "number") {
    const anchorMs =
      d.anchorAt.seconds * 1000 +
      Math.floor((d.anchorAt.nanoseconds || d.anchorAt.nanos || 0) / 1e6);
    const offsetSec = Number.isFinite(d.anchorOffsetSec)
      ? d.anchorOffsetSec
      : 0;

    // On veut : elapsed ≈ (now - anchorAt) + offsetSec
    // ⇔ (now - startMs) ≈ (now - (anchorAt - offsetSec * 1000))
    startMs = anchorMs - offsetSec * 1000;
  } else if (d.startAt && typeof d.startAt.seconds === "number") {
    startMs =
      d.startAt.seconds * 1000 +
      Math.floor((d.startAt.nanoseconds || 0) / 1e6);
  } else if (typeof d.startEpochMs === "number") {
    startMs = d.startEpochMs;
  }

  // Gardes : ne pas permettre Pause/Reprendre avant le départ ou après la fin
  const running = !!d.isRunning;
  const hasStart = Number.isFinite(startMs) && startMs > 0;
  const endOffset = Number.isFinite(d.endOffsetSec) ? d.endOffsetSec : null;

  const nowMs = Date.now();
  const elapsedIfRunning = hasStart
    ? Math.floor((nowMs - startMs) / 1000)
    : 0;

  const isEnded = Number.isFinite(endOffset)
    ? elapsedIfRunning >= endOffset
    : false;

  if (!running || !hasStart || isEnded) {
    // en dehors des phases valides → on ignore
    return;
  }

  // Toggle
  if (d.isPaused) {
    // Reprendre — repartir exactement là où on s'était arrêté
    if (!d.pauseAt || typeof d.pauseAt.seconds !== "number" || !hasStart) {
      await updateDoc(stateRef, {
        isPaused: false,
        // reset de la sentinelle de fin de manche, sinon l'écran reste en "Fin de la manche"
        lastAutoPausedRoundIndex: null,
        navSeq: (Number(d.navSeq) || 0) + 1,
      });
      return;
    }

    const pauseAtMs =
      d.pauseAt.seconds * 1000 +
      Math.floor((d.pauseAt.nanoseconds || d.pauseAt.nanos || 0) / 1e6);

    const lastElapsedSec = Math.max(
      0,
      Math.floor((pauseAtMs - startMs) / 1000)
    );

    await updateDoc(stateRef, {
      isPaused: false,
      // re-ancre proprement pour repartir EXACTEMENT au même elapsed
      anchorAt: serverTimestamp(),
      anchorOffsetSec: lastElapsedSec,
      // important : on nettoie la sentinelle de fin de manche
      lastAutoPausedRoundIndex: null,
      navSeq: (Number(d.navSeq) || 0) + 1,
    });
  } else {
    // Mettre en pause — snapshot de l'instant courant (pause MANUELLE)
    await updateDoc(stateRef, {
      isPaused: true,
      pauseAt: serverTimestamp(),
      lastAutoPausedRoundIndex: null, // ne pas afficher "Fin de la manche"
      navSeq: (Number(d.navSeq) || 0) + 1,
    });
  }
}
// ============================================================================
// /pages/admin.js — Partie 2/6
// Scope : Début du composant Admin — états, helpers internes, effets 1→3
// Règles : aucune modification fonctionnelle ; seulement commentaires/sections.
// ============================================================================

/* =============================== COMPOSANT =============================== */
/* ====================== ÉTATS & HELPERS INTERNES (PARTIE 2/6) ====================== */

function AdminInner() {
  /* [2.1] Étape 0 : injecter la config par défaut si absente */
  useEffect(() => {
    ensureConfigDefaults().catch((e) =>
      console.error("ensureConfigDefaults error:", e)
    );
  }, []);

  // [2.2] Garde locale pour l’attribution auto (anti multi-déclenchements UI)
  const awardGuardRef = useRef({});

  /* [2.3] Helpers internes spécifiques à Admin */

  // Helper pour convertir les offsets de manches (utilisé dans la config)
  function coerceOffsetsToNumbers(arr) {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const v = arr?.[i];
      if (typeof v === "number" && Number.isFinite(v)) out[i] = v;
      else if (typeof v === "string" && v.trim()) {
        const p = parseHMS(v);
        out[i] = p == null ? null : p;
      } else {
        out[i] = null;
      }
    }
    return out;
  }

  function withAlpha(hex, alpha = 0.35) {
    if (typeof hex !== "string") return hex;
    const s0 = hex.trim();
    if (!s0.startsWith("#")) return hex;
    const s = s0.slice(1);
    const A = Math.max(0, Math.min(1, Number(alpha)));

    // #RGB / #RGBA
    if (s.length === 3 || s.length === 4) {
      const r = parseInt(s[0] + s[0], 16);
      const g = parseInt(s[1] + s[1], 16);
      const b = parseInt(s[2] + s[2], 16);
      return `rgba(${r}, ${g}, ${b}, ${A})`;
    }

    // #RRGGBB / #RRGGBBAA
    if (s.length === 6 || s.length === 8) {
      const r = parseInt(s.slice(0, 2), 16);
      const g = parseInt(s.slice(2, 4), 16);
      const b = parseInt(s.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${A})`;
    }

    return hex;
  }

  /** Assombrit une couleur de manche (bouton statut non cliquable). */
  function darkenHex(hex, amount = 0.28) {
    if (typeof hex !== "string" || !hex.startsWith("#")) return hex;
    const s = hex.trim().slice(1);
    const full =
      s.length === 3 || s.length === 4
        ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
        : s.slice(0, 6);
    if (full.length < 6) return hex;
    const f = Math.max(0, Math.min(1, 1 - Number(amount) || 0));
    const to = (i) => {
      const n = Math.round(parseInt(full.slice(i, i + 2), 16) * f);
      return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
    };
    return `#${to(0)}${to(2)}${to(4)}`;
  }

  /* [2.4] États UI/DATA */

  // === Quiz (métadonnées + sélection) ===
  const [quizzes, setQuizzes] = useState([]); // [{ key, name }]
  const [activeQuizKey, setActiveQuizKey] = useState(null); // quiz utilisé en live (Player/Screen)
  const [selectedQuizKey, setSelectedQuizKey] = useState(null); // quiz affiché dans l’onglet

  // Questions (du quiz sélectionné)
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [savedRowId, setSavedRowId] = useState(null);
  const [needsOrderInit, setNeedsOrderInit] = useState(false);

  // UI générique
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [mainBtnBusy, setMainBtnBusy] = useState(false);
  const [adminTab, setAdminTab] = useState("players"); // "players" | `quiz:${quizKey}`

  // Joueurs (panneau)
  const [players, setPlayers] = useState([]);
  const [playersLoading, setPlayersLoading] = useState(true);
  const assignedColorRef = useRef(new Set());
  const lastAssignedColorRef = useRef(null);
  
  // Filtrage des joueurs
  const [showRejected, setShowRejected] = useState(false);
  const [showKicked, setShowKicked] = useState(false);
  
  // Liste globale des noms refusés
  const [globalRejectedNames, setGlobalRejectedNames] = useState([]);

  // Équipes
  const [teams, setTeams] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [expandedTeamIds, setExpandedTeamIds] = useState(new Set()); // Set d'IDs d'équipes ouvertes
  const [leaderboardView, setLeaderboardView] = useState("teams"); // "teams" | "players"

  // Ordre d’arrivée local
  const playerOrderRef = useRef(new Map()); // id -> index d’arrivée
  const nextPlayerOrderRef = useRef(1);

  const [configDoc, setConfigDoc] = useState(null);

  // Rounds & fin
  const [roundOffsetsStr, setRoundOffsetsStr] = useState([
    "00:00:00",
    "00:16:00",
    "00:31:00",
    "00:46:00",
    "",
    "",
    "",
    "",
  ]);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([
    0, 960, 1860, 2760, null, null, null, null,
  ]);
  const [quizEndSec, setQuizEndSec] = useState(null);
  const [endOffsetStr, setEndOffsetStr] = useState("");

  // Fin de manche (sentinelle podium Screen/Player — pas utilisée pour Back/Next)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] =
    useState(null);

  // Offset d’horloge serveur (ms) — mis à jour via /quiz/state.serverNow
  const serverDeltaRef = useRef(0);
  const [serverDeltaTick, setServerDeltaTick] = useState(0); // léger re-render si besoin

  // Live state
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  // EleyBuzz state
  const [isBuzzerMode, setIsBuzzerMode] = useState(false);
  const [buzzerState, setBuzzerState] = useState("idle");
  const [firstPlayerId, setFirstPlayerId] = useState(null);
  const [firstPlayerName, setFirstPlayerName] = useState(null);
  const [buzzerPoints, setBuzzerPoints] = useState(DEFAULT_BUZZER_POINTS);
  const [buzzerMessage, setBuzzerMessage] = useState(null);
  const [buzzerCorrectMessageDurationMs, setBuzzerCorrectMessageDurationMs] = useState(BUZZER_CORRECT_MESSAGE_DURATION_MS);
  const [defaultTimeMusicSec, setDefaultTimeMusicSec] = useState(DEFAULT_TIME_MUSIC_SEC);
  /** Télécommande Stream Deck (API) — OFF par défaut */
  const [streamDeckRemoteEnabled, setStreamDeckRemoteEnabled] = useState(false);
  const [streamDeckSecret, setStreamDeckSecret] = useState("");
  /** Dernier timecode posé par Back/Next (déjà sur un marqueur → Back = précédent). */
  const [parkedMarkerSec, setParkedMarkerSec] = useState(null);

  useEffect(() => {
    if (!isPaused) setParkedMarkerSec(null);
  }, [isPaused]);

  // Messages personnalisables EleyBuzz Screen
  const [screenEleyBuzzMessages, setScreenEleyBuzzMessages] = useState(ELEYBUZZ_SCREEN_MESSAGES);
  
  // États pour l'édition des scores
  const [editingScore, setEditingScore] = useState({ playerId: null, field: null }); // { playerId: "xxx", field: "score" ou "buzzScore" }
  const [editingValue, setEditingValue] = useState("");

  // Nom du gagnant EleyBuzz : résolu via la liste joueurs (firstPlayerName Firestore = legacy)
  const buzzerWinnerName = useMemo(() => {
    if (firstPlayerId) {
      const p = players.find((x) => x.id === firstPlayerId);
      if (p?.name) return p.name;
    }
    return firstPlayerName || null;
  }, [firstPlayerId, firstPlayerName, players]);

  // Refs pour connaître la phase courante sans dépendance d'ordre
  const isCountdownRef = useRef(false);
  const isRevealRef = useRef(false);

  // Création question
  const [newQ, setNewQ] = useState({
    text: "",
    answersCsv: "",
    timeMusicStr: formatHMS(DEFAULT_TIME_MUSIC_SEC), // Initialiser avec la valeur par défaut formatée
    imageQuestionFile: null, // image affichée pendant la phase "question"
    imageReponseFile: null, // image affichée pendant la "révélation"
    imageQuestionLarge: false, // afficher l'image question en plus grand (+30px)
  });

  // Type de question + matching (réponse libre) ou QCM
  const [newQuestionType, setNewQuestionType] = useState(QUESTION_TYPE_OPEN);
  const [newQcmOptions, setNewQcmOptions] = useState(["", "", "", ""]);
  const [newQcmCorrectIndex, setNewQcmCorrectIndex] = useState(0);
  const [newMatchingMode, setNewMatchingMode] = useState("strict");

  // Phrases de révélation (chargées depuis Firestore)
  const [revealPhrases, setRevealPhrases] = useState([...DEFAULT_REVEAL_PHRASES]);

  /* [2.5] Effect — 1) Charger questions du quiz sélectionné (ordre ascendant) */
  useEffect(() => {
    if (!selectedQuizKey) {
      setItems([]);
      setNeedsOrderInit(false);
      return;
    }

    (async () => {
      setLoading(true);
      try {
        const colRef = collection(db, "LesQuestions");
        const qRef = query(
          colRef,
          where("quizKey", "==", selectedQuizKey),
          orderBy("order", "asc")
        );
        const snap = await getDocs(qRef);
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setItems(arr);
        setNeedsOrderInit(
          arr.some((it) => typeof it.order !== "number")
        );
      } catch (e) {
        console.error("load LesQuestions error:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedQuizKey]);

  /* [2.6] Effect — 2) Écouter config (rounds + fin + quiz actifs) */
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "quiz", "config"),
      (snap) => {
        const d = snap.data() || {};
        setConfigDoc(d);

        // Quiz : métadonnées + actif
        let cfgQuizzes = Array.isArray(d.quizzes)
          ? d.quizzes.filter((q) => q && q.key && q.name)
          : [];

        let cfgActiveQuizKey =
          typeof d.activeQuizKey === "string" && d.activeQuizKey
            ? d.activeQuizKey
            : "quiz-test";

        if (!cfgQuizzes.length) {
          cfgQuizzes = [{ key: cfgActiveQuizKey, name: "Quiz test" }];
        } else if (!cfgQuizzes.some((q) => q.key === cfgActiveQuizKey)) {
          cfgQuizzes = [
            ...cfgQuizzes,
            { key: cfgActiveQuizKey, name: "Quiz test" },
          ];
        }

        setQuizzes(cfgQuizzes);
        setActiveQuizKey(cfgActiveQuizKey);

        // Timing EleyBuzz
        const bcmd = Number.isFinite(d?.buzzerCorrectMessageDurationMs) ? d.buzzerCorrectMessageDurationMs : BUZZER_CORRECT_MESSAGE_DURATION_MS;
        setBuzzerCorrectMessageDurationMs(bcmd);

        // Default TimeMusic
        const dtms = Number.isFinite(d?.defaultTimeMusicSec) ? d.defaultTimeMusicSec : DEFAULT_TIME_MUSIC_SEC;
        setDefaultTimeMusicSec(dtms);

        // Chemin du dossier d'archives (pour export/import)
        // Stocké dans configDoc, sera utilisé par exportQuiz/importQuiz

        // Phrases de révélation
        if (Array.isArray(d?.revealPhrases) && d.revealPhrases.length > 0) {
          setRevealPhrases(d.revealPhrases);
        } else {
          setRevealPhrases([...DEFAULT_REVEAL_PHRASES]);
        }

        // Liste globale des noms refusés
        if (Array.isArray(d?.globalRejectedNames)) {
          setGlobalRejectedNames(d.globalRejectedNames);
        } else {
          setGlobalRejectedNames([]);
        }

        // Vue du leaderboard (Équipes ou Joueurs)
        if (d?.leaderboardView === "players" || d?.leaderboardView === "teams") {
          setLeaderboardView(d.leaderboardView);
        } else {
          setLeaderboardView("teams"); // Par défaut : équipes
        }

        // Quiz sélectionné dans l'UI : si absent, basculer sur le quiz actif
        setSelectedQuizKey((prev) => {
          if (!prev) return cfgActiveQuizKey;
          const exists = cfgQuizzes.some((q) => q.key === prev);
          return exists ? prev : cfgActiveQuizKey;
        });
      },
      (e) => console.error("onSnapshot config error:", e)
    );

    return () => unsub();
  }, []);

  // Ref pour suivre la valeur par défaut précédente
  const prevDefaultTimeMusicSecRef = useRef(defaultTimeMusicSec);

  // Mettre à jour timeMusicStr quand defaultTimeMusicSec change
  // (seulement si le champ est vide ou correspond à l'ancienne valeur par défaut)
  useEffect(() => {
    const prevDefault = prevDefaultTimeMusicSecRef.current;
    const currentFormatted = formatHMS(defaultTimeMusicSec);
    const prevFormatted = formatHMS(prevDefault);
    
    // Mettre à jour si le champ est vide ou s'il correspond à l'ancienne valeur par défaut
    if (!newQ.timeMusicStr || newQ.timeMusicStr.trim() === "" || newQ.timeMusicStr === prevFormatted) {
      setNewQ((prev) => ({
        ...prev,
        timeMusicStr: currentFormatted,
      }));
    }
    
    // Mettre à jour la référence
    prevDefaultTimeMusicSecRef.current = defaultTimeMusicSec;
  }, [defaultTimeMusicSec]);

  /* [2.6bis] Effect — Dériver offsets/fin par quiz (selectedQuizKey ↔ configDoc) */
  useEffect(() => {
    if (!configDoc) {
      return;
    }

    const d = configDoc || {};
    const key = selectedQuizKey || activeQuizKey || "quiz-test";

    // roundOffsetsSec par quiz
    const byQuiz =
      d.roundOffsetsSecByQuiz &&
        typeof d.roundOffsetsSecByQuiz === "object"
        ? d.roundOffsetsSecByQuiz
        : null;

    let offs = null;
    if (byQuiz && Array.isArray(byQuiz[key])) {
      offs = coerceOffsetsToNumbers(byQuiz[key]);
    } else if (Array.isArray(d.roundOffsetsSec)) {
      // compat : fallback sur roundOffsetsSec global
      offs = coerceOffsetsToNumbers(d.roundOffsetsSec);
    } else {
      offs = [null, null, null, null, null, null, null, null];
    }

    setRoundOffsetsSec(offs);
    setRoundOffsetsStr(
      offs.map((s) => (Number.isFinite(s) ? formatHMS(s) : ""))
    );

    // endOffsetSec par quiz
    const endByQuiz =
      d.endOffsetSecByQuiz &&
        typeof d.endOffsetSecByQuiz === "object"
        ? d.endOffsetSecByQuiz
        : null;

    let end = null;
    if (endByQuiz && typeof endByQuiz[key] === "number") {
      end = endByQuiz[key];
    } else if (typeof d.endOffsetSec === "number") {
      // compat : fallback global
      end = d.endOffsetSec;
    } else {
      end = null;
    }

    if (typeof end === "number") {
      setQuizEndSec(end);
      setEndOffsetStr(formatHMS(end));
    } else {
      setQuizEndSec(null);
      setEndOffsetStr("");
    }
  }, [configDoc, selectedQuizKey, activeQuizKey]);

  /* [2.7] Effect — 3) Écouter état live (Timestamp ou startEpochMs) */
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "quiz", "state"),
      (snap) => {
        const d = snap.data() || {};

        // startMs reconstruit depuis l'ancrage (anchorAt + anchorOffsetSec) si présent.
        // Fallback : startAt (Timestamp) puis startEpochMs (legacy).
        let startMs = null;

        if (d.anchorAt && typeof d.anchorAt.seconds === "number") {
          const anchorMs =
            d.anchorAt.seconds * 1000 +
            Math.floor(
              (d.anchorAt.nanoseconds || d.anchorAt.nanos || 0) / 1e6
            );
          const offsetSec = Number.isFinite(d.anchorOffsetSec)
            ? d.anchorOffsetSec
            : 0;

          startMs = anchorMs - offsetSec * 1000;
        } else if (d.startAt && typeof d.startAt.seconds === "number") {
          startMs =
            d.startAt.seconds * 1000 +
            Math.floor((d.startAt.nanoseconds || 0) / 1e6);
        } else if (typeof d.startEpochMs === "number") {
          startMs = d.startEpochMs;
        }

        // Mise à jour du delta d’horloge si Admin publie serverNow
        if (d.serverNow && typeof d.serverNow.seconds === "number") {
          const serverNowMs =
            d.serverNow.seconds * 1000 +
            Math.floor(
              (d.serverNow.nanoseconds || d.serverNow.nanos || 0) / 1e6
            );
          const instantDelta = serverNowMs - Date.now();

          if (!serverDeltaRef.buffer) serverDeltaRef.buffer = [];
          serverDeltaRef.buffer.push(instantDelta);
          if (serverDeltaRef.buffer.length > 8)
            serverDeltaRef.buffer.shift();

          const sorted = [...serverDeltaRef.buffer].sort((a, b) => a - b);
          const p90 =
            sorted[Math.floor(sorted.length * 0.9)] ?? instantDelta;

          const prev = serverDeltaRef.current || 0;
          const alpha = 0.25;
          serverDeltaRef.current = prev * (1 - alpha) + p90 * alpha;

          setServerDeltaTick((t) => (t + 1) & 0xfff);
        }

        setIsRunning(!!d.isRunning);
        setIsPaused(!!d.isPaused);

        if (!startMs) {
          // Pendant la résolution des serverTimestamp (seek/pause), ne pas
          // raz quizStartMs si le quiz tourne encore → évite le flash « Démarrer ».
          if (!d.isRunning) {
            setQuizStartMs(null);
            setPauseAtMs(null);
            setElapsedSec(0);
          } else if (Number.isFinite(d.anchorOffsetSec) && d.isPaused) {
            setElapsedSec(Math.max(0, Math.round(d.anchorOffsetSec)));
          }
        } else {
          setQuizStartMs(startMs);
          if (d.pauseAt && typeof d.pauseAt.seconds === "number") {
            const pms =
              d.pauseAt.seconds * 1000 +
              Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
            setPauseAtMs(pms);
          } else {
            setPauseAtMs(null);
          }
        }

        setLastAutoPausedRoundIndex(
          Number.isInteger(d.lastAutoPausedRoundIndex)
            ? d.lastAutoPausedRoundIndex
            : null
        );

        // EleyBuzz state
        setIsBuzzerMode(!!d.isBuzzerMode);
        setBuzzerState(typeof d.buzzerState === "string" ? d.buzzerState : "idle");
        setFirstPlayerId(typeof d.firstPlayerId === "string" ? d.firstPlayerId : null);
        setFirstPlayerName(typeof d.firstPlayerName === "string" ? d.firstPlayerName : null);
        setBuzzerPoints(Number.isFinite(d.buzzerPoints) ? d.buzzerPoints : DEFAULT_BUZZER_POINTS);
        setBuzzerMessage(typeof d.buzzerMessage === "string" ? d.buzzerMessage : null);
        setStreamDeckRemoteEnabled(!!d.streamDeckRemoteEnabled);
        setStreamDeckSecret(typeof d.streamDeckSecret === "string" ? d.streamDeckSecret : "");
      },
      (e) => console.error("onSnapshot state error:", e)
    );

    return () => unsub();
  }, []);

  // Charger les messages personnalisés depuis Firestore
  useEffect(() => {
    const configRef = doc(db, "quiz", "config");
    const unsub = onSnapshot(configRef, (snap) => {
      const data = snap.data() || {};
      if (data.screenEleyBuzz) {
        setScreenEleyBuzzMessages({
          ...ELEYBUZZ_SCREEN_MESSAGES,
          ...data.screenEleyBuzz,
        });
      } else {
        setScreenEleyBuzzMessages(ELEYBUZZ_SCREEN_MESSAGES);
      }
    });
    return () => unsub();
  }, []);

  // ============================================================================
  // /pages/admin.js — Partie 3/6
  // Scope : Effets 4→6 + Heartbeat dynamique + Dérivés rounds/reveal +
  //         Watcher d’attribution automatique
  // Règles : aucune modification fonctionnelle ; uniquement cosmétique.
  // ============================================================================

  // [3.1] Effect — 4) Timer local (avec clamp fin de quiz)
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

    const first = computeNow();
    const firstClamped = Number.isFinite(quizEndSec)
      ? Math.min(first, quizEndSec)
      : first;
    setElapsedSec(firstClamped < 0 ? 0 : firstClamped);

    const id = setInterval(() => {
      const raw = computeNow();
      if (Number.isFinite(quizEndSec) && raw >= quizEndSec) {
        setElapsedSec(Math.max(0, quizEndSec));
        clearInterval(id);
      } else {
        setElapsedSec(raw < 0 ? 0 : raw);
      }
    }, 500);

    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec, serverDeltaTick]);

  // Auto-pause fin de manche (safety) — frontière = GAP avant début manche suivante.
  // Ne décide PAS des cibles Back/Next (marqueurs questions uniquement).
  useEffect(() => {
    if (!isRunning || isPaused) return;
    if (!Array.isArray(roundOffsetsSec) || roundOffsetsSec.every((v) => v == null))
      return;

    let prevIdx = -1;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) {
        prevIdx = i;
      }
    }
    if (prevIdx < 0) return;

    const nextStart =
      typeof roundOffsetsSec[prevIdx + 1] === "number"
        ? roundOffsetsSec[prevIdx + 1]
        : null;
    if (typeof nextStart !== "number") return;

    const boundary = Math.max(0, nextStart - ROUND_BOUNDARY_GAP_SEC);
    if (elapsedSec < boundary) return;
    if (lastAutoPausedRoundIndex === prevIdx) return;

    setDoc(
      doc(db, "quiz", "state"),
      {
        isPaused: true,
        pauseAt: serverTimestamp(),
        lastAutoPausedRoundIndex: prevIdx,
      },
      { merge: true }
    ).catch(console.error);
  }, [isRunning, isPaused, elapsedSec, roundOffsetsSec, lastAutoPausedRoundIndex]);

  // [3.3] Effect — 6) Écouter /quiz/state/players : normaliser + couleurs + ordre d’arrivée
  useEffect(() => {
    const playersCol = collection(db, "quiz", "state", "players");

    const unsub = onSnapshot(playersCol, (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Normaliser nameNorm + assigner une couleur si manquante
      arr.forEach((p) => {
        const pref = doc(db, "quiz", "state", "players", p.id);

        if (
          (!p.nameNorm || typeof p.nameNorm !== "string") &&
          typeof p.name === "string"
        ) {
          updateDoc(pref, { nameNorm: normKey(p.name || "") }).catch(() => { });
        }

        // Assigner une couleur seulement si le joueur n'a pas d'équipe
        // Si le joueur a une équipe, la couleur sera héritée de l'équipe
        if (!p.teamId && !p.color && !assignedColorRef.current.has(p.id)) {
          assignedColorRef.current.add(p.id);
          const prev = lastAssignedColorRef.current;
          const color = pickColorDifferent(prev, PLAYER_COLORS);
          lastAssignedColorRef.current = color;
          updateDoc(pref, { color }).catch(() => { });
        }
      });

      // Mémoriser l’ordre d’arrivée (local, stable)
      arr.forEach((p) => {
        if (!playerOrderRef.current.has(p.id)) {
          playerOrderRef.current.set(p.id, nextPlayerOrderRef.current++);
        }
      });

      // Tri par ordre d’arrivée
      arr.sort(
        (a, b) =>
          (playerOrderRef.current.get(a.id) ?? Number.POSITIVE_INFINITY) -
          (playerOrderRef.current.get(b.id) ?? Number.POSITIVE_INFINITY)
      );

      setPlayers(arr);
      setPlayersLoading(false);
    });

    return () => unsub();
  }, []);

  // [3.3.1] Effect — Écouter /quiz/state/teams
  const previousTeamsRef = useRef([]);
  useEffect(() => {
    const teamsCol = collection(db, "quiz", "state", "teams");
    const unsub = onSnapshot(teamsCol, (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      
      // Détecter les nouvelles équipes (celles qui n'étaient pas dans la liste précédente)
      const previousTeamIds = new Set(previousTeamsRef.current.map((t) => t.id));
      const newTeamIds = arr
        .filter((t) => !previousTeamIds.has(t.id))
        .map((t) => t.id);
      
      setTeams(arr);
      previousTeamsRef.current = arr; // Mettre à jour la référence
      setTeamsLoading(false);
      
      // Ouvrir toutes les équipes par défaut au premier chargement
      if (expandedTeamIds.size === 0 && arr.length > 0) {
        setExpandedTeamIds(new Set(arr.map((t) => t.id)));
      } else if (newTeamIds.length > 0) {
        // Ouvrir automatiquement les nouvelles équipes créées
        setExpandedTeamIds((prev) => {
          const newSet = new Set(prev);
          newTeamIds.forEach((teamId) => newSet.add(teamId));
          return newSet;
        });
      }
    }, (e) => {
      console.error("onSnapshot teams error:", e);
      setTeamsLoading(false);
    });

    return () => unsub();
  }, [expandedTeamIds.size]);

  // [3.4] Effect — Heartbeat dynamique (boost pendant reveal/countdown)
  useEffect(() => {
    const stateRef = doc(db, "quiz", "state");
    let intervalMs = 5000;
    let hbId = null;
    let watchId = null;
    let boostTimer = null;

    const tick = () =>
      setDoc(stateRef, { serverNow: serverTimestamp() }, { merge: true }).catch(
        () => { }
      );

    const startHB = () => {
      clearInterval(hbId);
      hbId = setInterval(tick, intervalMs);
    };

    const unsub = onSnapshot(stateRef, (snap) => {
      const d = snap.data() || {};
      if (d.hbBoost === true) {
        clearTimeout(boostTimer);
        intervalMs = 200;
        startHB();
        boostTimer = setTimeout(() => {
          intervalMs =
            isCountdownRef.current || isRevealRef.current ? 500 : 5000;
          startHB();
          setDoc(stateRef, { hbBoost: false }, { merge: true }).catch(() => { });
        }, 1500);
      }
    });

    // Observer local : ajuster 500 ms pendant reveal/countdown sinon 5000 ms
    watchId = setInterval(() => {
      if (boostTimer) return;
      const target =
        isCountdownRef.current || isRevealRef.current ? 500 : 5000;
      if (target !== intervalMs) {
        intervalMs = target;
        startHB();
      }
    }, 300);

    tick();
    startHB();

    return () => {
      clearInterval(hbId);
      clearInterval(watchId);
      clearTimeout(boostTimer);
      unsub();
    };
  }, []);

  // ========================================================================
  // DÉRIVÉS & PHASES (rounds/reveal/countdown) + Watcher attribution auto
  // ========================================================================

  /* --------- Dérivés simples --------- */
  const connectedCount = useMemo(
    () => players.filter((p) => !p?.isKicked).length,
    [players]
  );

  const plannedTimes = useMemo(
    () =>
      items
        .map(getTimeSec)
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b),
    [items]
  );

  /* --------- Dérivés “rounds & reveal” --------- */
  const currentRoundIndex = useMemo(() => {
    let lastIdx = -1;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) lastIdx = i;
    }
    if (lastIdx >= 0) return lastIdx;

    const firstActiveIdx = roundOffsetsSec.findIndex((t) =>
      Number.isFinite(t)
    );
    return firstActiveIdx !== -1 ? firstActiveIdx : 0;
  }, [elapsedSec, roundOffsetsSec]);

  const nextRoundIndex = useMemo(() => {
    if (isPaused && Number.isInteger(lastAutoPausedRoundIndex)) {
      const idx = lastAutoPausedRoundIndex + 1;
      return Number.isFinite(roundOffsetsSec[idx]) ? idx : null;
    }

    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && t > elapsedSec) return i;
    }
    return null;
  }, [elapsedSec, roundOffsetsSec, isPaused, lastAutoPausedRoundIndex]);

  const roundBoundarySec = useMemo(() => {
    if (
      !Array.isArray(roundOffsetsSec) ||
      roundOffsetsSec.every((v) => v == null)
    )
      return null;

    let prevIdx = -1;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) prevIdx = i;
    }

    const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
      ? roundOffsetsSec[prevIdx + 1]
      : null;

    return typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;
  }, [elapsedSec, roundOffsetsSec]);

  const atRoundBoundary = Boolean(
    isPaused &&
    typeof roundBoundarySec === "number" &&
    elapsedSec >= roundBoundarySec
  );

  // Questions triées par timecode
  const sortedQuestions = useMemo(
    () => [...items].sort((a, b) => getTimeSec(a) - getTimeSec(b)),
    [items]
  );

  const currentRoundStart = useMemo(() => {
    let s = 0;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) s = t;
    }
    return s;
  }, [elapsedSec, roundOffsetsSec]);

  const currentRoundEnd = useMemo(() => {
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && t > currentRoundStart) return t;
    }
    return Infinity;
  }, [roundOffsetsSec, currentRoundStart]);

  let _activeIdx = -1;
  for (let i = 0; i < sortedQuestions.length; i++) {
    const t = getTimeSec(sortedQuestions[i]);
    if (!Number.isFinite(t) || t < currentRoundStart) continue;
    if (t <= elapsedSec && t < currentRoundEnd) _activeIdx = i;
    else if (t >= currentRoundEnd) break;
  }
  const currentQuestion = _activeIdx >= 0 ? sortedQuestions[_activeIdx] : null;

  // Prochain événement (question / frontière / fin)
  let nextTimeSec = null;
  for (let i = 0; i < sortedQuestions.length; i++) {
    const t = getTimeSec(sortedQuestions[i]);
    if (Number.isFinite(t) && t > elapsedSec) {
      nextTimeSec = t;
      break;
    }
  }

  const _nextRoundStart = (() => {
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const v = roundOffsetsSec[i];
      if (typeof v === "number" && v > elapsedSec) return v;
    }
    return null;
  })();

  const nextRoundBoundary = Number.isFinite(_nextRoundStart)
    ? Math.max(0, _nextRoundStart - ROUND_BOUNDARY_GAP_SEC)
    : null;

  const candidates = [];
  if (Number.isFinite(nextTimeSec)) candidates.push(nextTimeSec);
  if (Number.isFinite(nextRoundBoundary)) candidates.push(nextRoundBoundary);
  if (Number.isFinite(quizEndSec)) candidates.push(quizEndSec);

  const effectiveNextTimeSec = candidates.length
    ? Math.min(...candidates)
    : null;

  // Fenêtres reveal / countdown
  const REVEAL_DURATION_SEC = DEFAULT_REVEAL_DURATION_SEC;
  const COUNTDOWN_START_SEC = 5;

  const revealStart =
    effectiveNextTimeSec != null
      ? effectiveNextTimeSec - REVEAL_DURATION_SEC
      : null;

  const countdownStart =
    effectiveNextTimeSec != null
      ? effectiveNextTimeSec - COUNTDOWN_START_SEC
      : null;

  const isRevealAnswerPhase = Boolean(
    currentQuestion &&
    revealStart != null &&
    countdownStart != null &&
    elapsedSec >= revealStart &&
    elapsedSec < countdownStart &&
    !isPaused
  );

  const isCountdownPhase = Boolean(
    currentQuestion &&
    countdownStart != null &&
    effectiveNextTimeSec != null &&
    elapsedSec >= countdownStart &&
    elapsedSec < effectiveNextTimeSec &&
    !isPaused
  );

  useEffect(() => {
    isCountdownRef.current = !!isCountdownPhase;
  }, [isCountdownPhase]);

  useEffect(() => {
    isRevealRef.current = !!isRevealAnswerPhase;
  }, [isRevealAnswerPhase]);


  /* === Watcher attribution auto (début du reveal) — transactionnel/idempotent === */
  useEffect(() => {
    const qid = currentQuestion?.id || null;
    const isReveal = isRevealAnswerPhase || isCountdownPhase;
    if (!qid || !isReveal) return;
    if (awardGuardRef.current[qid]) return;

    awardGuardRef.current[qid] = "pending";

    ensureAwardsForQuestionTx(db, qid).catch((e) => {
      console.error("[Admin/ensureAwardsForQuestionTx] error:", e);
      delete awardGuardRef.current[qid];
    });
  }, [
    currentQuestion?.id,
    isRevealAnswerPhase,
    isCountdownPhase,
    elapsedSec,
    isPaused,
  ]);

  // ============================================================================
  // /pages/admin.js — Partie 4/6
  // Scope : Actions — Questions (recalc timecodes, CRUD, uploads, offsets/fin)
  // Règles : aucune modification fonctionnelle ; seulement commentaires/sections.
  // ============================================================================

  // [4.1] Recalcul global des timecodes depuis l'ordre + TimeMusic (par quiz)
  async function recalcAllTimecodesFromOrder() {
    if (!selectedQuizKey) return;
    try {
      const colRef = collection(db, "LesQuestions");
      const qRef = query(
        colRef,
        where("quizKey", "==", selectedQuizKey),
        orderBy("order", "asc")
      );
      const snap = await getDocs(qRef);
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      let t = 0;
      const updates = [];
      for (const it of docs) {
        const newTimecode = t;
        const tm = clampTimeMusicSec(it.timeMusicSec);
        if (!Number.isFinite(it.timecodeSec) || it.timecodeSec !== newTimecode) {
          updates.push({ id: it.id, timecodeSec: newTimecode });
        }
        t += tm;
      }

      if (updates.length) {
        const batch = writeBatch(db);
        for (const u of updates) {
          batch.update(doc(db, "LesQuestions", u.id), { timecodeSec: u.timecodeSec });
        }
        await batch.commit();
      }

      // Rafraîchir le tableau (quiz courant uniquement)
      const snap2 = await getDocs(qRef);

      setItems(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error("recalcAllTimecodesFromOrder error:", e);
      alert("Échec du recalcul des timecodes : " + (e?.message || e));
    }
  }

  // [4.2] Édits inline sur une question (state local uniquement)
  const handleFieldChange = (id, field, value) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, [field]: value };

        if (field === "questionType") {
          next.questionType = value;
          if (value === QUESTION_TYPE_QCM) {
            next.qcmOptions = normalizeQcmOptions(next.qcmOptions?.length ? next.qcmOptions : next.answers);
            if (!Number.isInteger(next.qcmCorrectIndex)) next.qcmCorrectIndex = 0;
          }
        }
        if (field.startsWith("qcmOption_")) {
          const idx = parseInt(field.split("_")[1], 10);
          const opts = normalizeQcmOptions(next.qcmOptions);
          if (idx >= 0 && idx <= 3) opts[idx] = value;
          next.qcmOptions = opts;
        }
        if (field === "qcmCorrectIndex") {
          next.qcmCorrectIndex = Number(value);
        }

        // mapping CSV -> arrays (réponse libre)
        if (field === "answersCsv") {
          next.answers = parseCSV(value);
        }
        if (field === "timeMusicStr") {
          next.timeMusicSec = clampTimeMusicSec(parseHMS(value));
        }
        return next;
      })
    );
  };

  function buildAnswerPayload(it, hasAnswersCsv) {
    const qType = getQuestionType(it);
    if (qType === QUESTION_TYPE_QCM) {
      const correctIndex = getQcmCorrectIndex(it);
      const validation = validateQcmOptions(it.qcmOptions, correctIndex);
      if (!validation.ok) throw new Error(validation.reason);
      return {
        questionType: QUESTION_TYPE_QCM,
        qcmOptions: validation.options,
        qcmCorrectIndex: correctIndex,
        answers: qcmAnswersFromOptions(validation.options, correctIndex),
      };
    }
    return {
      questionType: QUESTION_TYPE_OPEN,
      answers: hasAnswersCsv
        ? parseCSV(it.answersCsv)
        : Array.isArray(it.answers)
          ? it.answers
          : [],
      matchingMode:
        typeof it.matchingMode === "string" && it.matchingMode
          ? it.matchingMode
          : "strict",
    };
  }

  // [4.3] Saisie des offsets de manches (UI) + sauvegarde
  const handleRoundOffsetChange = (i, value) => {
    setRoundOffsetsStr((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  const saveRoundOffsets = async (nextStrs) => {
    try {
      const secs = nextStrs.map((s) => {
        const t = (s || "").trim();
        if (!t) return null;
        const v = parseHMS(t);
        if (v == null) throw new Error("format");
        return v;
      });

      const cfgRef = doc(db, "quiz", "config");
      const key = selectedQuizKey || activeQuizKey || "quiz-test";

      const existingByQuiz =
        configDoc &&
          configDoc.roundOffsetsSecByQuiz &&
          typeof configDoc.roundOffsetsSecByQuiz === "object"
          ? configDoc.roundOffsetsSecByQuiz
          : {};

      const nextByQuiz = {
        ...existingByQuiz,
        [key]: secs,
      };

      const patch = {
        roundOffsetsSecByQuiz: nextByQuiz,
      };

      // Pour compatibilité avec Player/Screen : garder un roundOffsetsSec "global" pour le quiz actif
      if (key === activeQuizKey) {
        patch.roundOffsetsSec = secs;
      }

      await setDoc(cfgRef, patch, { merge: true });

      setRoundOffsetsSec(secs);
      setRoundOffsetsStr(
        secs.map((s) => (typeof s === "number" ? formatHMS(s) : ""))
      );
      setNotice("Offsets enregistrés");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide (laisser vide pour désactiver)");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  // [4.4] Saisie/Enregistrement de la fin du quiz (global)
  const saveEndOffset = async (valStr) => {
    try {
      const t = (valStr || "").trim();
      const v = t ? parseHMS(t) : null; // null = pas de fin
      if (t && v == null) throw new Error("format");

      const cfgRef = doc(db, "quiz", "config");
      const key = selectedQuizKey || activeQuizKey || "quiz-test";

      const existingByQuiz =
        configDoc &&
          configDoc.endOffsetSecByQuiz &&
          typeof configDoc.endOffsetSecByQuiz === "object"
          ? configDoc.endOffsetSecByQuiz
          : {};

      const nextByQuiz = {
        ...existingByQuiz,
        [key]: v,
      };

      const patch = {
        endOffsetSecByQuiz: nextByQuiz,
      };

      // Compat : copier sur le champ global pour le quiz actif (Player/Screen)
      if (key === activeQuizKey) {
        patch.endOffsetSec = v;
      }

      await setDoc(cfgRef, patch, { merge: true });

      setEndOffsetStr(v != null ? formatHMS(v) : "");
      setQuizEndSec(v);
      setNotice("Fin du quiz enregistrée");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide pour la fin du quiz");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  // [4.5] Upload d'image (Storage) + binding sur la question
  const uploadImage = async (file) => {
    if (!file) return null;
    try {
      const storageRef = ref(
        storage,
        `questions/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}-${file.name}`
      );
      const task = uploadBytesResumable(storageRef, file);
      return await new Promise((resolve, reject) => {
        task.on(
          "state_changed",
          () => { },
          (err) => {
            console.error("[UPLOAD] Erreur:", err);
            alert("Échec de l’upload : " + (err?.message || err));
            reject(err);
          },
          async () => resolve(await getDownloadURL(task.snapshot.ref))
        );
      });
    } catch (err) {
      console.error("Upload image failed:", err);
      alert("Échec de l’upload : " + (err?.message || err));
      return null;
    }
  };

  // Handler générique ciblé : "imageQuestionUrl" ou "imageReponseUrl"
  const handleImageChange = async (id, file, targetField) => {
    if (!file || !targetField) return;
    handleFieldChange(id, "_imageUploading", true);
    const url = await uploadImage(file);
    if (url) handleFieldChange(id, targetField, url);
    handleFieldChange(id, "_imageUploading", false);
  };

  // ============================================================================
  // [4.6] Export/Import de quiz
  // ============================================================================

  // Export d'un quiz complet (questions + URLs des images)
  const exportQuiz = async (quizKey) => {
    try {
      if (!quizKey) {
        alert("Aucun quiz sélectionné");
        return;
      }

      setNotice("Export en cours...");
      
      // Récupérer le quiz depuis la liste
      const quiz = quizzes.find((q) => q.key === quizKey);
      if (!quiz) {
        alert("Quiz introuvable");
        return;
      }

      // Récupérer toutes les questions du quiz
      const colRef = collection(db, "LesQuestions");
      const qRef = query(
        colRef,
        where("quizKey", "==", quizKey),
        orderBy("order", "asc")
      );
      const snap = await getDocs(qRef);
      
      const questions = snap.docs.map((d) => {
        const data = d.data();
        // S'assurer que les URLs sont bien des strings (pas null/undefined)
        // Ne pas utiliser String() sur null/undefined car ça donnerait "null" ou "undefined"
        // Vérifier aussi le champ imageUrl (ancien format possible)
        let imageQuestionUrl = "";
        let imageReponseUrl = "";
        
        if (data.imageQuestionUrl) {
          const str = String(data.imageQuestionUrl).trim();
          if (str && str !== "null" && str !== "undefined" && str.length > 0) {
            imageQuestionUrl = str;
          }
        }
        
        if (data.imageReponseUrl) {
          const str = String(data.imageReponseUrl).trim();
          if (str && str !== "null" && str !== "undefined" && str.length > 0) {
            imageReponseUrl = str;
          }
        }
        
        // Fallback sur imageUrl (ancien format)
        if (!imageReponseUrl && data.imageUrl) {
          const str = String(data.imageUrl).trim();
          if (str && str !== "null" && str !== "undefined" && str.length > 0) {
            imageReponseUrl = str;
          }
        }
        
        return {
          text: data.text || "",
          answers: Array.isArray(data.answers) ? data.answers : [],
          imageQuestionUrl: imageQuestionUrl,
          imageReponseUrl: imageReponseUrl,
          imageQuestionLarge: data.imageQuestionLarge || false,
          timeMusicSec: data.timeMusicSec || 0,
          order: data.order || 0,
          revealPhrases: Array.isArray(data.revealPhrases) ? data.revealPhrases : [],
          matchingMode: data.matchingMode || "strict",
          questionType: data.questionType || QUESTION_TYPE_OPEN,
          qcmOptions: normalizeQcmOptions(data.qcmOptions),
          qcmCorrectIndex: getQcmCorrectIndex(data),
        };
      });

      // Créer l'objet d'export
      const exportData = {
        version: "1.0",
        quizName: quiz.name,
        quizKey: quiz.key,
        exportedAt: new Date().toISOString(),
        questions: questions,
      };

      const jsonStr = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${quiz.name.replace(/[^a-z0-9]/gi, "_")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setNotice(`Quiz "${quiz.name}" exporté avec succès !`);
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      console.error("Erreur export:", err);
      alert("Erreur lors de l'export : " + (err?.message || err));
      setNotice(null);
    }
  };

  // Import d'un quiz depuis un fichier JSON
  const importQuiz = async (file, targetQuizKey = null) => {
    try {
      if (!file) {
        alert("Aucun fichier sélectionné");
        return;
      }

      setNotice("Import en cours...");

      // Lire le fichier
      const text = await file.text();
      const exportData = JSON.parse(text);

      // Vérifier la version
      if (!exportData.version || !exportData.questions) {
        throw new Error("Format de fichier invalide");
      }

      // Déterminer la clé du quiz cible
      let finalQuizKey = targetQuizKey;
      if (!finalQuizKey) {
        // Créer un nouveau quiz avec le nom du quiz importé
        const quizName = exportData.quizName || `Quiz importé ${Date.now()}`;
        finalQuizKey = `quiz-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Ajouter le quiz à la liste
        const cfgRef = doc(db, "quiz", "config");
        const cfgSnap = await getDoc(cfgRef);
        const cfgData = cfgSnap.exists() ? cfgSnap.data() : {};
        const existingQuizzes = Array.isArray(cfgData.quizzes) ? cfgData.quizzes : [];
        
        await setDoc(
          cfgRef,
          {
            quizzes: [...existingQuizzes, { key: finalQuizKey, name: quizName }],
          },
          { merge: true }
        );
      }

      // Importer les questions
      const colRef = collection(db, "LesQuestions");
      let importedCount = 0;
      let skippedCount = 0;
      let imagesCount = 0;

      for (const q of exportData.questions) {
        try {
          // S'assurer que les URLs sont bien des strings
          const imageQuestionUrl = q.imageQuestionUrl ? String(q.imageQuestionUrl) : "";
          const imageReponseUrl = q.imageReponseUrl ? String(q.imageReponseUrl) : "";
          
          // Créer la question
          await addDoc(colRef, {
            text: q.text || "",
            answers: Array.isArray(q.answers) ? q.answers : [],
            questionType: q.questionType === QUESTION_TYPE_QCM ? QUESTION_TYPE_QCM : QUESTION_TYPE_OPEN,
            qcmOptions: normalizeQcmOptions(q.qcmOptions),
            qcmCorrectIndex: getQcmCorrectIndex(q),
            imageQuestionUrl: imageQuestionUrl,
            imageReponseUrl: imageReponseUrl,
            imageQuestionLarge: q.imageQuestionLarge || false,
            timeMusicSec: q.timeMusicSec || 0,
            order: q.order || importedCount * 1000,
            revealPhrases: Array.isArray(q.revealPhrases) ? q.revealPhrases : [],
            matchingMode: q.matchingMode || "strict",
            timecodeSec: null, // Sera recalculé
            quizKey: finalQuizKey,
            createdAt: serverTimestamp(),
          });

          if (imageQuestionUrl || imageReponseUrl) {
            imagesCount++;
          }
          importedCount++;
        } catch (err) {
          console.error("Erreur import question:", err);
          skippedCount++;
        }
      }

      // Recalculer les timecodes
      if (importedCount > 0) {
        // Recharger les questions pour recalculer
        const qRef = query(
          colRef,
          where("quizKey", "==", finalQuizKey),
          orderBy("order", "asc")
        );
        const snap = await getDocs(qRef);
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        await recalcAllTimecodesFromOrder();
      }

      setNotice(
        `Import terminé : ${importedCount} questions importées${skippedCount > 0 ? `, ${skippedCount} ignorées` : ""}${imagesCount > 0 ? `, ${imagesCount} avec images` : ""}`
      );
      setTimeout(() => setNotice(null), 4000);

      // Sélectionner le quiz importé
      setSelectedQuizKey(finalQuizKey);
      setAdminTab(`quiz:${finalQuizKey}`);
    } catch (err) {
      console.error("Erreur import:", err);
      alert("Erreur lors de l'import : " + (err?.message || err));
      setNotice(null);
    }
  };

  // Supprimer l’image QUESTION (met à jour le brouillon local ; la suppression réelle se fait dans saveOne)
  const handleRemoveImageQuestion = (id) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        return {
          ...it,
          imageQuestionUrl: "",
          _deleteImageQuestion: true,
        };
      })
    );
  };

  // Supprimer l’image RÉPONSE (idem)
  const handleRemoveImageReponse = (id) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        return {
          ...it,
          imageReponseUrl: "",
          // legacy visibles à l’écran via fallback lecture
          imageUrl: "",
          _deleteImageReponse: true,
        };
      })
    );
  };

  // [4.6] Sauvegarder une question (update Firestore)
  const saveOne = async (it) => {
    try {
      setSavingId(it.id);

      const hasAnswersCsv = typeof it.answersCsv === "string";
      const hasTimeMusicStr = typeof it.timeMusicStr === "string";

      const nextTimeMusicSec = hasTimeMusicStr
        ? clampTimeMusicSec(parseHMS(it.timeMusicStr))
        : Number.isFinite(it.timeMusicSec)
          ? clampTimeMusicSec(it.timeMusicSec)
          : DEFAULT_TIME_MUSIC_SEC;

      // Base payload (sans deleteField)
      const answerFields = buildAnswerPayload(it, hasAnswersCsv);
      const payload = {
        text: it.text ?? "",
        ...answerFields,
        timeMusicSec: nextTimeMusicSec,
        timecodeSec:
          typeof it.timecodeSec === "number" ? it.timecodeSec : null,

        // Images (brutes, on ajustera juste après avec deleteField si besoin)
        imageQuestionUrl: it.imageQuestionUrl || "",
        imageReponseUrl: it.imageReponseUrl || it.imageUrl || "",
        imageQuestionLarge: it.imageQuestionLarge || false,

        order:
          typeof it.order === "number"
            ? it.order
            : (items.findIndex((x) => x.id === it.id) + 1) * 1000,
      };

      // Construire l’objet d’update final (avec deleteField)
      const updates = { ...payload };

      if (getQuestionType(it) === QUESTION_TYPE_OPEN) {
        updates.qcmOptions = deleteField();
        updates.qcmCorrectIndex = deleteField();
      } else {
        updates.matchingMode = deleteField();
      }

      // QUESTION : suppression demandée ou URL vide → deleteField + nettoyage legacy éventuel
      if (it._deleteImageQuestion || !payload.imageQuestionUrl) {
        updates.imageQuestionUrl = deleteField();
        updates.questionImageUrl = deleteField();
        updates.imageQuestion = deleteField();
      }

      // RÉPONSE : suppression demandée ou URL vide → deleteField + legacy
      if (it._deleteImageReponse || !payload.imageReponseUrl) {
        updates.imageReponseUrl = deleteField();
        updates.imageReponse = deleteField();
        updates.imageUrl = deleteField(); // legacy visible côté UI
        updates.image = deleteField();
      }

      await updateDoc(doc(db, "LesQuestions", it.id), updates);

      setSavedRowId(it.id);
      setTimeout(() => setSavedRowId(null), 2000);
    } catch (err) {
      console.error("saveOne error:", err);
      alert("Échec de la modification : " + (err?.message || err));
    } finally {
      setSavingId(null);
      await (async () => {
        if (!selectedQuizKey) return;
        const colRef = collection(db, "LesQuestions");
        const qRef = query(
          colRef,
          where("quizKey", "==", selectedQuizKey),
          orderBy("order", "asc")
        );
        const snap = await getDocs(qRef);
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        await recalcAllTimecodesFromOrder();
      })();
    }
  };

  // [4.7] Supprimer une question
  const removeOne = async (id) => {
    if (!confirm("Supprimer cette question ?")) return;
    await deleteDoc(doc(db, "LesQuestions", id));
    if (!selectedQuizKey) return;
    const colRef = collection(db, "LesQuestions");
    const qRef = query(
      colRef,
      where("quizKey", "==", selectedQuizKey),
      orderBy("order", "asc")
    );
    const snap = await getDocs(qRef);
    setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    await recalcAllTimecodesFromOrder();
  };

  // [4.8] Reorder (swap deux lignes)
  const swapOrder = async (indexA, indexB) => {
    if (
      indexA < 0 ||
      indexB < 0 ||
      indexA >= items.length ||
      indexB >= items.length
    )
      return;
    const a = items[indexA],
      b = items[indexB];
    const batch = writeBatch(db);
    batch.update(doc(db, "LesQuestions", a.id), {
      order: b.order ?? (indexB + 1) * 1000,
    });
    batch.update(doc(db, "LesQuestions", b.id), {
      order: a.order ?? (indexA + 1) * 1000,
    });
    await batch.commit();

    if (!selectedQuizKey) return;
    const colRef = collection(db, "LesQuestions");
    const qRef = query(
      colRef,
      where("quizKey", "==", selectedQuizKey),
      orderBy("order", "asc")
    );
    const snap = await getDocs(qRef);
    setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    await recalcAllTimecodesFromOrder();
  };

  // [4.9] Initialiser l'ordre une fois (fallback legacy)
  const initOrder = async () => {
    if (!selectedQuizKey) return;
    const colRef = collection(db, "LesQuestions");
    const q = query(
      colRef,
      where("quizKey", "==", selectedQuizKey),
      orderBy("createdAt", "asc")
    );
    const snap = await getDocs(q);
    const arr = snap.docs.map((d, i) => ({ id: d.id, ...d.data(), idx: i }));
    const batch = writeBatch(db);
    arr.forEach((it, i) =>
      batch.update(doc(colRef, it.id), { order: (i + 1) * 1000 })
    );
    await batch.commit();
    const q2 = query(
      colRef,
      where("quizKey", "==", selectedQuizKey),
      orderBy("order", "asc")
    );
    const snap2 = await getDocs(q2);
    setItems(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
    await recalcAllTimecodesFromOrder();
  };

  // [4.10] Créer une nouvelle question
  const createOne = async () => {
    try {
      setCreating(true);
      let imageQuestionUrl = "";
      let imageReponseUrl = "";
      if (newQ.imageQuestionFile)
        imageQuestionUrl = (await uploadImage(newQ.imageQuestionFile)) || "";
      if (newQ.imageReponseFile)
        imageReponseUrl = (await uploadImage(newQ.imageReponseFile)) || "";

      const answers =
        newQuestionType === QUESTION_TYPE_QCM
          ? qcmAnswersFromOptions(newQcmOptions, newQcmCorrectIndex)
          : parseCSV(newQ.answersCsv);

      if (newQuestionType === QUESTION_TYPE_QCM) {
        const validation = validateQcmOptions(newQcmOptions, newQcmCorrectIndex);
        if (!validation.ok) {
          alert(validation.reason);
          setCreating(false);
          return;
        }
      }

      const timeMusicSec = clampTimeMusicSec(parseHMS(newQ.timeMusicStr));
      const order =
        items.length > 0
          ? Math.max(...items.map((x) => x.order || 0)) + 1000
          : 1000;
      // Utiliser les phrases depuis Firestore (ou valeurs par défaut)
      const cleanedRevealPhrases = (revealPhrases ?? [])
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .slice(0, 5);

      await addDoc(collection(db, "LesQuestions"), {
        text: newQ.text || "",
        answers,
        questionType: newQuestionType,
        ...(newQuestionType === QUESTION_TYPE_QCM
          ? {
              qcmOptions: normalizeQcmOptions(newQcmOptions),
              qcmCorrectIndex: newQcmCorrectIndex,
            }
          : {
              matchingMode: newMatchingMode || "strict",
            }),

        timeMusicSec,
        timecodeSec: null, // recalculé par recalcAllTimecodesFromOrder

        imageQuestionUrl,
        imageReponseUrl,
        imageQuestionLarge: newQ.imageQuestionLarge || false,
        // imageUrl déprécié

        createdAt: new Date(),
        order,
        revealPhrases: cleanedRevealPhrases, // [] autorisé → fallback côté clients

        // Quiz propriétaire : quiz sélectionné ou quiz actif, fallback "quiz-test"
        quizKey: selectedQuizKey || activeQuizKey || "quiz-test",
      });

      setNewQ({
        text: "",
        answersCsv: "",
        timeMusicStr: formatHMS(defaultTimeMusicSec), // Utiliser la valeur par défaut configurée
        imageQuestionFile: null,
        imageReponseFile: null,
        imageQuestionLarge: false,
      });
      setNewQuestionType(QUESTION_TYPE_OPEN);
      setNewQcmOptions(["", "", "", ""]);
      setNewQcmCorrectIndex(0);
      setNewMatchingMode("strict");
    } catch (err) {
      console.error("createOne error:", err);
      alert("Échec de la création : " + (err?.message || err));
    } finally {
      setCreating(false);
      if (!selectedQuizKey) return;
      const colRef = collection(db, "LesQuestions");
      const qRef = query(
        colRef,
        where("quizKey", "==", selectedQuizKey),
        orderBy("order", "asc")
      );
      const snap = await getDocs(qRef);
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      await recalcAllTimecodesFromOrder();
    }
  };

  // ============================================================================
  // /pages/admin.js — Partie 5/6
  // Scope : Actions — Live (start/pause/seek/back/next/round) +
  //         Joueurs (reject/kick/alias) + purge/reset complet
  // Règles : aucune modification fonctionnelle ; seulement commentaires/sections.
  // ============================================================================

  

  // Garde-fou : dès que le quiz démarre réellement, on force l’onglet sur le quiz actif
  const wasRunningRefForTab = useRef(false);

  useEffect(() => {
    const nowRunning = isRunning && !!quizStartMs;
    const wasRunning = wasRunningRefForTab.current;

    // Transition "pas en cours" -> "en cours"
    if (!wasRunning && nowRunning && activeQuizKey) {
      setSelectedQuizKey(activeQuizKey);
      setAdminTab(`quiz:${activeQuizKey}`);
    }

    wasRunningRefForTab.current = nowRunning;
  }, [isRunning, quizStartMs, activeQuizKey, setAdminTab, setSelectedQuizKey]);

/* ------------------------------- Actions: Live ------------------------------- */

  const startQuiz = async () => {
    try {
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: false,
          startAt: serverTimestamp(),
          pauseAt: null,
          anchorAt: serverTimestamp(),
          anchorOffsetSec: 0,
          startEpochMs: null,
          navSeq: increment(1),
          hbBoost: true,
          lastAutoPausedRoundIndex: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("startQuiz error:", err);
      alert("Impossible de démarrer le quiz : " + (err?.message || err));
    }
  };

  /** Seek en pause sur un timecode question (Back/Next). Jamais de podium fin de manche. */
  const seekPaused = async (targetSec) => {
    try {
      const target = Math.max(0, Math.round(Number(targetSec) || 0));
      // Optimistic UI : pas de flash « Démarrer le quiz » pendant le serverTimestamp
      const now = Date.now();
      setParkedMarkerSec(target);
      setIsRunning(true);
      setIsPaused(true);
      setElapsedSec(target);
      setQuizStartMs(now - target * 1000);
      setPauseAtMs(now);
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: true,
          startAt: serverTimestamp(),
          pauseAt: serverTimestamp(),
          anchorAt: serverTimestamp(),
          anchorOffsetSec: target,
          startEpochMs: null,
          navSeq: increment(1),
          hbBoost: true,
          lastAutoPausedRoundIndex: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("seekPaused error:", err);
      alert("Échec du positionnement (pause) : " + (err?.message || err));
    }
  };

  /** Reprendre la lecture depuis un timecode question (après fin de manche). */
  const seekAndPlay = async (targetSec) => {
    try {
      const target = Math.max(0, Math.round(Number(targetSec) || 0));
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: false,
          startAt: serverTimestamp(),
          pauseAt: null,
          anchorAt: serverTimestamp(),
          anchorOffsetSec: target,
          startEpochMs: null,
          navSeq: increment(1),
          hbBoost: true,
          lastAutoPausedRoundIndex: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("seekAndPlay error:", err);
      alert("Échec de la reprise : " + (err?.message || err));
    }
  };

  /**
   * Pause / Reprendre.
   * Après auto-pause « fin de manche » : Reprendre = 1ère question de la manche
   * suivante (remplace l’ancien bouton « Manche suivante »), puis lecture.
   */
  const handlePauseResume = async () => {
    if (!(isRunning && quizStartMs) || isQuizEnded || isBuzzerMode) return;

    if (isPaused && Number.isInteger(lastAutoPausedRoundIndex)) {
      const markers = buildQuizMarkers(plannedTimes, roundOffsetsSec);
      const nextFirst = firstMarkerOfRound(
        markers,
        lastAutoPausedRoundIndex + 1
      );
      if (nextFirst) {
        setParkedMarkerSec(null);
        await seekAndPlay(nextFirst.sec);
        return;
      }
    }

    await togglePauseResume(db);
  };

  // Sauvegarder automatiquement la config de temps (manches + fin) avant un départ à froid
  const autoSaveTimeConfigBeforeStart = async () => {
    try {
      await saveRoundOffsets(roundOffsetsStr);
      await saveEndOffset(endOffsetStr);
    } catch (e) {
      console.error("autoSaveTimeConfigBeforeStart error:", e);
    }
  };

  /** Gros bouton / V : uniquement démarrer le quiz depuis le début */
  const startQuizFromBeginning = async () => {
    if (mainBtnBusy || isBuzzerMode || isQuizEnded) return;
    if (isRunning && quizStartMs) {
      setNotice("Le quiz est déjà démarré — utilise Pause / Back / Next");
      setTimeout(() => setNotice(null), 2000);
      return;
    }
    setMainBtnBusy(true);
    setTimeout(() => setMainBtnBusy(false), 350);
    await autoSaveTimeConfigBeforeStart();
    await startQuiz();
  };

  async function awardCurrentQuestionIfNeeded() {
    try {
      const qid = currentQuestion?.id || null;
      if (!qid) return { ok: false, reason: "no-active-question" };
      const res = await ensureAwardsForQuestionTx(db, qid);
      if (res?.reason)
        console.log("[Admin] awardCurrentQuestionIfNeeded:", res.reason);
      return res;
    } catch (e) {
      console.error("[Admin] awardCurrentQuestionIfNeeded error:", e);
      return { ok: false, reason: "error" };
    }
  }

  const handleBack = async () => {
    if (!isPaused || isBuzzerMode) return;
    const markers = buildQuizMarkers(plannedTimes, roundOffsetsSec);
    if (!markers.length) {
      setNotice("Aucun marqueur");
      setTimeout(() => setNotice(null), 1600);
      return;
    }

    const { seekSec } = planBackSeek(
      elapsedSec,
      markers,
      parkedMarkerSec
    );
    if (seekSec == null) return;
    await seekPaused(seekSec);
  };

  const handleNext = async () => {
    if (!isPaused || isBuzzerMode) return;
    const markers = buildQuizMarkers(plannedTimes, roundOffsetsSec);
    if (!markers.length) {
      setNotice("Aucun marqueur suivant");
      setTimeout(() => setNotice(null), 2000);
      return;
    }
    const target = resolveNextMarker(elapsedSec, markers);
    if (!target) {
      setNotice("Fin du quiz : plus de marqueur suivant");
      setTimeout(() => setNotice(null), 1600);
      return;
    }
    await awardCurrentQuestionIfNeeded();
    await seekPaused(target.sec);
  };

  /* ------------------------------- Actions: Joueurs & Reset ------------------------------- */

  // [5.1] Alias "Player N"
  async function getNextAliasNumber() {
    const stateRef = doc(db, "quiz", "state");
    let reservedN = await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.exists() ? snap.data() : {};
      const current = Number.isFinite(data?.aliasCounter)
        ? data.aliasCounter
        : 1;
      const next = current + 1;
      tx.set(stateRef, { aliasCounter: next }, { merge: true });
      return current;
    });

    while (true) {
      const nameNorm = normKey(`Player ${reservedN}`);
      const playersCol = collection(db, "quiz", "state", "players");
      const q = query(playersCol, where("nameNorm", "==", nameNorm));
      const snap = await getDocs(q);
      if (snap.empty) return reservedN;

      reservedN = await runTransaction(db, async (tx) => {
        const snap2 = await tx.get(stateRef);
        const data2 = snap2.exists() ? snap2.data() : {};
        const current2 = Number.isFinite(data2?.aliasCounter)
          ? data2.aliasCounter
          : 1;
        const next2 = current2 + 1;
        tx.set(stateRef, { aliasCounter: next2 }, { merge: true });
        return current2;
      });
    }
  }

  // [5.2] Refuser un nom de joueur (modération)
  async function rejectPlayer(playerId, currentName) {
    try {
      const playersCol = collection(db, "quiz", "state", "players");
      const ref = doc(playersCol, playerId);

      const snap = await getDoc(ref);
      if (!snap.exists()) return;
      const d = snap.data() || {};

      const isAliased = !!d.isAlias;
      const norm = normKey(
        typeof d.name === "string" ? d.name : currentName || ""
      );

      // Mettre à jour le statut du joueur (garder ses scores)
      const baseUpdates = {
        nameStatus: "rejected",
        nameLocked: false,
        isAlias: false,
        updatedAt:
          typeof serverTimestamp === "function"
            ? serverTimestamp()
            : new Date(),
      };

      await updateDoc(ref, baseUpdates);

      // Ajouter le nom à la liste globale des noms refusés (si ce n'est pas un alias)
      if (!isAliased && norm) {
        const configRef = doc(db, "quiz", "config");
        const configSnap = await getDoc(configRef);
        const configData = configSnap.exists() ? configSnap.data() : {};
        const currentRejected = Array.isArray(configData.globalRejectedNames) 
          ? configData.globalRejectedNames 
          : [];
        
        // Éviter les doublons
        if (!currentRejected.includes(norm)) {
          await updateDoc(configRef, {
            globalRejectedNames: arrayUnion(norm)
          }, { merge: true });
        }
      }
    } catch (e) {
      console.error("rejectPlayer failed:", e);
    }
  }

  // [5.2.1] Retirer un nom de la liste globale des noms refusés
  async function removeRejectedName(nameNorm) {
    try {
      const configRef = doc(db, "quiz", "config");
      await updateDoc(configRef, {
        globalRejectedNames: arrayRemove(nameNorm)
      }, { merge: true });
    } catch (e) {
      console.error("removeRejectedName failed:", e);
      alert("Erreur lors de la suppression du nom : " + (e?.message || e));
    }
  }

  // [5.3] Kick joueur
  async function kickPlayer(id) {
    try {
      const playersCol = collection(db, "quiz", "state", "players");
      await updateDoc(doc(playersCol, id), { isKicked: true });
    } catch (e) {
      console.error("kickPlayer", e);
    }
  }

  // [5.3.1] Réaccepter un joueur kické (conserve ses scores)
  async function unkickPlayer(id) {
    try {
      const playersCol = collection(db, "quiz", "state", "players");
      await updateDoc(doc(playersCol, id), { isKicked: false });
    } catch (e) {
      console.error("unkickPlayer", e);
    }
  }

  // [5.4.1] Actions sur les équipes
  async function rejectTeam(teamId, teamName) {
    try {
      // Ajouter à la liste globale des noms d'équipes refusés avant de supprimer
      const norm = normalizeTeamName(teamName);
      if (norm) {
        const configRef = doc(db, "quiz", "config");
        const configSnap = await getDoc(configRef);
        const configData = configSnap.exists() ? configSnap.data() : {};
        const currentRejected = Array.isArray(configData.globalRejectedTeamNames) 
          ? configData.globalRejectedTeamNames 
          : [];
        
        if (!currentRejected.includes(norm)) {
          await updateDoc(configRef, {
            globalRejectedTeamNames: arrayUnion(norm)
          }, { merge: true });
        }
      }

      // Supprimer l'équipe et retirer tous ses membres
      const result = await deleteTeamTx(db, teamId);
      if (!result.ok) {
        console.error("rejectTeam failed:", result.reason);
        alert("Erreur lors de la suppression de l'équipe : " + (result.reason || "Erreur inconnue"));
      }
    } catch (e) {
      console.error("rejectTeam failed:", e);
      alert("Erreur lors de la suppression de l'équipe : " + (e?.message || e));
    }
  }

  async function kickTeam(teamId) {
    try {
      const teamsCol = collection(db, "quiz", "state", "teams");
      const teamRef = doc(teamsCol, teamId);
      const teamSnap = await getDoc(teamRef);
      if (!teamSnap.exists()) return;

      const teamData = teamSnap.data();
      const memberIds = teamData.memberIds || [];

      // Kick l'équipe
      await updateDoc(teamRef, { isKicked: true, updatedAt: serverTimestamp() });

      // Kick tous les membres
      const playersCol = collection(db, "quiz", "state", "players");
      const batch = writeBatch(db);
      memberIds.forEach((playerId) => {
        const playerRef = doc(playersCol, playerId);
        batch.update(playerRef, { isKicked: true });
      });
      await batch.commit();
    } catch (e) {
      console.error("kickTeam failed:", e);
    }
  }

  async function unkickTeam(teamId) {
    try {
      const teamsCol = collection(db, "quiz", "state", "teams");
      const teamRef = doc(teamsCol, teamId);
      const teamSnap = await getDoc(teamRef);
      if (!teamSnap.exists()) return;

      const teamData = teamSnap.data();
      const memberIds = teamData.memberIds || [];

      // Réaccepter l'équipe
      await updateDoc(teamRef, { 
        isKicked: false,
        updatedAt: serverTimestamp(),
      });

      // Réaccepter tous les membres
      const playersCol = collection(db, "quiz", "state", "players");
      const batch = writeBatch(db);
      memberIds.forEach((playerId) => {
        const playerRef = doc(playersCol, playerId);
        batch.update(playerRef, { isKicked: false });
      });
      await batch.commit();
    } catch (e) {
      console.error("unkickTeam failed:", e);
    }
  }

  async function saveTeamScore(teamId, field, value) {
    try {
      const teamsCol = collection(db, "quiz", "state", "teams");
      const numValue = Number(value);
      if (!Number.isFinite(numValue)) return;
      await updateDoc(doc(teamsCol, teamId), {
        [field]: numValue,
        updatedAt: serverTimestamp(),
      });
      setEditingScore({ playerId: null, field: null });
      setEditingValue("");
    } catch (e) {
      console.error("saveTeamScore failed:", e);
      alert("Erreur lors de la sauvegarde : " + (e?.message || e));
    }
  }

  // [5.4] Renommer en alias "Player N" (verrouillé)
  async function renameToAlias(playerId) {
    try {
      const n = await getNextAliasNumber();
      const alias = `Player ${n}`;
      const aliasNorm = normKey(alias);

      const playersCol = collection(db, "quiz", "state", "players");
      const ref = doc(playersCol, playerId);

      await updateDoc(ref, {
        name: alias,
        nameNorm: aliasNorm,
        nameLocked: true,
        nameStatus: "locked",
        isAlias: true,
        aliasNumber: n,
        updatedAt:
          typeof serverTimestamp === "function"
            ? serverTimestamp()
            : new Date(),
      });
    } catch (e) {
      console.error("renameToAlias", e);
    }
  }

  // [5.5] Supprimer tous les joueurs (batchs)
  async function deleteAllPlayers() {
    const playersCol = collection(db, "quiz", "state", "players");
    const snap = await getDocs(playersCol);
    const ids = snap.docs.map((d) => d.id);

    while (ids.length) {
      const chunk = ids.splice(0, 400);
      const batch = writeBatch(db);
      chunk.forEach((id) => batch.delete(doc(playersCol, id)));
      await batch.commit();
    }
  }

  // [5.6] Purge complète de answers/* — voir purgeAnswersTree() dans firebase-helpers.js

  // [5.7] Reset complet du quiz + joueurs + answers/*
  async function resetQuizAndPlayers() {
    const ok = window.confirm(
      "Tout remettre à zéro ? (quiz/state, joueurs, answers/*)"
    );
    if (!ok) return;

    setNotice("Réinitialisation…");
    try {
      // Réinitialiser l'état EleyBuzz en premier
      await resetBuzzerState(db, "idle");

      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: false,
          isPaused: false,
          startAt: null,
          startEpochMs: null,
          pauseAt: null,
          isIntro: false,
          introEndsAtMs: null,
          introRoundIndex: null,
          lastAutoPausedRoundIndex: null,
          showFinalScore: false,
          buzzMergedIntoScore: false,
          // Réinitialiser complètement EleyBuzz
          isBuzzerMode: false,
          buzzerState: "idle",
          firstPlayerId: null,
          firstPlayerName: null,
          buzzerMessage: null,
          buzzerMessageType: null,
          streamDeckRemoteEnabled: false,
        },
        { merge: true }
      );

      await purgeAnswersTree(db);

      await deleteAllPlayers();

      // Supprimer toutes les équipes
      const teamsCol = collection(doc(db, "quiz", "state"), "teams");
      const teamsSnap = await getDocs(teamsCol);
      const deleteTeamsBatch = writeBatch(db);
      teamsSnap.docs.forEach((teamDoc) => {
        deleteTeamsBatch.delete(teamDoc.ref);
      });
      if (teamsSnap.docs.length > 0) {
        await deleteTeamsBatch.commit();
      }

      await setDoc(
        doc(db, "quiz", "state"),
        {
          playersResetAt: serverTimestamp(),
          aliasCounter: 1,
        },
        { merge: true }
      );

      setNotice("Réinitialisation terminée ✔");
      setTimeout(() => setNotice(null), 1800);
    } catch (e) {
      console.error("resetQuizAndPlayers error:", e);
      setNotice("Échec de la réinitialisation");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // [5.7bis] Reset du quiz uniquement (garde les joueurs et leurs scores)
  async function resetQuizOnly() {
    const ok = window.confirm(
      "Réinitialiser le quiz ? (quiz/state, answers/*) - Les joueurs et leurs scores seront conservés."
    );
    if (!ok) return;

    setNotice("Réinitialisation du quiz…");
    try {
      // Réinitialiser l'état EleyBuzz
      await resetBuzzerState(db, "idle");
      
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: false,
          isPaused: false,
          startAt: null,
          startEpochMs: null,
          pauseAt: null,
          isIntro: false,
          introEndsAtMs: null,
          introRoundIndex: null,
          lastAutoPausedRoundIndex: null,
          showFinalScore: false,
          buzzMergedIntoScore: false,
          // Réinitialiser complètement EleyBuzz
          isBuzzerMode: false,
          buzzerState: "idle",
          firstPlayerId: null,
          firstPlayerName: null,
          buzzerMessage: null,
          buzzerMessageType: null,
          streamDeckRemoteEnabled: false,
        },
        { merge: true }
      );

      await purgeAnswersTree(db);
      
      // Débloquer tous les joueurs (au cas où certains seraient bloqués)
      await resetAllPlayerBuzzLocks(db, []);

      setNotice("Quiz réinitialisé ✔");
      setTimeout(() => setNotice(null), 1800);
    } catch (e) {
      console.error("resetQuizOnly error:", e);
      setNotice("Échec de la réinitialisation du quiz");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // ============================================================================
  // [5.8] EleyBuzz — Fonctions de contrôle
  // ============================================================================

  // Calculer isQuizEnded avant de l'utiliser
  const isQuizEnded = Number.isFinite(quizEndSec) && elapsedSec >= quizEndSec;

  // Conditions d'activation EleyBuzz
  const canActivateEleyBuzz = (!isRunning || isPaused || isQuizEnded) && !isBuzzerMode;
  const canDeactivateEleyBuzz = isBuzzerMode === true;

  // Condition pour remettre tous les scores à zéro (même règle que EleyBuzz, sans la condition isBuzzerMode)
  const canResetScores = !isRunning || isPaused || isQuizEnded;

  // Toggle EleyBuzz mode
  async function toggleEleyBuzzMode() {
    try {
      const stateRef = doc(db, "quiz", "state");
      if (!isBuzzerMode) {
        // Activation : réinitialiser tous les états EleyBuzz
        await updateDoc(stateRef, {
          isBuzzerMode: true,
          buzzerState: "idle",
          firstPlayerId: null,
          firstPlayerName: null,
          wrongAnswerCount: 0, // Initialiser le compteur de mauvaises réponses
        });
        // Réinitialiser tous les canBuzz des joueurs à true (pour débloquer ceux qui étaient en punition)
        await resetAllPlayerBuzzLocks(db, []);
        setNotice("EleyBuzz activé");
      } else {
        // Désactivation : débloquer tous les joueurs et nettoyer la collection temporaire
        await resetAllPlayerBuzzLocks(db, []);
        await resetBuzzerState(db, "idle");
        await updateDoc(stateRef, {
          isBuzzerMode: false,
        });
        setNotice("EleyBuzz désactivé");
      }
      setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      console.error("toggleEleyBuzzMode error:", e);
      setNotice("Erreur lors du changement de mode EleyBuzz");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Toggle buzzer state (idle ↔ open)
  async function toggleBuzzerState() {
    if (!isBuzzerMode) return;
    
    if (buzzerState === BUZZER_STATES.LOCKED) {
      setNotice("Le buzzer est verrouillé, attendez la fin de la manche");
      setTimeout(() => setNotice(null), 2000);
      return;
    }
    
    try {
      if (buzzerState === "idle") {
        // Nouvelle question : tous les buzzers redeviennent bleus
        await openBuzzerForNewRound(db);
      } else {
        // Pause : IDLE + réinitialisation de tous les joueurs
        await resetBuzzerState(db, "idle");
      }
    } catch (e) {
      console.error("toggleBuzzerState error:", e);
      setNotice("Erreur lors du changement d'état du buzzer");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  /** Recovery live : tous bleus + buzzer OPEN + reload des Player figés */
  async function handleRecoverEleyBuzz() {
    if (!isBuzzerMode) return;
    try {
      await recoverEleyBuzzPlayers(db);
      setNotice("Buzzers reset — tous bleus + refresh joueurs");
      setTimeout(() => setNotice(null), 2000);
    } catch (e) {
      console.error("handleRecoverEleyBuzz error:", e);
      setNotice("Erreur reset buzzers");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Gérer bonne réponse (touche 2)
  async function handleBuzzerCorrect() {
    if (!isBuzzerMode || buzzerState !== "locked" || !firstPlayerId) return;
    try {
      const correctPlayerId = firstPlayerId;
      const correctPlayerName = buzzerWinnerName;
      const stateRef = doc(db, "quiz", "state");
      const correctMessage = `${screenEleyBuzzMessages.correctAnswer} ${correctPlayerName || "Joueur"}, ${screenEleyBuzzMessages.youWin} ${buzzerPoints} ${screenEleyBuzzMessages.pts}`;

      // 1) Message « bravo » (Screen + Player) — on garde firstPlayerId pour les textes joueurs
      await updateDoc(stateRef, {
        buzzerMessage: correctMessage,
        buzzerMessageType: "correct",
        buzzerState: BUZZER_STATES.LOCKED,
        firstPlayerId: correctPlayerId,
        firstPlayerName: null,
      });

      // 2) Points
      await awardBuzzerPoints(db, correctPlayerId, buzzerPoints);

      // 3) Fin du message → buzzer rouvert, tous les joueurs bleus (nouvelle manche)
      setTimeout(() => {
        openBuzzerForNewRound(db).catch((e) =>
          console.error("[handleBuzzerCorrect] openBuzzerForNewRound:", e)
        );
      }, buzzerCorrectMessageDurationMs);
    } catch (e) {
      console.error("handleBuzzerCorrect error:", e);
      setNotice("Erreur lors de l'attribution des points");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Gérer mauvaise réponse (touche 3)
  async function handleBuzzerWrong() {
    if (!isBuzzerMode || buzzerState !== "locked" || !firstPlayerId) return;
    try {
      const wrongPlayerId = firstPlayerId;
      const stateRef = doc(db, "quiz", "state");
      
      // Lire le compteur de mauvaises réponses pour cette question
      const stateSnap = await getDoc(stateRef);
      const stateData = stateSnap.exists() ? stateSnap.data() : {};
      const wrongAnswerCount = Number(stateData.wrongAnswerCount || 0);
      
      // Calculer la pénalité progressive :
      // 1ère = -1, 2ème = -2, 3ème = -3, 4ème = -4, 5ème+ = -5
      const penalty = Math.min(wrongAnswerCount + 1, 5);
      
      // Retirer les points de pénalité du score EleyBuzz (peut aller en négatif)
      await awardBuzzerPoints(db, wrongPlayerId, -penalty);
      
      // Snapshot joueurs AVANT lock : ceux déjà éliminés restent hors jeu
      const playersCol = collection(db, "quiz", "state", "players");
      const playersSnap = await getDocs(playersCol);
      const stayLocked = new Set(
        playersSnap.docs
          .filter((d) => d.data()?.canBuzz === false)
          .map((d) => d.id)
      );
      stayLocked.add(wrongPlayerId);

      // Une seule passe : un seul faux → canBuzz false ; les autres éligibles → true
      let batch = writeBatch(db);
      let n = 0;
      for (const d of playersSnap.docs) {
        const locked = stayLocked.has(d.id);
        batch.update(doc(playersCol, d.id), {
          canBuzz: !locked,
          buzzerCooldownUntil: null,
          lastWrongPenalty: d.id === wrongPlayerId ? penalty : null,
        });
        n++;
        if (n >= 400) {
          await batch.commit();
          batch = writeBatch(db);
          n = 0;
        }
      }
      if (n > 0) await batch.commit();
      
      // Incrémenter le compteur de mauvaises réponses pour cette question
      await updateDoc(stateRef, {
        wrongAnswerCount: wrongAnswerCount + 1,
      }, { merge: true });
      
      // Réouvrir le buzzer (sans message « mauvaise réponse » pour éviter le clignotement)
      await resetBuzzerState(db, "open");
    } catch (e) {
      console.error("handleBuzzerWrong error:", e);
      setNotice("Erreur lors du traitement de la mauvaise réponse");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Raccourcis EleyBuzz (pavé) toujours.
  // Transport clavier (V / Espace / Shift+B/N) : désactivé quand télécommande ON —
  // le Stream Deck envoie souvent HTTP + hotkey Studio One ; si Admin a le focus,
  // le hotkey doublerait la commande HTTP. Avec télécommande ON → HTTP seul.
  const transportHotkeysRef = useRef({});
  transportHotkeysRef.current = {
    streamDeckRemoteEnabled,
    isBuzzerMode,
    canPauseResume: isRunning && !isQuizEnded,
    isPaused,
    markersLen: buildQuizMarkers(plannedTimes, roundOffsetsSec).length,
    mainBtnBusy,
    isRunning,
    quizStartMs,
    isQuizEnded,
    startQuizFromBeginning,
    handleBack,
    handleNext,
    handlePauseResume,
  };

  const eleyBuzzHotkeysRef = useRef({});
  eleyBuzzHotkeysRef.current = {
    toggleEleyBuzzMode,
    toggleBuzzerState,
    handleBuzzerCorrect,
    handleBuzzerWrong,
    canActivateEleyBuzz,
    canDeactivateEleyBuzz,
    isBuzzerMode,
    buzzerState,
    firstPlayerId,
    buzzerMessage,
  };

  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        e.target?.isContentEditable
      ) {
        return;
      }

      const t = transportHotkeysRef.current;
      const h = eleyBuzzHotkeysRef.current;

      // Transport clavier uniquement si télécommande OFF (sinon Stream Deck = HTTP)
      if (!t.streamDeckRemoteEnabled && !h.isBuzzerMode) {
        if (e.code === "Space") {
          e.preventDefault();
          if (t.canPauseResume) t.handlePauseResume();
          return;
        }
        if (e.code === "KeyV" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (!t.mainBtnBusy && !t.isQuizEnded && !(t.isRunning && t.quizStartMs)) {
            t.startQuizFromBeginning();
          }
          return;
        }
        if (e.code === "KeyB" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (t.isPaused && t.markersLen > 0) t.handleBack();
          return;
        }
        if (e.code === "KeyN" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (t.isPaused && t.markersLen > 0) t.handleNext();
          return;
        }
      }

      // --- EleyBuzz (pavé numérique) ---
      if (e.code === "Numpad0") {
        e.preventDefault();
        if (h.canActivateEleyBuzz || h.canDeactivateEleyBuzz) {
          h.toggleEleyBuzzMode();
        }
        return;
      }
      if (e.code === "Numpad1") {
        e.preventDefault();
        if (h.isBuzzerMode && h.buzzerState !== "locked") {
          h.toggleBuzzerState();
        }
        return;
      }
      if (e.code === "Numpad2") {
        e.preventDefault();
        if (
          h.isBuzzerMode &&
          h.buzzerState === "locked" &&
          h.firstPlayerId &&
          !h.buzzerMessage
        ) {
          h.handleBuzzerCorrect();
        }
        return;
      }
      if (e.code === "Numpad3") {
        e.preventDefault();
        if (
          h.isBuzzerMode &&
          h.buzzerState === "locked" &&
          h.firstPlayerId &&
          !h.buzzerMessage
        ) {
          h.handleBuzzerWrong();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function toggleStreamDeckRemote() {
    try {
      const stateRef = doc(db, "quiz", "state");
      if (!streamDeckRemoteEnabled) {
        const secret = streamDeckSecret || makeStreamDeckSecret();
        await setDoc(
          stateRef,
          {
            streamDeckRemoteEnabled: true,
            streamDeckSecret: secret,
          },
          { merge: true }
        );
        setNotice("Télécommande Stream Deck ON");
      } else {
        await setDoc(
          stateRef,
          { streamDeckRemoteEnabled: false },
          { merge: true }
        );
        setNotice("Télécommande Stream Deck OFF");
      }
      setTimeout(() => setNotice(null), 1800);
    } catch (e) {
      console.error("toggleStreamDeckRemote error:", e);
      setNotice("Erreur télécommande");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // File d'attente Stream Deck → exécutée par Admin (auth admin), même en arrière-plan
  const remoteExecRef = useRef({});
  const remoteProcessedIdsRef = useRef(new Set());
  const remoteActionLockRef = useRef({ action: null, at: 0 });
  remoteExecRef.current = {
    secret: streamDeckSecret,
    enabled: streamDeckRemoteEnabled,
    isBuzzerMode,
    canPauseResume: isRunning && !isQuizEnded,
    startQuizFromBeginning,
    handleBack,
    handleNext,
    handlePauseResume,
  };

  useEffect(() => {
    if (!streamDeckRemoteEnabled || !streamDeckSecret) return undefined;

    const inboxCol = collection(db, "quiz", "state", "remoteInbox");
    const unsub = onSnapshot(
      inboxCol,
      async (snap) => {
        const changes = snap.docChanges().filter((c) => c.type === "added");
        for (const change of changes) {
          const refDoc = change.doc;
          const docId = refDoc.id;
          if (remoteProcessedIdsRef.current.has(docId)) continue;
          remoteProcessedIdsRef.current.add(docId);
          // Évite une fuite mémoire sur une longue session
          if (remoteProcessedIdsRef.current.size > 80) {
            remoteProcessedIdsRef.current = new Set(
              [...remoteProcessedIdsRef.current].slice(-40)
            );
          }

          const data = refDoc.data() || {};
          const exec = remoteExecRef.current;
          try {
            if (data.secret !== exec.secret) {
              await deleteDoc(refDoc.ref);
              continue;
            }
            await deleteDoc(refDoc.ref);
            if (exec.isBuzzerMode) continue;

            const action = String(data.action || "").toLowerCase();
            const now = Date.now();
            const lock = remoteActionLockRef.current;
            // Anti double-tap Stream Deck / double snapshot (~500 ms)
            if (lock.action === action && now - lock.at < 500) continue;
            remoteActionLockRef.current = { action, at: now };

            if (action === "pause" && exec.canPauseResume) {
              await exec.handlePauseResume();
            } else if (action === "start") {
              await exec.startQuizFromBeginning();
            } else if (action === "back") {
              await exec.handleBack();
            } else if (action === "next") {
              await exec.handleNext();
            }
          } catch (err) {
            console.error("[remoteInbox] exec error:", err);
          }
        }
      },
      (err) => console.error("[remoteInbox] snapshot error:", err)
    );

    return () => unsub();
  }, [streamDeckRemoteEnabled, streamDeckSecret]);

  // Sauvegarder un score modifié manuellement
  async function savePlayerScore(playerId, field, value) {
    try {
      const numValue = Number(value);
      if (isNaN(numValue)) {
        setNotice("Valeur invalide");
        setTimeout(() => setNotice(null), 2000);
        return;
      }
      
      const playerRef = doc(db, "quiz", "state", "players", playerId);
      await updateDoc(playerRef, {
        [field]: numValue,
      }, { merge: true });
      
      setNotice(`Score ${field === "score" ? "Quiz" : "EleyBuzz"} mis à jour ✔`);
      setTimeout(() => setNotice(null), 1500);
      setEditingScore({ playerId: null, field: null });
      setEditingValue("");
    } catch (e) {
      console.error("savePlayerScore error:", e);
      setNotice("Erreur lors de la sauvegarde");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Remettre tous les scores à 0 (onglet Joueurs)
  async function resetAllScores() {
    const ok = window.confirm(
      "Remettre tous les scores (quiz + EleyBuzz) à 0 pour tous les joueurs et toutes les équipes ?"
    );
    if (!ok) return;

    try {
      // Reset des scores joueurs
      const playersCol = collection(db, "quiz", "state", "players");
      const playersSnap = await getDocs(playersCol);
      const playerIds = playersSnap.docs.map((d) => d.id);

      // Reset des scores équipes
      const teamsCol = collection(db, "quiz", "state", "teams");
      const teamsSnap = await getDocs(teamsCol);
      const teamIds = teamsSnap.docs.map((d) => d.id);

      // Traiter par batch (400 max par batch Firestore)
      const allIds = [...playerIds, ...teamIds];
      while (allIds.length) {
        const chunk = allIds.splice(0, 400);
        const batch = writeBatch(db);
        chunk.forEach((id) => {
          // Vérifier si c'est un joueur ou une équipe
          if (playerIds.includes(id)) {
            batch.update(doc(playersCol, id), {
              score: 0,
              buzzScore: 0,
            });
          } else if (teamIds.includes(id)) {
            batch.update(doc(teamsCol, id), {
              teamQuizScore: 0,
            });
          }
        });
        await batch.commit();
      }

      await updateDoc(doc(db, "quiz", "state"), {
        showFinalScore: false,
        buzzMergedIntoScore: false,
      }, { merge: true });

      setNotice("Tous les scores (joueurs et équipes) ont été remis à 0 ✔");
      setTimeout(() => setNotice(null), 1800);
    } catch (e) {
      console.error("resetAllScores error:", e);
      setNotice("Échec de la remise à zéro des scores");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Afficher le score final : buzz → score joueur perso (équipes inchangées)
  async function showFinalScore() {
    try {
      const stateRef = doc(db, "quiz", "state");
      const stateSnap = await getDoc(stateRef);
      const stateData = stateSnap.exists() ? stateSnap.data() : {};

      if (!stateData.buzzMergedIntoScore) {
        const playersCol = collection(stateRef, "players");
        const playersSnap = await getDocs(playersCol);
        let batch = writeBatch(db);
        let n = 0;

        for (const d of playersSnap.docs) {
          const buzzScore = Number(d.data()?.buzzScore || 0);
          if (buzzScore === 0) continue;
          // Bonus ou malus EleyBuzz → score perso uniquement
          batch.update(doc(playersCol, d.id), {
            score: increment(buzzScore),
            buzzScore: 0,
          });
          n++;
          if (n >= 400) {
            await batch.commit();
            batch = writeBatch(db);
            n = 0;
          }
        }
        if (n > 0) {
          await batch.commit();
        }

        await updateDoc(stateRef, {
          showFinalScore: true,
          buzzMergedIntoScore: true,
        });
      } else {
        await updateDoc(stateRef, { showFinalScore: true });
      }

      setNotice("Score final : points ⚡ ajoutés aux scores joueurs (équipes inchangées)");
      setTimeout(() => setNotice(null), 2500);
    } catch (e) {
      console.error("showFinalScore error:", e);
      setNotice("Erreur lors de l'affichage du score final");
      setTimeout(() => setNotice(null), 2000);
    }
  }


  // ============================================================================
  // /pages/admin.js — Partie 6/6
  // Scope : UI dérivées (couleurs/libellés/ranking), tableau Questions (mémo),
  //         Rendu JSX complet (header, toolbar, onglets Joueurs/Questions)
  // Règles : aucune modification fonctionnelle ; seulement commentaires/sections.
  // ============================================================================

  // ===================== PARTIE 6.1/6 — AdminInner : UI =====================

  /* ================= UI DÉRIVÉES ================= */

  /* --- Couleurs & libellés UI --- */
  const roundColors = [
    "#e96db1ff", // M1
    "#fb923c",  // M2
    "#a78bfa",  // M3
    "#93c5fd",  // M4
    "#86efac",  // M5
    "#5eead4",  // M6
    "#cf72f4ff",// M7
    "#2b7bf3ff",// M8
  ];
  const ROUND_BG_ALPHA = 0.70;

  // isQuizEnded déjà défini plus haut (avant les fonctions EleyBuzz)
  const currentRoundNumber = currentRoundIndex + 1;

  /** Gros bouton : démarrer, ou statut Manche N (couleur de manche assombrie) */
  const quizInProgress = isRunning && !isQuizEnded;
  const mainButtonLabel = isQuizEnded
    ? "Fin du quiz"
    : quizInProgress
      ? `Manche ${currentRoundNumber}`
      : "Démarrer le quiz";

  const mainButtonRoundIdx = quizInProgress ? currentRoundIndex : null;
  const mainButtonColor =
    mainButtonRoundIdx != null
      ? darkenHex(roundColors[mainButtonRoundIdx] || "#9ca3af", 0.26)
      : "#e5e7eb";

  const quizMarkers = useMemo(
    () => buildQuizMarkers(plannedTimes, roundOffsetsSec),
    [plannedTimes, roundOffsetsSec]
  );

  const transportUi = useMemo(
    () =>
      isPaused ? getTransportUi(elapsedSec, quizMarkers, parkedMarkerSec) : null,
    [isPaused, elapsedSec, quizMarkers, parkedMarkerSec]
  );

  const backBtnLabel = transportUi?.backLabel || "Back";
  const nextBtnLabel = transportUi?.nextLabel || "Next";
  const backBtnRoundIdx = transportUi?.backRoundIndex ?? null;
  const nextBtnRoundIdx = transportUi?.nextRoundIndex ?? null;

  const backBtnBg =
    backBtnRoundIdx != null
      ? roundColors[backBtnRoundIdx] || "#bfdbfe"
      : "#bfdbfe";
  const nextBtnBg =
    nextBtnRoundIdx != null
      ? roundColors[nextBtnRoundIdx] || "#c7d2fe"
      : "#c7d2fe";

  // Quand un quiz est en cours ou en mode EleyBuzz, on verrouille la config de temps (manches + fin de quiz)
  const timeConfigLocked = (isRunning && !!activeQuizKey) || isBuzzerMode;

  // Quiz : ordre des onglets (quiz actif en premier, puis autres par ordre alphabétique)
  const quizTabsOrdered = useMemo(() => {
    if (!Array.isArray(quizzes) || quizzes.length === 0) return [];
    const active = quizzes.find((q) => q && q.key === activeQuizKey) || null;
    const others = quizzes
      .filter((q) => !active || q.key !== active.key)
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return active ? [active, ...others] : others;
  }, [quizzes, activeQuizKey]);

  const currentQuiz = useMemo(() => {
    if (!selectedQuizKey || !Array.isArray(quizzes)) return null;
    return quizzes.find((q) => q.key === selectedQuizKey) || null;
  }, [selectedQuizKey, quizzes]);

  // On peut changer le quiz actif uniquement avant le départ
  const canChangeActiveQuiz = !quizInProgress && !isQuizEnded;

  // --- Pause / Play (label = action au clic) ---
  const canPauseResume = isRunning && !isQuizEnded; // pas avant départ, ni après fin
  const showPlayLabel = !isRunning || isPaused || isQuizEnded;
  const pauseBtnLabel = showPlayLabel ? "Play" : "Pause";
  const pauseCursor = canPauseResume ? "pointer" : "not-allowed";
  const pauseBtnTitle = canPauseResume
    ? isPaused
      ? "Lancer la lecture (Play)"
      : "Mettre en pause"
    : "Disponible après le démarrage du quiz";
  const PAUSE_BTN_WIDTH = 120;
  const pauseBtnBg = showPlayLabel ? "#dfd6ff" : "#FECACA";

  const canSeekNav = isPaused && quizMarkers.length > 0 && !isBuzzerMode;

  const pauseNavInfo = useMemo(() => {
    if (!isRunning || !isPaused) return null;
    const times = sortedQuestionTimes(plannedTimes);
    const qIdx = currentQuestionIndex(elapsedSec, times);
    const qNum = qIdx >= 0 ? qIdx + 1 : 0;
    const roundPart = `Manche ${currentRoundNumber}`;
    const qPart = times.length
      ? ` · Question ${qNum || "—"}/${times.length}`
      : "";
    return {
      label: `PAUSE · ${roundPart}${qPart} · ${formatHMS(elapsedSec)}`,
    };
  }, [isRunning, isPaused, plannedTimes, elapsedSec, currentRoundNumber]);

  // ===== Rangs (égalité) pour l'affichage des médailles et du rang (sans toucher l'ordre du tableau)
  const rankingForAdmin = useMemo(() => {
    // On calcule un classement "virtuel" trié par score puis alpha,
    // puis on assigne un _rank avec égalités (règle compétition).
    const rows = (players || [])
      .filter((p) => !p?.isKicked)
      .map((p) => ({
        id: p.id,
        score: Number(p.score || 0),
        _nameKey: normKey(p.name || ""), // réutilise ton helper
      }));

    rows.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score; // score desc
      return a._nameKey.localeCompare(b._nameKey);        // alpha
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
        p._rank = lastRank;    // égalité → même rang
      } else {
        p._rank = i + 1;       // rang = position (1-based)
        lastScore = sc;
        lastRank = p._rank;
      }
    });

    // Map id → _rank pour lookup rapide pendant le rendu
    return new Map(rows.map((r) => [r.id, r._rank]));
  }, [players]);

  // Tri des équipes : OK → Refusé → Kické, puis alphabétique dans chaque groupe
  // Avec filtrage selon showRejected et showKicked
  const sortedTeams = useMemo(() => {
    const getStatusPriority = (t) => {
      if (t.isKicked) return 2; // Kické en dernier
      if (t.nameStatus === "rejected") return 1; // Refusé au milieu
      return 0; // OK en premier
    };

    // Filtrer selon les préférences d'affichage
    const filtered = teams.filter((t) => {
      if (t.isKicked && !showKicked) return false;
      if (t.nameStatus === "rejected" && !showRejected) return false;
      return true;
    });

    return filtered.sort((a, b) => {
      // D'abord par statut
      const statusA = getStatusPriority(a);
      const statusB = getStatusPriority(b);
      if (statusA !== statusB) {
        return statusA - statusB;
      }

      // Puis par ordre alphabétique (nom normalisé)
      const nameA = normalizeNameAlpha(a.name || "");
      const nameB = normalizeNameAlpha(b.name || "");
      return nameA.localeCompare(nameB, "fr", { sensitivity: "base" });
    });
  }, [teams, showRejected, showKicked]);

  // Tri des joueurs : OK → Refusé → Kické, puis alphabétique dans chaque groupe
  // Avec filtrage selon showRejected et showKicked
  // IMPORTANT: Filtrer les joueurs qui n'ont pas d'équipe (ils ne doivent pas apparaître dans les scores)
  const sortedPlayers = useMemo(() => {
    const getStatusPriority = (p) => {
      if (p.isKicked) return 2; // Kické en dernier
      if (p.nameStatus === "rejected") return 1; // Refusé au milieu
      return 0; // OK en premier
    };

    // Filtrer : seulement les joueurs qui ont une équipe
    // Filtrer selon les préférences d'affichage
    const filtered = players.filter((p) => {
      // Un joueur doit avoir une équipe pour apparaître
      if (!p.teamId) return false;
      
      if (p.isKicked && !showKicked) return false;
      if (p.nameStatus === "rejected" && !showRejected) return false;
      return true;
    });

    return filtered.sort((a, b) => {
      // D'abord par statut
      const statusA = getStatusPriority(a);
      const statusB = getStatusPriority(b);
      if (statusA !== statusB) {
        return statusA - statusB;
      }

      // Puis par ordre alphabétique (nom normalisé)
      const nameA = normalizeNameAlpha(a.name || "");
      const nameB = normalizeNameAlpha(b.name || "");
      return nameA.localeCompare(nameB, "fr", { sensitivity: "base" });
    });
  }, [players, showRejected, showKicked]);

  // Helper : obtenir les membres d'une équipe
  const getTeamMembers = (teamId) => {
    return players.filter((p) => p.teamId === teamId);
  };

  // === Actions Quiz (créer / activer / dupliquer / supprimer) ===
  const handleCreateQuiz = async () => {
    try {
      const defaultName = "Nouveau quiz";
      const name = window.prompt("Nom du nouveau quiz :", defaultName);
      if (!name) return;

      const baseKey =
        normKey(name)
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "quiz";
      const existing = new Set((quizzes || []).map((q) => q.key));
      let key = baseKey;
      let i = 2;
      while (existing.has(key)) {
        key = `${baseKey}-${i++}`;
      }

      const newQuiz = { key, name };
      const nextQuizzes = [...(quizzes || []), newQuiz];
      await setDoc(
        doc(db, "quiz", "config"),
        { quizzes: nextQuizzes },
        { merge: true }
      );

      setSelectedQuizKey(key);
      setAdminTab(`quiz:${key}`);
    } catch (e) {
      console.error("handleCreateQuiz error:", e);
      alert("Échec de la création du quiz : " + (e?.message || e));
    }
  };

  const handleSetActiveQuiz = async (quizKey) => {
    try {
      if (!canChangeActiveQuiz) return;
      if (!quizKey || quizKey === activeQuizKey) return;
      await setDoc(
        doc(db, "quiz", "config"),
        { activeQuizKey: quizKey },
        { merge: true }
      );
    } catch (e) {
      console.error("handleSetActiveQuiz error:", e);
      alert("Échec du changement de quiz actif : " + (e?.message || e));
    }
  };

  const handleDuplicateQuiz = async (sourceKey) => {
    try {
      if (!sourceKey) return;
      
      // Empêcher la duplication du quiz actif pendant qu'il est en cours
      if (sourceKey === activeQuizKey && isRunning) {
        alert("Impossible de dupliquer le quiz actif pendant qu'il est en cours. Arrête d'abord le quiz.");
        return;
      }
      
      const src = (quizzes || []).find((q) => q.key === sourceKey);
      const baseName = src?.name || "Quiz sans nom";
      const name = window.prompt("Nom du nouveau quiz :", `${baseName} (copie)`);
      if (!name) return;

      const baseKey =
        normKey(name)
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "quiz";
      const existing = new Set((quizzes || []).map((q) => q.key));
      let key = baseKey;
      let i = 2;
      while (existing.has(key)) {
        key = `${baseKey}-${i++}`;
      }

      const newQuiz = { key, name };
      const nextQuizzes = [...(quizzes || []), newQuiz];
      await setDoc(
        doc(db, "quiz", "config"),
        { quizzes: nextQuizzes },
        { merge: true }
      );

      // Dupliquer les questions du quiz source vers le nouveau quiz
      const colRef = collection(db, "LesQuestions");
      const snap = await getDocs(
        query(colRef, where("quizKey", "==", sourceKey))
      );
      for (const d of snap.docs) {
        const data = d.data() || {};
        const { id: _ignore, ...rest } = data;
        await addDoc(colRef, {
          ...rest,
          quizKey: key,
          createdAt: new Date(),
        });
      }

      setSelectedQuizKey(key);
      setAdminTab(`quiz:${key}`);
    } catch (e) {
      console.error("handleDuplicateQuiz error:", e);
      alert("Échec de la duplication du quiz : " + (e?.message || e));
    }
  };

  const handleEditQuizName = async (quizKey) => {
    try {
      if (!quizKey) return;
      const all = quizzes || [];
      const src = all.find((q) => q.key === quizKey);
      if (!src) {
        alert("Quiz introuvable.");
        return;
      }

      const currentName = src.name || "Quiz sans nom";
      const newName = window.prompt("Nouveau nom du quiz :", currentName);
      if (!newName || newName.trim() === "") {
        return; // Annulation ou nom vide
      }

      const trimmedName = newName.trim();
      if (trimmedName === currentName) {
        return; // Pas de changement
      }

      // Mettre à jour le nom dans le tableau des quiz
      const nextQuizzes = all.map((q) =>
        q.key === quizKey ? { ...q, name: trimmedName } : q
      );
      await setDoc(
        doc(db, "quiz", "config"),
        { quizzes: nextQuizzes },
        { merge: true }
      );

      setNotice(`Nom du quiz modifié : « ${trimmedName} »`);
    } catch (e) {
      console.error("handleEditQuizName error:", e);
      alert("Échec de la modification du nom : " + (e?.message || e));
    }
  };

  const handleDeleteQuiz = async (quizKey) => {
    try {
      if (!quizKey) return;
      const all = quizzes || [];
      if (all.length <= 1) {
        alert("Impossible de supprimer le dernier quiz restant.");
        return;
      }
      if (quizKey === activeQuizKey && isRunning) {
        alert("Impossible de supprimer le quiz actif pendant qu'il est en cours. Arrête d'abord le quiz.");
        return;
      }
      if (quizKey === activeQuizKey) {
        alert("Impossible de supprimer le quiz actif. Active d'abord un autre quiz.");
        return;
      }

      const src = all.find((q) => q.key === quizKey);
      const label = src?.name || quizKey;
      const ok = window.confirm(
        `Supprimer le quiz « ${label} » et toutes ses questions ?`
      );
      if (!ok) return;

      // Supprimer les questions de ce quiz
      const colRef = collection(db, "LesQuestions");
      const snap = await getDocs(
        query(colRef, where("quizKey", "==", quizKey))
      );
      for (const d of snap.docs) {
        await deleteDoc(doc(colRef, d.id));
      }

      // Mettre à jour la liste des quiz
      const nextQuizzes = all.filter((q) => q.key !== quizKey);
      await setDoc(
        doc(db, "quiz", "config"),
        { quizzes: nextQuizzes },
        { merge: true }
      );

      if (selectedQuizKey === quizKey) {
        const fallback =
          (activeQuizKey &&
            nextQuizzes.some((q) => q.key === activeQuizKey) &&
            activeQuizKey) ||
          (nextQuizzes[0] && nextQuizzes[0].key) ||
          null;
        if (fallback) {
          setSelectedQuizKey(fallback);
          setAdminTab(`quiz:${fallback}`);
        } else {
          setSelectedQuizKey(null);
          setAdminTab("players");
        }
      }
    } catch (e) {
      console.error("handleDeleteQuiz error:", e);
      alert("Échec de la suppression du quiz : " + (e?.message || e));
    }
  };

  /* --- Tableau Questions (mémo) --- */
  const table = useMemo(() => {
    if (loading) return <p>Chargement…</p>;
    if (!items.length) return <p>Aucune question.</p>;

    return (
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead style={{ background: "#2c5d8bff", color: "white" }}>
            <tr>
              <th style={{ width: 110, textAlign: "left", padding: "10px" }}>Ordre</th>
              <th style={{ width: "20%", textAlign: "left", padding: "10px" }}>Question</th>
              <th style={{ width: "12%", textAlign: "left", padding: "10px" }}>Image question</th>
              <th style={{ width: "30%", textAlign: "left", padding: "10px" }}>Réponses acceptées</th>
              <th style={{ width: "8%", textAlign: "left", padding: "10px" }}>TimeCode</th>
              <th style={{ width: "8%", textAlign: "left", padding: "10px" }}>TimeMusic</th>
              <th style={{ width: "12%", textAlign: "left", padding: "10px" }}>Image réponse</th>
              <th style={{ width: 180, padding: "10px" }}>Actions</th>

            </tr>
          </thead>

          <tbody>
            {items.map((it, i) => {
              const answersCsv = it.answersCsv ?? toCSV(it.answers || []);
              const qType = getQuestionType(it);
              const qcmOpts = normalizeQcmOptions(it.qcmOptions);
              const qcmCorrect = getQcmCorrectIndex(it);
              const timecodeStr =
                typeof it.timecodeStr === "string"
                  ? it.timecodeStr
                  : typeof it.timecodeSec === "number"
                    ? formatHMS(it.timecodeSec)
                    : typeof it.timecode === "number"
                      ? formatHMS(Math.round(it.timecode * 60))
                      : "";
              const timeMusicStr =
                typeof it.timeMusicStr === "string"
                  ? it.timeMusicStr
                  : typeof it.timeMusicSec === "number"
                    ? formatHMS(it.timeMusicSec)
                    : "";

              // Couleur de fond par manche
              const tSec = getTimeSec(it);
              let rowBg = undefined;
              if (Number.isFinite(tSec) && !(Number.isFinite(quizEndSec) && tSec >= quizEndSec)) {
                let rIdx = -1;
                for (let k = 0; k < roundOffsetsSec.length; k++) {
                  const v = roundOffsetsSec[k];
                  if (Number.isFinite(v) && tSec >= v) rIdx = k;
                }
                const base = roundColors[rIdx] || null;
                rowBg = base ? withAlpha(base, ROUND_BG_ALPHA) : undefined;
              }

              return (
                <tr key={it.id} style={{ borderTop: "1px solid #333", background: rowBg }}>
                  <td style={{ verticalAlign: "top", padding: "12px", whiteSpace: "nowrap" }}>
                    <button onClick={() => swapOrder(i, i - 1)} disabled={i === 0}>↑</button>{" "}
                    <button onClick={() => swapOrder(i, i + 1)} disabled={i === items.length - 1}>↓</button>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>({it.order ?? "—"})</div>
                  </td>

                  <td style={{ width: "20%", verticalAlign: "top", padding: "12px" }}>
                    <textarea
                      rows={2}
                      value={it.text || ""}
                      onChange={(e) => handleFieldChange(it.id, "text", e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0", resize: "vertical" }}
                    />
                  </td>

                  {/* Image question */}
                  <td style={{ width: "12%", verticalAlign: "top", padding: "12px" }}>
                    {it.imageQuestionUrl ? (
                      <div style={{ position: "relative" }}>
                        <img
                          src={it.imageQuestionUrl}
                          alt="image question"
                          style={{ width: "100%", maxHeight: 120, objectFit: "contain", borderRadius: 6, border: "1px solid #2a2a2a" }}
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveImageQuestion(it.id)}
                          disabled={it._imageUploading}
                          title="Supprimer l’image question (valider avec « Modifier »)"
                          aria-label="Supprimer l’image question"
                          style={{
                            position: "absolute",
                            top: 6,
                            right: 6,
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            border: "1px solid #2a2a2a",
                            background: "#111",
                            color: "#eee",
                            fontWeight: 800,
                            lineHeight: "20px",
                            textAlign: "center",
                            cursor: it._imageUploading ? "not-allowed" : "pointer",
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>Pas d’image</div>
                    )}

                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageChange(it.id, e.target.files?.[0] || null, "imageQuestionUrl")}
                      disabled={it._imageUploading}
                      style={{ width: "100%", boxSizing: "border-box", margin: "6px 0 0 0" }}
                    />
                    {it.imageQuestionUrl && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={it.imageQuestionLarge || false}
                          onChange={(e) => handleFieldChange(it.id, "imageQuestionLarge", e.target.checked)}
                        />
                        <span>Afficher en grand</span>
                      </label>
                    )}
                  </td>

                  <td style={{ width: "30%", verticalAlign: "top", padding: "12px" }}>
                    <label style={{ fontSize: 12, opacity: 0.9, display: "block", marginBottom: 8 }}>
                      Type de réponse
                      <select
                        value={qType}
                        onChange={(e) => handleFieldChange(it.id, "questionType", e.target.value)}
                        style={{ width: "100%", boxSizing: "border-box", marginTop: 4 }}
                      >
                        <option value={QUESTION_TYPE_OPEN}>Réponse libre (texte)</option>
                        <option value={QUESTION_TYPE_QCM}>QCM (4 propositions)</option>
                      </select>
                    </label>

                    {qType === QUESTION_TYPE_QCM ? (
                      <div style={{ display: "grid", gap: 8 }}>
                        {qcmOpts.map((opt, optIdx) => (
                          <label
                            key={optIdx}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 12,
                            }}
                          >
                            <input
                              type="radio"
                              name={`qcm-correct-${it.id}`}
                              checked={qcmCorrect === optIdx}
                              onChange={() => handleFieldChange(it.id, "qcmCorrectIndex", optIdx)}
                              title="Bonne réponse"
                            />
                            <input
                              type="text"
                              value={opt}
                              onChange={(e) => handleFieldChange(it.id, `qcmOption_${optIdx}`, e.target.value)}
                              placeholder={`Proposition ${optIdx + 1}`}
                              style={{ flex: 1, boxSizing: "border-box", padding: "4px 6px" }}
                            />
                          </label>
                        ))}
                        <div style={{ fontSize: 11, opacity: 0.65 }}>
                          Coche la bonne réponse (radio).
                        </div>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={answersCsv}
                          onChange={(e) => handleFieldChange(it.id, "answersCsv", e.target.value)}
                          placeholder="ex: Goku, Son Goku"
                          style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                        />
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Sépare par des virgules</div>
                        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                          <label style={{ fontSize: 12, opacity: 0.9 }}>
                            Mode d’appariement
                            <select
                              value={it.matchingMode || "strict"}
                              onChange={(e) => handleFieldChange(it.id, "matchingMode", e.target.value)}
                              style={{ width: "100%", boxSizing: "border-box", marginTop: 4 }}
                            >
                              <option value="strict">strict (exact après normalisation)</option>
                              <option value="relaxed">relaxed (tolérance relative)</option>
                              <option value="numeric">numeric (strict numérique)</option>
                            </select>
                          </label>
                        </div>
                      </>
                    )}
                  </td>

                  <td style={{ width: "8%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={timecodeStr}
                      readOnly
                      disabled
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0", opacity: 0.7 }}
                      title="Calculé automatiquement d'après l’ordre et TimeMusic"
                    />
                  </td>

                  <td style={{ width: "8%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={timeMusicStr}
                      onChange={(e) => handleFieldChange(it.id, "timeMusicStr", e.target.value)}
                      placeholder="ex: 00:00:35"
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                    {!it.timeMusicStr && typeof it.timeMusicSec !== "number" && (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        Défaut {defaultTimeMusicSec}s (min {TIME_MUSIC_MIN_SEC}s)
                      </div>
                    )}
                  </td>

                  {/* Image réponse (fallback lecture ancien imageUrl) */}
                  <td style={{ width: "12%", verticalAlign: "top", padding: "12px" }}>
                    {(it.imageReponseUrl || it.imageUrl) ? (
                      <div style={{ position: "relative" }}>
                        <img
                          src={it.imageReponseUrl || it.imageUrl}
                          alt="image réponse"
                          style={{ width: "100%", maxHeight: 120, objectFit: "contain", borderRadius: 6, border: "1px solid #2a2a2a" }}
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveImageReponse(it.id)}
                          disabled={it._imageUploading}
                          title="Supprimer l’image réponse (valider avec « Modifier »)"
                          aria-label="Supprimer l’image réponse"
                          style={{
                            position: "absolute",
                            top: 6,
                            right: 6,
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            border: "1px solid #2a2a2a",
                            background: "#111",
                            color: "#eee",
                            fontWeight: 800,
                            lineHeight: "20px",
                            textAlign: "center",
                            cursor: it._imageUploading ? "not-allowed" : "pointer",
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>Pas d’image</div>
                    )}

                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageChange(it.id, e.target.files?.[0] || null, "imageReponseUrl")}
                      disabled={it._imageUploading}
                      style={{ width: "100%", boxSizing: "border-box", margin: "6px 0 0 0" }}
                    />
                  </td>

                  <td style={{ textAlign: "center", whiteSpace: "nowrap", verticalAlign: "top", padding: "12px" }}>
                    <button onClick={() => saveOne(it)} disabled={savingId === it.id}>
                      {savingId === it.id ? "Modification…" : "Modifier"}
                    </button>{" "}
                    {savedRowId === it.id && (
                      <span style={{ marginLeft: 8, color: "lime" }}>Modifié ✔</span>
                    )}{" "}
                    <button onClick={() => removeOne(it.id)} style={{ color: "crimson" }}>
                      Supprimer
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [items, loading, savingId, savedRowId, roundOffsetsSec, quizEndSec]);


  // ===================== PARTIE 6.2/6 — AdminInner : Rendu =====================
  return (
    <div style={{ background: "#0a0a1a", color: "white", minHeight: "100vh", padding: 20 }}>
      {/* Header */}
      <div
        style={{
          margin: "0 -20px 16px",
          background: "#2c5d8bff",
          color: "white",
          padding: "12px 20px",
        }}
      >
        <h1 style={{ margin: 0 }}>Admin</h1>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
      {/* Ligne 1 — transport + EleyBuzz + chrono */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={startQuizFromBeginning}
          disabled={isRunning || isQuizEnded || mainBtnBusy || isBuzzerMode}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            width: 180,
            background: mainButtonColor,
            color: "#000",
            fontWeight: 600,
            cursor:
              isRunning || isQuizEnded || isBuzzerMode
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
            textAlign: "center",
            whiteSpace: "nowrap",
            opacity: isBuzzerMode ? 0.6 : 1,
          }}
          title={
            isBuzzerMode
              ? "Indisponible en mode EleyBuzz"
              : quizInProgress
                ? `Manche ${currentRoundNumber} en cours`
                : isQuizEnded
                  ? "Quiz terminé"
                  : streamDeckRemoteEnabled
                    ? "Démarrer le quiz depuis le début (V)"
                    : "Démarrer le quiz depuis le début"
          }
        >
          {mainButtonLabel}
        </button>

        <button
          onClick={() => (canPauseResume && !isBuzzerMode ? handlePauseResume() : null)}
          disabled={!canPauseResume || isBuzzerMode}
          aria-disabled={(!canPauseResume || isBuzzerMode) ? "true" : "false"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: PAUSE_BTN_WIDTH,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: pauseBtnBg,
            color: "#000",
            fontWeight: 600,
            cursor: (canPauseResume && !isBuzzerMode) ? pauseCursor : "not-allowed",
            opacity: (!canPauseResume || isBuzzerMode) ? 0.6 : 1,
            whiteSpace: "nowrap",
            textAlign: "center",
            transition: "background 160ms ease",
          }}
          title={
            isBuzzerMode
              ? "Indisponible en mode EleyBuzz"
              : streamDeckRemoteEnabled
                ? `${pauseBtnTitle} (Espace)`
                : pauseBtnTitle
          }
        >
          {pauseBtnLabel}
        </button>

        <button
          onClick={handleBack}
          disabled={!canSeekNav}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: backBtnBg,
            color: "#000",
            fontWeight: 600,
            minWidth: 100,
            cursor: !canSeekNav ? "not-allowed" : "pointer",
            transition: "background 160ms ease",
            opacity: isBuzzerMode ? 0.6 : 1,
          }}
          title={
            isBuzzerMode
              ? "Indisponible en mode EleyBuzz"
              : !isPaused
                ? "Disponible uniquement en pause"
                : streamDeckRemoteEnabled
                  ? `${backBtnLabel} — seek sans play (Shift+B)`
                  : `${backBtnLabel} — seek sans play`
          }
        >
          {backBtnLabel}
        </button>

        <button
          onClick={handleNext}
          disabled={!canSeekNav || !transportUi?.nextTarget}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: nextBtnBg,
            color: "#000",
            fontWeight: 600,
            minWidth: 100,
            cursor: !canSeekNav || !transportUi?.nextTarget ? "not-allowed" : "pointer",
            transition: "background 160ms ease",
            opacity: isBuzzerMode ? 0.6 : 1,
          }}
          title={
            isBuzzerMode
              ? "Indisponible en mode EleyBuzz"
              : !isPaused
                ? "Disponible uniquement en pause"
                : !transportUi?.nextTarget
                  ? "Plus de marqueur suivant"
                  : streamDeckRemoteEnabled
                    ? `${nextBtnLabel} — seek sans play (Shift+N)`
                    : `${nextBtnLabel} — seek sans play`
          }
        >
          {nextBtnLabel}
        </button>

        <button
          onClick={resetQuizOnly}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#e5e7eb",
            color: "#000",
            fontWeight: 600,
            cursor: "pointer",
          }}
          title="Réinitialiser le quiz (garde les joueurs et leurs scores)"
        >
          Reset Quiz
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: isBuzzerMode ? "#1f2937" : "#111", borderRadius: 8, border: "1px solid #2a2a2a" }}>
          <button
            onClick={toggleEleyBuzzMode}
            disabled={!canActivateEleyBuzz && !canDeactivateEleyBuzz}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #2a2a2a",
              background: isBuzzerMode ? "#dc2626" : "#16a34a",
              color: "#fff",
              fontWeight: 600,
              cursor: (!canActivateEleyBuzz && !canDeactivateEleyBuzz) ? "not-allowed" : "pointer",
              opacity: (!canActivateEleyBuzz && !canDeactivateEleyBuzz) ? 0.6 : 1,
            }}
            title={isBuzzerMode ? "Pavé num. 0 : désactiver EleyBuzz" : "Pavé num. 0 : activer EleyBuzz"}
          >
            {isBuzzerMode ? "STOP EleyBuzz (0)" : "Go EleyBuzz (0)"}
          </button>

          {isBuzzerMode && (
            <>
              <button
                onClick={toggleBuzzerState}
                disabled={buzzerState === "locked"}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid #2a2a2a",
                  background: buzzerState === "open" ? "#facc15" : "#6b7280",
                  color: "#000",
                  fontWeight: 600,
                  cursor: buzzerState === "locked" ? "not-allowed" : "pointer",
                  opacity: buzzerState === "locked" ? 0.6 : 1,
                }}
                title="Pavé num. 1 : ouvrir / fermer le buzzer"
              >
                {buzzerState === "open"
                  ? "Buzzer OUVERT (1)"
                  : buzzerState === "locked"
                    ? "Buzzer VERROUILLÉ"
                    : "Buzzer FERMÉ (1)"}
              </button>

              <button
                onClick={handleRecoverEleyBuzz}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid #2a2a2a",
                  background: "#38bdf8",
                  color: "#0f172a",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
                title="Débloque tous les joueurs (bleus), rouvre le buzzer et force un refresh des pages Player figées"
              >
                Reset buzzers
              </button>

              {buzzerState === "locked" && buzzerWinnerName && (
                <span style={{ color: "#facc15", fontWeight: 700 }}>
                  {buzzerWinnerName} a buzzé !
                </span>
              )}

              {buzzerState === "locked" && firstPlayerId && (
                <>
                  <button
                    onClick={handleBuzzerCorrect}
                    disabled={!!buzzerMessage}
                    onMouseDown={(e) => {
                      e.currentTarget.style.transform = "scale(0.95)";
                      e.currentTarget.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.2)";
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                    onTouchStart={(e) => {
                      e.currentTarget.style.transform = "scale(0.95)";
                      e.currentTarget.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.2)";
                    }}
                    onTouchEnd={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid #2a2a2a",
                      background: "#16a34a",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: buzzerMessage ? "not-allowed" : "pointer",
                      opacity: buzzerMessage ? 0.6 : 1,
                      transition: "transform 100ms ease, box-shadow 100ms ease",
                      userSelect: "none",
                    }}
                    title={buzzerMessage ? "En attente de la fin du message" : "Pavé num. 2 : bonne réponse"}
                  >
                    ✓ Correct (2)
                  </button>
                  <button
                    onClick={handleBuzzerWrong}
                    disabled={!!buzzerMessage}
                    onMouseDown={(e) => {
                      e.currentTarget.style.transform = "scale(0.95)";
                      e.currentTarget.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.2)";
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                    onTouchStart={(e) => {
                      e.currentTarget.style.transform = "scale(0.95)";
                      e.currentTarget.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.2)";
                    }}
                    onTouchEnd={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid #2a2a2a",
                      background: "#dc2626",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: buzzerMessage ? "not-allowed" : "pointer",
                      opacity: buzzerMessage ? 0.6 : 1,
                      transition: "transform 100ms ease, box-shadow 100ms ease",
                      userSelect: "none",
                    }}
                    title={buzzerMessage ? "En attente de la fin du message" : "Pavé num. 3 : mauvaise réponse"}
                  >
                    ✗ Faux (3)
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {/* Points EleyBuzz configurables */}
        {isBuzzerMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600 }}>Points EleyBuzz:</label>
            <input
              type="number"
              value={buzzerPoints}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 0) {
                  setBuzzerPoints(val);
                  updateDoc(doc(db, "quiz", "state"), { buzzerPoints: val }).catch(console.error);
                }
              }}
              min="0"
              style={{
                width: 60,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: "#111",
                color: "#fff",
                fontFamily: "monospace",
              }}
            />
          </div>
        )}

        <div
          style={{
            padding: "6px 10px",
            background: "#111",
            borderRadius: 8,
            fontFamily: "monospace",
            letterSpacing: 1,
            border: "1px solid #2a2a2a",
          }}
        >
          ⏱ {formatHMS(elapsedSec)}
        </div>

        {/* Info manche actuelle / suivante */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: "6px 10px",
            borderRadius: 8,
            background: "#020617",
            border: "1px solid #1f2937",
            minWidth: 170,
            fontSize: 12,
          }}
        >
          <div>
            Manche actuelle : <b>M{currentRoundNumber}</b>
          </div>
          <div style={{ opacity: 0.85 }}>
            Manche suivante :{" "}
            {nextRoundIndex != null ? <b>M{nextRoundIndex + 1}</b> : <span>—</span>}
          </div>
          {atRoundBoundary && (
            <div style={{ marginTop: 2, color: "#facc15" }}>
              Fin de manche atteinte
            </div>
          )}
        </div>

        <button
          onClick={resetQuizAndPlayers}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#e5e7eb",
            color: "#000",
            fontWeight: 600,
            cursor: "pointer",
            marginLeft: "auto",
          }}
          title="Tout remettre à zéro (quiz/state, joueurs, answers/*)"
        >
          Réinitialiser
        </button>
      </div>

      {/* Ligne 2 — télécommande Stream Deck + notices */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: streamDeckRemoteEnabled ? "10px 12px" : 0,
          borderRadius: 8,
          background: streamDeckRemoteEnabled ? "#0f172a" : "transparent",
          border: streamDeckRemoteEnabled ? "1px solid #1e293b" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            minHeight: 36,
          }}
        >
          <button
            onClick={toggleStreamDeckRemote}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #2a2a2a",
              background: streamDeckRemoteEnabled ? "#16a34a" : "#374151",
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: 13,
            }}
            title="API Stream Deck (HTTP). Les raccourcis clavier Admin sont coupés tant que c’est ON (évite le double avec Studio One)."
          >
            {streamDeckRemoteEnabled ? "Télécommande ON" : "Télécommande OFF"}
          </button>

          {pauseNavInfo ? (
            <span
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                background: "#1f2937",
                border: "1px solid #f59e0b",
                color: "#fde68a",
                fontWeight: 700,
                fontSize: 13,
                whiteSpace: "nowrap",
              }}
            >
              {pauseNavInfo.label}
            </span>
          ) : null}

          {notice ? (
            <div
              style={{
                padding: "6px 10px",
                background: "#1f2937",
                border: "1px solid #374151",
                borderRadius: 8,
                color: "#fff",
                fontSize: 13,
              }}
            >
              {notice}
            </div>
          ) : null}
        </div>

        {streamDeckRemoteEnabled && streamDeckSecret ? (
          <StreamDeckRemotePanel secret={streamDeckSecret} setNotice={setNotice} />
        ) : null}
      </div>

      {/* Ligne 3 — offsets manches + fin de quiz */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {/* M1..M8 avec couleurs */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <label key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 6,
                  background: Number.isFinite(roundOffsetsSec[i])
                    ? roundColors[i] || "#444"
                    : "#3a3a3a",
                  color: Number.isFinite(roundOffsetsSec[i]) ? "#111" : "#aaa",
                  fontWeight: 700,
                  opacity: Number.isFinite(roundOffsetsSec[i]) ? 1 : 0.6,
                }}
              >
                M{i + 1}
              </span>
              <input
                type="text"
                value={roundOffsetsStr[i]}
                placeholder={
                  typeof roundOffsetsSec[i] === "number" ? "hh:mm:ss" : "désactivée"
                }
                onChange={(e) => handleRoundOffsetChange(i, e.target.value)}
                onBlur={() => saveRoundOffsets(roundOffsetsStr)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRoundOffsets(roundOffsetsStr);
                }}
                disabled={timeConfigLocked}
                style={{
                  width: 90,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: "1px solid #2a2a2a",
                  background: "#111",
                  color: "#fff",
                  fontFamily: "monospace",
                  opacity: timeConfigLocked
                    ? 0.5
                    : typeof roundOffsetsSec[i] === "number"
                      ? 1
                      : 0.75,
                }}
                title={
                  timeConfigLocked
                    ? "Réglages des manches verrouillés pendant un quiz en cours"
                    : "Heure de début de la manche"
                }
              />

            </label>
          ))}
        </div>

        {/* Fin du quiz */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700 }}>Fin du quiz (hh:mm:ss)</span>
            <input
              type="text"
              value={endOffsetStr}
              onChange={(e) => setEndOffsetStr(e.target.value)}
              onBlur={() => saveEndOffset(endOffsetStr)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEndOffset(endOffsetStr);
              }}
              placeholder="ex: 01:58:00"
              disabled={timeConfigLocked}
              style={{
                width: 110,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: "#111",
                color: "#fff",
                fontFamily: "monospace",
                opacity: timeConfigLocked ? 0.5 : 1,
              }}
              title={
                timeConfigLocked
                  ? "Fin de quiz verrouillée pendant un quiz en cours"
                  : "Point de fin global (utilisé pour la révélation & le décompte final)"
              }
            />
          </label>
        </div>
      </div>
      </div>

      {needsOrderInit && (
        <div style={{ background: "#222", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <b>Initialisation de l’ordre requise :</b> certaines questions n’ont pas encore
          de champ <code>order</code>.
          <div style={{ marginTop: 8 }}>
            <button onClick={initOrder}>Initialiser l’ordre (une fois)</button>
          </div>
        </div>
      )}

      {/* Bouton global : créer un quiz */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <button
          type="button"
          onClick={handleCreateQuiz}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid #1f2a2a",
            background: "#2c5d8bff",
            color: "#e6eeff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Créer un quiz
        </button>

      </div>

      {/* Barre d’onglets */}
      <div
        style={{
          marginTop: 8,
          borderBottom: "1px solid #1f2a44",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => setAdminTab("players")}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #1f2a44",
            background: adminTab === "players" ? "#c97326" : "transparent", // Orange terne pour différencier des onglets quiz
            color: "#e6eeff",
            cursor: "pointer",
            fontWeight: adminTab === "players" ? 700 : 500,
          }}
        >
          Joueurs/Équipes
        </button>


        {quizTabsOrdered.map((q) => {
          const tabKey = `quiz:${q.key}`;
          const isTabSelected = adminTab === tabKey;
          const isQuizActive = q.key === activeQuizKey;
          // Pendant un quiz en cours, on interdit d’ouvrir un autre quiz que le quiz actif
          const canOpenThisQuiz =
            !isRunning || !activeQuizKey || q.key === activeQuizKey;

          return (
            <button
              key={q.key}
              type="button"
              onClick={() => {
                if (!canOpenThisQuiz) return;
                setSelectedQuizKey(q.key);
                setAdminTab(tabKey);
              }}
              disabled={!canOpenThisQuiz}
              aria-disabled={!canOpenThisQuiz ? "true" : "false"}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #1f2a44",
                background: isTabSelected ? "#2c5d8bff" : "transparent",
                color: "#e6eeff",
                cursor: canOpenThisQuiz ? "pointer" : "not-allowed",
                fontWeight: isTabSelected ? 700 : 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                opacity: canOpenThisQuiz ? 1 : 0.6,
              }}
              title={
                !canOpenThisQuiz
                  ? "Onglet verrouillé pendant un quiz en cours"
                  : undefined
              }
            >
              <span>{q.name}</span>
              {isQuizActive && <span style={{ color: "#22c55e" }}>✅</span>}
            </button>
          );
        })}

      </div>


      {/* Onglet Joueurs */}
      {adminTab === "players" && (
        <div style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Joueurs</h2>
          <div style={{ opacity: 0.9, marginTop: 6, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div>
              Joueurs connectés : <b>{connectedCount}</b>
              {playersLoading && <span style={{ marginLeft: 8, opacity: 0.7 }}>(chargement…)</span>}
            </div>
            <button
              onClick={resetAllScores}
              disabled={!canResetScores}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: "#c4b5fd",
                color: "#111827",
                fontWeight: 600,
                cursor: canResetScores ? "pointer" : "not-allowed",
                opacity: canResetScores ? 1 : 0.6,
              }}
              title={canResetScores ? "Remettre tous les scores (quiz + EleyBuzz) à 0" : "Indisponible pendant qu'un quiz est en cours"}
            >
              Remettre tous les scores à 0
            </button>
            <button
              onClick={showFinalScore}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: "#22c55e",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Fusionne les points ⚡ dans le score joueur (équipes inchangées) et affiche le score final"
            >
              Score final
            </button>
            <button
              onClick={() => setShowRejected(!showRejected)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: showRejected ? "#fde68a" : "#4b5563",
                color: showRejected ? "#111827" : "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
              title={showRejected ? "Masquer les noms refusés" : "Afficher les noms refusés"}
            >
              Noms refusés
            </button>
            <button
              onClick={() => setShowKicked(!showKicked)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: showKicked ? "#fca5a5" : "#4b5563",
                color: showKicked ? "#111827" : "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
              title={showKicked ? "Masquer les joueurs kickés" : "Afficher les joueurs kickés"}
            >
              Joueurs kickés
            </button>
            <button
              onClick={async () => {
                const newView = leaderboardView === "teams" ? "players" : "teams";
                setLeaderboardView(newView);
                // Sauvegarder dans Firestore
                try {
                  await updateDoc(doc(db, "quiz", "config"), {
                    leaderboardView: newView
                  }, { merge: true });
                } catch (e) {
                  console.error("Error saving leaderboardView:", e);
                }
              }}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: leaderboardView === "teams" ? "#3b82f6" : "#8b5cf6",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
              title={`Afficher le classement par ${leaderboardView === "teams" ? "joueurs" : "équipes"} sur Screen`}
            >
              Screen: {leaderboardView === "teams" ? "Équipes" : "Joueurs"}
            </button>
          </div>

          {/* Liste des noms refusés */}
          {globalRejectedNames.length > 0 && (
            <div style={{ marginTop: 16, padding: 12, background: "#1f2937", borderRadius: 8, border: "1px solid #374151" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#fde68a" }}>
                  Noms refusés ({globalRejectedNames.length})
                </h3>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {globalRejectedNames.map((nameNorm, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 8px",
                      background: "#374151",
                      borderRadius: 4,
                      border: "1px solid #4b5563",
                    }}
                  >
                    <span style={{ color: "#e5e7eb", fontSize: 13 }}>{nameNorm}</span>
                    <button
                      onClick={() => removeRejectedName(nameNorm)}
                      style={{
                        padding: "2px 6px",
                        borderRadius: 4,
                        border: "1px solid #6b7280",
                        background: "#dc2626",
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                      title="Retirer ce nom de la liste"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tableau équipes */}
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                tableLayout: "fixed",
                minWidth: 820,
              }}
            >
              <thead>
                <tr style={{ background: "#2c5d8bff" }}>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>Équipes</th>
                  <th style={{ textAlign: "center", padding: "10px 8px", width: 120 }}>Score Équipe Quiz</th>
                  <th style={{ textAlign: "center", padding: "10px 8px", width: 140 }}>Statut</th>
                  <th style={{ textAlign: "left", padding: "10px 8px", width: 360 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedTeams.map((t) => {
                  const status = t.isKicked ? "Kické" : (t.nameStatus === "rejected" ? "Refusé" : "OK");
                  const statusBg = t.isKicked ? "#4b5563" : t.nameStatus === "rejected" ? "#fde68a" : "#86efac";
                  const statusColor = t.isKicked ? "#e5e7eb" : t.nameStatus === "rejected" ? "#111827" : "#064e3b";
                  const members = getTeamMembers(t.id);
                  const isExpanded = expandedTeamIds.has(t.id);

                  return (
                    <Fragment key={t.id}>
                      <tr 
                        style={{ borderTop: "1px solid #1f2a44", cursor: "pointer" }}
                        onClick={() => {
                          const newSet = new Set(expandedTeamIds);
                          if (isExpanded) {
                            newSet.delete(t.id);
                          } else {
                            newSet.add(t.id);
                          }
                          setExpandedTeamIds(newSet);
                        }}
                      >
                        <td style={{ padding: "8px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                            <span
                              title={t.color || ""}
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: 4,
                                background: t.color || "#6b7280",
                                display: "inline-block",
                                border: "1px solid rgba(255,255,255,0.2)",
                                flex: "0 0 auto",
                              }}
                            />
                            <span
                              title={t.name || "(sans nom)"}
                              style={{
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                maxWidth: "100%",
                                display: "block",
                              }}
                            >
                              {t.name || "(sans nom)"} ({members.length} membre{members.length > 1 ? "s" : ""})
                            </span>
                            <span style={{ marginLeft: "auto", opacity: 0.7 }}>
                              {isExpanded ? "▼" : "▶"}
                            </span>
                          </div>
                        </td>

                        <td style={{ padding: "8px", textAlign: "center" }}>
                          {editingScore.playerId === t.id && editingScore.field === "teamQuizScore" ? (
                            <input
                              type="number"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onBlur={() => {
                                if (editingValue !== "") {
                                  saveTeamScore(t.id, "teamQuizScore", editingValue);
                                } else {
                                  setEditingScore({ playerId: null, field: null });
                                  setEditingValue("");
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  if (editingValue !== "") {
                                    saveTeamScore(t.id, "teamQuizScore", editingValue);
                                  }
                                } else if (e.key === "Escape") {
                                  setEditingScore({ playerId: null, field: null });
                                  setEditingValue("");
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                              style={{
                                width: 80,
                                padding: "4px 8px",
                                borderRadius: 4,
                                border: "1px solid #3b82f6",
                                background: "#111",
                                color: "#fff",
                                fontSize: 16,
                                fontWeight: 800,
                                textAlign: "center",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            />
                          ) : (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingScore({ playerId: t.id, field: "teamQuizScore" });
                                setEditingValue(String(Number(t.teamQuizScore || 0)));
                              }}
                              style={{
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 800,
                                letterSpacing: 0.2,
                                cursor: "pointer",
                                padding: "4px 8px",
                                borderRadius: 4,
                                transition: "background 150ms ease",
                                color: t.color || "#e5e7eb",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "rgba(59, 130, 246, 0.2)";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "transparent";
                              }}
                              title="Cliquez pour modifier le score Équipe Quiz"
                            >
                              {Number(t.teamQuizScore || 0)}
                            </span>
                          )}
                        </td>

                        <td style={{ padding: "8px", textAlign: "center" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "4px 8px",
                              borderRadius: 6,
                              background: statusBg,
                              color: statusColor,
                              fontWeight: 700,
                            }}
                          >
                            {status}
                          </span>
                        </td>

                        <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => rejectTeam(t.id, t.name)}
                            disabled={t.isKicked || t.nameStatus === "rejected"}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 6,
                              border: "1px solid #2a2a2a",
                              background: "#fde68a",
                              color: "#111827",
                              fontWeight: 600,
                              marginRight: 8,
                              opacity: t.isKicked || t.nameStatus === "rejected" ? 0.6 : 1,
                              cursor: t.isKicked || t.nameStatus === "rejected" ? "not-allowed" : "pointer",
                            }}
                            title="Refuser ce nom d'équipe"
                          >
                            Refuser
                          </button>

                          {t.isKicked ? (
                            <button
                              onClick={() => unkickTeam(t.id)}
                              style={{
                                marginLeft: 8,
                                padding: "6px 10px",
                                borderRadius: 6,
                                border: "1px solid #2a2a2a",
                                background: "#86efac",
                                color: "#064e3b",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                              title="Réaccepter cette équipe (conserve les scores)"
                            >
                              Réaccepter
                            </button>
                          ) : (
                            <button
                              onClick={() => kickTeam(t.id)}
                              style={{
                                marginLeft: 8,
                                padding: "6px 10px",
                                borderRadius: 6,
                                border: "1px solid #2a2a2a",
                                background: "#fecaca",
                                color: "#111827",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                              title="Retirer cette équipe de la partie (kick tous les membres)"
                            >
                              Kick
                            </button>
                          )}
                        </td>
                      </tr>
                      {/* Menu déroulant avec les membres */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={4} style={{ padding: 0, background: "#1a1f2e" }}>
                            <div style={{ padding: "12px 8px" }}>
                              <div style={{ fontWeight: 600, marginBottom: 8, opacity: 0.9 }}>
                                Membres de l'équipe ({members.length})
                              </div>
                              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                  <tr style={{ background: "#2c5d8bff", opacity: 0.8 }}>
                                    <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 12 }}>Joueur</th>
                                    <th style={{ textAlign: "center", padding: "6px 8px", fontSize: 12, width: 100 }}>Score Quiz</th>
                                    <th style={{ textAlign: "center", padding: "6px 8px", fontSize: 12, width: 100 }}>Score Bonus</th>
                                    <th style={{ textAlign: "center", padding: "6px 8px", fontSize: 12, width: 100 }}>Statut</th>
                                    <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, width: 200 }}>Actions</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {members.map((p) => {
                                    const pStatus = p.isKicked ? "Kické" : (p.nameStatus === "rejected" ? "Refusé" : "OK");
                                    const pStatusBg = p.isKicked ? "#4b5563" : p.nameStatus === "rejected" ? "#fde68a" : "#86efac";
                                    const pStatusColor = p.isKicked ? "#e5e7eb" : p.nameStatus === "rejected" ? "#111827" : "#064e3b";
                                    const isAliased = !!p.nameLocked || p.nameStatus === "locked";
                                    
                                    // Obtenir la couleur : depuis l'équipe si le joueur en a une, sinon depuis le joueur
                                    const playerColor = p.teamId ? t.color : (p.color || "#6b7280");
                                    
                                    return (
                                      <tr key={p.id} style={{ borderTop: "1px solid #1f2a44" }}>
                                        <td style={{ padding: "6px 8px" }}>
                                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span
                                              style={{
                                                width: 12,
                                                height: 12,
                                                borderRadius: 3,
                                                background: playerColor,
                                                display: "inline-block",
                                                border: "1px solid rgba(255,255,255,0.2)",
                                              }}
                                            />
                                            <span style={{ fontSize: 13 }}>{p.name || "(sans nom)"}</span>
                                          </div>
                                        </td>
                                        <td style={{ padding: "6px 8px", textAlign: "center", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                                          {editingScore.playerId === p.id && editingScore.field === "score" ? (
                                            <input
                                              type="number"
                                              value={editingValue}
                                              onChange={(e) => setEditingValue(e.target.value)}
                                              onBlur={() => {
                                                if (editingValue !== "") {
                                                  savePlayerScore(p.id, "score", editingValue);
                                                } else {
                                                  setEditingScore({ playerId: null, field: null });
                                                  setEditingValue("");
                                                }
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                  if (editingValue !== "") {
                                                    savePlayerScore(p.id, "score", editingValue);
                                                  }
                                                } else if (e.key === "Escape") {
                                                  setEditingScore({ playerId: null, field: null });
                                                  setEditingValue("");
                                                }
                                              }}
                                              autoFocus
                                              style={{
                                                width: 60,
                                                padding: "2px 4px",
                                                textAlign: "center",
                                                fontSize: 13,
                                                border: "1px solid #3b82f6",
                                                borderRadius: 4,
                                                background: "#0b1220",
                                                color: "#fff",
                                              }}
                                            />
                                          ) : (
                                            <span
                                              onClick={() => {
                                                setEditingScore({ playerId: p.id, field: "score" });
                                                setEditingValue(String(p.score || 0));
                                              }}
                                              style={{ cursor: "pointer", padding: "2px 4px", borderRadius: 4 }}
                                              title="Cliquer pour modifier"
                                            >
                                              {Number(p.score || 0)}
                                            </span>
                                          )}
                                        </td>
                                        <td style={{ padding: "6px 8px", textAlign: "center", fontSize: 13, fontVariantNumeric: "tabular-nums", color: "#facc15" }}>
                                          {editingScore.playerId === p.id && editingScore.field === "buzzScore" ? (
                                            <input
                                              type="number"
                                              value={editingValue}
                                              onChange={(e) => setEditingValue(e.target.value)}
                                              onBlur={() => {
                                                if (editingValue !== "") {
                                                  savePlayerScore(p.id, "buzzScore", editingValue);
                                                } else {
                                                  setEditingScore({ playerId: null, field: null });
                                                  setEditingValue("");
                                                }
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                  if (editingValue !== "") {
                                                    savePlayerScore(p.id, "buzzScore", editingValue);
                                                  }
                                                } else if (e.key === "Escape") {
                                                  setEditingScore({ playerId: null, field: null });
                                                  setEditingValue("");
                                                }
                                              }}
                                              autoFocus
                                              style={{
                                                width: 60,
                                                padding: "2px 4px",
                                                textAlign: "center",
                                                fontSize: 13,
                                                border: "1px solid #3b82f6",
                                                borderRadius: 4,
                                                background: "#0b1220",
                                                color: "#facc15",
                                              }}
                                            />
                                          ) : (
                                            <span
                                              onClick={() => {
                                                setEditingScore({ playerId: p.id, field: "buzzScore" });
                                                setEditingValue(String(p.buzzScore || 0));
                                              }}
                                              style={{ cursor: "pointer", padding: "2px 4px", borderRadius: 4 }}
                                              title="Cliquer pour modifier"
                                            >
                                              {Number(p.buzzScore || 0)}
                                            </span>
                                          )}
                                        </td>
                                        <td style={{ padding: "6px 8px", textAlign: "center" }}>
                                          <span
                                            style={{
                                              display: "inline-block",
                                              padding: "2px 6px",
                                              borderRadius: 4,
                                              background: pStatusBg,
                                              color: pStatusColor,
                                              fontWeight: 600,
                                              fontSize: 11,
                                            }}
                                          >
                                            {pStatus}
                                          </span>
                                        </td>
                                        <td style={{ padding: "6px 8px" }}>
                                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                            <button
                                              onClick={() => rejectPlayer(p.id, p.name)}
                                              disabled={p.isKicked || p.nameStatus === "rejected"}
                                              style={{
                                                padding: "4px 8px",
                                                borderRadius: 4,
                                                border: "1px solid #2a2a2a",
                                                background: "#fde68a",
                                                color: "#111827",
                                                fontWeight: 600,
                                                fontSize: 11,
                                                opacity: p.isKicked || p.nameStatus === "rejected" ? 0.6 : 1,
                                                cursor: p.isKicked || p.nameStatus === "rejected" ? "not-allowed" : "pointer",
                                              }}
                                              title="Refuser ce nom (le joueur devra en choisir un autre)"
                                            >
                                              Refuser
                                            </button>
                                            {p.isKicked ? (
                                              <button
                                                onClick={() => unkickPlayer(p.id)}
                                                style={{
                                                  padding: "4px 8px",
                                                  borderRadius: 4,
                                                  border: "1px solid #2a2a2a",
                                                  background: "#86efac",
                                                  color: "#064e3b",
                                                  fontWeight: 600,
                                                  fontSize: 11,
                                                  cursor: "pointer",
                                                }}
                                                title="Réaccepter ce joueur (conserve ses scores)"
                                              >
                                                Réaccepter
                                              </button>
                                            ) : (
                                              <button
                                                onClick={() => kickPlayer(p.id)}
                                                style={{
                                                  padding: "4px 8px",
                                                  borderRadius: 4,
                                                  border: "1px solid #2a2a2a",
                                                  background: "#fecaca",
                                                  color: "#111827",
                                                  fontWeight: 600,
                                                  fontSize: 11,
                                                  cursor: "pointer",
                                                }}
                                                title="Retirer ce joueur de la partie"
                                              >
                                                Kick
                                              </button>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                  {members.length === 0 && (
                                    <tr>
                                      <td colSpan={5} style={{ padding: 8, opacity: 0.7, fontSize: 12 }}>
                                        Aucun membre dans cette équipe.
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

                {sortedTeams.length === 0 && !teamsLoading && (
                  <tr>
                    <td colSpan={4} style={{ padding: 12, opacity: 0.7 }}>
                      Aucune équipe pour l'instant.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Onglet Quiz (questions du quiz sélectionné) */}
      {adminTab.startsWith("quiz:") && currentQuiz && (
        <>
          {/* Statut du quiz + actions Dupliquer / Supprimer */}
          <div
            style={{
              marginTop: 16,
              marginBottom: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <button
              type="button"
              disabled={!canChangeActiveQuiz || currentQuiz.key === activeQuizKey}
              onClick={() =>
                currentQuiz.key !== activeQuizKey
                  ? handleSetActiveQuiz(currentQuiz.key)
                  : null
              }
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid #1f2a2a",
                background:
                  currentQuiz.key === activeQuizKey ? "#16a34a" : "#b91c1c",
                color: "#f9fafb",
                fontWeight: 700,
                cursor:
                  !canChangeActiveQuiz || currentQuiz.key === activeQuizKey
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  !canChangeActiveQuiz && currentQuiz.key !== activeQuizKey
                    ? 0.7
                    : 1,
              }}
            >
              {currentQuiz.key === activeQuizKey ? "Quiz actif" : "Quiz inactif"}
            </button>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => handleDuplicateQuiz(currentQuiz.key)}
                disabled={currentQuiz.key === activeQuizKey && isRunning}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #374151",
                  background: currentQuiz.key === activeQuizKey && isRunning ? "#374151" : "#111827",
                  color: currentQuiz.key === activeQuizKey && isRunning ? "#6b7280" : "#e5e7eb",
                  fontWeight: 600,
                  cursor: currentQuiz.key === activeQuizKey && isRunning ? "not-allowed" : "pointer",
                  opacity: currentQuiz.key === activeQuizKey && isRunning ? 0.5 : 1,
                }}
                title={
                  currentQuiz.key === activeQuizKey && isRunning
                    ? "Impossible de dupliquer le quiz actif pendant qu'il est en cours"
                    : "Dupliquer ce quiz"
                }
              >
                Dupliquer ce quiz
              </button>
              <button
                type="button"
                onClick={() => handleEditQuizName(currentQuiz.key)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #2563eb",
                  background: "#2563eb",
                  color: "#f9fafb",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                title="Modifier le nom de ce quiz"
              >
                Editer nom du quizz
              </button>
              <button
                type="button"
                onClick={() => handleDeleteQuiz(currentQuiz.key)}
                disabled={currentQuiz.key === activeQuizKey && isRunning}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: currentQuiz.key === activeQuizKey && isRunning ? "1px solid #4b5563" : "1px solid #7f1d1d",
                  background: currentQuiz.key === activeQuizKey && isRunning ? "#4b5563" : "#b91c1c",
                  color: currentQuiz.key === activeQuizKey && isRunning ? "#9ca3af" : "#f9fafb",
                  fontWeight: 600,
                  cursor: currentQuiz.key === activeQuizKey && isRunning ? "not-allowed" : "pointer",
                  opacity: currentQuiz.key === activeQuizKey && isRunning ? 0.5 : 1,
                }}
                title={
                  currentQuiz.key === activeQuizKey && isRunning
                    ? "Impossible de supprimer le quiz actif pendant qu'il est en cours"
                    : "Supprimer ce quiz"
                }
              >
                Supprimer ce quiz
              </button>
              
              {/* Boutons Import/Export */}
              <button
                type="button"
                onClick={() => currentQuiz && exportQuiz(currentQuiz.key)}
                disabled={!currentQuiz}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "#e5e7eb",
                  fontWeight: 600,
                  cursor: currentQuiz ? "pointer" : "not-allowed",
                  fontSize: 13,
                }}
                title="Exporter ce quiz en fichier JSON"
              >
                📥 Exporter
              </button>
              <label
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "#e5e7eb",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontSize: 13,
                  display: "inline-block",
                }}
                title="Importer un quiz depuis un fichier JSON"
              >
                📤 Importer
                <input
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && currentQuiz) {
                      importQuiz(file, currentQuiz.key);
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          {/* Bloc création + questions sous fond bleu clair */}
          <div
            style={{
              marginTop: 8,
              padding: 12,
              borderRadius: 12,
              background: "#2c5d8bff",
              border: "1px solid #2d7ec940",
            }}
          >
            <h2 style={{ margin: 0 }}>
              {currentQuiz.name} — créer une nouvelle question
            </h2>

            <div
              style={{
                display: "grid",
                gap: 8,
                maxWidth: 800,
                marginTop: 12,
                marginBottom: 16,
              }}
            >
              <label>
                Question
                <textarea
                  rows={2}
                  value={newQ.text}
                  onChange={(e) => setNewQ((p) => ({ ...p, text: e.target.value }))}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </label>

              <label>
                Image question (optionnelle)
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    setNewQ((p) => ({
                      ...p,
                      imageQuestionFile: e.target.files?.[0] || null,
                    }))
                  }
                />
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={newQ.imageQuestionLarge || false}
                  onChange={(e) =>
                    setNewQ((p) => ({
                      ...p,
                      imageQuestionLarge: e.target.checked,
                    }))
                  }
                />
                <span>Afficher l'image question en grand (+200px)</span>
              </label>

              <label>
                Type de réponse
                <select
                  value={newQuestionType}
                  onChange={(e) => setNewQuestionType(e.target.value)}
                  style={{ width: "100%", boxSizing: "border-box" }}
                >
                  <option value={QUESTION_TYPE_OPEN}>Réponse libre (texte)</option>
                  <option value={QUESTION_TYPE_QCM}>QCM (4 propositions)</option>
                </select>
              </label>

              {newQuestionType === QUESTION_TYPE_QCM ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 13, opacity: 0.85 }}>4 propositions — coche la bonne réponse :</div>
                  {newQcmOptions.map((opt, optIdx) => (
                    <label
                      key={optIdx}
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        type="radio"
                        name="new-qcm-correct"
                        checked={newQcmCorrectIndex === optIdx}
                        onChange={() => setNewQcmCorrectIndex(optIdx)}
                      />
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => {
                          const next = [...newQcmOptions];
                          next[optIdx] = e.target.value;
                          setNewQcmOptions(next);
                        }}
                        placeholder={`Proposition ${optIdx + 1}`}
                        style={{ flex: 1, boxSizing: "border-box" }}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <>
                  <label>
                    Réponses acceptées (séparées par des virgules)
                    <input
                      type="text"
                      value={newQ.answersCsv}
                      onChange={(e) =>
                        setNewQ((p) => ({ ...p, answersCsv: e.target.value }))
                      }
                      placeholder="ex: Mario, Super Mario"
                      style={{ width: "100%", boxSizing: "border-box" }}
                    />
                  </label>
                  <label>
                    Mode d&apos;appariement (tolérance)
                    <select
                      value={newMatchingMode}
                      onChange={(e) => setNewMatchingMode(e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box" }}
                    >
                      <option value="strict">strict (exact après normalisation)</option>
                      <option value="relaxed">relaxed (tolérance relative)</option>
                      <option value="numeric">numeric (strict numérique)</option>
                    </select>
                  </label>
                </>
              )}

              <label>
                TimeMusic (hh:mm:ss)
                <input
                  type="text"
                  value={newQ.timeMusicStr}
                  onChange={(e) =>
                    setNewQ((p) => ({ ...p, timeMusicStr: e.target.value }))
                  }
                  placeholder={`Défaut: ${formatHMS(defaultTimeMusicSec)}`}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </label>

              <label>
                Image réponse (optionnelle)
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    setNewQ((p) => ({
                      ...p,
                      imageReponseFile: e.target.files?.[0] || null,
                    }))
                  }
                />
              </label>

              <div>
                <button onClick={createOne} disabled={creating}>
                  {creating ? "Création…" : "Créer la question"}
                </button>
              </div>
            </div>

            {table}
          </div>

        </>
      )}

    </div>

  );
}

// ===================== PARTIE 6.3/6 — Wrapper protégé par authentification =====================

export default function Admin() {
  return (
    <AuthGate
      title="Accès régie"
      subtitle="Réservé à l'organisation du quiz."
      accent="#22c55e"
    >
      <AdminInner />
    </AuthGate>
  );
}