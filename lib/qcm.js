// ============================================================================
// lib/qcm.js — Helpers QCM (4 propositions, une bonne réponse)
// ============================================================================

export const QUESTION_TYPE_OPEN = "open";
export const QUESTION_TYPE_QCM = "qcm";

export function getQuestionType(q) {
  return q?.questionType === QUESTION_TYPE_QCM ? QUESTION_TYPE_QCM : QUESTION_TYPE_OPEN;
}

export function isQcmQuestion(q) {
  return getQuestionType(q) === QUESTION_TYPE_QCM;
}

/** Normalise toujours 4 slots (strings trimées). */
export function normalizeQcmOptions(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const opts = src.map((s) => String(s ?? "").trim());
  while (opts.length < 4) opts.push("");
  return opts.slice(0, 4);
}

export function getQcmCorrectIndex(q) {
  const idx = Number(q?.qcmCorrectIndex);
  return Number.isInteger(idx) && idx >= 0 && idx <= 3 ? idx : 0;
}

export function getQcmOptionsForDisplay(q) {
  return normalizeQcmOptions(q?.qcmOptions);
}

/** `answers[0]` pour la révélation screen (bonne réponse seule). */
export function qcmAnswersFromOptions(options, correctIndex) {
  const opts = normalizeQcmOptions(options);
  const text = opts[correctIndex] || "";
  return text ? [text] : [];
}

export function validateQcmOptions(options, correctIndex) {
  const opts = normalizeQcmOptions(options);
  if (opts.some((t) => !t)) {
    return { ok: false, reason: "Les 4 propositions QCM doivent être renseignées." };
  }
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
    return { ok: false, reason: "Indiquez quelle proposition est la bonne réponse." };
  }
  if (!opts[correctIndex]) {
    return { ok: false, reason: "La proposition cochée comme bonne réponse est vide." };
  }
  return { ok: true, options: opts };
}

/** Mélange stable [0..3] par question + joueur (player uniquement). */
export function getShuffledQcmIndices(qid, playerId) {
  const indices = [0, 1, 2, 3];
  let h = 2166136261;
  const str = `${qid || ""}|${playerId || ""}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = indices.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h >>>= 0;
    const j = h % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}
