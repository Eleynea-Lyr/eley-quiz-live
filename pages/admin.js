// /pages/admin.js
import { useEffect, useMemo, useState } from "react";
import { db, storage } from "../lib/firebase";
import {
  collection, query, orderBy, getDocs, doc, updateDoc, deleteDoc, addDoc, writeBatch, setDoc, serverTimestamp, onSnapshot, Timestamp,
} from "firebase/firestore";

import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

// ---------------- Helpers ----------------
function parseCSV(input = "") {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function toCSV(list = []) {
  return (list || []).join(", ");
}
function parseHMS(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  // hh:mm:ss | mm:ss | ss
  if (s.includes(":")) {
    const parts = s.split(":").map((p) => p.trim());
    if (parts.length > 3) return null;
    const [hStr, mStr, sStr] =
      parts.length === 3 ? parts : ["0", parts[0] || "0", parts[1] || "0"];
    const h = Number(hStr);
    const m = Number(mStr);
    const sec = Number(sStr);
    if (![h, m, sec].every((n) => Number.isFinite(n) && n >= 0)) return null;
    if (m >= 60 || sec >= 60) return null;
    return h * 3600 + m * 60 + sec;
  }
  function getTimeSec(q) {
    if (!q || typeof q !== "object") return Infinity;
    if (typeof q.timecodeSec === "number") return q.timecodeSec;
    if (typeof q.timecode === "number") return Math.round(q.timecode * 60);
    return Infinity;
  }

  // rétro-compat si un nombre seul (minutes décimales)
  const num = Number(s);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 60);
}
function formatHMS(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec;              // nouveau format en secondes
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60);   // rétro-compat minutes
  return Infinity; // non planifiée
}

