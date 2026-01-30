// ============================================================================
// lib/firebase-helpers.js
// Fonctions Firestore réutilisables (scoring, attribution TX, hooks)
// ============================================================================

import { useEffect, useState } from 'react';
import { doc, getDoc, runTransaction, serverTimestamp, increment, collection, getDocs, query, where, updateDoc, writeBatch, onSnapshot, deleteDoc, Timestamp } from 'firebase/firestore';
import {
  DEFAULT_SCORING_TABLE,
  BUZZER_STATES,
  BUZZER_LATENCY_TOLERANCE_MS,
  REVEAL_DURATION_SEC,
  COUNTDOWN_START_SEC,
  ROUND_START_INTRO_SEC,
  COOLDOWN_MS,
  BUZZER_COOLDOWN_MS,
  BUZZER_CORRECT_MESSAGE_DURATION_MS,
  BUZZER_WRONG_MESSAGE_DURATION_MS,
  TIME_MUSIC_MIN_SEC,
  DEFAULT_TIME_MUSIC_SEC,
  DEFAULT_BUZZER_COLLECT_WINDOW_MS,
} from './constants';
import {
  PLAYER_MESSAGES,
  ELEYBUZZ_PLAYER_MESSAGES,
  SCREEN_MESSAGES,
  ELEYBUZZ_SCREEN_MESSAGES,
  LOCK_MESSAGES,
  DEFAULT_REVEAL_PHRASES,
} from './messages';

// ============================= MOBILE VH FIX =============================

/**
 * Hook: Fix viewport height sur mobile (bug 100vh iOS)
 */
