// ============================================================================
// lib/firebase-helpers.js
// Fonctions Firestore réutilisables (scoring, attribution TX, hooks)
// ============================================================================

import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc, runTransaction, serverTimestamp, increment, collection, getDocs, query, where, updateDoc, writeBatch, deleteDoc } from 'firebase/firestore';
import {
  DEFAULT_SCORING_TABLE,
  DEFAULT_TEAM_SCORING_TABLE,
  BUZZER_STATES,
  PLAYER_COLORS,
} from './constants';
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
 * Récupère la table de scoring depuis quiz/config
 */
export async function getScoringTable(db) {
  try {
    const cfgRef = doc(db, "quiz", "config");
    const snap = await getDoc(cfgRef);
    return (snap.exists() && Array.isArray(snap.data().scoringTable))
      ? snap.data().scoringTable
      : DEFAULT_SCORING_TABLE;
  } catch (e) {
    console.error("[getScoringTable] fallback:", e);
    return DEFAULT_SCORING_TABLE;
  }
}

/**
 * Récupère la table de scoring équipe depuis quiz/config
 */
export async function getTeamScoringTable(db) {
  try {
    const cfgRef = doc(db, "quiz", "config");
    const snap = await getDoc(cfgRef);
    const data = snap.exists() ? snap.data() : {};
    if (Array.isArray(data.teamScoringTable) && data.teamScoringTable.length > 0) {
      return data.teamScoringTable;
    }
  } catch (e) {
    console.error("[getTeamScoringTable] read failed:", e);
  }

  return DEFAULT_TEAM_SCORING_TABLE;
}

// ============================= ÉQUIPES =============================

/**
 * Récupère toutes les équipes existantes pour assigner une couleur différente
 */
async function getExistingTeamColors(db) {
  try {
    const teamsCol = collection(db, "quiz", "state", "teams");
    const snap = await getDocs(teamsCol);
    const colors = new Set();
    snap.docs.forEach((d) => {
      const color = d.data()?.color;
      if (color) colors.add(color);
    });
    return colors;
  } catch (e) {
    console.error("[getExistingTeamColors] error:", e);
    return new Set();
  }
}

/**
 * Choisit une couleur différente des équipes existantes
 * Exclut le jaune (#fbbf24, #facc15) car c'est la couleur du score bonus
 */
function pickTeamColor(existingColors) {
  // Couleurs à exclure : jaune (score bonus) + couleurs déjà utilisées
  const EXCLUDED_COLORS = new Set(["#fbbf24", "#facc15"]); // Jaune pour le score bonus
  const allExcluded = new Set([...existingColors, ...EXCLUDED_COLORS]);
  const available = PLAYER_COLORS.filter((c) => !allExcluded.has(c));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // Si toutes les couleurs sont prises (sauf jaune), retourner une aléatoire non-jaune
  const nonYellow = PLAYER_COLORS.filter((c) => !EXCLUDED_COLORS.has(c));
  return nonYellow.length > 0 
    ? nonYellow[Math.floor(Math.random() * nonYellow.length)]
    : PLAYER_COLORS[0]; // Fallback
}

/**
 * Crée une équipe de manière transactionnelle
 * @param {Object} db - Instance Firestore
 * @param {string} teamName - Nom de l'équipe (déjà validé et en majuscules)
 * @param {string} playerId - ID du joueur créateur
 * @param {string} nameNorm - Nom normalisé pour unicité
 * @returns {Promise<{ok: boolean, teamId?: string, reason?: string}>}
 */
export async function createTeamTx(db, teamName, playerId, nameNorm) {
  if (!teamName || !playerId || !nameNorm) {
    return { ok: false, reason: "missing-params" };
  }

  const teamsCol = collection(db, "quiz", "state", "teams");
  const playersCol = collection(db, "quiz", "state", "players");
  const playerRef = doc(playersCol, playerId);

  try {
    // Vérifier que le nom n'existe pas déjà (avant la transaction)
    const existingTeams = await getDocs(query(teamsCol, where("nameNorm", "==", nameNorm)));
    if (!existingTeams.empty) {
      return { ok: false, reason: "name-exists" };
    }

    // Récupérer les couleurs existantes (avant la transaction)
    const existingColors = await getExistingTeamColors(db);
    const color = pickTeamColor(existingColors);

    // Lire le joueur pour obtenir son équipe actuelle
    const playerSnap = await getDoc(playerRef);
    if (!playerSnap.exists()) {
      return { ok: false, reason: "player-not-found" };
    }
    const currentTeamId = playerSnap.data()?.teamId;

    // Transaction pour créer l'équipe et mettre à jour le joueur
    const teamRef = doc(teamsCol);
    return await runTransaction(db, async (tx) => {
      // Re-vérifier l'unicité dans la transaction (lecture)
      const checkSnap = await tx.get(playerRef);
      if (!checkSnap.exists()) {
        return { ok: false, reason: "player-not-found" };
      }

      // Créer l'équipe
      tx.set(teamRef, {
        name: teamName,
        nameNorm,
        color,
        teamQuizScore: 0,
        createdAt: serverTimestamp(),
        createdBy: playerId,
        memberIds: [playerId],
        isKicked: false,
        nameStatus: "ok",
        updatedAt: serverTimestamp(),
      });

      // Mettre à jour le joueur
      if (currentTeamId) {
        // Retirer le joueur de son ancienne équipe
        const oldTeamRef = doc(teamsCol, currentTeamId);
        const oldTeamSnap = await tx.get(oldTeamRef);
        if (oldTeamSnap.exists()) {
          const oldMemberIds = oldTeamSnap.data()?.memberIds || [];
          const newMemberIds = oldMemberIds.filter((id) => id !== playerId);
          tx.update(oldTeamRef, {
            memberIds: newMemberIds,
            updatedAt: serverTimestamp(),
          });
        }
      }

      tx.update(playerRef, {
        teamId: teamRef.id,
        updatedAt: serverTimestamp(),
      });

      return { ok: true, teamId: teamRef.id, color };
    });
  } catch (e) {
    console.error("[createTeamTx] error:", e);
    return { ok: false, reason: "transaction-failed", error: e.message };
  }
}

