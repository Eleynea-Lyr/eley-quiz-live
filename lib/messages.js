// ============================================================================
// lib/messages.js
// Tous les messages UI de l'application (Quiz + EleyBuzz)
// ============================================================================

// ===== PLAYER - Quiz =====
export const PLAYER_MESSAGES = {
  // Inscription
  welcomeTitle: "Bienvenue au Quiz d'Eley 🎶",
  welcomeSubtitle: "Entre ton pseudo pour participer :",
  namePlaceholder: "Ton pseudo",
  joinButton: "Rejoindre",
  
  // Validation nom
  nameEmpty: "Le pseudo ne peut pas être vide.",
  nameTooLong: "Le pseudo est trop long (max 30 caractères).",
  nameInvalidChars: "Seules les lettres, chiffres, apostrophes, tirets et espaces sont autorisés.",
  nameAlreadyTaken: "Ce pseudo est déjà pris. Choisis-en un autre !",
  nameProfanity: "Ce pseudo n'est pas autorisé. Choisis quelque chose de respectueux.",
  namePolitics: "Ce pseudo n'est pas autorisé. Pas de politique ici !",
  nameRejected: "L'animateur a refusé ton pseudo. Choisis-en un autre.",
  
  // Attente
  preStartTitle: "ELEY Quiz — En attente du départ",
  preStartMessage: "Le quiz n'a pas encore démarré.",
  preStartHint: "(Attendez que l'animateur lance la partie.)",
  preStartRegistered: "Tu es inscrit comme",
  preStartNotStarted: "L'Admin n'a pas encore lancé le quiz.",
  preStartChangeName: "Envie de changer de nom ?",
  preStartChangeNameButton: "Modifier mon nom",
  preStartNameLocked: "Ton nom a été fixé par l'animateur.",
  
  // Pendant le quiz
  questionPlaceholder: "Votre réponse",
  submitButton: "Valider",
  lockAntiSpam: "En cooldown anti-spam",
  
  // Fin de quiz/manche
  endOfQuizTitle: "Fin du quiz",
  endOfRoundTitle: "Fin de la manche",
  roundBreakSubtitle: "(pause de manche)",
  currentScore: "Ton score actuel est :",
  yourScore: "Ton score :",
  ranking: "Classement :",
  youAre: "Tu es",
  first: "1er",
  last: "dernier",
  inRanking: "dans le classement",
  transition: "(transition…)",
  pauseTitle: "On revient dans un instant…",
  pauseSubtitle: "Le quiz est momentanément en pause.",
  
  // Messages bonne réponse
  correctAnswer: "Bonne réponse !",
  alreadyCorrect: "Tu as déjà bien répondu à cette question",
  pointsEarned: "Tu as marqué",
  point: "point",
  points: "points",
  
  // Fallbacks
  waiting: "En attente du démarrage…",
  waitingFirstQuestion: "En attente de la première question",
  noQuestions: "Aucune question planifiée (ajoute des timecodes dans l'admin).",
  syncing: "Patiente… (synchronisation)",
  thanks: "Merci pour ta participation !",
};

// ===== PLAYER - EleyBuzz =====
export const ELEYBUZZ_PLAYER_MESSAGES = {
  title: "⚡ EleyBuzz ⚡",
  buzzerButton: "BUZZER",
  buzzerButtonTitle: "Appuie pour buzzer !",
  
  // États buzzer
  idle: "Écoute attentivement la question de Eley. Puis, dès que le Buzzer apparaît, appuie vite dessus si tu connais la réponse ! Attention, tu auras une pénalité si tu réponds faux !",
  open: "Le buzzer est OUVERT ! Appuie vite !",
  locked: "Le buzzer est verrouillé. Un joueur a déjà buzzé.",
  yourTurn: "À toi de répondre !",
  waitingVerification: "En attente de la vérification du premier joueur à avoir buzzé.",
  
  // Messages temporaires
  correctAnswer: "Bravo",
  youWin: "tu gagnes",
  pts: "pts !",
  otherScored: "a marqué",
  wrongAnswer: "Mauvaise réponse",
  tooSlow: "Un joueur a été plus rapide que toi !",
  
  // Punition (le nombre de points sera injecté dynamiquement)
  punishment: "T'es puni ! Tu perds {penalty} points ! Il fallait donner la bonne réponse ! Attends quelques secondes ou qu'un autre joueur se trompe également avant de rebuzzer.",
  punishmentTimer: "Temps restant :",
  
  // Scores
  quizScore: "Quiz",
  buzzScore: "⚡ EleyBuzz",
};

// ===== SCREEN - Quiz =====
export const SCREEN_MESSAGES = {
  // Pré-start
  preStartTitle: "EleyBox\nÉcran en attente",
  preStartMessage: "Le quiz n'a pas encore commencé.\nPréparez-vous…",
  
  // Pendant le quiz
  roundStarts: "La manche",
  roundStartsIn: "commence dans :",
  endOfRound: "Fin de la manche",
  provisionalPodium: "Podium provisoire :",
  transition: "(transition…)",
  pauseTitle: "On revient dans un instant…",
  pauseSubtitle: "Le quiz est momentanément en pause.",
  
  // Countdown
  nextQuestionIn: "Prochaine question dans :",
  endOfQuizIn: "Fin du quiz dans :",
  endOfRoundIn: "Fin de la manche",
  
  // Podium
  podiumTitle: "Voici le podium du Quiz d'Eley :",
  finalPodiumTitle: "Score Final de la EleyBox :",
  gold: "🥇 Or",
  silver: "🥈 Argent",
  bronze: "🥉 Bronze",
  noPoints: "Aucun point n'a été marqué. Merci à tous pour votre participation !",
  noPointsYet: "Aucun point n'a été marqué pour l'instant.",
  nothingDecided: "… mais rien n'est joué encore.",
  
  // Live podium
  congratsTo: "Bravo à :",
  
  // Classement
  rankingTitle: "Classement",
  topN: "Top",
  noPlayers: "Aucun joueur.",
  
  // Fallbacks
  waiting: "En attente du démarrage…",
  waitingFirstQuestion: "En attente de la première question (à",
  noQuestions: "Aucune question planifiée (ajoute des timecodes dans l'admin).",
  syncing: "Patiente… (synchronisation)",
};

// ===== SCREEN - EleyBuzz =====
export const ELEYBUZZ_SCREEN_MESSAGES = {
  title: "⚡ EleyBuzz ⚡",
  idle: "Écoute attentivement la question et appuie vite sur le buzzer de ton téléphone si tu connais la réponse.",
  open: "Le buzzer est OUVERT ! Préparez-vous à buzzer !",
  locked: "a buzzé !",
  waitingAnswer: "On attend sa réponse...",
  correctAnswer: "Bravo",
  youWin: "tu gagnes",
  pts: "pts !",
  wrongAnswer: "Mauvaise réponse !",
  rankingTitle: "Classement ⚡ EleyBuzz ⚡",
};

// ===== MESSAGES ANTI-SPAM =====
export const LOCK_MESSAGES = [
  "Eh, arrête de spammer ! Ecoute et réfléchis plutôt !",
  "Le spam c'est mal, m'voyez !",
  "Tu penses vraiment y arriver de cette façon ?",
  "Tu veux faire exploser l'appli ou quoi ?",
  "Calme toi, tout doux..."
];

// ===== PHRASES DE RÉVÉLATION (par défaut) =====
export const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :",
];

