// /pages/admin.js
import { useEffect, useMemo, useState } from "react";
import { db, storage } from "../lib/firebase";
import {
  collection,
  query,
  orderBy,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  addDoc,
  writeBatch,
  setDoc,
  serverTimestamp,
  onSnapshot,
  Timestamp,
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

/* ========================= Helpers ========================= */
function parseCSV(input = "") {
  return String(input)
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
    const h = Number(hStr),
      m = Number(mStr),
      sec = Number(sStr);
    if (![h, m, sec].every((n) => Number.isFinite(n) && n >= 0)) return null;
    if (m >= 60 || sec >= 60) return null;
    return h * 3600 + m * 60 + sec;
  }
  // nombre simple → minutes décimales (legacy)
  const num = Number(s);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 60);
}
function formatHMS(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
function getTimeSec(q) {
  if (!q || typeof q !== "object") return Infinity;
  if (typeof q.timecodeSec === "number") return q.timecodeSec; // secondes (nouveau)
  if (typeof q.timecode === "number") return Math.round(q.timecode * 60); // minutes (legacy)
  return Infinity;
}
function coerceOffsetsToNumbers(arr) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const v = arr?.[i];
    if (typeof v === "number" && Number.isFinite(v)) out[i] = v;
    else if (typeof v === "string" && v.trim()) {
      const p = parseHMS(v);
      out[i] = p == null ? null : p;
    } else {
      out[i] = null;
    }
  }
  return out;
}
function roundIndexOfTime(t, offsets) {
  if (!Array.isArray(offsets)) return 0;
  let idx = -1;
  for (let i = 0; i < offsets.length; i++) {
    const v = offsets[i];
    if (typeof v === "number" && t >= v) idx = i;
  }
  return Math.max(0, idx);
}

