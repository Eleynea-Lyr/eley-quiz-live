// ============================================================================
// lib/brand-theme.js — Charte EleyBox (Player + Screen uniquement)
// ============================================================================

export const BRAND = {
  mauveDark: "#0d0525",
  mauveLight: "#5d183c",
  red: "#b12b2f",
  orangeDark: "#e24d1c",
  orangeLight: "#fe9334",
  yellow: "#feed6a",
  blue: "#10aad1",
  /** Succès / bonne réponse — émeraude adoucie (proche du bleu, moins fluo que l’ancien vert) */
  green: "#3aab7a",
};

export const FONT_FAMILY =
  '"Source Sans 3", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

/** Texte sur fond sombre (Player + Screen) */
export const PAGE_TEXT = "rgba(255, 251, 245, 0.94)";
export const PAGE_TEXT_MUTED = "rgba(255, 251, 245, 0.72)";

/** Bas rouge → orange foncé → haut orange clair (legacy / barres) */
export const PAGE_BG_GRADIENT = `linear-gradient(to top, ${BRAND.red} 0%, ${BRAND.orangeDark} 48%, ${BRAND.orangeLight} 100%)`;

/** Player + Screen : mauve violet (bas) → noir diffus (haut) */
export const BRAND_PAGE_BG =
  "linear-gradient(to top, #2a1848 0%, #241640 22%, #1e1234 48%, #160e28 68%, #0a0614 86%, #000000 100%)";

/** Mauve du bas du dégradé Player/Screen — fond des badges joueur */
export const BRAND_PAGE_BOTTOM = "#2a1848";

/** Fond des cadres image quiz (bandes noires si l'image ne remplit pas le cadre) */
export const IMAGE_FRAME_BG = "#000000";

/** @deprecated alias — utiliser pageShellStyle */
export const PLAYER_WELCOME_BG = BRAND_PAGE_BG;

export const pageShellStyle = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: "max(100dvh, calc(var(--vh, 1vh) * 100))",
  backgroundColor: "#000000",
  backgroundImage: BRAND_PAGE_BG,
  backgroundRepeat: "no-repeat",
  backgroundSize: "cover",
  backgroundPosition: "center",
  color: PAGE_TEXT,
  fontFamily: FONT_FAMILY,
  position: "relative",
};

/** Accueil Player — alias (texte clair = défaut pageShellStyle) */
export const playerWelcomeShellStyle = {
  ...pageShellStyle,
};

export const BAR_BLUE = BRAND.blue;
export const BAR_RED = BRAND.red;
export const HANDLE_COLOR = BRAND.mauveDark;

/** Sous-titre sur fond sombre */
export const pageTextSecondary = { color: PAGE_TEXT_MUTED };

/** Sous-titre sur cartes claires (classements, panels) */
export const textSecondary = { color: BRAND.mauveLight };

const btnBase = {
  fontFamily: FONT_FAMILY,
  fontWeight: 700,
  borderRadius: 10,
  touchAction: "manipulation",
  WebkitTapHighlightColor: "transparent",
  userSelect: "none",
};

/** Bouton principal — bleu charte, texte blanc */
export const btnPrimaryStyle = {
  ...btnBase,
  border: `2px solid ${BRAND.mauveDark}`,
  background: BRAND.blue,
  color: "#ffffff",
  cursor: "pointer",
};

/** Bouton secondaire — contour clair sur fond sombre */
export const btnSecondaryStyle = {
  ...btnBase,
  border: `1px solid rgba(255, 251, 245, 0.35)`,
  background: "rgba(255, 251, 245, 0.08)",
  color: PAGE_TEXT,
  cursor: "pointer",
};

/** Bouton danger — rouge charte */
export const btnDangerStyle = {
  ...btnBase,
  border: `2px solid ${BRAND.mauveDark}`,
  background: BRAND.red,
  color: "#ffffff",
  cursor: "pointer",
};

/** Bouton ghost danger — contour rouge */
export const btnGhostDangerStyle = {
  ...btnBase,
  border: `2px solid ${BRAND.red}`,
  background: "transparent",
  color: BRAND.red,
  cursor: "pointer",
};

/** Champ sur fond sombre — fond clair pour contraste */
export const inputFieldStyle = {
  boxSizing: "border-box",
  borderRadius: 10,
  border: `1px solid rgba(255, 251, 245, 0.3)`,
  background: "rgba(255, 251, 245, 0.95)",
  color: BRAND.mauveDark,
  fontFamily: FONT_FAMILY,
};

export const headingPageStyle = {
  fontWeight: 800,
  color: PAGE_TEXT,
};

export const badgeSuccess = {
  background: BRAND.green,
  border: `2px solid ${BRAND.mauveDark}`,
  color: BRAND.mauveDark,
  fontWeight: 700,
};

export const badgeError = {
  background: BRAND.red,
  border: `2px solid ${BRAND.mauveDark}`,
  color: "#ffffff",
  fontWeight: 700,
};

export const cardStyle = {
  background: "rgba(255, 251, 245, 0.93)",
  border: `1px solid ${BRAND.mauveDark}`,
  borderRadius: 12,
  color: BRAND.mauveDark,
};

/** Panneau latéral Screen — mauve pastel (#2a1848 adouci, bien visible mais clair) */
export const SCREEN_ASIDE_PANEL_BG = "#d5c6e8";

export const asidePanelStyle = {
  ...cardStyle,
  background: SCREEN_ASIDE_PANEL_BG,
  color: BRAND.mauveDark,
  fontFamily: FONT_FAMILY,
};

export const podiumCardStyle = {
  ...cardStyle,
  padding: "var(--eley-input-pad-y) var(--eley-input-pad-x)",
  color: BRAND.mauveDark,
  fontFamily: FONT_FAMILY,
};

export const questionTextStyle = {
  fontFamily: FONT_FAMILY,
  color: PAGE_TEXT,
  fontSize: "var(--eley-text-question)",
  lineHeight: 1.45,
  margin: 0,
  marginTop: 6,
  maxWidth: "min(600px, 95%)",
  marginLeft: "auto",
  marginRight: "auto",
  overflowWrap: "break-word",
  wordBreak: "normal",
  hyphens: "auto",
  textAlign: "center",
  letterSpacing: "0.01em",
};

/** Bouton buzzer : bleu pressé (légèrement plus sombre) */
export const BUZZER_BLUE_PRESSED = "#0d8aab";
