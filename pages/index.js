export default function Home() {
  return (
    <div style={{ padding: '50px', fontFamily: 'Arial', textAlign: 'center' }}>
      <h1>Bienvenue sur le Quiz Interactif 🎶</h1>
      <p>Accédez aux vues :</p>
      <ul>
        <li><a href="/player">Vue Joueur</a></li>
        <li><a href="/admin">Vue Admin</a></li>
        <li><a href="/screen">Écran de Scène</a></li>
      </ul>
    </div>
  );
}
