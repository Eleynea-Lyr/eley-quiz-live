// ============================================================================
// /pages/screen.js — Refactoré avec imports depuis /lib
// Scope : Écran de scène/projection avec leaderboard temps réel
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/firebase";
import {
  collection, doc, getDocs, onSnapshot, query,
  where
} from "firebase/firestore";

// Imports depuis les fichiers utilitaires
import {
  REVEAL_DURATION_SEC,
  COUNTDOWN_START_SEC,
  ROUND_START_INTRO_SEC,
  UI_MASK_MS,
  BAR_H,
  BAR_BLUE,
  BAR_RED,
  HANDLE_COLOR,
  SCREEN_IMG_MAX,
  DEFAULT_LEADERBOARD_TOP_N,
  DEFAULT_SCORING_TABLE,
  BUZZER_STATES,
  BUZZER_CORRECT_MESSAGE_DURATION_MS,
  BUZZER_WRONG_MESSAGE_DURATION_MS,
} from "../lib/constants";

import {
  getTimeSec,
  formatHMS,
  pickRevealPhrase,
  roundIndexOfTime,
  nextRoundStartAfter,
  normalizeNameAlpha,
  addSmartLineBreaks,
} from "../lib/utils";

import {
  useMobileVH,
  ensureAwardsForQuestionTx,
} from "../lib/firebase-helpers";

import { SCREEN_MESSAGES } from "../lib/messages";

// ====== Constantes spécifiques à screen.js ======

// JOIN (DEV)
//const DEV_JOIN_URL = "http://192.168.1.118:3000/player";
//const JOIN_QR_SRC = "/qr-join-dev.png";

// JOIN (PUBLIC OK)
const DEV_JOIN_URL = "https://eley-quiz-live.vercel.app/player";
const JOIN_QR_SRC = "/qr-code-public-OK.png";

// Colonne gauche (image générique)
const LEFT_GENERIC_IMG_SRC = "/Chibi_Eley.png";


