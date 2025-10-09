// ============================================================================
// /pages/player.js — Partie 1/6
// Scope : Imports, hook mobile VH, constantes, helpers (scoring, normalisation,
//         modération & validation de nom), composant Splash, reset runtime.
// Règles : aucune modification fonctionnelle ; seulement commentaires/sections.
// ============================================================================

/*Partie 1/4 (imports, constantes, helpers) */
import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import { db } from "../lib/firebase";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  onSnapshot,
  orderBy,
  query,
  addDoc,
  updateDoc,
  where,
  serverTimestamp,
  deleteDoc,
  runTransaction,
} from "firebase/firestore";

// ---------------------------------------------------------------------------
// Hook: Fix viewport height on mobile browsers (100vh bug)
// ---------------------------------------------------------------------------
const useMobileVH = () => {
  useEffect(() => {
    const setVh = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", `${vh}px`);
    };
    setVh();
    window.addEventListener("resize", setVh);
    window.addEventListener("orientationchange", setVh);
    return () => {
      window.removeEventListener("resize", setVh);
      window.removeEventListener("orientationchange", setVh);
    };
  }, []);
};


/* ============================== CONSTANTES ============================== */

/* ===== Instant Win (helpers) ===== */
const FALLBACK_SCORING_TABLE = [
  30, 25, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
];

let _cachedScoring = null;
async function getScoringTable(db) {
  if (_cachedScoring) return _cachedScoring;
  try {
    const cfgRef = doc(db, "quiz", "config");
    const snap = await getDoc(cfgRef);
    const table = (snap.exists() && Array.isArray(snap.data().scoringTable))
      ? snap.data().scoringTable
      : FALLBACK_SCORING_TABLE;
    _cachedScoring = table;
    return table;
  } catch (e) {
    console.error("[getScoringTable] fallback due to error:", e);
    _cachedScoring = FALLBACK_SCORING_TABLE;
    return FALLBACK_SCORING_TABLE;
  }
}

/**
 * Marque la première bonne réponse du joueur et calcule rang/points prédits.
 * Écrit/merge dans:
 *   - answers/{qid}             → { correctCount: N }
 *   - answers/{qid}/submissions/{playerId}
 *       → { isCorrect, firstCorrectAt, predictedRank, predictedPoints }
 * Retourne { predictedRank, predictedPoints }.
 * Idempotent: si déjà correct, ne double-compte pas.
 */
async function recordFirstCorrectAndPredict({ db, qid, playerId }) {
  if (!qid || !playerId) {
    throw new Error("[recordFirstCorrectAndPredict] Missing qid or playerId");
  }
  const table = await getScoringTable(db);
  const qRef = doc(db, "answers", qid);
  const subRef = doc(db, "answers", qid, "submissions", playerId);

  return await runTransaction(db, async (tx) => {
    const subSnap = await tx.get(subRef);

    // Si déjà marqué correct, retourner ce qu'on a (évite double incrément).
    if (subSnap.exists() && subSnap.data().isCorrect) {
      const d = subSnap.data() || {};
      const predictedRank = d.predictedRank ?? null;
      const predictedPoints = d.predictedPoints ?? null;
      if (predictedRank != null && predictedPoints != null) {
        return { predictedRank, predictedPoints };
      }
      return { predictedRank: 0, predictedPoints: 0 };
    }

    // Lire compteur de corrects pour cette question
    const qSnap = await tx.get(qRef);
    const cur = qSnap.exists() ? (qSnap.data().correctCount || 0) : 0;
    const next = cur + 1;

    // Mettre à jour le compteur
    tx.set(qRef, { correctCount: next }, { merge: true });

    const predictedRank = next;
    const predictedPoints = table[predictedRank - 1] ?? 0;

    // Marquer la submission du joueur
    tx.set(subRef, {
      isCorrect: true,
      firstCorrectAt: serverTimestamp(),
      predictedRank,
      predictedPoints,
    }, { merge: true });

    return { predictedRank, predictedPoints };
  });
}

// ---------------------------------------------------------------------------
// Transitions : masque et “cooldown” frontière
// ---------------------------------------------------------------------------
const UI_MASK_MS = 220;         // durée du voile anti-flicker
const BOUNDARY_HYST_MS = 120;   // marge autour des frontières de manche

// ---------------------------------------------------------------------------
// Anti-spam
// ---------------------------------------------------------------------------
const RATE_LIMIT_ENABLED = true;
const MAX_WRONG_ATTEMPTS = 5;        // nb de tentatives avant blocage
const RATE_LIMIT_WINDOW_MS = 15_000; // fenêtre glissante: 15 s
const COOLDOWN_MS = 10_000;          // durée du blocage (10 s)

