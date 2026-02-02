// ============================================================================
// lib/utils.js
// Fonctions utilitaires partagées (temps, normalisation, modération, etc.)
// ============================================================================

import { 
  DEFAULT_REVEAL_PHRASES, 
  PROFANITY, 
  POLITICS_TOKENS, 
  POLITICS_PHRASES, 
  POLITICS_PREFIX,
  NAME_ALLOWED_RE 
} from './constants';

// ============================= TEMPS & FORMATTING =============================

/**
 * Extrait le timecode en secondes d'une question (nouveau: timecodeSec, legacy: timecode en minutes)
 */
export function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec;
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60);
  return Infinity;
}

/**
 * Formatte un nombre de secondes en HH:MM:SS
 */
export function formatHMS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Parse une durée HH:MM:SS | MM:SS | SS en secondes
 */
export function parseHMS(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  if (s.includes(":")) {
    const parts = s.split(":").map((p) => p.trim());
    if (parts.length > 3) return null;

    const [hStr, mStr, sStr] =
      parts.length === 3 ? parts : ["0", parts[0] || "0", parts[1] || "0"];

    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const sec = parseInt(sStr, 10);

    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) {
      return null;
    }
    if (h < 0 || m < 0 || m >= 60 || sec < 0 || sec >= 60) return null;

    return h * 3600 + m * 60 + sec;
  }

  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Formatte des secondes en HH:MM:SS pour affichage dans un input
 */
