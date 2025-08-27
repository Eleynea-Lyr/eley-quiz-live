// /pages/player.js
import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, orderBy, query, doc, onSnapshot } from 'firebase/firestore';


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
  useEffect(() => {
    setResult(null);
    setAnswer('');
  }, [currentQuestionId]);


  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;

    const userInput = normalize(answer);
    const accepted = currentQuestion.answers.map(normalize);

    const isCorrect = accepted.some(acc => acc === userInput || isCloseEnough(userInput, acc));
    setResult(isCorrect ? "correct" : "wrong");

    setTimeout(() => {
      setResult(null);
      setAnswer('');
      // L’enchaînement est maintenant piloté par le timecode (elapsedSec).
    }, 3000);

  };

  // ✅ Définir la fonction de soumission avant le return
  const handleSubmit = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const trimmed = (answer ?? '').trim();
    if (!trimmed) return;
    // Appelle la logique existante
    checkAnswer();
  };

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
          <h2 style={{ fontSize: '1.5rem' }}>{currentQuestion.text}</h2>

          {currentQuestion.imageUrl && (
            <div
              style={{
                width: 100,
                height: 100,
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
                alt="illustration"
                style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }}
                loading="lazy"
                decoding="async"
              />
            </div>
          )}

          {/* 👉 Entrée valide naturellement le formulaire */}
          <form onSubmit={handleSubmit}>
            <input
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

            {/*
            <button type="submit" onClick={handleSubmit} style={{ display: 'block', margin: '20px auto' }}>
              Valider
            </button>
            */}
          </form>

          {result === "correct" && <p style={{ color: 'lime' }}>✅ Bonne réponse !</p>}
          {result === "wrong" && <p style={{ color: 'red' }}>❌ Mauvaise réponse</p>}
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
  );
}
