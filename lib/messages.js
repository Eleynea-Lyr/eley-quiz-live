// ============================================================================
// lib/messages.js
// Messages UI — organisés page par page (Player, Screen, EleyBuzz)
// Modifier ici pour personnaliser une soirée (Halloween, etc.)
// ============================================================================

/** Fusionne des overrides Firestore sur les défauts d'une page */
export function mergePageMessages(defaults, overrides) {
  if (!overrides || typeof overrides !== "object") return { ...defaults };
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") merged[key] = value;
  }
  return merged;
}

/** Remplace {cle} dans un modèle de message */
export function formatMsg(template, vars = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (_, key) => (
    vars[key] != null ? String(vars[key]) : `{${key}}`
  ));
}

// =============================================================================
// PLAYER — Page « Création Joueur » (inscription)
// =============================================================================
export const PLAYER_PAGE_CREATION_JOUEUR = {
  /** Ligne 1 du titre (gros, centré en haut) */
  welcomeLine1: "Bienvenue",
  /** Ligne 2 du titre (même taille que ligne 1) */
  welcomeLine2: "dans le quiz d'ELEY",
  /** Au-dessus du champ texte */
  chooseNameLabel: "Choisis ton nom de joueur",
  /** Placeholder du champ */
  namePlaceholder: "ex : Les Quichettes",
  /** Sous le champ */
  maxCharsHint: "max 12 caractères",
  /** Bouton principal */
  enterButton: "Entrer",
  enterButtonBusy: "Inscription…",
  /** Nom refusé par l'animateur */
  nameRejectedByAdmin: "Ce nom a été refusé par l'animateur. Choisis-en un autre.",
};

/** @deprecated alias — utiliser PLAYER_PAGE_CREATION_JOUEUR */
export const PLAYER_PAGE_NOM_JOUEUR = PLAYER_PAGE_CREATION_JOUEUR;

// =============================================================================
// PLAYER — Page « Equipe » (choix créer / rejoindre)
// =============================================================================
export const PLAYER_PAGE_EQUIPE = {
  titleLine1: "Choisis",
  titleLine2: "ton équipe",
  choiceHint: "Créer une nouvelle équipe ou rejoindre une équipe existante",
  mustLeaveBeforeCreate: "Quitte d'abord ton équipe actuelle avant de créer une nouvelle équipe.",
  createButton: "Créer une équipe",
  joinButton: "Rejoindre une équipe",
  leaveTeamButton: 'Quitter l\'équipe "{teamName}"',
  soloIntro: "Tu es seul dans l'équipe",
  soloHint: "Tu dois d'abord supprimer cette équipe avant de créer ou rejoindre une autre équipe.",
  deleteTeamButton: 'Supprimer l\'équipe "{teamName}"',
  deleteTeamButtonBusy: "Suppression…",
  cancelButton: "Annuler",
};

// =============================================================================
// PLAYER — Page « Création d'équipe »
// =============================================================================
export const PLAYER_PAGE_CREATION_EQUIPE = {
  titleLine1: "Crée",
  titleLine2: "ton équipe",
  hint: "Crée une nouvelle équipe. Attention, si tu es déjà dans une équipe, pense à la quitter avant d'en créer une nouvelle.",
  namePlaceholder: "ex : LES CHAMPIONS",
  maxCharsHint: "Max 18 caractères. Le nom sera en majuscules.",
  submitButton: "Créer l'équipe",
  submitButtonBusy: "Création…",
  cancelButton: "Annuler",
};

// =============================================================================
// PLAYER — Page « Rejoindre une équipe »
// =============================================================================
export const PLAYER_PAGE_REJOINDRE_EQUIPE = {
  titleLine1: "Rejoins",
  titleLine2: "une équipe",
  /** Texte sous le titre (blanc, aligné à gauche) */
  hint: "Rejoins ton équipe",
  /** Affiché en rouge si le joueur rejoint alors qu'il est déjà dans une équipe */
  alreadyInTeamWarning: "Attention, tu fais déjà partie d'une équipe, tu en seras exclu automatiquement.",
  searchPlaceholder: "Recherche ton équipe",
  noResults: 'Aucune équipe trouvée pour "{query}"',
  noTeamsAvailable: "Aucune équipe disponible pour le moment.",
  memberSingular: "membre",
  memberPlural: "membres",
  cancelButton: "Annuler",
};