export function formatHMSForInput(sec) {
  if (!Number.isFinite(sec)) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

// ============================= NORMALISATION =============================

/**
 * Normalisation unifiée avec options configurables
 * @param {string} s - Texte à normaliser
 * @param {Object} options - Options de normalisation
 * @param {boolean} options.removeAccents - Supprimer les accents (défaut: true)
 * @param {boolean} options.toLowerCase - Convertir en minuscules (défaut: true)
 * @param {boolean} options.collapseSpaces - Réduire espaces multiples en un seul (défaut: true)
 * @param {boolean} options.trim - Supprimer espaces début/fin (défaut: true)
 * @param {string} options.spaceReplacement - Remplacement pour espaces (défaut: " " ou "" si trim uniquement)
 * @returns {string} Texte normalisé
 */
export function normalize(s, options = {}) {
  const {
    removeAccents = true,
    toLowerCase = true,
    collapseSpaces = true,
    trim = true,
    spaceReplacement = " "
  } = options;

  let result = String(s || "");

  // Supprimer les accents
  if (removeAccents) {
    result = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  // Convertir en minuscules
  if (toLowerCase) {
    result = result.toLowerCase();
  }

  // Réduire espaces multiples
  if (collapseSpaces) {
    result = result.replace(/\s+/g, spaceReplacement);
  }

  // Trim
  if (trim) {
    result = result.trim();
  }

  return result;
}

/**
 * Normalisation basique (accents + casse + espaces)
 * @deprecated Utiliser normalize() à la place
 */
export function normalizeBasic(s) {
  return normalize(s);
}

/**
 * Normalisation pour tri alphabétique (leaderboard)
 * @deprecated Utiliser normalize() à la place
 */
export function normalizeNameAlpha(s) {
  return normalize(s);
}

/**
 * Normalisation pour unicité/comparaison de noms
 * @deprecated Utiliser normalize() à la place
 */
export function normalizeName(s) {
  return normalize(s);
}

/**
 * Normalisation pour clé admin (utilisée dans admin.js)
 * @deprecated Utiliser normalize() à la place
 */
export function normKey(s) {
  return normalize(s);
}

// ============================= MANCHES =============================

/**
 * Trouve l'index de la manche courante pour un temps donné
 */
export function roundIndexOfTime(t, offsets) {
  if (!Array.isArray(offsets)) return 0;
  let idx = -1;
  for (let i = 0; i < offsets.length; i++) {
    const v = offsets[i];
    if (typeof v === "number" && t >= v) idx = i;
  }
  return Math.max(0, idx);
}

/**
 * Trouve le prochain début de manche après le temps t
 */
export function nextRoundStartAfter(t, offsets) {
  if (!Array.isArray(offsets)) return null;
  for (let i = 0; i < offsets.length; i++) {
    const v = offsets[i];
    if (typeof v === "number" && v > t) return v;
  }
  return null;
}

// ============================= RÉVÉLATION =============================

/**
 * Choisit une phrase de révélation (déterministe par question)
 */
export function pickRevealPhrase(q) {
  const custom = Array.isArray(q?.revealPhrases)
    ? q.revealPhrases.filter((p) => typeof p === "string" && p.trim() !== "")
    : [];
  const pool = custom.length ? custom : DEFAULT_REVEAL_PHRASES;
  if (!pool.length) return "Réponse :";
  
  const seedStr = String(q?.id || "");
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  return pool[hash % pool.length];
}

// ============================= VALIDATION RÉPONSES =============================

/**
 * Distance de Levenshtein (édition entre deux chaînes)
 */
export function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Vérifie si deux chaînes sont proches (distance <= tolerance)
 */
export function isCloseEnough(input, expected, tolerance = 2) {
  return levenshteinDistance(input, expected) <= tolerance;
}

/**
 * Détecte si une chaîne est purement numérique
 */
export function isNumericString(s) {
  return /^[0-9]+$/.test(String(s || ""));
}

/**
 * Récupère le mode de matching pour une question
 */
export function getAnswerMode(q) {
  return q?.answerMode || q?.matchMode || "relaxed";
}

/**
 * Vérifie si une réponse match selon le mode (strict/relaxed/numeric)
 */
export function matchesWithMode(inputRaw, expectedRaw, mode = "relaxed") {
  const inNorm = normalizeBasic(inputRaw);
  const exNorm = normalizeBasic(expectedRaw);

  if (mode === "numeric") {
    const inDigits = String(inputRaw ?? "").replace(/\s+/g, "");
    const exDigits = String(expectedRaw ?? "").replace(/\s+/g, "");

    const exIsNum = isNumericString(exDigits);
    const inIsNum = isNumericString(inDigits);

    if (exIsNum && inIsNum) {
      return Number(inDigits) === Number(exDigits);
    }
    if (!exIsNum) {
      return inNorm === exNorm;
    }
    return false;
  }

  if (mode === "strict") {
    return inNorm === exNorm;
  }

  // "relaxed"
  if (inNorm === exNorm) return true;

  const bothNumeric = isNumericString(inNorm) && isNumericString(exNorm);
  if (bothNumeric) return false;

  if (exNorm.length <= 4) return false;

  const tol = Math.max(1, Math.floor(exNorm.length / 3));
  return isCloseEnough(inNorm, exNorm, tol);
}

// ============================= MODÉRATION NOMS =============================

/**
 * Détecte si un nom est un alias auto-généré "Player N"
 */
export function isAliasName(raw) {
  return /^player\s*\d+$/i.test(String(raw || "").trim());
}

/**
 * Normalisation agressive pour modération (leetspeak + répétitions)
 */
export function normalizeForModeration(s) {
  let t = (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // Leetspeak (remplace seulement les chiffres/symboles, PAS les lettres normales)
  t = t
    .replace(/[@]/g, "a")
    .replace(/[$]/g, "s")
    .replace(/[€]/g, "e")
    .replace(/[0]/g, "o")
    .replace(/[1]/g, "i")  // Seulement le chiffre 1, pas la lettre l
    .replace(/[3]/g, "e")
    .replace(/[4]/g, "a")
    .replace(/[5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[+]/g, "t");

  t = t.replace(/[^a-z0-9]+/g, " ");
  t = t.replace(/([a-z0-9])\1{2,}/g, "$1$1"); // répétitions

  return t.replace(/\s+/g, " ").trim();
}

/**
 * Vérifie si un nom doit être modéré (retourne "moderation" | "politics" | null)
 */
export function moderationReason(raw) {
  if (!raw || typeof raw !== "string") return null;
  
  const norm = normalizeForModeration(raw);
  if (!norm) return null;
  
  const tokens = norm.split(" ").filter(t => t.length > 0);
  if (tokens.length === 0) return null;
  
  const joined = ` ${tokens.join(" ")} `;

  // Profanités - vérification directe
  try {
    if (PROFANITY && typeof PROFANITY.has === "function") {
      for (const t of tokens) {
        if (t && PROFANITY.has(t)) {
          return "moderation";
        }
      }
    }
  } catch (e) {
    console.error("[moderationReason] Erreur lors de la vérification PROFANITY:", e);
  }

  // Phrases politiques
  try {
    if (Array.isArray(POLITICS_PHRASES) && POLITICS_PHRASES.length > 0) {
      for (const phrase of POLITICS_PHRASES) {
        if (typeof phrase === "string" && phrase.trim() && joined.includes(` ${phrase.trim()} `)) {
          return "politics";
        }
      }
    }
  } catch (e) {
    console.error("[moderationReason] Erreur lors de la vérification POLITICS_PHRASES:", e);
  }

  // Mots politiques
  try {
    if (POLITICS_TOKENS && typeof POLITICS_TOKENS.has === "function") {
      const hasPoliticalWord = tokens.some((t) => t && POLITICS_TOKENS.has(t));
      if (hasPoliticalWord) {
        // Combinaisons préfixe + politique
        if (POLITICS_PREFIX && typeof POLITICS_PREFIX.has === "function") {
          const hasPrefix = tokens.some((t) => t && POLITICS_PREFIX.has(t));
          if (hasPrefix) {
            return "politics";
          }
        }
        return "politics";
      }
    }
  } catch (e) {
    console.error("[moderationReason] Erreur lors de la vérification POLITICS_TOKENS:", e);
  }

  return null;
}

/**
 * Validation globale d'un nom (charset + longueur + modération)
 */
export function validateName(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "empty" };

  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > 30) {
    return { ok: false, reason: "length" };
  }
  if (!NAME_ALLOWED_RE.test(cleaned)) {
    return { ok: false, reason: "charset" };
  }

  // Vérification de modération
  const mod = moderationReason(cleaned);
  if (mod) {
    return { ok: false, reason: mod };
  }

  return { ok: true, value: cleaned };
}

/**
 * Validation du nom d'équipe (max 20 caractères, conversion en majuscules)
 */
export function validateTeamName(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "empty" };

  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > 20) {
    return { ok: false, reason: "length" };
  }
  if (!NAME_ALLOWED_RE.test(cleaned)) {
    return { ok: false, reason: "charset" };
  }

  // Vérification de modération
  const mod = moderationReason(cleaned);
  if (mod) {
    return { ok: false, reason: mod };
  }

  // Conversion en majuscules
  const upperCased = cleaned.toUpperCase();

  return { ok: true, value: upperCased };
}

