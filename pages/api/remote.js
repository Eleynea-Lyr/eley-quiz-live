// ============================================================================
// /pages/api/remote.js — Commandes Stream Deck → file d'attente Firestore
//
// Usage Stream Deck (plugin « Web Requests » / HTTP GET — PAS « Website ») :
//   https://TON-DOMAINE/api/remote?action=pause&secret=XXX
//
// Actions : start | pause | back | next
// Prérequis : Admin ouvert (même en arrière-plan) + Télécommande ON.
// ============================================================================

import { db } from "../../lib/firebase";
import {
  collection,
  addDoc,
  doc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";
import { REMOTE_ACTIONS } from "../../lib/quiz-seek";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = req.method === "POST" ? req.body || {} : {};
    const action = String(body.action || req.query.action || "")
      .trim()
      .toLowerCase();
    const secret = String(body.secret || req.query.secret || "").trim();

    if (!REMOTE_ACTIONS.includes(action)) {
      return res.status(400).json({
        ok: false,
        error: `action invalide (attendu: ${REMOTE_ACTIONS.join(", ")})`,
      });
    }
    if (!secret || secret.length < 8) {
      return res.status(401).json({ ok: false, error: "secret manquant" });
    }

    const stateSnap = await getDoc(doc(db, "quiz", "state"));
    const state = stateSnap.exists() ? stateSnap.data() : {};

    if (!state.streamDeckRemoteEnabled) {
      return res.status(403).json({
        ok: false,
        error: "Télécommande OFF — active-la dans Admin",
      });
    }

    const expected = String(state.streamDeckSecret || "").trim();
    if (!expected || secret !== expected) {
      return res.status(401).json({ ok: false, error: "secret invalide" });
    }

    await addDoc(collection(db, "quiz", "state", "remoteInbox"), {
      action,
      secret,
      createdAt: serverTimestamp(),
      source: "stream-deck",
    });

    return res.status(200).json({ ok: true, action });
  } catch (e) {
    console.error("[api/remote]", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "erreur serveur",
    });
  }
}
