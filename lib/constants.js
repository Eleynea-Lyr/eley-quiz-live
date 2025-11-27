// ============================================================================
// lib/constants.js
// Toutes les constantes partagées du projet
// ============================================================================

// ===== Scoring =====
export const DEFAULT_SCORING_TABLE = [
  30, 25, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
];

// ===== Timings & Phases =====
export const REVEAL_DURATION_SEC = 20; // 15s réponse + 5s compte à rebours
export const COUNTDOWN_START_SEC = 5;
export const ROUND_START_INTRO_SEC = 5; // intro au début de chaque manche
export const UI_MASK_MS = 220; // durée du voile anti-flicker

// ===== Leaderboard =====
export const DEFAULT_LEADERBOARD_TOP_N = 20;

// ===== Barre de temps =====
export const BAR_H = 6;
export const BAR_BLUE = "#3b82f6";
export const BAR_RED = "#ef4444";
export const HANDLE_COLOR = "#f8fafc";

// ===== Images =====
export const PLAYER_IMG_MAX = 220; // px (vue joueur)
export const SCREEN_IMG_MAX = 300; // px (écran public)

// ===== Anti-spam (Player) =====
export const RATE_LIMIT_ENABLED = true;
export const MAX_WRONG_ATTEMPTS = 6;
export const RATE_LIMIT_WINDOW_MS = 15_000; // 15s
export const COOLDOWN_MS = 5_000; // 5s

// ===== Phrases de révélation =====
export const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :",
];

// ===== Phrases anti-spam =====
export const LOCK_PHRASES = [
  "Eh, arrête de spammer ! Ecoute et réfléchis plutôt !",
  "Le spam c'est mal, m'voyez !",
  "Tu penses vraiment y arriver de cette façon ?",
  "Tu veux faire exploser l'appli ou quoi ?",
  "Calme toi, tout doux..."
];

// ===== Couleurs joueurs (Admin) =====
export const PLAYER_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee",
  "#60a5fa", "#818cf8", "#a78bfa", "#f472b6", "#fda4af", "#f59e0b",
  "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6",
];

// ===== Espace mobile (iOS safe areas) =====
export const SAFE_TOP = "env(safe-area-inset-top, 0px)";
export const TOP_GUTTER_RUNNING = "clamp(40px, 8vh, 72px)";
export const TOP_GUTTER_IDLE = "clamp(28px, 6vh, 56px)";

// ===== Configuration Admin =====
export const DEFAULT_REVEAL_DURATION_SEC = 20;
export const TIME_MUSIC_MIN_SEC = 20;
export const DEFAULT_TIME_MUSIC_SEC = 35;

// ===== Validation noms =====
export const NAME_ALLOWED_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9''\-–\s]{1,30}$/u;

// ===== Modération =====
export const PROFANITY = new Set([
  "fuck", "shit", "merde", "pute", "putain", "salope", "connard", "connasse",
  "encule", "enculé", "enculee", "ntm", "fdp", "nique", "niquer",
  "biatch", "bite", "couille", "couilles", "pd", "tapette", "tafiole",
  "nazi", "hitler", "negro", "negre", "bougnoule", "youpin", "antisemite", "raciste"
]);

export const POLITICS_TOKENS = new Set([
  "palestine", "israel", "gaza", "hamas", "hezbollah",
  "ukraine", "russie", "russia", "poutine",
  "front", "national", "rn", "reconquete", "zemmour", "sarkozy",
  "lfi", "insoumise", "melenchon", "bardella",
  "macron", "lepen", "trump", "biden", "fn"
]);

export const POLITICS_PHRASES = [
  "front national", "la france insoumise", "le pen"
];

export const POLITICS_PREFIX = new Set(["vive", "viva", "free", "support", "go"]);

