// /pages/admin.js
import { useState } from 'react';
import { db } from '../lib/firebase';
import { collection, addDoc } from 'firebase/firestore';

export default function Admin() {
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [feedback, setFeedback] = useState('');

  const addQuestion = async () => {
    if (!text.trim()) {
      setFeedback("Veuillez entrer une question.");
      return;
    }
    try {
      await addDoc(collection(db, "LesQuestions"), {
      text,
      answers: answers.split(',').map((a) => a.trim()),
      imageUrl,
      createdAt: new Date()
      });
      setText('');
      setFeedback("Question ajoutée !");
    } catch (error) {
      console.error("Erreur d'ajout :", error);
      setFeedback("Une erreur est survenue.");
    }
  };

  return (
    <div style={{ background: '#121212', color: 'white', padding: '20px', height: '100vh' }}>
      <h1>Interface Admin</h1>
      <input 
        type="text" 
        value={text} 
        onChange={(e) => setText(e.target.value)}
        placeholder="Nouvelle question" 
        style={{ width: '80%', padding: '10px', marginTop: '20px' }}
      />
      <input
        type="text"
        value={answers}
        onChange={(e) => setAnswers(e.target.value)}
        placeholder="Réponses acceptées (séparées par des virgules)"
        style={{ width: '80%', padding: '10px', marginTop: '10px' }}
      />
      <input
        type="text"
        value={imageUrl}
        onChange={(e) => setImageUrl(e.target.value)}
        placeholder="URL de l'image (optionnel)"
        style={{ width: '80%', padding: '10px', marginTop: '10px' }}
      />
      <button onClick={addQuestion} style={{ display: 'block', marginTop: '20px' }}>
        Ajouter Question
      </button>
      {feedback && <p style={{ marginTop: '10px' }}>{feedback}</p>}
    </div>
  );
}
