// /pages/admin.js
import { useEffect, useMemo, useState } from "react";
import { db, storage } from "../lib/firebase";
import {
  collection, query, orderBy, getDocs, doc, updateDoc, deleteDoc, addDoc, writeBatch,
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

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

  // Rétro-compat: si on tape un nombre seul, interprète comme minutes décimales
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

function normalizeTimecode(v) {
  if (v === "" || v === null || typeof v === "undefined") return null;
  const num = Number(v);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export default function Admin() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newQ, setNewQ] = useState({
    text: "",
    answersCsv: "",
    timecodeStr: "", // minutes (ex: "12.5")
    imageFile: null,
  });
  const [needsOrderInit, setNeedsOrderInit] = useState(false);

  // ---------- LOAD ----------
  const load = async () => {
    setLoading(true);
    const q = query(collection(db, "LesQuestions"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setItems(arr);
    setLoading(false);

    // détecte si certaines questions n'ont pas de champ order
    const hasMissingOrder = arr.some((it) => typeof it.order !== "number");
    setNeedsOrderInit(hasMissingOrder);
  };

  useEffect(() => {
    load();
  }, []);

  // ---------- EDIT / SAVE ----------
  const handleFieldChange = (id, field, value) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, [field]: value };
        if (field === "timecodeStr") {
          next.timecodeSec = parseHMS(value); // null si invalide
        }
        return next;
      })
    );
  };

  const saveOne = async (it) => {
    try {
      setSavingId(it.id);

      const hasAnswersCsv = typeof it.answersCsv === "string";
      const hasTimecodeStr = typeof it.timecodeStr === "string";

      const payload = {
        text: it.text ?? "",
        // 👉 Si un CSV a été saisi, on le prend en priorité
        answers: hasAnswersCsv
          ? parseCSV(it.answersCsv)
          : Array.isArray(it.answers)
            ? it.answers
            : [],
        // Timecode en secondes (priorité à la saisie 'hh:mm:ss')
        timecodeSec: hasTimecodeStr
          ? parseHMS(it.timecodeStr)
          : (typeof it.timecodeSec === "number"
            ? it.timecodeSec
            // rétro-compat si ancien champ 'timecode' en minutes
            : (typeof it.timecode === "number" ? Math.round(it.timecode * 60) : null)),
        imageUrl: it.imageUrl || "",
        order:
          typeof it.order === "number"
            ? it.order
            : (items.findIndex((x) => x.id === it.id) + 1) * 1000,
      };

      await updateDoc(doc(db, "LesQuestions", it.id), payload);
    } catch (err) {
      console.error("saveOne error:", err);
      alert("Échec de l’enregistrement : " + (err?.message || err));
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

  // ---------- IMAGE UPLOAD ----------
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
          (snap) => {
            const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
            console.log(`[UPLOAD] ${pct}%`);
          },
          (err) => {
            console.error("[UPLOAD] Erreur:", err);
            alert("Échec de l’upload : " + (err?.message || err));
            reject(err);
          },
          async () => {
            const url = await getDownloadURL(task.snapshot.ref);
            console.log("[UPLOAD] Terminé →", url);
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
    handleFieldChange(id, "imageUrl", url || "");
    handleFieldChange(id, "_imageUploading", false);
  };

  // ---------- REORDER (swap order with neighbor) ----------
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
    const arr = snap.docs.map((d, i) => ({
      id: d.id,
      ...d.data(),
      idx: i,
    }));
    const batch = writeBatch(db);
    arr.forEach((it, i) => {
      // espacements de 1000 pour insertions futures
      batch.update(doc(db, "LesQuestions", it.id), { order: (i + 1) * 1000 });
    });
    await batch.commit();
    await load();
  };

  // ---------- CREATE ----------
  const createOne = async () => {
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

    await addDoc(collection(db, "LesQuestions"), {
      text: newQ.text || "",
      answers,
      timecodeSec,   // secondes (ou null)
      imageUrl,
      createdAt: new Date(),
      order,
    });

    setNewQ({ text: "", answersCsv: "", timecodeStr: "", imageFile: null });
    setCreating(false);
    await load();
  };

  const table = useMemo(() => {
    if (loading) return <p>Chargement…</p>;
    if (!items.length) return <p>Aucune question.</p>;

    return (
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed"
          }}
        >
          <thead style={{ background: "#4f6daaff", color: "white" }}>
            <tr>
              <th style={{ width: 20, textAlign: "left", padding: "10px" }}>Ordre</th>
              <th style={{ width: "20%", textAlign: "left", padding: "10px" }}>Question</th>
              <th style={{ width: "25%", textAlign: "left", padding: "10px" }}>Réponses acceptées</th>
              <th style={{ width: "15%", textAlign: "left", padding: "10px" }}>Timecode (hh:mm:ss)</th>
              <th style={{ width: "10%", textAlign: "left", padding: "10px" }}>Image</th>
              <th style={{ width: 140, padding: "10px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const answersCsv = it.answersCsv ?? toCSV(it.answers || []);
              const timecodeStr =
                typeof it.timecodeStr === "string"
                  ? it.timecodeStr
                  : (typeof it.timecodeSec === "number"
                    ? formatHMS(it.timecodeSec)
                    // rétro-compat : si ancien 'timecode' en minutes
                    : (typeof it.timecode === "number" ? formatHMS(Math.round(it.timecode * 60)) : ""));

              return (
                <tr key={it.id} style={{ borderTop: "1px solid #333" }}>
                  <td style={{ whiteSpace: "nowrap" }}>
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
                      value={it.text || ""}
                      onChange={(e) => handleFieldChange(it.id, "text", e.target.value)}
                      rows={2}
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0", resize: "vertical" }}
                    />
                  </td>

                  <td style={{ width: "20%", verticalAlign: "top", padding: "12px" }}>
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

                  <td style={{ width: "10%", verticalAlign: "top", padding: "12px" }}>
                    <input
                      type="text"
                      value={timecodeStr}
                      onChange={(e) => handleFieldChange(it.id, "timecodeStr", e.target.value)}
                      placeholder="ex: 01:23:45 ou 03:30"
                      style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }}
                    />
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Format hh:mm:ss (mm:ss et ss acceptés)</div>
                  </td>

                  <td style={{ width: "20%" }}>
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
                    />
                  </td>

                  <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                    <button onClick={() => saveOne(it)} disabled={savingId === it.id}>
                      {savingId === it.id ? "Modification…" : "Modifier"}
                    </button>{" "}
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
  }, [items, loading, savingId]);

  return (
    <div style={{ background: "#0a0a1a", color: "white", minHeight: "100vh", padding: 20 }}>
      <h1>Admin — Les Questions</h1>

      {needsOrderInit && (
        <div style={{ background: "#222", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <b>Initialisation de l’ordre requise :</b> certaines questions n’ont pas encore de champ <code>order</code>.
          <div style={{ marginTop: 8 }}>
            <button onClick={initOrder}>Initialiser l’ordre (une fois)</button>
          </div>
        </div>
      )}

      {table}

      <hr style={{ margin: "24px 0", borderColor: "#333" }} />

      <h2>Créer une nouvelle question</h2>
      <div style={{ display: "grid", gap: 8, maxWidth: 800 }}>
        <label>
          Question
          <textarea
            rows={2}
            value={newQ.text}
            onChange={(e) => setNewQ((p) => ({ ...p, text: e.target.value }))}
            style={{ width: "100%" }}
          />
        </label>
        <label>
          Réponses acceptées (séparées par des virgules)
          <input
            type="text"
            value={newQ.answersCsv}
            onChange={(e) => setNewQ((p) => ({ ...p, answersCsv: e.target.value }))}
            placeholder="ex: Mario, Super Mario"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          Timecode (hh:mm:ss)
          <input
            type="text"
            value={newQ.timecodeStr}
            onChange={(e) => setNewQ((p) => ({ ...p, timecodeStr: e.target.value }))}
            placeholder="ex: 00:07:30"
            style={{ width: "100%" }}
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
    </div>
  );
}
