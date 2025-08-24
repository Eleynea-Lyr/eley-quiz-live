// /pages/screen.js
import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';

export default function Screen() {
  const [question, setQuestion] = useState(null);

  useEffect(() => {
    const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "desc"), limit(1));
    const unsub = onSnapshot(q, snapshot => {
      const data = snapshot.docs.map(doc => doc.data());
      if (data.length) setQuestion(data[0]);
    });
    return () => unsub();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'row', background: '#000814', color: 'white', height: '100vh' }}>
      <div style={{ flex: 2, padding: '40px' }}>
        {question ? (
          <>
            <h1 style={{ fontSize: '2rem' }}>{question.text}</h1>
            {question.imageUrl && (
              <img src={question.imageUrl} alt="illustration" style={{ width: '90%', marginTop: '20px' }} />
            )}
          </>
        ) : (
          <p>En attente de question...</p>
        )}
      </div>

      <div style={{ flex: 1, padding: '20px', background: '#001d3d' }}>
        <h2>Tableau des scores</h2>
        <p>(Les scores seront ajoutés ici plus tard)</p>
      </div>
    </div>
  );
}
