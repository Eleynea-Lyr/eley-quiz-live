// ============================================================================
// lib/firebase-helpers.js
// Fonctions Firestore réutilisables (scoring, attribution TX, hooks)
// ============================================================================

import { useEffect } from 'react';
import { doc, getDoc, runTransaction, serverTimestamp, increment, collection, getDocs, query, where, updateDoc, writeBatch } from 'firebase/firestore';
import { DEFAULT_SCORING_TABLE, BUZZER_STATES } from './constants';

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

      tx.set(doc(db, "answers", qid, "awards", pid), {
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
 * Idempotent : ne double-compte pas si déjà marqué correct.
 */
export async function recordFirstCorrectAndPredict({ db, qid, playerId }) {
  if (!qid || !playerId) {
    throw new Error("[recordFirstCorrectAndPredict] Missing qid or playerId");
  }
  
  const table = await getScoringTable(db);
  const qRef = doc(db, "answers", qid);
  const subRef = doc(db, "answers", qid, "submissions", playerId);

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

    tx.set(subRef, {
      isCorrect: true,
      firstCorrectAt: serverTimestamp(),
      predictedRank,
      predictedPoints,
    }, { merge: true });

    return { predictedRank, predictedPoints };
  });
}

// ============================= ELEYBUZZ =============================

/**
 * Enregistre un buzz atomiquement (transaction) - seul le premier joueur peut buzzer.
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur qui buzz
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function registerBuzzerPress(db, playerId) {
  if (!db || !playerId) {
    throw new Error("[registerBuzzerPress] Missing db or playerId");
  }

  const stateRef = doc(db, "quiz", "state");

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(stateRef);
    if (!snap.exists()) {
      throw new Error("[registerBuzzerPress] quiz/state does not exist");
    }

    const data = snap.data() || {};

    // Vérifier que le buzzer est ouvert et qu'aucun joueur n'a encore buzzé
    if (data.buzzerState !== BUZZER_STATES.OPEN) {
      return { ok: false, reason: "buzzer-not-open" };
    }

    if (data.firstPlayerId) {
      return { ok: false, reason: "already-locked" };
    }

    // Récupérer le nom du joueur
    const playerRef = doc(db, "quiz", "state", "players", playerId);
    const playerSnap = await tx.get(playerRef);
    
    if (!playerSnap.exists()) {
      return { ok: false, reason: "player-not-found" };
    }

    const playerName = playerSnap.data().name || "";

    // Verrouiller le buzzer avec ce joueur
    tx.update(stateRef, {
      buzzerState: BUZZER_STATES.LOCKED,
      firstPlayerId: playerId,
      firstPlayerName: playerName,
    });

    return { ok: true };
  });

  // Si le buzz a réussi, réinitialiser les locks de tous les joueurs
  // (sauf celui qui vient de buzzé) pour permettre aux autres de rebuzzer
  // Note: On le fait après la transaction pour éviter de bloquer le buzz
  if (result.ok) {
    // Appel asynchrone non-bloquant pour réinitialiser les locks
    // Utilisation d'une référence directe pour éviter les imports circulaires
    resetAllPlayerBuzzLocks(db, [playerId]).catch((e) => {
      console.error("[registerBuzzerPress] Failed to reset locks:", e);
      // Ne pas faire échouer le buzz si le reset des locks échoue
    });
  }

  return result;
}

/**
 * Attribue des points EleyBuzz à un joueur.
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @param {number} points - Nombre de points à attribuer
 * @returns {Promise<{ok: boolean, newScore?: number, reason?: string}>}
 */
export async function awardBuzzerPoints(db, playerId, points) {
  if (!db || !playerId || !Number.isFinite(points) || points <= 0) {
    throw new Error("[awardBuzzerPoints] Invalid parameters");
  }

  const playerRef = doc(db, "quiz", "state", "players", playerId);

  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(playerRef);
    if (!snap.exists()) {
      return { ok: false, reason: "player-not-found" };
    }

    const currentBuzzScore = Number(snap.data().buzzScore || 0);
    const newScore = currentBuzzScore + points;

    tx.update(playerRef, {
      buzzScore: newScore,
    });

    return { ok: true, newScore };
  });
}

/**
 * Réinitialise l'état du buzzer.
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
  await updateDoc(playerRef, { canBuzz: true }, { merge: true });
}

/**
 * Désactive le droit de buzzer d'un joueur (après une mauvaise réponse).
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @returns {Promise<void>}
 */
export async function lockPlayerBuzz(db, playerId) {
  if (!db || !playerId) {
    throw new Error("[lockPlayerBuzz] Missing db or playerId");
  }

  const playerRef = doc(db, "quiz", "state", "players", playerId);
  await updateDoc(playerRef, { canBuzz: false }, { merge: true });
}

/**
 * Réinitialise les locks de tous les joueurs (sauf ceux spécifiés).
 * Utilisé quand un nouveau joueur buzz après une mauvaise réponse.
 * @param {Object} db - Instance Firestore
 * @param {string[]} exceptPlayerIds - IDs des joueurs à exclure du reset (optionnel)
 * @returns {Promise<void>}
 */
export async function resetAllPlayerBuzzLocks(db, exceptPlayerIds = []) {
  if (!db) {
    throw new Error("[resetAllPlayerBuzzLocks] Missing db");
  }

  const playersCol = collection(db, "quiz", "state", "players");
  const snap = await getDocs(playersCol);
  const exceptSet = new Set(exceptPlayerIds || []);

  let batch = writeBatch(db);
  let count = 0;
  for (const d of snap.docs) {
    if (!exceptSet.has(d.id)) {
      batch.update(doc(playersCol, d.id), { canBuzz: true });
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
}

