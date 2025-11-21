export default function Home() {
  const linkStyle = {
    color: "#38bdf8",          // bleu clair (liens)
    textDecoration: "none",
    fontWeight: "bold",
  };

  const linkStyleHover = {
    textDecoration: "underline",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "40px 50px",
        fontFamily: "Arial, sans-serif",
        textAlign: "center",
        backgroundColor: "#020617", // fond bleu très foncé
        color: "#f9fafb",           // texte blanc
      }}
    >

      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>
        Bienvenue sur le Quiz d'Eley 🎶
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
      </ul>
    </div>
  );
}
