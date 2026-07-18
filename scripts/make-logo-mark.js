/*

 * Logo transparent (filigrane accueil Player)

 * Dégradé : noir (#000) → mauve foncé (#0d0525), contours nets

 * Usage : node scripts/make-logo-mark.js

 */

const sharp = require("sharp");

const path = require("path");

const fs = require("fs");

const {

  loadSquareFromSource,

  renderMauveLogoPng,

  LOGO_MARK_DARK,

  LOGO_MARK_LIGHT,

} = require("./icon-recolor");



const SRC = path.join(__dirname, "..", "assets", "icon-source.png");

const OUT_DIR = path.join(__dirname, "..", "public", "graphics");

const OUT = path.join(OUT_DIR, "eley-logo-mark.png");



async function main() {

  if (!fs.existsSync(SRC)) {

    throw new Error("Source introuvable : " + SRC);

  }

  fs.mkdirSync(OUT_DIR, { recursive: true });



  const squareBuf = await loadSquareFromSource(SRC);

  const mark512 = await renderMauveLogoPng(squareBuf, {

    transparentBg: true,

    size: 512,

    dark: LOGO_MARK_DARK,

    light: LOGO_MARK_LIGHT,

    sharpEdges: true,

  });



  await sharp(mark512).sharpen({ sigma: 1, m1: 0.8, m2: 0.4 }).trim({ threshold: 1 }).png().toFile(OUT);



  console.log("Logo accueil généré :", OUT);

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


