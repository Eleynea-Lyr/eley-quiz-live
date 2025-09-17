// /pages/player.js
import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/firebase";
import { collection, doc, getDocs, onSnapshot, orderBy, query } from "firebase/firestore";

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

/* =============================== COMPOSANT =============================== */
export default function Player() {
  /* -------- Données & timing -------- */
  const [questionsList, setQuestionsList] = useState([]);

  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  const [quizEndSec, setQuizEndSec] = useState(null);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([]);

  // Intro & fin de manche (pilotées via /quiz/state)
  const [isIntro, setIsIntro] = useState(false);
  const [introEndsAtMs, setIntroEndsAtMs] = useState(null);
  const [introRoundIndex, setIntroRoundIndex] = useState(null);
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Anti-flicker
  const introGuardUntilRef = useRef(0);
  const prevStartMsRef = useRef(null);
  const ignoreCountdownUntilRef = useRef(0);

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
  // Récup questions
  useEffect(() => {
    (async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    })();
  }, []);

  // État live (Timestamp OU startEpochMs) + petite garde anti-flash
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

      // Anti-flicker : masque l'UI question pendant ~300ms au moment d'un seek/reprise/intro
      const now = Date.now();
      if (
        (startMs && prevStartMsRef.current !== startMs) ||
        d.isIntro === true ||
        typeof d.introEndsAtMs === "number"
      ) {
        introGuardUntilRef.current = now + 300;
        if (startMs) prevStartMsRef.current = startMs;
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

      // Flags intro / fin de manche
      setIsIntro(!!d.isIntro);
      setIntroEndsAtMs(typeof d.introEndsAtMs === "number" ? d.introEndsAtMs : null);
      setIntroRoundIndex(Number.isInteger(d.introRoundIndex) ? d.introRoundIndex : null);
      setLastAutoPausedRoundIndex(
        Number.isInteger(d.lastAutoPausedRoundIndex) ? d.lastAutoPausedRoundIndex : null
      );
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

  // Timer local
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
    const tick = () =>
      setElapsedSec(Math.max(0, Math.floor((Date.now() - quizStartMs) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs]);

  // Anti-flicker : petite fenêtre d’ignorance du décompte après seek/reprise (réserve)
  useEffect(() => {
    if (typeof quizStartMs === "number") {
      ignoreCountdownUntilRef.current = Date.now() + 600;
    } else {
      ignoreCountdownUntilRef.current = 0;
    }
  }, [quizStartMs]);

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

  // Fin de manche (pause posée à la frontière par l’admin)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;
  const isRoundBreak = Boolean(isPaused && endedRoundIndex != null);

  // Phases
  const nextEvent = effectiveNextTimeSec;
  const revealStart = nextEvent != null ? nextEvent - REVEAL_DURATION_SEC : null;
  const countdownStart = nextEvent != null ? nextEvent - COUNTDOWN_START_SEC : null;

  const isQuestionPhase = Boolean(
    currentQuestion &&
      qStart != null &&
      nextEvent != null &&
      elapsedSec >= qStart &&
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

  // Intro (garde visuelle)
  const isRoundIntro = Date.now() < (introGuardUntilRef?.current || 0);
  const introRemaining = 0;

  // Barre de progression
  const canShowTimeBar = Boolean(
    isQuestionPhase && qStart != null && qEnd != null && qEnd > qStart
  );
  const progress = canShowTimeBar
    ? Math.min(1, Math.max(0, (elapsedSec - qStart) / (qEnd - qStart)))
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

  const handleSubmit = (e) => {
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

  /* ================================ RENDER =============================== */
  if (showPreStart) {
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
        <div>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0 }}>
            EleyBox — En attente du départ
          </h1>
          <p style={{ opacity: 0.8, marginTop: 12 }}>
            L'Admin n'a pas encore lancé le quiz.
          </p>
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
          {isQuestionPhase ? (
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
          <form onSubmit={handleSubmit}>
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
