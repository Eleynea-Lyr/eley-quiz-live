/*
 * Construit un favicon.ico léger en embarquant directement des PNG
 * (le format ICO supporte des entrées encodées en PNG depuis Windows Vista).
 * Évite le gonflement des outils qui ré-encodent en BMP haute résolution.
 *
 * Usage : node scripts/make-favicon-ico.js
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "favicon.ico");
const ICONS = path.join(__dirname, "..", "public", "icons");

// Tailles à embarquer (doivent exister en PNG dans public/icons)
const SOURCES = [
  { size: 16, file: "favicon-16.png" },
  { size: 32, file: "favicon-32.png" },
  { size: 48, file: "favicon-48.png" },
];

function build() {
  const images = SOURCES.map(({ size, file }) => ({
    size,
    data: fs.readFileSync(path.join(ICONS, file)),
  }));

  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16; // après header + table des entrées

  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // largeur
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // hauteur
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // plans
    entry.writeUInt16LE(32, 6); // bits par pixel
    entry.writeUInt32LE(img.data.length, 8); // taille des données
    entry.writeUInt32LE(offset, 12); // offset des données
    offset += img.data.length;
    entries.push(entry);
  }

  const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
  fs.writeFileSync(OUT, ico);
  console.log("favicon.ico écrit :", ico.length, "octets");
}

build();
