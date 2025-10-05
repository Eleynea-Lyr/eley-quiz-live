// /pages/admin.js
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
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

/* ========================= COULEURS & HELPERS JOUEURS ========================= */

const PLAYER_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635",
  "#34d399", "#22d3ee", "#60a5fa", "#818cf8",
  "#a78bfa", "#f472b6", "#fda4af", "#f59e0b",
  "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6",
];

// Normalisation alpha (casse/accents-insensible)
function normKey(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function pickColorDifferent(prev) {
  const pool = PLAYER_COLORS.filter((c) => c !== prev);
  const bag = pool.length ? pool : PLAYER_COLORS;
  return bag[Math.floor(Math.random() * bag.length)];
}

/* ========================= DEFAULTS & CONSTANTES GLOBALES ========================= */

const DEFAULT_SCORING_TABLE = [30, 25, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const DEFAULT_REVEAL_DURATION_SEC = 20;   // 15s affichage + 5s décompte
const DEFAULT_LEADERBOARD_TOP_N = 20;

const TIME_MUSIC_MIN_SEC = 20;     // reveal incompressible
const DEFAULT_TIME_MUSIC_SEC = 35; // ex: 15s jeu + 20s reveal

function clampTimeMusicSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return DEFAULT_TIME_MUSIC_SEC;
  return Math.max(TIME_MUSIC_MIN_SEC, Math.floor(n));
}

/* =================== CONFIG PAR DÉFAUT (IDEMPOTENT) =================== */

async function ensureConfigDefaults() {
  const cfgRef = doc(db, "quiz", "config");
  const snap = await getDoc(cfgRef);
  const data = snap.exists() ? snap.data() : {};

  const patch = {};
  if (!("scoringTable" in data)) patch.scoringTable = DEFAULT_SCORING_TABLE;
  if (!("revealDurationSec" in data)) patch.revealDurationSec = DEFAULT_REVEAL_DURATION_SEC;
  if (!("leaderboardTopN" in data)) patch.leaderboardTopN = DEFAULT_LEADERBOARD_TOP_N;

  if (Object.keys(patch).length > 0) {
    await setDoc(cfgRef, patch, { merge: true });
  }
}

/* ========== SCORING (CACHE) ========== */

let _cachedScoringTable = null;
async function getScoringTableAdmin() {
  if (_cachedScoringTable) return _cachedScoringTable;
  try {
    const cfgRef = doc(db, "quiz", "config");
    const snap = await getDoc(cfgRef);
    const tbl = (snap.exists() && Array.isArray(snap.data().scoringTable))
      ? snap.data().scoringTable
      : DEFAULT_SCORING_TABLE;
    _cachedScoringTable = tbl;
    return tbl;
  } catch (e) {
    console.error("[Admin/getScoringTableAdmin] fallback:", e);
    _cachedScoringTable = DEFAULT_SCORING_TABLE;
    return DEFAULT_SCORING_TABLE;
  }
}

/* ========== ATTRIBUTION TRANSACTIONNELLE (ANTI-DOUBLONS) ========== */
// PATCH(Admin): robust awards TX (aligné sur Screen)
async function ensureAwardsForQuestionTx(qid) {
  if (!qid) return { ok: false, reason: "no-qid" };

  // 1) Lire toutes les bonnes réponses (sans orderBy)
  const subsCol = collection(db, "answers", qid, "submissions");
  let subsSnap;
  try {
    subsSnap = await getDocs(query(subsCol, where("isCorrect", "==", true)));
  } catch (e) {
    console.error("[Admin] read submissions failed:", e);
    return { ok: false, reason: "read-failed" };
  }

  // 2) Normaliser un "temps" en ms pour trier localement (plusieurs schémas possibles)
  function toMs(obj) {
    if (!obj) return Infinity;
    if (typeof obj.toMillis === "function") return obj.toMillis();
    if (typeof obj.seconds === "number") {
      return obj.seconds * 1000 + Math.floor((obj.nanoseconds || obj.nanos || 0) / 1e6);
    }
    if (typeof obj === "number" && Number.isFinite(obj)) return Math.floor(obj);
    return Infinity;
  }

  const raw = subsSnap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
  const ranked = raw
    .map(({ id, data }) => {
      const candidates = [
        toMs(data.firstCorrectAt),
        toMs(data.firstCorrectAtMs),
        toMs(data.createdAt),
        toMs(data.updatedAt),
      ];
      const t = Math.min(...candidates);
      return { id, t };
    })
    .filter(x => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

  if (ranked.length === 0) {
    console.warn("[Admin] no correct submissions for qid=", qid);
    return { ok: true, reason: "no-correct-submissions" };
  }

  const table = await getScoringTableAdmin();
  const qDocRef = doc(db, "answers", qid);
  const playersCol = collection(doc(db, "quiz", "state"), "players");

  // 3) TX: idempotence + attributions
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(qDocRef);
    if (snap.exists() && snap.data()?.awarded === true) {
      return { ok: true, reason: "already-awarded" };
    }

    tx.set(qDocRef, {
      awarded: true,
      awardedAt: serverTimestamp(),
      awardedCount: ranked.length,
    }, { merge: true });

    for (let i = 0; i < ranked.length; i++) {
      const pid = ranked[i].id;
      const points = table[i] ?? 0;

      tx.set(doc(db, "answers", qid, "awards", pid), {
        points, rank: i + 1, awardedAt: serverTimestamp()
      }, { merge: true });

      tx.set(doc(playersCol, pid), {
        score: increment(points),
        lastDelta: points,
        lastDeltaForQuestionId: qid,
      }, { merge: true });
    }

    return { ok: true, reason: "awarded", count: ranked.length };
  });
}


