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
  correctAnswer: "Bonne réponse",
  wrongAnswer: "Mauvaise réponse",
  waitNextQuestion: "Attends la prochaine question",
  tryYourChance: "À toi de tenter ta chance !",
  
  // Punition
  punishment: "T'es puni ! Il fallait donner la bonne réponse ! Attends 20 secondes ou qu'un autre joueur se trompe également avant de rebuzzer.",
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

// ===== ADMIN - Quiz =====
export const ADMIN_MESSAGES = {
  // Header
  title: "Admin",
  
  // Toolbar
  startQuiz: "Démarrer le quiz",
  nextRound: "Manche suivante",
  round: "Manche",
  endOfQuiz: "Fin du quiz",
  pause: "Pause",
  resume: "Reprendre",
  back: "Back",
  next: "Next",
  reset: "Réinitialiser",
  
  // Titres boutons
  pauseTitle: "Mettre en pause le quiz",
  resumeTitle: "Reprendre le quiz",
  backTitle: "Revenir au début de la question en cours (ou au début de la manche)",
  nextTitle: "Aller au début de la prochaine question (si disponible dans cette manche)",
  resetTitle: "Réinitialiser le quiz",
  unavailableBeforeStart: "Indisponible avant le départ ou après la fin",
  unavailableInEleyBuzz: "Indisponible en mode EleyBuzz",
  roundBoundaryReached: "Fin de manche atteinte : utilisez « Manche suivante »",
  
  // Manches
  currentRound: "Manche actuelle :",
  nextRound: "Manche suivante :",
  roundBoundary: "Fin de manche atteinte",
  roundConfigLocked: "Réglages des manches verrouillés pendant un quiz en cours",
  roundStartTime: "Heure de début de la manche",
  
  // Fin de quiz
  endOfQuizLabel: "Fin du quiz (hh:mm:ss)",
  endOfQuizPlaceholder: "ex: 01:58:00",
  endOfQuizLocked: "Fin de quiz verrouillée pendant un quiz en cours",
  endOfQuizTitle: "Point de fin global (utilisé pour la révélation & le décompte final)",
  
  // Notices
  resetConfirm: "Tout remettre à zéro ? (quiz/state, joueurs, answers/*)",
  resetting: "Réinitialisation…",
  resetComplete: "Réinitialisation terminée ✔",
  resetFailed: "Échec de la réinitialisation",
  
  // Joueurs
  playersTab: "Joueurs",
  playersConnected: "Joueurs connectés :",
  loading: "chargement…",
  resetScoresConfirm: "Remettre tous les scores (quiz + EleyBuzz) à 0 pour tous les joueurs ?",
  resetScoresButton: "Remettre tous les scores à 0",
  resetScoresTitle: "Remettre tous les scores (quiz + EleyBuzz) à 0",
  resetScoresUnavailable: "Indisponible pendant qu'un quiz est en cours",
  resetScoresSuccess: "Tous les scores ont été remis à 0 ✔",
  resetScoresFailed: "Échec de la remise à zéro des scores",
  finalScoreButton: "Score final",
  finalScoreTitle: "Afficher le podium final (score quiz + EleyBuzz)",
  finalScoreDisplayed: "Score final affiché sur Screen et Player",
  finalScoreError: "Erreur lors de l'affichage du score final",
  
  // Tableau joueurs
  playersTableName: "Joueurs",
  playersTableQuizScore: "Score Quiz",
  playersTableBonusScore: "Score Bonus",
  playersTableBonusScoreSubtitle: "EleyBuzz",
  playersTableStatus: "Statut",
  playersTableActions: "Actions",
  statusOK: "OK",
  statusRejected: "Refusé",
  statusKicked: "Kické",
  noPlayers: "Aucun joueur pour l'instant.",
  
  // Actions joueurs
  rejectButton: "Refuser",
  rejectTitle: "Refuser ce nom (le joueur devra en choisir un autre)",
  playerNButton: "Player N",
  playerNTitle: "Fixer le nom sur « Player N »",
  playerNUnavailable: "Disponible une fois le quiz lancé",
  playerNLocked: "Nom modéré (verrouillé)",
  playerNOwned: "Owned :)",
  kickButton: "Kick",
  kickTitle: "Retirer ce joueur de la partie",
  
  // Quiz
  createQuizButton: "+ Créer un quiz",
  quizActive: "Quiz actif",
  quizInactive: "Quiz inactif",
  tabLocked: "Onglet verrouillé pendant un quiz en cours",
  duplicateButton: "Dupliquer ce quiz",
  duplicateUnavailable: "Impossible de dupliquer le quiz actif pendant qu'il est en cours",
  editNameButton: "Editer nom du quizz",
  editNameTitle: "Modifier le nom de ce quiz",
  deleteButton: "Supprimer ce quiz",
  deleteUnavailable: "Impossible de supprimer le quiz actif pendant qu'il est en cours",
  cannotDeleteLast: "Impossible de supprimer le dernier quiz restant.",
  cannotDeleteActive: "Impossible de supprimer le quiz actif. Active d'abord un autre quiz.",
  deleteConfirm: "Supprimer le quiz",
  andAllQuestions: "et toutes ses questions ?",
  
  // Questions
  createQuestionTitle: "— créer une nouvelle question",
  questionLabel: "Question",
  imageQuestionLabel: "Image question (optionnelle)",
  answersLabel: "Réponses acceptées (séparées par des virgules)",
  answersPlaceholder: "ex: Mario, Super Mario",
  answersSeparatorHint: "Sépare par des virgules",
  matchingModeLabel: "Mode d'appariement (tolérance)",
  matchingStrict: "strict (exact après normalisation)",
  matchingRelaxed: "relaxed (tolérance relative)",
  matchingNumeric: "numeric (strict numérique)",
  timeMusicLabel: "TimeMusic (hh:mm:ss)",
  timeMusicPlaceholder: "ex: 00:00:35",
  imageAnswerLabel: "Image réponse (optionnelle)",
  createButton: "Créer la question",
  creating: "Création…",
  
  revealPhrasesLegend: "Phrase de réponse aléatoire (max 5)",
  revealPhrase: "Phrase",
  revealPhrasePlaceholder: "Ex: La réponse était :",
  revealPhrasesHint: "Laisse vide pour utiliser la liste par défaut.",
  
  // Tableau questions
  orderColumn: "Ordre",
  questionColumn: "Question",
  imageQuestionColumn: "Image question",
  answersColumn: "Réponses acceptées",
  timecodeColumn: "TimeCode",
  timeMusicColumn: "TimeMusic",
  imageAnswerColumn: "Image réponse",
  actionsColumn: "Actions",
  noImage: "Pas d'image",
  removeImageQuestionTitle: "Supprimer l'image question (valider avec « Modifier »)",
  removeImageAnswerTitle: "Supprimer l'image réponse (valider avec « Modifier »)",
  defaultTimeMusic: "Défaut",
  minTimeMusic: "(min",
  timecodeAutoCalculated: "Calculé automatiquement d'après l'ordre et TimeMusic",
  modifyButton: "Modifier",
  modifying: "Modification…",
  modified: "Modifié ✔",
  deleteQuestionButton: "Supprimer",
  
  orderInitRequired: "Initialisation de l'ordre requise :",
  orderInitMessage: "certaines questions n'ont pas encore de champ",
  initOrderButton: "Initialiser l'ordre (une fois)",
  
  noQuestions: "Aucune question.",
  
  // Quiz management
  createQuizPrompt: "Nom du nouveau quiz :",
  newQuizDefault: "Nouveau quiz",
  duplicateQuizPrompt: "Nom du nouveau quiz :",
  duplicateSuffix: "(copie)",
  editQuizPrompt: "Nouveau nom du quiz :",
  quizNotFound: "Quiz introuvable.",
  createQuizError: "Échec de la création du quiz :",
  changeActiveQuizError: "Échec du changement de quiz actif :",
  duplicateQuizError: "Échec de la duplication du quiz :",
  editQuizSuccess: "Nom du quiz modifié : «",
  editQuizError: "Échec de la modification du nom :",
  deleteQuizError: "Échec de la suppression du quiz :",
};