/**
 * Normalisation du nom d'équipe pour recherche/unicité (majuscules + normalisation)
 */
export function normalizeTeamName(s) {
  if (!s || typeof s !== "string") return "";
  // Convertir en majuscules puis normaliser
  return normalize(s.toUpperCase());
}

// ============================= CLASSEMENT =============================

/**
 * Message de fin personnalisé selon le rang
 */
export function messageForRank(rank) {
  if (rank === 1) return "Quel talent, tu es premier !";
  if (rank === 2) return "Félicitations, tu termines second !";
  if (rank === 3) return "Bravo, tu es 3e avec un très beau score !";
  if (rank === 4) return "Bravo, tu finis quatrième, si proche du podium !";
  if (Number.isInteger(rank)) {
    return `C'était le Quiz d'Eley. Tu finis à la ${rank}ᵉ place. Merci pour ta participation !`;
  }
  return "Merci pour ta participation !";
}

/**
 * Message de classement pour Final Score (format simple)
 */
export function finalScoreMessageForRank(rank, score) {
  if (Number(score) <= 0) return "Tu es dernier dans le classement";
  if (rank === 1) return "Tu es 1er dans le classement";
  if (rank === 2) return "Tu es 2ème dans le classement";
  if (rank === 3) return "Tu es 3ème dans le classement";
  if (Number.isInteger(rank)) {
    return `Tu es ${rank}ème dans le classement`;
  }
  return "Tu es dans le classement";
}

/**
 * Emoji médaille selon le rang
 */