export const useMobileVH = () => {
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

// ============================= SCORING =============================

/**
 * Récupère la table de scoring depuis quiz/config (avec cache)
 */
let _cachedScoring = null;

export async function getScoringTable(db) {
  if (_cachedScoring) return _cachedScoring;
  
  try {
    const cfgRef = doc(db, "quiz", "config");
    const snap = await getDoc(cfgRef);
    const table = (snap.exists() && Array.isArray(snap.data().scoringTable))
      ? snap.data().scoringTable
      : DEFAULT_SCORING_TABLE;
    _cachedScoring = table;
    return table;
  } catch (e) {
    console.error("[getScoringTable] fallback:", e);
    _cachedScoring = DEFAULT_SCORING_TABLE;
    return DEFAULT_SCORING_TABLE;
  }
}

/**
 * Reset du cache scoring (utile après modification admin)
 */
export function resetScoringCache() {
  _cachedScoring = null;
}

// ============================= CONFIGURATION TIMING =============================

/**
 * Cache pour la configuration de timing
 */
let _cachedTimingConfig = null;

/**
 * Récupère la configuration de timing depuis quiz/config (avec cache)
 * Retourne un objet avec toutes les valeurs de timing, avec fallback vers les constantes
 */
export async function getTimingConfig(db) {
  if (_cachedTimingConfig) return _cachedTimingConfig;

  try {
    const cfgRef = doc(db, "quiz", "config");
    const snap = await getDoc(cfgRef);
    const data = snap.exists() ? snap.data() : {};

    const config = {
      revealDurationSec: Number(data.revealDurationSec) || REVEAL_DURATION_SEC,
      countdownStartSec: Number(data.countdownStartSec) || COUNTDOWN_START_SEC,
      roundStartIntroSec: Number(data.roundStartIntroSec) || ROUND_START_INTRO_SEC,
      cooldownMs: Number(data.cooldownMs) || COOLDOWN_MS,
      buzzerCooldownMs: Number(data.buzzerCooldownMs) || BUZZER_COOLDOWN_MS,
      buzzerCorrectMessageDurationMs: Number(data.buzzerCorrectMessageDurationMs) || BUZZER_CORRECT_MESSAGE_DURATION_MS,
      buzzerWrongMessageDurationMs: Number(data.buzzerWrongMessageDurationMs) || BUZZER_WRONG_MESSAGE_DURATION_MS,
      buzzerCollectWindowMs: Number(data.buzzerCollectWindowMs) || DEFAULT_BUZZER_COLLECT_WINDOW_MS,
      timeMusicMinSec: Number(data.timeMusicMinSec) || TIME_MUSIC_MIN_SEC,
      defaultTimeMusicSec: Number(data.defaultTimeMusicSec) || DEFAULT_TIME_MUSIC_SEC,
    };

    _cachedTimingConfig = config;
    return config;
  } catch (e) {
    console.error("[getTimingConfig] fallback:", e);
    // Retourner les valeurs par défaut
    const defaultConfig = {
      revealDurationSec: REVEAL_DURATION_SEC,
      countdownStartSec: COUNTDOWN_START_SEC,
      roundStartIntroSec: ROUND_START_INTRO_SEC,
      buzzerCollectWindowMs: DEFAULT_BUZZER_COLLECT_WINDOW_MS,
      cooldownMs: COOLDOWN_MS,
      buzzerCooldownMs: BUZZER_COOLDOWN_MS,
      buzzerCorrectMessageDurationMs: BUZZER_CORRECT_MESSAGE_DURATION_MS,
      buzzerWrongMessageDurationMs: BUZZER_WRONG_MESSAGE_DURATION_MS,
      timeMusicMinSec: TIME_MUSIC_MIN_SEC,
      defaultTimeMusicSec: DEFAULT_TIME_MUSIC_SEC,
    };
    _cachedTimingConfig = defaultConfig;
    return defaultConfig;
  }
}

/**
 * Reset du cache timing config (utile après modification dans /config)
 */
export function resetTimingConfigCache() {
  _cachedTimingConfig = null;
}

// ============================= ATTRIBUTION POINTS =============================

/**
 * Normalise un timestamp Firestore/number en ms
 */
function toMs(obj) {
  if (!obj) return Infinity;
  if (typeof obj.toMillis === "function") return obj.toMillis();
  if (typeof obj.seconds === "number") {
    return obj.seconds * 1000 + Math.floor((obj.nanoseconds || obj.nanos || 0) / 1e6);
  }
  if (typeof obj === "number" && Number.isFinite(obj)) return Math.floor(obj);
  return Infinity;
}

/**
 * Attribution transactionnelle et idempotente des points pour une question.
 * Utilisé par Admin et Screen.
 */
export async function ensureAwardsForQuestionTx(db, qid) {
  if (!qid) return { ok: false, reason: "no-qid" };

  // 1) Lire toutes les bonnes réponses
  const subsCol = collection(db, "answers", qid, "submissions");
  let subsSnap;
  
  try {
    subsSnap = await getDocs(query(subsCol, where("isCorrect", "==", true)));
  } catch (e) {
    console.error("[ensureAwardsForQuestionTx] read failed:", e);
    return { ok: false, reason: "read-failed" };
  }

  // 2) Trier localement par timestamp
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
    return { ok: true, reason: "no-correct-submissions" };
  }

  const table = await getScoringTable(db);
  const qDocRef = doc(db, "answers", qid);
  const playersCol = collection(doc(db, "quiz", "state"), "players");

  // 3) Transaction idempotente
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
      const awardRef = doc(db, "answers", qid, "awards", pid);

      // Vérifier si les points ont déjà été attribués (pour éviter le double comptage)
      const awardSnap = await tx.get(awardRef);
      if (awardSnap.exists()) {
        // Les points ont déjà été attribués par recordFirstCorrectAndPredict
        // On met juste à jour l'award avec les infos finales si nécessaire
        tx.set(awardRef, {
          points,
          rank: i + 1,
          awardedAt: serverTimestamp(),
        }, { merge: true });
        // Ne pas incrémenter le score car il a déjà été mis à jour
        continue;
      }

      // Les points n'ont pas encore été attribués, les attribuer maintenant
      tx.set(awardRef, {
        points,
        rank: i + 1,
        awardedAt: serverTimestamp(),
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

// ============================= INSTANT WIN (Player) =============================

/**
 * Enregistre la première bonne réponse d'un joueur et retourne rang/points prédits.
 * Met à jour le score immédiatement dans Firestore pour synchronisation en temps réel.
 * Idempotent : ne double-compte pas si déjà marqué correct.
 */
export async function recordFirstCorrectAndPredict({ db, qid, playerId }) {
  if (!qid || !playerId) {
    throw new Error("[recordFirstCorrectAndPredict] Missing qid or playerId");
  }
  
  const table = await getScoringTable(db);
  const qRef = doc(db, "answers", qid);
  const subRef = doc(db, "answers", qid, "submissions", playerId);
  const playerRef = doc(db, "quiz", "state", "players", playerId);
  const awardRef = doc(db, "answers", qid, "awards", playerId);

  return await runTransaction(db, async (tx) => {
    const subSnap = await tx.get(subRef);

    // Si déjà correct, retourner les valeurs existantes
    if (subSnap.exists() && subSnap.data().isCorrect) {
      const d = subSnap.data() || {};
      const predictedRank = d.predictedRank ?? null;
      const predictedPoints = d.predictedPoints ?? null;
      if (predictedRank != null && predictedPoints != null) {
        return { predictedRank, predictedPoints };
      }
      return { predictedRank: 0, predictedPoints: 0 };
    }

    // Incrémenter le compteur
    const qSnap = await tx.get(qRef);
    const cur = qSnap.exists() ? (qSnap.data().correctCount || 0) : 0;
    const next = cur + 1;

    tx.set(qRef, { correctCount: next }, { merge: true });

    const predictedRank = next;
    const predictedPoints = table[predictedRank - 1] ?? 0;

    // Enregistrer la soumission
    tx.set(subRef, {
      isCorrect: true,
      firstCorrectAt: serverTimestamp(),
      predictedRank,
      predictedPoints,
    }, { merge: true });

    // Mettre à jour le score immédiatement dans Firestore (comme pour EleyBuzz)
    // Cela permet au classement dans Screen de s'incrémenter en temps réel
    tx.update(playerRef, {
      score: increment(predictedPoints),
      lastDelta: predictedPoints,
      lastDeltaForQuestionId: qid,
    });

    // Créer l'award pour éviter le double comptage au reveal
    tx.set(awardRef, {
      points: predictedPoints,
      rank: predictedRank,
      awardedAt: serverTimestamp(),
    }, { merge: true });

    return { predictedRank, predictedPoints };
  });
}

// ============================= ELEYBUZZ =============================

/**
 * Enregistre un buzz. Le premier qui buzz devient le gagnant (pas de fenêtre de collecte).
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @returns {Promise<{ok: boolean, reason?: string, isFirst?: boolean}>}
 */
export async function registerBuzzerPress(db, playerId) {
  if (!db || !playerId) {
    throw new Error("[registerBuzzerPress] Missing db or playerId");
  }

  const stateRef = doc(db, "quiz", "state");
  const playerRef = doc(db, "quiz", "state", "players", playerId);

  // Lire d'abord le joueur en dehors de la transaction (lecture simple, plus rapide)
  // Cela réduit la latence car on évite une lecture dans la transaction
  let playerName = "";
  try {
    const playerSnap = await getDoc(playerRef);
    if (!playerSnap.exists()) {
      return { ok: false, reason: "player-not-found" };
    }
    const playerData = playerSnap.data() || {};
    playerName = playerData.name || "";
    
    // Vérifier que le joueur peut buzzer
    if (playerData.canBuzz === false) {
      return { ok: false, reason: "player-cannot-buzz" };
    }
  } catch (e) {
    console.error("[registerBuzzerPress] Failed to read player:", e);
    return { ok: false, reason: "player-read-failed" };
  }

  // Transaction optimisée : une seule lecture (stateRef) au lieu de deux
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(stateRef);
    if (!snap.exists()) {
      throw new Error("[registerBuzzerPress] quiz/state does not exist");
    }

    const data = snap.data() || {};

    // Vérifier que le buzzer est ouvert
    if (data.buzzerState !== BUZZER_STATES.OPEN) {
      return { ok: false, reason: "buzzer-not-open" };
    }

    // Si quelqu'un a déjà buzzé, refuser
    if (data.firstPlayerId) {
      return { ok: false, reason: "already-taken" };
    }

    // C'est le premier ! Le définir comme gagnant et passer en LOCKED
    // Utiliser serverTimestamp pour avoir un timestamp serveur précis
    tx.update(stateRef, {
      buzzerState: BUZZER_STATES.LOCKED,
      firstPlayerId: playerId,
      firstPlayerName: playerName,
      buzzerPressedAt: serverTimestamp(), // Timestamp serveur pour déterminer le vrai premier
    });

    return { ok: true, isFirst: true };
  });

  // Si le buzz a réussi, réinitialiser les locks de TOUS les joueurs
  if (result.ok) {
    resetAllPlayerBuzzLocks(db, []).catch((e) => {
      console.error("[registerBuzzerPress] Failed to reset locks:", e);
    });
  }

  return result;
}


/**
 * Attribue ou retire des points EleyBuzz à un joueur.
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @param {number} points - Nombre de points à ajouter (positif) ou retirer (négatif)
 * @returns {Promise<{ok: boolean, newScore?: number, reason?: string}>}
 */
export async function awardBuzzerPoints(db, playerId, points) {
  if (!db || !playerId || !Number.isFinite(points) || points === 0) {
    throw new Error("[awardBuzzerPoints] Invalid parameters");
  }

  const playerRef = doc(db, "quiz", "state", "players", playerId);

  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(playerRef);
    if (!snap.exists()) {
      return { ok: false, reason: "player-not-found" };
    }

    const currentBuzzScore = Number(snap.data().buzzScore || 0);
    const newScore = currentBuzzScore + points; // Peut être négatif si points < 0

    tx.update(playerRef, {
      buzzScore: newScore,
    });

    return { ok: true, newScore };
  });
}