// ---------------- Component ----------------
export default function Admin() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [savedRowId, setSavedRowId] = useState(null);
  const [roundOffsetsStr, setRoundOffsetsStr] = useState([
    "00:00:00", "00:16:00", "00:31:00", "00:46:00",
    "", "", "", ""
  ]);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([
    0, 960, 1860, 2760, null, null, null, null
  ]);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [needsOrderInit, setNeedsOrderInit] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);
  const plannedTimes = useMemo(
    () => items.map(getTimeSec).filter((t) => Number.isFinite(t)).sort((a, b) => a - b),
    [items]
  );
  const [revealPhrases, setRevealPhrases] = useState(["", "", "", "", ""]);

  const [newRevealPhrases, setNewRevealPhrases] = useState(["", "", "", "", ""]);
  const [editingQuestion, setEditingQuestion] = useState(null);

  // (optionnel – juste utile pour placeholders côté UI création)
  const DEFAULT_REVEAL_PHRASES = [
    "La réponse était :",
    "Il fallait trouver :",
    "C'était :",
    "La bonne réponse :",
    "Réponse :"
  ];

  // Quand tu charges une question en édition :
  useEffect(() => {
    if (!editingQuestion) return;
    const arr = Array.isArray(editingQuestion.revealPhrases) ? editingQuestion.revealPhrases : [];
    setNewRevealPhrases([
      arr[0] ?? "",
      arr[1] ?? "",
      arr[2] ?? "",
      arr[3] ?? "",
      arr[4] ?? "",
    ]);
  }, [editingQuestion]);


  const [newQ, setNewQ] = useState({
    text: "",
    answersCsv: "",
    timecodeStr: "", // hh:mm:ss
    imageFile: null,
  });

  // ---------- LOAD ----------
  const load = async () => {
    setLoading(true);
    const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setItems(arr);
    setLoading(false);

    const hasMissingOrder = arr.some((it) => typeof it.order !== "number");
    setNeedsOrderInit(hasMissingOrder);
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data();
      if (d && Array.isArray(d.roundOffsetsSec)) {
        const offs = d.roundOffsetsSec.slice(0, 8);
        while (offs.length < 8) offs.push(null);
        setRoundOffsetsSec(offs);
        setRoundOffsetsStr(offs.map((s) => (typeof s === "number" ? formatHMS(s) : "")));
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data();
      if (!d || !d.startAt) {
        setIsRunning(false);
        setIsPaused(false);
        setQuizStartMs(null);
        setPauseAtMs(null);
        setElapsedSec(0);
        return;
      }
      setIsRunning(!!d.isRunning);
      setIsPaused(!!d.isPaused);
      const startMs = d.startAt.seconds * 1000 + Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      setQuizStartMs(startMs);
      if (d.pauseAt && d.pauseAt.seconds != null) {
        const pms = d.pauseAt.seconds * 1000 + Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
        setPauseAtMs(pms);
      } else {
        setPauseAtMs(null);
      }
    });
    return () => unsub();
  }, []);


  useEffect(() => {
    if (!quizStartMs) {
      setElapsedSec(0);
      return;
    }
    if (isPaused && pauseAtMs) {
      const e = Math.floor((pauseAtMs - quizStartMs) / 1000);
      setElapsedSec(e < 0 ? 0 : e);
      return;
    }
    if (!isRunning) {
      setElapsedSec(0);
      return;
    }
    const tick = () => {
      const e = Math.floor((Date.now() - quizStartMs) / 1000);
      setElapsedSec(e < 0 ? 0 : e);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs]);




  // ---------- EDIT / SAVE ----------
  const handleFieldChange = (id, field, value) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, [field]: value };
        if (field === "answersCsv") next.answers = parseCSV(value);
        if (field === "timecodeStr") next.timecodeSec = parseHMS(value);
        return next;
      })
    );
  };

  const handleRoundOffsetChange = (i, value) => {
    setRoundOffsetsStr((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  const saveRoundOffsets = async (nextStrs) => {
    try {
      const secs = nextStrs.map((s) => {
        const t = (s || "").trim();
        if (!t) return null;               // vide => désactivée
        const v = parseHMS(t);
        if (v == null) throw new Error("format");
        return v;
      });
      await setDoc(doc(db, "quiz", "config"), { roundOffsetsSec: secs }, { merge: true });
      setRoundOffsetsSec(secs);
      setRoundOffsetsStr(secs.map((s) => (typeof s === "number" ? formatHMS(s) : "")));
      setNotice("Offsets enregistrés");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide (laisser vide pour désactiver)");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  const uploadImage = async (file) => {
    if (!file) return null;
    try {
      const storageRef = ref(
        storage,
        `questions/${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`
      );
      const task = uploadBytesResumable(storageRef, file);
      return await new Promise((resolve, reject) => {
        task.on(
          "state_changed",
          () => { },
          (err) => {
            console.error("[UPLOAD] Erreur:", err);
            alert("Échec de l’upload : " + (err?.message || err));
            reject(err);
          },
          async () => {
            const url = await getDownloadURL(task.snapshot.ref);
            resolve(url);
          }
        );
      });
    } catch (err) {
      console.error("Upload image failed:", err);
      alert("Échec de l’upload : " + (err?.message || err));
      return null;
    }
  };

  const handleImageChange = async (id, file) => {
    if (!file) return;
    handleFieldChange(id, "_imageUploading", true);
    const url = await uploadImage(file);
    if (url) handleFieldChange(id, "imageUrl", url);
    handleFieldChange(id, "_imageUploading", false);
  };

  const saveOne = async (it) => {
    try {
      setSavingId(it.id);

      const hasAnswersCsv = typeof it.answersCsv === "string";
      const hasTimecodeStr = typeof it.timecodeStr === "string";

      const cleanedRevealPhrases = revealPhrases
        .map(s => (s ?? '').trim())
        .filter(Boolean)       // on ne garde que les non vides
        .slice(0, 5);          // max 5

      const payload = {
        text: it.text ?? "",
        answers: hasAnswersCsv
          ? parseCSV(it.answersCsv)
          : Array.isArray(it.answers)
            ? it.answers
            : [],
        timecodeSec: hasTimecodeStr
          ? parseHMS(it.timecodeStr)
          : typeof it.timecodeSec === "number"
            ? it.timecodeSec
            : typeof it.timecode === "number" // rétro-compat minutes
              ? Math.round(it.timecode * 60)
              : null,
        imageUrl: it.imageUrl || "",
        order:
          typeof it.order === "number"
            ? it.order
            : (items.findIndex((x) => x.id === it.id) + 1) * 1000,
        revealPhrases: cleanedRevealPhrases, // peut être [] → fallback côté client
      };

      await updateDoc(doc(db, "LesQuestions", it.id), payload);

      setSavedRowId(it.id);
      setTimeout(() => setSavedRowId(null), 2000);
    } catch (err) {
      console.error("saveOne error:", err);
      alert("Échec de la modification : " + (err?.message || err));
    } finally {
      setSavingId(null);
      await load();
    }
  };

  const removeOne = async (id) => {
    if (!confirm("Supprimer cette question ?")) return;
    await deleteDoc(doc(db, "LesQuestions", id));
    await load();
  };

  // ---------- REORDER ----------
  const swapOrder = async (indexA, indexB) => {
    if (indexA < 0 || indexB < 0 || indexA >= items.length || indexB >= items.length) return;
    const a = items[indexA];
    const b = items[indexB];
    const batch = writeBatch(db);
    const docA = doc(db, "LesQuestions", a.id);
    const docB = doc(db, "LesQuestions", b.id);
    batch.update(docA, { order: b.order ?? (indexB + 1) * 1000 });
    batch.update(docB, { order: a.order ?? (indexA + 1) * 1000 });
    await batch.commit();
    await load();
  };

  // ---------- INIT ORDER (one-time) ----------
  const initOrder = async () => {
    const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
    const snap = await getDocs(q);
    const arr = snap.docs.map((d, i) => ({ id: d.id, ...d.data(), idx: i }));
    const batch = writeBatch(db);
    arr.forEach((it, i) => {
      batch.update(doc(db, "LesQuestions", it.id), { order: (i + 1) * 1000 });
    });
    await batch.commit();
    await load();
  };

  // ---------- CREATE ----------
  const createOne = async () => {
    try {
      setCreating(true);
      let imageUrl = "";
      if (newQ.imageFile) {
        imageUrl = (await uploadImage(newQ.imageFile)) || "";
      }
      const answers = parseCSV(newQ.answersCsv);
      const timecodeSec = parseHMS(newQ.timecodeStr);

      const order =
        items.length > 0
          ? Math.max(...items.map((x) => x.order || 0)) + 1000
          : 1000;

      const cleanedRevealPhrases = (newRevealPhrases ?? [])
        .map(s => (s ?? "").trim())
        .filter(Boolean)
        .slice(0, 5);

      await addDoc(collection(db, "LesQuestions"), {
        text: newQ.text || "",
        answers,
        timecodeSec, // secondes (ou null)
        imageUrl,
        createdAt: new Date(),
        order,
        revealPhrases: cleanedRevealPhrases, // peut être [] → fallback côté client
      });

      setNewQ({ text: "", answersCsv: "", timecodeStr: "", imageFile: null });
      setNewRevealPhrases(["", "", "", "", ""]); // ← nettoie les 5 champs après création OK
    } catch (err) {
      console.error("createOne error:", err);
      alert("Échec de la création : " + (err?.message || err));
    } finally {
      setCreating(false);
      await load();
    }
    setNewRevealPhrases(["", "", "", "", ""]);
  };

  // ---------- QUIZ CONTROL ----------
  const startQuiz = async () => {
    try {
      await setDoc(
        doc(db, "quiz", "state"),
        { isRunning: true, isPaused: false, startAt: serverTimestamp(), pauseAt: null },
        { merge: true }
      );
    } catch (err) {
      console.error("startQuiz error:", err);
      alert("Impossible de démarrer le quiz : " + (err?.message || err));
    }
  };

  const resetQuiz = async () => {
    try {
      await setDoc(
        doc(db, "quiz", "state"),
        { isRunning: false, isPaused: false, startAt: null, pauseAt: null },
        { merge: true }
      );
    } catch (err) {
      console.error("resetQuiz error:", err);
      alert("Impossible de réinitialiser : " + (err?.message || err));
    }
  };

  const pauseQuiz = async () => {
    try {
      await setDoc(
        doc(db, "quiz", "state"),
        { isPaused: true, pauseAt: serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      console.error("pauseQuiz error:", err);
      alert("Impossible de mettre en pause : " + (err?.message || err));
    }
  };

  const startOrNextRound = async () => {
    const actives = roundOffsetsSec.filter((t) => typeof t === "number").sort((a, b) => a - b);
    const firstActive = actives[0] ?? 0;

    if (!isRunning || !quizStartMs) {
      await seekTo(firstActive);
      return;
    }
    if (isPaused) {
      if (typeof nextRoundOffsetSec === "number") {
        await seekTo(nextRoundOffsetSec);
      } else {
        setNotice("Aucune manche suivante");
        setTimeout(() => setNotice(null), 2000);
      }
    }
  };



  const seekTo = async (targetSec) => {
    try {
      const ms = Date.now() - Math.max(0, Math.floor(targetSec)) * 1000;
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,        // on relance
          isPaused: false,        // on quitte la pause
          startAt: Timestamp.fromMillis(ms),
          pauseAt: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("seekTo error:", err);
      alert("Échec du seek : " + (err?.message || err));
    }
  };

  const handleBack = async () => {
    if (!isPaused) return;

    const actives = roundOffsetsSec.filter((t) => typeof t === "number").sort((a, b) => a - b);
    const firstActive = actives[0] ?? 0;
    const roundStart = actives.filter((t) => t <= elapsedSec).slice(-1)[0] ?? firstActive;
    const roundEnd = actives.find((t) => t > roundStart) ?? Infinity;

    if (!plannedTimes.length || elapsedSec < firstActive) {
      await seekTo(0);
      return;
    }

    const inRound = plannedTimes.filter((t) => t >= roundStart && t < roundEnd);

    if (!inRound.some((t) => t <= elapsedSec)) {
      await seekTo(roundStart);
      return;
    }

    const past = inRound.filter((t) => t <= elapsedSec);
    const target = past[past.length - 1] ?? roundStart;
    await seekTo(target);
  };

  const handleNext = async () => {
    if (!isPaused) return;
    if (!plannedTimes.length) {
      setNotice("Aucune question suivante");
      setTimeout(() => setNotice(null), 2000);
      return;
    }

    const first = plannedTimes[0];
    // si on est en pause avant la 1ʳᵉ → aller à la 1ʳᵉ
    if (elapsedSec < first) { await seekTo(first); return; }

    // sinon aller au prochain timecode strictement supérieur
    const next = plannedTimes.find((t) => t > elapsedSec && t < (roundOffsetsSec.find((x) => x > (roundOffsetsSec
      .filter((u) => u <= elapsedSec).slice(-1)[0] ?? 0)) ?? Infinity));
    if (typeof next === "number") {
      await seekTo(next);
    } else {
      // pas de question suivante
      setNotice("Aucune question suivante");
      setTimeout(() => setNotice(null), 2000);
    }
  };


  // ---------- TABLE RENDER ----------
  const table = useMemo(() => {
    if (loading) return <p>Chargement…</p>;
    if (!items.length) return <p>Aucune question.</p>;

    return (
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
        >
          <thead style={{ background: "#2c5d8bff", color: "white" }}>
            <tr>
              <th style={{ width: 110, textAlign: "left", padding: "10px" }}>Ordre</th>
              <th style={{ width: "20%", textAlign: "left", padding: "10px" }}>Question</th>
              <th style={{ width: "30%", textAlign: "left", padding: "10px" }}>Réponses acceptées</th>
              <th style={{ width: "15%", textAlign: "left", padding: "10px" }}>
                Timecode (hh:mm:ss)
              </th>
              <th style={{ width: "15%", textAlign: "left", padding: "10px" }}>Image</th>
              <th style={{ width: 180, padding: "10px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const answersCsv = it.answersCsv ?? toCSV(it.answers || []);
              const timecodeStr =
                typeof it.timecodeStr === "string"
                  ? it.timecodeStr
                  : typeof it.timecodeSec === "number"
                    ? formatHMS(it.timecodeSec)
                    : typeof it.timecode === "number"
                      ? formatHMS(Math.round(it.timecode * 60))
                      : "";

              return (
                <tr key={it.id} style={{ borderTop: "1px solid #333" }}>
                  <td style={{ verticalAlign: "top", padding: "12px", whiteSpace: "nowrap" }}>
                    <button onClick={() => swapOrder(i, i - 1)} disabled={i === 0}>
                      ↑
                    </button>{" "}
                    <button onClick={() => swapOrder(i, i + 1)} disabled={i === items.length - 1}>
                      ↓
                    </button>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>({it.order ?? "—"})</div>
                  </td>

                  <td style={{ width: "20%", verticalAlign: "top", padding: "12px" }}>
                    <textarea
                      value={it.text || ""}
                      onChange={(e) => handleFieldChange(it.id, "text", e.target.value)}
                      rows={2}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        margin: "4px 0",
                        resize: "vertical",
                      }}
                    />
                  </td>

                  <td style={{ width: "30%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={answersCsv}
                      onChange={(e) => handleFieldChange(it.id, "answersCsv", e.target.value)}
                      placeholder="ex: Goku, Son Goku"
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Sépare par des virgules</div>
                  </td>

                  <td style={{ width: "15%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={timecodeStr}
                      onChange={(e) => handleFieldChange(it.id, "timecodeStr", e.target.value)}
                      placeholder="ex: 01:23:45 ou 03:30"
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                    {!it.timecodeStr && typeof it.timecodeSec !== "number" && (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        Laisse vide si tu ne veux pas caler cette question
                      </div>
                    )}
                  </td>

                  <td style={{ width: "15%", verticalAlign: "top", padding: "12px" }}>
                    {it.imageUrl ? (
                      <div>
                        <img
                          src={it.imageUrl}
                          alt="illustration"
                          style={{ width: "100%", maxHeight: 120, objectFit: "contain" }}
                        />
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>Pas d’image</div>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageChange(it.id, e.target.files?.[0] || null)}
                      disabled={it._imageUploading}
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                  </td>

                  <td style={{ textAlign: "center", whiteSpace: "nowrap", verticalAlign: "top", padding: "12px" }}>
                    <button onClick={() => saveOne(it)} disabled={savingId === it.id}>
                      {savingId === it.id ? "Modification…" : "Modifier"}
                    </button>
                    {savedRowId === it.id && (
                      <span style={{ marginLeft: 8, color: "lime" }}>Modifié ✔</span>
                    )}{" "}
                    <button onClick={() => removeOne(it.id)} style={{ color: "crimson" }}>
                      Supprimer
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [items, loading, savingId, savedRowId]);

  const currentRoundIndex = useMemo(() => {
    let lastIdx = -1;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (typeof t === "number" && elapsedSec >= t) lastIdx = i;
    }
    if (lastIdx >= 0) return lastIdx;
    const firstActiveIdx = roundOffsetsSec.findIndex((t) => typeof t === "number");
    return firstActiveIdx !== -1 ? firstActiveIdx : 0;
  }, [elapsedSec, roundOffsetsSec]);

  const currentRoundNumber = currentRoundIndex + 1;

  const nextRoundOffsetSec = useMemo(() => {
    const actives = roundOffsetsSec.filter((t) => typeof t === "number").sort((a, b) => a - b);
    return actives.find((t) => t > elapsedSec) ?? null;
  }, [elapsedSec, roundOffsetsSec]);


  // M1..M8 : jaune, orange, violet, bleu, vert, teal, rose, menthe
  const roundColors = [
    "#fef08a", // M1
    "#f587ecff", // M2
    "#f0bb6dff", // M3
    "#93c5fd", // M4
    "#86efac", // M5
    "#5eead4", // M6
    "#d868eeff", // M7
    "#c08e23ff", // M8
  ];

  // ---------- RENDER ----------
  return (
    <div style={{ background: "#0a0a1a", color: "white", minHeight: "100vh", padding: 20 }}>
      <div
        style={{
          margin: "0 -20px 16px",         // étire la barre au-delà du padding de la page
          background: "#2c5d8bff",
          color: "white",
          padding: "12px 20px"
        }}
      >
        <h1 style={{ margin: 0 }}>Admin — Les Questions</h1>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "12px 0", flexWrap: "wrap" }}>
        <button
          onClick={startOrNextRound}
          disabled={isRunning && !isPaused}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            width: 180,            // ✅ taille fixe du bouton principal
            background: isRunning && !isPaused ? (roundColors[currentRoundIndex] || "#a7f3d0") : "#e5e7eb",
            color: "#000",
            fontWeight: 600,
            cursor: isRunning && !isPaused ? "not-allowed" : "pointer",
            transition: "background 160ms ease",
            textAlign: "center",
            whiteSpace: "nowrap"
          }}
          title={
            !isRunning ? "Démarrer le quiz" :
              (isPaused ? "Manche suivante" : `Manche ${currentRoundNumber}`)
          }
        >
          {!isRunning ? "Démarrer le quiz" : (isPaused ? "Manche suivante" : `Manche ${currentRoundNumber}`)}
        </button>

        <button
          onClick={() => pauseQuiz()}
          disabled={!isRunning || isPaused}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#fecaca", // ✅ rouge doux pour Pause
            color: "#000",
            fontWeight: 600,
            cursor: (!isRunning || isPaused) ? "not-allowed" : "pointer",
            transition: "background 160ms ease"
          }}
          title="Mettre en pause le quiz"
        >
          Pause
        </button>

        <button
          onClick={handleBack}
          disabled={!isPaused || plannedTimes.length === 0}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: !isPaused || plannedTimes.length === 0 ? "#e5e7eb" : "#bfdbfe",
            color: "#000",
            fontWeight: 600,
            cursor: (!isPaused || plannedTimes.length === 0) ? "not-allowed" : "pointer",
            transition: "background 160ms ease"
          }}
          title="Revenir au début de la question en cours (ou au début de la manche)"
        >
          Back
        </button>

        <button
          onClick={handleNext}
          disabled={!isPaused || plannedTimes.length === 0}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: !isPaused || plannedTimes.length === 0 ? "#e5e7eb" : "#c7d2fe",
            color: "#000",
            fontWeight: 600,
            cursor: (!isPaused || plannedTimes.length === 0) ? "not-allowed" : "pointer",
            transition: "background 160ms ease"
          }}
          title="Aller au début de la prochaine question"
        >
          Next
        </button>

        <button
          onClick={() => resetQuiz()}
          disabled={false}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#e5e7eb",
            color: "#000",
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 160ms ease"
          }}
          title="Réinitialiser le quiz"
        >
          Réinitialiser
        </button>

        <div style={{
          padding: "6px 10px",
          background: "#111",
          borderRadius: 8,
          fontFamily: "monospace",
          letterSpacing: 1,
          border: "1px solid #2a2a2a"
        }}>
          ⏱ {formatHMS(elapsedSec)}
        </div>

        {/* ----- Formulaire M1..M8 en ligne (labels colorés par manche) ----- */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <label key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                padding: "2px 6px",
                borderRadius: 6,
                background: (typeof roundOffsetsSec[i] === "number") ? (roundColors[i] || "#444") : "#3a3a3a",
                color: "#000",
                fontWeight: 700,
                opacity: (typeof roundOffsetsSec[i] === "number") ? 1 : 0.6
              }}>
                M{i + 1}
              </span>
              <input
                type="text"
                value={roundOffsetsStr[i]}
                placeholder={typeof roundOffsetsSec[i] === "number" ? "hh:mm:ss" : "désactivée"}
                onChange={(e) => handleRoundOffsetChange(i, e.target.value)}
                onBlur={() => saveRoundOffsets(roundOffsetsStr)}
                onKeyDown={(e) => { if (e.key === "Enter") saveRoundOffsets(roundOffsetsStr); }}
                style={{
                  width: 90,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: "1px solid #2a2a2a",
                  background: "#111",
                  color: "#fff",
                  fontFamily: "monospace",
                  opacity: (typeof roundOffsetsSec[i] === "number") ? 1 : 0.75
                }}
              />

            </label>
          ))}
        </div>

        {notice && (
          <div style={{
            padding: "6px 10px",
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: 8,
            color: "#fff"
          }}>
            {notice}
          </div>
        )}
      </div>


      {needsOrderInit && (
        <div style={{ background: "#222", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <b>Initialisation de l’ordre requise :</b> certaines questions n’ont pas encore de champ{" "}
          <code>order</code>.
          <div style={{ marginTop: 8 }}>
            <button onClick={initOrder}>Initialiser l’ordre (une fois)</button>
          </div>
        </div>
      )}

      {/* --- Formulaire de création (au-dessus du tableau) --- */}
      <div
        style={{
          margin: "24px -20px 8px",
          background: "#2c5d8bff",
          color: "white",
          padding: "10px 20px"
        }}
      >
        <h2 style={{ margin: 0 }}>Créer une nouvelle question</h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 360px",
          gap: 16,
          alignItems: "start",
          maxWidth: 1100,
          marginBottom: 16
        }}
      >
        {/* Colonne gauche : formulaire existant */}
        <div style={{ display: "grid", gap: 8 }}>
          <label>
            Question
            <textarea
              rows={2}
              value={newQ.text}
              onChange={(e) => setNewQ((p) => ({ ...p, text: e.target.value }))}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>

          <label>
            Réponses acceptées (séparées par des virgules)
            <input
              type="text"
              value={newQ.answersCsv}
              onChange={(e) => setNewQ((p) => ({ ...p, answersCsv: e.target.value }))}
              placeholder="ex: Mario, Super Mario"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>

          <label>
            Timecode (hh:mm:ss)
            <input
              type="text"
              value={newQ.timecodeStr}
              onChange={(e) => setNewQ((p) => ({ ...p, timecodeStr: e.target.value }))}
              placeholder="ex: 00:07:30"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>

          <label>
            Image (optionnelle)
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setNewQ((p) => ({ ...p, imageFile: e.target.files?.[0] || null }))}
            />
          </label>

          <div>
            <button onClick={createOne} disabled={creating}>
              {creating ? "Création…" : "Créer la question"}
            </button>
          </div>
        </div>

        {/* Colonne droite : phrases de révélation */}
        <fieldset style={{ border: "1px solid #333", padding: 12, borderRadius: 8 }}>
          <legend style={{ padding: "0 6px" }}>Phrase de réponse aléatoire (max 5)</legend>

          {newRevealPhrases.map((val, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <label style={{ width: 120 }}>Phrase {i + 1}</label>
              <input
                type="text"
                value={val}
                onChange={(e) => {
                  const next = [...newRevealPhrases];
                  next[i] = e.target.value;
                  setNewRevealPhrases(next);
                }}
                placeholder={DEFAULT_REVEAL_PHRASES[i] || "Ex: La réponse était :"}
                style={{ flex: 1, padding: 8 }}
              />
            </div>
          ))}

          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Laisse vide pour utiliser la liste par défaut.
          </div>
        </fieldset>
      </div>


      {table}
    </div>
  );
}
