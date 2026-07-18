import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { auth } from "../lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { ADMIN_UIDS } from "../lib/constants";
import { useMobileVH } from "../lib/firebase-helpers";
import BrandShell from "../lib/BrandShell";
import { btnPrimaryStyle } from "../lib/brand-theme";

export default function Home() {
  const router = useRouter();
  useMobileVH();
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
      <BrandShell
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          minHeight: "max(100dvh, calc(var(--vh, 1vh) * 100))",
          padding: "var(--eley-shell-pad)",
          paddingTop: `calc(var(--eley-shell-pad) + env(safe-area-inset-top, 0px))`,
          paddingBottom: `calc(var(--eley-shell-pad) + env(safe-area-inset-bottom, 0px))`,
          overflowX: "hidden",
        }}
      >
        <div
          style={{
            position: "relative",
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--eley-gap-stack)",
            width: "min(var(--eley-content-narrow), 100%)",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: "var(--eley-title-page)",
              fontWeight: 800,
              lineHeight: 1.12,
            }}
          >
            Le Quiz d&apos;Eley 🎶
          </h1>
          <Link
            href="/player"
            prefetch
            style={{
              ...btnPrimaryStyle,
              display: "inline-block",
              padding: "var(--eley-btn-pad-y) clamp(28px, 8vw, 36px)",
              fontSize: "var(--eley-btn-home)",
              textDecoration: "none",
              textAlign: "center",
            }}
          >
            Clique ici pour jouer
          </Link>
        </div>
      </BrandShell>
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