// =============================================================================
// PLAYER — Page « Attente » (inscrit, quiz pas encore lancé)
// =============================================================================
export const PLAYER_PAGE_ATTENTE = {
  titleLine1: "Patience,",
  titleLine2: "le quiz va bientôt commencer",
  changeNameHint: "Envie de changer de nom ?",
  changeNameButton: "Modifier mon nom",
  changeTeamHint: "Envie de changer d'équipe ?",
  changeTeamButton: "Changer d'équipe",
  nameLocked: "Ton nom a été fixé par l'animateur.",
};

// =============================================================================
// PLAYER — Page « Quiz » (réponses, saisie)
// =============================================================================
export const PLAYER_PAGE_QUIZ = {
  questionPlaceholder: "Votre réponse",
  submitButton: "Valider",
  lockAntiSpam: "En cooldown anti-spam",
  correctAnswer: "Bonne réponse !",
  alreadyCorrect: "Tu as déjà bien répondu à cette question",
  qcmWrong: "Mauvaise réponse",
  /** Préfixe ligne joueur sous « Bonne réponse » (ex. « Tu marques 3 points ») */
  playerScored: "Tu marques",
  /** @deprecated — préférer playerScored */
  pointsEarned: "Tu marques",
  point: "point",
  points: "points",
  /** Phrase affichée au reveal avant la bonne réponse (ex. « La réponse était : ») */
  revealAnswer: "La réponse était :",
};

// =============================================================================
// PLAYER — Page « Fin / Pause » (manches, fin de quiz)
// =============================================================================
export const PLAYER_PAGE_FIN = {
  endOfQuizTitle: "Fin du quiz",
  endOfRoundTitle: "Fin de la manche",
  provisionalPodiumTeams: "Voici le podium provisoire des équipes",
  provisionalPodiumPlayers: "Voici le podium provisoire des joueurs",
  finalPodiumTeams: "Podium final des équipes",
  finalPodiumPlayers: "Podium final des joueurs",
  nothingDecided: "Mais rien n'est encore joué !",
  roundBreakSubtitle: "",
  transition: "(transition…)",
  pauseTitle: "On revient dans un instant…",
  pauseSubtitle: "Le quiz est momentanément en pause.",
  finalScoreTitle: "Fin de la soirée, voici les scores",
  personalRankPrefix: "Classement personnel :",
  thanks: "Merci pour ta participation !",
  waiting: "En attente du démarrage…",
  waitingFirstQuestion: "En attente de la première question",
  noQuestions: "Aucune question planifiée (ajoute des timecodes dans l'admin).",
  syncing: "Patiente… (synchronisation)",
};

