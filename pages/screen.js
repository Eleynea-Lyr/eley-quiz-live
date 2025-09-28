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

// ====== JOIN (DEV) ======
const DEV_JOIN_URL = "http://192.168.1.118:3000/player";
const JOIN_QR_SRC = "/qr-join-dev.png"; // fichier placé dans /public

// Barre de temps
const BAR_H = 6;
const BAR_BLUE = "#3b82f6";
const BAR_RED = "#ef4444";
const HANDLE_COLOR = "#f8fafc";

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

const SCREEN_IMG_MAX = 300; // px

function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec;
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60);
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

function Splash() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a1a",
      }}
      aria-hidden="true"
    />
  );
}

/* ================================== COMPOSANT ================================= */
export default function Screen() {
  const [stateLoaded, setStateLoaded] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [questionsLoaded, setQuestionsLoaded] = useState(false);

  // Données / timing
  const [questionsList, setQuestionsList] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  const [quizEndSec, setQuizEndSec] = useState(null);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([]);

  // Fin de manche (poussée par l’admin)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  /* --------------------------- Charger les questions --------------------------- */
  useEffect(() => {
    (async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      setQuestionsLoaded(true);
    })();
  }, []);

  /* ---- Écouter /quiz/state (startAt Timestamp OU startEpochMs) ---- */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = (snap && snap.data()) || {};

      // calcule startMs depuis startAt (Timestamp) OU startEpochMs (number)
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

  /* ------------------------------- Écouter config ------------------------------ */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data();
      setQuizEndSec(typeof d?.endOffsetSec === "number" ? d.endOffsetSec : null);
      setRoundOffsetsSec(
        Array.isArray(d?.roundOffsetsSec) ? d.roundOffsetsSec.map((v) => (Number.isFinite(v) ? v : null)) : []
      );
      setConfigLoaded(true);
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
  const currentQuestionId = currentQuestion?.id ?? null;

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

  // Bornes locales de la question (intro mangée sur la 1ʳᵉ question de la manche)
  const qStart = Number.isFinite(getTimeSec(currentQuestion)) ? getTimeSec(currentQuestion) : null;

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
  const introEnd =
    isFirstQuestionOfRound && Number.isFinite(qStart)
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

  // Le temps “jouable” commence après l’intro
  const qStartEffective =
    isFirstQuestionOfRound && Number.isFinite(qStart)
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
  const roundNumberForIntro =
    roundIdxForCurrentQuestion != null ? roundIdxForCurrentQuestion + 1 : null;

  // Fin de manche (pause posée au boundary par l’admin)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;
  const isQuizEnded = typeof quizEndSec === "number" && elapsedSec >= quizEndSec;
  const isRoundBreak = Boolean(isPaused && endedRoundIndex != null && !isQuizEnded);

  // Phases bornées (pas de flash)
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
  const qEndLocal = nextEvent != null ? nextEvent - REVEAL_DURATION_SEC : null;
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

  if (!stateLoaded || !configLoaded || !questionsLoaded) {
    return <Splash />; // 👈 plein bleu pendant le tout premier chargement
  }

  if (showPreStart) {
    return (
      <div style={{
        background: "#000814", color: "#fff", minHeight: "100vh",
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
      <div style={{ flex: 2, padding: "40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
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

        {/* QR — écran d’attente : juste sous le texte d’attente */}
        {!isRunning && <JoinPanelInline size="md" />}
      </div>

      {/* Zone scores (droite) */}
      <div style={{ flex: 1, padding: "20px", background: "#0b1e3d" }}>
        <h2>Tableau des scores</h2>
        <p>(Les scores seront ajoutés ici plus tard)</p>
      </div>

      {/* QR — pendant le quiz : en bas à gauche et 2× plus gros */}
      {isRunning && <JoinPanelFixedBottom />}
    </div>
  );
}
