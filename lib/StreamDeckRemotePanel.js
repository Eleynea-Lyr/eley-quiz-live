// ============================================================================
// lib/StreamDeckRemotePanel.js — URLs prêtes pour le Stream Deck (HTTP silencieux)
// ============================================================================

import { useMemo, useState } from "react";
import { REMOTE_ACTIONS } from "./quiz-seek";

const ACTION_LABELS = {
  start: "Démarrer",
  pause: "Pause / Play",
  back: "Back",
  next: "Next",
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * @param {{ secret: string, setNotice?: (msg: string|null) => void }} props
 */
export default function StreamDeckRemotePanel({ secret, setNotice }) {
  const [copied, setCopied] = useState(null);

  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";

  const urls = useMemo(() => {
    if (!origin || !secret) return [];
    return REMOTE_ACTIONS.map((action) => ({
      action,
      label: ACTION_LABELS[action] || action,
      url: `${origin}/api/remote?action=${action}&secret=${encodeURIComponent(secret)}`,
    }));
  }, [origin, secret]);

  const flash = (key, msg) => {
    setCopied(key);
    if (typeof setNotice === "function") {
      setNotice(msg);
      setTimeout(() => setNotice(null), 1600);
    }
    setTimeout(() => setCopied(null), 1600);
  };

  const onCopy = async (key, text, msg) => {
    const ok = await copyText(text);
    flash(key, ok ? msg : "Copie impossible — sélectionne l’URL à la main");
  };

  if (!urls.length) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "stretch",
      }}
    >
      {urls.map(({ action, label, url }) => (
        <div
          key={action}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minWidth: 200,
            maxWidth: 280,
            flex: "1 1 200px",
            padding: "8px 10px",
            borderRadius: 8,
            background: "#111827",
            border: "1px solid #334155",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 13 }}>{label}</span>
            <button
              type="button"
              onClick={() => onCopy(action, url, `URL ${label} copiée`)}
              style={{
                padding: "3px 8px",
                borderRadius: 6,
                border: "1px solid #475569",
                background: copied === action ? "#16a34a" : "#1e293b",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {copied === action ? "OK" : "Copier"}
            </button>
          </div>
          <code
            style={{
              fontSize: 10,
              lineHeight: 1.35,
              wordBreak: "break-all",
              opacity: 0.8,
              fontFamily: "ui-monospace, monospace",
            }}
            title={url}
          >
            {url}
          </code>
        </div>
      ))}
    </div>
  );
}