/* =============================== COMPOSANT =============================== */

/* ====================== ÉTATS & HELPERS INTERNES (PARTIE 2/4) ====================== */
export default function Admin() {
  /* Étape 0 : injecter la config par défaut si absente */
  useEffect(() => {
    ensureConfigDefaults().catch((e) => console.error("ensureConfigDefaults error:", e));
  }, []);

  // Garde locale pour l’attribution auto (anti multi-déclenchements UI)
  const awardGuardRef = useRef({});

  /* ---------- Helpers internes (déclarés ici pour usage dans tout le composant) ---------- */
  function parseCSV(input = "") {
    return String(input).split(",").map((s) => s.trim()).filter(Boolean);
  }
  function toCSV(list = []) {
    return (list || []).join(", ");
  }
  function parseHMS(input) {
    if (input == null) return null;
    const s = String(input).trim();
    if (!s) return null;

    // hh:mm:ss | mm:ss | ss
    if (s.includes(":")) {
      const parts = s.split(":").map((p) => p.trim());
      if (parts.length > 3) return null;
      const [hStr, mStr, sStr] =
        parts.length === 3 ? parts : ["0", parts[0] || "0", parts[1] || "0"];
      const h = Number(hStr), m = Number(mStr), sec = Number(sStr);
      if (![h, m, sec].every((n) => Number.isFinite(n) && n >= 0)) return null;
      if (m >= 60 || sec >= 60) return null;
      return h * 3600 + m * 60 + sec;
    }
    // nombre simple → minutes décimales (legacy)
    const num = Number(s);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num * 60);
  }
  function formatHMS(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }
  function getTimeSec(q) {
    if (!q || typeof q !== "object") return Infinity;
    if (typeof q.timecodeSec === "number") return q.timecodeSec;            // secondes (nouveau)
    if (typeof q.timecode === "number") return Math.round(q.timecode * 60); // minutes (legacy)
    return Infinity;
  }
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
  function roundIndexOfTime(t, offsets) {
    if (!Array.isArray(offsets)) return 0;
    let idx = -1;
    for (let i = 0; i < offsets.length; i++) {
      const v = offsets[i];
      if (typeof v === "number" && t >= v) idx = i;
    }
    return Math.max(0, idx);
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

  /* --------------------------------- ÉTATS UI/DATA --------------------------------- */
  // Questions
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [savedRowId, setSavedRowId] = useState(null);
  const [needsOrderInit, setNeedsOrderInit] = useState(false);

  // UI générique
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [mainBtnBusy, setMainBtnBusy] = useState(false);
  const [adminTab, setAdminTab] = useState("players"); // "players" | "questions"

  // Joueurs (panneau)
  const [players, setPlayers] = useState([]);
  const [playersLoading, setPlayersLoading] = useState(true);
  const assignedColorRef = useRef(new Set());
  const lastAssignedColorRef = useRef(null);

  // Ordre d’arrivée local
  const playerOrderRef = useRef(new Map()); // id -> index d’arrivée
  const nextPlayerOrderRef = useRef(1);

  // Rounds & fin
  const [roundOffsetsStr, setRoundOffsetsStr] = useState([
    "00:00:00", "00:16:00", "00:31:00", "00:46:00", "", "", "", "",
  ]);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([0, 960, 1860, 2760, null, null, null, null]);
  const [quizEndSec, setQuizEndSec] = useState(null);
  const [endOffsetStr, setEndOffsetStr] = useState("");

  // Intro / fin de manche
  const [isIntro, setIsIntro] = useState(false);
  const [introEndsAtMs, setIntroEndsAtMs] = useState(null);
  const [introRoundIndex, setIntroRoundIndex] = useState(null);
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Live state
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  // Création question
  const [newQ, setNewQ] = useState({
    text: "",
    answersCsv: "",
    timeMusicStr: "",
    imageFile: null,
  });
  const DEFAULT_REVEAL_PHRASES = [
    "La réponse était :",
    "Il fallait trouver :",
    "C'était :",
    "La bonne réponse :",
    "Réponse :",
  ];
  const [newRevealPhrases, setNewRevealPhrases] = useState(["", "", "", "", ""]);

  /* ------------------------------------- EFFECTS ------------------------------------- */

  // 1) Charger questions (ordre asc)
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
        const snap = await getDocs(q);
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setItems(arr);
        setNeedsOrderInit(arr.some((it) => typeof it.order !== "number"));
      } catch (e) {
        console.error("load LesQuestions error:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 2) Écouter config (rounds + fin)
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "quiz", "config"),
      (snap) => {
        const d = snap.data() || {};
        if (Array.isArray(d.roundOffsetsSec)) {
          const offs = coerceOffsetsToNumbers(d.roundOffsetsSec);
          setRoundOffsetsSec(offs);
          setRoundOffsetsStr(offs.map((s) => (Number.isFinite(s) ? formatHMS(s) : "")));
        }
        if (typeof d.endOffsetSec === "number") {
          setQuizEndSec(d.endOffsetSec);
          setEndOffsetStr(formatHMS(d.endOffsetSec));
        } else {
          setQuizEndSec(null);
          setEndOffsetStr("");
        }
      },
      (e) => console.error("onSnapshot config error:", e)
    );
    return () => unsub();
  }, []);

  // 3) Écouter état live (Timestamp ou startEpochMs)
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "quiz", "state"),
      (snap) => {
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
        } else {
          setQuizStartMs(startMs);
          if (d.pauseAt && typeof d.pauseAt.seconds === "number") {
            const pms = d.pauseAt.seconds * 1000 + Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
            setPauseAtMs(pms);
          } else {
            setPauseAtMs(null);
          }
        }

        // flags UI/state
        setIsIntro(!!d.isIntro);
        setIntroEndsAtMs(typeof d.introEndsAtMs === "number" ? d.introEndsAtMs : null);
        setIntroRoundIndex(Number.isInteger(d.introRoundIndex) ? d.introRoundIndex : null);
        setLastAutoPausedRoundIndex(
          Number.isInteger(d.lastAutoPausedRoundIndex) ? d.lastAutoPausedRoundIndex : null
        );
      },
      (e) => console.error("onSnapshot state error:", e)
    );
    return () => unsub();
  }, []);

  // 4) Timer local (avec clamp fin de quiz)
  useEffect(() => {
    if (!quizStartMs) {
      setElapsedSec(0);
      return;
    }
    if (isPaused && pauseAtMs) {
      const e = Math.floor((pauseAtMs - quizStartMs) / 1000);
      setElapsedSec(e < 0 ? 0 : e);
      return;
    }
    if (!isRunning) {
      setElapsedSec(0);
      return;
    }

    const computeNow = () => Math.floor((Date.now() - quizStartMs) / 1000);
    const first = computeNow();
    setElapsedSec(Number.isFinite(quizEndSec) && first >= quizEndSec ? quizEndSec : first < 0 ? 0 : first);

    const id = setInterval(() => {
      const raw = computeNow();
      if (Number.isFinite(quizEndSec) && raw >= quizEndSec) {
        setElapsedSec(quizEndSec);
        clearInterval(id);
      } else {
        setElapsedSec(raw < 0 ? 0 : raw);
      }
    }, 500);
    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec]);

  // 5) Auto-pause à la fin de manche (boundary = nextStart - 1s)
  useEffect(() => {
    if (!isRunning || isPaused) return;
    if (!Array.isArray(roundOffsetsSec) || roundOffsetsSec.every((v) => v == null)) return;

    const prevIdx = (() => {
      let idx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && elapsedSec >= t) idx = i;
      }
      return idx;
    })();

    const nextStart =
      typeof roundOffsetsSec[prevIdx + 1] === "number" ? roundOffsetsSec[prevIdx + 1] : null;

    if (typeof nextStart !== "number") return; // pas de manche suivante

    const boundary = Math.max(0, nextStart - 1); // marge 1s
    if (elapsedSec >= boundary && lastAutoPausedRoundIndex !== prevIdx) {
      setDoc(
        doc(db, "quiz", "state"),
        {
          isPaused: true,
          pauseAt: serverTimestamp(),
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      ).catch(console.error);
    }
  }, [isRunning, isPaused, elapsedSec, roundOffsetsSec, lastAutoPausedRoundIndex]);

  // 6) Écouter /quiz/state/players : normaliser nameNorm + couleur + ordre d’arrivée
  useEffect(() => {
    const playersCol = collection(db, "quiz", "state", "players");
    const unsub = onSnapshot(playersCol, (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // 1) Normaliser nameNorm + 2) Assigner une couleur si manquante
      arr.forEach((p) => {
        const pref = doc(db, "quiz", "state", "players", p.id);

        // 1) nameNorm : utile pour la modération et le tri "insensible"
        if ((!p.nameNorm || typeof p.nameNorm !== "string") && typeof p.name === "string") {
          updateDoc(pref, { nameNorm: normKey(p.name || "") }).catch(() => { });
        }

        // 2) Couleur : si manquante, poser une couleur (anti-répétition locale)
        if (!p.color && !assignedColorRef.current.has(p.id)) {
          assignedColorRef.current.add(p.id);
          const prev = lastAssignedColorRef.current;
          const color = pickColorDifferent(prev);
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

  /* ====================== DÉRIVÉS & ACTIONS (PARTIE 3/4) ====================== */

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
    const firstActiveIdx = roundOffsetsSec.findIndex((t) => Number.isFinite(t));
    return firstActiveIdx !== -1 ? firstActiveIdx : 0;
  }, [elapsedSec, roundOffsetsSec]);

  const nextRoundIndex = useMemo(() => {
    if (isPaused && Number.isInteger(lastAutoPausedRoundIndex)) {
      const idx = lastAutoPausedRoundIndex + 1;
      return Number.isFinite(roundOffsetsSec[idx]) ? idx : null;
    }
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && t >= elapsedSec) return i;
    }
    return null;
  }, [elapsedSec, roundOffsetsSec, isPaused, lastAutoPausedRoundIndex]);

  const roundBoundarySec = useMemo(() => {
    if (!Array.isArray(roundOffsetsSec) || roundOffsetsSec.every((v) => v == null))
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
    isPaused && typeof roundBoundarySec === "number" && elapsedSec >= roundBoundarySec
  );

  // Question courante bornée à la manche
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
    if (Number.isFinite(t) && t > elapsedSec) { nextTimeSec = t; break; }
  }
  const _nextRoundStart = (() => {
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const v = roundOffsetsSec[i];
      if (typeof v === "number" && v > elapsedSec) return v;
    }
    return null;
  })();
  const nextRoundBoundary = Number.isFinite(_nextRoundStart) ? Math.max(0, _nextRoundStart - 1) : null;

  const candidates = [];
  if (Number.isFinite(nextTimeSec)) candidates.push(nextTimeSec);
  if (Number.isFinite(nextRoundBoundary)) candidates.push(nextRoundBoundary);
  if (Number.isFinite(quizEndSec)) candidates.push(quizEndSec);
  const effectiveNextTimeSec = candidates.length ? Math.min(...candidates) : null;

  // Fenêtres reveal / countdown
  const REVEAL_DURATION_SEC = DEFAULT_REVEAL_DURATION_SEC;
  const COUNTDOWN_START_SEC = 5;
  const revealStart = effectiveNextTimeSec != null ? (effectiveNextTimeSec - REVEAL_DURATION_SEC) : null;
  const countdownStart = effectiveNextTimeSec != null ? (effectiveNextTimeSec - COUNTDOWN_START_SEC) : null;

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

  /* === Watcher attribution auto (début du reveal) — transactionnel/idempotent === */
  useEffect(() => {
    const qid = currentQuestion?.id || null;
    const isReveal = isRevealAnswerPhase || isCountdownPhase;
    if (!qid || !isReveal) return;

    if (awardGuardRef.current[qid]) return; // garde UI locale (une fois par qid)

    awardGuardRef.current[qid] = "pending";
    ensureAwardsForQuestionTx(qid)
      .catch((e) => {
        console.error("[Admin/ensureAwardsForQuestionTx] error:", e);
        delete awardGuardRef.current[qid]; // autorise un retry si échec
      });
  }, [currentQuestion?.id, isRevealAnswerPhase, isCountdownPhase, elapsedSec, isPaused]);

  /* ------------------------------- Actions: Questions ------------------------------- */

  async function recalcAllTimecodesFromOrder() {
    try {
      const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
      const snap = await getDocs(q);
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

      // Rafraîchir le tableau
      const snap2 = await getDocs(q);
      setItems(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error("recalcAllTimecodesFromOrder error:", e);
      alert("Échec du recalcul des timecodes : " + (e?.message || e));
    }
  }

  // Édits inline
  const handleFieldChange = (id, field, value) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, [field]: value };
        if (field === "answersCsv") next.answers = parseCSV(value);
        if (field === "timeMusicStr") next.timeMusicSec = clampTimeMusicSec(parseHMS(value));
        return next;
      })
    );
  };

  // Manches (UI) : saisir puis sauver
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
      await setDoc(doc(db, "quiz", "config"), { roundOffsetsSec: secs }, { merge: true });
      setRoundOffsetsSec(secs);
      setRoundOffsetsStr(secs.map((s) => (typeof s === "number" ? formatHMS(s) : "")));
      setNotice("Offsets enregistrés");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide (laisser vide pour désactiver)");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  const saveEndOffset = async (valStr) => {
    try {
      const t = (valStr || "").trim();
      const v = t ? parseHMS(t) : null; // null = pas de fin
      if (t && v == null) throw new Error("format");
      await setDoc(doc(db, "quiz", "config"), { endOffsetSec: v }, { merge: true });
      setEndOffsetStr(v != null ? formatHMS(v) : "");
      setQuizEndSec(v);
      setNotice("Fin du quiz enregistrée");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide pour la fin du quiz");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  // Upload image question
  const uploadImage = async (file) => {
    if (!file) return null;
    try {
      const storageRef = ref(
        storage,
        `questions/${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`
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
  const handleImageChange = async (id, file) => {
    if (!file) return;
    handleFieldChange(id, "_imageUploading", true);
    const url = await uploadImage(file);
    if (url) handleFieldChange(id, "imageUrl", url);
    handleFieldChange(id, "_imageUploading", false);
  };

  // Save / delete
  const saveOne = async (it) => {
    try {
      setSavingId(it.id);

      const hasAnswersCsv = typeof it.answersCsv === "string";
      const hasTimeMusicStr = typeof it.timeMusicStr === "string";

      const nextTimeMusicSec =
        hasTimeMusicStr
          ? clampTimeMusicSec(parseHMS(it.timeMusicStr))
          : Number.isFinite(it.timeMusicSec)
            ? clampTimeMusicSec(it.timeMusicSec)
            : DEFAULT_TIME_MUSIC_SEC;

      const payload = {
        text: it.text ?? "",
        answers: hasAnswersCsv
          ? parseCSV(it.answersCsv)
          : Array.isArray(it.answers)
            ? it.answers
            : [],
        timeMusicSec: nextTimeMusicSec,
        timecodeSec: typeof it.timecodeSec === "number" ? it.timecodeSec : null,
        imageUrl: it.imageUrl || "",
        order:
          typeof it.order === "number"
            ? it.order
            : (items.findIndex((x) => x.id === it.id) + 1) * 1000,
      };

      await updateDoc(doc(db, "LesQuestions", it.id), payload);
      setSavedRowId(it.id);
      setTimeout(() => setSavedRowId(null), 2000);
    } catch (err) {
      console.error("saveOne error:", err);
      alert("Échec de la modification : " + (err?.message || err));
    } finally {
      setSavingId(null);
      await (async () => {
        const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
        const snap = await getDocs(q);
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        await recalcAllTimecodesFromOrder();
      })();
    }
  };

  const removeOne = async (id) => {
    if (!confirm("Supprimer cette question ?")) return;
    await deleteDoc(doc(db, "LesQuestions", id));
    const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    await recalcAllTimecodesFromOrder();
  };

  // Reorder
  const swapOrder = async (indexA, indexB) => {
    if (indexA < 0 || indexB < 0 || indexA >= items.length || indexB >= items.length) return;
    const a = items[indexA], b = items[indexB];
    const batch = writeBatch(db);
    batch.update(doc(db, "LesQuestions", a.id), { order: b.order ?? (indexB + 1) * 1000 });
    batch.update(doc(db, "LesQuestions", b.id), { order: a.order ?? (indexA + 1) * 1000 });
    await batch.commit();
    const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    await recalcAllTimecodesFromOrder();
  };

  // Init order (one-time)
  const initOrder = async () => {
    const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
    const snap = await getDocs(q);
    const arr = snap.docs.map((d, i) => ({ id: d.id, ...d.data(), idx: i }));
    const batch = writeBatch(db);
    arr.forEach((it, i) => batch.update(doc(db, "LesQuestions", it.id), { order: (i + 1) * 1000 }));
    await batch.commit();
    const q2 = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap2 = await getDocs(q2);
    setItems(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
    await recalcAllTimecodesFromOrder();
  };

  // Create
  const createOne = async () => {
    try {
      setCreating(true);
      let imageUrl = "";
      if (newQ.imageFile) imageUrl = (await uploadImage(newQ.imageFile)) || "";

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
        timeMusicSec,
        timecodeSec: null, // recalculé par recalcAllTimecodesFromOrder
        imageUrl,
        createdAt: new Date(),
        order,
        revealPhrases: cleanedRevealPhrases, // [] autorisé → fallback côté clients
      });

      setNewQ({ text: "", answersCsv: "", timeMusicStr: "", imageFile: null });
      setNewRevealPhrases(["", "", "", "", ""]);
    } catch (err) {
      console.error("createOne error:", err);
      alert("Échec de la création : " + (err?.message || err));
    } finally {
      setCreating(false);
      const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
      const snap = await getDocs(q);
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      await recalcAllTimecodesFromOrder();
    }
  };

  /* ------------------------------- Actions: Live ------------------------------- */

  const startQuiz = async () => {
    try {
      const nowMs = Date.now();
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: false,
          startAt: Timestamp.fromMillis(nowMs),
          startEpochMs: nowMs,
          pauseAt: null,
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
          // Pause MANUELLE : effacer la sentinelle pour ne pas afficher "Fin de manche"
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
      const ms = Date.now() - target * 1000;

      // Neutraliser l'auto-pause si on saute au début d'une manche
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
        startAt: Timestamp.fromMillis(ms),
        startEpochMs: ms,
        pauseAt: null,
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
      const newStartMs = Date.now() - Math.max(0, Math.floor(elapsedSec)) * 1000;

      // Si on est pile à la frontière (boundary = nextStart - 1), armer la sentinelle
      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && elapsedSec >= t) prevIdx = i;
      }
      const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
        ? roundOffsetsSec[prevIdx + 1]
        : null;
      const boundary =
        typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;

      const payload = {
        isRunning: true,
        isPaused: false,
        startAt: Timestamp.fromMillis(newStartMs),
        startEpochMs: newStartMs,
        pauseAt: null,
      };
      if (typeof boundary === "number" && elapsedSec >= boundary) {
        payload.lastAutoPausedRoundIndex = prevIdx;
      }

      await setDoc(doc(db, "quiz", "state"), payload, { merge: true });
    } catch (err) {
      console.error("resumeFromPause error:", err);
      alert("Échec de la reprise : " + (err?.message || err));
    }
  };

  const jumpToRoundStartAndPlay = async (roundStartSec) => {
    try {
      const target = Math.max(0, Math.floor(roundStartSec));
      const ms = Date.now() - target * 1000;

      // Sentinelle = index de la manche précédente au point (roundStartSec - 1)
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
          startAt: Timestamp.fromMillis(ms),
          startEpochMs: ms,
          pauseAt: null,
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
      const startMs = Date.now() - target * 1000;

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
        startAt: Timestamp.fromMillis(startMs),
        startEpochMs: startMs,
        pauseAt: serverTimestamp(),
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

  const startOrNextRound = async () => {
    const actives = (Array.isArray(roundOffsetsSec) ? roundOffsetsSec : [])
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);

    if (mainBtnBusy) return;
    setMainBtnBusy(true);
    setTimeout(() => setMainBtnBusy(false), 350);

    if (!actives.length) {
      await startQuiz();
      return;
    }

    // 1) Première fois (quiz pas démarré) → démarrer
    if (!isRunning || !quizStartMs) {
      await startQuiz();
      return;
    }

    // 2) En pause → contexte :
    //    - si elapsed < boundary (nextStart - 1) → SAUT au début de la manche suivante
    //    - sinon → reprise simple
    if (isPaused) {
      let nextRoundStart = null;
      if (isPaused && Number.isInteger(lastAutoPausedRoundIndex)) {
        const idx = lastAutoPausedRoundIndex + 1;
        nextRoundStart = Number.isFinite(roundOffsetsSec[idx]) ? roundOffsetsSec[idx] : null;
      } else {
        nextRoundStart = actives.find((t) => t >= elapsedSec);
      }
      if (typeof nextRoundStart !== "number") {
        setNotice("Aucune manche suivante");
        setTimeout(() => setNotice(null), 1800);
        return;
      }
      const boundary = Math.max(0, nextRoundStart - 1);

      // PATCH(Admin): attribuer la question en pause avant de quitter la manche
      await awardCurrentQuestionIfNeeded();

      if (elapsedSec < boundary) {
        await jumpToRoundStartAndPlay(nextRoundStart);
      } else {
        await resumeFromPause();
      }
      return;
    }
  };

  // PATCH(Admin): helper pour attribuer la question active si besoin
  async function awardCurrentQuestionIfNeeded() {
    try {
      const qid = currentQuestion?.id || null; // currentQuestion est déjà dérivé plus bas
      if (!qid) return { ok: false, reason: "no-active-question" };
      const res = await ensureAwardsForQuestionTx(qid);
      if (res?.reason) console.log("[Admin] awardCurrentQuestionIfNeeded:", res.reason);
      return res;
    } catch (e) {
      console.error("[Admin] awardCurrentQuestionIfNeeded error:", e);
      return { ok: false, reason: "error" };
    }
  }


  const handleBack = async () => {
    if (!isPaused) return;

    // Si on est sur la frontière de manche → bloqué (UX)
    if (atRoundBoundary) {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
      return;
    }

    const actives = roundOffsetsSec
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);
    const firstActive = actives[0] ?? 0;
    const roundStart = actives.filter((t) => t <= elapsedSec).slice(-1)[0] ?? firstActive;
    const roundEnd = actives.find((t) => t > roundStart) ?? Infinity;

    if (!plannedTimes.length || elapsedSec < firstActive) {
      await seekTo(0);
      return;
    }

    const inRound = plannedTimes.filter((t) => t >= roundStart && t < roundEnd);
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
      roundOffsetsSec.find((t) => typeof t === "number" && t > currentRoundStartLocal) ?? Infinity;

    const next = plannedTimes.find((t) => t > elapsedSec && t < currentRoundEndLocal);
    if (typeof next === "number") {
      await awardCurrentQuestionIfNeeded(); // PATCH(Admin): attribuer la question en pause avant de sauter
      await seekTo(next);
    } else {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
    }
  };

  async function goToRoundEndPaused() {
    const prevIdx = roundIndexOfTime(Math.max(0, elapsedSec - 1), roundOffsetsSec);
    const nextStart =
      typeof roundOffsetsSec[prevIdx + 1] === "number"
        ? roundOffsetsSec[prevIdx + 1]
        : null;
    if (!Number.isFinite(nextStart)) return; // pas de manche suivante

    const targetSec = Math.max(0, Math.floor(nextStart));
    const startMs = Date.now() - targetSec * 1000;

    try {
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: true,
          startAt: Timestamp.fromMillis(startMs),
          startEpochMs: startMs,
          pauseAt: serverTimestamp(),
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      );
    } catch (e) {
      console.error("goToRoundEndPaused error:", e);
    }
  }

  /* ------------------------------- Actions: Joueurs & Reset ------------------------------- */

  // Récupère un N unique et libre pour "Player N"
  async function getNextAliasNumber() {
    const stateRef = doc(db, "quiz", "state");
    let reservedN = await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.exists() ? snap.data() : {};
      const current = Number.isFinite(data?.aliasCounter) ? data.aliasCounter : 1;
      const next = current + 1;
      tx.set(stateRef, { aliasCounter: next }, { merge: true });
      return current; // on utilise la valeur actuelle
    });

    // Collision (rare) : si "Player reservedN" existe déjà -> on boucle
    while (true) {
      const nameNorm = normKey(`Player ${reservedN}`);
      const playersCol = collection(db, "quiz", "state", "players");
      const q = query(playersCol, where("nameNorm", "==", nameNorm));
      const snap = await getDocs(q);
      if (snap.empty) return reservedN;

      reservedN = await runTransaction(db, async (tx) => {
        const snap2 = await tx.get(stateRef);
        const data2 = snap2.exists() ? snap2.data() : {};
        const current2 = Number.isFinite(data2?.aliasCounter) ? data2.aliasCounter : 1;
        const next2 = current2 + 1;
        tx.set(stateRef, { aliasCounter: next2 }, { merge: true });
        return current2;
      });
    }
  }

  async function rejectPlayer(playerId, currentName) {
    try {
      const playersCol = collection(db, "quiz", "state", "players");
      const ref = doc(playersCol, playerId);

      // Lire l’état courant pour savoir si c’est un alias “Player N”
      const snap = await getDoc(ref);
      if (!snap.exists()) return;
      const d = snap.data() || {};

      const isAliased = !!d.isAlias; // flag posé par “Player N”
      const norm = normKey(typeof d.name === "string" ? d.name : (currentName || ""));

      // Base: passer en "rejected" et déverrouiller
      const baseUpdates = {
        nameStatus: "rejected",
        nameLocked: false,
        isAlias: false,
        updatedAt: (typeof serverTimestamp === "function" ? serverTimestamp() : new Date()),
      };

      // ⛔️ On n’ajoute PAS “player n” dans rejectedNames
      const updates = isAliased
        ? baseUpdates
        : { ...baseUpdates, rejectedNames: arrayUnion(norm) };

      await updateDoc(ref, updates);
    } catch (e) {
      console.error("rejectPlayer failed:", e);
    }
  }

  async function kickPlayer(id) {
    try {
      const playersCol = collection(db, "quiz", "state", "players");
      await updateDoc(doc(playersCol, id), { isKicked: true });
    } catch (e) {
      console.error("kickPlayer", e);
    }
  }

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
        nameLocked: true,        // verrouille le nom
        nameStatus: "locked",    // UI: bouton "Player N" devient "Owned :)"
        isAlias: true,
        aliasNumber: n,
        updatedAt: (typeof serverTimestamp === "function" ? serverTimestamp() : new Date()),
      });
    } catch (e) {
      console.error("renameToAlias", e);
    }
  }

  // Supprime tous les joueurs (en batchs)
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

  // Purge complète de answers/* (submissions + awards + doc racine)
  async function purgeAnswersTree() {
    const answersCol = collection(db, "answers");
    const answersSnap = await getDocs(answersCol);

    for (const qDoc of answersSnap.docs) {
      const qid = qDoc.id;

      // Submissions/*
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

      // Awards/*
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

      // Doc racine answers/{qid}
      await deleteDoc(doc(answersCol, qid));
    }
  }

  async function resetQuizAndPlayers() {
    const ok = window.confirm("Tout remettre à zéro ? (quiz/state, joueurs, answers/*)");
    if (!ok) return;

    setNotice("Réinitialisation…");
    try {
      // 1) Stopper proprement /quiz/state
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
        },
        { merge: true }
      );

      // 2) Purger toute l’arbo answers/*
      await purgeAnswersTree();

      // 3) Supprimer tous les joueurs
      await deleteAllPlayers();

      // 4) Marqueur de reset + compteur d’alias
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

  /* ================= UI DÉRIVÉES & RENDU (PARTIE 4/4) ================= */

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

  const isQuizEnded = Number.isFinite(quizEndSec) && elapsedSec >= quizEndSec;
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

  const canClickPause = isRunning && !isPaused && !isQuizEnded;
  const pauseCursor = canClickPause ? "pointer" : "not-allowed";

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
              <th style={{ width: "30%", textAlign: "left", padding: "10px" }}>Réponses acceptées</th>
              <th style={{ width: "8%", textAlign: "left", padding: "10px" }}>TimeMusic</th>
              <th style={{ width: "8%", textAlign: "left", padding: "10px" }}>TimeCode</th>
              <th style={{ width: "15%", textAlign: "left", padding: "10px" }}>Image</th>
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

                  <td style={{ width: "30%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={answersCsv}
                      onChange={(e) => handleFieldChange(it.id, "answersCsv", e.target.value)}
                      placeholder="ex: Goku, Son Goku"
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sépare par des virgules</div>
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

                  <td style={{ width: "15%", verticalAlign: "top", padding: "12px" }}>
                    {it.imageUrl ? (
                      <div>
                        <img
                          src={it.imageUrl}
                          alt="illustration"
                          style={{ width: "100%", maxHeight: 120, objectFit: "contain" }}
                        />
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>Pas d’image</div>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageChange(it.id, e.target.files?.[0] || null)}
                      disabled={it._imageUploading}
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
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


  /* --------------------------------- Rendu --------------------------------- */
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
          disabled={(isRunning && !isPaused) || isQuizEnded || mainBtnBusy}
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
              (isRunning && !isPaused) || isIntro || isQuizEnded
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
          title={mainButtonLabel}
        >
          {mainButtonLabel}
        </button>

        <button
          onClick={canClickPause ? pauseQuiz : (e) => e.preventDefault()}
          aria-disabled={canClickPause ? "false" : "true"}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#fecaca",
            color: "#000",
            fontWeight: 600,
            cursor: pauseCursor,
            transition: "background 160ms ease",
          }}
          title={canClickPause ? "Mettre en pause le quiz" : "Pause indisponible"}
        >
          Pause
        </button>

        <button
          onClick={handleBack}
          disabled={!isPaused || plannedTimes.length === 0 || atRoundBoundary}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#bfdbfe",
            color: "#000",
            fontWeight: 600,
            cursor:
              !isPaused || plannedTimes.length === 0 || atRoundBoundary
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
          }}
          title={
            atRoundBoundary
              ? "Fin de manche atteinte : utilisez « Manche suivante »"
              : "Revenir au début de la question en cours (ou au début de la manche)"
          }
        >
          Back
        </button>

        <button
          onClick={handleNext}
          disabled={!isPaused || plannedTimes.length === 0 || atRoundBoundary}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#c7d2fe",
            color: "#000",
            fontWeight: 600,
            cursor:
              !isPaused || plannedTimes.length === 0 || atRoundBoundary
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
          }}
          title={
            atRoundBoundary
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
          }}
          title="Réinitialiser le quiz"
        >
          Réinitialiser
        </button>

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
                style={{
                  width: 90,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: "1px solid #2a2a2a",
                  background: "#111",
                  color: "#fff",
                  fontFamily: "monospace",
                  opacity: typeof roundOffsetsSec[i] === "number" ? 1 : 0.75,
                }}
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
              style={{
                width: 110,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: "#111",
                color: "#fff",
                fontFamily: "monospace",
              }}
              title="Point de fin global (utilisé pour la révélation & le décompte final)"
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

      {/* ===== Onglets + contenu ===== */}
      <div
        style={{
          margin: "24px -20px 8px",
          background: "#2c5d8bff",
          color: "white",
          padding: "10px 20px",
        }}
      >
        {/* Barre d’onglets */}
        <div style={{ marginTop: 16, borderBottom: "1px solid #1f2a44", display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => setAdminTab("players")}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #1f2a44",
              background: adminTab === "players" ? "#0b1e3d" : "transparent",
              color: "#e6eeff",
              cursor: "pointer",
              fontWeight: adminTab === "players" ? 700 : 500,
            }}
          >
            Joueurs
          </button>
          <button
            type="button"
            onClick={() => setAdminTab("questions")}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #1f2a44",
              background: adminTab === "questions" ? "#0b1e3d" : "transparent",
              color: "#e6eeff",
              cursor: "pointer",
              fontWeight: adminTab === "questions" ? 700 : 500,
            }}
          >
            Questions
          </button>
        </div>

        {/* Onglet Joueurs */}
        {adminTab === "players" && (
          <div style={{ marginTop: 16 }}>
            <h2 style={{ margin: 0 }}>Joueurs</h2>
            <div style={{ opacity: 0.9, marginTop: 6 }}>
              Joueurs connectés : <b>{connectedCount}</b>
              {playersLoading && <span style={{ marginLeft: 8, opacity: 0.7 }}>(chargement…)</span>}
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
                  <tr style={{ background: "#0b1e3d" }}>
                    <th style={{ textAlign: "left", padding: "10px 8px" }}>Joueurs</th>
                    <th style={{ textAlign: "center", padding: "10px 8px", width: 120 }}>Score</th>
                    <th style={{ textAlign: "center", padding: "10px 8px", width: 140 }}>Statut</th>
                    <th style={{ textAlign: "left", padding: "10px 8px", width: 360 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p) => {
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
                      <td colSpan={3} style={{ padding: 12, opacity: 0.7 }}>
                        Aucun joueur pour l’instant.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Onglet Questions */}
        {adminTab === "questions" && (
          <>
            <h2 style={{ margin: 0 }}>Créer une nouvelle question</h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 360px",
                gap: 16,
                alignItems: "start",
                maxWidth: 1100,
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
                  Réponses acceptées (séparées par des virgules)
                  <input
                    type="text"
                    value={newQ.answersCsv}
                    onChange={(e) => setNewQ((p) => ({ ...p, answersCsv: e.target.value }))}
                    placeholder="ex: Mario, Super Mario"
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </label>

                <label>
                  TimeMusic (hh:mm:ss)
                  <input
                    type="text"
                    value={newQ.timeMusicStr}
                    onChange={(e) => setNewQ((p) => ({ ...p, timeMusicStr: e.target.value }))}
                    placeholder="ex: 00:00:35"
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </label>

                <label>
                  Image (optionnelle)
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) =>
                      setNewQ((p) => ({ ...p, imageFile: e.target.files?.[0] || null }))
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
              <fieldset style={{ border: "1px solid #333", padding: 12, borderRadius: 8 }}>
                <legend style={{ padding: "0 6px" }}>Phrase de réponse aléatoire (max 5)</legend>

                {newRevealPhrases.map((val, i) => (
                  <div
                    key={i}
                    style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}
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
          </>
        )}
      </div>
    </div>
  );
}
