// ============================================================================
// /pages/screen.js — Partie 1/5
// Scope : Imports, hook mobile VH, constantes, helpers utilitaires,
// panneaux "Rejoindre", scoring & attribution transactionnelle (hors composant).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/firebase";
import {
  collection, doc, getDocs, getDoc, onSnapshot, orderBy, query,
  where, runTransaction, serverTimestamp, increment
} from "firebase/firestore";

// Fix viewport height on mobile browsers (100vh bug)
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

/* ============================ CONSTANTES & HELPERS ============================ */

const UI_MASK_MS = 220; // durée du voile anti-flicker (ms)

// Phrases de révélation par défaut
const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :",
];

// Phases / timings
const REVEAL_DURATION_SEC = 20; // 15s avec la réponse + 5s de décompte
const COUNTDOWN_START_SEC = 5;
const ROUND_START_INTRO_SEC = 5; // mange 5s sur la 1ʳᵉ question de la manche

// ====== JOIN (DEV) ======
//const DEV_JOIN_URL = "http://192.168.1.118:3000/player";
//const JOIN_QR_SRC = "/qr-join-dev.png"; // fichier placé dans /public

// ====== JOIN (PUBLIC OK) ======
const DEV_JOIN_URL = "https://eley-quiz-live.vercel.app/player";
const JOIN_QR_SRC = "/qr-code-public-OK.png"; // fichier placé dans /public

// Barre de temps
const BAR_H = 6;
const BAR_BLUE = "#3b82f6";
const BAR_RED = "#ef4444";
const HANDLE_COLOR = "#f8fafc";

// Panneau "Rejoindre" (inline)
function JoinPanelInline({ size = "md" }) {
  const imgSize = size === "lg" ? 320 : 160;
  const panelStyle = {
    marginTop: 12,
    width: size === "lg" ? 360 : 320,
    padding: 12,
    borderRadius: 12,
    background: "rgba(15, 35, 74, 0.92)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
    color: "#e6eeff",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  };
  return (
    <div style={panelStyle} aria-hidden="true">
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Rejoindre :</div>
      <div style={{ fontFamily: "monospace", fontSize: 16, userSelect: "all" }}>
        {DEV_JOIN_URL}
      </div>
      <img
        src={JOIN_QR_SRC}
        alt=""
        width={imgSize}
        height={imgSize}
        style={{ display: "block", marginTop: 10 }}
      />
    </div>
  );
}

// Panneau "Rejoindre" fixé en bas-gauche pendant le quiz
function JoinPanelFixedBottom() {
  return (
    <div
      style={{
        position: "fixed",
        left: 18,
        bottom: 18,
        zIndex: 10,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    >
      <JoinPanelInline size="lg" />
    </div>
  );
}

const SCREEN_IMG_MAX = 300; // px (image de révélation, côté public)

// Time helpers
function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec;           // secondes (nouveau)
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60); // minutes (legacy)
  return Infinity;
}
function formatHMS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
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

// Splash (plein bleu foncé au boot)
function Splash() {
  return (
    <div
      style={{
        minHeight: "calc(var(--vh, 1vh) * 100)",
        background: "#0a0a1a",
      }}
      aria-hidden="true"
    />
  );
}

// leaderboard
const DEFAULT_LEADERBOARD_TOP_N = 20;

