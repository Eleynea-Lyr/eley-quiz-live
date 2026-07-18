/*

 * Génère les icônes PWA / favicons depuis assets/icon-source.png

 * Fond : dégradé orange foncé → orange clair → jaune (#e24d1c → #fe9334 → #feed6a)

 * Logo : noir → mauve foncé (#000 → #0d0525)

 * Usage : node scripts/make-icons.js

 */

const sharp = require("sharp");

const path = require("path");

const fs = require("fs");

const { loadSquareFromSource, renderPwaIconPng } = require("./icon-recolor");



const SRC = path.join(__dirname, "..", "assets", "icon-source.png");

const OUT = path.join(__dirname, "..", "public", "icons");



async function main() {

  if (!fs.existsSync(SRC)) {

    throw new Error("Source introuvable : " + SRC);

  }

  fs.mkdirSync(OUT, { recursive: true });



  const squareBuf = await loadSquareFromSource(SRC);

  const icon512 = await renderPwaIconPng(squareBuf, 512, 1);

  const iconMaskable = await renderPwaIconPng(squareBuf, 512, 0.78);



  await sharp(icon512).png().toFile(path.join(OUT, "icon-512.png"));

  await sharp(icon512).resize(192, 192).png().toFile(path.join(OUT, "icon-192.png"));

  await sharp(icon512).resize(180, 180).png().toFile(path.join(OUT, "apple-touch-icon.png"));



  await sharp(icon512).resize(48, 48).png().toFile(path.join(OUT, "favicon-48.png"));

  await sharp(icon512).resize(32, 32).png().toFile(path.join(OUT, "favicon-32.png"));

  await sharp(icon512).resize(16, 16).png().toFile(path.join(OUT, "favicon-16.png"));



  await sharp(iconMaskable).png().toFile(path.join(OUT, "icon-maskable-512.png"));



  console.log("Icônes PWA générées dans", OUT);

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


