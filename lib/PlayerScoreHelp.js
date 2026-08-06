// ============================================================================
// lib/PlayerScoreHelp.js — Bouton (i) + modal scores (Player)
// ============================================================================

import { useEffect, useId, useState } from "react";
import {
  BRAND,
  BRAND_PAGE_BOTTOM,
  FONT_FAMILY,
  PAGE_TEXT,
  PAGE_TEXT_MUTED,
} from "./brand-theme";
import { getTeamBadgeStyle } from "./team-color";
import { PLAYER_SCORE_HELP } from "./messages";

const PAGE_COUNT = 4;

function MiniTeamBadge() {
  const tint = getTeamBadgeStyle(BRAND.blue);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 10,
        padding: "6px 10px",
        fontSize: "0.82rem",
        fontWeight: 700,
        maxWidth: "100%",
        ...tint,
      }}
      aria-hidden="true"
    >
      <span style={{ fontSize: "0.95rem" }}>⭐</span>
      <span>MON ÉQUIPE</span>
      <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.95 }}>• 30</span>
    </div>
  );
}

/** highlight: "player" = score perso net ; "buzz" = partie ⚡ nette */
function MiniPlayerBadge({ highlight = "player" }) {
  const dimPlayer = highlight === "buzz";
  const dimBuzz = highlight === "player";
  const divider = {
    width: 2,
    alignSelf: "stretch",
    minHeight: 14,
    background: "rgba(255, 251, 245, 0.22)",
    flexShrink: 0,
    margin: "0 1px 0 5px",
  };
  const playerColor = dimPlayer ? "rgba(254, 237, 106, 0.28)" : BRAND.yellow;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 10,
        padding: "6px 10px",
        fontSize: "0.82rem",
        fontWeight: 700,
        background: BRAND_PAGE_BOTTOM,
        border: "2px solid rgba(255, 251, 245, 0.22)",
        color: "#fff",
        maxWidth: "100%",
      }}
      aria-hidden="true"
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          opacity: dimPlayer ? 0.18 : 1,
        }}
      >
        <svg
          width="0.95em"
          height="0.95em"
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{ flexShrink: 0, display: "block" }}
        >
          <path
            fill={playerColor}
            d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
          />
        </svg>
        Toi
      </span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          opacity: dimPlayer ? 0.18 : 1,
        }}
      >
        • 18
      </span>
      <span style={divider} />
      <span
        style={{
          color: dimBuzz ? "rgba(254, 237, 106, 0.28)" : BRAND.yellow,
          opacity: dimBuzz ? 0.4 : 1,
        }}
      >
        ⚡ 5
      </span>
    </div>
  );
}

/** i tout en courbes — pastille + liséré type badges (SVG net) */
function InfoIcon({ size = 28 }) {
  const ink = "rgba(255, 251, 245, 0.92)";
  const rim = "rgba(255, 251, 245, 0.22)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ display: "block", overflow: "visible" }}
    >
      <circle
        cx="16"
        cy="16"
        r="14.25"
        fill="rgba(255, 251, 245, 0.14)"
        stroke={rim}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx="16" cy="9.2" r="2.15" fill={ink} />
      <rect x="13.85" y="13.2" width="4.3" height="11.2" rx="2.15" fill={ink} />
    </svg>
  );
}

function BuzzLegend() {
  const row = (color, label) => (
    <div
      key={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: "0.88rem",
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: color,
          border: `1px solid ${BRAND.mauveDark}`,
          flexShrink: 0,
        }}
      />
      <span>{label}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
      {row(BRAND.blue, "Bleu — tu peux buzzer")}
      {row(BRAND.yellow, "Jaune — c’est à toi de répondre")}
      {row(BRAND.mauveLight, "Rouge grisé — un autre joueur a buzzé")}
      {row(BRAND.red, "Rouge — hors jeu pour cette question")}
    </div>
  );
}

