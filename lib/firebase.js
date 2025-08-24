// lib/firebase.js
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyD-sJeZyugrh_xUkCzQ2xBQzKy3WklYiTw",
  authDomain: "quizlive-892d0.firebaseapp.com",
  projectId: "quizlive-892d0",
  storageBucket: "quizlive-892d0.firebasestorage.app",
  messagingSenderId: "736686423494",
  appId: "1:736686423494:web:bfb83318ce8dfe374586c7"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);
