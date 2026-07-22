/**
 * Rassemble les fichiers du site statique dans public/ pour Vercel.
 * Lancé automatiquement par le script « vercel-build ».
 */
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const sortie = path.join(racine, 'public');

const FICHIERS = [
  'index.html',
  'style.css',
  'app.js',
  'sw.js',
  'supabase-config.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

fs.mkdirSync(sortie, { recursive: true });

let copies = 0;
for (const nom of FICHIERS) {
  const source = path.join(racine, nom);
  if (!fs.existsSync(source)) {
    console.warn('Ignoré (absent) : ' + nom);
    continue;
  }
  fs.copyFileSync(source, path.join(sortie, nom));
  copies++;
}

console.log('public/ prêt : ' + copies + ' fichiers copiés.');