function normalizeNameAlpha(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ===== Scoring (défaut) + helpers attribution TX =====
const DEFAULT_SCORING_TABLE = [30, 25, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

async function getScoringTableScreen() {
  try {
    const snap = await getDoc(doc(db, "quiz", "config"));
    return (snap.exists() && Array.isArray(snap.data()?.scoringTable))
      ? snap.data().scoringTable
      : DEFAULT_SCORING_TABLE;
  } catch {
    return DEFAULT_SCORING_TABLE;
  }
}

// Attribution transactionnelle et idempotente (robuste aux différents schémas de timestamps)
async function ensureAwardsForQuestionTx(qid) {
  if (!qid) return { ok: false, reason: "no-qid" };

  // 1) Lire toutes les bonnes réponses (pas d'ordre imposé)
  const subsCol = collection(db, "answers", qid, "submissions");
  let subsSnap;
  try {
    subsSnap = await getDocs(query(subsCol, where("isCorrect", "==", true)));
  } catch (e) {
    console.error("[Screen] read submissions failed:", e);
    return { ok: false, reason: "read-failed" };
  }

  // 2) Normaliser un "temps" en ms pour trier localement
  function toMs(obj) {
    if (!obj) return Infinity;
    if (typeof obj.toMillis === "function") return obj.toMillis(); // Timestamp Firestore
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
    .sort((a, b) => a.t - b.t); // plus rapide d’abord

  if (ranked.length === 0) {
    console.warn("[Screen] no correct submissions for qid=", qid);
    return { ok: true, reason: "no-correct-submissions" };
  }

  const table = await getScoringTableScreen();
  const qDocRef = doc(db, "answers", qid);
  const playersCol = collection(doc(db, "quiz", "state"), "players");

  // 3) Transaction : idempotence + écritures atomiques
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

// ============================================================================
// /pages/screen.js — Partie 2/5
// Scope : Composant Screen — états/refs, abonnements Firestore (questions,
// joueurs, config, état global) et timer local synchronisé.
// ============================================================================

export default function Screen() {
  useMobileVH();

  /* ======================= ÉTATS & RÉFS (TOP-LEVEL) ======================= */

  const lastNavSeqRef = useRef(null);
  const uiFreezeUntilRef = useRef(0);

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

  // Leaderboard
  const [playersLB, setPlayersLB] = useState([]);
  const [leaderboardTopN, setLeaderboardTopN] = useState(DEFAULT_LEADERBOARD_TOP_N);
  const awardGuardRef = useRef({}); // utilisé plus tard pour l’attribution des points

  // Fin de manche (poussée par l’admin)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Offset d’horloge serveur (ms) — mis à jour via /quiz/state.serverNow
  const serverDeltaRef = useRef(0);
  const [serverDeltaTick, setServerDeltaTick] = useState(0); // re-render léger si besoin

  // Préchargement image pour éviter le flash au reveal
  const [preloadedImage, setPreloadedImage] = useState(null);


  /* --------------------------- Charger les questions --------------------------- */
  useEffect(() => {
    (async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      setQuestionsLoaded(true);
    })();
  }, []);

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
          color: v.color || null,
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

  /* ------------------------------- Écouter config ------------------------------ */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data() || {};
      // taille du top
      const topN = Number.isFinite(d?.leaderboardTopN) ? d.leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N;
      setLeaderboardTopN(topN);
      // bornes quiz & manches
      setQuizEndSec(typeof d?.endOffsetSec === "number" ? d.endOffsetSec : null);
      setRoundOffsetsSec(
        Array.isArray(d?.roundOffsetsSec)
          ? d.roundOffsetsSec.map((v) => (Number.isFinite(v) ? v : null))
          : []
      );
      const rv = Number.isFinite(d?.revealDurationSec) ? d.revealDurationSec : REVEAL_DURATION_SEC;
      setRevealDurationSec(rv);
      setConfigLoaded(true);
    });
    return () => unsub();
  }, []);

  /* ------------------------------ Écouter /state ------------------------------ */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = (snap && snap.data()) || {};

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
        uiFreezeUntilRef.current = performance.now() + UI_MASK_MS;
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
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
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
  }, [playersLB, leaderboardTopN]);

  // Podium (fin de quiz) : groupes par médailles avec égalités (> 0 pts)
  const podium = useMemo(() => {
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => ({
        id: p.id,
        name: p.name || "",
        score: Number(p.score || 0),
        _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
      }))
      .sort((a, b) => (a.score !== b.score ? b.score - a.score : a._nameKey.localeCompare(b._nameKey)));

    const distinct = Array.from(new Set(rows.map((r) => r.score))).filter((s) => s > 0);
    const goldScore = distinct[0];
    const silverScore = distinct[1];
    const bronzeScore = distinct[2];

    return {
      gold: typeof goldScore === "number" ? rows.filter((r) => r.score === goldScore) : [],
      silver: typeof silverScore === "number" ? rows.filter((r) => r.score === silverScore) : [],
      bronze: typeof bronzeScore === "number" ? rows.filter((r) => r.score === bronzeScore) : [],
    };
  }, [playersLB]);

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

  const uiMasked = performance.now() < uiFreezeUntilRef.current;

  // Prochaine frontière de manche (−GAP pour éviter chevauchement reveal)
  const GAP = 1;
  const nextRoundStart = nextRoundStartAfter(elapsedSec, roundOffsetsSec);
  const nextRoundBoundary = Number.isFinite(nextRoundStart) ? Math.max(0, nextRoundStart - GAP) : null;

  // Fenêtre morte à ± ~1s autour de la frontière
  const ROUND_DEADZONE_SEC = 1;
  const secondsToRoundBoundary = Number.isFinite(nextRoundStart) ? nextRoundStart - elapsedSec : null;
  const inRoundBoundaryWindow =
    !uiMasked &&
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= ROUND_DEADZONE_SEC &&
    secondsToRoundBoundary >= -0.25;

  // Candidat minimal
  let effectiveNextTimeSec = null;
  let nextKind = null; // "question" | "round" | "end"
  {
    const cands = [];
    if (Number.isFinite(nextTimeSec)) cands.push({ t: nextTimeSec, k: "question" });
    if (Number.isFinite(nextRoundBoundary)) cands.push({ t: nextRoundBoundary, k: "round" });
    if (Number.isFinite(quizEndSec)) cands.push({ t: quizEndSec, k: "end" });
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
    ? qStart + ROUND_START_INTRO_SEC
    : null;

  // Le temps “jouable” commence après l’intro
  const qStartEffective =
    isFirstQuestionOfRound && Number.isFinite(qStart)
      ? qStart + ROUND_START_INTRO_SEC
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
  const isRoundBreak = Boolean(isPaused && endedRoundIndex != null && !isQuizEnded);

  // Phases bornées (anti-flash)
  const nextEvent = effectiveNextTimeSec;
  const revealStart = nextEvent != null ? nextEvent - revealDurationSec : null;
  const countdownStart = nextEvent != null ? nextEvent - COUNTDOWN_START_SEC : null;

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

  /* ===== Attribution des points : déclenchée pendant la fenêtre de révélation ===== */
  useEffect(() => {
    const qid = currentQuestion?.id || null;
    if (!qid) return;

    const inRevealWindow = isRevealAnswerPhase || isCountdownPhase;
    if (!inRevealWindow) return;

    // Anti double-run (par écran) pour ce qid
    if (awardGuardRef.current[qid]) return;
    awardGuardRef.current[qid] = "pending";

    ensureAwardsForQuestionTx(qid).catch((e) => {
      console.error("[Screen] awards TX error:", e);
      delete awardGuardRef.current[qid]; // autorise un retry si la TX échoue
    });
  }, [currentQuestion?.id, isRevealAnswerPhase, isCountdownPhase]);

  /* ---------------------- Variables d’UI dérivées ---------------------- */
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
  const qEndLocal = nextEvent != null ? nextEvent - revealDurationSec : null;
  const canShowTimeBar = Boolean(
    isQuestionPhase && qStartEffective != null && qEndLocal != null && qEndLocal > qStartEffective
  );
  const progress = canShowTimeBar
    ? Math.min(1, Math.max(0, (elapsedSec - qStartEffective) / (qEndLocal - qStartEffective)))
    : 0;

  // Phrases de révélation & réponse principale
  const revealPhrase = useMemo(
    () => (currentQuestion ? pickRevealPhrase(currentQuestion) : ""),
    [currentQuestionId]
  );
  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);

  // Infos attente
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;

  // Pré-start
  const showPreStart = !(quizStartMs && isRunning);

  // Variables spécifiques au leaderboard pendant reveal
  const currentQuestionIdForLB = currentQuestionId;
  const inRevealWindowForLB = Boolean(isRevealAnswerPhase || isCountdownPhase);

  // Préchargement image (anti-flicker au reveal)
  useEffect(() => {
    setPreloadedImage(null);
    const url = currentQuestion?.imageUrl;
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
  }, [currentQuestionId]);

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
// /pages/screen.js — Partie 4/5
// Scope : RENDER — écrans pré-start / quiz (question, reveal, countdown),
// pauses & fins de manche/quiz, colonne classement et panneaux “Rejoindre”.
// (⚠️ Ne PAS fermer la fonction ici — l’accolade finale arrive en partie 5.)
// ============================================================================

  /* ============================ RENDER (PARTIE 4/4) ============================ */

  if (!stateLoaded || !configLoaded || !questionsLoaded) {
    return <Splash />; // plein écran de boot
  }

  if (showPreStart) {
    return (
      <div style={{
        background: "#000814", color: "#fff", minHeight: "calc(var(--vh, 1vh) * 100)",
        display: "grid", placeItems: "center", padding: "24px", textAlign: "center"
      }}>
        <div
          style={{
            width: 360,
            maxWidth: "90vw",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0 }}>
            EleyBox<br />Écran en attente
          </h1>
          <p style={{ opacity: 0.8, marginTop: 12 }}>
            Le quiz n'a pas encore commencé.<br />Préparez-vous…
          </p>
          <JoinPanelInline size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        background: "#000814",
        color: "white",
        minHeight: "calc(var(--vh, 1vh) * 100)",
        position: "relative",
      }}
    >
      {/* Voile anti-flicker */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "#020617",
          opacity: uiMasked ? 0.96 : 0,
          transition: "opacity 120ms ease",
          pointerEvents: "none",
          zIndex: 50,
        }}
      />
      {/* Horloge en haut à droite */}
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

      {/* Zone question (gauche) */}
      <div style={{ flex: 2, padding: "40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
        {isQuizEnded ? (
          <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
            <h1 style={{ fontSize: "2.4rem", marginTop: 6, marginBottom: 8 }}>Voici le podium :</h1>

            {podium.gold.length + podium.silver.length + podium.bronze.length === 0 ? (
              <div style={{ opacity: 0.85, fontSize: 18, marginTop: 6 }}>
                Aucun point n’a été marqué. Merci à tous pour votre participation !
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10, justifyContent: "center", marginTop: 10 }}>
                {/* 🥇 Or — 2× plus gros */}
                {podium.gold.length > 0 && (
                  <div style={{ background: "#0b1e3d", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 6 }}>🥇 Or</div>
                    {podium.gold.map((p) => (
                      <div
                        key={p.id}
                        style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "baseline" }}
                      >
                        <span style={{ fontWeight: 900, fontSize: 42 }}>{p.name || "(sans nom)"}</span>
                        <span style={{ opacity: 0.85, fontSize: 26 }}>•</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 900, fontSize: 42 }}>{p.score}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 🥈 Argent */}
                {podium.silver.length > 0 && (
                  <div style={{ background: "#0b0f1a", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🥈 Argent</div>
                    {podium.silver.map((p) => (
                      <div key={p.id} style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                        <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name || "(sans nom)"}</span>
                        <span style={{ opacity: 0.85 }}>•</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>{p.score}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 🥉 Bronze */}
                {podium.bronze.length > 0 && (
                  <div style={{ background: "#0b0f1a", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🥉 Bronze</div>
                    {podium.bronze.map((p) => (
                      <div key={p.id} style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                        <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name || "(sans nom)"}</span>
                        <span style={{ opacity: 0.85 }}>•</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>{p.score}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : isRoundBreak ? (
          <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
            <h1 style={{ fontSize: "2rem", margin: 0 }}>
              Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
            </h1>

            <h2 style={{ fontSize: "1.6rem", marginTop: 10, marginBottom: 6 }}>Podium provisoire :</h2>

            {podium.gold.length + podium.silver.length + podium.bronze.length === 0 ? (
              <div style={{ opacity: 0.85, fontSize: 16, marginTop: 6 }}>
                Aucun point n’a été marqué pour l’instant.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10, justifyContent: "center", marginTop: 8 }}>
                {/* 🥇 Or — 2× plus gros */}
                {podium.gold.length > 0 && (
                  <div style={{ background: "#0b1e3d", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 6 }}>🥇 Or</div>
                    {podium.gold.map((p) => (
                      <div
                        key={p.id}
                        style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "baseline" }}
                      >
                        <span style={{ fontWeight: 900, fontSize: 28 }}>{p.name || "(sans nom)"}</span>
                        <span style={{ opacity: 0.85, fontSize: 18 }}>•</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 900, fontSize: 24 }}>{p.score}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 🥈 Argent */}
                {podium.silver.length > 0 && (
                  <div style={{ background: "#0b0f1a", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🥈 Argent</div>
                    {podium.silver.map((p) => (
                      <div key={p.id} style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                        <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name || "(sans nom)"}</span>
                        <span style={{ opacity: 0.85 }}>•</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>{p.score}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 🥉 Bronze */}
                {podium.bronze.length > 0 && (
                  <div style={{ background: "#0b0f1a", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🥉 Bronze</div>
                    {podium.bronze.map((p) => (
                      <div key={p.id} style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                        <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name || "(sans nom)"}</span>
                        <span style={{ opacity: 0.85 }}>•</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>{p.score}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ opacity: 0.8, marginTop: 10, fontSize: 14 }}>
              … mais rien n’est joué encore.
            </div>
          </div>
        ) : inRoundBoundaryWindow ? (
          <div style={{ marginTop: 8, marginBottom: 4 }}>
            <h1 style={{ fontSize: "2rem", margin: 0 }}>
              Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
            </h1>
            <div style={{ opacity: 0.85, fontSize: 18, marginTop: 8 }}>(transition…)</div>
          </div>
        ) : isPaused ? (
          <div style={{ marginTop: 8, marginBottom: 4 }}>
            <h1 style={{ fontSize: "2rem", margin: 0 }}>On revient dans un instant…</h1>
            <div style={{ opacity: 0.75, marginTop: 8, fontSize: 16 }}>
              Le quiz est momentanément en pause.
            </div>
          </div>
        ) : currentQuestion ? (
          <>
            {isRoundIntroPhase ? (
              <div style={{ marginTop: 8, marginBottom: 4 }}>
                <div style={{ opacity: 0.85, fontSize: 18, marginBottom: 6 }}>
                  {roundNumberForIntro ? `La manche ${roundNumberForIntro} commence dans :` : "La manche commence dans :"}
                </div>
                <div style={{ fontSize: "5rem", fontWeight: 800, lineHeight: 1 }}>
                  {introCountdownSec}
                </div>
              </div>
            ) : isQuestionPhase ? (
              <h1 style={{ fontSize: "2rem", margin: 0 }}>{currentQuestion.text}</h1>
            ) : isRevealAnswerPhase ? (
              <div style={{ marginTop: 8, marginBottom: 4 }}>
                <div style={{ opacity: 0.85, fontSize: 18, marginBottom: 8 }}>
                  {revealPhrase}
                </div>
                <h1 style={{ fontSize: "2.2rem", margin: 0 }}>{primaryAnswer}</h1>
              </div>
            ) : isCountdownPhase ? (
              <div style={{ marginTop: 8, marginBottom: 4 }}>
                <div style={{ opacity: 0.85, fontSize: 18, marginBottom: 6 }}>
                  {countdownLabel}
                </div>
                <div style={{ fontSize: "5rem", fontWeight: 800, lineHeight: 1 }}>
                  {countdownSec}
                </div>
              </div>
            ) : (
              <h1 style={{ fontSize: "2rem", margin: 0 }}>{currentQuestion.text}</h1>
            )}

            {/* Barre de temps sous la question */}
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
                  // 👇 cache la barre tant que le masque est actif
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

            {/* Image pendant la révélation */}
            {isRevealAnswerPhase && currentQuestion?.imageUrl ? (
              <div
                style={{
                  width: SCREEN_IMG_MAX,
                  height: SCREEN_IMG_MAX,
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
                  alt="Révélation — œuvre"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    imageRendering: "auto",
                    visibility: preloadedImage ? "visible" : "hidden",
                  }}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            ) : null}
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

        {/* QR — écran d’attente : juste sous le texte d’attente */}
        {!isRunning && <JoinPanelInline size="md" />}
      </div>

      {/* ===== Colonne scores (droite) ===== */}
      <aside
        aria-label="Classement"
        style={{
          position: "fixed",
          top: 12,
          right: 12,
          bottom: 12,
          width: 320,
          maxWidth: "35vw",
          background: "#0b0f1a",
          border: "1px solid #1f2a44",
          borderRadius: 12,
          padding: 12,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 30,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: 0.2 }}>
            Classement
          </h3>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            Top {Number.isFinite(leaderboardTopN) ? leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N}
          </div>
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
            const medal = s > 0 && (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "");
            const showDelta = Boolean(
              inRevealWindowForLB &&
              currentQuestionIdForLB &&
              p.lastDeltaForQuestionId === currentQuestionIdForLB &&
              Number(p.lastDelta) > 0
            );

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
                  borderBottom: "1px solid #16233b",
                }}
              >
                <div style={{ textAlign: "right", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                  {rank}.
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: p.color || "#64748b",
                        border: "1px solid rgba(255,255,255,0.25)",
                        flex: "0 0 auto",
                      }}
                    />
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

                  {showDelta && (
                    <span
                      style={{
                        display: "inline-block",
                        marginTop: 4,
                        padding: "2px 6px",
                        borderRadius: 9999,
                        background: "#0b3a1e",
                        border: "1px solid #14532d",
                        color: "#86efac",
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
              Aucun joueur.
            </div>
          )}
        </div>
      </aside>

      {/* QR — pendant le quiz : en bas à gauche et 2× plus gros */}
      {isRunning && <JoinPanelFixedBottom />}
    </div>
  );
}