/**
 * Nettoie la collection temporaire des tentatives de buzzer.
 * @param {Object} db - Instance Firestore
 * @returns {Promise<void>}
 */
export async function clearBuzzerAttempts(db) {
  if (!db) {
    throw new Error("[clearBuzzerAttempts] Missing db");
  }

  try {
    const attemptsCol = collection(db, "quiz", "state", "buzzerAttempts");
    const snap = await getDocs(attemptsCol);
    
    if (snap.empty) return;

    // Utiliser des batches pour supprimer (limite de 500 opérations par batch)
    const docs = snap.docs;
    const BATCH_SIZE = 400; // On reste en dessous de la limite de 500
    
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      const chunk = docs.slice(i, i + BATCH_SIZE);
      
      for (const docSnap of chunk) {
        batch.delete(docSnap.ref);
      }
      
      await batch.commit();
    }
  } catch (e) {
    console.error("[clearBuzzerAttempts] Error:", e);
    // Ne pas faire échouer si le nettoyage échoue
  }
}

/**
 * Réinitialise l'état du buzzer et nettoie les timestamps locaux des joueurs.
 * @param {Object} db - Instance Firestore
 * @param {string} nextState - État suivant ("idle" ou "open"), défaut: "idle"
 * @returns {Promise<void>}
 */
