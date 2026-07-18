// ============================================================================
// pages/messages.js
// Page de configuration des messages du quiz — organisée page par page
// (alignée sur lib/messages.js)
// ============================================================================

import { useState, useEffect } from "react";
import { db } from "../lib/firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import {
  PLAYER_PAGE_CREATION_JOUEUR,
  PLAYER_PAGE_EQUIPE,
  PLAYER_PAGE_CREATION_EQUIPE,
  PLAYER_PAGE_REJOINDRE_EQUIPE,
  PLAYER_PAGE_ATTENTE,
  PLAYER_PAGE_QUIZ,
  PLAYER_PAGE_FIN,
  ELEYBUZZ_PLAYER_MESSAGES,
  SCREEN_PAGE_ATTENTE,
  SCREEN_PAGE_QUIZ,
  SCREEN_PAGE_PODIUM,
  ELEYBUZZ_SCREEN_MESSAGES,
  LOCK_MESSAGES,
  DEFAULT_REVEAL_PHRASES,
} from "../lib/messages";
import AuthGate from "../lib/AuthGate";

const SECTION_STYLE = {
  background: "#0b0f1a",
  border: "1px solid #1f2a44",
  borderRadius: 12,
  padding: 24,
};

const PLAYER_ELEYBUZZ_KEYS = ["idle", "open", "locked", "yourTurn", "correctAnswer", "wrongAnswer", "punishment"];
const SCREEN_ELEYBUZZ_KEYS = ["idle", "open", "waitingAnswer", "correctAnswer", "youWin", "pts", "wrongAnswer"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] != null) out[k] = obj[k];
  }
  return out;
}

function createDefaultMessages() {
  return {
    playerNomJoueur: { ...PLAYER_PAGE_CREATION_JOUEUR },
    playerEquipe: { ...PLAYER_PAGE_EQUIPE },
    playerCreationEquipe: { ...PLAYER_PAGE_CREATION_EQUIPE },
    playerRejoindreEquipe: { ...PLAYER_PAGE_REJOINDRE_EQUIPE },
    playerAttente: { ...PLAYER_PAGE_ATTENTE },
    playerQuiz: { ...PLAYER_PAGE_QUIZ },
    playerFin: { ...PLAYER_PAGE_FIN },
    playerEleyBuzz: pick(ELEYBUZZ_PLAYER_MESSAGES, PLAYER_ELEYBUZZ_KEYS),
    screenAttente: { ...SCREEN_PAGE_ATTENTE },
    screenQuiz: { ...SCREEN_PAGE_QUIZ },
    screenPodium: { ...SCREEN_PAGE_PODIUM },
    screenEleyBuzz: pick(ELEYBUZZ_SCREEN_MESSAGES, SCREEN_ELEYBUZZ_KEYS),
    lockMessages: [...LOCK_MESSAGES],
    revealPhrases: [...DEFAULT_REVEAL_PHRASES],
  };
}

/** Fusion Firestore + migration depuis l'ancien schéma playerQuiz / screenQuiz */
function mergeMessagesFromFirestore(data) {
  const defaults = createDefaultMessages();
  if (!data) return defaults;

  const oldPQ = data.playerQuiz || {};
  const oldSQ = data.screenQuiz || {};

  return {
    playerNomJoueur: {
      ...defaults.playerNomJoueur,
      ...data.playerNomJoueur,
      chooseNameLabel:
        data.playerNomJoueur?.chooseNameLabel
        ?? oldPQ.welcomeSubtitle
        ?? defaults.playerNomJoueur.chooseNameLabel,
    },
    playerEquipe: {
      ...defaults.playerEquipe,
      ...data.playerEquipe,
    },
    playerCreationEquipe: {
      ...defaults.playerCreationEquipe,
      ...data.playerCreationEquipe,
    },
    playerRejoindreEquipe: {
      ...defaults.playerRejoindreEquipe,
      ...data.playerRejoindreEquipe,
    },
    playerAttente: {
      ...defaults.playerAttente,
      ...data.playerAttente,
      titleLine1:
        data.playerAttente?.titleLine1
        ?? (typeof data.playerAttente?.title === "string" ? data.playerAttente.title : null)
        ?? oldPQ.preStartTitle
        ?? defaults.playerAttente.titleLine1,
      titleLine2: data.playerAttente?.titleLine2 ?? defaults.playerAttente.titleLine2,
    },
    playerQuiz: {
      ...defaults.playerQuiz,
      ...data.playerQuizPage,
      correctAnswer: data.playerQuizPage?.correctAnswer ?? oldPQ.correctAnswer ?? defaults.playerQuiz.correctAnswer,
      pointsEarned: data.playerQuizPage?.pointsEarned ?? oldPQ.pointsEarned ?? defaults.playerQuiz.pointsEarned,
    },
    playerFin: {
      ...defaults.playerFin,
      ...data.playerFin,
      endOfQuizTitle: data.playerFin?.endOfQuizTitle ?? oldPQ.endOfQuizTitle ?? defaults.playerFin.endOfQuizTitle,
      endOfRoundTitle: data.playerFin?.endOfRoundTitle ?? oldPQ.endOfRoundTitle ?? defaults.playerFin.endOfRoundTitle,
      pauseTitle: data.playerFin?.pauseTitle ?? oldPQ.pauseTitle ?? defaults.playerFin.pauseTitle,
      pauseSubtitle: data.playerFin?.pauseSubtitle ?? oldPQ.pauseSubtitle ?? defaults.playerFin.pauseSubtitle,
      thanks: data.playerFin?.thanks ?? oldPQ.thanks ?? defaults.playerFin.thanks,
    },
    playerEleyBuzz: {
      ...defaults.playerEleyBuzz,
      ...data.playerEleyBuzz,
    },
    screenAttente: {
      ...defaults.screenAttente,
      ...data.screenAttente,
      title: data.screenAttente?.title ?? oldSQ.preStartTitle ?? defaults.screenAttente.title,
      message: data.screenAttente?.message ?? oldSQ.preStartMessage ?? defaults.screenAttente.message,
    },
    screenQuiz: {
      ...defaults.screenQuiz,
      ...data.screenQuizPage,
      pauseTitle: data.screenQuizPage?.pauseTitle ?? oldSQ.pauseTitle ?? defaults.screenQuiz.pauseTitle,
      pauseSubtitle: data.screenQuizPage?.pauseSubtitle ?? oldSQ.pauseSubtitle ?? defaults.screenQuiz.pauseSubtitle,
    },
    screenPodium: {
      ...defaults.screenPodium,
      ...data.screenPodium,
      endOfRound:
        data.screenPodium?.endOfRound
        ?? data.screenQuizPage?.endOfRound
        ?? oldSQ.endOfRound
        ?? defaults.screenPodium.endOfRound,
      podiumTitle: data.screenPodium?.podiumTitle ?? oldSQ.podiumTitle ?? defaults.screenPodium.podiumTitle,
      finalPodiumTitle: data.screenPodium?.finalPodiumTitle ?? oldSQ.finalPodiumTitle ?? defaults.screenPodium.finalPodiumTitle,
      finalPodiumTeams:
        data.screenPodium?.finalPodiumTeams
        ?? data.screenPodium?.podiumTitle
        ?? defaults.screenPodium.finalPodiumTeams,
      finalPodiumPlayers:
        data.screenPodium?.finalPodiumPlayers
        ?? defaults.screenPodium.finalPodiumPlayers,
    },
    screenEleyBuzz: {
      ...defaults.screenEleyBuzz,
      ...data.screenEleyBuzz,
    },
    lockMessages:
      Array.isArray(data.lockMessages) && data.lockMessages.length > 0
        ? data.lockMessages
        : defaults.lockMessages,
    revealPhrases:
      Array.isArray(data.revealPhrases) && data.revealPhrases.length > 0
        ? data.revealPhrases
        : defaults.revealPhrases,
  };
}