// =============================================================================
// PLAYER — Aide scores (bouton i)
// =============================================================================
export const PLAYER_SCORE_HELP = {
  openLabel: "Comment marchent les scores ?",
  closeLabel: "Fermer",
  dialogTitle: "Comment marchent les scores",
  prev: "Précédent",
  next: "Suivant",
  done: "Compris !",
  page0Title: "Le quiz musical d’Eley",
  page0Lead:
    "La musique joue, les questions s’affichent sur ton téléphone en temps réel, et elles ont toujours un lien avec ce que tu entends.",
  page0Body:
    "Réponds juste et vite pour faire gagner des points à ton équipe… et grimper toi aussi au classement perso !",
  page0Buzz:
    "L’animateur pourra aussi lancer un mode Buzz : des questions en direct pour gagner (ou perdre) des points bonus.",
  page1Title: "Parlons score d’équipe !",
  page1Body:
    "À chaque question, seul le premier de ton équipe à trouver la bonne réponse fait gagner des points à toute la team.",
  page1Caption: "Badge en haut à gauche",
  page1Example: "La 1ʳᵉ équipe qui trouve marque le plus, les suivantes un peu moins.",
  page2Title: "Et toi, en solo ?",
  page2Lead: "En parallèle de ton équipe, toi aussi tu marques des points.",
  page2Body: "Plus tu réponds vite et juste, plus tu grimpes au classement joueurs.",
  page2Caption: "Badge en haut à droite",
  page2Note: "Score équipe (gauche) ≠ score perso (droite).",
  page2NoteLine2: "Les deux comptent pour la soirée.",
  page3Title: "Le mode Buzz",
  page3Lead:
    "Le mode Buzz permet de gagner des points bonus qui s’ajouteront à ton score joueur. Attention : tu peux aussi avoir des malus.",
  page3Body:
    "Quand le gros bouton bleu apparaît, buzz pour tenter de répondre. Si tu réponds juste, tu gagnes des points bonus. Si tu réponds faux, tu en perds… et tu attends la question suivante pour pouvoir rebuzzer.",
  page3Caption: "Voici les différents états du buzzer :",
  page3Close:
    "À la fin du quiz, l’animateur ajoutera ces points bonus (ou malus) à ton score joueur.",
  page3CloseNote: "Ça ne change pas le score de l’équipe.",
};

// =============================================================================
// PLAYER — Validation du nom (erreurs formulaire)
// =============================================================================
export const PLAYER_NAME_VALIDATION = {
  nameEmpty: "Le pseudo ne peut pas être vide.",
  nameTooLong: "Le pseudo est trop long (max 12 caractères).",
  nameInvalidChars: "Seules les lettres, chiffres, apostrophes, tirets et espaces sont autorisés.",
  nameAlreadyTaken: "Ce pseudo est déjà pris. Choisis-en un autre !",
  nameProfanity: "Ce pseudo n'est pas autorisé. Choisis quelque chose de respectueux.",
  namePolitics: "Ce pseudo n'est pas autorisé. Pas de politique ici !",
  nameRejected: "L'animateur a refusé ton pseudo. Choisis-en un autre.",
};

/** @deprecated Préférer les constantes PLAYER_PAGE_* ci-dessus */
export const PLAYER_MESSAGES = {
  welcomeTitle: `${PLAYER_PAGE_CREATION_JOUEUR.welcomeLine1} ${PLAYER_PAGE_CREATION_JOUEUR.welcomeLine2}`,
  welcomeSubtitle: PLAYER_PAGE_CREATION_JOUEUR.chooseNameLabel,
  namePlaceholder: PLAYER_PAGE_CREATION_JOUEUR.namePlaceholder,
  joinButton: PLAYER_PAGE_CREATION_JOUEUR.enterButton,
  ...PLAYER_NAME_VALIDATION,
  preStartTitle: `${PLAYER_PAGE_ATTENTE.titleLine1} ${PLAYER_PAGE_ATTENTE.titleLine2}`,
  preStartMessage: "Le quiz n'a pas encore démarré.",
  preStartHint: "(Attendez que l'animateur lance la partie.)",
  preStartChangeName: PLAYER_PAGE_ATTENTE.changeNameHint,
  preStartChangeNameButton: PLAYER_PAGE_ATTENTE.changeNameButton,
  preStartNameLocked: PLAYER_PAGE_ATTENTE.nameLocked,
  questionPlaceholder: PLAYER_PAGE_QUIZ.questionPlaceholder,
  submitButton: PLAYER_PAGE_QUIZ.submitButton,
  lockAntiSpam: PLAYER_PAGE_QUIZ.lockAntiSpam,
  endOfQuizTitle: PLAYER_PAGE_FIN.endOfQuizTitle,
  endOfRoundTitle: PLAYER_PAGE_FIN.endOfRoundTitle,
  roundBreakSubtitle: PLAYER_PAGE_FIN.roundBreakSubtitle,
  revealAnswer: PLAYER_PAGE_QUIZ.revealAnswer,
  yourScore: "Ton score :",
  ranking: "Classement :",
  youAre: "Tu es",
  first: "1er",
  last: "dernier",
  inRanking: "dans le classement",
  transition: PLAYER_PAGE_FIN.transition,
  pauseTitle: PLAYER_PAGE_FIN.pauseTitle,
  pauseSubtitle: PLAYER_PAGE_FIN.pauseSubtitle,
  correctAnswer: PLAYER_PAGE_QUIZ.correctAnswer,
  alreadyCorrect: PLAYER_PAGE_QUIZ.alreadyCorrect,
  pointsEarned: PLAYER_PAGE_QUIZ.pointsEarned,
  point: PLAYER_PAGE_QUIZ.point,
  points: PLAYER_PAGE_QUIZ.points,
  waiting: PLAYER_PAGE_FIN.waiting,
  waitingFirstQuestion: PLAYER_PAGE_FIN.waitingFirstQuestion,
  noQuestions: PLAYER_PAGE_FIN.noQuestions,
  syncing: PLAYER_PAGE_FIN.syncing,
  thanks: PLAYER_PAGE_FIN.thanks,
};

