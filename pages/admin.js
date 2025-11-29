// ============================================================================
// /pages/admin.js — Refactoré avec imports depuis /lib
// Scope : Interface d'administration complète (questions, joueurs, contrôles)
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
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
  Timestamp,
  arrayUnion,
  runTransaction,
  where,
  increment,
  deleteField,
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

// Imports depuis les fichiers utilitaires
import {
  DEFAULT_SCORING_TABLE,
  DEFAULT_REVEAL_DURATION_SEC,
  DEFAULT_LEADERBOARD_TOP_N,
  TIME_MUSIC_MIN_SEC,
  DEFAULT_TIME_MUSIC_SEC,
  PLAYER_COLORS,
  DEFAULT_BUZZER_POINTS,
  BUZZER_CORRECT_MESSAGE_DURATION_MS,
  BUZZER_WRONG_MESSAGE_DURATION_MS,
  BUZZER_COOLDOWN_MS,
  BUZZER_STATES,
} from "../lib/constants";

import {
  parseHMS,
  formatHMS,
  formatHMSForInput,
  parseCSV,
  toCSV,
  clampTimeMusicSec,
  normKey,
  pickColorDifferent,
  normalizeNameAlpha,
  getTimeSec,
  roundIndexOfTime,
} from "../lib/utils";

