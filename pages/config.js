// ============================================================================
// pages/config.js
// Page de configuration des durées et paramètres du quiz
// ============================================================================

import { useState, useEffect } from "react";
import { db } from "../lib/firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { resetTimingConfigCache } from "../lib/firebase-helpers";
import {
  REVEAL_DURATION_SEC,
  COUNTDOWN_START_SEC,
  ROUND_START_INTRO_SEC,
  COOLDOWN_MS,
  BUZZER_COOLDOWN_MS,
  BUZZER_CORRECT_MESSAGE_DURATION_MS,
  BUZZER_WRONG_MESSAGE_DURATION_MS,
  DEFAULT_BUZZER_WRONG_PENALTY,
  DEFAULT_TIME_MUSIC_SEC,
  DEFAULT_BUZZER_COLLECT_WINDOW_MS,
} from "../lib/constants";

// Composant pour un champ de configuration
function ConfigField({ label, value, onChange, min, max, step = 1, unit, description }) {
  const handleChange = (e) => {
    const inputValue = e.target.value;
    if (inputValue === "" || inputValue === "-") {
      // Permettre la saisie vide temporairement
      return;
    }
    const val = parseFloat(inputValue);
    if (!isNaN(val) && Number.isFinite(val) && val >= min && val <= max) {
      onChange(val);
    }
  };

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
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <input
          type="number"
          value={value ?? ""}
          onChange={handleChange}
          min={min}
          max={max}
          step={step}
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid #1f2a44",
            background: "#111",
            color: "#fff",
            fontSize: 16,
            fontFamily: "monospace",
          }}
        />
        <span style={{ minWidth: 40, fontWeight: 600, color: "#94a3b8" }}>{unit}</span>
      </div>
      {description && (
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7, fontStyle: "italic" }}>
          {description}
        </div>
      )}
    </div>
  );
}