// =============================================================================
// PLAYER — Page « EleyBuzz »
// =============================================================================
export const ELEYBUZZ_PLAYER_MESSAGES = {
  title: "⚡ EleyBuzz ⚡",
  buzzerButton: "BUZZER",
  buzzerButtonTitle: "Appuie pour buzzer !",
  idle: "Écoute attentivement la question de Eley. Puis, dès que le Buzzer apparaît, appuie vite dessus si tu connais la réponse ! Attention, tu auras une pénalité si tu réponds faux !",
  open: "Le buzzer est OUVERT ! Appuie vite !",
  locked: "Le buzzer est verrouillé. Un joueur a déjà buzzé.",
  yourTurn: "À toi de répondre !",
  waitingVerification: "En attente de la vérification du premier joueur à avoir buzzé.",
  correctAnswer: "Bravo",
  youWin: "tu gagnes",
  pts: "pts !",
  otherScored: "a marqué",
  wrongAnswer: "Mauvaise réponse",
  tooSlow: "Un joueur a été plus rapide que toi !",
  punishment: "T'es puni ! Tu perds {penalty} points ! Il fallait donner la bonne réponse ! Attends quelques secondes ou qu'un autre joueur se trompe également avant de rebuzzer.",
  punishmentTimer: "Temps restant :",
  quizScore: "Quiz",
  buzzScore: "⚡ EleyBuzz",
};

// =============================================================================
// SCREEN — Page « Attente »
// =============================================================================
export const SCREEN_PAGE_ATTENTE = {
  title: "EleyBox\nÉcran en attente",
  message: "Le quiz n'a pas encore commencé.\nPréparez-vous…",
};

// =============================================================================
// SCREEN — Page « Quiz »
// =============================================================================
export const SCREEN_PAGE_QUIZ = {
  roundStarts: "La manche",
  roundStartsIn: "commence dans :",
  endOfRound: "Fin de la manche",
  provisionalPodium: "Podium provisoire :",
  transition: "(transition…)",
  pauseTitle: "On revient dans un instant…",
  pauseSubtitle: "Le quiz est momentanément en pause.",
  nextQuestionIn: "Prochaine question dans :",
  endOfQuizIn: "Fin du quiz dans :",
  endOfRoundIn: "Fin de la manche",
  congratsTo: "Bravo à :",
  /** Phrase avant la bonne réponse au reveal (ex. « La réponse était : ») */
  revealAnswer: "La réponse était :",
  waiting: "En attente du démarrage…",
  waitingFirstQuestion: "En attente de la première question (à",
  noQuestions: "Aucune question planifiée (ajoute des timecodes dans l'admin).",
  syncing: "Patiente… (synchronisation)",
};

