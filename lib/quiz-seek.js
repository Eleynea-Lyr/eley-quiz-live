// ============================================================================
// lib/quiz-seek.js — Transport Admin style Studio One
//
// Contrat :
//   • Seek Back/Next = UNIQUEMENT timecodeSec des questions (jamais timeMusic,
//     jamais roundOffsetsSec comme destination).
//   • roundOffsetsSec = annotation seule (isFirstOfRound, labels « Manche N »).
//   • Back :
//       - entre deux marqueurs (pas au début) → snap au marqueur courant
//       - déjà au début (pause mid-question déjà snappée, ou après Next/Back)
//         → marqueur précédent en UN clic
// ============================================================================

/** Tolérance « au début du marqueur » sur l’elapsed brut. */
export const MARKER_AT_START_EPS_SEC = 0.35;

/** Tolérance si on vient de seek (parkedSec) — timestamps Firestore / floor. */
export const MARKER_PARKED_EPS_SEC = 1.25;

/** @typedef {{
 *   sec: number,
 *   kind: 'question',
 *   roundIndex: number,
 *   isFirstOfRound: boolean
 * }} QuizMarker */

export function sortedQuestionTimes(plannedTimes) {
  return (Array.isArray(plannedTimes) ? plannedTimes : [])
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .slice()
    .sort((a, b) => a - b);
}

function roundIndexForSec(sec, roundOffsetsSec) {
  const rounds = Array.isArray(roundOffsetsSec) ? roundOffsetsSec : [];
  let idx = 0;
  let found = false;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (typeof r === "number" && Number.isFinite(r) && r <= sec) {
      idx = i;
      found = true;
    }
  }
  return found ? idx : 0;
}

/** Une entrée par question (timecodeSec). */
export function buildQuizMarkers(plannedTimes, roundOffsetsSec) {
  const qTimes = sortedQuestionTimes(plannedTimes);
  /** @type {QuizMarker[]} */
  const markers = [];

  for (const sec of qTimes) {
    const roundIndex = roundIndexForSec(sec, roundOffsetsSec);
    const prev = markers[markers.length - 1];
    const isFirstOfRound = !prev || prev.roundIndex !== roundIndex;
    markers.push({
      sec,
      kind: "question",
      roundIndex,
      isFirstOfRound,
    });
  }

  return markers;
}

export function currentMarkerIndex(elapsedSec, markers) {
  const t = Number(elapsedSec) || 0;
  let idx = -1;
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].sec <= t) idx = i;
  }
  return idx;
}

export function currentMarkerAt(elapsedSec, markers) {
  const idx = currentMarkerIndex(elapsedSec, markers);
  return idx >= 0 ? markers[idx] : null;
}

export function isAtMarkerStart(elapsedSec, marker, eps = MARKER_AT_START_EPS_SEC) {
  if (!marker) return false;
  return (Number(elapsedSec) || 0) <= marker.sec + eps;
}

/**
 * Déjà posé sur le début du marqueur courant ?
 * - elapsed ≈ marker.sec, ou
 * - parkedSec (dernier seek Back/Next) ≈ marker courant
 */
export function isParkedOnCurrentMarker(elapsedSec, marker, parkedSec) {
  if (!marker) return false;
  if (isAtMarkerStart(elapsedSec, marker)) return true;
  if (parkedSec == null || !Number.isFinite(parkedSec)) return false;
  const t = Number(elapsedSec) || 0;
  return (
    Math.abs(parkedSec - marker.sec) <= MARKER_PARKED_EPS_SEC &&
    Math.abs(t - marker.sec) <= MARKER_PARKED_EPS_SEC
  );
}

/**
 * Back Studio One :
 * - pas au début du marqueur courant → ce marqueur (snap)
 * - déjà au début → marqueur précédent (y compris 1ère Q de manche)
 */
export function resolveBackMarker(elapsedSec, markers, opts = {}) {
  if (!markers?.length) return null;
  const t = Number(elapsedSec) || 0;
  const idx = currentMarkerIndex(t, markers);
  if (idx < 0) return markers[0];
  const current = markers[idx];

  if (!isParkedOnCurrentMarker(t, current, opts.parkedSec)) {
    return current;
  }
  if (idx > 0) return markers[idx - 1];
  return current;
}

export function resolveNextMarker(elapsedSec, markers) {
  if (!markers?.length) return null;
  const t = Number(elapsedSec) || 0;
  return markers.find((m) => m.sec > t) || null;
}

