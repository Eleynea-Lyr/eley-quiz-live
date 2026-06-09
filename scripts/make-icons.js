/*
 * Script utilitaire (one-shot) : génère les icônes PWA à partir de assets/icon-source.png
 * Usage : node scripts/make-icons.js
 * Dépend de "sharp" (installé temporairement).
 */
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const SRC = path.join(__dirname, "..", "assets", "icon-source.png");
const OUT = path.join(__dirname, "..", "public", "icons");
const BG = { r: 2, g: 8, b: 23, alpha: 1 }; // #020617

async function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error("Source introuvable : " + SRC);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const meta = await sharp(SRC).metadata();
  const size = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - size) / 2);
  const top = Math.floor((meta.height - size) / 2);

  // Base carrée (recadrage centré)
  const squareBuf = await sharp(SRC)
    .extract({ left, top, width: size, height: size })
    .toBuffer();

  // Icônes "any"
  await sharp(squareBuf).resize(512, 512).png().toFile(path.join(OUT, "icon-512.png"));
  await sharp(squareBuf).resize(192, 192).png().toFile(path.join(OUT, "icon-192.png"));
  await sharp(squareBuf).resize(180, 180).flatten({ background: BG }).png().toFile(path.join(OUT, "apple-touch-icon.png"));

  // Favicons (onglet navigateur, surtout desktop) — fond opaque pour rester net en petit
  await sharp(squareBuf).resize(48, 48).flatten({ background: BG }).png().toFile(path.join(OUT, "favicon-48.png"));
  await sharp(squareBuf).resize(32, 32).flatten({ background: BG }).png().toFile(path.join(OUT, "favicon-32.png"));
  await sharp(squareBuf).resize(16, 16).flatten({ background: BG }).png().toFile(path.join(OUT, "favicon-16.png"));

  // Icône "maskable" : logo à ~78% sur fond navy (respect de la safe zone)
  const inner = Math.round(512 * 0.78);
  const innerBuf = await sharp(squareBuf).resize(inner, inner).toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
    .composite([{ input: innerBuf, gravity: "center" }])
    .png()
    .toFile(path.join(OUT, "icon-maskable-512.png"));

  console.log("Icônes générées dans", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
