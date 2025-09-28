// /pages/player.js
import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/firebase";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  addDoc,
  updateDoc,
  where,
  serverTimestamp,
  deleteDoc,
} from "firebase/firestore";

/* ============================== CONSTANTES ============================== */
// Anti-spam
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

  // Mots politiques (si un token politique apparaît)
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

function Splash() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a1a", // même fond que l'UI Player
      }}
      aria-hidden="true"
    />
  );
}

/* =============================== COMPOSANT =============================== */
export default function Player() {
  const [hydrated, setHydrated] = useState(false);            // localStorage lu
  const [stateLoaded, setStateLoaded] = useState(false);       // 1er /quiz/state reçu
  const [playerDocLoaded, setPlayerDocLoaded] = useState(false); // 1er doc joueur reçu
  const [splashReleased, setSplashReleased] = useState(false); // Splash affiché seulement au premier boot

  /* -------- Données & timing -------- */
  const [questionsList, setQuestionsList] = useState([]);

  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  const [quizEndSec, setQuizEndSec] = useState(null);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([]);

  // Inscription
  const [playerId, setPlayerId] = useState(null);
  const [playerName, setPlayerName] = useState("");
  const [inputName, setInputName] = useState("");
  const [nameLocked, setNameLocked] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isKicked, setIsKicked] = useState(false);
  const [rejectedNames, setRejectedNames] = useState([]);
  const selfRenameRef = useRef(false); // true si le joueur déclenche "Modifier mon nom"

  // Fin de manche (pilotée via /quiz/state)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Joueur / input
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
  const answerInputRef = useRef(null);

  // Anti-spam
  const [wrongTimes, setWrongTimes] = useState([]); // timestamps ms des erreurs
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [lockPhraseIndex, setLockPhraseIndex] = useState(null);

  /* =============================== Effects =============================== */

  // Charger identité locale
  const pendingResetRef = useRef(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("reset") === "1") {
      pendingResetRef.current = true; // on note la demande
      url.searchParams.delete("reset"); // on nettoie l'URL
      window.history.replaceState({}, "", url.toString());
    } else {
      const pid = localStorage.getItem("playerId");
      const pname = localStorage.getItem("playerName");
      if (pid) setPlayerId(pid);
      if (pname) setPlayerName(pname);
    }

    // Recharger la cache locale des noms refusés
    try {
      const raw = localStorage.getItem("rejectedNamesCache");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setRejectedNames(arr);
      }
    } catch { }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!pendingResetRef.current) return;
    if (isRunning) {
      // Quiz lancé → on ignore la demande utilisateur
      pendingResetRef.current = false;
      return;
    }
    // Quiz pas lancé → on autorise le "Modifier mon nom" via resetAndDeletePlayer
    pendingResetRef.current = false;
    resetAndDeletePlayer();
  }, [isRunning]);

  // Suivre mon doc joueur pour voir si refusé / kické / verrouillé
  useEffect(() => {
    if (!playerId) return;
    
    const playersCol = collection(doc(db, "quiz", "state"), "players");
    const ref = doc(playersCol, playerId);

    const unsub = onSnapshot(ref, (snap) => {
      // 1) Le doc n'existe plus
      if (!snap.exists()) {
        const selfInitiated = selfRenameRef.current === true;
        selfRenameRef.current = false;

        // Invalider l'identité locale
        localStorage.removeItem("playerId");
        localStorage.removeItem("playerName");
        setPlayerId(null);
        setPlayerName("");
        setInputName("");
        setError("");
        setIsKicked(false);

        if (!selfInitiated) {
          // Reset Admin → purge aussi la blocklist locale
          localStorage.removeItem("rejectedNamesCache");
          setRejectedNames([]);
        }
        return;
      }

      // 2) Le doc existe : lecture des champs
      const d = snap.data() || {};

      // KICK → écran bloquant + message
      setIsKicked(!!d.isKicked);
      if (d.isKicked) {
        setError("Vous avez été retiré de la partie.");
      } else if (d.nameStatus === "rejected") {
        // Nom refusé par l’admin → retour au formulaire avec champ vidé
        setError("Nom refusé : trouve un autre nom plus adapté à la soirée :)");
        setInputName(""); // on efface pour réafficher le placeholder
      } else {
        setError("");
      }

      // Nom courant (affichage / badge)
      if (typeof d.name === "string") {
        setPlayerName(d.name);
        localStorage.setItem("playerName", d.name);
      }

      // Verrouillage (après “Player N”)
      setNameLocked(!!d.nameLocked);

      // 3) Blocklist (noms refusés) : serveur + cache local (union)
      let serverRejected = Array.isArray(d.rejectedNames) ? d.rejectedNames : [];

      // Filtre défensif : on ne garde pas les alias "player N"
      serverRejected = serverRejected.filter((n) => !isAliasName(n));

      // Charger le cache local (tolérant)
      let prev = [];
      try {
        const raw = localStorage.getItem("rejectedNamesCache");
        prev = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(prev)) prev = [];
      } catch {
        prev = [];
      }

      // Union unique (serveur ∪ cache local), en filtrant aussi le local par sécurité
      const union = Array.from(new Set([...prev.filter((n) => !isAliasName(n)), ...serverRejected]));

      // Persister et mémoriser
      localStorage.setItem("rejectedNamesCache", JSON.stringify(union));
      setRejectedNames(union);
      setPlayerDocLoaded(true);
    });

    return () => unsub();
  }, [playerId]);

  useEffect(() => {
    if (!playerId) setPlayerDocLoaded(true);
  }, [playerId]);

  // État "running" simple (utilisé pour l'écran d'attente et reset URL)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};
      setIsRunning(!!d.isRunning);
    });
    return () => unsub();
  }, []);

  //forcer la purge locale
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};
      const t = d.playersResetAt;
      if (t && typeof t.seconds === "number") {
        const ms = t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
        const prev = Number(localStorage.getItem("playersResetAt") || 0);
        if (!Number.isFinite(prev) || ms > prev) {
          // Nouveau reset détecté → purge des caches liés aux noms refusés
          localStorage.setItem("playersResetAt", String(ms));
          localStorage.removeItem("rejectedNamesCache");
          setRejectedNames([]);
        }
      }
    });
    return () => unsub();
  }, []);

  // Récup questions
  useEffect(() => {
    (async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    })();
  }, []);

  // État live (Timestamp OU startEpochMs)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};

      // startMs depuis startAt (Timestamp) OU startEpochMs (number)
      let startMs = null;
      if (d.startAt && typeof d.startAt.seconds === "number") {
        startMs = d.startAt.seconds * 1000 + Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      } else if (typeof d.startEpochMs === "number") {
        startMs = d.startEpochMs;
      }

      setIsRunning(!!d.isRunning);
      setIsPaused(!!d.isPaused);

      if (!startMs) {
        setQuizStartMs(null);
        setPauseAtMs(null);
        setElapsedSec(0);
        setAnswer("");
        setResult(null);
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

  // Config (manches + fin)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data();
      setQuizEndSec(typeof d?.endOffsetSec === "number" ? d.endOffsetSec : null);
      setRoundOffsetsSec(
        Array.isArray(d?.roundOffsetsSec) ? d.roundOffsetsSec.map((v) => (Number.isFinite(v) ? v : null)) : []
      );
    });
    return () => unsub();
  }, []);

  // Timer local (avec clamp fin de quiz)
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

    const computeNow = () => Math.floor((Date.now() - quizStartMs) / 1000);
    const first = computeNow();
    if (Number.isFinite(quizEndSec) && first >= quizEndSec) {
      setElapsedSec(Math.max(0, quizEndSec));
      return;
    }
    setElapsedSec(first < 0 ? 0 : first);

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
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec]);

  // Ticker cooldown (anti-spam)
  useEffect(() => {
    if (!cooldownUntilMs) return;
    const id = setInterval(() => setCooldownTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [cooldownUntilMs]);

  /* ===================== Dérivés & calculs d'écran ===================== */
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

  // Question courante (dernière question dans la fenêtre de la manche actuelle)
  let activeIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (!Number.isFinite(t) || t < currentRoundStart) continue;
    if (t <= elapsedSec && t < currentRoundEnd) activeIndex = i;
    else if (t >= currentRoundEnd) break;
  }
  const currentQuestion = activeIndex >= 0 ? sorted[activeIndex] : null;

  // Prochaine question
  let nextTimeSec = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (Number.isFinite(t) && t > elapsedSec) {
      nextTimeSec = t;
      break;
    }
  }

  // Prochaine échéance (min question / frontière de manche / fin de quiz)
  const GAP = 1;
  const nextRoundStart = nextRoundStartAfter(elapsedSec, roundOffsetsSec);
  const nextRoundBoundary = Number.isFinite(nextRoundStart) ? Math.max(0, nextRoundStart - GAP) : null;

  const ROUND_DEADZONE_SEC = 1;
  const secondsToRoundBoundary = Number.isFinite(nextRoundStart) ? nextRoundStart - elapsedSec : null;
  const inRoundBoundaryWindow =
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= ROUND_DEADZONE_SEC &&
    secondsToRoundBoundary >= -0.25; // petite tolérance

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

  // Bornes de la question courante
  const qStart = Number.isFinite(getTimeSec(currentQuestion)) ? getTimeSec(currentQuestion) : null;
  const boundary = effectiveNextTimeSec;
  const qEnd = boundary != null ? boundary - REVEAL_DURATION_SEC : null;

  // 1ʳᵉ question de la manche courante ?
  const firstQuestionTimeInCurrentRound = (() => {
    for (let i = 0; i < sorted.length; i++) {
      const t = getTimeSec(sorted[i]);
      if (!Number.isFinite(t)) continue;
      if (t >= currentRoundStart && t < currentRoundEnd) return t; // sorted asc → premier suffit
    }
    return null;
  })();

  const isFirstQuestionOfRound =
    Number.isFinite(qStart) &&
    Number.isFinite(firstQuestionTimeInCurrentRound) &&
    qStart === firstQuestionTimeInCurrentRound;

  // Fenêtre d’intro (compte à rebours 5→1) au S.D. de la 1ʳᵉ question de la manche
  const introStart = isFirstQuestionOfRound ? qStart : null;
  const introEnd = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + ROUND_START_INTRO_SEC
    : null;

  const isRoundIntroPhase = Boolean(
    isFirstQuestionOfRound &&
    !isPaused &&
    !(isPaused && Number.isInteger(lastAutoPausedRoundIndex)) &&
    introStart != null &&
    elapsedSec >= introStart &&
    elapsedSec < introEnd
  );

  // Le temps “utilisable” pour répondre commence après l’intro
  const qStartEffective = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + ROUND_START_INTRO_SEC
    : qStart;

  // Compte à rebours affiché 5..1
  const introCountdownSec = isRoundIntroPhase
    ? Math.max(1, Math.ceil((introEnd ?? 0) - elapsedSec))
    : null;

  // Numéro de manche pour l’UI
  const roundIdxForCurrentQuestion = Number.isFinite(qStart)
    ? roundIndexOfTime(Math.max(0, qStart), roundOffsetsSec)
    : null;
  const roundNumberForIntro = roundIdxForCurrentQuestion != null ? roundIdxForCurrentQuestion + 1 : null;

  // Fin de manche (pause posée à la frontière par l’admin)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;
  const isRoundBreak = Boolean(isPaused && endedRoundIndex != null);

  // Phases
  const nextEvent = effectiveNextTimeSec;
  const revealStart = nextEvent != null ? nextEvent - REVEAL_DURATION_SEC : null;
  const countdownStart = nextEvent != null ? nextEvent - COUNTDOWN_START_SEC : null;

  const isQuestionPhase = Boolean(
    currentQuestion &&
    qStartEffective != null &&
    nextEvent != null &&
    elapsedSec >= qStartEffective &&
    elapsedSec < revealStart &&
    !isPaused &&
    !isRoundBreak
  );

  const isRevealAnswerPhase = Boolean(
    currentQuestion &&
    revealStart != null &&
    countdownStart != null &&
    elapsedSec >= revealStart &&
    elapsedSec < countdownStart &&
    !isPaused &&
    !isRoundBreak
  );

  const isCountdownPhase = Boolean(
    currentQuestion &&
    countdownStart != null &&
    nextEvent != null &&
    elapsedSec >= countdownStart &&
    elapsedSec < nextEvent &&
    !isPaused &&
    !isRoundBreak
  );

  // Décompte (jamais 0s)
  const secondsToNext = nextEvent != null ? nextEvent - elapsedSec : null;
  const countdownSec = isCountdownPhase
    ? Math.max(1, Math.min(COUNTDOWN_START_SEC, Math.ceil(secondsToNext)))
    : null;

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

  // Reset UI quand la question change
  const currentQuestionId = currentQuestion?.id ?? null;
  useEffect(() => {
    setResult(null);
    setAnswer("");
    setWrongTimes([]);
    setCooldownUntilMs(null);
    setLockPhraseIndex(null);
  }, [currentQuestionId]);

  const revealPhrase = useMemo(
    () => (currentQuestion ? pickRevealPhrase(currentQuestion) : ""),
    [currentQuestionId]
  );
  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);

  // Anti-spam (dérivés)
  const nowMs = Date.now() + cooldownTick; // force re-render pendant cooldown
  const isLocked = RATE_LIMIT_ENABLED && cooldownUntilMs != null && nowMs < cooldownUntilMs;
  const lockRemainingSec = isLocked ? Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000)) : 0;
  const lockText =
    lockPhraseIndex != null && LOCK_PHRASES[lockPhraseIndex]
      ? LOCK_PHRASES[lockPhraseIndex]
      : LOCK_PHRASES[0];

  // Conditions input
  const answersOpen = Boolean(isQuestionPhase && !isLocked);
  const showInput = Boolean(answersOpen && result !== "correct");

  /* ============================ Vérification ============================ */
  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;
    const userInput = normalize(answer);
    const accepted = currentQuestion.answers.map(normalize);
    const isCorrect = accepted.some(
      (acc) => acc === userInput || isCloseEnough(userInput, acc)
    );

    if (isCorrect) {
      setResult("correct");
      setAnswer("");
    } else {
      setResult("wrong");
      setAnswer("");

      // fenêtre glissante 15s
      setWrongTimes((prev) => {
        const now = Date.now();
        const pruned = prev.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        const nextArr = [...pruned, now];
        if (RATE_LIMIT_ENABLED && nextArr.length >= MAX_WRONG_ATTEMPTS && !isLocked) {
          setCooldownUntilMs(now + COOLDOWN_MS);
          setLockPhraseIndex(() => Math.floor(Math.random() * LOCK_PHRASES.length));
          return []; // reset après blocage
        }
        return nextArr;
      });

      // refocus + animations
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

  // Préchargement image
  useEffect(() => {
    if (currentQuestion?.imageUrl) {
      const img = new Image();
      img.src = currentQuestion.imageUrl;
    }
  }, [currentQuestion?.imageUrl]);

  const showPreStart = !(quizStartMs && isRunning);
  const isQuizEnded = typeof quizEndSec === "number" && elapsedSec >= quizEndSec;

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

    // Blocklist locale/serveur — alias "Player N" autorisé
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
        // 1ʳᵉ inscription : créer un doc
        const ref = await addDoc(playersCol, {
          name: v.value,
          nameNorm,
          createdAt: serverTimestamp(),
          score: 0,
          isKicked: false,
          nameStatus: "ok",
          rejectedNames: Array.isArray(rejectedNames) ? rejectedNames : [], // réinjecte l’historique local
        });
        setPlayerId(ref.id);
        localStorage.setItem("playerId", ref.id);
        localStorage.setItem("playerName", v.value);
        setPlayerName(v.value);
        setInputName("");
      } else {
        // Renommage (après refus ou volontaire)
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
      selfRenameRef.current = true; // indique que la suppression du doc vient du joueur
      const pid = playerId || localStorage.getItem("playerId");
      if (pid) {
        const playersCol = collection(doc(db, "quiz", "state"), "players");
        await deleteDoc(doc(playersCol, pid)); // supprime le doc joueur
      }
    } catch (e) {
      console.error("Suppression du joueur échouée :", e);
      // On continue malgré tout pour nettoyer localement
    } finally {
      localStorage.removeItem("playerId");
      localStorage.removeItem("playerName");
      setPlayerId(null);
      setPlayerName("");
      setInputName("");
      setError("");
    }
  }

  // Flags d’état pour le bouton
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

  // Bouton désactivé si occupation, ou nom refusé (hors alias), ou même nom refusé courant (hors alias)
  const isSubmitDisabled = busy || isRejectedInput || isSameAsRejectedCurrent;

  /* ================================ RENDER =============================== */
  // Garde initiale : on attend la toute première disponibilité, puis on "relâche" le Splash définitivement
  const initialBootReady = hydrated && stateLoaded && (!playerId || playerDocLoaded);

  // dès que le boot initial est prêt une fois, on ne réaffiche plus jamais le Splash (même si playerDocLoaded rebouge)
  useEffect(() => {
    if (initialBootReady) setSplashReleased(true);
  }, [initialBootReady]);

  if (!splashReleased) return <Splash />;


  // 1) Écran d’inscription (P6)
  if (!playerId || (typeof error === "string" && error.startsWith("Nom refusé"))) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#000814",
          color: "white",
          display: "grid",
          placeItems: "center",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div style={{ width: 380, maxWidth: "90vw" }}>
          <h1 style={{ margin: 0, fontSize: "2rem", fontWeight: 800 }}>
            Bienvenue dans le quiz d’ELEY
          </h1>
          <p style={{ opacity: 0.85, marginTop: 10 }}>
            Choisis ton nom de joueur / team :
          </p>

          <form onSubmit={handleNameSubmit} style={{ marginTop: 12 }}>
            <input
              type="text"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              maxLength={30}
              placeholder="ex : Les Quichettes"
              style={{
                width: "100%", padding: "10px 12px",
                borderRadius: 10, border: "1px solid #334155",
                background: "#0b1220", color: "white", fontSize: 16,
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
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #2a2a2a",
                background: busy ? "#64748b" : "#3b82f6",
                color: "white",
                fontWeight: 700,
                cursor: isSubmitDisabled ? "not-allowed" : "pointer",
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

  // Écran bloquant si le joueur a été retiré
  if (isKicked && playerId) {
    return (
      <div
        style={{
          background: "#0a0a1a",
          color: "#fff",
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <div style={{ width: 380, maxWidth: "90vw" }}>
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

  // Écran d’attente une fois inscrit (avant le lancement par l’Admin)
  if (showPreStart && playerId) {
    return (
      <div
        style={{
          background: "#0a0a1a",
          color: "#fff",
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <div style={{ width: 380, maxWidth: "90vw" }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0 }}>
            ELEY&nbsp;Quiz — En attente du départ
          </h1>
          <p style={{ opacity: 0.85, marginTop: 12 }}>
            {playerName ? <>Tu es inscrit comme <b>{playerName}</b>.<br /></> : null}
            L’Admin n’a pas encore lancé le quiz.
          </p>

          {(!nameLocked && !isRunning) ? (
            <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
              Envie de changer de nom ?{" "}
              <button
                onClick={resetAndDeletePlayer}
                style={{ color: "#93c5fd", background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
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

  return (
    <div
      style={{
        background: "#0a0a1a",
        color: "white",
        padding: "20px",
        minHeight: "100vh",
        textAlign: "center",
        position: "relative",
      }}
    >
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

      {/* Badge nom joueur en haut (quiz lancé) */}
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

      {isQuizEnded ? (
        <>
          <h2 style={{ fontSize: "2rem", marginTop: 24 }}>Fin du quiz</h2>
          <p style={{ fontSize: "1.2rem", opacity: 0.9 }}>Bravo, tu es troisième !</p>
        </>
      ) : isRoundBreak ? (
        // Fin de manche — priorité absolue
        <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
          <h2 style={{ fontSize: "1.8rem", margin: 0 }}>
            Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
          </h2>
          <div style={{ opacity: 0.85, fontSize: 14, marginTop: 8 }}>
            (placeholder scoring)
          </div>
        </div>
      ) : inRoundBoundaryWindow ? (
        // Fenêtre morte juste avant la frontière
        <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
          <h2 style={{ fontSize: "1.8rem", margin: 0 }}>
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
        </div>
      ) : currentQuestion ? (
        <>
          {/* question / révélation / décompte */}
          {isRoundIntroPhase ? (
            <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>
                {roundNumberForIntro ? `La manche ${roundNumberForIntro} commence dans :` : "La manche commence dans :"}
              </div>
              <div style={{ fontSize: "4rem", fontWeight: 800, lineHeight: 1 }}>
                {introCountdownSec}
              </div>
            </div>
          ) : isQuestionPhase ? (
            <h2 style={{ fontSize: "1.5rem" }}>{currentQuestion.text}</h2>
          ) : isRevealAnswerPhase ? (
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>
                {revealPhrase}
              </div>
              <h2 style={{ fontSize: "1.6rem", margin: 0 }}>{primaryAnswer}</h2>
            </div>
          ) : isCountdownPhase ? (
            <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>
                {countdownLabel}
              </div>
              <div style={{ fontSize: "4rem", fontWeight: 800, lineHeight: 1 }}>
                {countdownSec}
              </div>
            </div>
          ) : (
            // Fallback conservateur
            <h2 style={{ fontSize: "1.5rem" }}>{currentQuestion.text}</h2>
          )}

          {/* Barre de temps */}
          {canShowTimeBar && (
            <div
              style={{
                width: "min(700px, 92%)",
                height: BAR_H,
                margin: "12px auto 10px",
                background: BAR_BLUE,
                borderRadius: 9999,
                overflow: "hidden",
                position: "relative",
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

          {/* Image pendant la révélation */}
          {isRevealAnswerPhase && !isRoundBreak && currentQuestion?.imageUrl ? (
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
                src={currentQuestion.imageUrl}
                alt="Réponse visuelle — œuvre"
                style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "auto" }}
                loading="lazy"
                decoding="async"
              />
            </div>
          ) : null}

          {/* Saisie / anti-spam */}
          <form onSubmit={handleAnswerSubmit}>
            {showInput ? (
              <input
                ref={answerInputRef}
                className="answerInput"
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Votre réponse"
                style={{ width: "80%", padding: "10px", marginTop: "20px" }}
                autoFocus
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

          {result === "correct" && isQuestionPhase && (
            <p
              style={{
                color: "lime",
                fontSize: "2.2rem",
                fontWeight: 800,
                marginTop: 20,
              }}
            >
              Bonne réponse
            </p>
          )}
        </>
      ) : (
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

      {/* Animations wrong-answer */}
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