import {
  ensureAwardsForQuestionTx,
  resetScoringCache,
  registerBuzzerPress,
  awardBuzzerPoints,
  resetBuzzerState,
  lockPlayerBuzz,
  resetPlayerBuzzLock,
  resetAllPlayerBuzzLocks,
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
  if (!("scoringTable" in data)) patch.scoringTable = DEFAULT_SCORING_TABLE;
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

/**
 * Backfill : ajoute buzzScore = 0 aux joueurs existants qui n'ont pas ce champ
 * (Optionnel, peut être appelé une fois au besoin)
 */
async function backfillPlayersBuzzScore() {
  try {
    const playersCol = collection(doc(db, "quiz", "state"), "players");
    const snap = await getDocs(playersCol);

    const docsToFix = snap.docs.filter((d) => {
      const data = d.data() || {};
      return !("buzzScore" in data);
    });

    if (!docsToFix.length) return;

    console.log(
      "[Admin] backfill buzzScore on",
      docsToFix.length,
      "players"
    );

    // Batch par blocs de 400
    while (docsToFix.length) {
      const chunk = docsToFix.splice(0, 400);
      const batch = writeBatch(db);

      chunk.forEach((docSnap) => {
        batch.update(doc(playersCol, docSnap.id), { buzzScore: 0 });
      });

      await batch.commit();
    }
  } catch (e) {
    console.error("backfillPlayersBuzzScore error:", e);
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

  // Intro / fin de manche
  const [isIntro, setIsIntro] = useState(false);
  const [introEndsAtMs, setIntroEndsAtMs] = useState(null);
  const [introRoundIndex, setIntroRoundIndex] = useState(null);
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
  const [buzzerMessageType, setBuzzerMessageType] = useState(null);

  // Refs pour connaître la phase courante sans dépendance d'ordre
  const isCountdownRef = useRef(false);
  const isRevealRef = useRef(false);

  // Création question
  const [newQ, setNewQ] = useState({
    text: "",
    answersCsv: "",
    timeMusicStr: "",
    imageQuestionFile: null, // image affichée pendant la phase "question"
    imageReponseFile: null, // image affichée pendant la "révélation"
  });

  // Matching — champs création
  // matchingMode: "strict" | "relaxed" | "numeric"
  const [newMatchingMode, setNewMatchingMode] = useState("strict");

  const DEFAULT_REVEAL_PHRASES = [
    "La réponse était :",
    "Il fallait trouver :",
    "C'était :",
    "La bonne réponse :",
    "Réponse :",
  ];
  const [newRevealPhrases, setNewRevealPhrases] = useState([
    "",
    "",
    "",
    "",
    "",
  ]);

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

        // Quiz sélectionné dans l’UI : si absent, basculer sur le quiz actif
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
          setQuizStartMs(null);
          setPauseAtMs(null);
          setElapsedSec(0);
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

        setIsIntro(!!d.isIntro);
        setIntroEndsAtMs(
          typeof d.introEndsAtMs === "number" ? d.introEndsAtMs : null
        );
        setIntroRoundIndex(
          Number.isInteger(d.introRoundIndex) ? d.introRoundIndex : null
        );
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
        setBuzzerMessageType(typeof d.buzzerMessageType === "string" ? d.buzzerMessageType : null);
      },
      (e) => console.error("onSnapshot state error:", e)
    );

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

  // [3.2] Effect — 5) Auto-pause à la fin de manche (boundary = 1s AVANT la manche suivante)
  useEffect(() => {
    if (!isRunning || isPaused) return;
    if (!Array.isArray(roundOffsetsSec) || roundOffsetsSec.every((v) => v == null))
      return;

    // Manche courante = dernière dont l’offset ≤ elapsedSec
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

    // Frontière = 1 seconde AVANT le début de la manche suivante
    const boundary = Math.max(0, nextStart - 1);

    if (elapsedSec < boundary) return;

    // Déjà auto-pausé pour cette manche → ne rien refaire
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

        if (!p.color && !assignedColorRef.current.has(p.id)) {
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
    ? Math.max(0, _nextRoundStart)
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

  /* === Contrôle clavier EleyBuzz (touches 1, 2, 3) === */
  useEffect(() => {
    if (!isBuzzerMode) return;

    const handleKeyDown = (e) => {
      // Touche 1 : toggle buzzer state (idle ↔ open)
      if (e.key === "1" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleBuzzerState();
      }
      // Touche 2 : bonne réponse
      else if (e.key === "2" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        handleBuzzerCorrect();
      }
      // Touche 3 : mauvaise réponse
      else if (e.key === "3" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        handleBuzzerWrong();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isBuzzerMode, buzzerState, firstPlayerId, firstPlayerName, buzzerPoints]);

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

        // 🔎 Patch Matching — mapping CSV -> arrays
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
      const payload = {
        text: it.text ?? "",
        answers: hasAnswersCsv
          ? parseCSV(it.answersCsv)
          : Array.isArray(it.answers)
            ? it.answers
            : [],

        matchingMode:
          typeof it.matchingMode === "string" && it.matchingMode
            ? it.matchingMode
            : "strict",

        timeMusicSec: nextTimeMusicSec,
        timecodeSec:
          typeof it.timecodeSec === "number" ? it.timecodeSec : null,

        // Images (brutes, on ajustera juste après avec deleteField si besoin)
        imageQuestionUrl: it.imageQuestionUrl || "",
        imageReponseUrl: it.imageReponseUrl || it.imageUrl || "",

        order:
          typeof it.order === "number"
            ? it.order
            : (items.findIndex((x) => x.id === it.id) + 1) * 1000,
      };

      // Construire l’objet d’update final (avec deleteField)
      const updates = { ...payload };

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

      const answers = parseCSV(newQ.answersCsv);
      const timeMusicSec = clampTimeMusicSec(parseHMS(newQ.timeMusicStr));
      const order =
        items.length > 0
          ? Math.max(...items.map((x) => x.order || 0)) + 1000
          : 1000;
      const cleanedRevealPhrases = (newRevealPhrases ?? [])
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .slice(0, 5);

      await addDoc(collection(db, "LesQuestions"), {
        text: newQ.text || "",
        answers,

        // Champs persistant pour le matching
        matchingMode: newMatchingMode || "strict",

        timeMusicSec,
        timecodeSec: null, // recalculé par recalcAllTimecodesFromOrder

        imageQuestionUrl,
        imageReponseUrl,
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
        timeMusicStr: "",
        imageQuestionFile: null,
        imageReponseFile: null,
      });
      setNewMatchingMode("strict");
      setNewRevealPhrases(["", "", "", "", ""]);
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
        },
        { merge: true }
      );
    } catch (err) {
      console.error("startQuiz error:", err);
      alert("Impossible de démarrer le quiz : " + (err?.message || err));
    }
  };

  const pauseQuiz = async () => {
    try {
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isPaused: true,
          pauseAt: serverTimestamp(),
          lastAutoPausedRoundIndex: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("pauseQuiz error:", err);
      alert("Impossible de mettre en pause : " + (err?.message || err));
    }
  };

  const seekTo = async (targetSec) => {
    try {
      const target = Math.max(0, Math.floor(targetSec));

      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && target - 1 >= t) prevIdx = i;
      }
      const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
        ? roundOffsetsSec[prevIdx + 1]
        : null;
      const boundary =
        typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;

      const payload = {
        isRunning: true,
        isPaused: false,
        startAt: serverTimestamp(),
        pauseAt: null,
        anchorAt: serverTimestamp(),
        anchorOffsetSec: target,
        startEpochMs: null,
        navSeq: increment(1),
        hbBoost: true,
      };
      if (typeof boundary === "number" && target >= boundary && prevIdx >= 0) {
        payload.lastAutoPausedRoundIndex = prevIdx;
      }
      await setDoc(doc(db, "quiz", "state"), payload, { merge: true });
    } catch (err) {
      console.error("seekTo error:", err);
      alert("Échec du seek : " + (err?.message || err));
    }
  };

  const resumeFromPause = async () => {
    try {
      const elapsed = Math.max(0, Math.floor(elapsedSec));

      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: false,
          startAt: serverTimestamp(),
          pauseAt: null,
          anchorAt: serverTimestamp(),
          anchorOffsetSec: elapsed,
          startEpochMs: null,
          navSeq: increment(1),
          hbBoost: true,
          lastAutoPausedRoundIndex: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("resumeFromPause error:", err);
      alert("Échec de la reprise : " + (err?.message || err));
    }
  };

  const jumpToRoundStartAndPlay = async (roundStartSec) => {
    try {
      const target = Math.max(0, Math.floor(roundStartSec));

      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && target - 1 >= t) prevIdx = i;
      }

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
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("jumpToRoundStartAndPlay error:", err);
      alert("Échec du saut de manche : " + (err?.message || err));
    }
  };

  const seekPaused = async (targetSec) => {
    try {
      const target = Math.max(0, Math.floor(targetSec));

      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && target - 1 >= t) prevIdx = i;
      }
      const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
        ? roundOffsetsSec[prevIdx + 1]
        : null;
      const boundary =
        typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;

      const payload = {
        isRunning: true,
        isPaused: true,
        startAt: serverTimestamp(),
        pauseAt: serverTimestamp(),
        anchorAt: serverTimestamp(),
        anchorOffsetSec: target,
        startEpochMs: null,
        navSeq: increment(1),
        hbBoost: true,
      };
      if (typeof boundary === "number" && target >= boundary && prevIdx >= 0) {
        payload.lastAutoPausedRoundIndex = prevIdx;
      }
      await setDoc(doc(db, "quiz", "state"), payload, { merge: true });
    } catch (err) {
      console.error("seekPaused error:", err);
      alert("Échec du positionnement (pause) : " + (err?.message || err));
    }
  };

    // Sauvegarder automatiquement la config de temps (manches + fin) avant un départ à froid
  const autoSaveTimeConfigBeforeStart = async () => {
    try {
      // On se base sur ce qui est actuellement saisi dans les champs M1..M8 + Fin du quiz
      await saveRoundOffsets(roundOffsetsStr);
      await saveEndOffset(endOffsetStr);
    } catch (e) {
      console.error("autoSaveTimeConfigBeforeStart error:", e);
    }
  };


    const startOrNextRound = async () => {
    const actives = (Array.isArray(roundOffsetsSec) ? roundOffsetsSec : [])
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);

    if (mainBtnBusy) return;
    setMainBtnBusy(true);
    setTimeout(() => setMainBtnBusy(false), 350);

    const isColdStart = !isRunning || !quizStartMs;

    if (!actives.length) {
      if (isColdStart) {
        await autoSaveTimeConfigBeforeStart();
      }
      await startQuiz();
      return;
    }

    if (isColdStart) {
      await autoSaveTimeConfigBeforeStart();
      await startQuiz();
      return;
    }

    if (isPaused) {
      let nextRoundStart = null;
      if (isPaused && Number.isInteger(lastAutoPausedRoundIndex)) {
        const idx = lastAutoPausedRoundIndex + 1;
        nextRoundStart = Number.isFinite(roundOffsetsSec[idx])
          ? roundOffsetsSec[idx]
          : null;
      } else {
        nextRoundStart = actives.find((t) => t >= elapsedSec);
      }
      if (typeof nextRoundStart !== "number") {
        setNotice("Aucune manche suivante");
        setTimeout(() => setNotice(null), 1800);
        return;
      }
      const boundary = Math.max(0, nextRoundStart);

      await awardCurrentQuestionIfNeeded();

      if (elapsedSec < boundary) {
        await jumpToRoundStartAndPlay(nextRoundStart);
      } else {
        await resumeFromPause();
      }
      return;
    }
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
    if (!isPaused) return;

    if (atRoundBoundary) {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
      return;
    }

    const actives = roundOffsetsSec
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);
    const firstActive = actives[0] ?? 0;
    const roundStart =
      actives.filter((t) => t <= elapsedSec).slice(-1)[0] ?? firstActive;
    const roundEnd = actives.find((t) => t > roundStart) ?? Infinity;

    if (!plannedTimes.length || elapsedSec < firstActive) {
      await seekTo(0);
      return;
    }

    const inRound = plannedTimes.filter(
      (t) => t >= roundStart && t < roundEnd
    );
    if (!inRound.some((t) => t <= elapsedSec)) {
      await seekTo(roundStart);
      return;
    }

    const past = inRound.filter((t) => t <= elapsedSec);
    const target = past[past.length - 1] ?? roundStart;
    await seekTo(target);
  };

  const handleNext = async () => {
    if (!isPaused) return;
    if (atRoundBoundary) {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
      return;
    }
    if (!plannedTimes.length) {
      setNotice("Aucune question suivante");
      setTimeout(() => setNotice(null), 2000);
      return;
    }

    const first = plannedTimes[0];
    if (elapsedSec < first) {
      await seekTo(first);
      return;
    }

    const currentRoundStartLocal =
      roundOffsetsSec
        .filter((t) => typeof t === "number" && t <= elapsedSec)
        .slice(-1)[0] ?? 0;
    const currentRoundEndLocal =
      roundOffsetsSec.find(
        (t) => typeof t === "number" && t > currentRoundStartLocal
      ) ?? Infinity;

    const next = plannedTimes.find(
      (t) => t > elapsedSec && t < currentRoundEndLocal
    );
    if (typeof next === "number") {
      await awardCurrentQuestionIfNeeded();
      await seekTo(next);
    } else {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
    }
  };

  async function goToRoundEndPaused() {
    const prevIdx = roundIndexOfTime(
      Math.max(0, elapsedSec - 1),
      roundOffsetsSec
    );
    const nextStart =
      typeof roundOffsetsSec[prevIdx + 1] === "number"
        ? roundOffsetsSec[prevIdx + 1]
        : null;
    if (!Number.isFinite(nextStart)) return;

    const targetSec = Math.max(0, Math.floor(nextStart));
    try {
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: true,
          startAt: serverTimestamp(),
          pauseAt: serverTimestamp(),
          anchorAt: serverTimestamp(),
          anchorOffsetSec: targetSec,
          startEpochMs: null,
          navSeq: increment(1),
          hbBoost: true,
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      );
    } catch (e) {
      console.error("goToRoundEndPaused error:", e);
    }
  }

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

      const baseUpdates = {
        nameStatus: "rejected",
        nameLocked: false,
        isAlias: false,
        updatedAt:
          typeof serverTimestamp === "function"
            ? serverTimestamp()
            : new Date(),
      };

      const updates = isAliased
        ? baseUpdates
        : { ...baseUpdates, rejectedNames: arrayUnion(norm) };

      await updateDoc(ref, updates);
    } catch (e) {
      console.error("rejectPlayer failed:", e);
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

  // [5.6] Purge complète de answers/* (submissions + awards + doc racine)
  async function purgeAnswersTree() {
    const answersCol = collection(db, "answers");
    const answersSnap = await getDocs(answersCol);

    for (const qDoc of answersSnap.docs) {
      const qid = qDoc.id;

      const subsCol = collection(db, "answers", qid, "submissions");
      const subsSnap = await getDocs(subsCol);
      if (!subsSnap.empty) {
        const ids = subsSnap.docs.map((d) => d.id);
        while (ids.length) {
          const chunk = ids.splice(0, 400);
          const batch = writeBatch(db);
          chunk.forEach((sid) => batch.delete(doc(subsCol, sid)));
          await batch.commit();
        }
      }

      const awardsCol = collection(db, "answers", qid, "awards");
      const awardsSnap = await getDocs(awardsCol);
      if (!awardsSnap.empty) {
        const ids = awardsSnap.docs.map((d) => d.id);
        while (ids.length) {
          const chunk = ids.splice(0, 400);
          const batch = writeBatch(db);
          chunk.forEach((aid) => batch.delete(doc(awardsCol, aid)));
          await batch.commit();
        }
      }

      await deleteDoc(doc(answersCol, qid));
    }
  }

  // [5.7] Reset complet du quiz + joueurs + answers/*
  async function resetQuizAndPlayers() {
    const ok = window.confirm(
      "Tout remettre à zéro ? (quiz/state, joueurs, answers/*)"
    );
    if (!ok) return;

    setNotice("Réinitialisation…");
    try {
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
        },
        { merge: true }
      );

      await purgeAnswersTree();

      await deleteAllPlayers();

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
        });
        // Réinitialiser tous les canBuzz des joueurs à true (pour débloquer ceux qui étaient en punition)
        await resetAllPlayerBuzzLocks(db, []);
        setNotice("EleyBuzz activé");
      } else {
        // Désactivation
        await updateDoc(stateRef, {
          isBuzzerMode: false,
          buzzerState: "idle",
          firstPlayerId: null,
          firstPlayerName: null,
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
    try {
      const stateRef = doc(db, "quiz", "state");
      const nextState = buzzerState === "idle" ? "open" : "idle";
      await resetBuzzerState(db, nextState);
    } catch (e) {
      console.error("toggleBuzzerState error:", e);
      setNotice("Erreur lors du changement d'état du buzzer");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Gérer bonne réponse (touche 2)
  async function handleBuzzerCorrect() {
    if (!isBuzzerMode || buzzerState !== "locked" || !firstPlayerId) return;
    try {
      // Attribuer les points
      await awardBuzzerPoints(db, firstPlayerId, buzzerPoints);
      
      // Afficher message temporaire (géré côté Screen via Firestore)
      const stateRef = doc(db, "quiz", "state");
      await updateDoc(stateRef, {
        buzzerMessage: `Bravo ${firstPlayerName || "Joueur"}, tu gagnes ${buzzerPoints} pts !`,
        buzzerMessageType: "correct",
      });

      // Reset après 5 secondes
      setTimeout(async () => {
        await resetBuzzerState(db, "idle");
        await updateDoc(stateRef, {
          buzzerMessage: null,
          buzzerMessageType: null,
        });
      }, BUZZER_CORRECT_MESSAGE_DURATION_MS);
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
      
      // Lock le joueur qui s'est trompé
      await lockPlayerBuzz(db, wrongPlayerId);

      // Afficher message temporaire
      const stateRef = doc(db, "quiz", "state");
      await updateDoc(stateRef, {
        buzzerMessage: "Mauvaise réponse !",
        buzzerMessageType: "wrong",
      });

      // Reset après 3 secondes et réouvrir le buzzer
      // On réinitialise les locks de tous les joueurs SAUF celui qui vient de se tromper
      // (il sera débloqué après 20 secondes si personne ne rebuzz, ou dès qu'un autre buzz)
      setTimeout(async () => {
        try {
          await resetAllPlayerBuzzLocks(db, [wrongPlayerId]);
          await resetBuzzerState(db, "open");
          await updateDoc(stateRef, {
            buzzerMessage: null,
            buzzerMessageType: null,
          });
        } catch (e) {
          console.error("[handleBuzzerWrong] Reset error:", e);
        }
      }, BUZZER_WRONG_MESSAGE_DURATION_MS);

      // Cooldown de 20 secondes : si personne ne rebuzz, débloquer le joueur après 20s
      setTimeout(async () => {
        try {
          // Vérifier que le buzzer est toujours ouvert et qu'aucun autre joueur n'a buzzé
          const stateSnap = await getDoc(stateRef);
          if (stateSnap.exists()) {
            const data = stateSnap.data() || {};
            // Si le buzzer est toujours ouvert et qu'aucun autre joueur n'a buzzé, débloquer
            if (data.buzzerState === BUZZER_STATES.OPEN && !data.firstPlayerId) {
              await resetPlayerBuzzLock(db, wrongPlayerId);
            }
          }
        } catch (e) {
          console.error("[handleBuzzerWrong] Cooldown unlock error:", e);
        }
      }, BUZZER_WRONG_MESSAGE_DURATION_MS + BUZZER_COOLDOWN_MS);
    } catch (e) {
      console.error("handleBuzzerWrong error:", e);
      setNotice("Erreur lors du traitement de la mauvaise réponse");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Remettre tous les scores à 0 (onglet Joueurs)
  async function resetAllScores() {
    const ok = window.confirm(
      "Remettre tous les scores (quiz + EleyBuzz) à 0 pour tous les joueurs ?"
    );
    if (!ok) return;

    try {
      const playersCol = collection(db, "quiz", "state", "players");
      const snap = await getDocs(playersCol);
      const ids = snap.docs.map((d) => d.id);

      while (ids.length) {
        const chunk = ids.splice(0, 400);
        const batch = writeBatch(db);
        chunk.forEach((id) => {
          batch.update(doc(playersCol, id), {
            score: 0,
            buzzScore: 0,
          });
        });
        await batch.commit();
      }

      setNotice("Tous les scores ont été remis à 0 ✔");
      setTimeout(() => setNotice(null), 1800);
    } catch (e) {
      console.error("resetAllScores error:", e);
      setNotice("Échec de la remise à zéro des scores");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  // Afficher le score final (podium combiné)
  async function showFinalScore() {
    try {
      const stateRef = doc(db, "quiz", "state");
      await updateDoc(stateRef, { showFinalScore: true });
      setNotice("Score final affiché sur Screen et Player");
      setTimeout(() => setNotice(null), 2000);
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

  const mainButtonLabel = isQuizEnded
    ? "Fin du quiz"
    : !isRunning
      ? "Démarrer le quiz"
      : isPaused
        ? "Manche suivante"
        : `Manche ${currentRoundNumber}`;

  const mainButtonRoundIdx = isQuizEnded
    ? null
    : !isRunning
      ? null
      : isPaused
        ? nextRoundIndex
        : currentRoundIndex;

  const mainButtonColor =
    mainButtonRoundIdx != null && mainButtonRoundIdx >= 0
      ? roundColors[mainButtonRoundIdx] || "#e5e7eb"
      : "#e5e7eb";

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

  // On peut changer le quiz actif uniquement quand le gros bouton affiche "Démarrer le quiz"
  const canChangeActiveQuiz = mainButtonLabel === "Démarrer le quiz";


  // --- Pause/Reprendre (même visuel qu'avant, juste le label qui bascule) ---
  const canPauseResume = isRunning && !!quizStartMs && !isQuizEnded; // pas avant départ, ni après fin
  const pauseBtnLabel = isPaused ? "Reprendre" : "Pause";
  const pauseCursor = canPauseResume ? "pointer" : "not-allowed";
  const pauseBtnTitle = canPauseResume
    ? (isPaused ? "Reprendre le quiz" : "Mettre en pause le quiz")
    : "Indisponible avant le départ ou après la fin";
  // Largeur fixe + couleur pastel différente quand on est en "Reprendre"
  const PAUSE_BTN_WIDTH = 120; // px, dimensionnée pour "Reprendre"
  const pauseBtnBg = isPaused ? "#dfd6ff" : "#FECACA"; // Reprendre = pêche pastel, Pause = saumon pastel d'origine


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

  // Tri des joueurs : OK → Refusé → Kické, puis alphabétique dans chaque groupe
  const sortedPlayers = useMemo(() => {
    const getStatusPriority = (p) => {
      if (p.isKicked) return 2; // Kické en dernier
      if (p.nameStatus === "rejected") return 1; // Refusé au milieu
      return 0; // OK en premier
    };

    return [...players].sort((a, b) => {
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
  }, [players]);

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
                  </td>

                  <td style={{ width: "30%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={answersCsv}
                      onChange={(e) => handleFieldChange(it.id, "answersCsv", e.target.value)}
                      placeholder="ex: Goku, Son Goku"
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sépare par des virgules</div>
                    {/* 🔎 Patch Matching — édition par ligne */}
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
                        Défaut {DEFAULT_TIME_MUSIC_SEC}s (min {TIME_MUSIC_MIN_SEC}s)
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          margin: "12px 0",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={startOrNextRound}
          disabled={(isRunning && !isPaused) || isQuizEnded || mainBtnBusy || isBuzzerMode}
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
              (isRunning && !isPaused) || isIntro || isQuizEnded || isBuzzerMode
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
            textAlign: "center",
            whiteSpace: "nowrap",
            opacity: isBuzzerMode ? 0.6 : 1,
          }}
          title={isBuzzerMode ? "Indisponible en mode EleyBuzz" : mainButtonLabel}
        >
          {mainButtonLabel}
        </button>

        <button
          onClick={() => (canPauseResume && !isBuzzerMode ? togglePauseResume(db) : null)}
          disabled={!canPauseResume || isBuzzerMode}
          aria-disabled={(!canPauseResume || isBuzzerMode) ? "true" : "false"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: PAUSE_BTN_WIDTH,          // largeur fixe pour "Reprendre"
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: pauseBtnBg,          // couleur pastel différente en "Reprendre"
            color: "#000",
            fontWeight: 600,
            cursor: (canPauseResume && !isBuzzerMode) ? pauseCursor : "not-allowed",
            opacity: (!canPauseResume || isBuzzerMode) ? 0.6 : 1,
            whiteSpace: "nowrap",
            textAlign: "center",
            transition: "background 160ms ease",
          }}
          title={isBuzzerMode ? "Indisponible en mode EleyBuzz" : pauseBtnTitle}
        >
          {pauseBtnLabel}
        </button>

        <button
          onClick={handleBack}
          disabled={!isPaused || plannedTimes.length === 0 || atRoundBoundary || isBuzzerMode}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#bfdbfe",
            color: "#000",
            fontWeight: 600,
            cursor:
              !isPaused || plannedTimes.length === 0 || atRoundBoundary || isBuzzerMode
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
            opacity: isBuzzerMode ? 0.6 : 1,
          }}
          title={
            isBuzzerMode
              ? "Indisponible en mode EleyBuzz"
              : atRoundBoundary
                ? "Fin de manche atteinte : utilisez « Manche suivante »"
                : "Revenir au début de la question en cours (ou au début de la manche)"
          }
        >
          Back
        </button>

        <button
          onClick={handleNext}
          disabled={!isPaused || plannedTimes.length === 0 || atRoundBoundary || isBuzzerMode}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#c7d2fe",
            color: "#000",
            fontWeight: 600,
            cursor:
              !isPaused || plannedTimes.length === 0 || atRoundBoundary || isBuzzerMode
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
            opacity: isBuzzerMode ? 0.6 : 1,
          }}
          title={
            isBuzzerMode
              ? "Indisponible en mode EleyBuzz"
              : atRoundBoundary
                ? "Fin de manche atteinte : utilisez « Manche suivante »"
                : "Aller au début de la prochaine question (si disponible dans cette manche)"
          }
        >
          Next
        </button>

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
          }}
          title="Réinitialiser le quiz"
        >
          Réinitialiser
        </button>

        {/* EleyBuzz Controls */}
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
            title={isBuzzerMode ? "Désactiver EleyBuzz" : "Activer EleyBuzz"}
          >
            {isBuzzerMode ? "STOP EleyBuzz" : "Go EleyBuzz"}
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
                title="Touche 1 : Ouvrir/Fermer le buzzer"
              >
                {buzzerState === "open" ? "Buzzer OUVERT" : buzzerState === "locked" ? "Buzzer VERROUILLÉ" : "Buzzer FERMÉ"}
              </button>

              {buzzerState === "locked" && firstPlayerName && (
                <span style={{ color: "#facc15", fontWeight: 700 }}>
                  {firstPlayerName} a buzzé !
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
                    title={buzzerMessage ? "En attente de la fin du message" : "Touche 2 : Bonne réponse (+15 pts)"}
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
                    title={buzzerMessage ? "En attente de la fin du message" : "Touche 3 : Mauvaise réponse"}
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

        {notice && (
          <div
            style={{
              padding: "6px 10px",
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: 8,
              color: "#fff",
            }}
          >
            {notice}
          </div>
        )}
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
            background: adminTab === "players" ? "#2c5d8bff" : "transparent",
            color: "#e6eeff",
            cursor: "pointer",
            fontWeight: adminTab === "players" ? 700 : 500,
          }}
        >
          Joueurs
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
                background: "#fde68a",
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
              title="Afficher le podium final (score quiz + EleyBuzz)"
            >
              Score final
            </button>
          </div>

          {/* Tableau joueurs */}
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
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>Joueurs</th>
                  <th style={{ textAlign: "center", padding: "10px 8px", width: 120 }}>Score Quiz</th>
                  <th style={{ textAlign: "center", padding: "10px 8px", width: 120 }}>Score Bonus<br/><span style={{ fontSize: "0.85em", opacity: 0.9 }}>EleyBuzz</span></th>
                  <th style={{ textAlign: "center", padding: "10px 8px", width: 140 }}>Statut</th>
                  <th style={{ textAlign: "left", padding: "10px 8px", width: 360 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedPlayers.map((p) => {
                  const status = p.isKicked ? "Kické" : (p.nameStatus === "rejected" ? "Refusé" : "OK");
                  const statusBg =
                    p.isKicked ? "#4b5563" : p.nameStatus === "rejected" ? "#fde68a" : "#86efac";
                  const statusColor =
                    p.isKicked ? "#e5e7eb" : p.nameStatus === "rejected" ? "#111827" : "#064e3b";

                  const isAliased = !!p.nameLocked || p.nameStatus === "locked";
                  // Rang (égalité) + médaille
                  const rank = rankingForAdmin.get(p.id) ?? null;
                  const s = Number(p.score || 0);
                  const medal = s > 0 && (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "");

                  return (
                    <tr key={p.id} style={{ borderTop: "1px solid #1f2a44" }}>
                      <td style={{ padding: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          <span
                            title={p.color || ""}
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 4,
                              background: p.color || "#6b7280",
                              display: "inline-block",
                              border: "1px solid rgba(255,255,255,0.2)",
                              flex: "0 0 auto",
                            }}
                          />
                          <span
                            title={p.name || "(sans nom)"}
                            style={{
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              maxWidth: "100%",
                              display: "block",
                            }}
                          >
                            {p.name || "(sans nom)"}
                          </span>
                        </div>
                      </td>

                      <td style={{ padding: "8px", textAlign: "center" }} title={rank != null ? `Rang #${rank}` : undefined}>
                        <span
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 800,
                            letterSpacing: 0.2,
                          }}
                        >
                          {Number(p.score || 0)}
                        </span>
                        {medal && <span style={{ marginLeft: 6 }}>{medal}</span>}
                      </td>

                      <td style={{ padding: "8px", textAlign: "center" }}>
                        <span
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 800,
                            letterSpacing: 0.2,
                            color: "#facc15",
                          }}
                        >
                          {Number(p.buzzScore || 0)}
                        </span>
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

                      <td style={{ padding: "8px" }}>
                        <button
                          onClick={() => rejectPlayer(p.id, p.name)}
                          disabled={p.isKicked || p.nameStatus === "rejected"}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: "1px solid #2a2a2a",
                            background: "#fde68a",
                            color: "#111827",
                            fontWeight: 600,
                            marginRight: 8,
                            opacity: p.isKicked || p.nameStatus === "rejected" ? 0.6 : 1,
                            cursor:
                              p.isKicked || p.nameStatus === "rejected" ? "not-allowed" : "pointer",
                          }}
                          title="Refuser ce nom (le joueur devra en choisir un autre)"
                        >
                          Refuser
                        </button>

                        <button
                          onClick={() => renameToAlias(p.id)}
                          disabled={!isRunning || isAliased}
                          title={
                            !isRunning
                              ? "Disponible une fois le quiz lancé"
                              : isAliased
                                ? "Nom modéré (verrouillé)"
                                : "Fixer le nom sur « Player N »"
                          }
                          style={{
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: "1px solid #2a2a2a",
                            background: isAliased ? "#e5e7eb" : "#c7d2fe",
                            color: "#111827",
                            fontWeight: 600,
                            opacity: !isRunning || isAliased ? 0.6 : 1,
                            cursor: !isRunning || isAliased ? "not-allowed" : "pointer",
                          }}
                        >
                          {isAliased ? "Owned :)" : "Player N"}
                        </button>

                        <button
                          onClick={() => kickPlayer(p.id)}
                          disabled={p.isKicked}
                          style={{
                            marginLeft: 8,
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: "1px solid #2a2a2a",
                            background: "#fecaca",
                            color: "#111827",
                            fontWeight: 600,
                            opacity: p.isKicked ? 0.6 : 1,
                            cursor: p.isKicked ? "not-allowed" : "pointer",
                          }}
                          title="Retirer ce joueur de la partie"
                        >
                          Kick
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {players.length === 0 && !playersLoading && (
                  <tr>
                    <td colSpan={5} style={{ padding: 12, opacity: 0.7 }}>
                      Aucun joueur pour l'instant.
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
                gridTemplateColumns: "minmax(0, 1fr) 360px",
                gap: 16,
                alignItems: "start",
                maxWidth: 1100,
                marginTop: 12,
                marginBottom: 16,
              }}
            >
              {/* Colonne gauche */}
              <div style={{ display: "grid", gap: 8 }}>
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
                {/* 🔎 Patch Matching — options de tolérance par question */}
                <label>
                  Mode d’appariement (tolérance)
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

                <label>
                  TimeMusic (hh:mm:ss)
                  <input
                    type="text"
                    value={newQ.timeMusicStr}
                    onChange={(e) =>
                      setNewQ((p) => ({ ...p, timeMusicStr: e.target.value }))
                    }
                    placeholder="ex: 00:00:35"
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

              {/* Colonne droite : phrases de révélation */}
              <fieldset
                style={{
                  border: "1px solid #333",
                  padding: 12,
                  borderRadius: 8,
                  background: "rgba(15, 23, 42, 0.65)",
                }}
              >
                <legend style={{ padding: "0 6px" }}>
                  Phrase de réponse aléatoire (max 5)
                </legend>

                {newRevealPhrases.map((val, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <label style={{ width: 120 }}>Phrase {i + 1}</label>
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => {
                        const next = [...newRevealPhrases];
                        next[i] = e.target.value;
                        setNewRevealPhrases(next);
                      }}
                      placeholder={DEFAULT_REVEAL_PHRASES[i] || "Ex: La réponse était :"}
                      style={{ flex: 1, padding: 8 }}
                    />
                  </div>
                ))}

                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Laisse vide pour utiliser la liste par défaut.
                </div>
              </fieldset>
            </div>

            {table}
          </div>

        </>
      )}

    </div>

  );
}