// Phrases anti-spam
const LOCK_PHRASES = [
  "Eh, arrête de spammer ! Ecoute et réfléchis plutôt !",
  "Le spam c'est mal, m'voyez !",
  "Tu penses vraiment y arriver de cette façon ?",
  "Tu veux faire exploser l'appli ou quoi ?",
  "Calme toi, tout doux..."
];

// Phrases de révélation (fallback)
const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :",
];

// Phases
const REVEAL_DURATION_SEC = 20; // 15s réponse + 5s compte à rebours
const COUNTDOWN_START_SEC = 5;
// Intro au début de chaque manche (mange ce temps sur la 1ʳᵉ question de la manche)
const ROUND_START_INTRO_SEC = 5;

// Barre de temps
const BAR_H = 6;
const BAR_BLUE = "#3b82f6";
const BAR_RED = "#ef4444";
const HANDLE_COLOR = "#f8fafc";

// Image
const PLAYER_IMG_MAX = 220; // px

/* ================================ HELPERS =============================== */
function normalize(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
function isCloseEnough(input, expected, tolerance = 2) {
  return levenshteinDistance(input, expected) <= tolerance;
}
function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec;           // secondes (nouveau)
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60); // minutes (legacy)
  return Infinity;
}
function pickRevealPhrase(q) {
  const custom = Array.isArray(q?.revealPhrases)
    ? q.revealPhrases.filter((p) => typeof p === "string" && p.trim() !== "")
    : [];
  const pool = custom.length ? custom : DEFAULT_REVEAL_PHRASES;
  if (!pool.length) return "Réponse :";
  const seedStr = String(q?.id || "");
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  return pool[hash % pool.length];
}
function formatHMS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

// Manches
function roundIndexOfTime(t, offsets) {
  if (!Array.isArray(offsets)) return 0;
  let idx = -1;
  for (let i = 0; i < offsets.length; i++) {
    const v = offsets[i];
    if (typeof v === "number" && t >= v) idx = i;
  }
  return Math.max(0, idx);
}
function nextRoundStartAfter(t, offsets) {
  if (!Array.isArray(offsets)) return null;
  for (let i = 0; i < offsets.length; i++) {
    const v = offsets[i];
    if (typeof v === "number" && v > t) return v;
  }
  return null;
}

/* ===== Helpers nom joueur (validation + modération forte) ===== */

// 1) Règles d'entrée : lettres FR + chiffres + espace + apostrophe + tirets, 1..30
const NAME_ALLOWED_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9'’\-–\s]{1,30}$/u;

// Helper : détecte "Player N" (N = entier)
function isAliasName(raw) {
  return /^player\s*\d+$/i.test(String(raw || "").trim());
}