// Panneau "Rejoindre" (inline)
function JoinPanelInline({ size = "md" }) {
  const imgSize = size === "lg" ? 320 : 160;
  const panelStyle = {
    marginTop: 0, // évite le décalage dans le cadre
    width: size === "lg" ? "100%" : 320,
    boxSizing: "border-box",
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
        style={{
          display: "block",
          marginTop: 10,
          width: "100%",
          maxWidth: 320,
          height: "auto",
        }}
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

// ============================================================================
// /pages/screen.js — Partie 2/5
// Scope : Composant Screen — états/refs, abonnements Firestore (questions,
// joueurs, config, état global) et timer local synchronisé.
// ============================================================================

function ScreenInner() {
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
  const [countdownStartSec, setCountdownStartSec] = useState(COUNTDOWN_START_SEC);
  const [roundStartIntroSec, setRoundStartIntroSec] = useState(ROUND_START_INTRO_SEC);
  const [activeQuizKey, setActiveQuizKey] = useState(null);

  // Image optionnelle au-dessus du QR (config: screenLeftImageUrl)
  const [leftImageUrl, setLeftImageUrl] = useState(null);

  // Messages personnalisables
  const [podiumTitle, setPodiumTitle] = useState(SCREEN_MESSAGES.podiumTitle);
  const [finalPodiumTitle, setFinalPodiumTitle] = useState(SCREEN_MESSAGES.finalPodiumTitle);

  // Leaderboard
  const [playersLB, setPlayersLB] = useState([]);
  const [leaderboardTopN, setLeaderboardTopN] = useState(DEFAULT_LEADERBOARD_TOP_N);
  const awardGuardRef = useRef({}); // utilisé plus tard pour l’attribution des points

  // Fin de manche (poussée par l’admin)
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  // Offset d’horloge serveur (ms) — mis à jour via /quiz/state.serverNow
  const serverDeltaRef = useRef(0);
  const [serverDeltaTick, setServerDeltaTick] = useState(0); // re-render léger si besoin

  // Dernier reset global des joueurs (playersResetAt) déjà pris en compte
  const lastPlayersResetAtRef = useRef(0);

  // Préchargement images (réponse + question) pour éviter le flash
  const [preloadedAnswerImage, setPreloadedAnswerImage] = useState(null);
  const [preloadedQuestionImage, setPreloadedQuestionImage] = useState(null);
  const [syncHoleSince, setSyncHoleSince] = useState(null);


  // Table de points (pour afficher +30/+25/+20)
  const [scoringTable, setScoringTable] = useState(DEFAULT_SCORING_TABLE);

  // Top 3 live pour la question courante (pendant la phase "question")
  // Format: [{ playerId }]
  const [liveFirsts, setLiveFirsts] = useState([]);

  // EleyBuzz state
  const [isBuzzerMode, setIsBuzzerMode] = useState(false);
  const [buzzerState, setBuzzerState] = useState("idle");
  const [firstPlayerId, setFirstPlayerId] = useState(null);
  const [firstPlayerName, setFirstPlayerName] = useState(null);
  const [buzzerMessage, setBuzzerMessage] = useState(null);
  const [buzzerMessageType, setBuzzerMessageType] = useState(null);

  // Score Final state
  const [showFinalScore, setShowFinalScore] = useState(false);

  // Accès rapide aux noms des joueurs par id
  const playersById = useMemo(() => {
    const map = Object.create(null);
    for (const p of playersLB) map[p.id] = p;
    return map;
  }, [playersLB]);

  // Charger la table de scoring une fois
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const t = await getScoringTableScreen();
        if (mounted && Array.isArray(t)) setScoringTable(t);
      } catch {
        // fallback déjà en place via DEFAULT_SCORING_TABLE
      }
    })();
    return () => { mounted = false; };
  }, []);



  /* --------------------------- Charger les questions --------------------------- */
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // Pas de quiz actif connu → liste vide mais "loaded" (évite un splash infini)
        if (!activeQuizKey) {
          if (!cancelled) {
            setQuestionsList([]);
            setQuestionsLoaded(true);
          }
          return;
        }

        const q = query(
          collection(db, "LesQuestions"),
          where("quizKey", "==", activeQuizKey)
        );
        const snapshot = await getDocs(q);
        if (!cancelled) {
          setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
          setQuestionsLoaded(true);
        }
      } catch (e) {
        console.error("[Screen] load questions failed:", e);
        if (!cancelled) {
          setQuestionsList([]);
          setQuestionsLoaded(true);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [activeQuizKey]);


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
          buzzScore: Number(v.buzzScore || 0),
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

      // Quiz actif
      const activeKey =
        typeof d?.activeQuizKey === "string" && d.activeQuizKey.trim()
          ? d.activeQuizKey.trim()
          : null;
      setActiveQuizKey(activeKey);

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
      const cs = Number.isFinite(d?.countdownStartSec) ? d.countdownStartSec : COUNTDOWN_START_SEC;
      setCountdownStartSec(cs);
      const ris = Number.isFinite(d?.roundStartIntroSec) ? d.roundStartIntroSec : ROUND_START_INTRO_SEC;
      setRoundStartIntroSec(ris);

      // Image optionnelle au-dessus du QR (fallback sur LEFT_GENERIC_IMG_SRC si absent)
      setLeftImageUrl(
        typeof d?.screenLeftImageUrl === "string" && d.screenLeftImageUrl.trim() !== ""
          ? d.screenLeftImageUrl
          : (LEFT_GENERIC_IMG_SRC || null)
      );

      // Messages personnalisables depuis Firestore
      const customPodiumTitle = typeof d?.screenQuiz?.podiumTitle === "string" && d.screenQuiz.podiumTitle.trim() !== ""
        ? d.screenQuiz.podiumTitle
        : SCREEN_MESSAGES.podiumTitle;
      setPodiumTitle(customPodiumTitle);
      const customFinalPodiumTitle = typeof d?.screenQuiz?.finalPodiumTitle === "string" && d.screenQuiz.finalPodiumTitle.trim() !== ""
        ? d.screenQuiz.finalPodiumTitle
        : SCREEN_MESSAGES.finalPodiumTitle;
      setFinalPodiumTitle(customFinalPodiumTitle);

      setConfigLoaded(true);
    });
    return () => unsub();
  }, []);


  /* ------------------------------ Écouter /state ------------------------------ */
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = (snap && snap.data()) || {};

      // Reset runtime local si un nouveau reset global est détecté
      const tReset = d.playersResetAt;
      if (tReset && typeof tReset.seconds === "number") {
        const ms =
          tReset.seconds * 1000 +
          Math.floor((tReset.nanoseconds || tReset.nanos || 0) / 1e6);

        // Nouveau reset vu → on vide toutes les sentinelles locales de session
        if (ms > lastPlayersResetAtRef.current) {
          lastPlayersResetAtRef.current = ms;

          // Gardes TX (awards), top live, images et timer local
          awardGuardRef.current = {};
          setLiveFirsts([]);
          setPreloadedAnswerImage(null);
          setPreloadedQuestionImage(null);
          setElapsedSec(0);
        }
      }

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

      // EleyBuzz state
      setIsBuzzerMode(!!d.isBuzzerMode);
      setBuzzerState(typeof d.buzzerState === "string" ? d.buzzerState : "idle");
      setFirstPlayerId(typeof d.firstPlayerId === "string" ? d.firstPlayerId : null);
      setFirstPlayerName(typeof d.firstPlayerName === "string" ? d.firstPlayerName : null);
      setBuzzerMessage(typeof d.buzzerMessage === "string" ? d.buzzerMessage : null);
      setBuzzerMessageType(typeof d.buzzerMessageType === "string" ? d.buzzerMessageType : null);
      setShowFinalScore(!!d.showFinalScore);

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

  // Podium (fin de quiz) : basé sur les RANGS (1, 2, 3) comme dans le classement
  // Score final = score quiz uniquement (sans EleyBuzz pour la fin de quiz normale)
  const podium = useMemo(() => {
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => {
        const scoreQuiz = Number(p.score || 0);
        return {
          id: p.id,
          name: p.name || "",
          score: scoreQuiz,
          _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
        };
      })
      .sort((a, b) => {
        // Tri par score quiz uniquement, puis nom
        if (a.score !== b.score) return b.score - a.score;
        return a._nameKey.localeCompare(b._nameKey);
      });

    // Calcul des rangs "compétition" : 1,1,3,4… (basé sur score quiz)
    let lastScore = null;
    let lastRank = 0;
    rows.forEach((p, i) => {
      const sc = p.score;
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

    // Groupes de médailles alignés sur le classement (basé sur score quiz)
    const gold = rows.filter((p) => p.score > 0 && p._rank === 1);
    const silver = rows.filter((p) => p.score > 0 && p._rank === 2);
    const bronze = rows.filter((p) => p.score > 0 && p._rank === 3);

    return { gold, silver, bronze };
  }, [playersLB]);

  // Podium final (Score Final de la soirée) : Quiz + EleyBuzz
  const finalPodium = useMemo(() => {
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => {
        const scoreQuiz = Number(p.score || 0);
        const buzzScore = Number(p.buzzScore || 0);
        const scoreFinal = scoreQuiz + buzzScore;
        return {
          id: p.id,
          name: p.name || "",
          score: scoreQuiz,
          buzzScore: buzzScore,
          scoreFinal: scoreFinal,
          _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
        };
      })
      .sort((a, b) => {
        // Tri par score final (quiz + EleyBuzz), puis nom
        if (a.scoreFinal !== b.scoreFinal) return b.scoreFinal - a.scoreFinal;
        return a._nameKey.localeCompare(b._nameKey);
      });

    // Calcul des rangs "compétition" : 1,1,3,4… (basé sur scoreFinal)
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

    // Groupes de médailles alignés sur le classement (basé sur scoreFinal)
    const gold = rows.filter((p) => p.scoreFinal > 0 && p._rank === 1);
    const silver = rows.filter((p) => p.scoreFinal > 0 && p._rank === 2);
    const bronze = rows.filter((p) => p.scoreFinal > 0 && p._rank === 3);

    return { gold, silver, bronze, all: rows };
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

  const boundaryRoundIndex =
    Number.isFinite(nextRoundStart)
      ? roundIndexOfTime(Math.max(0, nextRoundStart - 0.001), roundOffsetsSec)
      : null;

  // Candidat minimal
  // On re-considère la frontière de manche (nextRoundBoundary) comme un
  // "événement" à part entière pour retrouver le compte à rebours
  // "Fin de la manche X dans :".
  let effectiveNextTimeSec = null;
  let nextKind = null; // "question" | "end" | "round"
  {
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
    ? qStart + roundStartIntroSec
    : null;

  // Le temps "jouable" commence après l'intro
  const qStartEffective =
    isFirstQuestionOfRound && Number.isFinite(qStart)
      ? qStart + roundStartIntroSec
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

  // On ne considère "Fin de manche" que si :
  //  - la pause vient bien d'une auto-pause (endedRoundIndex != null)
  //  - ET qu'on est encore dans la fenêtre de temps de cette manche
  let isRoundBreak = false;
  if (isPaused && endedRoundIndex != null && !isQuizEnded) {
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




  // Phases bornées (anti-flash)
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

    ensureAwardsForQuestionTx(db, qid).catch((e) => {
      console.error("[Screen] awards TX error:", e);
      delete awardGuardRef.current[qid]; // autorise un retry si la TX échoue
    });
  }, [currentQuestion?.id, isRevealAnswerPhase, isCountdownPhase]);

  /* ---------------------- Variables d’UI dérivées ---------------------- */
  // Décompte (jamais 0s)
  const secondsToNext = nextEvent != null ? nextEvent - elapsedSec : null;
  const countdownSec = isCountdownPhase
    ? Math.max(1, Math.min(countdownStartSec, Math.ceil(secondsToNext)))
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

  // Détecter si la réponse est courte (moins de 30 caractères) pour forcer une seule ligne
  // Exception : si elle contient ! ou ?, on permet les retours à la ligne après ces ponctuations
  const isShortAnswer = useMemo(() => {
    if (!primaryAnswer) return false;
    // Si la réponse contient ! ou ?, on ne force pas nowrap même si elle est courte
    if (/[!?]/.test(primaryAnswer)) return false;
    return primaryAnswer.length < 30;
  }, [primaryAnswer]);

  // URLs images (question / réponse) avec fallbacks :
  // - questionImgUrl : seulement les champs dédiés "image question" (jamais l'ancien 'image')
  // - answerImgUrl   : champs dédiés "image réponse", puis (legacy) 'imageUrl' / 'image'
  const questionImgUrl = useMemo(() => {
    const q = currentQuestion || {};
    // champs possibles côté Admin pour l'image de la question
    return (
      (typeof q.questionImageUrl === "string" && q.questionImageUrl.trim()) ||
      (typeof q.imageQuestionUrl === "string" && q.imageQuestionUrl.trim()) ||
      (typeof q.imageQuestion === "string" && q.imageQuestion.trim()) ||
      null
    );
  }, [currentQuestionId]);

  const answerImgUrl = useMemo(() => {
    const q = currentQuestion || {};
    // champs dédiés "image réponse", puis compat avec anciens champs
    return (
      (typeof q.answerImageUrl === "string" && q.answerImageUrl.trim()) ||
      (typeof q.imageReponseUrl === "string" && q.imageReponseUrl.trim()) ||
      (typeof q.imageReponse === "string" && q.imageReponse.trim()) ||
      (typeof q.imageUrl === "string" && q.imageUrl.trim()) || // legacy
      (typeof q.image === "string" && q.image.trim()) || // très legacy ("image" tout court)
      null
    );
  }, [currentQuestionId]);


  // Abonnement live aux 3 premiers joueurs ayant trouvé (pendant la phase question)
  useEffect(() => {
    // Reset à chaque nouvelle question ou si on sort de la phase "question"
    setLiveFirsts([]);
    const qid = currentQuestionId;
    if (!qid || !isQuestionPhase) return;

    // Helper local pour normaliser un temps en ms (comme dans ensureAwardsForQuestionTx)
    const toMs = (obj) => {
      if (!obj) return Infinity;
      if (typeof obj.toMillis === "function") return obj.toMillis();
      if (typeof obj.seconds === "number") {
        return obj.seconds * 1000 + Math.floor((obj.nanoseconds || obj.nanos || 0) / 1e6);
      }
      if (typeof obj === "number" && Number.isFinite(obj)) return Math.floor(obj);
      return Infinity;
    };

    try {
      const subsCol = collection(db, "answers", qid, "submissions");
      // ⚠️ Pas de orderBy ici (certains docs n'ont pas firstCorrectAt) → on trie côté client
      const q = query(subsCol, where("isCorrect", "==", true));
      const unsub = onSnapshot(q, (snap) => {
        const ranked = snap.docs
          .map((d) => {
            const data = d.data() || {};
            const t = Math.min(
              toMs(data.firstCorrectAt),
              typeof data.firstCorrectAtMs === "number" ? data.firstCorrectAtMs : Infinity,
              toMs(data.createdAt),
              toMs(data.updatedAt)
            );
            return { playerId: d.id, t };
          })
          .filter((x) => Number.isFinite(x.t))
          .sort((a, b) => a.t - b.t)
          .slice(0, 3);

        setLiveFirsts(ranked.map((x) => ({ playerId: x.playerId })));
      });
      return () => unsub();
    } catch (e) {
      console.error("[Screen] live podium subscription error:", e);
    }
  }, [currentQuestionId, isQuestionPhase]);



  // Infos attente
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;

  // Pré-start
  const showPreStart = !(quizStartMs && isRunning);

  // Watchdog de synchronisation :
  // si on reste coincé trop longtemps sans question alors que le quiz tourne,
  // on force un reload doux pour se recaler.
  useEffect(() => {
    const inSyncHole =
      isRunning &&
      !isPaused &&
      !isQuizEnded &&
      earliestTimeSec != null &&
      elapsedSec >= earliestTimeSec + 2 && // on laisse 2s de marge
      !currentQuestion;

    if (!inSyncHole) {
      if (syncHoleSince !== null) {
        setSyncHoleSince(null);
      }
      return;
    }

    // Première fois qu'on détecte le trou de synchro → on démarre le chrono
    if (syncHoleSince === null) {
      setSyncHoleSince(Date.now());
      return;
    }

    // Si ça dure plus de 5s → reload automatique
    const elapsedMs = Date.now() - syncHoleSince;
    if (elapsedMs > 5000) {
      try {
        window.location.reload();
      } catch {
        // no-op si le contexte ne permet pas le reload
      }
    }
  }, [
    isRunning,
    isPaused,
    isQuizEnded,
    earliestTimeSec,
    elapsedSec,
    currentQuestion,
    syncHoleSince,
  ]);


  // Variables spécifiques au leaderboard pendant reveal
  const currentQuestionIdForLB = currentQuestionId;
  const inRevealWindowForLB = Boolean(isRevealAnswerPhase || isCountdownPhase);

  // Préchargement image RÉPONSE (anti-flicker au reveal)
  useEffect(() => {
    setPreloadedAnswerImage(null);
    const url = answerImgUrl;
    if (!url) return;

    let cancelled = false;
    const img = new Image();
    img.src = url;

    const markReady = () => { if (!cancelled) setPreloadedAnswerImage(url); };

    if (typeof img.decode === "function") {
      img.decode().then(markReady).catch(markReady);
    } else {
      img.onload = markReady;
      img.onerror = () => { if (!cancelled) setPreloadedAnswerImage(null); };
    }
    return () => { cancelled = true; };
  }, [answerImgUrl, currentQuestionId]);

  // Préchargement image QUESTION (anti-flicker pendant la phase question)
  useEffect(() => {
    setPreloadedQuestionImage(null);
    const url = questionImgUrl;
    if (!url) return;

    let cancelled = false;
    const img = new Image();
    img.src = url;

    const markReady = () => { if (!cancelled) setPreloadedQuestionImage(url); };

    if (typeof img.decode === "function") {
      img.decode().then(markReady).catch(markReady);
    } else {
      img.onload = markReady;
      img.onerror = () => { if (!cancelled) setPreloadedQuestionImage(null); };
    }
    return () => { cancelled = true; };
  }, [questionImgUrl, currentQuestionId]);



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
  // EleyBuzz Mode — Gestion des messages temporaires et leaderboard
  // IMPORTANT: Ces hooks doivent être AVANT tous les early returns conditionnels
  // ============================================================================
  
  // Gestion des messages temporaires avec auto-dismiss
  useEffect(() => {
    if (!isBuzzerMode || !buzzerMessage || !buzzerMessageType) return;

    const duration = buzzerMessageType === "correct"
      ? BUZZER_CORRECT_MESSAGE_DURATION_MS
      : BUZZER_WRONG_MESSAGE_DURATION_MS;

    const timer = setTimeout(() => {
      setBuzzerMessage(null);
      setBuzzerMessageType(null);
    }, duration);

    return () => clearTimeout(timer);
  }, [isBuzzerMode, buzzerMessage, buzzerMessageType]);

  // Réinitialiser tous les états EleyBuzz locaux quand le mode est désactivé
  useEffect(() => {
    if (!isBuzzerMode) {
      // Quand EleyBuzz est désactivé, réinitialiser tous les états locaux
      setBuzzerMessage(null);
      setBuzzerMessageType(null);
    }
  }, [isBuzzerMode]);

  // Leaderboard EleyBuzz (trié par buzzScore)
  const buzzerLeaderboard = useMemo(() => {
    if (!isBuzzerMode) return [];
    
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => ({
        id: p.id,
        name: p.name || "",
        buzzScore: Number(p.buzzScore || 0),
        _nameKey: p._nameKey || normalizeNameAlpha(p.name || ""),
      }))
      .sort((a, b) => {
        if (a.buzzScore !== b.buzzScore) return b.buzzScore - a.buzzScore;
        return a._nameKey.localeCompare(b._nameKey);
      });

    // Calcul des rangs avec égalités
    let lastScore = null;
    let lastRank = 0;
    rows.forEach((p, i) => {
      const sc = p.buzzScore;
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
  }, [isBuzzerMode, playersLB]);

  // Largeur bornée + retours à la ligne + descente légère
  // Aligné avec Player pour cohérence
  const screenQuestionStyle = {
    fontSize: "clamp(1.1rem, 4.2vw, 1.45rem)", // Même taille que Player
    lineHeight: 1.5,
    margin: 0,
    marginTop: 6,
    maxWidth: "min(600px, 95%)", // Même largeur que Player
    marginLeft: "auto",
    marginRight: "auto",
    overflowWrap: "break-word", // Moins agressif que "anywhere"
    wordBreak: "normal", // Évite de couper les mots au milieu
    hyphens: "auto",
    textAlign: "center", // Centré comme demandé
    letterSpacing: "0.01em", // Légère augmentation pour meilleure lisibilité
  };


  // ============================================================================
  // /pages/screen.js — Partie 4/5
  // Scope : RENDER — écrans pré-start / quiz (question, reveal, countdown),
  // pauses & fins de manche/quiz, colonne classement et panneaux "Rejoindre".
  // (⚠️ Ne PAS fermer la fonction ici — l'accolade finale arrive en partie 5.)
  // ============================================================================

  /* ============================ RENDER (PARTIE 4/4) ============================ */

  if (!stateLoaded || !configLoaded || !questionsLoaded) {
    return <Splash />; // plein écran de boot
  }

  // ============================================================================
  // EleyBuzz Mode — Early return si mode buzzer actif (priorité sur showPreStart)
  // ============================================================================
  if (isBuzzerMode) {
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
        {/* Colonne gauche : image optionnelle + QR */}
        <aside
          aria-label="Infos & QR"
          style={{
            position: "relative",
            width: 360,
            maxWidth: "clamp(280px, 30vw, 400px)",
            maxHeight: "calc(100vh - 24px)",
            background: "#081224",
            border: "1px solid #1f2a44",
            borderRadius: 12,
            padding: 12,
            margin: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignSelf: "flex-start",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {leftImageUrl && (
            <div
              style={{
                borderRadius: 10,
                overflow: "hidden",
                border: "1px solid #1f2a44",
                background: "#0b0f1a",
                flexShrink: 0,
              }}
            >
              <img
                src={leftImageUrl}
                alt=""
                style={{
                  display: "block",
                  width: "100%",
                  height: "clamp(200px, 25vh, 300px)",
                  objectFit: "cover",
                }}
                loading="lazy"
                decoding="async"
              />
            </div>
          )}
          <div style={{ marginTop: "auto", paddingBottom: 0, flexShrink: 0 }}>
            <JoinPanelInline size="lg" />
          </div>
        </aside>

        {/* Colonne centrale : Contenu EleyBuzz */}
        <div
          style={{
            flex: 1,
            padding: "40px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "3rem", fontWeight: 800, margin: 0 }}>
            ⚡ EleyBuzz ⚡
          </h1>

          {/* État du buzzer */}
          {buzzerState === BUZZER_STATES.IDLE && !buzzerMessage && (
            <div 
              style={{ fontSize: "1.5rem", opacity: 0.85, maxWidth: "min(800px, 90%)" }}
              dangerouslySetInnerHTML={{ 
                __html: addSmartLineBreaks("Écoute attentivement la question et appuie vite sur le buzzer de ton téléphone si tu connais la réponse.")
                  .replace(/\.\s+/g, ".<br>")
              }}
            />
          )}

          {buzzerState === BUZZER_STATES.OPEN && (
            <div style={{ fontSize: "1.5rem", opacity: 0.85, color: "#22c55e", fontWeight: 700 }}>
              Le buzzer est OUVERT ! Préparez-vous à buzzer !
            </div>
          )}

          {buzzerState === BUZZER_STATES.LOCKED && firstPlayerName && !buzzerMessage && (
            <div>
              <div style={{ fontSize: "2rem", fontWeight: 800, marginBottom: 8, color: "#facc15" }}>
                {firstPlayerName} a buzzé !
              </div>
              <div style={{ fontSize: "1.2rem", opacity: 0.85 }}>
                On attend sa réponse...
              </div>
            </div>
          )}

          {/* Messages temporaires */}
          {buzzerMessage && buzzerMessageType && (
            <div
              style={{
                fontSize: "2.5rem",
                fontWeight: 800,
                padding: "20px 40px",
                borderRadius: 12,
                background: buzzerMessageType === "correct" ? "#0b3a1e" : "#7f1d1d",
                border: `2px solid ${buzzerMessageType === "correct" ? "#22c55e" : "#dc2626"}`,
                color: buzzerMessageType === "correct" ? "#86efac" : "#fecaca",
                animation: "fadeIn 200ms ease-in",
              }}
            >
              {buzzerMessage}
            </div>
          )}
        </div>

        {/* Colonne droite : Classement EleyBuzz */}
        <aside
          aria-label="Classement EleyBuzz"
          style={{
            width: 320,
            maxWidth: "clamp(280px, 30vw, 400px)",
            maxHeight: "calc(100vh - 24px)",
            background: "#0b0f1a",
            border: "1px solid #1f2a44",
            borderRadius: 12,
            padding: "12px 12px 8px 12px",
            margin: 12,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignSelf: "flex-start",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: 0.2 }}>
                ⚡ EleyBuzz ⚡
              </h3>
            </div>

            {/* Petit bandeau bleu sous le titre */}
            <div
              style={{
                marginTop: 6,
                height: 3,
                borderRadius: 9999,
                background: "#0f172a",
                border: "1px solid #2a488fff",
              }}
            />
          </div>

          <div
            role="list"
            style={{
              marginTop: 4,
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            {buzzerLeaderboard.length > 0 ? (
              buzzerLeaderboard.map((p) => {
                const rank = p._rank;
                const s = Number(p.buzzScore || 0);
                const medal = s > 0 && (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "");
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
                      background: rank <= 3 ? "#1f2937" : "transparent",
                    }}
                  >
                    <div style={{ textAlign: "right", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                      {rank}.
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
                    </div>

                    <div
                      style={{
                        fontWeight: 800,
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: 0.2,
                        color: "#facc15",
                      }}
                      aria-label="score"
                      title={`${p.buzzScore} points`}
                    >
                      {p.buzzScore}
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ opacity: 0.7, padding: 12, textAlign: "center" }}>
                Aucun joueur.
              </div>
            )}
          </div>
        </aside>
      </div>
    );
  }

  // ============================================================================
  // Score Final Mode — Early return si mode score final actif
  // ============================================================================
  if (showFinalScore) {
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
        {/* Colonne gauche : image optionnelle + QR (conservée) */}
        <aside
          aria-label="Infos & QR"
          style={{
            position: "relative",
            width: 360,
            maxWidth: "clamp(280px, 30vw, 400px)",
            maxHeight: "calc(100vh - 24px)",
            background: "#081224",
            border: "1px solid #1f2a44",
            borderRadius: 12,
            padding: 12,
            margin: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignSelf: "flex-start",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {leftImageUrl && (
            <div
              style={{
                borderRadius: 10,
                overflow: "hidden",
                border: "1px solid #1f2a44",
                background: "#0b0f1a",
                flexShrink: 0,
              }}
            >
              <img
                src={leftImageUrl}
                alt=""
                style={{
                  display: "block",
                  width: "100%",
                  height: "clamp(200px, 25vh, 300px)",
                  objectFit: "cover",
                }}
                loading="lazy"
                decoding="async"
              />
            </div>
          )}
          <div style={{ marginTop: "auto", paddingBottom: 0, flexShrink: 0 }}>
            <JoinPanelInline size="lg" />
          </div>
        </aside>

        {/* Colonne principale : Podium Final */}
        <div
          style={{
            flex: 1,
            padding: "40px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "2.4rem", marginTop: 6, marginBottom: 8 }}>{finalPodiumTitle}</h1>

          {finalPodium.gold.length + finalPodium.silver.length + finalPodium.bronze.length === 0 ? (
            <div style={{ opacity: 0.85, fontSize: 18, marginTop: 6 }}>
              Aucun point n'a été marqué. Merci à tous pour votre participation !
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10, justifyContent: "center", marginTop: 10 }}>
              {/* 🥇 Or — 2× plus gros */}
              {finalPodium.gold.length > 0 && (
                <div style={{ background: "#0b1e3d", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 6 }}>🥇 Or</div>
                  {finalPodium.gold.map((p) => (
                    <div
                      key={p.id}
                      style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "baseline" }}
                    >
                      <span style={{ fontWeight: 900, fontSize: 42 }}>{p.name || "(sans nom)"}</span>
                      <span style={{ opacity: 0.85, fontSize: 26 }}>•</span>
                      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 900, fontSize: 42 }}>
                        {p.scoreFinal} pts
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* 🥈 Argent */}
              {finalPodium.silver.length > 0 && (
                <div style={{ background: "#0b0f1a", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🥈 Argent</div>
                  {finalPodium.silver.map((p) => (
                    <div key={p.id} style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                      <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name || "(sans nom)"}</span>
                      <span style={{ opacity: 0.85 }}>•</span>
                      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>
                        {p.scoreFinal} pts
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* 🥉 Bronze */}
              {finalPodium.bronze.length > 0 && (
                <div style={{ background: "#0b0f1a", border: "1px solid #1f2a44", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🥉 Bronze</div>
                  {finalPodium.bronze.map((p) => (
                    <div key={p.id} style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                      <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name || "(sans nom)"}</span>
                      <span style={{ opacity: 0.85 }}>•</span>
                      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>
                        {p.scoreFinal} pts
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ============================================================================
  // Écran d'attente (showPreStart) — affiché seulement si EleyBuzz n'est pas actif
  // ============================================================================
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

      {/* Colonne gauche : image optionnelle + QR */}
      <aside
        aria-label="Infos & QR"
        style={{
          position: "relative",
          width: 360,
          maxWidth: "clamp(280px, 30vw, 400px)",
          maxHeight: "calc(100vh - 24px)",
          background: "#081224",
          border: "1px solid #1f2a44",
          borderRadius: 12,
          padding: 12,
          margin: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignSelf: "flex-start",
          overflowY: "auto",
          overflowX: "hidden",
        }}

      >
        {/* Timecode overlay (haut-gauche) */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            background: "rgba(17,17,17,0.9)",
            padding: "6px 10px",
            borderRadius: 8,
            fontFamily: "monospace",
            letterSpacing: 1,
            border: "1px solid #2a2a2a",
            zIndex: 2,
          }}
        >
          ⏱ {formatHMS(elapsedSec)}
        </div>

        {leftImageUrl && (
          <div
            style={{
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid #1f2a44",
              background: "#0b0f1a",
              flexShrink: 0,
            }}
          >
            <img
              src={leftImageUrl}
              alt=""
              style={{
                display: "block",
                width: "100%",
                height: "clamp(200px, 25vh, 300px)",
                objectFit: "cover",
              }}
              loading="lazy"
              decoding="async"
            />

          </div>
        )}
        <div style={{ marginTop: "auto", paddingBottom: 0, flexShrink: 0 }}>
          <JoinPanelInline size="lg" />
        </div>
      </aside>

      <div
        style={{
          flex: 1,
          padding: "40px 24px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          textAlign: "center",
        }}
      >
        {isQuizEnded ? (
          <div style={{ marginTop: 8, marginBottom: 4, textAlign: "center" }}>
            <h1 style={{ fontSize: "2.4rem", marginTop: 6, marginBottom: 8 }}>{podiumTitle}</h1>

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
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 900, fontSize: 42 }}>
                          {p.score}
                        </span>
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
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>
                          {p.score}
                        </span>
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
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>
                          {p.score}
                        </span>
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
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>
                          {p.score}
                        </span>
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
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 14 }}>
                          {p.score}
                        </span>
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
              Fin de la manche {boundaryRoundIndex != null ? boundaryRoundIndex + 1 : ""}
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
              <h1 
                style={{ ...screenQuestionStyle, fontSize: "clamp(1.6rem, 3.8vw, 2.1rem)" }}
                dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
              />
            ) : isRevealAnswerPhase ? (
              <div style={{ marginTop: 8, marginBottom: 4 }}>
                <div style={{ 
                  opacity: 0.85, 
                  fontSize: 18, 
                  marginBottom: 8,
                  lineHeight: 1.4,
                  maxWidth: "min(800px, 95%)",
                  marginLeft: "auto",
                  marginRight: "auto",
                  textAlign: "center",
                  whiteSpace: "nowrap", // Force une seule ligne pour les phrases de révélation
                  overflowWrap: "normal", // Ne coupe jamais les mots
                  wordBreak: "normal", // Ne coupe pas les mots au milieu
                }}>
                  {revealPhrase}
                </div>
                <h1 
                  style={{ 
                    fontSize: "clamp(1.2rem, 5vw, 1.6rem)", // Même taille que Player
                    margin: 0,
                    lineHeight: 1.5,
                    whiteSpace: isShortAnswer ? "nowrap" : "normal", // Force une seule ligne pour les réponses courtes (sans ponctuation)
                    maxWidth: isShortAnswer ? "none" : "min(1600px, 95%)", // Pas de limite pour les réponses courtes
                    marginLeft: "auto",
                    marginRight: "auto",
                    overflowWrap: isShortAnswer ? "normal" : "break-word", // Ne coupe jamais pour les réponses courtes
                    wordBreak: "normal", // Ne coupe pas les mots au milieu
                    hyphens: "none", // Pas de césure automatique
                    textAlign: "center",
                    letterSpacing: "0.01em",
                  }}
                  dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(primaryAnswer) }}
                />
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
              <h1 
                style={{ ...screenQuestionStyle, fontSize: "clamp(1.6rem, 3.8vw, 2.1rem)" }}
                dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
              />
            )}

            {/* Image pendant la PHASE QUESTION (champs dédiés) */}
            {isQuestionPhase && questionImgUrl ? (
              <div
                style={{
                  width: SCREEN_IMG_MAX,
                  height: SCREEN_IMG_MAX,
                  maxWidth: "100%",
                  margin: "16px auto 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#111",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <img
                  src={questionImgUrl}
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

            {/* Podium live : s’affiche au fil de l’eau pendant la phase "question" */}
            {isQuestionPhase && liveFirsts.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ opacity: 0.85, fontSize: 14, marginBottom: 6 }}>
                  Bravo à :
                </div>
                <div style={{ display: "grid", gap: 6, justifyContent: "center" }}>
                  {liveFirsts.map((e, idx) => {
                    const rank = idx + 1;
                    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉";
                    const pts = scoringTable[idx] ?? 0;
                    const name = (playersById[e.playerId]?.name || "(…)");
                    const big = rank === 1;

                    return (
                      <div
                        key={e.playerId}
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "baseline",
                          justifyContent: "center",
                          background: "#0b0f1a",
                          border: "1px solid #1f2a44",
                          borderRadius: 10,
                          padding: "6px 10px",
                        }}
                      >
                        <span style={{ fontSize: big ? 22 : 18 }}>{medal}</span>
                        <b style={{ fontSize: big ? 20 : 16 }}>
                          {name}
                        </b>
                        <span style={{ opacity: 0.85 }}>•</span>
                        <span
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 800,
                          }}
                        >
                          +{pts} pts
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}



            {/* Image pendant la RÉVÉLATION (réponse) */}
            {isRevealAnswerPhase && answerImgUrl ? (
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
                  src={answerImgUrl}
                  alt="Révélation — œuvre"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    imageRendering: "auto",
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
      {/* Cachée quand showFinalScore est actif */}
      {!showFinalScore && (
      <aside
        aria-label="Classement"
        style={{
          width: 320,
          maxWidth: "clamp(280px, 30vw, 400px)",
          maxHeight: "calc(100vh - 24px)",
          background: "#0b0f1a",
          border: "1px solid #1f2a44",
          borderRadius: 12,
          padding: "12px 12px 8px 12px", // bas plus fin → QR visuellement plus bas
          margin: 12,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignSelf: "flex-start",
        }}
      >

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: 0.2 }}>
              Classement
            </h3>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              Top {Number.isFinite(leaderboardTopN) ? leaderboardTopN : DEFAULT_LEADERBOARD_TOP_N}
            </div>
          </div>

          {/* Petit bandeau bleu sous le titre "Classement / Top N" */}
          <div
            style={{
              marginTop: 6,
              height: 3,
              borderRadius: 9999,
              background: "#0f172a",       // bleu nuit un peu plus clair que #0b0f1a
              border: "1px solid #2a488fff", // même bleu que le cadre du QR
            }}
          />
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
      )}
    </div>
  );
}

export default function Screen() {
  const SCREEN_PASSWORD = "ChoupiEleyBoxScreen";

  const [screenUnlocked, setScreenUnlocked] = useState(false);
  const [screenPasswordInput, setScreenPasswordInput] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const ok = window.localStorage.getItem("eley_screen_unlocked") === "1";
      if (ok) {
        setScreenUnlocked(true);
      }
    } catch {
      // ignore
    }
  }, []);

  if (!screenUnlocked) {
    return (
      <div
        style={{
          minHeight: "calc(var(--vh, 1vh) * 100)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000814",
          color: "#e5e7eb",
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          padding: 16,
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (screenPasswordInput === SCREEN_PASSWORD) {
              setScreenUnlocked(true);
              try {
                if (typeof window !== "undefined") {
                  window.localStorage.setItem("eley_screen_unlocked", "1");
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
            background: "#020617",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 260,
            maxWidth: 360,
            boxShadow: "0 20px 40px rgba(0,0,0,0.45)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, textAlign: "center" }}>
            Accès écran scène
          </h1>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8, textAlign: "center" }}>
            Réservé à l&apos;écran de projection du quiz.
          </p>

          <label style={{ fontSize: 14, marginTop: 8 }}>
            Mot de passe :
            <input
              type="password"
              value={screenPasswordInput}
              onChange={(e) => setScreenPasswordInput(e.target.value)}
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
              background: "#3b82f6",
              color: "#0b1120",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Afficher l&apos;écran
          </button>
        </form>
      </div>
    );
  }

  // Une fois déverrouillé → on rend ton vrai écran public
  return <ScreenInner />;
}
