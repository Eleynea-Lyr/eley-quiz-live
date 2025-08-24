// /pages/player.js
import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';

function normalize(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[a.length][b.length];
}

function isCloseEnough(input, expected, tolerance = 2) {
  return levenshteinDistance(input, expected) <= tolerance;
}

export default function Player() {
  const [questionsList, setQuestionsList] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    const fetchQuestions = async () => {
      const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
      const snapshot = await getDocs(q);
      const list = snapshot.docs.map(doc => doc.data());
      setQuestionsList(list);
    };
    fetchQuestions();
  }, []);

  const currentQuestion = questionsList[currentIndex];

  const checkAnswer = () => {
    if (!currentQuestion || !currentQuestion.answers) return;

    const userInput = normalize(answer);
    const accepted = currentQuestion.answers.map(normalize);

    const isCorrect = accepted.some(acc => acc === userInput || isCloseEnough(userInput, acc));
    setResult(isCorrect ? "correct" : "wrong");

    setTimeout(() => {
      setResult(null);
      setAnswer('');
      setCurrentIndex(prev => (prev + 1 < questionsList.length ? prev + 1 : prev));
    }, 3000);
  };

  return (
    <div style={{ background: '#0a0a1a', color: 'white', padding: '20px', height: '100vh', textAlign: 'center' }}>
      {currentQuestion ? (
        <>
          <h2 style={{ fontSize: '1.5rem' }}>{currentQuestion.text}</h2>

          {currentQuestion.imageUrl && (
            <img src={currentQuestion.imageUrl} alt="illustration" style={{ width: '80%', margin: '20px auto' }} />
          )}

          <input
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Votre réponse"
            style={{ width: '80%', padding: '10px', marginTop: '20px' }}
          />
          <button onClick={checkAnswer} style={{ display: 'block', margin: '20px auto' }}>Valider</button>

          {result === "correct" && <p style={{ color: 'lime' }}>✅ Bonne réponse coucouuu !</p>}
          {result === "wrong" && <p style={{ color: 'red' }}>❌ Mauvaise réponse</p>}
        </>
      ) : (
        <p>Chargement des questions...</p>
      )}
    </div>
  );
}