/** Alias legacy pour screen.js (lecture inchangée) */
function legacyScreenQuizPayload(messages) {
  return {
    preStartTitle: messages.screenAttente.title,
    preStartMessage: messages.screenAttente.message,
    podiumTitle: messages.screenPodium.podiumTitle,
    finalPodiumTitle: messages.screenPodium.finalPodiumTitle,
    pauseTitle: messages.screenQuiz.pauseTitle,
    pauseSubtitle: messages.screenQuiz.pauseSubtitle,
  };
}

function MessageField({ label, value, onChange, placeholder, description, multiline = false }) {
  const Component = multiline ? "textarea" : "input";
  const props = multiline
    ? {
        rows: 3,
        style: {
          width: "100%",
          padding: "8px 12px",
          borderRadius: 6,
          border: "1px solid #1f2a44",
          background: "#111",
          color: "#fff",
          fontSize: 16,
          fontFamily: "inherit",
          resize: "vertical",
        },
      }
    : {
        type: "text",
        style: {
          width: "100%",
          padding: "8px 12px",
          borderRadius: 6,
          border: "1px solid #1f2a44",
          background: "#111",
          color: "#fff",
          fontSize: 16,
        },
      };

  return (
    <div>
      <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>
        {label}
      </label>
      <Component
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        {...props}
      />
      {description && (
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7, fontStyle: "italic" }}>
          {description}
        </div>
      )}
    </div>
  );
}

function SectionSaveButton({ onSave, saving, saved, showDivider = true }) {
  return (
    <div
      style={{
        marginTop: showDivider ? 20 : 0,
        paddingTop: showDivider ? 16 : 0,
        borderTop: showDivider ? "1px solid #1f2a44" : "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
      }}
    >
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        style={{
          padding: "12px 24px",
          borderRadius: 8,
          border: "none",
          background: saving ? "#64748b" : "#22c55e",
          color: "#fff",
          fontWeight: 700,
          cursor: saving ? "not-allowed" : "pointer",
          fontSize: 16,
        }}
      >
        {saving ? "Sauvegarde…" : "💾 Sauvegarder"}
      </button>
      {saved && (
        <span style={{ color: "#10b981", fontWeight: 600, fontSize: 14, marginLeft: 4 }}>
          Messages sauvegardés ✔
        </span>
      )}
    </div>
  );
}

function PageSection({ title, subtitle, color, children, onSave, saving, saved }) {
  return (
    <section style={SECTION_STYLE}>
      <h2 style={{ fontSize: "1.5rem", marginBottom: subtitle ? 8 : 20, color }}>
        {title}
      </h2>
      {subtitle && (
        <p style={{ opacity: 0.75, marginBottom: 20, fontSize: 14 }}>{subtitle}</p>
      )}
      <div style={{ display: "grid", gap: 16 }}>{children}</div>
      {onSave && (
        <SectionSaveButton onSave={onSave} saving={saving} saved={saved} />
      )}
    </section>
  );
}