// 2) Normalisation “unicité/tri”
function normalizeName(s) {
  return (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // supprime les accents
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// 3) Normalisation “modération” (durcit : leet + ponctuation + répétitions)
function normalizeForModeration(s) {
  let t = (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase();

  // leetspeak courant
  t = t
    .replace(/[@]/g, "a")
    .replace(/[$]/g, "s")
    .replace(/[€]/g, "e")
    .replace(/[0]/g, "o")
    .replace(/[1l]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[4]/g, "a")
    .replace(/[5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[+]/g, "t");

  // tout ce qui n'est pas alphanum devient espace
  t = t.replace(/[^a-z0-9]+/g, " ");

  // compressions de répétitions (biiiiiite -> biite -> bite)
  t = t.replace(/([a-z0-9])\1{2,}/g, "$1$1");

  // espaces propres
  return t.replace(/\s+/g, " ").trim();
}

// 4) Dictionnaires — listes ciblées (peuvent être étendues)
const PROFANITY = new Set([
  "fuck", "shit", "merde", "pute", "putain", "salope", "connard", "connasse",
  "encule", "enculé", "enculee", "enculee", "ntm", "fdp", "nique", "niquer",
  "biatch", "bite", "couille", "couilles", "pd", "tapette", "tafiole",
  // racisme / haine
  "nazi", "hitler", "negro", "negre", "bougnoule", "youpin", "antisemite", "raciste"
]);

// Mots/organisations/lieux politiques & conflits
const POLITICS_TOKENS = new Set([
  "palestine", "israel", "gaza", "hamas", "hezbollah",
  "ukraine", "russie", "russia", "poutine",
  "front", "national", "rn", "reconquete", "zemmour", "sarkozy",
  "lfi", "insoumise", "melenchon", "bardella",
  "macron", "lepen", "trump", "biden", "FN"
]);
// Phrases exactes multi-mots à repérer (avec espaces normaux)
const POLITICS_PHRASES = [
  "front national", "la france insoumise", "le pen"
];
const POLITICS_PREFIX = new Set(["vive", "viva", "free", "support", "go"]);

// 5) Vérification modération
function moderationReason(raw) {
  const norm = normalizeForModeration(raw);
  if (!norm) return null;
  const tokens = norm.split(" ");               // tokens sans accents, propres
  const joined = ` ${tokens.join(" ")} `;       // pour les phrases

  // Profanités (par token entier)
  for (const t of tokens) {
    if (PROFANITY.has(t)) return "moderation";  // insultes/haine/sexuel
  }

  // Phrases politiques connues
  for (const phrase of POLITICS_PHRASES) {
    if (joined.includes(` ${phrase} `)) return "politics";
  }

  // Mots politiques
  const hasPoliticalWord = tokens.some((t) => POLITICS_TOKENS.has(t));
  if (hasPoliticalWord) return "politics";

  // Combinaisons du type "vive/viva/free" + mot politique
  const hasPrefix = tokens.some((t) => POLITICS_PREFIX.has(t));
  if (hasPrefix && hasPoliticalWord) return "politics";

  return null;
}

// 6) Validation globale — renvoie {ok, value?, reason?}
function validateName(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "empty" };

  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > 30) return { ok: false, reason: "length" };
  if (!NAME_ALLOWED_RE.test(cleaned)) return { ok: false, reason: "charset" };

  const mod = moderationReason(cleaned);
  if (mod) return { ok: false, reason: mod };

  return { ok: true, value: cleaned };
}

// ---------------------------------------------------------------------------
// Splash (écran neutre, plein écran, fond homogène)
// ---------------------------------------------------------------------------
function Splash() {
  return (
    <div
      style={{
        minHeight: "calc(var(--vh, 1vh) * 100)",
        background: "#0a0a1a", // même fond que l'UI Player
      }}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers alpha/tri pour le classement & messages finaux
// ---------------------------------------------------------------------------
function normalizeNameAlpha(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function messageForRank(rank) {
  if (rank === 1) return "Quel talent, tu es premier !";
  if (rank === 2) return "Félicitations, tu termines second !";
  if (rank === 3) return "Bravo, tu es 3e avec un très beau score !";
  if (rank === 4) return "Bravo, tu finis quatrième, si proche du podium !";
  if (Number.isInteger(rank))
    return `C'était le Quiz d'Eley. Tu finis à la ${rank}ᵉ place. Merci pour ta participation !`;
  return "Merci pour ta participation !";
}
function medalForRank(rank) {
  return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "";
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

  /* ======================= ÉTATS & RÉFS (TOP-LEVEL) ======================= */

  const lastNavSeqRef = useRef(null);
  const uiFreezeUntilRef = useRef(0);

  // Mémo: ce joueur a répondu pour la 1ʳᵉ fois *après* le dernier Back sur ce qid
  const answeredAfterBackRef = useRef({}); // { [qid]: boolean }

  // Leaderboard (fin de quiz)
  const [playersLB, setPlayersLB] = useState([]);

  // Id local (persisté)
  const myIdRef = useRef(null);
  useEffect(() => {
    try {
      myIdRef.current =
        localStorage.getItem("playerId") ||
        localStorage.getItem("playerID") ||
        localStorage.getItem("player_id") ||
        null;
    } catch {}
  }, []);

  // Instant win (affichage immédiat + anti double-appel)
  const [instantWin, setInstantWin] = useState(null);
  const lastInstantWinQidRef = useRef(null);

  // Boot flags
  const [hydrated, setHydrated] = useState(false);              // localStorage lu
  const [stateLoaded, setStateLoaded] = useState(false);        // 1er /quiz/state reçu
  const [playerDocLoaded, setPlayerDocLoaded] = useState(false);// 1er doc joueur reçu
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

  // Sentinelle fin de manche (posée côté Admin)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Réponse / saisie
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
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

  // Anti-spam
  const [wrongTimes, setWrongTimes] = useState([]); // timestamps ms des erreurs
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [lockPhraseIndex, setLockPhraseIndex] = useState(null);

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
    } catch {}
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
        });
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

      startTransition(() => {
        setIsKicked(!!d.isKicked);
        if (d.isKicked) {
          setError("Vous avez été retiré de la partie.");
        } else if (d.nameStatus === "rejected") {
          setError("Nom refusé : trouve un autre nom plus adapté à la soirée :)");
          setInputName("");
        } else {
          setError("");
        }
      });

      if (typeof d.name === "string") {
        startTransition(() => {
          setPlayerName(d.name);
        });
        localStorage.setItem("playerName", d.name);
      }
      startTransition(() => setNameLocked(!!d.nameLocked));

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

      startTransition(() => setPlayerDocLoaded(true));
    });

    return () => unsub();
  }, [playerId]);

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

      startTransition(() => {
        setIsRunning(!!d.isRunning);
        setIsPaused(!!d.isPaused);
      });

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

  // 6) Purge blocklist locale à chaque reset global
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};
      const t = d.playersResetAt;
      if (t && typeof t.seconds === "number") {
        const ms = t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
        const prev = Number(localStorage.getItem("playersResetAt") || 0);
        if (!Number.isFinite(prev) || ms > prev) {
          localStorage.setItem("playersResetAt", String(ms));
          localStorage.removeItem("rejectedNamesCache");
          startTransition(() => setRejectedNames([]));
        }
      }
    });
    return () => unsub();
  }, []);

  // 7) Récupérer les questions
  useEffect(() => {
    (async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    })();
  }, []);

  // 8) Config (manches + fin + durée de révélation)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data();
      startTransition(() => {
        setQuizEndSec(typeof d?.endOffsetSec === "number" ? d.endOffsetSec : null);
        setRoundOffsetsSec(
          Array.isArray(d?.roundOffsetsSec)
            ? d.roundOffsetsSec.map((v) => (Number.isFinite(v) ? v : null))
            : []
        );
        const rv = Number.isFinite(d?.revealDurationSec) ? d.revealDurationSec : REVEAL_DURATION_SEC;
        setRevealDurationSec(rv);
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
          isKicked: !!v.isKicked,
        };
      });
      startTransition(() => setPlayersLB(arr));
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
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec]);

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

  const ROUND_DEADZONE_SEC = 1;
  const secondsToRoundBoundary = Number.isFinite(nextRoundStart) ? nextRoundStart - elapsedSec : null;
  const inRoundBoundaryWindow =
    !uiMasked &&
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= ROUND_DEADZONE_SEC &&
    secondsToRoundBoundary >= -0.25;

  let effectiveNextTimeSec = null;
  let nextKind = null; // "question" | "round" | "end"
  const cands = [];
  if (Number.isFinite(nextTimeSec)) cands.push({ t: nextTimeSec, k: "question" });
  if (Number.isFinite(nextRoundBoundary)) cands.push({ t: nextRoundBoundary, k: "round" });
  if (Number.isFinite(quizEndSec)) cands.push({ t: quizEndSec, k: "end" });
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
    ? qStart + ROUND_START_INTRO_SEC
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

  // Le temps utile de réponse commence après l’intro
  const qStartEffective = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + ROUND_START_INTRO_SEC
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

  // Fin de manche (pause posée par Admin à la frontière)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;
  const isRoundBreak = Boolean(isPaused && endedRoundIndex != null);

  // --- Phases
  const nextEvent = effectiveNextTimeSec;
  const revealStart = nextEvent != null ? nextEvent - revealDurationSec : null;
  const countdownStart = nextEvent != null ? nextEvent - COUNTDOWN_START_SEC : null;

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
    ? Math.max(1, Math.min(COUNTDOWN_START_SEC, Math.ceil(secondsToNext)))
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

  // Phrase de révélation + réponse primaire
  const revealPhrase = useMemo(
    () => (currentQuestion ? pickRevealPhrase(currentQuestion) : ""),
    [currentQuestionId]
  );

  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);

  // --- Préchargement image du reveal (anti-flicker)
  const [preloadedImage, setPreloadedImage] = useState(null);
  const currentImageUrl = currentQuestion ? currentQuestion.imageUrl : null;

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
      const u = sorted[k]?.imageUrl;
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
          if (im.decode) im.decode().catch(() => {});
        } catch {}
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
    return (gotNow && noBackSince) || justAnsweredAfterBack;
  }, [qid, result, justAnsweredAfterBack, backTick]);

  // Splash : relâcher après boot initial
  const initialBootReady = hydrated && stateLoaded && (!playerId || playerDocLoaded);
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

  // “Déjà correct” (persiste même après un Back)
  const alreadyCorrect = useMemo(() => {
    const qid = currentQuestionId;
    if (!qid) return false;
    if (answeredAtRef.current[qid] != null) return true;
    if (lastAnswerQidRef.current === qid) return true;
    if (instantWin && instantWin.qid === qid) return true;
    return result === "correct";
  }, [currentQuestionId, instantWin, result]);

  // Ouverture/affichage input
  const answersOpen = Boolean(isQuestionPhase && !isLocked);
  const showInput = Boolean(answersOpen && !hadCorrectEver && !justAnsweredAfterBack);

  // Focus auto si input visible et masque levé
  useEffect(() => {
    if (!uiMasked && showInput) {
      const el = answerInputRef.current;
      if (el && document.activeElement !== el) {
        requestAnimationFrame(() => el.focus());
      }
    }
  }, [uiMasked, showInput, currentQuestionId]);

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