export async function resetBuzzerState(db, nextState = BUZZER_STATES.IDLE) {
  if (!db) {
    throw new Error("[resetBuzzerState] Missing db");
  }

  const stateRef = doc(db, "quiz", "state");

  await updateDoc(stateRef, {
    buzzerState: nextState,
    firstPlayerId: null,
    firstPlayerName: null,
  });

  // Nettoyer les timestamps locaux de tous les joueurs (fait de manière asynchrone)
  const playersCol = collection(db, "quiz", "state", "players");
  getDocs(playersCol).then(async (snap) => {
    let batch = writeBatch(db);
    let count = 0;
    for (const d of snap.docs) {
      batch.update(doc(playersCol, d.id), { 
        lastBuzzerAttemptLocalMs: null 
      });
      count++;
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }
  }).catch((e) => {
    console.error("[resetBuzzerState] Failed to clear local timestamps:", e);
  });

  // Nettoyer aussi la collection temporaire des tentatives (legacy, si elle existe)
  clearBuzzerAttempts(db).catch((e) => {
    console.error("[resetBuzzerState] Failed to clear attempts:", e);
  });
}

/**
 * Réinitialise le lock d'un joueur (pour anti-spam).
 * Permet à un joueur de rebuzzer après qu'un autre joueur ait buzzé.
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @returns {Promise<void>}
 */
export async function resetPlayerBuzzLock(db, playerId) {
  if (!db || !playerId) {
    throw new Error("[resetPlayerBuzzLock] Missing db or playerId");
  }

  const playerRef = doc(db, "quiz", "state", "players", playerId);
  await updateDoc(playerRef, { 
    canBuzz: true,
    buzzerCooldownUntil: null  // Réinitialiser aussi le timestamp de cooldown
  }, { merge: true });
}

/**
 * Désactive le droit de buzzer d'un joueur (après une mauvaise réponse).
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @param {number} cooldownMs - Durée du cooldown en ms (optionnel, défaut: pas de cooldown timestamp)
 * @returns {Promise<void>}
 */
export async function lockPlayerBuzz(db, playerId, cooldownMs = null) {
  if (!db || !playerId) {
    throw new Error("[lockPlayerBuzz] Missing db or playerId");
  }

  const playerRef = doc(db, "quiz", "state", "players", playerId);
  const update = { canBuzz: false };
  
  // Si un cooldown est spécifié, calculer le timestamp de fin
  if (cooldownMs && Number.isFinite(cooldownMs) && cooldownMs > 0) {
    update.buzzerCooldownUntil = new Date(Date.now() + cooldownMs);
  }
  
  await updateDoc(playerRef, update, { merge: true });
}

