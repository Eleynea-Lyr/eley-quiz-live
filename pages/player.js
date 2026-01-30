// ============================================================================
// /pages/player.js — Refactoré avec imports depuis /lib
// Scope : Vue joueur avec inscription, réponses temps réel, scoring instantané
// ============================================================================

import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import { db } from "../lib/firebase";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  addDoc,
  updateDoc,
  where,
  serverTimestamp,
  deleteDoc,
} from "firebase/firestore";

// Imports depuis les fichiers utilitaires
import {
  REVEAL_DURATION_SEC,
  COUNTDOWN_START_SEC,
  ROUND_START_INTRO_SEC,
  UI_MASK_MS,
  RATE_LIMIT_ENABLED,
  MAX_WRONG_ATTEMPTS,
  RATE_LIMIT_WINDOW_MS,
  COOLDOWN_MS,
  LOCK_PHRASES,
  BAR_H,
  BAR_BLUE,
  BAR_RED,
  HANDLE_COLOR,
  PLAYER_IMG_MAX,
  SAFE_TOP,
  TOP_GUTTER_RUNNING,
  TOP_GUTTER_IDLE,
  BUZZER_COOLDOWN_MS,
  BUZZER_STATES,
  BUZZER_CORRECT_MESSAGE_DURATION_MS,
  BUZZER_WRONG_MESSAGE_DURATION_MS,
  DEFAULT_BUZZER_WRONG_PENALTY,
} from "../lib/constants";

import {
  getTimeSec,
  formatHMS,
  normalize,
  normalizeBasic,
  normalizeName,
  normalizeNameAlpha,
  pickRevealPhrase,
  roundIndexOfTime,
  nextRoundStartAfter,
  matchesWithMode,
  getAnswerMode,
  isAliasName,
  validateName,
  messageForRank,
  finalScoreMessageForRank,
  medalForRank,
  IS_IOS,
  addSmartLineBreaks,
} from "../lib/utils";

import {
  useMobileVH,
  recordFirstCorrectAndPredict,
  registerBuzzerPress,
} from "../lib/firebase-helpers";

import { ELEYBUZZ_PLAYER_MESSAGES, SCREEN_MESSAGES } from "../lib/messages";