/**
 * Rejoint une équipe de manière transactionnelle (retire automatiquement de l'ancienne)
 * @param {Object} db - Instance Firestore
 * @param {string} teamId - ID de l'équipe à rejoindre
 * @param {string} playerId - ID du joueur
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function joinTeamTx(db, teamId, playerId) {
  if (!teamId || !playerId) {
    return { ok: false, reason: "missing-params" };
  }

  const teamsCol = collection(db, "quiz", "state", "teams");
  const playersCol = collection(db, "quiz", "state", "players");
  const teamRef = doc(teamsCol, teamId);
  const playerRef = doc(playersCol, playerId);

  try {
    return await runTransaction(db, async (tx) => {
      // Vérifier que l'équipe existe et n'est pas kickée
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists()) {
        return { ok: false, reason: "team-not-found" };
      }
      const teamData = teamSnap.data();
      if (teamData.isKicked || teamData.nameStatus === "rejected") {
        return { ok: false, reason: "team-unavailable" };
      }

      // Vérifier que le joueur existe
      const playerSnap = await tx.get(playerRef);
      if (!playerSnap.exists()) {
        return { ok: false, reason: "player-not-found" };
      }

      // Retirer le joueur de son ancienne équipe (si elle existe)
      const currentTeamId = playerSnap.data()?.teamId;
      if (currentTeamId && currentTeamId !== teamId) {
        const oldTeamRef = doc(teamsCol, currentTeamId);
        const oldTeamSnap = await tx.get(oldTeamRef);
        if (oldTeamSnap.exists()) {
          const oldMemberIds = oldTeamSnap.data()?.memberIds || [];
          const newMemberIds = oldMemberIds.filter((id) => id !== playerId);
          tx.update(oldTeamRef, {
            memberIds: newMemberIds,
            updatedAt: serverTimestamp(),
          });
        }
      }

      // Ajouter le joueur à la nouvelle équipe
      const memberIds = teamData.memberIds || [];
      if (!memberIds.includes(playerId)) {
        memberIds.push(playerId);
        tx.update(teamRef, {
          memberIds,
          updatedAt: serverTimestamp(),
        });
      }

      // Mettre à jour le joueur
      tx.update(playerRef, {
        teamId: teamId,
        updatedAt: serverTimestamp(),
      });

      return { ok: true };
    });
  } catch (e) {
    console.error("[joinTeamTx] error:", e);
    return { ok: false, reason: "transaction-failed", error: e.message };
  }
}

/**
 * Quitte une équipe de manière transactionnelle
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function leaveTeamTx(db, playerId) {
  if (!playerId) {
    return { ok: false, reason: "missing-params" };
  }

  const teamsCol = collection(db, "quiz", "state", "teams");
  const playersCol = collection(db, "quiz", "state", "players");
  const playerRef = doc(playersCol, playerId);

  try {
    return await runTransaction(db, async (tx) => {
      // Vérifier que le joueur existe
      const playerSnap = await tx.get(playerRef);
      if (!playerSnap.exists()) {
        return { ok: false, reason: "player-not-found" };
      }

      const currentTeamId = playerSnap.data()?.teamId;
      if (!currentTeamId) {
        return { ok: false, reason: "not-in-team" };
      }

      // Retirer le joueur de l'équipe
      const teamRef = doc(teamsCol, currentTeamId);
      const teamSnap = await tx.get(teamRef);
      if (teamSnap.exists()) {
        const memberIds = teamSnap.data()?.memberIds || [];
        const newMemberIds = memberIds.filter((id) => id !== playerId);
        
        // Si l'équipe n'a plus de membres, la supprimer
        if (newMemberIds.length === 0) {
          tx.delete(teamRef);
        } else {
          tx.update(teamRef, {
            memberIds: newMemberIds,
            updatedAt: serverTimestamp(),
          });
        }
      }

      // Retirer teamId du joueur
      tx.update(playerRef, {
        teamId: null,
        updatedAt: serverTimestamp(),
      });

      return { ok: true };
    });
  } catch (e) {
    console.error("[leaveTeamTx] error:", e);
    return { ok: false, reason: "transaction-failed", error: e.message };
  }
}

/**
 * Supprime une équipe et retire tous ses membres
 * Utilise des batch writes pour gérer un grand nombre de membres
 * @param {Object} db - Instance Firestore
 * @param {string} teamId - ID de l'équipe à supprimer
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function deleteTeamTx(db, teamId) {
  if (!db || !teamId) {
    return { ok: false, reason: "missing-params" };
  }

  const teamsCol = collection(db, "quiz", "state", "teams");
  const playersCol = collection(db, "quiz", "state", "players");
  const teamRef = doc(teamsCol, teamId);

  try {
    // D'abord, lire l'équipe pour obtenir la liste des membres
    const teamSnap = await getDoc(teamRef);
    if (!teamSnap.exists()) {
      return { ok: false, reason: "team-not-found" };
    }

    const teamData = teamSnap.data();
    const memberIds = teamData?.memberIds || [];

    // Utiliser des batch writes pour mettre à jour tous les joueurs
    // Firestore limite les batches à 500 opérations
    const BATCH_LIMIT = 500;
    let batch = writeBatch(db);
    let count = 0;

    for (const playerId of memberIds) {
      const playerRef = doc(playersCol, playerId);
      batch.update(playerRef, {
        teamId: null,
        updatedAt: serverTimestamp(),
      });
      count++;

      // Si on atteint la limite, commit le batch et en créer un nouveau
      if (count >= BATCH_LIMIT) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }

    // Commit le dernier batch s'il y a des opérations en attente
    if (count > 0) {
      await batch.commit();
    }

    // Supprimer l'équipe
    await deleteDoc(teamRef);

    return { ok: true };
  } catch (e) {
    console.error("[deleteTeamTx] error:", e);
    return { ok: false, reason: "transaction-failed", error: e.message };
  }
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
 * Indique si un teamAward existant doit empêcher une nouvelle attribution optimiste.
 * Un award « orphelin » (quiz reset sans purge teamAwards) ne bloque pas.
 */