/**
 * Réinitialise les locks de tous les joueurs (sauf ceux spécifiés).
 * Utilisé quand un nouveau joueur buzz après une mauvaise réponse.
 * Avec mécanisme de retry en cas d'échec.
 * IMPORTANT: Ne réinitialise PAS les cooldowns de punition (buzzerCooldownUntil) si le cooldown est encore actif.
 * @param {Object} db - Instance Firestore
 * @param {string[]} exceptPlayerIds - IDs des joueurs à exclure du reset (optionnel)
 * @param {number} maxRetries - Nombre max de tentatives (défaut: 3)
 * @returns {Promise<{ok: boolean, retries?: number, error?: Error}>}
 */
export async function resetAllPlayerBuzzLocks(db, exceptPlayerIds = [], maxRetries = 3) {
  if (!db) {
    throw new Error("[resetAllPlayerBuzzLocks] Missing db");
  }

  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const playersCol = collection(db, "quiz", "state", "players");
      const snap = await getDocs(playersCol);
      const exceptSet = new Set(exceptPlayerIds || []);
      const now = Date.now();

  let batch = writeBatch(db);
  let count = 0;
  for (const d of snap.docs) {
    if (!exceptSet.has(d.id)) {
      // Débloquer TOUS les joueurs (même ceux avec cooldown actif)
      // C'est utilisé quand un autre joueur donne une mauvaise réponse
      // pour libérer tous les joueurs punis précédemment
      batch.update(doc(playersCol, d.id), { 
        canBuzz: true,
        buzzerCooldownUntil: null,  // Réinitialiser le timestamp de cooldown (libération de la punition)
        lastBuzzerAttemptLocalMs: null  // Nettoyer aussi le timestamp local
      });
      count++;
      // Firestore limite les batches à 500 opérations
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db); // Nouveau batch pour la suite
        count = 0;
      }
    }
  }
  if (count > 0) {
    await batch.commit();
  }
      
      // Succès
      return { ok: true, retries: attempt };
    } catch (e) {
      lastError = e;
      console.error(`[resetAllPlayerBuzzLocks] Attempt ${attempt + 1}/${maxRetries} failed:`, e);
      
      // Attendre avant de réessayer (backoff exponentiel: 100ms, 200ms, 400ms...)
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }
  }
  
  // Toutes les tentatives ont échoué
  console.error("[resetAllPlayerBuzzLocks] All retries failed. Last error:", lastError);
  return { ok: false, error: lastError };
}

// ============================= MESSAGES =============================

/**
 * Hook: Charge les messages depuis Firestore avec fallback sur les valeurs par défaut
 */
export function useMessages(db) {
  const [messages, setMessages] = useState({
    playerQuiz: { ...PLAYER_MESSAGES },
    playerEleyBuzz: { ...ELEYBUZZ_PLAYER_MESSAGES },
    screenQuiz: { ...SCREEN_MESSAGES },
    screenEleyBuzz: { ...ELEYBUZZ_SCREEN_MESSAGES },
    lockMessages: [...LOCK_MESSAGES],
    revealPhrases: [...DEFAULT_REVEAL_PHRASES],
  });

  useEffect(() => {
    if (!db) return;

    const configRef = doc(db, "quiz", "config");
    const unsub = onSnapshot(
      configRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() || {};

        setMessages({
          playerQuiz: {
            ...PLAYER_MESSAGES,
            ...(data.playerQuiz || {}),
          },
          playerEleyBuzz: {
            ...ELEYBUZZ_PLAYER_MESSAGES,
            ...(data.playerEleyBuzz || {}),
          },
          screenQuiz: {
            ...SCREEN_MESSAGES,
            ...(data.screenQuiz || {}),
          },
          screenEleyBuzz: {
            ...ELEYBUZZ_SCREEN_MESSAGES,
            ...(data.screenEleyBuzz || {}),
          },
          lockMessages: Array.isArray(data.lockMessages) && data.lockMessages.length > 0
            ? data.lockMessages
            : [...LOCK_MESSAGES],
          revealPhrases: Array.isArray(data.revealPhrases) && data.revealPhrases.length > 0
            ? data.revealPhrases
            : [...DEFAULT_REVEAL_PHRASES],
        });
      },
      (e) => console.error("[useMessages] onSnapshot error:", e)
    );

    return () => unsub();
  }, [db]);

  return messages;
}