// =============================================================================
// SCREEN — Page « Podium / Classement »
// =============================================================================
export const SCREEN_PAGE_PODIUM = {
  /** Fin de manche — le numéro est ajouté après (ex. « Fin de la manche 3 ») */
  endOfRound: "Fin de la manche",
  endOfQuiz: "Fin du quiz",
  provisionalPodiumTeams: "Voici le podium provisoire des équipes",
  provisionalPodiumPlayers: "Voici le podium provisoire des joueurs",
  nothingDecided: "… mais rien n'est joué encore.",
  /** Sous le podium à la fin du quiz (écran géant) */
  quizEndThanks: "Bravo à tous et merci pour votre participation !",
  /** @deprecated Préférer finalPodiumTeams / finalPodiumPlayers en fin de quiz */
  podiumTitle: "Voici le podium du Quiz d'Eley :",
  finalPodiumTeams: "Voici le podium final des équipes",
  finalPodiumPlayers: "Voici le podium final des joueurs",
  finalPodiumTitle: "Score Final de la EleyBox :",
  finalEveningTitle: "Fin de la soirée, Voici le podium final :",
  gold: "🥇 Or",
  silver: "🥈 Argent",
  bronze: "🥉 Bronze",
  noPoints: "Aucun point n'a été marqué. Merci à tous pour votre participation !",
  noPointsYet: "Aucun point n'a été marqué pour l'instant.",
  rankingTitle: "Classement",
  topN: "Top",
  noPlayers: "Aucun joueur.",
};

/** @deprecated Préférer SCREEN_PAGE_* */
export const SCREEN_MESSAGES = {
  preStartTitle: SCREEN_PAGE_ATTENTE.title,
  preStartMessage: SCREEN_PAGE_ATTENTE.message,
  ...SCREEN_PAGE_QUIZ,
  podiumTitle: SCREEN_PAGE_PODIUM.podiumTitle,
  finalPodiumTitle: SCREEN_PAGE_PODIUM.finalPodiumTitle,
  gold: SCREEN_PAGE_PODIUM.gold,
  silver: SCREEN_PAGE_PODIUM.silver,
  bronze: SCREEN_PAGE_PODIUM.bronze,
  noPoints: SCREEN_PAGE_PODIUM.noPoints,
  noPointsYet: SCREEN_PAGE_PODIUM.noPointsYet,
  nothingDecided: SCREEN_PAGE_PODIUM.nothingDecided,
  quizEndThanks: SCREEN_PAGE_PODIUM.quizEndThanks,
  finalPodiumTeams: SCREEN_PAGE_PODIUM.finalPodiumTeams,
  finalPodiumPlayers: SCREEN_PAGE_PODIUM.finalPodiumPlayers,
  endOfRound: SCREEN_PAGE_PODIUM.endOfRound,
  endOfQuiz: SCREEN_PAGE_PODIUM.endOfQuiz,
  provisionalPodiumTeams: SCREEN_PAGE_PODIUM.provisionalPodiumTeams,
  provisionalPodiumPlayers: SCREEN_PAGE_PODIUM.provisionalPodiumPlayers,
  finalEveningTitle: SCREEN_PAGE_PODIUM.finalEveningTitle,
  rankingTitle: SCREEN_PAGE_PODIUM.rankingTitle,
  topN: SCREEN_PAGE_PODIUM.topN,
  noPlayers: SCREEN_PAGE_PODIUM.noPlayers,
};

// =============================================================================
// SCREEN — Page « EleyBuzz »
// =============================================================================
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

// =============================================================================
// Messages anti-spam (cooldown saisie)
// =============================================================================
export const LOCK_MESSAGES = [
  "Eh, arrête de spammer ! Ecoute et réfléchis plutôt !",
  "Le spam c'est mal, m'voyez !",
  "Tu penses vraiment y arriver de cette façon ?",
  "Tu veux faire exploser l'appli ou quoi ?",
  "Calme toi, tout doux...",
];

// =============================================================================
// Phrases de révélation (réponse affichée)
// =============================================================================
export const DEFAULT_REVEAL_PHRASES = [
  "La réponse était :",
  "Il fallait trouver :",
  "C'était :",
  "La bonne réponse :",
  "Réponse :",
];