export default function Config() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saved, setSaved] = useState(false);

  // Valeurs par défaut depuis constants.js
  const [config, setConfig] = useState({
    revealDurationSec: REVEAL_DURATION_SEC,
    countdownStartSec: COUNTDOWN_START_SEC,
    roundStartIntroSec: ROUND_START_INTRO_SEC,
    cooldownMs: COOLDOWN_MS,
    buzzerCooldownMs: BUZZER_COOLDOWN_MS,
    buzzerCorrectMessageDurationMs: BUZZER_CORRECT_MESSAGE_DURATION_MS,
    buzzerWrongMessageDurationMs: BUZZER_WRONG_MESSAGE_DURATION_MS,
    buzzerWrongPenalty: DEFAULT_BUZZER_WRONG_PENALTY,
    buzzerCollectWindowMs: DEFAULT_BUZZER_COLLECT_WINDOW_MS,
    defaultTimeMusicSec: DEFAULT_TIME_MUSIC_SEC,
  });

  // Charger la configuration depuis Firestore
  useEffect(() => {
    async function loadConfig() {
      try {
        const configRef = doc(db, "quiz", "config");
        const snap = await getDoc(configRef);
        
        if (snap.exists()) {
          const data = snap.data() || {};
          setConfig({
            revealDurationSec: data.revealDurationSec ?? REVEAL_DURATION_SEC,
            countdownStartSec: data.countdownStartSec ?? COUNTDOWN_START_SEC,
            roundStartIntroSec: data.roundStartIntroSec ?? ROUND_START_INTRO_SEC,
            cooldownMs: data.cooldownMs ?? COOLDOWN_MS,
            buzzerCooldownMs: data.buzzerCooldownMs ?? BUZZER_COOLDOWN_MS,
            buzzerCorrectMessageDurationMs: data.buzzerCorrectMessageDurationMs ?? BUZZER_CORRECT_MESSAGE_DURATION_MS,
            buzzerWrongMessageDurationMs: data.buzzerWrongMessageDurationMs ?? BUZZER_WRONG_MESSAGE_DURATION_MS,
            buzzerWrongPenalty: data.buzzerWrongPenalty ?? DEFAULT_BUZZER_WRONG_PENALTY,
            buzzerCollectWindowMs: data.buzzerCollectWindowMs ?? DEFAULT_BUZZER_COLLECT_WINDOW_MS,
            defaultTimeMusicSec: data.defaultTimeMusicSec ?? DEFAULT_TIME_MUSIC_SEC,
          });
        }
      } catch (e) {
        console.error("Erreur lors du chargement de la config:", e);
        setNotice("Erreur lors du chargement de la configuration");
        setTimeout(() => setNotice(null), 3000);
      } finally {
        setLoading(false);
      }
    }

    loadConfig();
  }, []);

  // Sauvegarder la configuration
  async function saveConfig() {
    setSaving(true);
    setNotice(null);
    setSaved(false);

    try {
      const configRef = doc(db, "quiz", "config");
      await setDoc(
        configRef,
        {
          ...config,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      resetTimingConfigCache(); // Réinitialiser le cache pour que les autres pages utilisent les nouvelles valeurs
      setNotice("Configuration sauvegardée avec succès ✔");
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
    if (!window.confirm("Réinitialiser toutes les valeurs aux valeurs par défaut ?")) {
      return;
    }

    setConfig({
      revealDurationSec: REVEAL_DURATION_SEC,
      countdownStartSec: COUNTDOWN_START_SEC,
      roundStartIntroSec: ROUND_START_INTRO_SEC,
      cooldownMs: COOLDOWN_MS,
      buzzerCooldownMs: BUZZER_COOLDOWN_MS,
      buzzerCorrectMessageDurationMs: BUZZER_CORRECT_MESSAGE_DURATION_MS,
      buzzerWrongMessageDurationMs: BUZZER_WRONG_MESSAGE_DURATION_MS,
      buzzerWrongPenalty: DEFAULT_BUZZER_WRONG_PENALTY,
      buzzerCollectWindowMs: DEFAULT_BUZZER_COLLECT_WINDOW_MS,
      defaultTimeMusicSec: DEFAULT_TIME_MUSIC_SEC,
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
        <div>Chargement de la configuration…</div>
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
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: 8 }}>Configuration du Quiz</h1>
        <p style={{ opacity: 0.8, marginBottom: 32 }}>
          Modifiez les durées et paramètres de timing du quiz. Les changements sont sauvegardés dans Firestore.
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
          {/* Section Quiz Principal */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#3b82f6" }}>
              ⏱️ Durées du Quiz Principal
            </h2>

            <div style={{ display: "grid", gap: 16 }}>
              <ConfigField
                label="Durée de la phase Révélation (secondes)"
                value={config.revealDurationSec}
                onChange={(val) => setConfig({ ...config, revealDurationSec: val })}
                min={5}
                max={60}
                unit="s"
                description="Temps pendant lequel la réponse est affichée (défaut: 20s)"
              />

              <ConfigField
                label="Durée du décompte (secondes)"
                value={config.countdownStartSec}
                onChange={(val) => setConfig({ ...config, countdownStartSec: val })}
                min={3}
                max={10}
                unit="s"
                description="Temps du décompte avant la prochaine question (défaut: 5s)"
              />

              <ConfigField
                label="Durée de l'intro de manche (secondes)"
                value={config.roundStartIntroSec}
                onChange={(val) => setConfig({ ...config, roundStartIntroSec: val })}
                min={3}
                max={10}
                unit="s"
                description="Temps du décompte au début de chaque manche (défaut: 5s)"
              />

              <ConfigField
                label="Cooldown anti-spam (millisecondes)"
                value={config.cooldownMs}
                onChange={(val) => setConfig({ ...config, cooldownMs: val })}
                min={1000}
                max={30000}
                step={1000}
                unit="ms"
                description="Temps d'attente entre deux réponses (défaut: 5000ms = 5s)"
              />
            </div>
          </section>

          {/* Section EleyBuzz */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#facc15" }}>
              ⚡ Durées EleyBuzz
            </h2>

            <div style={{ display: "grid", gap: 16 }}>
              <ConfigField
                label="Cooldown après mauvaise réponse (millisecondes)"
                value={config.buzzerCooldownMs}
                onChange={(val) => setConfig({ ...config, buzzerCooldownMs: val })}
                min={5000}
                max={60000}
                step={1000}
                unit="ms"
                description="Temps d'attente avant de pouvoir rebuzzer après une mauvaise réponse (défaut: 20000ms = 20s)"
              />

              <ConfigField
                label="Durée message 'Bonne réponse' (millisecondes)"
                value={config.buzzerCorrectMessageDurationMs}
                onChange={(val) => setConfig({ ...config, buzzerCorrectMessageDurationMs: val })}
                min={1000}
                max={10000}
                step={500}
                unit="ms"
                description="Temps d'affichage du message de bonne réponse (défaut: 5000ms = 5s)"
              />

              <ConfigField
                label="Durée message 'Mauvaise réponse' (millisecondes)"
                value={config.buzzerWrongMessageDurationMs}
                onChange={(val) => setConfig({ ...config, buzzerWrongMessageDurationMs: val })}
                min={1000}
                max={10000}
                step={500}
                unit="ms"
                description="Temps d'affichage du message de mauvaise réponse (défaut: 3000ms = 3s)"
              />

              <ConfigField
                label="Pénalité pour mauvaise réponse (points)"
                value={config.buzzerWrongPenalty}
                onChange={(val) => setConfig({ ...config, buzzerWrongPenalty: val })}
                min={1}
                max={20}
                step={1}
                unit="pts"
                description="Nombre de points perdus pour une mauvaise réponse (défaut: 3 pts)"
              />

              <ConfigField
                label="Durée de la fenêtre de collecte des buzz (millisecondes)"
                value={config.buzzerCollectWindowMs}
                onChange={(val) => setConfig({ ...config, buzzerCollectWindowMs: val })}
                min={500}
                max={5000}
                step={100}
                unit="ms"
                description="Temps pendant lequel les buzz sont collectés avant sélection aléatoire pondérée (défaut: 1500ms = 1,5s)"
              />
            </div>
          </section>

          {/* Section Musique */}
          <section
            style={{
              background: "#0b0f1a",
              border: "1px solid #1f2a44",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: "1.5rem", marginBottom: 20, color: "#a78bfa" }}>
              🎵 Durées Musique
            </h2>

            <div style={{ display: "grid", gap: 16 }}>
              <ConfigField
                label="Durée par défaut de musique (secondes)"
                value={config.defaultTimeMusicSec}
                onChange={(val) => setConfig({ ...config, defaultTimeMusicSec: val })}
                min={20}
                max={120}
                unit="s"
                description="Durée par défaut pour TimeMusic lors de la création d'une question (défaut: 40s)"
              />
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
              onClick={saveConfig}
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
                Durée sauvegardée ✔
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