/** 1ère question d'une manche (reprise après fin de manche). */
export function firstMarkerOfRound(markers, roundIndex) {
  if (!markers?.length || !Number.isInteger(roundIndex)) return null;
  return (
    markers.find((m) => m.roundIndex === roundIndex && m.isFirstOfRound) ||
    markers.find((m) => m.roundIndex === roundIndex) ||
    null
  );
}

/**
 * @returns {{ seekSec: number|null }}
 */
export function planBackSeek(elapsedSec, markers, parkedSec = null) {
  if (!markers?.length) return { seekSec: null };
  const target = resolveBackMarker(elapsedSec, markers, { parkedSec });
  return { seekSec: target?.sec ?? null };
}

function labelBack(marker, current) {
  if (!marker?.isFirstOfRound) return "Back";
  if (current?.isFirstOfRound && current.sec === marker.sec) {
    return `Manche ${marker.roundIndex + 1}`;
  }
  if (current && current.roundIndex > marker.roundIndex) {
    return `Manche ${marker.roundIndex + 1}`;
  }
  return "Back";
}

function labelNext(marker) {
  if (!marker) return "Fin de quiz";
  if (marker.isFirstOfRound) return `Manche ${marker.roundIndex + 1}`;
  return "Next";
}

/**
 * Labels UI Admin.
 * Back sur 1ère Q de manche = identité « Manche N » (où l’on est).
 * Next sans cible = « Fin de quiz ».
 */
export function getTransportUi(elapsedSec, markers, parkedSec = null) {
  const current = currentMarkerAt(elapsedSec, markers);
  const beforeFirst = !current && markers[0] ? markers[0] : null;

  const identity =
    current?.isFirstOfRound
      ? current
      : beforeFirst?.isFirstOfRound
        ? beforeFirst
        : null;

  const backTarget = resolveBackMarker(elapsedSec, markers, { parkedSec });
  const nextTarget = resolveNextMarker(elapsedSec, markers);

  const backLabel = identity
    ? `Manche ${identity.roundIndex + 1}`
    : labelBack(backTarget, current);
  const nextLabel = labelNext(nextTarget);

  const backRoundIndex = backLabel.startsWith("Manche")
    ? (identity || backTarget)?.roundIndex ?? null
    : null;
  const nextRoundIndex =
    nextLabel.startsWith("Manche") && nextTarget
      ? nextTarget.roundIndex
      : null;

  return {
    current,
    backTarget,
    nextTarget,
    backLabel,
    nextLabel,
    backRoundIndex,
    nextRoundIndex,
  };
}

// --- Compat / helpers divers -------------------------------------------------

export function currentRoundIndexFromElapsed(elapsedSec, roundOffsetsSec) {
  return roundIndexForSec(Number(elapsedSec) || 0, roundOffsetsSec);
}

export function isOnFirstOfRoundQuestion(elapsedSec, markers) {
  return !!currentMarkerAt(elapsedSec, markers)?.isFirstOfRound;
}

export function isAtFirstOfRoundStart(elapsedSec, markers) {
  const m = currentMarkerAt(elapsedSec, markers);
  return !!m?.isFirstOfRound && isAtMarkerStart(elapsedSec, m);
}

export function labelForNavMarker(marker, fallback, ctx = {}) {
  if (!marker) return fallback === "Next" ? "Fin de quiz" : fallback;
  if (ctx.dir === "back") return labelBack(marker, ctx.currentMarker) || fallback;
  const n = labelNext(marker);
  return n === "Fin de quiz" ? fallback : n;
}

export function labelForMarker(marker, fallback) {
  if (!marker) return fallback;
  return labelNext(marker);
}

export function isAtRoundMarkerStart(elapsedSec, markers) {
  return isAtFirstOfRoundStart(elapsedSec, markers);
}

export function resolveBackSeekSec(elapsedSec, plannedTimes) {
  return resolveBackMarker(elapsedSec, buildQuizMarkers(plannedTimes, []))?.sec ?? null;
}

export function resolveNextSeekSec(elapsedSec, plannedTimes) {
  return resolveNextMarker(elapsedSec, buildQuizMarkers(plannedTimes, []))?.sec ?? null;
}

export function currentQuestionIndex(elapsedSec, plannedTimes) {
  const times = sortedQuestionTimes(plannedTimes);
  let idx = -1;
  const t = Number(elapsedSec) || 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= t) idx = i;
  }
  return idx;
}

export const REMOTE_ACTIONS = ["start", "pause", "back", "next"];

export function makeStreamDeckSecret() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 20; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