function PageBody({ page }) {
  const m = PLAYER_SCORE_HELP;
  if (page === 0) {
    return (
      <>
        <h2
          style={{
            ...titleStyle,
            textAlign: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span aria-hidden="true" style={{ color: "#f2a0c4", fontSize: "0.95em", lineHeight: 1 }}>
            ♪
          </span>
          <span>{m.page0Title}</span>
        </h2>
        <p style={bodyStyle}>{m.page0Lead}</p>
        <p style={bodyStyle}>{m.page0Body}</p>
        <p style={bodyStyle}>{m.page0Buzz}</p>
      </>
    );
  }
  if (page === 1) {
    return (
      <>
        <h2
          style={{
            ...titleStyle,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span aria-hidden="true" style={{ color: BRAND.orangeLight, fontSize: "0.92em", lineHeight: 1 }}>
            ★
          </span>
          <span>{m.page1Title}</span>
        </h2>
        <p style={bodyStyle}>{m.page1Body}</p>
        <div style={{ margin: "14px 0 8px" }}>
          <MiniTeamBadge />
        </div>
        <p
          style={{
            ...captionStyle,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>{m.page1Caption}</span>
          <span aria-hidden="true" style={{ fontSize: "1.15em", lineHeight: 1, color: BRAND.orangeLight }}>
            ↖
          </span>
        </p>
        <p style={bodyStyle}>{m.page1Example}</p>
      </>
    );
  }
  if (page === 2) {
    return (
      <>
        <h2
          style={{
            ...titleStyle,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <svg
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            aria-hidden="true"
            style={{ flexShrink: 0, display: "block", fontSize: "0.95em" }}
          >
            <path
              fill={BRAND.yellow}
              d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
            />
          </svg>
          <span>{m.page2Title}</span>
        </h2>
        <p style={bodyStyle}>{m.page2Lead}</p>
        <p style={bodyStyle}>{m.page2Body}</p>
        <div style={{ margin: "14px 0 8px" }}>
          <MiniPlayerBadge highlight="player" />
        </div>
        <p
          style={{
            ...captionStyle,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>{m.page2Caption}</span>
          <span aria-hidden="true" style={{ fontSize: "1.15em", lineHeight: 1, color: BRAND.yellow }}>
            ↗
          </span>
        </p>
        <p style={bodyStyle}>{m.page2Note}</p>
        <p style={bodyStyle}>{m.page2NoteLine2}</p>
      </>
    );
  }
  return (
    <>
      <h2
        style={{
          ...titleStyle,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span aria-hidden="true" style={{ color: BRAND.yellow, fontSize: "0.95em", lineHeight: 1 }}>
          ⚡
        </span>
        <span>{m.page3Title}</span>
      </h2>
      <p style={bodyStyle}>{m.page3Lead}</p>
      <p style={bodyStyle}>{m.page3Body}</p>
      <div style={{ margin: "14px 0 8px" }}>
        <MiniPlayerBadge highlight="buzz" />
      </div>
      <p style={{ ...captionStyle, marginBottom: 10 }}>{m.page3Caption}</p>
      <BuzzLegend />
      <p style={{ ...bodyStyle, marginTop: 14 }}>
        {m.page3Close}
        <br />
        {m.page3CloseNote}
      </p>
    </>
  );
}

const titleStyle = {
  margin: "0 0 12px",
  fontSize: "clamp(1.15rem, 4.2vw, 1.45rem)",
  fontWeight: 800,
  lineHeight: 1.2,
  color: PAGE_TEXT,
  fontFamily: FONT_FAMILY,
};

const bodyStyle = {
  margin: "0 0 10px",
  fontSize: "clamp(0.92rem, 3.4vw, 1.05rem)",
  lineHeight: 1.45,
  fontWeight: 600,
  color: PAGE_TEXT,
  fontFamily: FONT_FAMILY,
};

const captionStyle = {
  margin: "0 0 10px",
  fontSize: "0.8rem",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: PAGE_TEXT_MUTED,
  fontFamily: FONT_FAMILY,
};

/**
 * Bouton info bas-gauche + modal opaque (scores / EleyBuzz).
 */
export default function PlayerScoreHelp() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const titleId = useId();
  const m = PLAYER_SCORE_HELP;

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowRight") setPage((p) => Math.min(PAGE_COUNT - 1, p + 1));
      if (e.key === "ArrowLeft") setPage((p) => Math.max(0, p - 1));
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const openModal = () => {
    setPage(0);
    setOpen(true);
  };

  const closeModal = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        disabled={open}
        aria-label={m.openLabel}
        title={m.openLabel}
        style={{
          position: "absolute",
          left: "max(12px, env(safe-area-inset-left, 0px))",
          bottom: "max(12px, env(safe-area-inset-bottom, 0px))",
          width: 88,
          height: 88,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          cursor: open ? "default" : "pointer",
          opacity: open ? 0.28 : 0.55,
          pointerEvents: open ? "none" : "auto",
          zIndex: 4,
          display: "grid",
          placeItems: "center",
          padding: 0,
          boxShadow: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <InfoIcon size={60} />
      </button>

      {open && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(0, 0, 0, 0.78)",
            display: "grid",
            placeItems: "center",
            padding: "max(16px, env(safe-area-inset-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px))",
            boxSizing: "border-box",
          }}
          onClick={closeModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(420px, 100%)",
              maxHeight: "min(78dvh, 640px)",
              overflow: "auto",
              borderRadius: 18,
              background: "#1a0f2e",
              border: `2px solid ${BRAND.mauveDark}`,
              boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
              color: PAGE_TEXT,
              fontFamily: FONT_FAMILY,
              padding: "18px 18px 16px",
              boxSizing: "border-box",
              position: "relative",
              textAlign: "left",
            }}
          >
            <button
              type="button"
              onClick={closeModal}
              aria-label={m.closeLabel}
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                width: 36,
                height: 36,
                borderRadius: "50%",
                border: "1px solid rgba(255,251,245,0.2)",
                background: "rgba(0,0,0,0.35)",
                color: PAGE_TEXT,
                fontSize: "1.25rem",
                fontWeight: 700,
                cursor: "pointer",
                lineHeight: 1,
                display: "grid",
                placeItems: "center",
                padding: 0,
              }}
            >
              ×
            </button>

            <div id={titleId} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              {m.dialogTitle}
            </div>

            <div style={{ paddingRight: 28, minHeight: 220 }}>
              <PageBody page={page} />
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                marginTop: 16,
                paddingTop: 12,
                borderTop: "1px solid rgba(255,251,245,0.12)",
              }}
            >
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                style={navBtnStyle(page === 0)}
              >
                {m.prev}
              </button>

              <div style={{ display: "flex", gap: 6, alignItems: "center" }} aria-label={`${page + 1} / ${PAGE_COUNT}`}>
                {Array.from({ length: PAGE_COUNT }, (_, i) => (
                  <span
                    key={i}
                    style={{
                      width: i === page ? 8 : 6,
                      height: i === page ? 8 : 6,
                      borderRadius: "50%",
                      background: i === page ? BRAND.yellow : "rgba(255,251,245,0.28)",
                    }}
                  />
                ))}
              </div>

              {page < PAGE_COUNT - 1 ? (
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(PAGE_COUNT - 1, p + 1))}
                  style={navBtnStyle(false)}
                >
                  {m.next}
                </button>
              ) : (
                <button type="button" onClick={closeModal} style={navBtnStyle(false)}>
                  {m.done}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function navBtnStyle(disabled) {
  return {
    minWidth: 88,
    padding: "8px 12px",
    borderRadius: 10,
    border: `1px solid ${disabled ? "rgba(255,251,245,0.12)" : BRAND.blue}`,
    background: disabled ? "transparent" : "rgba(16, 170, 209, 0.18)",
    color: disabled ? PAGE_TEXT_MUTED : PAGE_TEXT,
    fontFamily: FONT_FAMILY,
    fontWeight: 700,
    fontSize: "0.9rem",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
  };
}
