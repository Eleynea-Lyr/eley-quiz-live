import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { auth } from "../lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { ADMIN_UIDS } from "../lib/constants";

export default function Home() {
  const router = useRouter();
  // Par défaut : vue "joueur" (la plus restrictive) pour ne JAMAIS exposer
  // les liens d'organisation à un visiteur lambda, même le temps d'un éclair.
  const [adminView, setAdminView] = useState(false);

  useEffect(() => {
    // La vue complète (hub d'organisation) s'affiche si :
    //  - on est sur la machine de l'animateur (localhost / 127.0.0.1), OU
    //  - l'utilisateur connecté est l'admin (uid autorisé).
    let isLocalhost = false;
    try {
      const h = window.location.hostname;
      isLocalhost = h === "localhost" || h === "127.0.0.1" || h === "[::1]";
    } catch {
      isLocalhost = false;
    }

    if (isLocalhost) setAdminView(true);

    const unsub = onAuthStateChanged(auth, (user) => {
      const isAdmin = !!user && ADMIN_UIDS.includes(user.uid);
      setAdminView(isLocalhost || isAdmin);
    });
    return () => unsub();
  }, []);

  // Précharger /player dès l'affichage (navigation plus rapide au clic)
  useEffect(() => {
    if (!adminView) router.prefetch("/player");
  }, [adminView, router]);

  const linkStyle = {
    color: "#38bdf8",
    textDecoration: "none",
    fontWeight: "bold",
  };
  const linkStyleHover = { textDecoration: "underline" };

  const pageStyle = {
    minHeight: "100vh",
    margin: 0,
    padding: "40px 50px",
    fontFamily: "Arial, sans-serif",
    textAlign: "center",
    backgroundColor: "#020617",
    color: "#f9fafb",
  };

  // ===== Vue JOUEUR (par défaut, pour le public) =====
  if (!adminView) {
    return (
      <div
        style={{
          ...pageStyle,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-start",
          paddingTop: "clamp(72px, 18vh, 140px)",
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        <h1 style={{ fontSize: "2rem", marginBottom: "1.5rem", marginTop: 0 }}>
          Le Quiz d&apos;Eley 🎶
        </h1>
        <Link
          href="/player"
          prefetch
          style={{
            display: "inline-block",
            padding: "18px 36px",
            borderRadius: 14,
            background: "#3b82f6",
            color: "#0b1120",
            fontSize: "1.4rem",
            fontWeight: 800,
            textDecoration: "none",
            boxShadow: "0 12px 30px rgba(59,130,246,0.35)",
          }}
        >
          Clique ici pour jouer
        </Link>
      </div>
    );
  }

  // ===== Vue ANIMATEUR (hub complet) =====
  return (
    <div style={pageStyle}>
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>
        Bienvenue sur le Quiz d&apos;Eley 🎶
      </h1>
      <p style={{ marginBottom: "1.5rem" }}>Accédez aux vues :</p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        <li style={{ marginBottom: "0.75rem" }}>
          <a
            href="/player"
            style={linkStyle}
            onMouseEnter={(e) => Object.assign(e.target.style, linkStyleHover)}
            onMouseLeave={(e) => Object.assign(e.target.style, linkStyle)}
          >
            Vue Joueur
          </a>
        </li>
        <li style={{ marginBottom: "0.75rem" }}>
          <a
            href="/admin"
            style={linkStyle}
            onMouseEnter={(e) => Object.assign(e.target.style, linkStyleHover)}
            onMouseLeave={(e) => Object.assign(e.target.style, linkStyle)}
          >
            Vue Admin
          </a>
        </li>
        <li style={{ marginBottom: "0.75rem" }}>
          <a
            href="/screen"
            style={linkStyle}
            onMouseEnter={(e) => Object.assign(e.target.style, linkStyleHover)}
            onMouseLeave={(e) => Object.assign(e.target.style, linkStyle)}
          >
            Écran de Scène
          </a>
        </li>
        <li style={{ marginBottom: "0.75rem" }}>
          <a
            href="/config"
            style={linkStyle}
            onMouseEnter={(e) => Object.assign(e.target.style, linkStyleHover)}
            onMouseLeave={(e) => Object.assign(e.target.style, linkStyle)}
          >
            ⚙️ Configuration
          </a>
        </li>
        <li style={{ marginBottom: "0.75rem" }}>
          <a
            href="/messages"
            style={linkStyle}
            onMouseEnter={(e) => Object.assign(e.target.style, linkStyleHover)}
            onMouseLeave={(e) => Object.assign(e.target.style, linkStyle)}
          >
            💬 Messages
          </a>
        </li>
      </ul>
    </div>
  );
}