/* ======================== Component ======================== */
export default function Admin() {
  /* ------------ Data & UI ------------ */
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [savedRowId, setSavedRowId] = useState(null);
  const [needsOrderInit, setNeedsOrderInit] = useState(false);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [mainBtnBusy, setMainBtnBusy] = useState(false);

  /* ------------ Rounds & End ------------ */
  const [roundOffsetsStr, setRoundOffsetsStr] = useState([
    "00:00:00",
    "00:16:00",
    "00:31:00",
    "00:46:00",
    "",
    "",
    "",
    "",
  ]);
  const [roundOffsetsSec, setRoundOffsetsSec] = useState([
    0, 960, 1860, 2760, null, null, null, null,
  ]);
  const [quizEndSec, setQuizEndSec] = useState(null);
  const [endOffsetStr, setEndOffsetStr] = useState("");

  /* ------------ Intro / fin de manche ------------ */
  const [isIntro, setIsIntro] = useState(false);
  const [introEndsAtMs, setIntroEndsAtMs] = useState(null);
  const [introRoundIndex, setIntroRoundIndex] = useState(null);
  const [lastAutoPausedRoundIndex, setLastAutoPausedRoundIndex] = useState(null);

  /* ------------ Live state ------------ */
  const [isRunning, setIsRunning] = useState(false);
  const [quizStartMs, setQuizStartMs] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAtMs, setPauseAtMs] = useState(null);

  /* ------------ Création question ------------ */
  const [newQ, setNewQ] = useState({
    text: "",
    answersCsv: "",
    timecodeStr: "",
    imageFile: null,
  });
  const DEFAULT_REVEAL_PHRASES = [
    "La réponse était :",
    "Il fallait trouver :",
    "C'était :",
    "La bonne réponse :",
    "Réponse :",
  ];
  const [newRevealPhrases, setNewRevealPhrases] = useState([
    "",
    "",
    "",
    "",
    "",
  ]);

  /* ------------ Utilitaires temps ------------ */
  const plannedTimes = useMemo(
    () =>
      items
        .map(getTimeSec)
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b),
    [items]
  );

  /* =================== Effects =================== */

  // Charger questions
  useEffect(() => {
    (async () => {
      setLoading(true);
      const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
      const snap = await getDocs(q);
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setItems(arr);
      setLoading(false);
      setNeedsOrderInit(arr.some((it) => typeof it.order !== "number"));
    })();
  }, []);

  // Écouter config (rounds + fin)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "config"), (snap) => {
      const d = snap.data() || {};
      if (Array.isArray(d.roundOffsetsSec)) {
        const offs = coerceOffsetsToNumbers(d.roundOffsetsSec);
        setRoundOffsetsSec(offs);
        setRoundOffsetsStr(
        offs.map((s) => (Number.isFinite(s) ? formatHMS(s) : ""))
        );
      }
      if (typeof d.endOffsetSec === "number") {
        setQuizEndSec(d.endOffsetSec);
        setEndOffsetStr(formatHMS(d.endOffsetSec));
      } else {
        setQuizEndSec(null);
        setEndOffsetStr("");
      }
    });
    return () => unsub();
  }, []);

  // Écouter état live (Timestamp ou startEpochMs)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "quiz", "state"), (snap) => {
      const d = snap.data() || {};

      // startMs depuis startAt (Timestamp) OU startEpochMs (number)
      let startMs = null;
      if (d.startAt && typeof d.startAt.seconds === "number") {
        startMs =
          d.startAt.seconds * 1000 +
          Math.floor((d.startAt.nanoseconds || 0) / 1e6);
      } else if (typeof d.startEpochMs === "number") {
        startMs = d.startEpochMs;
      }

      setIsRunning(!!d.isRunning);
      setIsPaused(!!d.isPaused);

      if (!startMs) {
        setQuizStartMs(null);
        setPauseAtMs(null);
        setElapsedSec(0);
      } else {
        setQuizStartMs(startMs);
        if (d.pauseAt && typeof d.pauseAt.seconds === "number") {
          const pms =
            d.pauseAt.seconds * 1000 +
            Math.floor((d.pauseAt.nanoseconds || 0) / 1e6);
          setPauseAtMs(pms);
        } else {
          setPauseAtMs(null);
        }
      }

      // flags
      setIsIntro(!!d.isIntro);
      setIntroEndsAtMs(
        typeof d.introEndsAtMs === "number" ? d.introEndsAtMs : null
      );
      setIntroRoundIndex(
        Number.isInteger(d.introRoundIndex) ? d.introRoundIndex : null
      );
      setLastAutoPausedRoundIndex(
        Number.isInteger(d.lastAutoPausedRoundIndex)
          ? d.lastAutoPausedRoundIndex
          : null
      );
    });
    return () => unsub();
  }, []);

  // Timer local (avec clamp fin de quiz)
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

    const computeNow = () => Math.floor((Date.now() - quizStartMs) / 1000);
    const first = computeNow();
    setElapsedSec(
      Number.isFinite(quizEndSec) && first >= quizEndSec
        ? quizEndSec
        : first < 0
        ? 0
        : first
    );

    const id = setInterval(() => {
      const raw = computeNow();
      if (Number.isFinite(quizEndSec) && raw >= quizEndSec) {
        setElapsedSec(quizEndSec);
        clearInterval(id);
      } else {
        setElapsedSec(raw < 0 ? 0 : raw);
      }
    }, 500);
    return () => clearInterval(id);
  }, [isRunning, isPaused, quizStartMs, pauseAtMs, quizEndSec]);

  // Auto-pause à la fin de manche (boundary = nextStart - 1s)
  useEffect(() => {
    if (!isRunning || isPaused) return;
    if (!Array.isArray(roundOffsetsSec) || roundOffsetsSec.every((v) => v == null)) return;

    const prevIdx = roundIndexOfTime(Math.max(0, elapsedSec - 1), roundOffsetsSec);
    const nextStart =
      typeof roundOffsetsSec[prevIdx + 1] === "number"
        ? roundOffsetsSec[prevIdx + 1]
        : null;
    if (typeof nextStart !== "number") return; // pas de manche suivante

    const boundary = Math.max(0, nextStart - 1); // marge 1s
    if (elapsedSec >= boundary && lastAutoPausedRoundIndex !== prevIdx) {
      setDoc(
        doc(db, "quiz", "state"),
        {
          isPaused: true,
          pauseAt: serverTimestamp(),
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      ).catch(console.error);
    }
  }, [isRunning, isPaused, elapsedSec, roundOffsetsSec, lastAutoPausedRoundIndex]);

  /* =================== Actions =================== */

  // Modifs inline des champs question
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

  // Manches (UI) : saisir puis sauver
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
        if (!t) return null; // vide => désactivée
        const v = parseHMS(t);
        if (v == null) throw new Error("format");
        return v;
      });
      await setDoc(
        doc(db, "quiz", "config"),
        { roundOffsetsSec: secs },
        { merge: true }
      );
      setRoundOffsetsSec(secs);
      setRoundOffsetsStr(
        secs.map((s) => (typeof s === "number" ? formatHMS(s) : ""))
      );
      setNotice("Offsets enregistrés");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide (laisser vide pour désactiver)");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  const saveEndOffset = async (valStr) => {
    try {
      const t = (valStr || "").trim();
      const v = t ? parseHMS(t) : null; // null = pas de fin
      if (t && v == null) throw new Error("format");
      await setDoc(
        doc(db, "quiz", "config"),
        { endOffsetSec: v },
        { merge: true }
      );
      setEndOffsetStr(v != null ? formatHMS(v) : "");
      setNotice("Fin du quiz enregistrée");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Format hh:mm:ss invalide pour la fin du quiz");
      setTimeout(() => setNotice(null), 2000);
    }
  };

  // Upload image question
  const uploadImage = async (file) => {
    if (!file) return null;
    try {
      const storageRef = ref(
        storage,
        `questions/${Date.now()}-${Math.random().toString(36).slice(2)}-${
          file.name
        }`
      );
      const task = uploadBytesResumable(storageRef, file);
      return await new Promise((resolve, reject) => {
        task.on(
          "state_changed",
          () => {},
          (err) => {
            console.error("[UPLOAD] Erreur:", err);
            alert("Échec de l’upload : " + (err?.message || err));
            reject(err);
          },
          async () => resolve(await getDownloadURL(task.snapshot.ref))
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

  // Save / delete
  const saveOne = async (it) => {
    try {
      setSavingId(it.id);

      const hasAnswersCsv = typeof it.answersCsv === "string";
      const hasTimecodeStr = typeof it.timecodeStr === "string";

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
          : typeof it.timecode === "number"
          ? Math.round(it.timecode * 60)
          : null,
        imageUrl: it.imageUrl || "",
        order:
          typeof it.order === "number"
            ? it.order
            : (items.findIndex((x) => x.id === it.id) + 1) * 1000,
        // revealPhrases inchangé (création uniquement)
      };

      await updateDoc(doc(db, "LesQuestions", it.id), payload);
      setSavedRowId(it.id);
      setTimeout(() => setSavedRowId(null), 2000);
    } catch (err) {
      console.error("saveOne error:", err);
      alert("Échec de la modification : " + (err?.message || err));
    } finally {
      setSavingId(null);
      await (async () => {
        const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
        const snap = await getDocs(q);
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      })();
    }
  };
  const removeOne = async (id) => {
    if (!confirm("Supprimer cette question ?")) return;
    await deleteDoc(doc(db, "LesQuestions", id));
    const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  };

  // Reorder
  const swapOrder = async (indexA, indexB) => {
    if (
      indexA < 0 ||
      indexB < 0 ||
      indexA >= items.length ||
      indexB >= items.length
    )
      return;
    const a = items[indexA],
      b = items[indexB];
    const batch = writeBatch(db);
    batch.update(doc(db, "LesQuestions", a.id), {
      order: b.order ?? (indexB + 1) * 1000,
    });
    batch.update(doc(db, "LesQuestions", b.id), {
      order: a.order ?? (indexA + 1) * 1000,
    });
    await batch.commit();
    const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  };

  // Init order (one-time)
  const initOrder = async () => {
    const q = query(collection(db, "LesQuestions"), orderBy("createdAt", "asc"));
    const snap = await getDocs(q);
    const arr = snap.docs.map((d, i) => ({ id: d.id, ...d.data(), idx: i }));
    const batch = writeBatch(db);
    arr.forEach((it, i) =>
      batch.update(doc(db, "LesQuestions", it.id), { order: (i + 1) * 1000 })
    );
    await batch.commit();
    const q2 = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap2 = await getDocs(q2);
    setItems(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
  };

  // Create
  const createOne = async () => {
    try {
      setCreating(true);
      let imageUrl = "";
      if (newQ.imageFile) imageUrl = (await uploadImage(newQ.imageFile)) || "";

      const answers = parseCSV(newQ.answersCsv);
      const timecodeSec = parseHMS(newQ.timecodeStr);
      const order =
        items.length > 0
          ? Math.max(...items.map((x) => x.order || 0)) + 1000
          : 1000;

      const cleanedRevealPhrases = (newRevealPhrases ?? [])
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .slice(0, 5);

      await addDoc(collection(db, "LesQuestions"), {
        text: newQ.text || "",
        answers,
        timecodeSec,
        imageUrl,
        createdAt: new Date(),
        order,
        revealPhrases: cleanedRevealPhrases, // [] autorisé → fallback côté client
      });

      setNewQ({
        text: "",
        answersCsv: "",
        timecodeStr: "",
        imageFile: null,
      });
      setNewRevealPhrases(["", "", "", "", ""]);
    } catch (err) {
      console.error("createOne error:", err);
      alert("Échec de la création : " + (err?.message || err));
    } finally {
      setCreating(false);
      const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
      const snap = await getDocs(q);
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
  };

  // Live controls
  const startQuiz = async () => {
    try {
      const nowMs = Date.now();
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: false,
          startAt: Timestamp.fromMillis(nowMs), // même base temps que startEpochMs
          startEpochMs: nowMs, // compat Player/Screen
          pauseAt: null,
        },
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
        {
          isRunning: false,
          isPaused: false,
          startAt: null,
          startEpochMs: null, // compat Player/Screen
          pauseAt: null,
          isIntro: false,
          introEndsAtMs: null,
          introRoundIndex: null,
          lastAutoPausedRoundIndex: null,
        },
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
        {
          isPaused: true,
          pauseAt: serverTimestamp(),
          // Pause MANUELLE : on efface la sentinelle pour ne pas afficher "Fin de manche"
          lastAutoPausedRoundIndex: null,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("pauseQuiz error:", err);
      alert("Impossible de mettre en pause : " + (err?.message || err));
    }
  };

  const seekTo = async (targetSec) => {
    try {
      const target = Math.max(0, Math.floor(targetSec));
      const ms = Date.now() - target * 1000;

      // Neutraliser l'auto-pause si on saute au début d'une manche
      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && target - 1 >= t) prevIdx = i;
      }
      const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
        ? roundOffsetsSec[prevIdx + 1]
        : null;
      const boundary =
        typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;

      const payload = {
        isRunning: true,
        isPaused: false,
        startAt: Timestamp.fromMillis(ms),
        startEpochMs: ms,
        pauseAt: null,
      };
      if (typeof boundary === "number" && target >= boundary && prevIdx >= 0) {
        payload.lastAutoPausedRoundIndex = prevIdx;
      }

      await setDoc(doc(db, "quiz", "state"), payload, { merge: true });
    } catch (err) {
      console.error("seekTo error:", err);
      alert("Échec du seek : " + (err?.message || err));
    }
  };

  const resumeFromPause = async () => {
    try {
      const newStartMs = Date.now() - Math.max(0, Math.floor(elapsedSec)) * 1000;

      // Si on est pile à la frontière (boundary = nextStart - 1), on arme la sentinelle
      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && elapsedSec >= t) prevIdx = i;
      }
      const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
        ? roundOffsetsSec[prevIdx + 1]
        : null;
      const boundary =
        typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;

      const payload = {
        isRunning: true,
        isPaused: false,
        startAt: Timestamp.fromMillis(newStartMs),
        startEpochMs: newStartMs,
        pauseAt: null,
      };
      if (typeof boundary === "number" && elapsedSec >= boundary) {
        payload.lastAutoPausedRoundIndex = prevIdx;
      }

      await setDoc(doc(db, "quiz", "state"), payload, { merge: true });
    } catch (err) {
      console.error("resumeFromPause error:", err);
      alert("Échec de la reprise : " + (err?.message || err));
    }
  };

  const jumpToRoundStartAndPlay = async (roundStartSec) => {
    try {
      const target = Math.max(0, Math.floor(roundStartSec));
      const ms = Date.now() - target * 1000;

      // Sentinelle = index de la manche précédente au point (roundStartSec - 1)
      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && target - 1 >= t) prevIdx = i;
      }

      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: false,
          startAt: Timestamp.fromMillis(ms),
          startEpochMs: ms,
          pauseAt: null,
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("jumpToRoundStartAndPlay error:", err);
      alert("Échec du saut de manche : " + (err?.message || err));
    }
  };

  const seekPaused = async (targetSec) => {
    try {
      const target = Math.max(0, Math.floor(targetSec));
      const startMs = Date.now() - target * 1000;

      let prevIdx = -1;
      for (let i = 0; i < roundOffsetsSec.length; i++) {
        const t = roundOffsetsSec[i];
        if (Number.isFinite(t) && target - 1 >= t) prevIdx = i;
      }
      const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
        ? roundOffsetsSec[prevIdx + 1]
        : null;
      const boundary =
        typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;

      const payload = {
        isRunning: true,
        isPaused: true,
        startAt: Timestamp.fromMillis(startMs),
        startEpochMs: startMs,
        pauseAt: serverTimestamp(),
      };
      if (typeof boundary === "number" && target >= boundary && prevIdx >= 0) {
        payload.lastAutoPausedRoundIndex = prevIdx;
      }

      await setDoc(doc(db, "quiz", "state"), payload, { merge: true });
    } catch (err) {
      console.error("seekPaused error:", err);
      alert("Échec du positionnement (pause) : " + (err?.message || err));
    }
  };

  const startOrNextRound = async () => {
    const actives = (Array.isArray(roundOffsetsSec) ? roundOffsetsSec : [])
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);

    if (mainBtnBusy) return;
    setMainBtnBusy(true);
    setTimeout(() => setMainBtnBusy(false), 350);

    if (!actives.length) {
      await startQuiz();
      return;
    }

    // 1) Première fois (quiz pas démarré) → démarrer
    if (!isRunning || !quizStartMs) {
      await startQuiz();
      return;
    }

    // 2) En pause → contexte :
    //    - si elapsed < boundary (nextStart - 1) → SAUT au début de la manche suivante
    //    - sinon → reprise simple
    if (isPaused) {
      const nextRoundStart = actives.find((t) => t > elapsedSec);
      if (typeof nextRoundStart !== "number") {
        setNotice("Aucune manche suivante");
        setTimeout(() => setNotice(null), 1800);
        return;
      }
      const boundary = Math.max(0, nextRoundStart - 1);
      if (elapsedSec < boundary) {
        await jumpToRoundStartAndPlay(nextRoundStart);
      } else {
        await resumeFromPause();
      }
      return;
    }
  };

  const handleBack = async () => {
    if (!isPaused) return;

    // Si on est sur la frontière de manche → bloqué (UX)
    if (atRoundBoundary) {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
      return;
    }

    const actives = roundOffsetsSec
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);
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
    if (atRoundBoundary) {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
      return;
    }
    if (!plannedTimes.length) {
      setNotice("Aucune question suivante");
      setTimeout(() => setNotice(null), 2000);
      return;
    }

    const first = plannedTimes[0];
    if (elapsedSec < first) {
      await seekTo(first);
      return;
    }

    const currentRoundStart =
      roundOffsetsSec
        .filter((t) => typeof t === "number" && t <= elapsedSec)
        .slice(-1)[0] ?? 0;
    const currentRoundEnd =
      roundOffsetsSec.find((t) => typeof t === "number" && t > currentRoundStart) ??
      Infinity;

    const next = plannedTimes.find((t) => t > elapsedSec && t < currentRoundEnd);
    if (typeof next === "number") {
      await seekTo(next);
    } else {
      setNotice("Fin de manche atteinte : utilisez « Manche suivante »");
      setTimeout(() => setNotice(null), 1600);
    }
  };

  async function goToRoundEndPaused() {
    const prevIdx = roundIndexOfTime(Math.max(0, elapsedSec - 1), roundOffsetsSec);
    const nextStart =
      typeof roundOffsetsSec[prevIdx + 1] === "number"
        ? roundOffsetsSec[prevIdx + 1]
        : null;
    if (!Number.isFinite(nextStart)) return; // pas de manche suivante

    const targetSec = Math.max(0, Math.floor(nextStart));
    const startMs = Date.now() - targetSec * 1000;

    try {
      await setDoc(
        doc(db, "quiz", "state"),
        {
          isRunning: true,
          isPaused: true,
          startAt: Timestamp.fromMillis(startMs),
          startEpochMs: startMs,
          pauseAt: serverTimestamp(),
          lastAutoPausedRoundIndex: prevIdx,
        },
        { merge: true }
      );
    } catch (e) {
      console.error("goToRoundEndPaused error:", e);
    }
  }

  async function fixRoundsInConfig() {
    try {
      const refCfg = doc(db, "quiz", "config");
      const snap = await getDoc(refCfg);
      const d = snap.data() || {};
      const fixed = coerceOffsetsToNumbers(d.roundOffsetsSec || []);
      await setDoc(refCfg, { roundOffsetsSec: fixed }, { merge: true });
      setRoundOffsetsSec(fixed);
      setRoundOffsetsStr(
        fixed.map((s) => (typeof s === "number" ? formatHMS(s) : ""))
      );
      setNotice("Manches réparées ✅");
      setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      console.error(e);
      setNotice("Échec de la réparation des manches");
      setTimeout(() => setNotice(null), 2000);
    }
  }

  /* =================== Derived =================== */
  const currentRoundIndex = useMemo(() => {
    let lastIdx = -1;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) lastIdx = i;
    }
    if (lastIdx >= 0) return lastIdx;
    const firstActiveIdx = roundOffsetsSec.findIndex((t) => Number.isFinite(t));
    return firstActiveIdx !== -1 ? firstActiveIdx : 0;
  }, [elapsedSec, roundOffsetsSec]);

  const nextRoundIndex = useMemo(() => {
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && t > elapsedSec) return i;
    }
    return null;
  }, [elapsedSec, roundOffsetsSec]);

  // Frontière de fin de manche avec marge 1s
  const roundBoundarySec = useMemo(() => {
    if (!Array.isArray(roundOffsetsSec) || roundOffsetsSec.every((v) => v == null))
      return null;
    let prevIdx = -1;
    for (let i = 0; i < roundOffsetsSec.length; i++) {
      const t = roundOffsetsSec[i];
      if (Number.isFinite(t) && elapsedSec >= t) prevIdx = i;
    }
    const nextStart = Number.isFinite(roundOffsetsSec[prevIdx + 1])
      ? roundOffsetsSec[prevIdx + 1]
      : null;
    return typeof nextStart === "number" ? Math.max(0, nextStart - 1) : null;
  }, [elapsedSec, roundOffsetsSec]);

  const atRoundBoundary = Boolean(
    isPaused && typeof roundBoundarySec === "number" && elapsedSec >= roundBoundarySec
  );

  const roundColors = [
    "#fef08a", // M1
    "#fb923c", // M2
    "#a78bfa", // M3
    "#93c5fd", // M4
    "#86efac", // M5
    "#5eead4", // M6
    "#f472b6", // M7
    "#f59e0b", // M8
  ];

  const isQuizEnded = Number.isFinite(quizEndSec) && elapsedSec >= quizEndSec;
  const currentRoundNumber = currentRoundIndex + 1;

  const mainButtonLabel = isQuizEnded
    ? "Fin du quiz"
    : !isRunning
    ? "Démarrer le quiz"
    : isPaused
    ? "Manche suivante"
    : `Manche ${currentRoundNumber}`;

  const mainButtonRoundIdx = isQuizEnded
    ? null
    : !isRunning
    ? null
    : isPaused
    ? nextRoundIndex
    : currentRoundIndex;

  const mainButtonColor =
    mainButtonRoundIdx != null && mainButtonRoundIdx >= 0
      ? roundColors[mainButtonRoundIdx] || "#e5e7eb"
      : "#e5e7eb";

  // Pause « soft-disabled »
  const canClickPause = isRunning && !isPaused && !isQuizEnded;
  const pauseCursor = canClickPause ? "pointer" : "not-allowed";

  /* =================== UI =================== */
  const table = useMemo(() => {
    if (loading) return <p>Chargement…</p>;
    if (!items.length) return <p>Aucune question.</p>;

    return (
      <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}
        >
          <thead style={{ background: "#2c5d8bff", color: "white" }}>
            <tr>
              <th style={{ width: 110, textAlign: "left", padding: "10px" }}>Ordre</th>
              <th style={{ width: "20%", textAlign: "left", padding: "10px" }}>
                Question
              </th>
              <th style={{ width: "30%", textAlign: "left", padding: "10px" }}>
                Réponses acceptées
              </th>
              <th style={{ width: "15%", textAlign: "left", padding: "10px" }}>
                Timecode (hh:mm:ss)
              </th>
              <th style={{ width: "15%", textAlign: "left", padding: "10px" }}>
                Image
              </th>
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
                    <button
                      onClick={() => swapOrder(i, i + 1)}
                      disabled={i === items.length - 1}
                    >
                      ↓
                    </button>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>({it.order ?? "—"})</div>
                  </td>

                  <td style={{ width: "20%", verticalAlign: "top", padding: "12px" }}>
                    <textarea
                      rows={2}
                      value={it.text || ""}
                      onChange={(e) => handleFieldChange(it.id, "text", e.target.value)}
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
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      Sépare par des virgules
                    </div>
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
                      onChange={(e) =>
                        handleImageChange(it.id, e.target.files?.[0] || null)
                      }
                      disabled={it._imageUploading}
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                  </td>

                  <td
                    style={{
                      textAlign: "center",
                      whiteSpace: "nowrap",
                      verticalAlign: "top",
                      padding: "12px",
                    }}
                  >
                    <button onClick={() => saveOne(it)} disabled={savingId === it.id}>
                      {savingId === it.id ? "Modification…" : "Modifier"}
                    </button>{" "}
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

  /* =================== Render =================== */
  return (
    <div style={{ background: "#0a0a1a", color: "white", minHeight: "100vh", padding: 20 }}>
      {/* Header */}
      <div
        style={{
          margin: "0 -20px 16px",
          background: "#2c5d8bff",
          color: "white",
          padding: "12px 20px",
        }}
      >
        <h1 style={{ margin: 0 }}>Admin — Les Questions</h1>
      </div>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          margin: "12px 0",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={startOrNextRound}
          disabled={(isRunning && !isPaused) || isQuizEnded || mainBtnBusy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            width: 180,
            background: mainButtonColor,
            color: "#000",
            fontWeight: 600,
            cursor:
              (isRunning && !isPaused) || isIntro || isQuizEnded
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
          title={mainButtonLabel}
        >
          {mainButtonLabel}
        </button>

        <button
          onClick={canClickPause ? pauseQuiz : (e) => e.preventDefault()}
          aria-disabled={canClickPause ? "false" : "true"}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#fecaca", // rouge doux permanent
            color: "#000",
            fontWeight: 600,
            cursor: pauseCursor,
            transition: "background 160ms ease",
          }}
          title={canClickPause ? "Mettre en pause le quiz" : "Pause indisponible"}
        >
          Pause
        </button>

        <button
          onClick={handleBack}
          disabled={!isPaused || plannedTimes.length === 0 || atRoundBoundary}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#bfdbfe",
            color: "#000",
            fontWeight: 600,
            cursor:
              !isPaused || plannedTimes.length === 0 || atRoundBoundary
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
          }}
          title={
            atRoundBoundary
              ? "Fin de manche atteinte : utilisez « Manche suivante »"
              : "Revenir au début de la question en cours (ou au début de la manche)"
          }
        >
          Back
        </button>

        <button
          onClick={handleNext}
          disabled={!isPaused || plannedTimes.length === 0 || atRoundBoundary}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#c7d2fe",
            color: "#000",
            fontWeight: 600,
            cursor:
              !isPaused || plannedTimes.length === 0 || atRoundBoundary
                ? "not-allowed"
                : "pointer",
            transition: "background 160ms ease",
          }}
          title={
            atRoundBoundary
              ? "Fin de manche atteinte : utilisez « Manche suivante »"
              : "Aller au début de la prochaine question (si disponible dans cette manche)"
          }
        >
          Next
        </button>

        <button
          onClick={resetQuiz}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            background: "#e5e7eb",
            color: "#000",
            fontWeight: 600,
          }}
          title="Réinitialiser le quiz"
        >
          Réinitialiser
        </button>

        <div
          style={{
            padding: "6px 10px",
            background: "#111",
            borderRadius: 8,
            fontFamily: "monospace",
            letterSpacing: 1,
            border: "1px solid #2a2a2a",
          }}
        >
          ⏱ {formatHMS(elapsedSec)}
        </div>

        {/* M1..M8 avec couleurs */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <label key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 6,
                  background: Number.isFinite(roundOffsetsSec[i])
                    ? roundColors[i] || "#444"
                    : "#3a3a3a",
                  color: Number.isFinite(roundOffsetsSec[i]) ? "#111" : "#aaa",
                  fontWeight: 700,
                  opacity: Number.isFinite(roundOffsetsSec[i]) ? 1 : 0.6,
                }}
              >
                M{i + 1}
              </span>
              <input
                type="text"
                value={roundOffsetsStr[i]}
                placeholder={
                  typeof roundOffsetsSec[i] === "number" ? "hh:mm:ss" : "désactivée"
                }
                onChange={(e) => handleRoundOffsetChange(i, e.target.value)}
                onBlur={() => saveRoundOffsets(roundOffsetsStr)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRoundOffsets(roundOffsetsStr);
                }}
                style={{
                  width: 90,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: "1px solid #2a2a2a",
                  background: "#111",
                  color: "#fff",
                  fontFamily: "monospace",
                  opacity: typeof roundOffsetsSec[i] === "number" ? 1 : 0.75,
                }}
              />
            </label>
          ))}
          <button
            onClick={fixRoundsInConfig}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #2a2a2a",
              background: "#e5e7eb",
              color: "#000",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Convertit les manches stockées en hh:mm:ss en secondes numériques"
          >
            Réparer les manches
          </button>
        </div>

        {/* Fin du quiz */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700 }}>Fin du quiz (hh:mm:ss)</span>
            <input
              type="text"
              value={endOffsetStr}
              onChange={(e) => setEndOffsetStr(e.target.value)}
              onBlur={() => saveEndOffset(endOffsetStr)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEndOffset(endOffsetStr);
              }}
              placeholder="ex: 01:58:00"
              style={{
                width: 110,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid #2a2a2a",
                background: "#111",
                color: "#fff",
                fontFamily: "monospace",
              }}
              title="Point de fin global (utilisé pour la révélation & le décompte final)"
            />
          </label>
        </div>

        {notice && (
          <div
            style={{
              padding: "6px 10px",
              background: "#1f2937",
              border: "1px solid #374151",
              borderRadius: 8,
              color: "#fff",
            }}
          >
            {notice}
          </div>
        )}
      </div>

      {needsOrderInit && (
        <div style={{ background: "#222", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <b>Initialisation de l’ordre requise :</b> certaines questions n’ont pas encore
          de champ <code>order</code>.
          <div style={{ marginTop: 8 }}>
            <button onClick={initOrder}>Initialiser l’ordre (une fois)</button>
          </div>
        </div>
      )}

      {/* Création question */}
      <div
        style={{
          margin: "24px -20px 8px",
          background: "#2c5d8bff",
          color: "white",
          padding: "10px 20px",
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
          marginBottom: 16,
        }}
      >
        {/* Colonne gauche */}
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
              onChange={(e) =>
                setNewQ((p) => ({ ...p, imageFile: e.target.files?.[0] || null }))
              }
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
            <div
              key={i}
              style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}
            >
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