// ===== ADMIN - EleyBuzz =====
export const ELEYBUZZ_ADMIN_MESSAGES = {
  goButton: "Go EleyBuzz",
  stopButton: "STOP EleyBuzz",
  goTitle: "Activer EleyBuzz",
  stopTitle: "Désactiver EleyBuzz",
  activated: "EleyBuzz activé",
  deactivated: "EleyBuzz désactivé",
  activationError: "Erreur lors du changement de mode EleyBuzz",
  
  // Buzzer controls
  buzzerClosed: "Buzzer FERMÉ",
  buzzerOpen: "Buzzer OUVERT",
  buzzerLocked: "Buzzer VERROUILLÉ",
  buzzerTitle: "Touche 1 : Ouvrir/Fermer le buzzer",
  playerBuzzed: "a buzzé !",
  
  correctButton: "✓ Correct (2)",
  wrongButton: "✗ Faux (3)",
  correctTitle: "Touche 2 : Bonne réponse (+15 pts)",
  wrongTitle: "Touche 3 : Mauvaise réponse",
  waitingMessage: "En attente de la fin du message",
  
  buzzerStateError: "Erreur lors du changement d'état du buzzer",
  correctError: "Erreur lors de l'attribution des points",
  wrongError: "Erreur lors du traitement de la mauvaise réponse",
  
  // Points
  pointsLabel: "Points EleyBuzz:",
  
  // Unlock
  unlockButton: "🔓 Débloquer joueurs",
  unlockTitle: "Débloquer manuellement tous les joueurs (en cas de problème)",
  unlocking: "Déblocage des joueurs...",
  unlockSuccess: "Tous les joueurs débloqués ✔",
  unlockRetries: "tentative(s)",
  unlockFailed: "⚠️ Échec du déblocage - Réessayez",
  unlockError: "Erreur lors du déblocage",
};

// ===== FINAL SCORE =====
export const FINAL_SCORE_MESSAGES = {
  titleScreen: "Score Final de la EleyBox",
  titlePlayer: "Score Final de la EleyBox",
  endOfEvening: "Fin de la soirée, ton score est de :",
  pts: "pts",
  youAreFirst: "Quel talent, tu es premier !",
  youAreSecond: "Félicitations, tu termines second !",
  youAreThird: "Bravo, tu es 3e avec un très beau score !",
  youAreFourth: "Bravo, tu finis quatrième, si proche du podium !",
  youAreRank: "C'était le Quiz d'Eley. Tu finis à la",
  youAreLast: "Merci pour ta participation !",
  inRanking: "place. Merci pour ta participation !",
  th: "ème",
};

// ===== MESSAGES DE FIN (PLAYER) =====
export const END_MESSAGES = {
  firstPlace: "Tu es 1er dans le classement",
  secondPlace: "Tu es 2ème dans le classement",
  thirdPlace: "Tu es 3ème dans le classement",
  fourthPlace: "Tu es 4ème dans le classement",
  otherPlace: "Tu es",
  otherPlaceSuffix: "dans le classement",
  thanks: "Tu es dernier dans le classement",
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