// ===================== PARTIE 6.3/6 — Wrapper protégé par mot de passe =====================

export default function Admin() {
  const ADMIN_PASSWORD = "ChoupiEleyBoxAdmin";

  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPasswordInput, setAdminPasswordInput] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const ok = window.localStorage.getItem("eley_admin_unlocked") === "1";
      if (ok) {
        setAdminUnlocked(true);
      }
    } catch {
      // ignore
    }
  }, []);

  if (!adminUnlocked) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#020617",
          color: "#e5e7eb",
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (adminPasswordInput === ADMIN_PASSWORD) {
              setAdminUnlocked(true);
              try {
                if (typeof window !== "undefined") {
                  window.localStorage.setItem("eley_admin_unlocked", "1");
                }
              } catch {
                // ignore
              }
            } else {
              alert("Mot de passe incorrect");
            }
          }}
          style={{
            padding: 24,
            borderRadius: 12,
            border: "1px solid #1f2937",
            background: "#030712",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 260,
            boxShadow: "0 20px 40px rgba(0,0,0,0.45)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            Accès admin
          </h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
            Cette page est réservée à l&apos;organisation du quiz.
          </p>

          <label style={{ fontSize: 14, marginTop: 8 }}>
            Mot de passe :
            <input
              type="password"
              value={adminPasswordInput}
              onChange={(e) => setAdminPasswordInput(e.target.value)}
              style={{
                marginTop: 4,
                width: "100%",
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid #4b5563",
                background: "#020617",
                color: "#e5e7eb",
                outline: "none",
              }}
            />
          </label>

          <button
            type="submit"
            style={{
              marginTop: 8,
              padding: "8px 12px",
              borderRadius: 8,
              border: "none",
              background: "#22c55e",
              color: "#022c22",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Entrer
          </button>
        </form>
      </div>
    );
  }

  // Une fois déverrouillé → on rend ton vrai admin
  return <AdminInner />;
}