function shouldBlockTeamOptimisticAward(teamAwardSnap, subSnap) {
  if (!teamAwardSnap?.exists()) return false;
  const ad = teamAwardSnap.data() || {};
  if (ad.isOptimistic) return true;
  return Boolean(subSnap?.exists() && subSnap.data()?.isCorrect === true);
}

/**
 * Indique si un teamAward est encore valide pour la passe finale (ensureAwards).
 */
function shouldSkipTeamFinalAward(teamAwardSnap, submissionSnaps, firstPlayerInfo) {
  if (!teamAwardSnap?.exists()) return false;
  const ad = teamAwardSnap.data() || {};
  if (ad.isOptimistic) return true;
  if (!firstPlayerInfo || ad.firstPlayerId !== firstPlayerInfo.playerId) return false;
  const subSnap = submissionSnaps.get(firstPlayerInfo.playerId);
  if (!subSnap?.exists() || subSnap.data()?.isCorrect !== true) return false;

  const awardMs = toMs(ad.awardedAt);
  const subMs = toMs(subSnap.data().firstCorrectAt);
  if (Number.isFinite(awardMs) && Number.isFinite(subMs)) {
    return awardMs >= subMs - 3000;
  }
  return true;
}

/**
 * Purge complète de answers/* (submissions, awards, teamAwards, doc racine).
 */
export async function purgeAnswersTree(db) {
  const answersCol = collection(db, "answers");
  const answersSnap = await getDocs(answersCol);

  for (const qDoc of answersSnap.docs) {
    const qid = qDoc.id;

    const subsCol = collection(db, "answers", qid, "submissions");
    const subsSnap = await getDocs(subsCol);
    if (!subsSnap.empty) {
      const ids = subsSnap.docs.map((d) => d.id);
      while (ids.length) {
        const chunk = ids.splice(0, 400);
        const batch = writeBatch(db);
        chunk.forEach((sid) => batch.delete(doc(subsCol, sid)));
        await batch.commit();
      }
    }

    const awardsCol = collection(db, "answers", qid, "awards");
    const awardsSnap = await getDocs(awardsCol);
    if (!awardsSnap.empty) {
      const ids = awardsSnap.docs.map((d) => d.id);
      while (ids.length) {
        const chunk = ids.splice(0, 400);
        const batch = writeBatch(db);
        chunk.forEach((aid) => batch.delete(doc(awardsCol, aid)));
        await batch.commit();
      }
    }

    const teamAwardsCol = collection(db, "answers", qid, "teamAwards");
    const teamAwardsSnap = await getDocs(teamAwardsCol);
    if (!teamAwardsSnap.empty) {
      const ids = teamAwardsSnap.docs.map((d) => d.id);
      while (ids.length) {
        const chunk = ids.splice(0, 400);
        const batch = writeBatch(db);
        chunk.forEach((tid) => batch.delete(doc(teamAwardsCol, tid)));
        await batch.commit();
      }
    }

    await deleteDoc(doc(answersCol, qid));
  }
}

/**
 * Attribution transactionnelle et idempotente des points pour une question.
 * Utilisé par Admin et Screen.
 */
