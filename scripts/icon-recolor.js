/**
 * Recolorise le logo (forme bleue d’origine) + fonds / export PWA.
 */
const sharp = require("sharp");

const MAUVE_DARK = { r: 13, g: 5, b: 37 };
const MAUVE_LIGHT = { r: 93, g: 24, b: 60 };

/** Filigrane accueil : noir → mauve foncé */
const LOGO_MARK_DARK = { r: 0, g: 0, b: 0 };
const LOGO_MARK_LIGHT = { r: 0x0d, g: 0x05, b: 0x25 };

/** Fond PWA — charte (#e24d1c → #fe9334 → #feed6a) */
const ORANGE_DARK = { r: 0xe2, g: 0x4d, b: 0x1c };
const ORANGE_LIGHT = { r: 0xfe, g: 0x93, b: 0x34 };
const YELLOW = { r: 0xfe, g: 0xed, b: 0x6a };

const BG_LUM = 32;
const PEAK_LUM = 195;
const SOFT = 50;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(a, b, t) {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}

function gradientAt(x, y, width, height, dark, light) {
  const t = (x / Math.max(1, width - 1) + (1 - y / Math.max(1, height - 1))) / 2;
  return lerpColor(dark, light, t);
}

function gradientBackgroundAt(y, height) {
  const progress = 1 - y / Math.max(1, height - 1);
  if (progress <= 0.48) return lerpColor(ORANGE_DARK, ORANGE_LIGHT, progress / 0.48);
  return lerpColor(ORANGE_LIGHT, YELLOW, (progress - 0.48) / 0.52);
}

function alphaFromLuminance(lum, alphaIn, soft) {
  if (lum < BG_LUM) return 0;
  if (lum >= BG_LUM + soft) return alphaIn;
  const t = (lum - BG_LUM) / soft;
  return Math.round(alphaIn * t);
}

function shapeStrength(lum, sharpEdges) {
  if (lum < BG_LUM) return 0;
  const s = Math.min(1, (lum - BG_LUM) / (PEAK_LUM - BG_LUM));
  if (!sharpEdges) return s;
  return s < 0.15 ? 0 : 1;
}

async function loadSquareFromSource(srcPath) {
  const meta = await sharp(srcPath).metadata();
  const size = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - size) / 2);
  const top = Math.floor((meta.height - size) / 2);
  return sharp(srcPath).extract({ left, top, width: size, height: size }).toBuffer();
}

async function renderGradientBackgroundPng(size) {
  const width = size;
  const height = size;
  const channels = 4;
  const out = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y += 1) {
    const row = gradientBackgroundAt(y, height);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      out[i] = row.r;
      out[i + 1] = row.g;
      out[i + 2] = row.b;
      out[i + 3] = 255;
    }
  }

  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function renderMauveLogoPng(squareBuf, opts = {}) {
  const {
    transparentBg = false,
    size = 512,
    dark = MAUVE_DARK,
    light = MAUVE_LIGHT,
    sharpEdges = false,
  } = opts;

  const soft = sharpEdges ? 10 : SOFT;
  const glowMix = sharpEdges ? 0 : 0.35;
  const glowBoost = sharpEdges ? 0 : 18;

  const { data, info } = await sharp(squareBuf)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const out = Buffer.alloc(data.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const shape = shapeStrength(lum, sharpEdges);

      if (shape <= 0) {
        if (transparentBg) {
          out[i] = 0;
          out[i + 1] = 0;
          out[i + 2] = 0;
          out[i + 3] = 0;
        } else {
          out[i] = dark.r;
          out[i + 1] = dark.g;
          out[i + 2] = dark.b;
          out[i + 3] = 255;
        }
        continue;
      }

      const grad = gradientAt(x, y, width, height, dark, light);
      const glow = sharpEdges ? shape : shape * shape;
      out[i] = Math.min(255, Math.round(lerp(grad.r, light.r, glow * glowMix) + glow * glowBoost));
      out[i + 1] = Math.min(
        255,
        Math.round(lerp(grad.g, light.g, glow * glowMix) + glow * 6 * (glowBoost ? 1 : 0))
      );
      out[i + 2] = Math.min(
        255,
        Math.round(lerp(grad.b, light.b, glow * glowMix) + glow * 10 * (glowBoost ? 1 : 0))
      );
      out[i + 3] = transparentBg ? alphaFromLuminance(lum, data[i + 3], soft) : 255;
    }
  }

  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function renderPwaIconPng(squareBuf, size, logoScale = 1) {
  const logoSize = Math.round(size * logoScale);
  const logoBuf = await renderMauveLogoPng(squareBuf, {
    transparentBg: true,
    size: logoSize,
    dark: LOGO_MARK_DARK,
    light: LOGO_MARK_LIGHT,
    sharpEdges: true,
  });
  const bgBuf = await renderGradientBackgroundPng(size);

  return sharp(bgBuf)
    .composite([{ input: logoBuf, gravity: "center" }])
    .png()
    .toBuffer();
}

module.exports = {
  MAUVE_DARK,
  MAUVE_LIGHT,
  LOGO_MARK_DARK,
  LOGO_MARK_LIGHT,
  ORANGE_DARK,
  ORANGE_LIGHT,
  YELLOW,
  loadSquareFromSource,
  renderMauveLogoPng,
  renderGradientBackgroundPng,
  renderPwaIconPng,
};