// ---------------------------------------------------------------------------
// Constante locale spécifique au player
// ---------------------------------------------------------------------------
const BOUNDARY_HYST_MS = 120;   // marge autour des frontières de manche

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
    } catch { }
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
  const [countdownStartSec, setCountdownStartSec] = useState(COUNTDOWN_START_SEC);
  const [roundStartIntroSec, setRoundStartIntroSec] = useState(ROUND_START_INTRO_SEC);
  const [cooldownMs, setCooldownMs] = useState(COOLDOWN_MS);
  const [buzzerCooldownMs, setBuzzerCooldownMs] = useState(BUZZER_COOLDOWN_MS);
  const [buzzerCorrectMessageDurationMs, setBuzzerCorrectMessageDurationMs] = useState(BUZZER_CORRECT_MESSAGE_DURATION_MS);
  const [buzzerWrongMessageDurationMs, setBuzzerWrongMessageDurationMs] = useState(BUZZER_WRONG_MESSAGE_DURATION_MS);
  const [buzzerWrongPenalty, setBuzzerWrongPenalty] = useState(DEFAULT_BUZZER_WRONG_PENALTY);
  const [activeQuizKey, setActiveQuizKey] = useState(null);

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

  // Reset complet de la session locale (utilisé après un reset Admin + nouveau join)
  const resetLocalSessionState = () => {
    // Oublier toutes les questions pour lesquelles on avait déjà bien répondu
    answeredAtRef.current = {};

    // Oublier les infos de "Back" (question précédente, médaille, etc.)
    prevElapsedSecRef.current = null;
    prevQuestionIdRef.current = null;
    prevQidRef.current = null;
    backInfoRef.current = { lastBackQid: null, hadCorrectBeforeBack: false };

    // Forcer un petit "tick" pour invalider les dérivés éventuels du Back
    setBackTick((x) => x + 1);
  };

  // Anti-spam
  const [wrongTimes, setWrongTimes] = useState([]); // timestamps ms des erreurs
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [lockPhraseIndex, setLockPhraseIndex] = useState(null);

  // EleyBuzz state
  const [isBuzzerMode, setIsBuzzerMode] = useState(false);
  const [buzzerState, setBuzzerState] = useState("idle");
  const [firstPlayerId, setFirstPlayerId] = useState(null);
  const [canBuzz, setCanBuzz] = useState(true);
  const [buzzerCooldownUntilMs, setBuzzerCooldownUntilMs] = useState(null);
  const [buzzerCooldownTick, setBuzzerCooldownTick] = useState(0); // Force re-render chaque seconde pour décompte fluide
  const [buzzerMessage, setBuzzerMessage] = useState(null);
  const [buzzerMessageType, setBuzzerMessageType] = useState(null);
  // Ref pour mémoriser de manière persistante si le joueur est puni (évite les flashes)
  // Utiliser un ref au lieu d'un state pour éviter les re-renders inutiles
  const isPunishedRef = useRef(false);
  // State pour forcer le re-render quand nécessaire
  const [, setPunishedTick] = useState(0);
  // État optimiste pour le buzzer (affichage immédiat sans attendre Firestore)
  const [optimisticBuzzerState, setOptimisticBuzzerState] = useState(null);
  const [optimisticFirstPlayerId, setOptimisticFirstPlayerId] = useState(null);
  // État local pour empêcher les doubles buzz (désactive le bouton immédiatement)
  const [isBuzzing, setIsBuzzing] = useState(false);

  // Score Final state
  const [showFinalScore, setShowFinalScore] = useState(false);
  const [finalPodiumTitle, setFinalPodiumTitle] = useState(SCREEN_MESSAGES.finalPodiumTitle);


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
    } catch { }
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

      // Si le nom est refusé, réinitialiser complètement pour forcer une nouvelle inscription
      if (d.nameStatus === "rejected") {
        startTransition(() => {
          setIsKicked(false);
          setError("Nom refusé : trouve un autre nom plus adapté à la soirée :)");
          setInputName("");
          setPlayerName("");
          setPlayerId(null);
        });
        localStorage.removeItem("playerId");
        localStorage.removeItem("playerName");
        // Le useEffect se désabonnera automatiquement car playerId devient null
        return; // Sortir tôt pour éviter de mettre à jour playerName
      }

      startTransition(() => {
        setIsKicked(!!d.isKicked);
        if (d.isKicked) {
          setError("Vous avez été retiré de la partie.");
        } else {
          setError("");
        }
      });

      // Ne mettre à jour playerName que si le nom est accepté (pas refusé)
      if (typeof d.name === "string") {
        startTransition(() => {
          setPlayerName(d.name);
        });
        localStorage.setItem("playerName", d.name);
      }
      startTransition(() => setNameLocked(!!d.nameLocked));

      // EleyBuzz: canBuzz depuis le doc joueur
      // IMPORTANT: Si canBuzz est undefined/null, on considère qu'il est true (par défaut)
      // Cela permet aux nouveaux joueurs de buzzer immédiatement
      const canBuzzValue = d.canBuzz;
      startTransition(() => {
        // Si canBuzz est explicitement false, on le respecte
        // Sinon (undefined, null, true), on considère qu'il est true
        setCanBuzz(canBuzzValue !== false);
      });

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
        
        // EleyBuzz state
        const newIsBuzzerMode = !!d.isBuzzerMode;
        setIsBuzzerMode(newIsBuzzerMode);
        const newBuzzerState = typeof d.buzzerState === "string" ? d.buzzerState : "idle";
        const newFirstPlayerId = typeof d.firstPlayerId === "string" ? d.firstPlayerId : null;
        
        setBuzzerState(newBuzzerState);
        setFirstPlayerId(newFirstPlayerId);
        
        // Si EleyBuzz est désactivé, forcer canBuzz à true (débloquer tous les joueurs)
        if (!newIsBuzzerMode) {
          setCanBuzz(true);
        }
        
        // Réinitialiser l'état optimiste dans plusieurs cas :
        // 1. Si le buzzer revient à idle (nouvelle question) → réinitialiser
        // 2. Si firstPlayerId devient null (réinitialisation) → réinitialiser
        // 3. Si Firestore confirme l'état optimiste → réinitialiser (synchronisation)
        // 4. Si l'état Firestore change (par exemple, un autre joueur a buzzé) → réinitialiser
        if (newBuzzerState === BUZZER_STATES.IDLE || newFirstPlayerId === null) {
          // Nouvelle question ou réinitialisation : toujours réinitialiser l'optimiste
          setOptimisticBuzzerState(null);
          setOptimisticFirstPlayerId(null);
          setIsBuzzing(false); // Réactiver le bouton
        } else if (optimisticBuzzerState && optimisticBuzzerState === newBuzzerState && optimisticFirstPlayerId === newFirstPlayerId) {
          // Firestore confirme l'état optimiste : réinitialiser (synchronisation)
          setOptimisticBuzzerState(null);
          setOptimisticFirstPlayerId(null);
          // Si Firestore confirme que ce joueur est le premier, garder isBuzzing à true
          // Sinon, réactiver le bouton
          if (newFirstPlayerId !== playerId) {
            setIsBuzzing(false);
          }
        } else if (optimisticBuzzerState && (optimisticBuzzerState !== newBuzzerState || optimisticFirstPlayerId !== newFirstPlayerId)) {
          // L'état Firestore change : réinitialiser l'optimiste
          setOptimisticBuzzerState(null);
          setOptimisticFirstPlayerId(null);
          // Si un autre joueur a buzzé, réactiver le bouton
          if (newFirstPlayerId !== playerId) {
            setIsBuzzing(false);
          }
        } else if (newBuzzerState === BUZZER_STATES.LOCKED && newFirstPlayerId === playerId) {
          // Firestore confirme que ce joueur est le premier : garder isBuzzing à true
          // (le bouton reste désactivé car le joueur peut maintenant répondre)
        } else if (newBuzzerState === BUZZER_STATES.LOCKED && newFirstPlayerId !== playerId) {
          // Un autre joueur a buzzé : réactiver le bouton
          setIsBuzzing(false);
        }
        
        setBuzzerMessage(typeof d.buzzerMessage === "string" ? d.buzzerMessage : null);
        setBuzzerMessageType(typeof d.buzzerMessageType === "string" ? d.buzzerMessageType : null);
        setShowFinalScore(!!d.showFinalScore);
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

  // 6) Reset local (blocklist + runtime) à chaque reset global
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};
      const t = d.playersResetAt;
      if (t && typeof t.seconds === "number") {
        const ms = t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
        const prev = Number(localStorage.getItem("playersResetAt") || 0);

        // Nouveau reset détecté côté Admin → on resynchronise le joueur local
        if (!Number.isFinite(prev) || ms > prev) {
          localStorage.setItem("playersResetAt", String(ms));
          localStorage.removeItem("rejectedNamesCache");

          // 1) Purge de la blocklist locale
          startTransition(() => {
            setRejectedNames([]);
          });

          // 2) Reset complet du runtime de la session (comme après un F5)
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

          // 3) Reset des marqueurs de Back & dérivés locaux
          resetLocalSessionState();
          
          // 4) Réinitialiser les états EleyBuzz locaux (débloquer le joueur)
          startTransition(() => {
            setCanBuzz(true);
            setBuzzerCooldownUntilMs(null);
            setOptimisticBuzzerState(null);
            setOptimisticFirstPlayerId(null);
            setIsBuzzing(false);
          });
        }
      }
    });
    return () => unsub();
  }, []);


  // 7) Récupérer les questions du quiz ACTIF
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // Pas de quiz actif → pas de questions (évite le mélange)
        if (!activeQuizKey) {
          if (!cancelled) setQuestionsList([]);
          return;
        }

        const q = query(
          collection(db, "LesQuestions"),
          where("quizKey", "==", activeQuizKey)
        );
        const snapshot = await getDocs(q);
        if (!cancelled) {
          setQuestionsList(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        }
      } catch (e) {
        console.error("[Player] load questions failed:", e);
        if (!cancelled) setQuestionsList([]);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [activeQuizKey]);


  // 8) Config (manches + fin + durée de révélation + quiz actif)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data() || {};
      startTransition(() => {
        // Quiz actif
        const activeKey =
          typeof d?.activeQuizKey === "string" && d.activeQuizKey.trim()
            ? d.activeQuizKey.trim()
            : null;
        setActiveQuizKey(activeKey);

        // Fin de quiz & manches
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
        const cm = Number.isFinite(d?.cooldownMs) ? d.cooldownMs : COOLDOWN_MS;
        setCooldownMs(cm);
        const bcm = Number.isFinite(d?.buzzerCooldownMs) ? d.buzzerCooldownMs : BUZZER_COOLDOWN_MS;
        setBuzzerCooldownMs(bcm);
        const bcmd = Number.isFinite(d?.buzzerCorrectMessageDurationMs) ? d.buzzerCorrectMessageDurationMs : BUZZER_CORRECT_MESSAGE_DURATION_MS;
        setBuzzerCorrectMessageDurationMs(bcmd);
        const bwmd = Number.isFinite(d?.buzzerWrongMessageDurationMs) ? d.buzzerWrongMessageDurationMs : BUZZER_WRONG_MESSAGE_DURATION_MS;
        setBuzzerWrongMessageDurationMs(bwmd);
        const bwp = Number.isFinite(d?.buzzerWrongPenalty) ? d.buzzerWrongPenalty : DEFAULT_BUZZER_WRONG_PENALTY;
        setBuzzerWrongPenalty(bwp);

        // Messages personnalisables depuis Firestore
        const customFinalPodiumTitle = typeof d?.screenQuiz?.finalPodiumTitle === "string" && d.screenQuiz.finalPodiumTitle.trim() !== ""
          ? d.screenQuiz.finalPodiumTitle
          : SCREEN_MESSAGES.finalPodiumTitle;
        setFinalPodiumTitle(customFinalPodiumTitle);
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
          buzzScore: Number(v.buzzScore || 0),
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
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec, serverDeltaTick]);

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

  // Manche qui est en train de se terminer pendant la fenêtre morte
  const boundaryRoundIndex =
    Number.isFinite(nextRoundStart)
      ? roundIndexOfTime(Math.max(0, nextRoundStart - 0.001), roundOffsetsSec)
      : null;

  let effectiveNextTimeSec = null;

  // On re-considère la frontière de manche (nextRoundBoundary) comme un
  // "événement" à part entière pour retrouver le compte à rebours
  // "Fin de la manche X dans :".
  let nextKind = null; // "question" | "end" | "round"
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
    ? qStart + roundStartIntroSec
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

  // Le temps utile de réponse commence après l'intro
  const qStartEffective = isFirstQuestionOfRound && Number.isFinite(qStart)
    ? qStart + roundStartIntroSec
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

  // Fin de manche (pause posée par l’Admin)
  const endedRoundIndex = Number.isInteger(lastAutoPausedRoundIndex) ? lastAutoPausedRoundIndex : null;

  // On ne considère "Fin de manche" que si :
  //  - la pause vient bien d'une auto-pause (endedRoundIndex != null)
  //  - ET qu'on est encore dans la fenêtre de temps de cette manche
  let isRoundBreak = false;
  if (isPaused && endedRoundIndex != null) {
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



  // --- Phases
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
    ? Math.max(1, Math.min(countdownStartSec, Math.ceil(secondsToNext)))
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
  const currentImageUrl = currentQuestion
    ? (currentQuestion.imageReponseUrl || currentQuestion.imageUrl || null)
    : null;


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
      const u = sorted[k]?.imageReponseUrl || sorted[k]?.imageUrl;
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
          if (im.decode) im.decode().catch(() => { });
        } catch { }
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

    const tAnswer = answeredAtRef.current[qid];

    // -1 → F5 après bonne réponse dans le “run” actuel → on garde "Bonne réponse !"
    const isReloadedFreshCorrect = tAnswer === -1 && noBackSince;
    // -2 → F5 après Back (bonne réponse d'un “run” précédent)
    //      → on NE le compte PAS comme "Bonne réponse !" mais comme "déjà répondu".

    return (gotNow && noBackSince) || justAnsweredAfterBack || isReloadedFreshCorrect;
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

  // 🔁 Recharger l'état "bonne réponse" après un F5
  useEffect(() => {
    const qid = currentQuestionId;
    if (!qid || !playerId) return;

    // Si on connaît déjà localement le fait que la question est correcte, ne rien faire
    if (answeredAtRef.current[qid] != null) return;

    let cancelled = false;
    (async () => {
      try {
        // answers/{qid}/submissions/{playerId}
        const subRef = doc(db, "answers", qid, "submissions", playerId);
        const snap = await getDoc(subRef);
        if (cancelled || !snap.exists()) return;

        const data = snap.data() || {};
        if (!data.isCorrect) return;

        // Par défaut : F5 après bonne réponse dans le “run” actuel
        let sentinel = -1;

        // Si on a les timings, on essaie de savoir si la bonne réponse
        // appartenait à un “run” précédent (avant un Back).
        const first = data.firstCorrectAt;
        const qStart = getTimeSec(currentQuestion);
        if (
          first &&
          typeof first.seconds === "number" &&
          Number.isFinite(quizStartMs) &&
          Number.isFinite(qStart)
        ) {
          const firstMs =
            first.seconds * 1000 +
            Math.floor((first.nanoseconds || first.nanos || 0) / 1e6);
          const approxElapsedAtCorrect = (firstMs - quizStartMs) / 1000;

          // Si, dans la timeline actuelle, la bonne réponse semble dater
          // d'avant le début de la question, c'est qu'elle vient d'un “ancien run”.
          if (approxElapsedAtCorrect < qStart - 0.5) {
            sentinel = -2; // “déjà répondu” avant le Back
          }
        }

        // 1) On marque le fait qu'on a déjà bien répondu
        answeredAtRef.current[qid] = sentinel;

        // 2) On restaure les points/rang si disponibles (peu importe le type de sentinel)
        const predictedRank = Number.isFinite(data.predictedRank) ? data.predictedRank : null;
        const predictedPoints = Number.isFinite(data.predictedPoints) ? data.predictedPoints : null;

        if (Number.isFinite(predictedPoints) && predictedPoints > 0) {
          lastInstantWinQidRef.current = qid;
          setInstantWin({
            qid,
            rank: predictedRank,
            points: predictedPoints,
            at: Date.now(),
          });
        }

        // 3) Tick pour forcer la mise à jour des dérivés (showGoodNow, etc.)
        setBackTick((t) => t + 1);
      } catch (e) {
        console.error("[Player] reload previous correct state failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentQuestionId, playerId, currentQuestion, quizStartMs]);


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

  // GESTION DE LA PUNITION : Ref persistante pour éviter les flashes pendant la synchronisation
  // Le joueur est considéré comme puni si canBuzz est false (source de vérité Firestore)
  // Une fois puni, on reste puni jusqu'à ce que canBuzz soit true ET que le buzzer soit OPEN
  // Cela évite de voir le buzzer bleu brièvement avant qu'il ne devienne gris
  useEffect(() => {
    if (!isBuzzerMode || !playerId) return;
    
    const now = Date.now();
    
    // Si canBuzz est false, le joueur est puni (source de vérité Firestore)
    if (!canBuzz) {
      // Marquer comme puni dans le ref (persistant)
      if (!isPunishedRef.current) {
        isPunishedRef.current = true;
        setPunishedTick(t => t + 1); // Force re-render
      }
      
      // Si canBuzz est false, démarrer le cooldown local immédiatement
      // Le cooldown doit démarrer même si le buzzer est réouvert (cas de mauvaise réponse)
      if (!buzzerCooldownUntilMs) {
        const cooldownEndMs = now + buzzerCooldownMs;
        setBuzzerCooldownUntilMs(cooldownEndMs);
      }
    } else {
      // canBuzz est true : le joueur est libéré
      // Si le buzzer est LOCKED avec un autre joueur, on libère quand même (le buzzer sera gris, pas bleu)
      if (isPunishedRef.current) {
        // Le buzzer n'est pas verrouillé : on peut libérer
        // Si LOCKED avec un autre joueur, le buzzer sera gris (pas bleu), donc pas de flash
        // Si OPEN ou IDLE, le buzzer sera bleu, ce qui est normal
        isPunishedRef.current = false;
        setPunishedTick(t => t + 1); // Force re-render
        // Réinitialiser le cooldown car le joueur n'est plus puni
        if (buzzerCooldownUntilMs) {
          setBuzzerCooldownUntilMs(null);
        }
      }
    }
  }, [isBuzzerMode, playerId, canBuzz, buzzerState, buzzerCooldownUntilMs, buzzerMessageType, buzzerCooldownMs]);

  // Ticker cooldown EleyBuzz - mise à jour chaque 100ms pour décompte fluide et précis
  useEffect(() => {
    if (!buzzerCooldownUntilMs) {
      setBuzzerCooldownTick(0);
      return;
    }
    
    // Vérifier immédiatement
    const now = Date.now();
    if (now >= buzzerCooldownUntilMs) {
      setBuzzerCooldownUntilMs(null);
      setBuzzerCooldownTick(0);
      return;
    }
    
    // Mettre à jour plus fréquemment (toutes les 100ms) pour un décompte fluide
    // Cela garantit que le calcul du temps restant est toujours précis
    const id = setInterval(() => {
      const now = Date.now();
      if (now >= buzzerCooldownUntilMs) {
        setBuzzerCooldownUntilMs(null);
        setBuzzerCooldownTick(0);
      } else {
        // Force re-render toutes les 100ms pour afficher le décompte précis
        setBuzzerCooldownTick(t => t + 1);
      }
    }, 100); // Mise à jour toutes les 100ms pour plus de fluidité
    
    return () => clearInterval(id);
  }, [buzzerCooldownUntilMs]);

  // Réinitialiser tous les états EleyBuzz locaux quand le mode est désactivé
  useEffect(() => {
    if (!isBuzzerMode) {
      // Quand EleyBuzz est désactivé, réinitialiser tous les états locaux
      startTransition(() => {
        setBuzzerCooldownUntilMs(null);
        setOptimisticBuzzerState(null);
        setOptimisticFirstPlayerId(null);
        setIsBuzzing(false); // Réactiver le bouton
        // Forcer canBuzz à true localement (sera synchronisé depuis Firestore)
        setCanBuzz(true);
      });
    }
  }, [isBuzzerMode]);

  // Rafraîchissement automatique pendant les phases LOCKED et IDLE pour éviter les blocages
  // Nettoie les états optimistes et force un re-render périodique
  // - Pendant LOCKED : quand la personne répond
  // - Pendant IDLE : pendant l'attente ("écoute attentivement la question de Eley")
  useEffect(() => {
    if (!isBuzzerMode) return;
    
    // Activer le rafraîchissement pendant LOCKED (personne répond) ou IDLE (attente)
    const shouldRefresh = buzzerState === BUZZER_STATES.LOCKED || buzzerState === BUZZER_STATES.IDLE;
    if (!shouldRefresh) return;

    // Nettoyer immédiatement les états optimistes qui ne sont plus nécessaires
    // Une fois que Firestore confirme LOCKED, on n'a plus besoin de l'optimiste
    if (optimisticBuzzerState && firstPlayerId) {
      // Firestore a confirmé, on peut nettoyer l'optimiste
      setOptimisticBuzzerState(null);
      setOptimisticFirstPlayerId(null);
    }

    // Rafraîchissement périodique toutes les 500ms pendant LOCKED ou IDLE
    // Cela force un re-render et nettoie les états qui pourraient s'accumuler
    const refreshInterval = setInterval(() => {
      // Forcer un petit re-render pour nettoyer les états
      // Cela évite l'accumulation de mémoire et les blocages
      if (optimisticBuzzerState && firstPlayerId) {
        // Nettoyer l'optimiste si Firestore a confirmé
        setOptimisticBuzzerState(null);
        setOptimisticFirstPlayerId(null);
      }
    }, 500); // Rafraîchissement toutes les 500ms

    return () => clearInterval(refreshInterval);
  }, [isBuzzerMode, buzzerState, optimisticBuzzerState, firstPlayerId]);


  /* ============================ Vérification & Handlers ============================ */


  // Empêche le transfert de focus de l'input vers le bouton (iOS ferme le clavier sinon)
  const keepInputFocus = (e) => {
    // Empêche toute prise de focus par le bouton (sinon iOS range le clavier)
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();

    const el = answerInputRef?.current;
    if (el) {
      // 1) Focus immédiat (dans le même gesture)
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }

      // 2) Re-focus “double tick” pour WKWebView (certains iOS l’ignorent sinon)
      requestAnimationFrame(() => {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        const v = el.value || "";
        try { el.setSelectionRange(v.length, v.length); } catch { }
      });

      // 3) Fallback ultra-fiable (petit délai) pour Chrome iOS
      setTimeout(() => {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      }, 30);
    }
  };



  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;
    const mode = getAnswerMode(currentQuestion);
    const list = Array.isArray(currentQuestion.answers) ? currentQuestion.answers : [];
    const isCorrect = list.some((acc) => matchesWithMode(answer, acc, mode));


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
      // Ferme volontairement le clavier — c’est le SEUL cas où on le fait
      requestAnimationFrame(() => {
        const el = answerInputRef?.current;
        if (el) {
          try { el.blur(); } catch { }
        }
      });

      setResult("wrong");
      setAnswer("");

      setWrongTimes((prev) => {
        const now = Date.now();
        const pruned = prev.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        const nextArr = [...pruned, now];
        if (RATE_LIMIT_ENABLED && nextArr.length >= MAX_WRONG_ATTEMPTS && !isLocked) {
          setCooldownUntilMs(now + cooldownMs);
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

  // Handler EleyBuzz - premier qui buzz = gagnant
  const handleBuzzerPress = async () => {
    if (!playerId || !isBuzzerMode || buzzerState !== BUZZER_STATES.OPEN) return;
    if (buzzerCooldownUntilMs && Date.now() < buzzerCooldownUntilMs) return;
    
    // Vérifier canBuzz
    if (!canBuzz) return;

    // Mise à jour optimiste immédiate
    if (!isBuzzing) {
      setIsBuzzing(true);
      startTransition(() => {
        setOptimisticBuzzerState(BUZZER_STATES.LOCKED);
        setOptimisticFirstPlayerId(playerId);
      });
    }

    // Appel Firestore en arrière-plan (non-bloquant)
    try {
      const result = await registerBuzzerPress(db, playerId);
      // Si le buzz a échoué, réinitialiser l'état optimiste
      if (!result.ok && result.reason === "already-buzzed") {
        // Déjà buzzé, garder l'état optimiste pour l'animation visuelle
        // Ne pas réinitialiser isBuzzing pour permettre les clics suivants
        return;
      }
      // Si le buzz a échoué (déjà verrouillé par un autre joueur), réinitialiser l'état optimiste
      if (!result.ok && result.reason === "already-locked") {
        startTransition(() => {
          setOptimisticBuzzerState(null);
          setOptimisticFirstPlayerId(null);
        });
        // Réactiver le bouton si le buzz a échoué
        setIsBuzzing(false);
      } else if (result.ok) {
        // Le buzz a réussi, garder isBuzzing à true jusqu'à ce que Firestore confirme
        // (sera réinitialisé par le useEffect qui écoute firstPlayerId)
      } else {
        // Autre erreur (buzzer-not-open, player-not-found, player-cannot-buzz)
        startTransition(() => {
          setOptimisticBuzzerState(null);
          setOptimisticFirstPlayerId(null);
        });
        setIsBuzzing(false);
      }
    } catch (e) {
      console.error("[Player] handleBuzzerPress error:", e);
      // En cas d'erreur, réinitialiser l'état optimiste et réactiver le bouton
      startTransition(() => {
        setOptimisticBuzzerState(null);
        setOptimisticFirstPlayerId(null);
      });
      setIsBuzzing(false);
    }
  };

  const handleAnswerSubmit = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (isLocked) return;
    const trimmed = (answer ?? "").trim();
    if (!trimmed) return;

    checkAnswer();

    // iOS: garder le clavier ouvert & vider le champ de manière fiable
    requestAnimationFrame(() => {
      const el = answerInputRef.current;
      if (el) {
        try { el.value = ""; } catch { }
        // Ré-assigne le state si jamais un IME garde une valeur fantôme
        if (answer !== "") setAnswer("");
        el.focus();
        try { el.setSelectionRange(0, 0); } catch { }
      }
    });
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
  // Score depuis Firestore (mis à jour en temps réel par recordFirstCorrectAndPredict)
  const myScore = useMemo(() => (meRow ? meRow.score : 0), [meRow]);
  const myBuzzScore = useMemo(() => (meRow ? Number(meRow.buzzScore || 0) : 0), [meRow]);
  const myMedal = useMemo(
    () => (Number(myScore) > 0 ? medalForRank(myRank) : ""),
    [myRank, myScore]
  );
  const myEndMessage = useMemo(() => {
    return Number(myScore) > 0
      ? messageForRank(myRank)
      : "Merci pour ta participation !";
  }, [myRank, myScore]);

  // Classement final (Quiz + EleyBuzz) pour le Score Final
  const finalRanking = useMemo(() => {
    const rows = (playersLB || [])
      .filter((p) => !p.isKicked)
      .map((p) => {
        const scoreQuiz = Number(p.score || 0);
        const buzzScore = Number(p.buzzScore || 0);
        const scoreFinal = scoreQuiz + buzzScore;
        return {
          ...p,
          scoreQuiz,
          buzzScore,
          scoreFinal,
          _nameKey: normalizeNameAlpha(p.name || ""),
        };
      });
    rows.sort((a, b) => {
      if (a.scoreFinal !== b.scoreFinal) return b.scoreFinal - a.scoreFinal;
      return a._nameKey.localeCompare(b._nameKey);
    });
    // Rangs avec égalités
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
    return rows;
  }, [playersLB]);

  const myFinalRow = useMemo(() => {
    if (playerId) {
      const byId = finalRanking.find((p) => p.id === playerId);
      if (byId) return byId;
    }
    if (myIdRef.current) {
      const byRef = finalRanking.find((p) => p.id === myIdRef.current);
      if (byRef) return byRef;
    }
    if (playerName) {
      const key = normalizeNameAlpha(playerName);
      const byName = finalRanking.find((p) => normalizeNameAlpha(p.name || "") === key);
      if (byName) return byName;
    }
    return null;
  }, [finalRanking, playerId, playerName]);

  const myFinalScore = useMemo(() => (myFinalRow ? myFinalRow.scoreFinal : 0), [myFinalRow]);
  const myFinalRank = useMemo(() => (myFinalRow ? myFinalRow._rank : null), [myFinalRow]);
  const myFinalMedal = useMemo(
    () => (Number(myFinalScore) > 0 ? medalForRank(myFinalRank) : ""),
    [myFinalRank, myFinalScore]
  );

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
      else if (v.reason === "charset") setError("Utilise uniquement lettres FR, chiffres, espaces, apostrophes (' ') et tirets.");
      else if (v.reason === "politics") setError("Évite les noms à caractère politique. Merci !");
      else if (v.reason === "moderation") setError("Nom inadapté au tout public.");
      else setError("Nom invalide.");
      setInputName(""); // Vider le champ pour permettre une nouvelle saisie
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
          buzzScore: 0,
          isKicked: false,
          nameStatus: "ok",
          rejectedNames: Array.isArray(rejectedNames) ? rejectedNames : [],
          canBuzz: true, // Initialiser canBuzz à true pour permettre le buzzer
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

  // Style compact pour la question (évite le chevauchement en haut)
  const questionH2Style = {
    fontSize: "clamp(1.1rem, 4.2vw, 1.45rem)",
    lineHeight: 1.5, // Augmenté pour plus d'espacement entre les lignes
    margin: 0,
    marginTop: 6,
    maxWidth: "min(600px, 95%)", // Limite la largeur pour forcer des retours naturels
    marginLeft: "auto",
    marginRight: "auto",
    overflowWrap: "break-word", // Moins agressif que "anywhere"
    wordBreak: "normal", // Évite de couper les mots au milieu
    hyphens: "auto",
    lineBreak: "loose", // Permet des retours à la ligne plus souples
    textAlign: "center", // Centré comme demandé
    letterSpacing: "0.01em", // Légère augmentation pour meilleure lisibilité
  };

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
            Vous avez été retiré de la partie par l'animateur.
          </p>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            (Si c'est une erreur, rapprochez-vous de l'animateur.)
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // EleyBuzz Mode — Early return si mode buzzer actif (priorité sur showPreStart)
  // Permet d'accéder à EleyBuzz même si le quiz n'a pas encore démarré
  // ============================================================================
  if (isBuzzerMode && playerId) {
    // VÉRIFICATION DE PUNITION EN PREMIER (avant même de calculer effectiveBuzzerState)
    // Utiliser le ref isPunishedRef qui est géré par le useEffect ci-dessus
    // Cela garantit qu'un joueur puni ne verra JAMAIS le buzzer, même pendant les transitions d'état
    const now = Date.now();
    // Utiliser isPunishedRef.current comme source de vérité principale (évite les flashes)
    // Vérifier aussi !canBuzz comme fallback (sécurité supplémentaire en cas de latence)
    // Si canBuzz est false, le joueur est puni, point final
    // IMPORTANT : Ne pas utiliser effectiveBuzzerState ici car il dépend de optimisticBuzzerState
    // qui peut changer avant que canBuzz ne soit synchronisé
    const isPunished = isPunishedRef.current || !canBuzz;
    
    // Utiliser l'état optimiste pour le buzzerState ET firstPlayerId (affichage immédiat)
    // Cela permet d'afficher immédiatement "À toi de répondre !" pour le joueur qui buzz
    // et "Le buzzer est verrouillé..." pour les autres, sans attendre Firestore
    // Garde-fou pour la production : s'assurer que buzzerState a toujours une valeur valide
    const effectiveBuzzerState = optimisticBuzzerState || buzzerState || BUZZER_STATES.IDLE;
    // Utiliser optimisticFirstPlayerId pour l'affichage immédiat (UX améliorée)
    // Firestore confirmera ensuite qui peut vraiment répondre (sécurité)
    const effectiveFirstPlayerId = optimisticFirstPlayerId || firstPlayerId || null;
    
    // Permettre les clics si le buzzer est ouvert
    const canPressBuzzer = effectiveBuzzerState === BUZZER_STATES.OPEN && canBuzz && (!buzzerCooldownUntilMs || now >= buzzerCooldownUntilMs);
    // Calculer le temps restant pour le timer de punition
    // Utiliser Date.now() directement pour avoir le temps réel à chaque render (forcé par buzzerCooldownTick)
    const currentTime = Date.now();
    let buzzerCooldownRemainingSec = 0;
    if (buzzerCooldownUntilMs && currentTime < buzzerCooldownUntilMs) {
      // Calculer simplement le temps restant en secondes (20, 19, 18... jusqu'à 1)
      buzzerCooldownRemainingSec = Math.ceil((buzzerCooldownUntilMs - currentTime) / 1000);
      if (buzzerCooldownRemainingSec < 0) buzzerCooldownRemainingSec = 0;
    }

    return (
      <div
          style={{
            background: "#0a0a1a",
            color: "#fff",
            minHeight: "calc(var(--vh, 1vh) * 100)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            textAlign: "center",
            position: "relative",
          }}
        >
        {/* Badge nom joueur en haut-gauche (même ligne que le timer) */}
        {playerName && (
          <div
            style={{
              position: "absolute",
              top: `calc(12px + ${SAFE_TOP})`,
              left: 12,
              zIndex: 20,
              background: "#0b1e3d",
              border: "1px solid #1f2a44",
              borderRadius: 9999,
              padding: "6px 10px",
              fontSize: 14,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "#fff",
            }}
            aria-label="Nom du joueur"
            title={nameLocked ? "Nom verrouillé" : "Nom du joueur"}
          >
            <span>👤</span>
            <b style={{ letterSpacing: 0.2 }}>{playerName}</b>
            {(isRunning || isBuzzerMode) && myScore != null && (
              <span style={{ marginLeft: 4, opacity: 0.9, fontVariantNumeric: "tabular-nums" }}>
                • {myScore}
              </span>
            )}
            {isBuzzerMode && (
              <span style={{ marginLeft: 4, opacity: 0.9, fontVariantNumeric: "tabular-nums", color: "#facc15" }}>
                • ⚡ {myBuzzScore}
              </span>
            )}
            {nameLocked && <span style={{ opacity: 0.7, marginLeft: 6 }}>🔒</span>}
          </div>
        )}

        <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0, marginBottom: 24 }}>
          ⚡ EleyBuzz ⚡
        </h1>

        {/* BLOC PRINCIPAL ELEYBUZZ : Gère Punition OU Buzzer de manière exclusive */}
        {(() => {
          // 1. DÉTECTION STRICTE DE LA PUNITION - PRIORITÉ ABSOLUE
          // isPunished est déjà calculé AVANT ce bloc (ligne ~2041)
          // Cela garantit qu'on ne regarde même pas l'état du buzzer si le joueur est puni
          
          if (isPunished) {
            // Calculer hasActiveCooldown dans le scope du bloc
            // Utiliser Date.now() directement pour avoir le temps réel à chaque render (forcé par buzzerCooldownTick)
            const currentTimeForCooldown = Date.now();
            const hasActiveCooldown = buzzerCooldownUntilMs && buzzerCooldownUntilMs > currentTimeForCooldown;
            const remainingSec = hasActiveCooldown ? Math.max(0, Math.ceil((buzzerCooldownUntilMs - currentTimeForCooldown) / 1000)) : 0;

            return (
              <div style={{ marginBottom: 24, textAlign: "center" }}>
                <div 
                  style={{ 
                    opacity: 0.9, 
                    fontSize: 18, 
                    color: "#f59e0b",
                    fontWeight: 700,
                    lineHeight: 1.6,
                    marginBottom: 16
                  }}
                  dangerouslySetInnerHTML={{ 
                    __html: addSmartLineBreaks(ELEYBUZZ_PLAYER_MESSAGES.punishment.replace("{penalty}", String(buzzerWrongPenalty))).replace(/\.\s+/g, ".<br>")
                  }}
                />
                {/* Afficher le timer si cooldown actif, sinon juste le message */}
                {hasActiveCooldown && (
                  <div 
                    style={{ 
                      fontSize: "2.5rem", 
                      fontWeight: 800, 
                      color: "#f59e0b",
                      fontFamily: "monospace",
                      letterSpacing: 2
                    }}
                  >
                    {remainingSec}
                  </div>
                )}
              </div>
            );
          }

          // 2. SI PAS PUNI (canBuzz = true) : GESTION DU BUZZER
          
          // État IDLE : message d'attente
          if (effectiveBuzzerState === BUZZER_STATES.IDLE) {
            return (
              <div 
                style={{ opacity: 0.85, fontSize: 16, lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ 
                  __html: "Écoute attentivement la question de Eley.<br><br>Puis, dès que le Buzzer apparaît, appuie vite dessus si tu connais la réponse !<br><br>Attention, tu auras une pénalité si tu réponds faux !"
                }}
              />
            );
          }

          // États OPEN, LOCKED : Affichage du buzzer
          // Déterminer la couleur et l'état du buzzer
          const getBuzzerStyle = () => {
            // Garde-fou pour la production : s'assurer que effectiveBuzzerState est valide
            if (!effectiveBuzzerState || typeof effectiveBuzzerState !== 'string') {
              // Fallback si l'état n'est pas valide (peut arriver en production)
              return {
                background: "#6b7280",
                border: "#fff",
                shadow: "0 8px 24px rgba(107, 114, 128, 0.3)",
                isClickable: false,
                isAnimating: false,
              };
            }

            // Si OPEN : bleu (actif)
            if (effectiveBuzzerState === BUZZER_STATES.OPEN) {
              return {
                background: "#3b82f6",
                border: "#fff",
                shadow: "0 8px 24px rgba(59, 130, 246, 0.4)",
                isClickable: canPressBuzzer,
                isAnimating: false,
              };
            }
            
            // Si LOCKED : déterminer selon qui a buzzé
            if (effectiveBuzzerState === BUZZER_STATES.LOCKED) {
              // Pendant la vérification : bleu pour TOUS ceux qui ont buzzé
              // On reste en bleu tant que le serveur n'a pas confirmé (firstPlayerId === null)
              // Pas d'animation automatique, seulement au clic/touch
              // Garde-fou pour la production : vérifier que les valeurs sont valides
              const isWaitingVerification = (!firstPlayerId || firstPlayerId === null) && (isBuzzing || optimisticFirstPlayerId === playerId);
              
              if (isWaitingVerification) {
                return {
                  background: "#3b82f6",
                  border: "#fff",
                  shadow: "0 8px 24px rgba(59, 130, 246, 0.4)",
                  isClickable: false, // Désactivé pendant vérification
                  isAnimating: false, // Pas d'animation automatique
                };
              }
              
              // Une fois le serveur a confirmé (firstPlayerId !== null) :
              // Premier joueur confirmé par le serveur : jaune (utiliser firstPlayerId, pas effectiveFirstPlayerId)
              // Garde-fou pour la production : vérifier que les valeurs sont valides
              if (firstPlayerId && playerId && firstPlayerId === playerId) {
                return {
                  background: "#facc15",
                  border: "#fff",
                  shadow: "0 8px 24px rgba(250, 204, 21, 0.4)",
                  isClickable: false,
                  isAnimating: false,
                };
              }
              
              // Autres joueurs : gris (même ceux qui avaient buzzé mais ne sont pas premiers)
              return {
                background: "#6b7280",
                border: "#fff",
                shadow: "0 8px 24px rgba(107, 114, 128, 0.3)",
                isClickable: false,
                isAnimating: false,
              };
            }
            
            // Fallback : bleu
            return {
              background: "#3b82f6",
              border: "#fff",
              shadow: "0 8px 24px rgba(59, 130, 246, 0.4)",
              isClickable: false,
              isAnimating: false,
            };
          };
          
          const buzzerStyle = getBuzzerStyle();
          // isWaitingVerification : le serveur n'a pas encore confirmé qui est le premier
          // Garde-fou pour la production : vérifier que les valeurs sont valides
          const isWaitingVerification = (!firstPlayerId || firstPlayerId === null) && (isBuzzing || optimisticFirstPlayerId === playerId);
          
          return (
            <>
              {/* Buzzer toujours visible (sauf IDLE) */}
              <button
                onTouchStart={(e) => {
                  // Animation visuelle seulement pour les buzzers bleus (OPEN)
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  
                  if (canAnimate) {
                    e.preventDefault();
                    // Animation immédiate
                    e.currentTarget.style.transform = "scale(0.95)";
                    e.currentTarget.style.background = "#2563eb";
                    
                    // Appeler handleBuzzerPress seulement si cliquable
                    if (buzzerStyle.isClickable) {
                      handleBuzzerPress();
                    }
                  }
                }}
                onClick={(e) => {
                  // Animation visuelle seulement pour les buzzers bleus (OPEN)
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  
                  if (canAnimate) {
                    e.preventDefault();
                    
                    // Appeler handleBuzzerPress seulement si cliquable
                    if (buzzerStyle.isClickable) {
                      handleBuzzerPress();
                    }
                  }
                }}
                disabled={effectiveBuzzerState === BUZZER_STATES.LOCKED} // Désactivé seulement en LOCKED
                style={{
                  width: "min(280px, 80vw)",
                  height: "min(280px, 80vw)",
                  maxWidth: 300,
                  maxHeight: 300,
                  borderRadius: "50%",
                  border: `4px solid ${buzzerStyle.border}`,
                  background: buzzerStyle.background,
                  color: "#fff",
                  fontSize: "clamp(1.5rem, 6vw, 2.5rem)",
                  fontWeight: 800,
                  cursor: effectiveBuzzerState === BUZZER_STATES.OPEN ? "pointer" : "default",
                  touchAction: "manipulation",
                  WebkitTapHighlightColor: "transparent",
                  userSelect: "none",
                  transition: "transform 100ms ease, background 100ms ease",
                  boxShadow: buzzerStyle.shadow,
                  // Pas d'animation automatique, seulement au clic/touch
                }}
                onMouseDown={(e) => {
                  // Animation visuelle seulement pour les buzzers bleus (OPEN)
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(0.95)";
                    e.currentTarget.style.background = "#2563eb";
                  }
                }}
                onMouseUp={(e) => {
                  // Réinitialiser seulement si on était en OPEN
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.background = buzzerStyle.background;
                  }
                }}
                onMouseLeave={(e) => {
                  // Réinitialiser seulement si on était en OPEN
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.background = buzzerStyle.background;
                  }
                }}
                onTouchEnd={(e) => {
                  // Réinitialiser seulement si on était en OPEN
                  const canAnimate = effectiveBuzzerState === BUZZER_STATES.OPEN;
                  if (canAnimate) {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.background = buzzerStyle.background;
                  }
                }}
                title={
                  buzzerStyle.isClickable 
                    ? "Appuie pour buzzer !" 
                    : (firstPlayerId && playerId && firstPlayerId === playerId)
                      ? "À toi de répondre !" 
                      : "Le buzzer est verrouillé"
                }
              >
                BUZZER
              </button>
              
              {/* Messages de bonne/mauvaise réponse (affichés en dessous) - seulement en LOCKED */}
              {effectiveBuzzerState === BUZZER_STATES.LOCKED && !isWaitingVerification && (
                <div 
                  style={{ 
                    marginTop: 24,
                    opacity: 0.9, 
                    fontSize: 18,
                    color: (() => {
                      // Garde-fou pour la production : vérifier que les valeurs sont valides
                      if (playerId && firstPlayerId && playerId === firstPlayerId && buzzerMessageType === "correct") return "#10b981";
                      if (playerId && firstPlayerId && playerId === firstPlayerId && buzzerMessageType === "wrong") return "#ef4444";
                      return undefined;
                    })(),
                    fontWeight: (playerId && firstPlayerId && playerId === firstPlayerId) ? 700 : 400,
                    lineHeight: 1.6,
                  }}
                  dangerouslySetInnerHTML={{ 
                    __html: (() => {
                      // Garde-fou pour la production : vérifier que les valeurs sont valides
                      const isFirstPlayer = playerId && firstPlayerId && playerId === firstPlayerId;
                      if (isFirstPlayer && buzzerMessageType === "correct") {
                        return ELEYBUZZ_PLAYER_MESSAGES.correctAnswer;
                      }
                      if (isFirstPlayer && buzzerMessageType === "wrong") {
                        return ELEYBUZZ_PLAYER_MESSAGES.wrongAnswer;
                      }
                      if (isFirstPlayer) {
                        return ELEYBUZZ_PLAYER_MESSAGES.yourTurn;
                      }
                      if (buzzerMessageType === "correct") {
                        return ELEYBUZZ_PLAYER_MESSAGES.waitNextQuestion;
                      }
                      if (buzzerMessageType === "wrong") {
                        return ELEYBUZZ_PLAYER_MESSAGES.tryYourChance;
                      }
                      // Si le buzzer est gris (pas le premier joueur), afficher le message "trop lent"
                      // Garde-fou pour la production : vérifier que les valeurs sont valides
                      if (firstPlayerId && firstPlayerId !== null && playerId && firstPlayerId !== playerId) {
                        return ELEYBUZZ_PLAYER_MESSAGES.tooSlow;
                      }
                      return null; // Pas de message si rien de spécial
                    })()
                  }}
                />
              )}
            </>
          );
        })()}

      </div>
    );
  }

  // ============================================================================
  // Score Final Mode — Early return si mode score final actif (priorité sur tout)
  // ============================================================================
  if (showFinalScore && playerId) {
    return (
      <div
        style={{
          background: "#0a0a1a",
          color: "#fff",
          minHeight: "calc(var(--vh, 1vh) * 100)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: 0, marginBottom: 24 }}>
          {finalPodiumTitle}
        </h1>
        <div
          style={{
            marginTop: 8,
            padding: 20,
            borderRadius: 12,
            background: "#0b0f1a",
            border: "1px solid #1f2a44",
            textAlign: "center",
            maxWidth: "min(500px, 95%)",
          }}
        >
          <div style={{ fontSize: "clamp(1.5rem, 5vw, 2rem)", fontWeight: 800, marginBottom: 12 }}>
            Fin de la soirée, ton score est de :
          </div>
          <div style={{ fontSize: "clamp(2rem, 8vw, 3rem)", fontWeight: 900, color: "#facc15", marginBottom: 16 }}>
            {myFinalScore} pts
          </div>
          {myFinalRank != null && (
            <div style={{ fontSize: "clamp(1.1rem, 4vw, 1.3rem)", opacity: 0.9 }}>
              {myFinalMedal && <span style={{ fontSize: "1.5rem", marginRight: 8 }}>{myFinalMedal}</span>}
              {messageForRank(myFinalRank)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 3) Écran d'attente une fois inscrit (avant lancement par l'Admin)
  // (Affiché seulement si EleyBuzz n'est pas actif)
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
            L'Admin n'a pas encore lancé le quiz.
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
                Ton nom a été fixé par l'animateur.
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
  //         bannière de bonne réponse, styles d'animations.
  // ============================================================================

  // 4) Écran principal pendant le quiz
  return (
    <div
      style={{
        background: "#0a0a1a",
        color: "white",
        padding: "20px",
        paddingTop: isRunning
          ? `calc(${TOP_GUTTER_RUNNING} + ${SAFE_TOP})`
          : `calc(${TOP_GUTTER_IDLE} + ${SAFE_TOP})`,
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
          top: `calc(12px + ${SAFE_TOP})`,
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

      {/* Badge nom joueur en haut-gauche (même ligne que le timer) */}
      {(isRunning || isBuzzerMode) && playerName && (
        <div
          style={{
            position: "absolute",
            top: `calc(12px + ${SAFE_TOP})`,
            left: 12,
            zIndex: 20,
            background: "#0b1e3d",
            border: "1px solid #1f2a44",
            borderRadius: 9999,
            padding: "6px 10px",
            fontSize: 14,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "#fff",
          }}
          aria-label="Nom du joueur"
          title={nameLocked ? "Nom verrouillé" : "Nom du joueur"}
        >
          <span>👤</span>
          <b style={{ letterSpacing: 0.2 }}>{playerName}</b>
          {(isRunning || isBuzzerMode) && myScore != null && (
            <span style={{ marginLeft: 4, opacity: 0.9, fontVariantNumeric: "tabular-nums" }}>
              • {myScore}
            </span>
          )}
          {(isRunning || isBuzzerMode) && (
            <span style={{ marginLeft: 4, opacity: 0.9, fontVariantNumeric: "tabular-nums", color: "#facc15" }}>
              • ⚡ {myBuzzScore}
            </span>
          )}
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
              {myMedal ? `${myMedal} ` : ""}{myRank != null ? finalScoreMessageForRank(myRank, myScore) : "Merci pour ta participation !"}
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
            Fin de la manche {boundaryRoundIndex != null ? boundaryRoundIndex + 1 : ""}
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
            <>
              {/* Phase question */}
              <h2 
                style={questionH2Style}
                dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
              />

              {/* Image question (optionnelle) - Taille réduite de moitié pour éviter que le clavier cache le champ input, ou +200px si imageQuestionLarge */}
              {currentQuestion?.imageQuestionUrl ? (
                <div
                  style={{
                    width: currentQuestion.imageQuestionLarge ? (PLAYER_IMG_MAX / 2 + 200) : (PLAYER_IMG_MAX / 2),
                    height: currentQuestion.imageQuestionLarge ? (PLAYER_IMG_MAX / 2 + 200) : (PLAYER_IMG_MAX / 2),
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
                    src={currentQuestion.imageQuestionUrl}
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
            </>
          ) : isRevealAnswerPhase ? (

            // Révélation de la réponse
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div style={{ 
                opacity: 0.85, 
                fontSize: 16, 
                marginBottom: 6,
                lineHeight: 1.4,
                maxWidth: "min(600px, 95%)",
                marginLeft: "auto",
                marginRight: "auto",
                textAlign: "center",
              }}>
                {revealPhrase}
              </div>
              <h2
                style={{
                  fontSize: "clamp(1.2rem, 5vw, 1.6rem)",
                  margin: 0,
                  lineHeight: 1.5,
                  maxWidth: "min(600px, 95%)",
                  marginLeft: "auto",
                  marginRight: "auto",
                  overflowWrap: "break-word", // Ne coupe que si nécessaire, préfère couper entre les mots
                  wordBreak: "normal", // Ne coupe pas les mots au milieu
                  hyphens: "auto",
                  textAlign: "center",
                  letterSpacing: "0.01em",
                }}
                dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(primaryAnswer) }}
              />
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
              style={questionH2Style}
              dangerouslySetInnerHTML={{ __html: addSmartLineBreaks(currentQuestion.text) }}
            />
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
                onKeyDown={(e) => {
                  // Capte Enter pour éviter un submit natif qui fermerait le clavier
                  if (e.key === "Enter" && !isLocked) {
                    e.preventDefault();
                    const trimmed = (answer ?? "").trim();
                    if (trimmed.length > 0) {
                      handleAnswerSubmit();
                      // Re-focus immédiat pour conserver le clavier ouvert
                      const el = answerInputRef?.current;
                      if (el) {
                        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
                        try { el.setSelectionRange(0, 0); } catch { }
                      }
                    }
                  }
                }}

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
                enterKeyHint="send"
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

          {/* Bouton "Valider" — visible sur toutes plateformes quand l'input est visible */}
          {showInput && (
            <div style={{ marginTop: 10, textAlign: "center" }}>
              <button
                type="button"
                onMouseDown={keepInputFocus}
                onTouchStart={keepInputFocus}
                onClick={handleAnswerSubmit}
                disabled={isLocked || !((answer ?? "").trim().length > 0)}
                style={{
                  width: "auto",
                  minWidth: "120px",
                  padding: "clamp(10px, 2.8vw, 12px) 24px",
                  boxSizing: "border-box",
                  display: "inline-block",
                  borderRadius: 10,
                  border: "1px solid #2a2a2a",
                  background: isLocked ? "#64748b" : "#3b82f6",
                  color: "white",
                  fontWeight: 700,
                  cursor: isLocked ? "not-allowed" : "pointer",
                  touchAction: "manipulation",
                  WebkitTapHighlightColor: "transparent",
                  userSelect: "none",
                }}
                aria-disabled={isLocked ? "true" : "false"}
                title={isLocked ? "En cooldown anti-spam" : "Valider la réponse"}
              >
                Valider
              </button>
            </div>
          )}





          {/* Bannière "bonne réponse" persistante pendant la phase question */}
          {isQuestionPhase && (hadCorrectEver || showGoodNow) && (
            <div style={{ marginTop: 8, textAlign: "center" }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  borderRadius: 10,
                  border: "1px solid #2a2a2a",
                  background: "#0b3a1e",
                  fontWeight: 700,
                }}
              >
                {showGoodNow ? "Bonne réponse !" : "Tu as déjà bien répondu à cette question"}
              </div>
              {Number.isFinite(gainedPoints) && (
                <div style={{ marginTop: 6, fontSize: "0.95rem", opacity: 0.9 }}>
                  Tu as marqué {gainedPoints} point{gainedPoints > 1 ? "s" : ""}
                  {instantWin?.rank ? ` ${medalForRank(instantWin.rank)}` : ""}
                </div>
              )}
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
        /* Lisibilité input : texte & caret blancs, fond sombre, même après animations */
.answerInput {
  color: #fff !important;
  caret-color: #fff !important;
  -webkit-text-fill-color: #fff !important; /* WKWebView/iOS */

  /* Contraste garanti (sinon blanc sur blanc) */
  background: #0b1220 !important;
  border: 1px solid #334155 !important;
  border-radius: 10px;
}

/* Placeholder plus lisible sur fond sombre */
.answerInput::placeholder {
  color: rgba(255, 255, 255, 0.7);
}

/* Sécurité : ne jamais altérer la couleur du texte pendant l’animation d’erreur */
.answerInput.flashWrong {
  color: #fff !important;
  -webkit-text-fill-color: #fff !important;
}

/* (Android/iOS) Cas auto-fill : évite un fond blanc injecté par le navigateur */
.answerInput:-webkit-autofill {
  -webkit-text-fill-color: #fff !important;
  caret-color: #fff !important;
  background: #0b1220 !important;
  /* évite l’override visuel temporaire de Chrome */
  transition: background-color 99999s ease-out 0s;
}


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
