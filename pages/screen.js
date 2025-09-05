// /pages/screen.js
import { useState, useEffect, useMemo } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, orderBy, query, doc, onSnapshot } from 'firebase/firestore';

// ----- helpers -----
function getTimeSec(q) {
  if (!q || typeof q !== 'object') return Infinity;
  if (typeof q.timecodeSec === 'number') return q.timecodeSec;        // nouveau format (secondes)
  if (typeof q.timecode === 'number') return Math.round(q.timecode * 60); // rétro-compat (minutes)
  return Infinity;
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
  if (!Number.isFinite(sec) || sec < 0) return '00:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

export default function Screen() {
  const [questionsList, setQuestionsList] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);


  // Charger les questions une fois (ordre chronologique de création)
  useEffect(() => {
    const fetchQuestions = async () => {
      const q = query(collection(db, 'LesQuestions'), orderBy('createdAt', 'asc'));
      const snapshot = await getDocs(q);
      const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setQuestionsList(list);
    };
    fetchQuestions();
  }, []);

  // Suivre l'état du quiz (démarrage)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'quiz', 'state'), (snap) => {
      const d = snap.data();
      if (!d || !d.startAt) {
        setIsRunning(false);
        setIsPaused(false);
        setQuizStartMs(null);
        setPauseAtMs(null);
        setElapsedSec(0);
        return;
      }
      setIsRunning(!!d.isRunning);
      setIsPaused(!!d.isPaused);
      const startMs = d.startAt.seconds * 1000 + Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      setQuizStartMs(startMs);
      if (d.pauseAt && d.pauseAt.seconds != null) {
        const pms = d.pauseAt.seconds * 1000 + Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
        setPauseAtMs(pms);
        const e = Math.floor((pms - startMs) / 1000);
        setElapsedSec(e < 0 ? 0 : e);
      } else {
        setPauseAtMs(null);
      }
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
    const tick = () => {
      const e = Math.floor((Date.now() - quizStartMs) / 1000);
      setElapsedSec(e < 0 ? 0 : e);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs]);


  // Sélection de la question active
  const sorted = [...questionsList].sort((a, b) => getTimeSec(a) - getTimeSec(b));
  let activeIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (t <= elapsedSec) activeIndex = i; else break;
  }
  const currentQuestion = activeIndex >= 0 ? sorted[activeIndex] : null;

  const currentQuestionId = currentQuestion?.id ?? null;

  const revealPhrase = useMemo(() => {
    return currentQuestion ? pickRevealPhrase(currentQuestion) : "";
  }, [currentQuestionId]);

  const primaryAnswer = useMemo(() => {
    const a = currentQuestion?.answers;
    return Array.isArray(a) && a.length ? String(a[0]) : "";
  }, [currentQuestionId]);


  // Infos pour les messages d’attente
  const allTimes = sorted.map(getTimeSec).filter((t) => Number.isFinite(t));
  const earliestTimeSec = allTimes.length ? Math.min(...allTimes) : null;

  // Prochaine question planifiée (après maintenant)
  let nextTimeSec = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTimeSec(sorted[i]);
    if (Number.isFinite(t) && t > elapsedSec) { nextTimeSec = t; break; }
  }

  // --- Révélation = les 20s AVANT la prochaine question planifiée ---
  const REVEAL_DURATION_SEC = 20;
  const secondsToNext = (typeof nextTimeSec === 'number') ? (nextTimeSec - elapsedSec) : null;

  const isRevealing = Boolean(
    currentQuestion &&
    typeof nextTimeSec === 'number' &&
    secondsToNext > 0 &&
    secondsToNext <= REVEAL_DURATION_SEC
  );

  const SCREEN_IMG_MAX = 300; // px

  // --- Préchargement image ---
  useEffect(() => {
    if (currentQuestion?.imageUrl) {
      const img = new Image();
      img.src = currentQuestion.imageUrl;
    }
  }, [currentQuestion?.imageUrl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'row', background: '#000814', color: 'white', minHeight: '100vh', position: 'relative' }}>
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

      {/* Zone question */}
      <div style={{ flex: 2, padding: '40px' }}>
        {currentQuestion ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {!isRevealing ? (
                <h1 style={{ fontSize: '2rem', margin: 0 }}>{currentQuestion.text}</h1>
              ) : (
                <div style={{ marginTop: 8, marginBottom: 4 }}>
                  <div style={{ opacity: 0.85, fontSize: 18, marginBottom: 8 }}>{revealPhrase}</div>
                  <h1 style={{ fontSize: '2.2rem', margin: 0 }}>{primaryAnswer}</h1>
                </div>
              )}
            </div>

            {isRevealing && currentQuestion?.imageUrl ? (
              <div
                style={{
                  width: SCREEN_IMG_MAX,
                  height: SCREEN_IMG_MAX,
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
                  alt="Révélation — œuvre"
                  style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            ) : null}


            <div style={{ marginTop: 12, opacity: 0.7, fontSize: 14 }}>
              Temps écoulé : {formatHMS(elapsedSec)}
              {Number.isFinite(getTimeSec(currentQuestion)) && (
                <> — Timecode : {formatHMS(getTimeSec(currentQuestion))}</>
              )}
            </div>
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

      {/* Zone scores (placeholder) */}
      <div style={{ flex: 1, padding: '20px', background: '#001d3d' }}>
        <h2>Tableau des scores</h2>
        <p>(Les scores seront ajoutés ici plus tard)</p>
      </div>
    </div>
  );
}
