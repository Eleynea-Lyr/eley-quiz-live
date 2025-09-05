// /pages/player.js
import { useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, orderBy, query, doc, onSnapshot } from 'firebase/firestore';

// --- Anti-spam mauvaises réponses ---
const RATE_LIMIT_ENABLED = true;     // ← passe à false pour désactiver facilement
const MAX_WRONG_ATTEMPTS = 5;        // nb de tentatives avant blocage
const RATE_LIMIT_WINDOW_MS = 15_000; // fenêtre glissante: 15 s (mets 30_000 pour 30 s)
const COOLDOWN_MS = 10_000;          // durée du blocage en ms (10 s)


// Phrases affichées pendant le blocage (anti-spam)
const LOCK_PHRASES = [
  "Eh, arrête de spammer ! Ecoute et réfléchis plutôt !",
  "Le spam c'est mal, m'voyez !",
  "Tu penses vraiment y arriver de cette façon ?",
  "Tu veux faire exploser l'appli ou quoi ?",
  "Calme toi, tout doux..."
];

function normalize(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[a.length][b.length];
}

function isCloseEnough(input, expected, tolerance = 2) {
  return levenshteinDistance(input, expected) <= tolerance;
}

function getTimeSec(q) {
  if (!q || typeof q !== 'object') return Infinity;
  if (typeof q.timecodeSec === 'number') return q.timecodeSec;        // nouveau format (secondes)
  if (typeof q.timecode === 'number') return Math.round(q.timecode * 60); // rétro-compat (minutes)
  return Infinity; // pas de timecode -> tout à la fin
}

// --- Phrases de révélation (fallback) ---
const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :"
];

// Sélection déterministe (même phrase sur Player & Screen pour une question donnée)
function pickRevealPhrase(q) {
  const custom = Array.isArray(q?.revealPhrases)
    ? q.revealPhrases.filter(p => typeof p === 'string' && p.trim() !== '')
    : [];
  const pool = custom.length ? custom : DEFAULT_REVEAL_PHRASES;
  if (!pool.length) return "Réponse :";

  const seedStr = String(q?.id || '');
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  const idx = hash % pool.length;
  return pool[idx];
}


function formatHMS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}


