// /pages/screen.js
import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/firebase";
import { collection, doc, getDocs, onSnapshot, orderBy, query } from "firebase/firestore";

/* ============================ CONSTANTES & HELPERS ============================ */
const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :",
];

const REVEAL_DURATION_SEC = 20; // 15s avec la réponse + 5s de décompte
const COUNTDOWN_START_SEC = 5;
const ROUND_START_INTRO_SEC = 5; // mange 5s sur la 1ʳᵉ question de la manche

// Barre de temps
const BAR_H = 6;
const BAR_BLUE = "#3b82f6";
const BAR_RED = "#ef4444";
const HANDLE_COLOR = "#f8fafc";

const SCREEN_IMG_MAX = 300; // px

function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec;            // secondes
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60); // minutes → s (legacy)
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

/* ================================== COMPOSANT ================================= */
export default function Screen() {
  // Données / timing
  const [questionsList, setQuestionsList] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);
  const ignoreCountdownUntilRef = useRef(0);

  const [quizEndSec, setQuizEndSec] = useState(null);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([]);

  // Intro & fin de manche (poussés par l’admin)
  const [isIntro, setIsIntro] = useState(false);
  const [introEndsAtMs, setIntroEndsAtMs] = useState(null);
  const [introRoundIndex, setIntroRoundIndex] = useState(null);
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Anti-flicker intro guard (masque le flash de question avant l'overlay)
  const introGuardUntilRef = useRef(0);
  const prevStartMsRef = useRef(null);

  /* --------------------------- Charger les questions --------------------------- */
  useEffect(() => {
    (async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    })();
  }, []);

  /* ---- Écouter /quiz/state (startAt Timestamp OU startEpochMs) + anti-flash --- */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};

      // calcule startMs depuis startAt (Timestamp) OU startEpochMs (number)
      let startMs = null;
      if (d.startAt && typeof d.startAt.seconds === "number") {
        startMs = d.startAt.seconds * 1000 + Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      } else if (typeof d.startEpochMs === "number") {
        startMs = d.startEpochMs;
      }

      // Anti-flicker (voir Player)
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

      // Flags intro / fin-manche
      setIsIntro(!!d.isIntro);
      setIntroEndsAtMs(typeof d.introEndsAtMs === "number" ? d.introEndsAtMs : null);
      setIntroRoundIndex(Number.isInteger(d.introRoundIndex) ? d.introRoundIndex : null);
      setLastAutoPausedRoundIndex(
        Number.isInteger(d.lastAutoPausedRoundIndex) ? d.lastAutoPausedRoundIndex : null
      );
    });
    return () => unsub();
  }, []);

  /* ------------------------------- Écouter config ------------------------------ */
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

  /* -------------------------------- Timer local (avec clamp fin de quiz) -------------------------------- */
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


  /* Anti-flicker: ignorer le bloc "décompte 5s" pendant ~600ms après un seek/reprise */
  useEffect(() => {
    if (typeof quizStartMs === "number") {
      ignoreCountdownUntilRef.current = Date.now() + 600;
    } else {
      ignoreCountdownUntilRef.current = 0;
    }
  }, [quizStartMs]);

  /* --------------- Choix question active (borné à la manche courante) --------- */
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

  // Dernière question dans [currentRoundStart, elapsedSec[
  let activeIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (!Number.isFinite(t) || t < currentRoundStart) continue;
    if (t <= elapsedSec && t < currentRoundEnd) activeIndex = i;
    else if (t >= currentRoundEnd) break;
  }
  const currentQuestion = activeIndex >= 0 ? sorted[activeIndex] : null;
  const currentQuestionId = currentQuestion?.id ?? null; // pour useMemo deps

  /* --------------- Prochaine échéance (question / manche / fin quiz) ---------- */
  // Prochaine question
  let nextTimeSec = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (Number.isFinite(t) && t > elapsedSec) {
      nextTimeSec = t;
      break;
    }
  }

  // Prochaine manche
  const GAP = 1;
  const nextRoundStart = nextRoundStartAfter(elapsedSec, roundOffsetsSec);
  const nextRoundBoundary = Number.isFinite(nextRoundStart) ? Math.max(0, nextRoundStart - GAP) : null;

  // Fenêtre morte (1s avant la frontière)
  const ROUND_DEADZONE_SEC = 1;
  const secondsToRoundBoundary = Number.isFinite(nextRoundStart) ? nextRoundStart - elapsedSec : null;
  const inRoundBoundaryWindow =
    secondsToRoundBoundary != null &&
    secondsToRoundBoundary <= ROUND_DEADZONE_SEC &&
    secondsToRoundBoundary >= -0.25;

  // Min des candidates
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

  // Base locale indépendante de qStart (au cas où l'ordre des blocs change)
  const qStartBase =
    Number.isFinite(getTimeSec(currentQuestion)) ? getTimeSec(currentQuestion) : null;

  const firstQuestionTimeInCurrentRound = (() => {
    for (let i = 0; i < sorted.length; i++) {
      const t = getTimeSec(sorted[i]);
      if (!Number.isFinite(t)) continue;
      if (t >= currentRoundStart && t < currentRoundEnd) return t;
    }
    return null;
  })();

  const isFirstQuestionOfRound =
    Number.isFinite(qStartBase) &&
    Number.isFinite(firstQuestionTimeInCurrentRound) &&
    qStartBase === firstQuestionTimeInCurrentRound;

  const introStart = isFirstQuestionOfRound ? qStartBase : null;
  const introEnd =
    isFirstQuestionOfRound && Number.isFinite(qStartBase)
      ? qStartBase + ROUND_START_INTRO_SEC
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
  const qStartEffective =
    isFirstQuestionOfRound && Number.isFinite(qStartBase)
      ? qStartBase + ROUND_START_INTRO_SEC
      : qStartBase;

  // Compte à rebours affiché 5..1
  const introCountdownSec = isRoundIntroPhase
    ? Math.max(1, Math.ceil((introEnd ?? 0) - elapsedSec))
    : null;

  // Numéro de manche pour l’UI
  const roundIdxForCurrentQuestion = Number.isFinite(qStartBase)
    ? roundIndexOfTime(Math.max(0, qStartBase), roundOffsetsSec)
    : null;
  const roundNumberForIntro =
    roundIdxForCurrentQuestion != null ? roundIdxForCurrentQuestion + 1 : null;



  // Fin de manche (pause posée au boundary par l’admin)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;
  const isQuizEnded = typeof quizEndSec === "number" && elapsedSec >= quizEndSec;
  const isRoundBreak = Boolean(isPaused && endedRoundIndex != null && !isQuizEnded);

  // Fenêtres de phases (bornes fixes → pas de flash)
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

  // Intro (garde visuelle)
  const isRoundIntro = Date.now() < (introGuardUntilRef?.current || 0);
  const introRemaining = 0;

  // Barre de progression (autonome, sans dépendre d'une var qEnd externe)
  const boundaryLocal = (typeof boundary !== "undefined" ? boundary : effectiveNextTimeSec);
  const qEndLocal = boundaryLocal != null ? boundaryLocal - REVEAL_DURATION_SEC : null;

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

  // Préchargement image reveal
  useEffect(() => {
    if (currentQuestion?.imageUrl) {
      const img = new Image();
      img.src = currentQuestion.imageUrl;
    }
  }, [currentQuestion?.imageUrl]);

  // Infos attente
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;

  const showPreStart = !(quizStartMs && isRunning);

  /* ================================== RENDER ================================== */
  if (showPreStart) {
    return (
      <div
        style={{
          background: "#000814",
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
            EleyBox — Écran en attente
          </h1>
          <p style={{ opacity: 0.8, marginTop: 12 }}>
            Le quiz n'a pas encore commencé. Préparez-vous…
          </p>
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
        minHeight: "100vh",
        position: "relative",
      }}
    >
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
      <div style={{ flex: 2, padding: "40px" }}>
        {isQuizEnded ? (
          <>
            <h1 style={{ fontSize: "2.4rem", marginTop: 6 }}>Le gagnant est…</h1>
            <p style={{ opacity: 0.85, marginTop: 8 }}>(écran de fin — scoring à venir)</p>
          </>
        ) : isRoundBreak ? (
          <div style={{ marginTop: 8, marginBottom: 4 }}>
            <h1 style={{ fontSize: "2rem", margin: 0 }}>
              Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
            </h1>
            <div style={{ opacity: 0.85, fontSize: 18, marginTop: 8 }}>
              (Ici, le tableau des scores — placeholder)
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
            {/* fin de manche / intro de manche / question / révélation */}
            {isRoundBreak ? (
              <div style={{ marginTop: 8, marginBottom: 4 }}>
                <h1 style={{ fontSize: "2rem", margin: 0 }}>
                  Fin de la manche {endedRoundIndex != null ? endedRoundIndex + 1 : ""}
                </h1>
                <div style={{ opacity: 0.85, fontSize: 18, marginTop: 8 }}>
                  (Ici, le tableau des scores — placeholder)
                </div>
              </div>
            ) : isRoundIntroPhase ? (
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
                  width: "min(520px, 80%)",
                  height: BAR_H,
                  marginTop: 12,
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
                  style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "auto" }}
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
      </div>

      {/* Zone scores (droite) */}
      <div style={{ flex: 1, padding: "20px", background: "#001d3d" }}>
        <h2>Tableau des scores</h2>
        <p>(Les scores seront ajoutés ici plus tard)</p>
      </div>
    </div>
  );
}