/* ============================ Vérification & Handlers ============================ */

  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;
    const userInput = normalize(answer);
    const accepted = currentQuestion.answers.map(normalize);
    const isCorrect = accepted.some(
      (acc) => acc === userInput || isCloseEnough(userInput, acc)
    );

    if (isCorrect) {
      lastAnswerQidRef.current = currentQuestion?.id || null;
      setResult("correct");
      setAnswer("");

      // Horodatage de la 1re bonne réponse (robuste aux Back)
      if (currentQuestion?.id && Number.isFinite(elapsedSec)) {
        const qid = currentQuestion.id;
        if (answeredAtRef.current[qid] == null) {
          answeredAtRef.current[qid] = elapsedSec;
        }
      }

      const qid = currentQuestion?.id;
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
      setResult("wrong");
      setAnswer("");

      setWrongTimes((prev) => {
        const now = Date.now();
        const pruned = prev.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        const nextArr = [...pruned, now];
        if (RATE_LIMIT_ENABLED && nextArr.length >= MAX_WRONG_ATTEMPTS && !isLocked) {
          setCooldownUntilMs(now + COOLDOWN_MS);
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

  const handleAnswerSubmit = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (isLocked) return;
    const trimmed = (answer ?? "").trim();
    if (!trimmed) return;
    checkAnswer();
  };

  // === Instant win (prédiction rang/points dès qu'une réponse correcte survient) ===
  useEffect(() => {
    const qid = currentQuestionId;
    if (!qid) return;
    if (!(result === "correct" && isQuestionPhase)) return;
    if (lastAnswerQidRef.current !== qid) return;
    if (lastInstantWinQidRef.current === qid) return;
    if (!playerId) return;

    let cancelled = false;
    (async () => {
      try {
        const { predictedRank, predictedPoints } = await recordFirstCorrectAndPredict({
          db,
          qid,
          playerId,
        });
        if (cancelled) return;
        setInstantWin({ qid, rank: predictedRank, points: predictedPoints, at: Date.now() });
        lastInstantWinQidRef.current = qid;

        // Mémorise aussi l’instant de la 1re bonne réponse (utile pour les Back)
        if (Number.isFinite(elapsedSec) && answeredAtRef.current[qid] == null) {
          answeredAtRef.current[qid] = elapsedSec;
        }
      } catch (e) {
        console.error("[instantWin effect] error:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [currentQuestionId, result, isQuestionPhase, playerId, elapsedSec]);

  // ==== Classement (TOP-LEVEL; pas dans une condition) ====
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
  const myScore = useMemo(() => (meRow ? meRow.score : 0), [meRow]);
  const myMedal = useMemo(
    () => (Number(myScore) > 0 ? medalForRank(myRank) : ""),
    [myRank, myScore]
  );
  const myEndMessage = useMemo(() => {
    return Number(myScore) > 0
      ? messageForRank(myRank)
      : "Merci pour ta participation !";
  }, [myRank, myScore]);

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
      if (v.reason === "length") setError("Le nom doit faire entre 1 et 30 caractères.");
      else if (v.reason === "charset") setError("Utilise uniquement lettres FR, chiffres, espaces, apostrophes (’ ') et tirets.");
      else if (v.reason === "politics") setError("Évite les noms à caractère politique. Merci !");
      else if (v.reason === "moderation") setError("Nom inadapté au tout public.");
      else setError("Nom invalide.");
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
        const ref = await addDoc(playersCol, {
          name: v.value,
          nameNorm,
          createdAt: serverTimestamp(),
          score: 0,
          isKicked: false,
          nameStatus: "ok",
          rejectedNames: Array.isArray(rejectedNames) ? rejectedNames : [],
        });
        setPlayerId(ref.id);
        localStorage.setItem("playerId", ref.id);
        localStorage.setItem("playerName", v.value);
        setPlayerName(v.value);
        setInputName("");
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

  async function resetAndDeletePlayer() {
    try {
      selfRenameRef.current = true;
      const pid = playerId || localStorage.getItem("playerId");
      if (pid) {
        const playersCol = collection(doc(db, "quiz", "state"), "players");
        await deleteDoc(doc(playersCol, pid));
      }
    } catch (e) {
      console.error("Suppression du joueur échouée :", e);
    } finally {
      localStorage.removeItem("playerId");
      localStorage.removeItem("playerName");
      startTransition(() => {
        setPlayerId(null);
        setPlayerName("");
        setInputName("");
        setError("");
      });
    }
  }

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

  // 1) Écran d’inscription (nom refusé ou pas encore inscrit)
  if (!playerId || (typeof error === "string" && error.startsWith("Nom refusé"))) {
    return (
      <div
        style={{
          minHeight: "calc(var(--vh, 1vh) * 100)",
          background: "#000814",
          color: "white",
          display: "grid",
          placeItems: "center",
          padding: 24,
          textAlign: "center",
          overflowX: "hidden",
        }}
      >
        <div style={{ width: "min(360px, 100%)", margin: "0 auto" }}>
          <h1 style={{ margin: 0, fontSize: "2rem", fontWeight: 800 }}>
            Bienvenue dans le quiz d’ELEY
          </h1>
          <p style={{ opacity: 0.85, marginTop: 10 }}>
            Choisis ton nom de joueur / team :
          </p>

          <form onSubmit={handleNameSubmit} style={{ marginTop: 12 }}>
            <input
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="text"
              enterKeyHint="send"
              type="text"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              maxLength={30}
              placeholder="ex : Les Quichettes"
              style={{
                width: "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                display: "block",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #334155",
                background: "#0b1220",
                color: "white",
                fontSize: "clamp(14px, 3.9vw, 16px)",
              }}
              autoFocus
            />
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              Lettres FR, chiffres, espaces, apostrophes (’ '), tirets. 1–30 caractères.
            </div>

            {error && (
              <div style={{ marginTop: 8, color: "#fecaca" }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitDisabled}
              style={{
                marginTop: 12,
                width: "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                display: "block",
                padding: "clamp(10px, 2.8vw, 12px) 12px",
                borderRadius: 10,
                border: "1px solid #2a2a2a",
                background: busy ? "#64748b" : "#3b82f6",
                color: "white",
                fontWeight: 700,
                cursor: isSubmitDisabled ? "not-allowed" : "pointer",
                touchAction: "manipulation",
                WebkitTapHighlightColor: "transparent",
                userSelect: "none",
              }}
              title={
                isRejectedInput || isSameAsRejectedCurrent
                  ? "Ce nom a été refusé — choisis-en un autre."
                  : "Valider le nom"
              }
              aria-disabled={isSubmitDisabled ? "true" : "false"}
            >
              {busy ? "Inscription…" : "Entrer"}
            </button>

            {Array.isArray(rejectedNames)
              && rejectedNames.includes(normalizeName(inputName))
              && !isAliasName(inputName) && (
                <div style={{ marginTop: 6, color: "#fbbf24" }}>
                  Ce nom a été refusé par l’animateur. Choisis-en un autre.
                </div>
              )}
          </form>
        </div>
      </div>
    );
  }

  // 2) Écran bloquant si le joueur a été retiré
  if (isKicked && playerId) {
    return (
      <div
        style={{
          background: "#0a0a1a",
          color: "#fff",
          minHeight: "calc(var(--vh, 1vh) * 100)",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          textAlign: "center",
          overflowX: "hidden",
        }}
      >
        <div style={{ width: "min(380px, 100%)", margin: "0 auto" }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0 }}>
            ELEY&nbsp;Quiz — Accès retiré
          </h1>
          <p style={{ opacity: 0.85, marginTop: 12 }}>
            Vous avez été retiré de la partie par l’animateur.
          </p>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            (Si c’est une erreur, rapprochez-vous de l’animateur.)
          </div>
        </div>
      </div>
    );
  }

  // 3) Écran d’attente une fois inscrit (avant lancement par l’Admin)
  if (showPreStart && playerId) {
    return (
      <div
        style={{
          background: "#0a0a1a",
          color: "#fff",
          minHeight: "calc(var(--vh, 1vh) * 100)",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <div style={{ width: "min(380px, 100%)", margin: "0 auto" }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0 }}>
            ELEY&nbsp;Quiz — En attente du départ
          </h1>
        </div>

        <div style={{ width: "min(380px, 100%)", margin: "12px auto 0", textAlign: "center" }}>
          <p style={{ opacity: 0.85 }}>
            {playerName ? <>Tu es inscrit comme <b>{playerName}</b>.<br /></> : null}
            L’Admin n’a pas encore lancé le quiz.
          </p>

          {(!nameLocked && !isRunning) ? (
            <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
              Envie de changer de nom ?{" "}
              <button
                onClick={resetAndDeletePlayer}
                style={{
                  color: "#93c5fd",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Modifier mon nom
              </button>
            </div>
          ) : (
            nameLocked && (
              <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
                Ton nom a été fixé par l’animateur.
              </div>
            )
          )}
        </div>
      </div>
    );
  }

// ============================================================================
// /pages/player.js — Partie 5/6
// Scope : Écran principal pendant le quiz — overlay anti-flicker, timer,
//         badge nom, fin de quiz / fin de manche / pause, phases (question /
//         reveal / décompte), barre de temps, image, score, saisie + anti-spam,
//         bannière de bonne réponse, styles d’animations.
// ============================================================================

  // 4) Écran principal pendant le quiz
  return (
    <div
      style={{
        background: "#0a0a1a",
        color: "white",
        padding: "20px",
        minHeight: "calc(var(--vh, 1vh) * 100)",
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
          background: "#020617",          // bleu nuit
          opacity: uiMasked ? 0.96 : 0,
          transition: "opacity 120ms ease",
          pointerEvents: "none",
          zIndex: 50,
        }}
      />

      {/* Timer discret en haut-droite */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          background: "#111",
          padding: "6px 10px",
          borderRadius: 8,
          fontFamily: "monospace",
          letterSpacing: 1,
          border: "1px solid #2a2a2a",
        }}
      >
        ⏱ {formatHMS(elapsedSec)}
      </div>

      {/* Badge nom joueur en haut-gauche */}
      {isRunning && playerName && (
        <div
          style={{
            position: "fixed",
            top: 10,
            left: 10,
            zIndex: 20,
            background: "#0b1e3d",
            border: "1px solid #1f2a44",
            borderRadius: 9999,
            padding: "6px 10px",
            fontSize: 14,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
          aria-label="Nom du joueur"
          title={nameLocked ? "Nom verrouillé" : "Nom du joueur"}
        >
          <span>👤</span>
          <b style={{ letterSpacing: 0.2 }}>{playerName}</b>
          {nameLocked && <span style={{ opacity: 0.7, marginLeft: 6 }}>🔒</span>}
        </div>
      )}

      {/* ====================== Branches principales d’affichage ====================== */}

      {/* Fin du quiz : message perso + classement */}
      {isQuizEnded ? (
        <>
          <h2 style={{ fontSize: "2rem", marginTop: 24 }}>Fin du quiz</h2>
          <div
            style={{
              marginTop: 8,
              padding: 12,
              borderRadius: 12,
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "clamp(1.1rem, 4.8vw, 1.5rem)", fontWeight: 800 }}>
              {myMedal ? `${myMedal} ` : ""}{myEndMessage}
            </div>
            {myRank != null && (
              <div style={{ marginTop: 6, opacity: 0.9, fontSize: "clamp(0.95rem, 3.8vw, 1rem)" }}>
                Ton score : <b>{myScore}</b> • Classement : <b>{Number(myScore) > 0 ? `#${myRank}` : "dernier"}</b>
              </div>
            )}
          </div>
        </>
      ) : isRoundBreak ? (
        // Fin de manche — priorité absolue
        <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
          <h2 style={{ fontSize: "1.8rem", margin: 0 }}>
            Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
          </h2>
          <div style={{ opacity: 0.85, fontSize: 14, marginTop: 8 }}>
            (pause de manche)
          </div>
          <div style={{ marginTop: 10, opacity: 0.9 }}>
            Ton score actuel est : <b>{myScore}</b>
          </div>
          {myRank != null && (
            <div
              style={{
                marginTop: 6,
                opacity: 0.9,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {myMedal ? <span aria-label="médaille" title="médaille">{myMedal}</span> : null}
              <span>Tu es {Number(myScore) > 0 ? (myRank === 1 ? "1er" : `${myRank}ᵉ`) : "dernier"} dans le classement</span>
            </div>
          )}
        </div>
      ) : inRoundBoundaryWindow ? (
        // Fenêtre morte juste avant la frontière
        <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(1.2rem, 5.3vw, 1.8rem)", margin: 0 }}>
            Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
          </h2>
          <div style={{ opacity: 0.85, fontSize: 14, marginTop: 8 }}>(transition…)</div>
        </div>
      ) : isPaused ? (
        // Pause manuelle
        <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
          <h2 style={{ fontSize: "1.8rem", margin: 0 }}>On revient dans un instant…</h2>
          <div style={{ opacity: 0.75, marginTop: 8, fontSize: 14 }}>
            Le quiz est momentanément en pause.
          </div>

          {/* Info (pause) : même logique que la bannière question */}
          {currentQuestion && (hadCorrectEver || showGoodNow) && (
            <div style={{ marginTop: 10, fontSize: 14, opacity: 0.9 }}>
              {showGoodNow ? "Bonne réponse !" : "Tu as déjà bien répondu à cette question"}
              {Number.isFinite(gainedPoints) ? <> (+{gainedPoints} pts)</> : null}
            </div>
          )}
        </div>
      ) : currentQuestion ? (
        <>
          {/* ======================== Phases de la question ======================== */}

          {/* Intro de manche */}
          {isRoundIntroPhase ? (
            <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>
                {roundNumberForIntro ? `La manche ${roundNumberForIntro} commence dans :` : "La manche commence dans :"}
              </div>
              <div style={{ fontSize: "clamp(2.4rem, 12vw, 4rem)", fontWeight: 800, lineHeight: 1 }}>
                {introCountdownSec}
              </div>
            </div>
          ) : isQuestionPhase ? (
            // Phase question
            <h2 style={{ fontSize: "1.5rem" }}>{currentQuestion.text}</h2>
          ) : isRevealAnswerPhase ? (
            // Révélation de la réponse
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>
                {revealPhrase}
              </div>
              <h2
                style={{
                  fontSize: "clamp(1.2rem, 5vw, 1.6rem)",
                  margin: 0,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  hyphens: "auto",
                }}
              >
                {primaryAnswer}
              </h2>
            </div>
          ) : isCountdownPhase ? (
            // Décompte avant prochaine échéance
            <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>
                {countdownLabel}
              </div>
              <div style={{ fontSize: "clamp(2.4rem, 12vw, 4rem)", fontWeight: 800, lineHeight: 1 }}>
                {countdownSec}
              </div>
            </div>
          ) : (
            // Fallback conservateur
            <h2
              style={{
                fontSize: "clamp(1.1rem, 4.5vw, 1.5rem)",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                hyphens: "auto",
                margin: 0,
              }}
            >
              {currentQuestion.text}
            </h2>
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
                width: PLAYER_IMG_MAX,
                height: PLAYER_IMG_MAX,
                maxWidth: "100%",
                margin: "16px auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#111",
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

          {/* Score (révélé pour tous pendant le reveal) */}
          {isRevealAnswerPhase && (
            <div style={{ marginTop: 8, fontWeight: 700 }}>
              Ton score actuel est de : <b>{myScore}</b>
            </div>
          )}

          {/* -------------------- Saisie + anti-spam / cooldown -------------------- */}
          <form onSubmit={handleAnswerSubmit}>
            {showInput ? (
              <input
                ref={answerInputRef}
                className="answerInput"
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Votre réponse"
                style={{
                  width: "min(520px, 100%)",
                  maxWidth: "92vw",
                  boxSizing: "border-box",
                  padding: "clamp(10px, 2.8vw, 12px)",
                  marginTop: "16px",
                  fontSize: "clamp(14px, 3.9vw, 16px)",
                  visibility: uiMasked ? "hidden" : "visible", // pas d’autofocus tant que masque actif
                }}
                autoFocus={!uiMasked}
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
              />
            ) : isLocked && isQuestionPhase ? (
              <p
                style={{
                  color: "#f59e0b",
                  fontWeight: 800,
                  fontSize: "1.2rem",
                  marginTop: 16,
                }}
              >
                {lockText} ({lockRemainingSec}s)
              </p>
            ) : null}
          </form>

          {/* Bannière “bonne réponse” persistante pendant la phase question */}
          {isQuestionPhase && (hadCorrectEver || showGoodNow) && (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #2a2a2a",
                background: "#0b3a1e",
                fontWeight: 700,
              }}
            >
              {showGoodNow ? "Bonne réponse !" : "Tu as déjà bien répondu à cette question"}
              {Number.isFinite(gainedPoints) ? ` +${gainedPoints} pts` : ""}{" "}
              {instantWin?.rank ? medalForRank(instantWin.rank) : ""}
            </div>
          )}
        </>
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

      {/* ============================== Styles locaux ============================== */}
      <style jsx>{`
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
    </div>
  );
}