export default function Player() {
  const [questionsList, setQuestionsList] = useState([]);
  const [answer, setAnswer] = useState('');
  const answerInputRef = useRef(null);
  const [wrongTimes, setWrongTimes] = useState([]); // array de timestamps (ms)
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null);
  // petit tick pour rafraîchir l'affichage du compte à rebours
  const [cooldownTick, setCooldownTick] = useState(0);
  const [lockPhraseIndex, setLockPhraseIndex] = useState(null);
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);



  useEffect(() => {
    const fetchQuestions = async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setQuestionsList(list);
    };
    fetchQuestions();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data();
      if (!d || !d.startAt) {
        setIsRunning(false);
        setIsPaused(false);
        setQuizStartMs(null);
        setPauseAtMs(null);
        setElapsedSec(0);
        setAnswer('');
        setResult(null);
        return;
      }
      setIsRunning(!!d.isRunning);
      setIsPaused(!!d.isPaused);
      const startMs = d.startAt.seconds * 1000 + Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      setQuizStartMs(startMs);
      if (d.pauseAt && d.pauseAt.seconds != null) {
        const pms = d.pauseAt.seconds * 1000 + Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
        setPauseAtMs(pms);
      } else {
        setPauseAtMs(null);
      }
      if (d.isPaused && d.pauseAt) {
        const e = Math.floor(((d.pauseAt.seconds * 1000 + Math.floor((d.pauseAt.nanoseconds || 0) / 1e6)) - startMs) / 1000);
        setElapsedSec(e < 0 ? 0 : e);
      }
    });
    return () => unsub();
  }, []);



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
    const tick = () => {
      const e = Math.floor((Date.now() - quizStartMs) / 1000);
      setElapsedSec(e < 0 ? 0 : e);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs]);



  // trie toutes les questions par timecode (secondes), celles sans timecode vont à la fin
  const sorted = [...questionsList].sort((a, b) => getTimeSec(a) - getTimeSec(b));

  // choisit la dernière dont timecode <= elapsedSec
  let activeIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (t <= elapsedSec) activeIndex = i; else break;
  }
  const currentQuestion = activeIndex >= 0 ? sorted[activeIndex] : null;

  // calcule la prochaine question planifiée (après maintenant)
  let nextTimeSec = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (Number.isFinite(t) && t > elapsedSec) { nextTimeSec = t; break; }
  }

  // pour l’affichage “première question” si rien d’actif
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;


  // reset champ et feedback quand la question active change
  const currentQuestionId = currentQuestion?.id ?? null;
  const revealPhrase = useMemo(() => {
    return currentQuestion ? pickRevealPhrase(currentQuestion) : "";
  }, [currentQuestionId]);

  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);

  // --- Révélation = les 20s AVANT la prochaine question planifiée ---
  const REVEAL_DURATION_SEC = 20;
  const secondsToNext = (nextTimeSec != null) ? (nextTimeSec - elapsedSec) : null;

  const isRevealing = Boolean(
    currentQuestion &&
    nextTimeSec != null &&
    secondsToNext > 0 &&
    secondsToNext <= REVEAL_DURATION_SEC
  );




  useEffect(() => {
    setResult(null);
    setAnswer('');
    setWrongTimes([]);
    setCooldownUntilMs(null);
    setLockPhraseIndex(null);
  }, [currentQuestionId]);


  // Blocage temporaire après trop de mauvaises réponses
  const nowMs = Date.now();
  const isLocked = RATE_LIMIT_ENABLED && cooldownUntilMs != null && nowMs < cooldownUntilMs;
  const lockRemainingSec = isLocked ? Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000)) : 0;
  const lockText = (lockPhraseIndex != null && LOCK_PHRASES[lockPhraseIndex])
    ? LOCK_PHRASES[lockPhraseIndex]
    : "Eh, arrête de spammer ! Ecoute et réfléchis plutôt !";


  // On interdit la saisie pendant la révélation et pendant le blocage
  const answersOpen = Boolean(currentQuestion && !isRevealing && !isLocked);

  // On masque complètement l'input si la réponse est correcte
  const showInput = Boolean(answersOpen && result !== "correct");


  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;

    const userInput = normalize(answer);
    const accepted = currentQuestion.answers.map(normalize);

    const isCorrect = accepted.some(acc => acc === userInput || isCloseEnough(userInput, acc));

    if (isCorrect) {
      setResult("correct");
      setAnswer("");
    } else {
      setResult("wrong");
      setAnswer("");

      // incrémente le compteur et déclenche le blocage si seuil atteint
      setWrongTimes(prev => {
        const now = Date.now();
        // ne garder que les tentatives dans la fenêtre (15s par défaut)
        const pruned = prev.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        const nextArr = [...pruned, now];

        if (RATE_LIMIT_ENABLED && nextArr.length >= MAX_WRONG_ATTEMPTS && !isLocked) {
          setCooldownUntilMs(now + COOLDOWN_MS);
          setLockPhraseIndex(() => Math.floor(Math.random() * LOCK_PHRASES.length));
          return []; // reset après blocage
        }
        return nextArr;
      });

      // refocus + animation visuelle
      setTimeout(() => {
        const el = answerInputRef.current;
        if (el) {
          el.focus();
          el.classList.remove('shake');
          el.classList.remove('flashWrong');
          void el.offsetWidth;
          el.classList.add('shake');
          el.classList.add('flashWrong');
        }
      }, 0);

      setTimeout(() => setResult(null), 400);
    }
  };

  // ✅ Définir la fonction de soumission avant le return
  const handleSubmit = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (isLocked) return; // bloqué temporairement
    const trimmed = (answer ?? '').trim();
    if (!trimmed) return;
    checkAnswer();
  };


  const PLAYER_IMG_MAX = 220; // px

  // --- Préchargement de l'image pour éviter le lag au moment d'afficher ---
  useEffect(() => {
    if (currentQuestion?.imageUrl) {
      const img = new Image();
      img.src = currentQuestion.imageUrl;
    }
  }, [currentQuestion?.imageUrl]);


  return (
    <div style={{ background: '#0a0a1a', color: 'white', padding: '20px', height: '100vh', textAlign: 'center', position: 'relative' }}>
      <div style={{
        position: 'absolute',
        top: 12,
        right: 12,
        background: '#111',
        padding: '6px 10px',
        borderRadius: 8,
        fontFamily: 'monospace',
        letterSpacing: 1,
        border: '1px solid #2a2a2a'
      }}>
        ⏱ {formatHMS(elapsedSec)}
      </div>

      {currentQuestion ? (
        <>
          {!isRevealing ? (
            <h2 style={{ fontSize: '1.5rem' }}>{currentQuestion.text}</h2>
          ) : (
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div style={{ opacity: 0.85, fontSize: 16, marginBottom: 6 }}>{revealPhrase}</div>
              <h2 style={{ fontSize: '1.6rem', margin: 0 }}>{primaryAnswer}</h2>
            </div>
          )}

          {isRevealing && currentQuestion?.imageUrl ? (
            <div
              style={{
                width: PLAYER_IMG_MAX,
                height: PLAYER_IMG_MAX,
                maxWidth: '100%',
                margin: '16px auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#111',
                borderRadius: 8,
                overflow: 'hidden'
              }}
            >
              <img
                src={currentQuestion.imageUrl}
                alt="Réponse visuelle — œuvre"
                style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }}
                loading="lazy"
                decoding="async"
              />
            </div>
          ) : null}


          {/* 👉 Entrée valide naturellement le formulaire */}
          <form onSubmit={handleSubmit}>
            {showInput ? (
              <input
                ref={answerInputRef}
                className="answerInput"
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Votre réponse"
                style={{ width: '80%', padding: '10px', marginTop: '20px' }}
                autoFocus
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
              />
            ) : (
              isLocked && !isRevealing ? (
                <p style={{ color: '#f59e0b', fontWeight: 800, fontSize: '1.2rem', marginTop: 16 }}>
                  {lockText} ({lockRemainingSec}s)
                </p>
              ) : null
            )}
            {/*
            <button type="submit" onClick={handleSubmit} style={{ display: 'block', margin: '20px auto' }}>
              Valider
            </button>
            */}
          </form>

          {result === "correct" && !isRevealing && (
            <p style={{ color: 'lime', fontSize: '2.2rem', fontWeight: 800, marginTop: 20 }}>
              Bonne réponse
            </p>
          )}
          {/* message "mauvaise réponse" supprimé – on utilise le flash rouge de l'input */}
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
      <style jsx>{`
  .answerInput.shake {
    animation: shake 250ms ease-in-out;
  }
  @keyframes shake {
    0%   { transform: translateX(0); }
    20%  { transform: translateX(-6px); }
    40%  { transform: translateX(6px); }
    60%  { transform: translateX(-4px); }
    80%  { transform: translateX(4px); }
    100% { transform: translateX(0); }
  }

  /* Rouge bien vif : overlay interne + liseré rouge, très court */
  .answerInput.flashWrong {
    animation: flashWrong 220ms ease-out;
  }
  @keyframes flashWrong {
    /* Départ : rouge saturé très visible, même sur fond sombre */
    0% {
      box-shadow:
        0 0 0 3px rgba(255, 0, 0, 0.95) inset,   /* liseré rouge interne épais */
        0 0 0 9999px rgba(255, 0, 0, 0.28) inset,/* overlay rouge interne */
        0 0 10px rgba(255, 0, 0, 0.85);          /* halo externe léger */
      background-color: rgba(255, 0, 0, 0.35);   /* petit voile rouge */
      border-color: rgba(255, 0, 0, 1);
      color: inherit;
    }
    60% {
      box-shadow:
        0 0 0 2px rgba(255, 0, 0, 0.75) inset,
        0 0 0 9999px rgba(255, 0, 0, 0.18) inset,
        0 0 6px rgba(255, 0, 0, 0.6);
      background-color: rgba(255, 0, 0, 0.18);
    }
    /* Fin : revient à l'état normal (pas de fill-mode) */
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
