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
 * Normalisation basique (accents + casse + espaces)
 */
export function normalizeBasic(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalisation pour tri alphabétique (leaderboard)
 */
export function normalizeNameAlpha(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalisation pour unicité/comparaison de noms
 */
export function normalizeName(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalisation pour clé admin (utilisée dans admin.js)
 */
export function normKey(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
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
 * Normalise un texte pour recherche (utilisé dans admin.js)
 */
export function normalize(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Ajoute des opportunités de césure intelligentes pour améliorer les retours à la ligne
 * Utilise des espaces insécables (&nbsp;) pour garder ensemble les petits groupes de mots cohérents
 * Retourne du HTML avec des espaces insécables aux bons endroits
 */
export function addSmartLineBreaks(text) {
  if (!text || typeof text !== "string") return text;
  
  let result = text;
  
  // 1. Articles/déterminants + nom : garder ensemble avec espace insécable
  // Ex: "cette musique" → "cette&nbsp;musique"
  // Ex: "le film", "la trilogie", "un acteur", etc.
  const determiners = [
    "cette", "ce", "ces", "les", "la", "le", "un", "une", "des", "du", "de",
    "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
    "notre", "nos", "votre", "vos", "leur", "leurs",
    "quel", "quelle", "quels", "quelles", "quelle"
  ];
  
  determiners.forEach(det => {
    // Remplacer "déterminant + espace + nom" par "déterminant&nbsp;nom"
    const regex = new RegExp(`\\b${det}\\s+([a-zàâäéèêëïîôùûüÿç]+)`, "gi");
    result = result.replace(regex, (match, noun) => {
      // Ne pas appliquer si le nom est trop long (plus de 15 caractères)
      if (noun.length > 15) return match;
      return `${det}&nbsp;${noun}`;
    });
  });
  
  // 2. Prépositions + article/déterminant : garder ensemble
  // Ex: "dans cette", "par le", "de la", etc.
  const prepositions = ["dans", "sur", "sous", "avec", "sans", "pour", "par", "vers", "chez", "entre", "parmi", "pendant", "durant", "depuis", "jusqu'à", "jusqu'", "de", "du", "des"];
  prepositions.forEach(prep => {
    determiners.forEach(det => {
      const regex = new RegExp(`\\b${prep}\\s+${det}\\s+`, "gi");
      result = result.replace(regex, `${prep}&nbsp;${det}&nbsp;`);
    });
  });
  
  // 3. Prépositions + nom propre (majuscule) : garder ensemble
  // Ex: "par Tim", "de France", "à Paris", etc.
  result = result.replace(/\b(dans|sur|sous|avec|sans|pour|par|vers|chez|entre|parmi|pendant|durant|depuis|de|du|des|à|au|aux)\s+([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ][a-zàâäéèêëïîôùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ][a-zàâäéèêëïîôùûüÿç]+)*)/g, "$1&nbsp;$2");
  
  // 4. Adjectifs courts + nom : garder ensemble si le groupe fait moins de 15 caractères
  // Ex: "double face", "grand écran", "petit film"
  result = result.replace(/\b([a-zàâäéèêëïîôùûüÿç]{2,8})\s+([a-zàâäéèêëïîôùûüÿç]{2,10})\b/gi, (match, adj, noun) => {
    // Si le groupe complet fait moins de 15 caractères, garder ensemble
    if (match.length < 15) {
      return `${adj}&nbsp;${noun}`;
    }
    return match;
  });
  
  // 5. Groupes verbe + complément court : "qui joue", "qui produit"
  result = result.replace(/\b(qui|que|quoi|où|quand|comment|pourquoi)\s+([a-zàâäéèêëïîôùûüÿç]{2,10})\b/gi, (match, word, verb) => {
    if (match.length < 15) {
      return `${word}&nbsp;${verb}`;
    }
    return match;
  });
  
  // 6. Mots avec tirets : remplacer les tirets par des tirets insécables pour éviter la coupure
  // Ex: "donne-t-on" → "donne&#8209;t&#8209;on" (le tiret insécable empêche la coupure)
  // On détecte les mots avec tirets entourés de lettres (pas de tirets entre les mots)
  result = result.replace(/\b([a-zàâäéèêëïîôùûüÿç]+)-([a-zàâäéèêëïîôùûüÿç]+(?:-[a-zàâäéèêëïîôùûüÿç]+)*)\b/gi, (match) => {
    // Remplacer tous les tirets dans ce mot par des tirets insécables
    return match.replace(/-/g, "&#8209;");
  });
  
  // 7. Points d'exclamation et d'interrogation : aller à la ligne après
  // Exception : ne pas aller à la ligne si c'est un sigle suivi de ? ou !
  // Ex: "Qui est-ce ?" → "Qui est-ce ?<br>"
  // Ex: "B.O. ?" → "<span style='white-space:nowrap'>B.O.</span> ?" (pas de retour à la ligne dans le sigle)
  // Ex: "O.N.U." → "<span style='white-space:nowrap'>O.N.U.</span>" (pas de retour à la ligne)
  
  // D'abord, protéger les sigles complets (avec point final) suivis d'un espace optionnel et d'un ? ou !
  // On enveloppe les sigles dans des balises <span> avec white-space:nowrap pour empêcher la coupure CSS
  const siglePlaceholder = "___SIGLE_PUNCT___";
  const siglesWithPunct = [];
  let sigleCounter = 0;
  
  // Protéger les sigles suivis de ? ou ! (ex: "B.O. ?", "U.S.A. !")
  result = result.replace(/([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ](?:\.[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])+\.)\s*([!?])/g, (match, sigle, punct) => {
    const placeholder = `${siglePlaceholder}${sigleCounter}___`;
    // Envelopper le sigle dans une balise span avec white-space:nowrap
    siglesWithPunct[sigleCounter] = `<span style="white-space:nowrap">${sigle}</span> ${punct}`;
    sigleCounter++;
    return placeholder;
  });
  
  // Protéger aussi les sigles seuls (sans ponctuation finale) pour éviter les problèmes
  const siglePlaceholder2 = "___SIGLE___";
  const sigles = [];
  let sigleCounter2 = 0;
  // Sigles avec point final mais sans ? ou ! après
  result = result.replace(/([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ](?:\.[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])+\.)(?![!?])/g, (match) => {
    const placeholder = `${siglePlaceholder2}${sigleCounter2}___`;
    // Envelopper le sigle dans une balise span avec white-space:nowrap
    sigles[sigleCounter2] = `<span style="white-space:nowrap">${match}</span>`;
    sigleCounter2++;
    return placeholder;
  });
  
  // Ajouter <br> après les points d'exclamation et d'interrogation
  result = result.replace(/([!?])\s*/g, "$1<br>");
  
  // Restaurer les sigles avec ponctuation (sans <br> après, car le placeholder ne contient pas le ? ou !)
  siglesWithPunct.forEach((item, index) => {
    result = result.replace(`${siglePlaceholder}${index}___`, item);
  });
  
  // Restaurer les sigles seuls
  sigles.forEach((sigle, index) => {
    result = result.replace(`${siglePlaceholder2}${index}___`, sigle);
  });
  
  return result;
}