export function medalForRank(rank) {
  return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "";
}

// ============================= MOBILE =============================

/**
 * Détection iOS/iPadOS (y compris mode "desktop")
 */
export const IS_IOS = (() => {
  if (typeof navigator === 'undefined') return false;
  try {
    const ua = navigator.userAgent || "";
    const isIOSDevice = /iPad|iPhone|iPod/.test(ua);
    const isTouchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return isIOSDevice || isTouchMac;
  } catch {
    return false;
  }
})();

// ============================= DIVERS =============================

/**
 * Parse CSV simple (split sur virgules)
 */
export function parseCSV(input = "") {
  return String(input)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Convertit un tableau en CSV
 */
export function toCSV(list = []) {
  return (list || []).join(", ");
}

/**
 * Clamp une durée musicale selon les contraintes
 */
export function clampTimeMusicSec(sec, minSec = 20, defaultSec = 35) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return defaultSec;
  return Math.max(minSec, Math.floor(n));
}

/**
 * Choisit une couleur différente de la précédente (joueurs Admin)
 */
export function pickColorDifferent(prev, colors) {
  const pool = colors.filter((c) => c !== prev);
  const bag = pool.length ? pool : colors;
  return bag[Math.floor(Math.random() * bag.length)];
}

/**
 * Protège les sigles (ex: "B.O.", "U.S.A.") avec une balise span nowrap
 * @param {string} text - Texte contenant potentiellement des sigles
 * @returns {Object} { text: string avec placeholders, sigles: Array des sigles protégés }
 */
function protectAcronyms(text) {
  const siglePlaceholder = "___SIGLE_PUNCT___";
  const siglePlaceholder2 = "___SIGLE___";
  const siglesWithPunct = [];
  const sigles = [];
  let sigleCounter = 0;
  let sigleCounter2 = 0;
  
  // Protéger les sigles suivis de ? ou ! (ex: "B.O. ?", "U.S.A. !")
  let result = text.replace(/([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ](?:\.[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])+\.)\s*([!?])/g, (match, sigle, punct) => {
    const placeholder = `${siglePlaceholder}${sigleCounter}___`;
    siglesWithPunct[sigleCounter] = `<span style="white-space:nowrap">${sigle}</span> ${punct}`;
    sigleCounter++;
    return placeholder;
  });
  
  // Protéger les sigles seuls (sans ponctuation finale)
  result = result.replace(/([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ](?:\.[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])+\.)(?![!?])/g, (match) => {
    const placeholder = `${siglePlaceholder2}${sigleCounter2}___`;
    sigles[sigleCounter2] = `<span style="white-space:nowrap">${match}</span>`;
    sigleCounter2++;
    return placeholder;
  });
  
  return { text: result, siglesWithPunct, sigles };
}

/**
 * Restaure les sigles protégés dans le texte
 * @param {string} text - Texte avec placeholders
 * @param {Array} siglesWithPunct - Sigles avec ponctuation
 * @param {Array} sigles - Sigles sans ponctuation
 * @returns {string} Texte avec sigles restaurés
 */
function restoreAcronyms(text, siglesWithPunct, sigles) {
  let result = text;
  
  siglesWithPunct.forEach((item, index) => {
    result = result.replace(`___SIGLE_PUNCT___${index}___`, item);
  });
  
  sigles.forEach((sigle, index) => {
    result = result.replace(`___SIGLE___${index}___`, sigle);
  });
  
  return result;
}

/**
 * Ajoute des espaces insécables après les déterminants
 * @param {string} text - Texte à traiter
 * @returns {string} Texte avec espaces insécables
 */
function addNonBreakingSpacesAfterDeterminers(text) {
  const determiners = [
    "cette", "ce", "ces", "les", "la", "le", "un", "une", "des", "du", "de",
    "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
    "notre", "nos", "votre", "vos", "leur", "leurs",
    "quel", "quelle", "quels", "quelles"
  ];
  
  let result = text;
  determiners.forEach(det => {
    const regex = new RegExp(`\\b${det}\\s+([a-zàâäéèêëïîôùûüÿç]+)`, "gi");
    result = result.replace(regex, (match, noun) => {
      if (noun.length > 15) return match;
      return `${det}&nbsp;${noun}`;
    });
  });
  
  return result;
}

