// ============================================================================
// lib/AuthGate.js
// Garde d'accès par authentification Firebase (email / mot de passe).
// Affiche `children` UNIQUEMENT si l'utilisateur connecté fait partie des
// administrateurs autorisés (ADMIN_UIDS). Sinon, affiche un écran de connexion.
//
// Remplace l'ancien "mot de passe en clair" (NEXT_PUBLIC_*), qui n'était pas une
// vraie sécurité car livré au navigateur.
// ============================================================================

import { useEffect, useState } from "react";
import { auth } from "./firebase";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { ADMIN_UIDS } from "./constants";

export default function AuthGate({
  title = "Accès réservé",
  subtitle = "",
  accent = "#3b82f6",
  children,
}) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
    return () => unsub();
  }, []);

  const isAdmin = !!user && ADMIN_UIDS.includes(user.uid);

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      if (!ADMIN_UIDS.includes(cred.user.uid)) {
        await signOut(auth);
        setError("Ce compte n'est pas autorisé pour cet accès.");
      }
    } catch {
      setError("Email ou mot de passe incorrect.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  const wrap = {
    minHeight: "calc(var(--vh, 1vh) * 100)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#020617",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    padding: 16,
  };

  if (!ready) {
    return <div style={wrap}>Chargement…</div>;
  }

  if (isAdmin) {
    return children;
  }

  return (
    <div style={wrap}>
      <form
        onSubmit={handleLogin}
        style={{
          padding: 24,
          borderRadius: 12,
          border: "1px solid #1f2937",
          background: "#030712",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minWidth: 280,
          maxWidth: 360,
          boxShadow: "0 20px 40px rgba(0,0,0,0.45)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, textAlign: "center" }}>
          {title}
        </h1>
        {subtitle ? (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8, textAlign: "center" }}>
            {subtitle}
          </p>
        ) : null}

        <label style={{ fontSize: 14, marginTop: 8 }}>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ fontSize: 14 }}>
          Mot de passe
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        {error ? (
          <p style={{ margin: 0, fontSize: 13, color: "#fca5a5", textAlign: "center" }}>
            {error}
          </p>
        ) : null}

        {user && !isAdmin ? (
          <button
            type="button"
            onClick={() => signOut(auth)}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              fontSize: 12,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Se déconnecter du compte actuel
          </button>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          style={{
            marginTop: 8,
            padding: "8px 12px",
            borderRadius: 8,
            border: "none",
            background: accent,
            color: "#0b1120",
            fontWeight: 700,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </div>
  );
}

const inputStyle = {
  marginTop: 4,
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #4b5563",
  background: "#020617",
  color: "#e5e7eb",
  outline: "none",
  boxSizing: "border-box",
};