function MessagesInner() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saved, setSaved] = useState(false);
  const [messages, setMessages] = useState(createDefaultMessages);

  const setSectionField = (sectionKey, fieldKey, value) => {
    setMessages((prev) => ({
      ...prev,
      [sectionKey]: { ...prev[sectionKey], [fieldKey]: value },
    }));
  };

  useEffect(() => {
    async function loadMessages() {
      try {
        const configRef = doc(db, "quiz", "config");
        const snap = await getDoc(configRef);
        if (snap.exists()) {
          setMessages(mergeMessagesFromFirestore(snap.data()));
        }
      } catch (e) {
        console.error("Erreur lors du chargement des messages:", e);
        setNotice("Erreur lors du chargement des messages");
        setTimeout(() => setNotice(null), 3000);
      } finally {
        setLoading(false);
      }
    }

    loadMessages();
  }, []);

  async function saveMessages() {
    setSaving(true);
    setNotice(null);
    setSaved(false);

    try {
      const configRef = doc(db, "quiz", "config");
      await setDoc(
        configRef,
        {
          playerNomJoueur: messages.playerNomJoueur,
          playerEquipe: messages.playerEquipe,
          playerCreationEquipe: messages.playerCreationEquipe,
          playerRejoindreEquipe: messages.playerRejoindreEquipe,
          playerAttente: messages.playerAttente,
          playerQuizPage: messages.playerQuiz,
          playerFin: messages.playerFin,
          playerEleyBuzz: messages.playerEleyBuzz,
          screenAttente: messages.screenAttente,
          screenQuizPage: messages.screenQuiz,
          screenPodium: messages.screenPodium,
          screenEleyBuzz: messages.screenEleyBuzz,
          screenQuiz: legacyScreenQuizPayload(messages),
          lockMessages: messages.lockMessages.filter((m) => m && m.trim() !== ""),
          revealPhrases: messages.revealPhrases.filter((p) => p && p.trim() !== ""),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setNotice("Messages sauvegardés avec succès ✔");
      setSaved(true);
      setTimeout(() => {
        setNotice(null);
        setSaved(false);
      }, 3000);
    } catch (e) {
      console.error("Erreur lors de la sauvegarde:", e);
      setNotice("Erreur lors de la sauvegarde");
      setTimeout(() => setNotice(null), 3000);
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    if (!window.confirm("Réinitialiser tous les messages aux valeurs par défaut ?")) {
      return;
    }
    setMessages(createDefaultMessages());
  }

  const nom = messages.playerNomJoueur;
  const attente = messages.playerAttente;
  const quiz = messages.playerQuiz;
  const fin = messages.playerFin;
  const pBuzz = messages.playerEleyBuzz;
  const sAttente = messages.screenAttente;
  const sQuiz = messages.screenQuiz;
  const sPodium = messages.screenPodium;
  const sBuzz = messages.screenEleyBuzz;

  const sectionSaveProps = { onSave: saveMessages, saving, saved };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a1a",
          color: "#fff",
        }}
      >
        <div>Chargement des messages…</div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a1a",
        color: "#fff",
        padding: "40px 20px",
      }}
    >
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: 8 }}>Messages du Quiz</h1>
        <p style={{ opacity: 0.8, marginBottom: 32 }}>
          Messages organisés page par page, comme dans{" "}
          <code style={{ opacity: 0.9 }}>lib/messages.js</code>. Les valeurs par défaut viennent
          de ce fichier ; les changements ici sont sauvegardés dans Firestore.
        </p>

        {notice && (
          <div
            style={{
              padding: "12px 16px",
              background: notice.includes("succès") ? "#10b981" : "#ef4444",
              borderRadius: 8,
              marginBottom: 24,
              fontWeight: 600,
            }}
          >
            {notice}
          </div>
        )}

        <div style={{ display: "grid", gap: 24 }}>
          {/* ── PLAYER ── */}
          <h2 style={{ fontSize: "1.25rem", opacity: 0.6, margin: "8px 0 0", letterSpacing: 1 }}>
            📱 PLAYER
          </h2>

          <PageSection
            title="Création Joueur"
            subtitle="Page d'inscription — titre, champ nom, bouton Entrer"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre — ligne 1"
              value={nom.welcomeLine1}
              onChange={(v) => setSectionField("playerNomJoueur", "welcomeLine1", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.welcomeLine1}
            />
            <MessageField
              label="Titre — ligne 2"
              value={nom.welcomeLine2}
              onChange={(v) => setSectionField("playerNomJoueur", "welcomeLine2", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.welcomeLine2}
            />
            <MessageField
              label="Label au-dessus du champ"
              value={nom.chooseNameLabel}
              onChange={(v) => setSectionField("playerNomJoueur", "chooseNameLabel", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.chooseNameLabel}
            />
            <MessageField
              label="Placeholder du champ"
              value={nom.namePlaceholder}
              onChange={(v) => setSectionField("playerNomJoueur", "namePlaceholder", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.namePlaceholder}
            />
            <MessageField
              label="Indication sous le champ"
              value={nom.maxCharsHint}
              onChange={(v) => setSectionField("playerNomJoueur", "maxCharsHint", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.maxCharsHint}
            />
            <MessageField
              label="Bouton Entrer"
              value={nom.enterButton}
              onChange={(v) => setSectionField("playerNomJoueur", "enterButton", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.enterButton}
            />
            <MessageField
              label="Bouton Entrer (chargement)"
              value={nom.enterButtonBusy}
              onChange={(v) => setSectionField("playerNomJoueur", "enterButtonBusy", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.enterButtonBusy}
            />
            <MessageField
              label="Nom refusé par l'animateur"
              value={nom.nameRejectedByAdmin}
              onChange={(v) => setSectionField("playerNomJoueur", "nameRejectedByAdmin", v)}
              placeholder={PLAYER_PAGE_CREATION_JOUEUR.nameRejectedByAdmin}
              multiline
            />
          </PageSection>

          <PageSection
            title="Equipe"
            subtitle="Choix créer ou rejoindre une équipe"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre — ligne 1"
              value={messages.playerEquipe.titleLine1}
              onChange={(v) => setSectionField("playerEquipe", "titleLine1", v)}
              placeholder={PLAYER_PAGE_EQUIPE.titleLine1}
            />
            <MessageField
              label="Titre — ligne 2"
              value={messages.playerEquipe.titleLine2}
              onChange={(v) => setSectionField("playerEquipe", "titleLine2", v)}
              placeholder={PLAYER_PAGE_EQUIPE.titleLine2}
            />
            <MessageField
              label="Texte sous le titre"
              value={messages.playerEquipe.choiceHint}
              onChange={(v) => setSectionField("playerEquipe", "choiceHint", v)}
              placeholder={PLAYER_PAGE_EQUIPE.choiceHint}
            />
            <MessageField
              label="Message — quitter avant de créer"
              value={messages.playerEquipe.mustLeaveBeforeCreate}
              onChange={(v) => setSectionField("playerEquipe", "mustLeaveBeforeCreate", v)}
              placeholder={PLAYER_PAGE_EQUIPE.mustLeaveBeforeCreate}
              description="Affiché sur « Choisis ton équipe » si le joueur clique sur Créer sans avoir quitté son équipe"
            />
            <MessageField
              label="Bouton créer une équipe"
              value={messages.playerEquipe.createButton}
              onChange={(v) => setSectionField("playerEquipe", "createButton", v)}
              placeholder={PLAYER_PAGE_EQUIPE.createButton}
            />
            <MessageField
              label="Bouton rejoindre une équipe"
              value={messages.playerEquipe.joinButton}
              onChange={(v) => setSectionField("playerEquipe", "joinButton", v)}
              placeholder={PLAYER_PAGE_EQUIPE.joinButton}
            />
            <MessageField
              label="Bouton quitter l'équipe"
              value={messages.playerEquipe.leaveTeamButton}
              onChange={(v) => setSectionField("playerEquipe", "leaveTeamButton", v)}
              placeholder={PLAYER_PAGE_EQUIPE.leaveTeamButton}
              description="Utilisez {teamName} pour le nom de l'équipe"
            />
            <MessageField
              label="Seul dans l'équipe — intro"
              value={messages.playerEquipe.soloIntro}
              onChange={(v) => setSectionField("playerEquipe", "soloIntro", v)}
              placeholder={PLAYER_PAGE_EQUIPE.soloIntro}
            />
            <MessageField
              label="Seul dans l'équipe — suite"
              value={messages.playerEquipe.soloHint}
              onChange={(v) => setSectionField("playerEquipe", "soloHint", v)}
              placeholder={PLAYER_PAGE_EQUIPE.soloHint}
              multiline
            />
            <MessageField
              label="Bouton supprimer l'équipe"
              value={messages.playerEquipe.deleteTeamButton}
              onChange={(v) => setSectionField("playerEquipe", "deleteTeamButton", v)}
              placeholder={PLAYER_PAGE_EQUIPE.deleteTeamButton}
              description="Utilisez {teamName} pour le nom de l'équipe"
            />
            <MessageField
              label="Bouton supprimer (chargement)"
              value={messages.playerEquipe.deleteTeamButtonBusy}
              onChange={(v) => setSectionField("playerEquipe", "deleteTeamButtonBusy", v)}
              placeholder={PLAYER_PAGE_EQUIPE.deleteTeamButtonBusy}
            />
            <MessageField
              label="Bouton annuler"
              value={messages.playerEquipe.cancelButton}
              onChange={(v) => setSectionField("playerEquipe", "cancelButton", v)}
              placeholder={PLAYER_PAGE_EQUIPE.cancelButton}
            />
          </PageSection>

          <PageSection
            title="Création d'équipe"
            subtitle="Formulaire de création d'une nouvelle équipe"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre — ligne 1"
              value={messages.playerCreationEquipe.titleLine1}
              onChange={(v) => setSectionField("playerCreationEquipe", "titleLine1", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.titleLine1}
            />
            <MessageField
              label="Titre — ligne 2"
              value={messages.playerCreationEquipe.titleLine2}
              onChange={(v) => setSectionField("playerCreationEquipe", "titleLine2", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.titleLine2}
            />
            <MessageField
              label="Texte sous le titre"
              value={messages.playerCreationEquipe.hint}
              onChange={(v) => setSectionField("playerCreationEquipe", "hint", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.hint}
              multiline
            />
            <MessageField
              label="Placeholder du champ"
              value={messages.playerCreationEquipe.namePlaceholder}
              onChange={(v) => setSectionField("playerCreationEquipe", "namePlaceholder", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.namePlaceholder}
            />
            <MessageField
              label="Indication sous le champ"
              value={messages.playerCreationEquipe.maxCharsHint}
              onChange={(v) => setSectionField("playerCreationEquipe", "maxCharsHint", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.maxCharsHint}
            />
            <MessageField
              label="Bouton créer"
              value={messages.playerCreationEquipe.submitButton}
              onChange={(v) => setSectionField("playerCreationEquipe", "submitButton", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.submitButton}
            />
            <MessageField
              label="Bouton créer (chargement)"
              value={messages.playerCreationEquipe.submitButtonBusy}
              onChange={(v) => setSectionField("playerCreationEquipe", "submitButtonBusy", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.submitButtonBusy}
            />
            <MessageField
              label="Bouton annuler"
              value={messages.playerCreationEquipe.cancelButton}
              onChange={(v) => setSectionField("playerCreationEquipe", "cancelButton", v)}
              placeholder={PLAYER_PAGE_CREATION_EQUIPE.cancelButton}
            />
          </PageSection>

          <PageSection
            title="Rejoindre une équipe"
            subtitle="Recherche et liste des équipes existantes"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre — ligne 1"
              value={messages.playerRejoindreEquipe.titleLine1}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "titleLine1", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.titleLine1}
            />
            <MessageField
              label="Titre — ligne 2"
              value={messages.playerRejoindreEquipe.titleLine2}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "titleLine2", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.titleLine2}
            />
            <MessageField
              label="Texte sous le titre"
              value={messages.playerRejoindreEquipe.hint}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "hint", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.hint}
            />
            <MessageField
              label="Message — déjà dans une équipe"
              value={messages.playerRejoindreEquipe.alreadyInTeamWarning}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "alreadyInTeamWarning", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.alreadyInTeamWarning}
              description="Affiché en rouge sur « Rejoins une équipe » si le joueur est encore membre d'une équipe"
              multiline
            />
            <MessageField
              label="Placeholder recherche"
              value={messages.playerRejoindreEquipe.searchPlaceholder}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "searchPlaceholder", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.searchPlaceholder}
            />
            <MessageField
              label="Aucun résultat"
              value={messages.playerRejoindreEquipe.noResults}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "noResults", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.noResults}
              description='Utilisez {query} pour la recherche'
            />
            <MessageField
              label="Aucune équipe disponible"
              value={messages.playerRejoindreEquipe.noTeamsAvailable}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "noTeamsAvailable", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.noTeamsAvailable}
            />
            <MessageField
              label="Membre (singulier)"
              value={messages.playerRejoindreEquipe.memberSingular}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "memberSingular", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.memberSingular}
            />
            <MessageField
              label="Membres (pluriel)"
              value={messages.playerRejoindreEquipe.memberPlural}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "memberPlural", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.memberPlural}
            />
            <MessageField
              label="Bouton annuler"
              value={messages.playerRejoindreEquipe.cancelButton}
              onChange={(v) => setSectionField("playerRejoindreEquipe", "cancelButton", v)}
              placeholder={PLAYER_PAGE_REJOINDRE_EQUIPE.cancelButton}
            />
          </PageSection>

          <PageSection
            title="Attente"
            subtitle="Joueur inscrit, quiz pas encore lancé"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre — ligne 1"
              value={attente.titleLine1}
              onChange={(v) => setSectionField("playerAttente", "titleLine1", v)}
              placeholder={PLAYER_PAGE_ATTENTE.titleLine1}
            />
            <MessageField
              label="Titre — ligne 2"
              value={attente.titleLine2}
              onChange={(v) => setSectionField("playerAttente", "titleLine2", v)}
              placeholder={PLAYER_PAGE_ATTENTE.titleLine2}
            />
            <MessageField
              label="Changer de nom — hint"
              value={attente.changeNameHint}
              onChange={(v) => setSectionField("playerAttente", "changeNameHint", v)}
              placeholder={PLAYER_PAGE_ATTENTE.changeNameHint}
            />
            <MessageField
              label="Bouton modifier le nom"
              value={attente.changeNameButton}
              onChange={(v) => setSectionField("playerAttente", "changeNameButton", v)}
              placeholder={PLAYER_PAGE_ATTENTE.changeNameButton}
            />
            <MessageField
              label="Changer d'équipe — hint"
              value={attente.changeTeamHint}
              onChange={(v) => setSectionField("playerAttente", "changeTeamHint", v)}
              placeholder={PLAYER_PAGE_ATTENTE.changeTeamHint}
            />
            <MessageField
              label="Bouton changer d'équipe"
              value={attente.changeTeamButton}
              onChange={(v) => setSectionField("playerAttente", "changeTeamButton", v)}
              placeholder={PLAYER_PAGE_ATTENTE.changeTeamButton}
            />
            <MessageField
              label="Nom verrouillé"
              value={attente.nameLocked}
              onChange={(v) => setSectionField("playerAttente", "nameLocked", v)}
              placeholder={PLAYER_PAGE_ATTENTE.nameLocked}
            />
          </PageSection>

          <PageSection
            title="Quiz"
            subtitle="Pendant le quiz — saisie et feedback"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Placeholder réponse"
              value={quiz.questionPlaceholder}
              onChange={(v) => setSectionField("playerQuiz", "questionPlaceholder", v)}
              placeholder={PLAYER_PAGE_QUIZ.questionPlaceholder}
            />
            <MessageField
              label="Bouton Valider"
              value={quiz.submitButton}
              onChange={(v) => setSectionField("playerQuiz", "submitButton", v)}
              placeholder={PLAYER_PAGE_QUIZ.submitButton}
            />
            <MessageField
              label="Cooldown anti-spam"
              value={quiz.lockAntiSpam}
              onChange={(v) => setSectionField("playerQuiz", "lockAntiSpam", v)}
              placeholder={PLAYER_PAGE_QUIZ.lockAntiSpam}
            />
            <MessageField
              label="Bonne réponse"
              value={quiz.correctAnswer}
              onChange={(v) => setSectionField("playerQuiz", "correctAnswer", v)}
              placeholder={PLAYER_PAGE_QUIZ.correctAnswer}
            />
            <MessageField
              label="Déjà répondu correctement"
              value={quiz.alreadyCorrect}
              onChange={(v) => setSectionField("playerQuiz", "alreadyCorrect", v)}
              placeholder={PLAYER_PAGE_QUIZ.alreadyCorrect}
            />
            <MessageField
              label="Mauvaise réponse (QCM)"
              value={quiz.qcmWrong}
              onChange={(v) => setSectionField("playerQuiz", "qcmWrong", v)}
              placeholder={PLAYER_PAGE_QUIZ.qcmWrong}
            />
            <MessageField
              label="Points joueur (préfixe, ex. « Tu marques »)"
              value={quiz.playerScored ?? quiz.pointsEarned}
              onChange={(v) => {
                setSectionField("playerQuiz", "playerScored", v);
                setSectionField("playerQuiz", "pointsEarned", v);
              }}
              placeholder={PLAYER_PAGE_QUIZ.playerScored}
            />
            <MessageField
              label="Reveal — phrase avant la réponse (ex. « La réponse était : »)"
              value={quiz.revealAnswer}
              onChange={(v) => setSectionField("playerQuiz", "revealAnswer", v)}
              placeholder={PLAYER_PAGE_QUIZ.revealAnswer}
            />
          </PageSection>

          <PageSection
            title="Fin / Pause"
            subtitle="Fin de manche, pause, fin de soirée"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre fin de quiz"
              value={fin.endOfQuizTitle}
              onChange={(v) => setSectionField("playerFin", "endOfQuizTitle", v)}
              placeholder={PLAYER_PAGE_FIN.endOfQuizTitle}
            />
            <MessageField
              label="Titre fin de manche"
              value={fin.endOfRoundTitle}
              onChange={(v) => setSectionField("playerFin", "endOfRoundTitle", v)}
              placeholder={PLAYER_PAGE_FIN.endOfRoundTitle}
            />
            <MessageField
              label="Podium provisoire — équipes"
              value={fin.provisionalPodiumTeams}
              onChange={(v) => setSectionField("playerFin", "provisionalPodiumTeams", v)}
              placeholder={PLAYER_PAGE_FIN.provisionalPodiumTeams}
            />
            <MessageField
              label="Podium provisoire — joueurs"
              value={fin.provisionalPodiumPlayers}
              onChange={(v) => setSectionField("playerFin", "provisionalPodiumPlayers", v)}
              placeholder={PLAYER_PAGE_FIN.provisionalPodiumPlayers}
            />
            <MessageField
              label="Fin de manche — rien n'est joué"
              value={fin.nothingDecided}
              onChange={(v) => setSectionField("playerFin", "nothingDecided", v)}
              placeholder={PLAYER_PAGE_FIN.nothingDecided}
            />
            <MessageField
              label="Podium final — équipes"
              value={fin.finalPodiumTeams}
              onChange={(v) => setSectionField("playerFin", "finalPodiumTeams", v)}
              placeholder={PLAYER_PAGE_FIN.finalPodiumTeams}
            />
            <MessageField
              label="Podium final — joueurs"
              value={fin.finalPodiumPlayers}
              onChange={(v) => setSectionField("playerFin", "finalPodiumPlayers", v)}
              placeholder={PLAYER_PAGE_FIN.finalPodiumPlayers}
            />
            <MessageField
              label="Sous-titre pause manche"
              value={fin.roundBreakSubtitle}
              onChange={(v) => setSectionField("playerFin", "roundBreakSubtitle", v)}
              placeholder={PLAYER_PAGE_FIN.roundBreakSubtitle}
            />
            <MessageField
              label="Transition"
              value={fin.transition}
              onChange={(v) => setSectionField("playerFin", "transition", v)}
              placeholder={PLAYER_PAGE_FIN.transition}
            />
            <MessageField
              label="Titre pause"
              value={fin.pauseTitle}
              onChange={(v) => setSectionField("playerFin", "pauseTitle", v)}
              placeholder={PLAYER_PAGE_FIN.pauseTitle}
            />
            <MessageField
              label="Sous-titre pause"
              value={fin.pauseSubtitle}
              onChange={(v) => setSectionField("playerFin", "pauseSubtitle", v)}
              placeholder={PLAYER_PAGE_FIN.pauseSubtitle}
            />
            <MessageField
              label="Titre scores fin de soirée"
              value={fin.finalScoreTitle}
              onChange={(v) => setSectionField("playerFin", "finalScoreTitle", v)}
              placeholder={PLAYER_PAGE_FIN.finalScoreTitle}
            />
            <MessageField
              label="Classement personnel (préfixe)"
              value={fin.personalRankPrefix}
              onChange={(v) => setSectionField("playerFin", "personalRankPrefix", v)}
              placeholder={PLAYER_PAGE_FIN.personalRankPrefix}
            />
            <MessageField
              label="Remerciement"
              value={fin.thanks}
              onChange={(v) => setSectionField("playerFin", "thanks", v)}
              placeholder={PLAYER_PAGE_FIN.thanks}
            />
            <MessageField
              label="En attente du démarrage"
              value={fin.waiting}
              onChange={(v) => setSectionField("playerFin", "waiting", v)}
              placeholder={PLAYER_PAGE_FIN.waiting}
            />
            <MessageField
              label="En attente 1ère question"
              value={fin.waitingFirstQuestion}
              onChange={(v) => setSectionField("playerFin", "waitingFirstQuestion", v)}
              placeholder={PLAYER_PAGE_FIN.waitingFirstQuestion}
            />
            <MessageField
              label="Aucune question"
              value={fin.noQuestions}
              onChange={(v) => setSectionField("playerFin", "noQuestions", v)}
              placeholder={PLAYER_PAGE_FIN.noQuestions}
            />
            <MessageField
              label="Synchronisation"
              value={fin.syncing}
              onChange={(v) => setSectionField("playerFin", "syncing", v)}
              placeholder={PLAYER_PAGE_FIN.syncing}
            />
          </PageSection>

          <PageSection
            title="EleyBuzz"
            subtitle="Mode buzzer sur le Player"
            color="#facc15"
            {...sectionSaveProps}
          >
            <MessageField
              label="Instructions (buzzer fermé)"
              value={pBuzz.idle}
              onChange={(v) => setSectionField("playerEleyBuzz", "idle", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.idle}
              multiline
            />
            <MessageField
              label="Buzzer ouvert"
              value={pBuzz.open}
              onChange={(v) => setSectionField("playerEleyBuzz", "open", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.open}
            />
            <MessageField
              label="Buzzer verrouillé"
              value={pBuzz.locked}
              onChange={(v) => setSectionField("playerEleyBuzz", "locked", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.locked}
            />
            <MessageField
              label="À toi de répondre"
              value={pBuzz.yourTurn}
              onChange={(v) => setSectionField("playerEleyBuzz", "yourTurn", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.yourTurn}
            />
            <MessageField
              label="Bonne réponse"
              value={pBuzz.correctAnswer}
              onChange={(v) => setSectionField("playerEleyBuzz", "correctAnswer", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.correctAnswer}
            />
            <MessageField
              label="Mauvaise réponse"
              value={pBuzz.wrongAnswer}
              onChange={(v) => setSectionField("playerEleyBuzz", "wrongAnswer", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.wrongAnswer}
            />
            <MessageField
              label="Punition"
              value={pBuzz.punishment}
              onChange={(v) => setSectionField("playerEleyBuzz", "punishment", v)}
              placeholder={ELEYBUZZ_PLAYER_MESSAGES.punishment}
              description="Utilisez {penalty} pour le nombre de points perdus"
              multiline
            />
          </PageSection>

          {/* ── SCREEN ── */}
          <h2 style={{ fontSize: "1.25rem", opacity: 0.6, margin: "8px 0 0", letterSpacing: 1 }}>
            🖥️ SCREEN
          </h2>

          <PageSection
            title="Attente"
            subtitle="Avant le lancement du quiz"
            color="#8b5cf6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Titre"
              value={sAttente.title}
              onChange={(v) => setSectionField("screenAttente", "title", v)}
              placeholder={SCREEN_PAGE_ATTENTE.title}
              description="Utilisez \\n pour un saut de ligne"
              multiline
            />
            <MessageField
              label="Message"
              value={sAttente.message}
              onChange={(v) => setSectionField("screenAttente", "message", v)}
              placeholder={SCREEN_PAGE_ATTENTE.message}
              description="Utilisez \\n pour un saut de ligne"
              multiline
            />
          </PageSection>

          <PageSection
            title="Quiz"
            subtitle="Pendant le quiz sur l'écran géant"
            color="#8b5cf6"
            {...sectionSaveProps}
          >
            <MessageField
              label="La manche commence"
              value={sQuiz.roundStarts}
              onChange={(v) => setSectionField("screenQuiz", "roundStarts", v)}
              placeholder={SCREEN_PAGE_QUIZ.roundStarts}
            />
            <MessageField
              label="… commence dans :"
              value={sQuiz.roundStartsIn}
              onChange={(v) => setSectionField("screenQuiz", "roundStartsIn", v)}
              placeholder={SCREEN_PAGE_QUIZ.roundStartsIn}
            />
            <MessageField
              label="Transition (fin de manche)"
              value={sQuiz.transition}
              onChange={(v) => setSectionField("screenQuiz", "transition", v)}
              placeholder={SCREEN_PAGE_QUIZ.transition}
            />
            <MessageField
              label="Titre pause"
              value={sQuiz.pauseTitle}
              onChange={(v) => setSectionField("screenQuiz", "pauseTitle", v)}
              placeholder={SCREEN_PAGE_QUIZ.pauseTitle}
            />
            <MessageField
              label="Sous-titre pause"
              value={sQuiz.pauseSubtitle}
              onChange={(v) => setSectionField("screenQuiz", "pauseSubtitle", v)}
              placeholder={SCREEN_PAGE_QUIZ.pauseSubtitle}
            />
            <MessageField
              label="Prochaine question dans :"
              value={sQuiz.nextQuestionIn}
              onChange={(v) => setSectionField("screenQuiz", "nextQuestionIn", v)}
              placeholder={SCREEN_PAGE_QUIZ.nextQuestionIn}
            />
            <MessageField
              label="Fin du quiz dans :"
              value={sQuiz.endOfQuizIn}
              onChange={(v) => setSectionField("screenQuiz", "endOfQuizIn", v)}
              placeholder={SCREEN_PAGE_QUIZ.endOfQuizIn}
            />
            <MessageField
              label="Fin de la manche dans : (préfixe)"
              value={sQuiz.endOfRoundIn}
              onChange={(v) => setSectionField("screenQuiz", "endOfRoundIn", v)}
              placeholder={SCREEN_PAGE_QUIZ.endOfRoundIn}
              description="Suivi du numéro de manche et de « dans : » (ex. Fin de la manche 3 dans :)"
            />
            <MessageField
              label="Reveal — phrase avant la réponse (ex. « La réponse était : »)"
              value={sQuiz.revealAnswer}
              onChange={(v) => setSectionField("screenQuiz", "revealAnswer", v)}
              placeholder={SCREEN_PAGE_QUIZ.revealAnswer}
            />
            <MessageField
              label="Bravo à :"
              value={sQuiz.congratsTo}
              onChange={(v) => setSectionField("screenQuiz", "congratsTo", v)}
              placeholder={SCREEN_PAGE_QUIZ.congratsTo}
            />
            <MessageField
              label="En attente du démarrage"
              value={sQuiz.waiting}
              onChange={(v) => setSectionField("screenQuiz", "waiting", v)}
              placeholder={SCREEN_PAGE_QUIZ.waiting}
            />
            <MessageField
              label="En attente 1ère question"
              value={sQuiz.waitingFirstQuestion}
              onChange={(v) => setSectionField("screenQuiz", "waitingFirstQuestion", v)}
              placeholder={SCREEN_PAGE_QUIZ.waitingFirstQuestion}
            />
            <MessageField
              label="Aucune question"
              value={sQuiz.noQuestions}
              onChange={(v) => setSectionField("screenQuiz", "noQuestions", v)}
              placeholder={SCREEN_PAGE_QUIZ.noQuestions}
            />
            <MessageField
              label="Synchronisation"
              value={sQuiz.syncing}
              onChange={(v) => setSectionField("screenQuiz", "syncing", v)}
              placeholder={SCREEN_PAGE_QUIZ.syncing}
            />
          </PageSection>

          <PageSection
            title="Fin de manche / Fin de quiz"
            subtitle="Podiums provisoires et finaux sur l'écran géant"
            color="#8b5cf6"
            {...sectionSaveProps}
          >
            <MessageField
              label="Fin de la manche (titre)"
              value={sPodium.endOfRound}
              onChange={(v) => setSectionField("screenPodium", "endOfRound", v)}
              placeholder={SCREEN_PAGE_PODIUM.endOfRound}
              description="Le numéro de manche est ajouté après (ex. Fin de la manche 3)"
            />
            <MessageField
              label="Podium provisoire — équipes"
              value={sPodium.provisionalPodiumTeams}
              onChange={(v) => setSectionField("screenPodium", "provisionalPodiumTeams", v)}
              placeholder={SCREEN_PAGE_PODIUM.provisionalPodiumTeams}
            />
            <MessageField
              label="Podium provisoire — joueurs"
              value={sPodium.provisionalPodiumPlayers}
              onChange={(v) => setSectionField("screenPodium", "provisionalPodiumPlayers", v)}
              placeholder={SCREEN_PAGE_PODIUM.provisionalPodiumPlayers}
            />
            <MessageField
              label="Fin de la manche — rien n'est joué"
              value={sPodium.nothingDecided}
              onChange={(v) => setSectionField("screenPodium", "nothingDecided", v)}
              placeholder={SCREEN_PAGE_PODIUM.nothingDecided}
            />
            <MessageField
              label="Fin de quiz (titre)"
              value={sPodium.endOfQuiz}
              onChange={(v) => setSectionField("screenPodium", "endOfQuiz", v)}
              placeholder={SCREEN_PAGE_PODIUM.endOfQuiz}
            />
            <MessageField
              label="Fin de quiz — podium final équipes"
              value={sPodium.finalPodiumTeams}
              onChange={(v) => setSectionField("screenPodium", "finalPodiumTeams", v)}
              placeholder={SCREEN_PAGE_PODIUM.finalPodiumTeams}
            />
            <MessageField
              label="Fin de quiz — podium final joueurs"
              value={sPodium.finalPodiumPlayers}
              onChange={(v) => setSectionField("screenPodium", "finalPodiumPlayers", v)}
              placeholder={SCREEN_PAGE_PODIUM.finalPodiumPlayers}
            />
            <MessageField
              label="Fin de quiz — remerciements"
              value={sPodium.quizEndThanks}
              onChange={(v) => setSectionField("screenPodium", "quizEndThanks", v)}
              placeholder={SCREEN_PAGE_PODIUM.quizEndThanks}
              multiline
            />
            <MessageField
              label="Fin de soirée — titre"
              value={sPodium.finalEveningTitle}
              onChange={(v) => setSectionField("screenPodium", "finalEveningTitle", v)}
              placeholder={SCREEN_PAGE_PODIUM.finalEveningTitle}
            />
            <MessageField
              label="Titre podium final (score EleyBox)"
              value={sPodium.finalPodiumTitle}
              onChange={(v) => setSectionField("screenPodium", "finalPodiumTitle", v)}
              placeholder={SCREEN_PAGE_PODIUM.finalPodiumTitle}
            />
            <MessageField
              label="Or / Argent / Bronze"
              value={sPodium.gold}
              onChange={(v) => setSectionField("screenPodium", "gold", v)}
              placeholder={SCREEN_PAGE_PODIUM.gold}
            />
            <MessageField
              label="Argent"
              value={sPodium.silver}
              onChange={(v) => setSectionField("screenPodium", "silver", v)}
              placeholder={SCREEN_PAGE_PODIUM.silver}
            />
            <MessageField
              label="Bronze"
              value={sPodium.bronze}
              onChange={(v) => setSectionField("screenPodium", "bronze", v)}
              placeholder={SCREEN_PAGE_PODIUM.bronze}
            />
            <MessageField
              label="Aucun point (fin)"
              value={sPodium.noPoints}
              onChange={(v) => setSectionField("screenPodium", "noPoints", v)}
              placeholder={SCREEN_PAGE_PODIUM.noPoints}
              multiline
            />
            <MessageField
              label="Aucun point (provisoire)"
              value={sPodium.noPointsYet}
              onChange={(v) => setSectionField("screenPodium", "noPointsYet", v)}
              placeholder={SCREEN_PAGE_PODIUM.noPointsYet}
            />
            <MessageField
              label="Titre classement (colonne droite)"
              value={sPodium.rankingTitle}
              onChange={(v) => setSectionField("screenPodium", "rankingTitle", v)}
              placeholder={SCREEN_PAGE_PODIUM.rankingTitle}
            />
            <MessageField
              label="Top N"
              value={sPodium.topN}
              onChange={(v) => setSectionField("screenPodium", "topN", v)}
              placeholder={SCREEN_PAGE_PODIUM.topN}
            />
            <MessageField
              label="Aucun joueur"
              value={sPodium.noPlayers}
              onChange={(v) => setSectionField("screenPodium", "noPlayers", v)}
              placeholder={SCREEN_PAGE_PODIUM.noPlayers}
            />
          </PageSection>

          <PageSection
            title="EleyBuzz"
            subtitle="Mode buzzer sur l'écran géant"
            color="#facc15"
            {...sectionSaveProps}
          >
            <MessageField
              label="Instructions (buzzer fermé)"
              value={sBuzz.idle}
              onChange={(v) => setSectionField("screenEleyBuzz", "idle", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.idle}
              multiline
            />
            <MessageField
              label="Buzzer ouvert"
              value={sBuzz.open}
              onChange={(v) => setSectionField("screenEleyBuzz", "open", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.open}
            />
            <MessageField
              label="On attend sa réponse"
              value={sBuzz.waitingAnswer}
              onChange={(v) => setSectionField("screenEleyBuzz", "waitingAnswer", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.waitingAnswer}
            />
            <MessageField
              label="Bravo"
              value={sBuzz.correctAnswer}
              onChange={(v) => setSectionField("screenEleyBuzz", "correctAnswer", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.correctAnswer}
            />
            <MessageField
              label="Tu gagnes"
              value={sBuzz.youWin}
              onChange={(v) => setSectionField("screenEleyBuzz", "youWin", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.youWin}
            />
            <MessageField
              label="Pts"
              value={sBuzz.pts}
              onChange={(v) => setSectionField("screenEleyBuzz", "pts", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.pts}
            />
            <MessageField
              label="Mauvaise réponse"
              value={sBuzz.wrongAnswer}
              onChange={(v) => setSectionField("screenEleyBuzz", "wrongAnswer", v)}
              placeholder={ELEYBUZZ_SCREEN_MESSAGES.wrongAnswer}
            />
          </PageSection>

          {/* ── DIVERS ── */}
          <h2 style={{ fontSize: "1.25rem", opacity: 0.6, margin: "8px 0 0", letterSpacing: 1 }}>
            ⚙️ DIVERS
          </h2>

          <PageSection
            title="Messages anti-spam"
            subtitle="Affichés aléatoirement quand un joueur spamme la saisie"
            color="#ef4444"
            {...sectionSaveProps}
          >
            {messages.lockMessages.map((msg, i) => (
              <div key={i}>
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>
                  Message {i + 1}
                </label>
                <input
                  type="text"
                  value={msg}
                  onChange={(e) => {
                    const next = [...messages.lockMessages];
                    next[i] = e.target.value;
                    setMessages({ ...messages, lockMessages: next });
                  }}
                  placeholder={LOCK_MESSAGES[i] || "Ex: Eh, arrête de spammer !"}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid #1f2a44",
                    background: "#111",
                    color: "#fff",
                    fontSize: 16,
                  }}
                />
              </div>
            ))}
          </PageSection>

          <PageSection
            title="Phrases de révélation"
            subtitle="Affichées aléatoirement lors de la révélation des réponses"
            color="#3b82f6"
            {...sectionSaveProps}
          >
            {messages.revealPhrases.map((phrase, i) => (
              <div key={i}>
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>
                  Phrase {i + 1}
                </label>
                <input
                  type="text"
                  value={phrase}
                  onChange={(e) => {
                    const next = [...messages.revealPhrases];
                    next[i] = e.target.value;
                    setMessages({ ...messages, revealPhrases: next });
                  }}
                  placeholder={DEFAULT_REVEAL_PHRASES[i] || "Ex: La réponse était :"}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid #1f2a44",
                    background: "#111",
                    color: "#fff",
                    fontSize: 16,
                  }}
                />
              </div>
            ))}
          </PageSection>
        </div>

        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 32,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <SectionSaveButton onSave={saveMessages} saving={saving} saved={saved} showDivider={false} />
          </div>

          <button
            onClick={resetToDefaults}
            style={{
              padding: "12px 24px",
              borderRadius: 8,
              border: "1px solid #1f2a44",
              background: "transparent",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            🔄 Réinitialiser aux valeurs par défaut
          </button>

          <a
            href="/"
            style={{
              padding: "12px 24px",
              borderRadius: 8,
              border: "1px solid #1f2a44",
              background: "#1f2937",
              color: "#fff",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
              fontSize: 16,
            }}
          >
            ← Retour à l'accueil
          </a>
        </div>
      </div>
    </div>
  );
}

export default function Messages() {
  return (
    <AuthGate
      title="Accès messages"
      subtitle="Réservé à l'organisation du quiz."
      accent="#22c55e"
    >
      <MessagesInner />
    </AuthGate>
  );
}