export async function ensureAwardsForQuestionTx(db, qid) {
  if (!qid) return { ok: false, reason: "no-qid" };

  // 1) Lire toutes les bonnes réponses AVANT la transaction (pour obtenir la liste des IDs)
  const subsCol = collection(db, "answers", qid, "submissions");
  let submissionIds = [];
  
  try {
    const subsSnap = await getDocs(query(subsCol, where("isCorrect", "==", true)));
    submissionIds = subsSnap.docs.map(d => d.id);
  } catch (e) {
    console.error("[ensureAwardsForQuestionTx] read failed:", e);
    return { ok: false, reason: "read-failed" };
  }

  if (submissionIds.length === 0) {
    return { ok: true, reason: "no-correct-submissions" };
  }

  const table = await getScoringTable(db);
  const teamTable = await getTeamScoringTable(db);
  const qDocRef = doc(db, "answers", qid);
  const playersCol = collection(doc(db, "quiz", "state"), "players");
  const teamsCol = collection(doc(db, "quiz", "state"), "teams");
  const teamAwardsCol = collection(db, "answers", qid, "teamAwards");

  // 2) Transaction idempotente
  return await runTransaction(db, async (tx) => {
    // PHASE 1: TOUTES LES LECTURES (obligatoire avant les écritures)
    // NE PAS utiliser awarded comme garde-fou global car cela empêcherait l'attribution
    // de points aux nouveaux joueurs/équipes qui répondent après le premier appel
    const snap = await tx.get(qDocRef);

    // Recalculer ranked DANS la transaction en relisant chaque soumission individuellement
    // Cela garantit d'avoir les données les plus récentes et élimine les conditions de course
    const submissionSnaps = new Map();
    for (const pid of submissionIds) {
      const subRef = doc(subsCol, pid);
      submissionSnaps.set(pid, await tx.get(subRef));
    }

    // Trier par timestamp avec les données fraîches de la transaction
    const ranked = Array.from(submissionSnaps.entries())
      .filter(([pid, subSnap]) => {
        const data = subSnap.exists() ? subSnap.data() : {};
        return data.isCorrect === true;
      })
      .map(([pid, subSnap]) => {
        const data = subSnap.data() || {};
        const candidates = [
          toMs(data.firstCorrectAt),
          toMs(data.firstCorrectAtMs),
          toMs(data.createdAt),
          toMs(data.updatedAt),
        ];
        const t = Math.min(...candidates);
        return { id: pid, t };
      })
      .filter(x => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);

    if (ranked.length === 0) {
      return { ok: true, reason: "no-correct-submissions-in-tx" };
    }

    // Lire les équipes des joueurs DANS la transaction pour avoir les données les plus récentes
    const playerTeamMap = new Map(); // playerId -> teamId (pour référence rapide)
    for (let i = 0; i < ranked.length; i++) {
      const pid = ranked[i].id;
      const playerRef = doc(playersCol, pid);
      const playerSnap = await tx.get(playerRef);
      if (playerSnap.exists()) {
        const playerData = playerSnap.data();
        const teamId = playerData?.teamId;
        if (teamId) {
          playerTeamMap.set(pid, teamId);
        }
      }
    }

    // Lire tous les awards des joueurs (pour vérifier individuellement)
    const awardSnaps = new Map();
    for (let i = 0; i < ranked.length; i++) {
      const pid = ranked[i].id;
      const awardRef = doc(db, "answers", qid, "awards", pid);
      awardSnaps.set(pid, await tx.get(awardRef));
    }

    // Recalculer teamFirstPlayer DANS la transaction pour avoir les données les plus récentes
    // Cela permet de capturer tous les joueurs qui ont répondu, même s'ils ont répondu presque en même temps
    const teamFirstPlayer = new Map(); // teamId -> { playerId, rank }
    for (let i = 0; i < ranked.length; i++) {
      const pid = ranked[i].id;
      const teamId = playerTeamMap.get(pid);
      if (teamId) {
        // Identifier le premier joueur de chaque équipe (basé sur le rang dans ranked)
        if (!teamFirstPlayer.has(teamId)) {
          teamFirstPlayer.set(teamId, { playerId: pid, rank: i });
        }
      }
    }

    // Trier les équipes par l'ordre de leur premier joueur
    const sortedTeams = Array.from(teamFirstPlayer.entries())
      .sort((a, b) => a[1].rank - b[1].rank);
    
    // Assigner les rangs d'équipe
    const teamRank = new Map(); // teamId -> rank d'équipe (0-based)
    sortedTeams.forEach(([teamId], index) => {
      teamRank.set(teamId, index);
    });

    // Lire tous les awards d'équipe existants DANS la transaction (pour être sûr d'avoir les dernières données)
    const teamAwardSnaps = new Map();
    for (const [teamId] of teamFirstPlayer.entries()) {
      const teamAwardRef = doc(teamAwardsCol, teamId);
      teamAwardSnaps.set(teamId, await tx.get(teamAwardRef));
    }

    // Lire tous les documents d'équipe (seulement ceux qui n'ont pas encore reçu de points)
    const teamSnaps = new Map();
    for (const [teamId] of teamFirstPlayer.entries()) {
      const teamAwardSnap = teamAwardSnaps.get(teamId);
      if (teamAwardSnap && shouldSkipTeamFinalAward(teamAwardSnap, submissionSnaps, teamFirstPlayer.get(teamId))) {
        continue; // Déjà attribués dans cette passe ou en cours (optimiste)
      }
      const teamRef = doc(teamsCol, teamId);
      teamSnaps.set(teamId, await tx.get(teamRef));
    }

    // PHASE 2: TOUTES LES ÉCRITURES (après toutes les lectures)
    // Ne pas mettre awarded: true car cela empêcherait l'attribution de points
    // aux nouveaux joueurs/équipes qui répondent après. On vérifie individuellement
    // pour chaque joueur et chaque équipe s'ils ont déjà reçu des points.
    // On met juste à jour le compteur pour information
    const currentAwardedCount = snap.exists() ? (snap.data()?.awardedCount || 0) : 0;
    tx.set(qDocRef, {
      awardedCount: Math.max(currentAwardedCount, ranked.length),
      lastAwardedAt: serverTimestamp(),
    }, { merge: true });

    // Attribuer les points aux joueurs (utiliser la table de scoring joueurs : 20/19/18...)
    for (let i = 0; i < ranked.length; i++) {
      const pid = ranked[i].id;
      const points = table[i] ?? 0; // Table joueurs : 20, 19, 18, 17...
      const awardRef = doc(db, "answers", qid, "awards", pid);
      const awardSnap = awardSnaps.get(pid);

      // Vérifier si les points ont déjà été attribués (pour éviter le double comptage)
      if (awardSnap.exists()) {
        // Les points ont déjà été attribués par recordFirstCorrectAndPredict
        // IMPORTANT: Si les points prédits étaient incorrects (ancienne table), on doit les corriger
        const existingPoints = awardSnap.data()?.points || 0;
        if (existingPoints !== points) {
          // Les points ont changé (table mise à jour), corriger le score
          const diff = points - existingPoints;
          tx.set(awardRef, {
            points,
            rank: i + 1,
            awardedAt: serverTimestamp(),
          }, { merge: true });
          
          // Ajuster le score du joueur
          tx.set(doc(playersCol, pid), {
            score: increment(diff),
            lastDelta: points,
            lastDeltaForQuestionId: qid,
          }, { merge: true });
        } else {
          // Juste mettre à jour l'award avec les infos finales
          tx.set(awardRef, {
            points,
            rank: i + 1,
            awardedAt: serverTimestamp(),
          }, { merge: true });
        }
      } else {
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
    }

    // Attribuer les points équipe (indépendamment des points joueurs)
    // Utiliser la table de scoring équipe : 30/25/20/19/18...
    for (const [teamId, firstPlayerInfo] of teamFirstPlayer.entries()) {
      // Vérifier si les points équipe ont déjà été attribués pour cette équipe et cette question
      // Utiliser les données de la transaction pour être sûr d'avoir les dernières données
      const teamAwardSnap = teamAwardSnaps.get(teamId);
      if (shouldSkipTeamFinalAward(teamAwardSnap, submissionSnaps, firstPlayerInfo)) {
        continue; // Déjà attribués dans cette passe ou en cours (optimiste)
      }

      const teamRankIndex = teamRank.get(teamId) ?? 0;
      const teamPoints = teamTable[teamRankIndex] ?? 1; // Table équipe : 30, 25, 20, 19, 18...
      const teamRef = doc(teamsCol, teamId);
      
      // Vérifier que l'équipe existe (déjà lu dans la phase 1)
      const teamSnap = teamSnaps.get(teamId);
      if (!teamSnap) {
        // L'équipe n'a pas été lue dans la phase 1 - cela ne devrait pas arriver
        // mais si c'est le cas, on ne peut pas la lire maintenant (pas de nouvelles lectures après écritures)
        // On skip cette équipe pour éviter une erreur de transaction
        console.error(`[ensureAwardsForQuestionTx] Team ${teamId} was not read in phase 1, skipping team points`);
        continue;
      }
      
      if (!teamSnap.exists()) {
        // L'équipe n'existe plus dans Firestore
        console.error(`[ensureAwardsForQuestionTx] Team ${teamId} does not exist in Firestore, skipping team points`);
        continue;
      }

      // L'équipe existe, attribuer les points
      tx.set(teamRef, {
        teamQuizScore: increment(teamPoints),
        updatedAt: serverTimestamp(),
      }, { merge: true });

      // Marquer que les points équipe ont été attribués pour cette question
      const teamAwardRef = doc(teamAwardsCol, teamId);
      tx.set(teamAwardRef, {
        teamId,
        points: teamPoints,
        rank: teamRankIndex + 1,
        firstPlayerId: firstPlayerInfo.playerId,
        awardedAt: serverTimestamp(),
      }, { merge: true });
    }

    return { ok: true, reason: "awarded", count: ranked.length };
  });
}

// ============================= INSTANT WIN (Player) =============================

/**
 * Enregistre un mauvais choix QCM (une seule tentative — persiste après F5).
 */
export async function recordQcmWrongChoice({ db, qid, playerId, selectedIndex }) {
  if (!qid || !playerId) {
    throw new Error("[recordQcmWrongChoice] Missing qid or playerId");
  }
  const subRef = doc(db, "answers", qid, "submissions", playerId);
  await setDoc(
    subRef,
    {
      isCorrect: false,
      qcmFailed: true,
      qcmSelectedIndex: selectedIndex,
      answeredAt: serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
}

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
  const teamTable = await getTeamScoringTable(db);
  const qRef = doc(db, "answers", qid);
  const subRef = doc(db, "answers", qid, "submissions", playerId);
  const playerRef = doc(db, "quiz", "state", "players", playerId);
  const awardRef = doc(db, "answers", qid, "awards", playerId);
  const playersCol = collection(doc(db, "quiz", "state"), "players");
  const teamsCol = collection(doc(db, "quiz", "state"), "teams");
  const teamAwardsCol = collection(db, "answers", qid, "teamAwards");

  // Lire les soumissions correctes AVANT la transaction pour déterminer le rang d'équipe
  // (on ne peut pas utiliser getDocs dans une transaction)
  const subsCol = collection(db, "answers", qid, "submissions");
  let correctSubs = [];
  try {
    const subsSnap = await getDocs(query(subsCol, where("isCorrect", "==", true)));
    correctSubs = subsSnap.docs
      .map(d => ({ id: d.id, data: d.data() || {} }))
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
    
    // Ajouter la soumission actuelle au calcul (elle n'est pas encore dans la base)
    // On suppose qu'elle est la plus récente (timestamp actuel)
    const now = Date.now();
    correctSubs.push({ id: playerId, t: now });
    correctSubs.sort((a, b) => a.t - b.t);
  } catch (e) {
    console.error("[recordFirstCorrectAndPredict] Error reading submissions:", e);
    // En cas d'erreur, on suppose que c'est la première soumission
    correctSubs = [{ id: playerId, t: Date.now() }];
  }

  // Lire les équipes des joueurs qui ont répondu correctement
  const playerTeamMap = new Map();
  for (const sub of correctSubs) {
    const pid = sub.id;
    if (pid === playerId) {
      // Pour le joueur actuel, on lira l'équipe dans la transaction
      // On mettra à jour playerTeamMap après
      continue;
    }
    try {
      const playerRef = doc(playersCol, pid);
      const playerSnap = await getDoc(playerRef);
      if (playerSnap.exists()) {
        const playerData = playerSnap.data();
        const teamId = playerData?.teamId;
        if (teamId) {
          playerTeamMap.set(pid, teamId);
        }
      }
    } catch (e) {
      console.error(`[recordFirstCorrectAndPredict] Error reading player ${pid}:`, e);
    }
  }

  const result = await runTransaction(db, async (tx) => {
    // PHASE 1: TOUTES LES LECTURES (obligatoire avant les écritures)
    const subSnap = await tx.get(subRef);

    // Si déjà correct, retourner les valeurs existantes
    if (subSnap.exists() && subSnap.data().isCorrect) {
      const d = subSnap.data() || {};
      const predictedRank = d.predictedRank ?? null;
      const predictedPoints = d.predictedPoints ?? null;
      let teamPoints = null;
      let teamRank = null;
      const playerSnapExisting = await tx.get(playerRef);
      const existingTeamId = playerSnapExisting.exists()
        ? playerSnapExisting.data()?.teamId
        : null;
      if (existingTeamId) {
        const teamAwardSnapExisting = await tx.get(doc(teamAwardsCol, existingTeamId));
        if (teamAwardSnapExisting.exists()) {
          const ta = teamAwardSnapExisting.data() || {};
          teamPoints = Number.isFinite(ta.points) ? ta.points : null;
          teamRank = Number.isFinite(ta.rank) ? ta.rank : null;
        }
      }
      // Réconciliation équipe si award orphelin (ex. reset quiz sans purge teamAwards)
      ensureAwardsForQuestionTx(db, qid).catch((e) => {
        console.error("[recordFirstCorrectAndPredict] reconcile ensureAwards error:", e);
      });
      if (predictedRank != null && predictedPoints != null) {
        return { predictedRank, predictedPoints, teamPoints, teamRank };
      }
      return { predictedRank: 0, predictedPoints: 0, teamPoints, teamRank };
    }

    // Lire le compteur de la question
    const qSnap = await tx.get(qRef);
    const cur = qSnap.exists() ? (qSnap.data().correctCount || 0) : 0;
    const next = cur + 1;

    // Lire l'équipe du joueur (pour la mise à jour optimiste du score équipe)
    const playerSnap = await tx.get(playerRef);
    const playerData = playerSnap.exists() ? playerSnap.data() : {};
    const teamId = playerData?.teamId;

    // Lire les documents nécessaires pour la mise à jour optimiste du score équipe
    let teamAwardSnap = null;
    let teamSnap = null;
    if (teamId) {
      const teamAwardRef = doc(teamAwardsCol, teamId);
      teamAwardSnap = await tx.get(teamAwardRef);
      
      // Si les points équipe n'ont pas encore été attribués, lire l'équipe
      if (!shouldBlockTeamOptimisticAward(teamAwardSnap, subSnap)) {
        const teamRef = doc(teamsCol, teamId);
        teamSnap = await tx.get(teamRef);
      }
    }

    // PHASE 2: TOUTES LES ÉCRITURES (après toutes les lectures)
    const predictedRank = next;
    const predictedPoints = table[predictedRank - 1] ?? 0;

    // Enregistrer la soumission
    tx.set(subRef, {
      isCorrect: true,
      firstCorrectAt: serverTimestamp(),
      predictedRank,
      predictedPoints,
    }, { merge: true });

    // Mettre à jour le compteur
    tx.set(qRef, { correctCount: next }, { merge: true });

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

    // ===== MISE À JOUR OPTIMISTE DU SCORE ÉQUIPE =====
    let teamPoints = null;
    let teamRank = null;
    if (
      teamId
      && teamSnap
      && teamSnap.exists()
      && !shouldBlockTeamOptimisticAward(teamAwardSnap, subSnap)
    ) {
      // Ajouter l'équipe du joueur actuel au map
      playerTeamMap.set(playerId, teamId);

      // Recalculer teamFirstPlayer avec l'équipe du joueur actuel
      const teamFirstPlayer = new Map(); // teamId -> { playerId, rank }
      for (let i = 0; i < correctSubs.length; i++) {
        const pid = correctSubs[i].id;
        const tId = playerTeamMap.get(pid);
        if (tId) {
          if (!teamFirstPlayer.has(tId)) {
            teamFirstPlayer.set(tId, { playerId: pid, rank: i });
          }
        }
      }

      // Calculer le rang d'équipe prédit
      const sortedTeams = Array.from(teamFirstPlayer.entries())
        .sort((a, b) => a[1].rank - b[1].rank);

      // Vérifier si ce joueur est le premier de son équipe
      const firstPlayerInfo = teamFirstPlayer.get(teamId);
      if (firstPlayerInfo && firstPlayerInfo.playerId === playerId) {
        // Ce joueur est le premier de son équipe à répondre
        // Calculer le rang d'équipe prédit
        const teamRankIndex = sortedTeams.findIndex(([tId]) => tId === teamId);
        const predictedTeamPoints = teamTable[teamRankIndex] ?? 1;

        // Mettre à jour le score équipe de manière optimiste
        const teamRef = doc(teamsCol, teamId);
        tx.set(teamRef, {
          teamQuizScore: increment(predictedTeamPoints),
          updatedAt: serverTimestamp(),
        }, { merge: true });

        // Marquer que les points équipe ont été attribués (optimiste)
        const teamAwardRef = doc(teamAwardsCol, teamId);
        tx.set(teamAwardRef, {
          teamId,
          points: predictedTeamPoints,
          rank: teamRankIndex + 1,
          firstPlayerId: playerId,
          awardedAt: serverTimestamp(),
          isOptimistic: true, // Flag pour indiquer que c'est une mise à jour optimiste
        }, { merge: true });
        teamPoints = predictedTeamPoints;
        teamRank = teamRankIndex + 1;
      }
    }

    return { predictedRank, predictedPoints, teamPoints, teamRank };
  });

  // ===== PRIORITÉ 2 : Appeler ensureAwardsForQuestionTx en arrière-plan =====
  // Déclencher la transaction de vérification/correction en arrière-plan
  // Cela permet de corriger les scores si nécessaire (par exemple si plusieurs joueurs répondent en même temps)
  ensureAwardsForQuestionTx(db, qid).catch((e) => {
    // Erreur silencieuse - la transaction ensureAwardsForQuestionTx est idempotente
    // et corrigera les scores si nécessaire
    console.error("[recordFirstCorrectAndPredict] Background ensureAwardsForQuestionTx error:", e);
  });

  return result;
}

// ============================= ELEYBUZZ =============================

/**
 * Enregistre un buzz. Le premier commit serveur gagne (1 transaction, 1 RTT).
 * openSeq doit correspondre à buzzerOpenSeq courant (invalide les taps en retard).
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @param {number} openSeq - Numéro de session d'ouverture du buzzer
 * @returns {Promise<{ok: boolean, reason?: string, isFirst?: boolean}>}
 */
export async function registerBuzzerPress(db, playerId, openSeq) {
  if (!db || !playerId) {
    throw new Error("[registerBuzzerPress] Missing db or playerId");
  }
  if (!Number.isFinite(openSeq)) {
    return { ok: false, reason: "invalid-open-seq" };
  }

  const stateRef = doc(db, "quiz", "state");
  const playerRef = doc(db, "quiz", "state", "players", playerId);

  try {
    return await runTransaction(db, async (tx) => {
      const [playerSnap, stateSnap] = await Promise.all([
        tx.get(playerRef),
        tx.get(stateRef),
      ]);

      if (!playerSnap.exists()) {
        return { ok: false, reason: "player-not-found" };
      }

      const playerData = playerSnap.data() || {};
      if (playerData.canBuzz === false) {
        return { ok: false, reason: "player-cannot-buzz" };
      }

      if (!stateSnap.exists()) {
        throw new Error("[registerBuzzerPress] quiz/state does not exist");
      }

      const data = stateSnap.data() || {};

      if (data.buzzerState !== BUZZER_STATES.OPEN) {
        return { ok: false, reason: "buzzer-not-open" };
      }

      const serverOpenSeq = Number(data.buzzerOpenSeq) || 0;
      if (serverOpenSeq !== openSeq) {
        return { ok: false, reason: "stale-open-seq" };
      }

      if (data.firstPlayerId) {
        return { ok: false, reason: "already-taken" };
      }

      tx.update(stateRef, {
        buzzerState: BUZZER_STATES.LOCKED,
        firstPlayerId: playerId,
        buzzerPressedAt: serverTimestamp(),
      });

      return { ok: true, isFirst: true };
    });
  } catch (e) {
    console.error("[registerBuzzerPress] transaction failed:", e);
    return { ok: false, reason: "transaction-failed" };
  }
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
 * Débloque TOUS les joueurs pour une nouvelle manche EleyBuzz (y compris les punis).
 * @param {Object} db - Instance Firestore
 * @returns {Promise<void>}
 */
export async function unlockAllPlayersForNewRound(db) {
  if (!db) {
    throw new Error("[unlockAllPlayersForNewRound] Missing db");
  }

  const playersCol = collection(db, "quiz", "state", "players");
  const snap = await getDocs(playersCol);

  let batch = writeBatch(db);
  let count = 0;
  for (const d of snap.docs) {
    batch.update(doc(playersCol, d.id), {
      canBuzz: true,
      buzzerCooldownUntil: null,
      lastWrongPenalty: null,
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
}

/**
 * Ouvre le buzzer pour une nouvelle manche : tous les joueurs peuvent rebuzzer (bleus).
 * Invalide les taps en retard (buzzerOpenSeq) et remet wrongAnswerCount à zéro.
 * @param {Object} db - Instance Firestore
 * @returns {Promise<void>}
 */
export async function openBuzzerForNewRound(db) {
  if (!db) {
    throw new Error("[openBuzzerForNewRound] Missing db");
  }

  // Débloquer les joueurs AVANT d'ouvrir le buzzer (évite un flash rouge)
  await unlockAllPlayersForNewRound(db);

  const stateRef = doc(db, "quiz", "state");
  await updateDoc(stateRef, {
    buzzerState: BUZZER_STATES.OPEN,
    firstPlayerId: null,
    firstPlayerName: null,
    buzzerMessage: null,
    buzzerMessageType: null,
    wrongAnswerCount: 0,
    buzzerOpenSeq: increment(1),
  }, { merge: true });
}

/**
 * Réinitialise l'état du buzzer (pause IDLE ou réouverture simple sans reset joueurs).
 * @param {Object} db - Instance Firestore
 * @param {string} nextState - État suivant ("idle" ou "open"), défaut: "idle"
 * @returns {Promise<void>}
 */
export async function resetBuzzerState(db, nextState = BUZZER_STATES.IDLE) {
  if (!db) {
    throw new Error("[resetBuzzerState] Missing db");
  }

  const stateRef = doc(db, "quiz", "state");

  const updateData = {
    buzzerState: nextState,
    firstPlayerId: null,
    firstPlayerName: null,
    buzzerMessage: null,
    buzzerMessageType: null,
  };
  
  // Réinitialiser le compteur de mauvaises réponses à chaque pause (IDLE) ou nouvelle manche
  if (nextState === BUZZER_STATES.IDLE) {
    updateData.wrongAnswerCount = 0;
  }

  // Chaque ouverture du buzzer invalide les requêtes de buzz encore en vol
  if (nextState === BUZZER_STATES.OPEN) {
    updateData.buzzerOpenSeq = increment(1);
  }

  await updateDoc(stateRef, updateData, { merge: true });

  // Si on revient à IDLE (nouvelle question), débloquer tous les joueurs
  if (nextState === BUZZER_STATES.IDLE) {
    const playersCol = collection(db, "quiz", "state", "players");
    getDocs(playersCol).then(async (snap) => {
      let batch = writeBatch(db);
      let count = 0;
      for (const d of snap.docs) {
        batch.update(doc(playersCol, d.id), { 
          canBuzz: true,
          buzzerCooldownUntil: null,
          lastWrongPenalty: null,
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
      console.error("[resetBuzzerState] Failed to reset players:", e);
    });
  }
}

/**
 * Désactive le droit de buzzer d'un joueur (après une mauvaise réponse sur la manche en cours).
 * @param {Object} db - Instance Firestore
 * @param {string} playerId - ID du joueur
 * @returns {Promise<void>}
 */
export async function lockPlayerBuzz(db, playerId) {
  if (!db || !playerId) {
    throw new Error("[lockPlayerBuzz] Missing db or playerId");
  }

  const playerRef = doc(db, "quiz", "state", "players", playerId);
  // Verrouiller le joueur sans cooldown - il restera verrouillé jusqu'à la prochaine question
  await updateDoc(playerRef, { 
    canBuzz: false,
    buzzerCooldownUntil: null  // S'assurer qu'il n'y a pas de cooldown actif
  }, { merge: true });
}

/**
 * Réinitialise les locks des joueurs éligibles (sauf ceux exclus — ex. puni après un faux).
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

  let batch = writeBatch(db);
  let count = 0;
  for (const d of snap.docs) {
    if (!exceptSet.has(d.id)) {
      const playerData = d.data() || {};
      // Ne débloquer que les joueurs qui n'ont PAS déjà donné une mauvaise réponse
      // Si canBuzz est explicitement false, c'est qu'ils ont donné une mauvaise réponse et doivent rester verrouillés
      // On ne débloque que ceux qui ont canBuzz: true, undefined, ou null
      if (playerData.canBuzz !== false) {
        batch.update(doc(playersCol, d.id), { 
          canBuzz: true,
          buzzerCooldownUntil: null,
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
