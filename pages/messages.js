// ============================================================================
// pages/messages.js
// Page de configuration des messages du quiz
// ============================================================================

import { useState, useEffect } from "react";
import { db } from "../lib/firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import {
  PLAYER_MESSAGES,
  ELEYBUZZ_PLAYER_MESSAGES,
  SCREEN_MESSAGES,
  ELEYBUZZ_SCREEN_MESSAGES,
  LOCK_MESSAGES,
  DEFAULT_REVEAL_PHRASES,
} from "../lib/messages";

// Composant pour un champ de message
function MessageField({ label, value, onChange, placeholder, description, multiline = false }) {
  const Component = multiline ? "textarea" : "input";
  const props = multiline
    ? { rows: 3, style: { width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #1f2a44", background: "#111", color: "#fff", fontSize: 16, fontFamily: "inherit", resize: "vertical" } }
    : { type: "text", style: { width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #1f2a44", background: "#111", color: "#fff", fontSize: 16 } };

  return (
    <div>
      <label
        style={{
          display: "block",
          marginBottom: 8,
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {label}
      </label>
      <Component
        value={value}
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

export default function Messages() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saved, setSaved] = useState(false);

  // Valeurs par défaut depuis messages.js
  const [messages, setMessages] = useState({
    // Player - Quiz
    playerQuiz: {
      welcomeTitle: PLAYER_MESSAGES.welcomeTitle,
      welcomeSubtitle: PLAYER_MESSAGES.welcomeSubtitle,
      preStartTitle: PLAYER_MESSAGES.preStartTitle,
      preStartMessage: PLAYER_MESSAGES.preStartMessage,
      correctAnswer: PLAYER_MESSAGES.correctAnswer,
      pointsEarned: PLAYER_MESSAGES.pointsEarned,
      endOfQuizTitle: PLAYER_MESSAGES.endOfQuizTitle,
      endOfRoundTitle: PLAYER_MESSAGES.endOfRoundTitle,
      pauseTitle: PLAYER_MESSAGES.pauseTitle,
      pauseSubtitle: PLAYER_MESSAGES.pauseSubtitle,
      thanks: PLAYER_MESSAGES.thanks,
    },
    // Player - EleyBuzz
    playerEleyBuzz: {
      idle: ELEYBUZZ_PLAYER_MESSAGES.idle,
      open: ELEYBUZZ_PLAYER_MESSAGES.open,
      locked: ELEYBUZZ_PLAYER_MESSAGES.locked,
      yourTurn: ELEYBUZZ_PLAYER_MESSAGES.yourTurn,
      correctAnswer: ELEYBUZZ_PLAYER_MESSAGES.correctAnswer,
      wrongAnswer: ELEYBUZZ_PLAYER_MESSAGES.wrongAnswer,
      waitNextQuestion: ELEYBUZZ_PLAYER_MESSAGES.waitNextQuestion,
      tryYourChance: ELEYBUZZ_PLAYER_MESSAGES.tryYourChance,
      punishment: ELEYBUZZ_PLAYER_MESSAGES.punishment,
    },
    // Screen - Quiz
    screenQuiz: {
      preStartTitle: SCREEN_MESSAGES.preStartTitle,
      preStartMessage: SCREEN_MESSAGES.preStartMessage,
      podiumTitle: SCREEN_MESSAGES.podiumTitle,
      finalPodiumTitle: SCREEN_MESSAGES.finalPodiumTitle,
      pauseTitle: SCREEN_MESSAGES.pauseTitle,
      pauseSubtitle: SCREEN_MESSAGES.pauseSubtitle,
    },
    // Screen - EleyBuzz
    screenEleyBuzz: {
      idle: ELEYBUZZ_SCREEN_MESSAGES.idle,
      open: ELEYBUZZ_SCREEN_MESSAGES.open,
      waitingAnswer: ELEYBUZZ_SCREEN_MESSAGES.waitingAnswer,
      correctAnswer: ELEYBUZZ_SCREEN_MESSAGES.correctAnswer,
      youWin: ELEYBUZZ_SCREEN_MESSAGES.youWin,
      pts: ELEYBUZZ_SCREEN_MESSAGES.pts,
      wrongAnswer: ELEYBUZZ_SCREEN_MESSAGES.wrongAnswer,
    },
    // Messages anti-spam
    lockMessages: [...LOCK_MESSAGES],
    // Phrases de révélation
    revealPhrases: [...DEFAULT_REVEAL_PHRASES],
  });

  // Charger la configuration depuis Firestore
  useEffect(() => {
    async function loadMessages() {
      try {
        const configRef = doc(db, "quiz", "config");
        const snap = await getDoc(configRef);

        if (snap.exists()) {
          const data = snap.data() || {};
          
          // Charger les messages sauvegardés ou utiliser les valeurs par défaut
          setMessages({
            playerQuiz: {
              welcomeTitle: data.playerQuiz?.welcomeTitle ?? PLAYER_MESSAGES.welcomeTitle,
              welcomeSubtitle: data.playerQuiz?.welcomeSubtitle ?? PLAYER_MESSAGES.welcomeSubtitle,
              preStartTitle: data.playerQuiz?.preStartTitle ?? PLAYER_MESSAGES.preStartTitle,
              preStartMessage: data.playerQuiz?.preStartMessage ?? PLAYER_MESSAGES.preStartMessage,
              correctAnswer: data.playerQuiz?.correctAnswer ?? PLAYER_MESSAGES.correctAnswer,
              pointsEarned: data.playerQuiz?.pointsEarned ?? PLAYER_MESSAGES.pointsEarned,
              endOfQuizTitle: data.playerQuiz?.endOfQuizTitle ?? PLAYER_MESSAGES.endOfQuizTitle,
              endOfRoundTitle: data.playerQuiz?.endOfRoundTitle ?? PLAYER_MESSAGES.endOfRoundTitle,
              pauseTitle: data.playerQuiz?.pauseTitle ?? PLAYER_MESSAGES.pauseTitle,
              pauseSubtitle: data.playerQuiz?.pauseSubtitle ?? PLAYER_MESSAGES.pauseSubtitle,
              thanks: data.playerQuiz?.thanks ?? PLAYER_MESSAGES.thanks,
            },
            playerEleyBuzz: {
              idle: data.playerEleyBuzz?.idle ?? ELEYBUZZ_PLAYER_MESSAGES.idle,
              open: data.playerEleyBuzz?.open ?? ELEYBUZZ_PLAYER_MESSAGES.open,
              locked: data.playerEleyBuzz?.locked ?? ELEYBUZZ_PLAYER_MESSAGES.locked,
              yourTurn: data.playerEleyBuzz?.yourTurn ?? ELEYBUZZ_PLAYER_MESSAGES.yourTurn,
              correctAnswer: data.playerEleyBuzz?.correctAnswer ?? ELEYBUZZ_PLAYER_MESSAGES.correctAnswer,
              wrongAnswer: data.playerEleyBuzz?.wrongAnswer ?? ELEYBUZZ_PLAYER_MESSAGES.wrongAnswer,
              waitNextQuestion: data.playerEleyBuzz?.waitNextQuestion ?? ELEYBUZZ_PLAYER_MESSAGES.waitNextQuestion,
              tryYourChance: data.playerEleyBuzz?.tryYourChance ?? ELEYBUZZ_PLAYER_MESSAGES.tryYourChance,
              punishment: data.playerEleyBuzz?.punishment ?? ELEYBUZZ_PLAYER_MESSAGES.punishment,
            },
            screenQuiz: {
              preStartTitle: data.screenQuiz?.preStartTitle ?? SCREEN_MESSAGES.preStartTitle,
              preStartMessage: data.screenQuiz?.preStartMessage ?? SCREEN_MESSAGES.preStartMessage,
              podiumTitle: data.screenQuiz?.podiumTitle ?? SCREEN_MESSAGES.podiumTitle,
              finalPodiumTitle: data.screenQuiz?.finalPodiumTitle ?? SCREEN_MESSAGES.finalPodiumTitle,
              pauseTitle: data.screenQuiz?.pauseTitle ?? SCREEN_MESSAGES.pauseTitle,
              pauseSubtitle: data.screenQuiz?.pauseSubtitle ?? SCREEN_MESSAGES.pauseSubtitle,
            },
            screenEleyBuzz: {
              idle: data.screenEleyBuzz?.idle ?? ELEYBUZZ_SCREEN_MESSAGES.idle,
              open: data.screenEleyBuzz?.open ?? ELEYBUZZ_SCREEN_MESSAGES.open,
              waitingAnswer: data.screenEleyBuzz?.waitingAnswer ?? ELEYBUZZ_SCREEN_MESSAGES.waitingAnswer,
              correctAnswer: data.screenEleyBuzz?.correctAnswer ?? ELEYBUZZ_SCREEN_MESSAGES.correctAnswer,
              youWin: data.screenEleyBuzz?.youWin ?? ELEYBUZZ_SCREEN_MESSAGES.youWin,
              pts: data.screenEleyBuzz?.pts ?? ELEYBUZZ_SCREEN_MESSAGES.pts,
              wrongAnswer: data.screenEleyBuzz?.wrongAnswer ?? ELEYBUZZ_SCREEN_MESSAGES.wrongAnswer,
            },
            lockMessages: Array.isArray(data.lockMessages) && data.lockMessages.length > 0
              ? data.lockMessages
              : [...LOCK_MESSAGES],
            revealPhrases: Array.isArray(data.revealPhrases) && data.revealPhrases.length > 0
              ? data.revealPhrases
              : [...DEFAULT_REVEAL_PHRASES],
          });
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

  // Sauvegarder la configuration
  async function saveMessages() {
    setSaving(true);
    setNotice(null);
    setSaved(false);

    try {
      const configRef = doc(db, "quiz", "config");
      await setDoc(
        configRef,
        {
          playerQuiz: messages.playerQuiz,
          playerEleyBuzz: messages.playerEleyBuzz,
          screenQuiz: messages.screenQuiz,
          screenEleyBuzz: messages.screenEleyBuzz,
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

  // Réinitialiser aux valeurs par défaut
  function resetToDefaults() {
    if (!window.confirm("Réinitialiser tous les messages aux valeurs par défaut ?")) {
      return;
    }

    setMessages({
      playerQuiz: {
        welcomeTitle: PLAYER_MESSAGES.welcomeTitle,
        welcomeSubtitle: PLAYER_MESSAGES.welcomeSubtitle,
        preStartTitle: PLAYER_MESSAGES.preStartTitle,
        preStartMessage: PLAYER_MESSAGES.preStartMessage,
        correctAnswer: PLAYER_MESSAGES.correctAnswer,
        pointsEarned: PLAYER_MESSAGES.pointsEarned,
        endOfQuizTitle: PLAYER_MESSAGES.endOfQuizTitle,
        endOfRoundTitle: PLAYER_MESSAGES.endOfRoundTitle,
        pauseTitle: PLAYER_MESSAGES.pauseTitle,
        pauseSubtitle: PLAYER_MESSAGES.pauseSubtitle,
        thanks: PLAYER_MESSAGES.thanks,
      },
      playerEleyBuzz: {
        idle: ELEYBUZZ_PLAYER_MESSAGES.idle,
        open: ELEYBUZZ_PLAYER_MESSAGES.open,
        locked: ELEYBUZZ_PLAYER_MESSAGES.locked,
        yourTurn: ELEYBUZZ_PLAYER_MESSAGES.yourTurn,
        correctAnswer: ELEYBUZZ_PLAYER_MESSAGES.correctAnswer,
        wrongAnswer: ELEYBUZZ_PLAYER_MESSAGES.wrongAnswer,
        waitNextQuestion: ELEYBUZZ_PLAYER_MESSAGES.waitNextQuestion,
        tryYourChance: ELEYBUZZ_PLAYER_MESSAGES.tryYourChance,
        punishment: ELEYBUZZ_PLAYER_MESSAGES.punishment,
      },
      screenQuiz: {
        preStartTitle: SCREEN_MESSAGES.preStartTitle,
        preStartMessage: SCREEN_MESSAGES.preStartMessage,
        podiumTitle: SCREEN_MESSAGES.podiumTitle,
        finalPodiumTitle: SCREEN_MESSAGES.finalPodiumTitle,
        pauseTitle: SCREEN_MESSAGES.pauseTitle,
        pauseSubtitle: SCREEN_MESSAGES.pauseSubtitle,
      },
      screenEleyBuzz: {
        idle: ELEYBUZZ_SCREEN_MESSAGES.idle,
        open: ELEYBUZZ_SCREEN_MESSAGES.open,
        waitingAnswer: ELEYBUZZ_SCREEN_MESSAGES.waitingAnswer,
        correctAnswer: ELEYBUZZ_SCREEN_MESSAGES.correctAnswer,
        youWin: ELEYBUZZ_SCREEN_MESSAGES.youWin,
        pts: ELEYBUZZ_SCREEN_MESSAGES.pts,
        wrongAnswer: ELEYBUZZ_SCREEN_MESSAGES.wrongAnswer,
      },
      lockMessages: [...LOCK_MESSAGES],
      revealPhrases: [...DEFAULT_REVEAL_PHRASES],
    });
  }

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
          Modifiez les messages affichés dans l'application (Player et Screen). Les changements sont sauvegardés dans Firestore.
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
          {/* Section Player - Quiz */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#3b82f6" }}>
              📱 Player - Quiz
            </h2>
            <div style={{ display: "grid", gap: 16 }}>
              <MessageField
                label="Titre d'accueil"
                value={messages.playerQuiz.welcomeTitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, welcomeTitle: val } })}
                placeholder={PLAYER_MESSAGES.welcomeTitle}
                description="Titre affiché lors de l'inscription"
              />
              <MessageField
                label="Sous-titre d'accueil"
                value={messages.playerQuiz.welcomeSubtitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, welcomeSubtitle: val } })}
                placeholder={PLAYER_MESSAGES.welcomeSubtitle}
                description="Sous-titre affiché lors de l'inscription"
              />
              <MessageField
                label="Titre d'attente"
                value={messages.playerQuiz.preStartTitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, preStartTitle: val } })}
                placeholder={PLAYER_MESSAGES.preStartTitle}
                description="Titre affiché avant le démarrage du quiz"
              />
              <MessageField
                label="Message d'attente"
                value={messages.playerQuiz.preStartMessage}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, preStartMessage: val } })}
                placeholder={PLAYER_MESSAGES.preStartMessage}
                description="Message affiché avant le démarrage du quiz"
              />
              <MessageField
                label="Message de bonne réponse"
                value={messages.playerQuiz.correctAnswer}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, correctAnswer: val } })}
                placeholder={PLAYER_MESSAGES.correctAnswer}
                description="Message affiché quand le joueur répond correctement"
              />
              <MessageField
                label="Message de points gagnés"
                value={messages.playerQuiz.pointsEarned}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, pointsEarned: val } })}
                placeholder={PLAYER_MESSAGES.pointsEarned}
                description="Texte affiché avant le nombre de points (ex: 'Tu as marqué')"
              />
              <MessageField
                label="Titre fin de quiz"
                value={messages.playerQuiz.endOfQuizTitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, endOfQuizTitle: val } })}
                placeholder={PLAYER_MESSAGES.endOfQuizTitle}
              />
              <MessageField
                label="Titre fin de manche"
                value={messages.playerQuiz.endOfRoundTitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, endOfRoundTitle: val } })}
                placeholder={PLAYER_MESSAGES.endOfRoundTitle}
              />
              <MessageField
                label="Titre de pause"
                value={messages.playerQuiz.pauseTitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, pauseTitle: val } })}
                placeholder={PLAYER_MESSAGES.pauseTitle}
              />
              <MessageField
                label="Sous-titre de pause"
                value={messages.playerQuiz.pauseSubtitle}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, pauseSubtitle: val } })}
                placeholder={PLAYER_MESSAGES.pauseSubtitle}
              />
              <MessageField
                label="Message de remerciement"
                value={messages.playerQuiz.thanks}
                onChange={(val) => setMessages({ ...messages, playerQuiz: { ...messages.playerQuiz, thanks: val } })}
                placeholder={PLAYER_MESSAGES.thanks}
              />
            </div>
          </section>

          {/* Section Player - EleyBuzz */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#facc15" }}>
              ⚡ Player - EleyBuzz
            </h2>
            <div style={{ display: "grid", gap: 16 }}>
              <MessageField
                label="Instructions (buzzer fermé)"
                value={messages.playerEleyBuzz.idle}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, idle: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.idle}
                description="Message affiché quand le buzzer est fermé"
                multiline
              />
              <MessageField
                label="Message buzzer ouvert"
                value={messages.playerEleyBuzz.open}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, open: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.open}
              />
              <MessageField
                label="Message buzzer verrouillé"
                value={messages.playerEleyBuzz.locked}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, locked: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.locked}
                description="Message affiché aux autres joueurs quand quelqu'un a buzzé"
              />
              <MessageField
                label="Message 'À toi de répondre'"
                value={messages.playerEleyBuzz.yourTurn}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, yourTurn: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.yourTurn}
                description="Message affiché au joueur qui a buzzé en premier"
              />
              <MessageField
                label="Message bonne réponse"
                value={messages.playerEleyBuzz.correctAnswer}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, correctAnswer: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.correctAnswer}
              />
              <MessageField
                label="Message mauvaise réponse"
                value={messages.playerEleyBuzz.wrongAnswer}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, wrongAnswer: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.wrongAnswer}
              />
              <MessageField
                label="Message 'Attends la prochaine question'"
                value={messages.playerEleyBuzz.waitNextQuestion}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, waitNextQuestion: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.waitNextQuestion}
                description="Message affiché aux autres joueurs après une bonne réponse"
              />
              <MessageField
                label="Message 'À toi de tenter ta chance'"
                value={messages.playerEleyBuzz.tryYourChance}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, tryYourChance: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.tryYourChance}
                description="Message affiché aux autres joueurs après une mauvaise réponse"
              />
              <MessageField
                label="Message de punition"
                value={messages.playerEleyBuzz.punishment}
                onChange={(val) => setMessages({ ...messages, playerEleyBuzz: { ...messages.playerEleyBuzz, punishment: val } })}
                placeholder={ELEYBUZZ_PLAYER_MESSAGES.punishment}
                description="Message affiché au joueur qui a donné une mauvaise réponse"
                multiline
              />
            </div>
          </section>

          {/* Section Screen - Quiz */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#8b5cf6" }}>
              🖥️ Screen - Quiz
            </h2>
            <div style={{ display: "grid", gap: 16 }}>
              <MessageField
                label="Titre d'attente"
                value={messages.screenQuiz.preStartTitle}
                onChange={(val) => setMessages({ ...messages, screenQuiz: { ...messages.screenQuiz, preStartTitle: val } })}
                placeholder={SCREEN_MESSAGES.preStartTitle}
                description="Titre affiché avant le démarrage (utilisez \\n pour un saut de ligne)"
                multiline
              />
              <MessageField
                label="Message d'attente"
                value={messages.screenQuiz.preStartMessage}
                onChange={(val) => setMessages({ ...messages, screenQuiz: { ...messages.screenQuiz, preStartMessage: val } })}
                placeholder={SCREEN_MESSAGES.preStartMessage}
                description="Message affiché avant le démarrage (utilisez \\n pour un saut de ligne)"
                multiline
              />
              <MessageField
                label="Titre du podium"
                value={messages.screenQuiz.podiumTitle}
                onChange={(val) => setMessages({ ...messages, screenQuiz: { ...messages.screenQuiz, podiumTitle: val } })}
                placeholder={SCREEN_MESSAGES.podiumTitle}
              />
              <MessageField
                label="Titre du podium final"
                value={messages.screenQuiz.finalPodiumTitle}
                onChange={(val) => setMessages({ ...messages, screenQuiz: { ...messages.screenQuiz, finalPodiumTitle: val } })}
                placeholder={SCREEN_MESSAGES.finalPodiumTitle}
              />
              <MessageField
                label="Titre de pause"
                value={messages.screenQuiz.pauseTitle}
                onChange={(val) => setMessages({ ...messages, screenQuiz: { ...messages.screenQuiz, pauseTitle: val } })}
                placeholder={SCREEN_MESSAGES.pauseTitle}
              />
              <MessageField
                label="Sous-titre de pause"
                value={messages.screenQuiz.pauseSubtitle}
                onChange={(val) => setMessages({ ...messages, screenQuiz: { ...messages.screenQuiz, pauseSubtitle: val } })}
                placeholder={SCREEN_MESSAGES.pauseSubtitle}
              />
            </div>
          </section>

          {/* Section Screen - EleyBuzz */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#facc15" }}>
              ⚡ Screen - EleyBuzz
            </h2>
            <div style={{ display: "grid", gap: 16 }}>
              <MessageField
                label="Instructions (buzzer fermé)"
                value={messages.screenEleyBuzz.idle}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, idle: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.idle}
                description="Message affiché quand le buzzer est fermé"
                multiline
              />
              <MessageField
                label="Message buzzer ouvert"
                value={messages.screenEleyBuzz.open}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, open: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.open}
              />
              <MessageField
                label="Message 'On attend sa réponse'"
                value={messages.screenEleyBuzz.waitingAnswer}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, waitingAnswer: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.waitingAnswer}
              />
              <MessageField
                label="Message 'Bravo'"
                value={messages.screenEleyBuzz.correctAnswer}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, correctAnswer: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.correctAnswer}
                description="Premier mot du message de bonne réponse (ex: 'Bravo')"
              />
              <MessageField
                label="Message 'tu gagnes'"
                value={messages.screenEleyBuzz.youWin}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, youWin: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.youWin}
                description="Texte avant les points (ex: 'tu gagnes')"
              />
              <MessageField
                label="Abréviation 'pts'"
                value={messages.screenEleyBuzz.pts}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, pts: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.pts}
                description="Abréviation des points (ex: 'pts !')"
              />
              <MessageField
                label="Message mauvaise réponse"
                value={messages.screenEleyBuzz.wrongAnswer}
                onChange={(val) => setMessages({ ...messages, screenEleyBuzz: { ...messages.screenEleyBuzz, wrongAnswer: val } })}
                placeholder={ELEYBUZZ_SCREEN_MESSAGES.wrongAnswer}
              />
            </div>
          </section>

          {/* Section Messages anti-spam */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#ef4444" }}>
              🚫 Messages anti-spam
            </h2>
            <p style={{ opacity: 0.8, marginBottom: 16, fontSize: 14 }}>
              Ces messages sont affichés aléatoirement quand un joueur spam. Laissez un champ vide pour ne pas l'utiliser.
            </p>
            <div style={{ display: "grid", gap: 16 }}>
              {messages.lockMessages.map((msg, i) => (
                <div key={i}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: 8,
                      fontWeight: 600,
                      fontSize: 14,
                    }}
                  >
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
            </div>
          </section>

          {/* Section Phrases de révélation */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#3b82f6" }}>
              💬 Phrases de révélation
            </h2>
            <p style={{ opacity: 0.8, marginBottom: 16, fontSize: 14 }}>
              Ces phrases sont affichées aléatoirement lors de la révélation des réponses. 
              Laissez un champ vide pour ne pas l'utiliser.
            </p>
            <div style={{ display: "grid", gap: 16 }}>
              {messages.revealPhrases.map((phrase, i) => (
                <div key={i}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: 8,
                      fontWeight: 600,
                      fontSize: 14,
                    }}
                  >
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
            </div>
          </section>
        </div>

        {/* Boutons d'action */}
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 32,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <button
              onClick={saveMessages}
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