/**
 * Ajoute des espaces insécables après prépositions + déterminants
 * @param {string} text - Texte à traiter
 * @returns {string} Texte avec espaces insécables
 */
function addNonBreakingSpacesAfterPrepositions(text) {
  const prepositions = ["dans", "sur", "sous", "avec", "sans", "pour", "par", "vers", "chez", "entre", "parmi", "pendant", "durant", "depuis", "jusqu'à", "jusqu'", "de", "du", "des"];
  const determiners = ["cette", "ce", "ces", "les", "la", "le", "un", "une", "des", "du", "de", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos", "leur", "leurs", "quel", "quelle", "quels", "quelles"];
  
  let result = text;
  prepositions.forEach(prep => {
    determiners.forEach(det => {
      const regex = new RegExp(`\\b${prep}\\s+${det}\\s+`, "gi");
      result = result.replace(regex, `${prep}&nbsp;${det}&nbsp;`);
    });
  });
  
  // Prépositions + nom propre
  result = result.replace(/\b(dans|sur|sous|avec|sans|pour|par|vers|chez|entre|parmi|pendant|durant|depuis|de|du|des|à|au|aux)\s+([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ][a-zàâäéèêëïîôùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ][a-zàâäéèêëïîôùûüÿç]+)*)/g, "$1&nbsp;$2");
  
  return result;
}

/**
 * Ajoute des espaces insécables pour groupes courts (adj + nom, qui + verbe, etc.)
 * @param {string} text - Texte à traiter
 * @returns {string} Texte avec espaces insécables
 */
function addNonBreakingSpacesForShortGroups(text) {
  let result = text;
  
  // Adjectifs courts + nom
  result = result.replace(/\b([a-zàâäéèêëïîôùûüÿç]{2,8})\s+([a-zàâäéèêëïîôùûüÿç]{2,10})\b/gi, (match, adj, noun) => {
    if (match.length < 15) {
      return `${adj}&nbsp;${noun}`;
    }
    return match;
  });
  
  // Groupes verbe + complément court
  result = result.replace(/\b(qui|que|quoi|où|quand|comment|pourquoi)\s+([a-zàâäéèêëïîôùûüÿç]{2,10})\b/gi, (match, word, verb) => {
    if (match.length < 15) {
      return `${word}&nbsp;${verb}`;
    }
    return match;
  });
  
  return result;
}

/**
 * Remplace les tirets par des tirets insécables dans les mots composés
 * @param {string} text - Texte à traiter
 * @returns {string} Texte avec tirets insécables
 */
function replaceHyphensWithNonBreaking(text) {
  return text.replace(/\b([a-zàâäéèêëïîôùûüÿç]+)-([a-zàâäéèêëïîôùûüÿç]+(?:-[a-zàâäéèêëïîôùûüÿç]+)*)\b/gi, (match) => {
    return match.replace(/-/g, "&#8209;");
  });
}

/**
 * Ajoute des opportunités de césure intelligentes pour améliorer les retours à la ligne
 * Utilise des espaces insécables (&nbsp;) pour garder ensemble les petits groupes de mots cohérents
 * Retourne du HTML avec des espaces insécables aux bons endroits
 */
export function addSmartLineBreaks(text) {
  if (!text || typeof text !== "string") return text;
  
  // Protéger les sigles (ex: "B.O.", "U.S.A.")
  const { text: protectedText, siglesWithPunct, sigles } = protectAcronyms(text);
  
  let result = protectedText;
  
  // Appliquer les différentes transformations
  result = addNonBreakingSpacesAfterDeterminers(result);
  result = addNonBreakingSpacesAfterPrepositions(result);
  result = addNonBreakingSpacesForShortGroups(result);
  result = replaceHyphensWithNonBreaking(result);
  
  // Ajouter <br> après les points d'exclamation et d'interrogation
  result = result.replace(/([!?])\s*/g, "$1<br>");
  
  // Restaurer les sigles
  result = restoreAcronyms(result, siglesWithPunct, sigles);
  
  return result;
}

