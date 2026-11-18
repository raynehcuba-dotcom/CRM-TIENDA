// Uso (desde la raíz de CRM-TIENDA-main):
//   npm install material-symbols @fontsource-variable/dm-sans @fontsource-variable/jetbrains-mono @fontsource-variable/plus-jakarta-sans
//   node fix-fonts.mjs
// Copia las fuentes a assets/fonts y sustituye los <link> de Google Fonts en los *.html de la raíz.
import fs from 'node:fs';
import path from 'node:path';

const nm = 'node_modules';
const destDir = path.join('assets', 'fonts');
fs.mkdirSync(destDir, { recursive: true });

const files = [
  [`${nm}/material-symbols/material-symbols-outlined.woff2`, 'material-symbols-outlined.woff2'],
  [`${nm}/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2`, 'dm-sans.woff2'],
  [`${nm}/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2`, 'jetbrains-mono.woff2'],
  [`${nm}/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2`, 'plus-jakarta-sans.woff2'],
];
for (const [src, name] of files) {
  if (!fs.existsSync(src)) { console.error('Falta ' + src + ' (ejecute primero npm install de los paquetes).'); process.exit(1); }
  fs.copyFileSync(src, path.join(destDir, name));
}

const css = `/* Fuentes locales (funcionan sin conexión) */
@font-face{font-family:'DM Sans';font-style:normal;font-weight:100 1000;font-display:swap;src:url('./dm-sans.woff2') format('woff2');}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;font-display:swap;src:url('./jetbrains-mono.woff2') format('woff2');}
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;font-display:swap;src:url('./plus-jakarta-sans.woff2') format('woff2');}
@font-face{font-family:'Material Symbols Outlined';font-style:normal;font-weight:100 700;font-display:block;src:url('./material-symbols-outlined.woff2') format('woff2');}
.material-symbols-outlined{font-family:'Material Symbols Outlined';font-weight:normal;font-style:normal;font-size:24px;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:'liga';font-feature-settings:'liga';-webkit-font-smoothing:antialiased;}
`;
fs.writeFileSync(path.join(destDir, 'fonts.css'), css);

const tag = '<link rel="stylesheet" href="/assets/fonts/fonts.css"/>';
const googleLink = /[ \t]*<link\b[^>]*(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>\s*\n?/gi;

for (const f of fs.readdirSync('.').filter(n => n.toLowerCase().endsWith('.html'))) {
  let html = fs.readFileSync(f, 'utf8');
  if (html.includes('/assets/fonts/fonts.css')) { console.log('Ya corregido: ' + f); continue; }
  const before = html;
  html = html.replace(googleLink, '');
  if (html === before) { console.log('Sin enlaces de Google Fonts: ' + f); continue; }
  html = html.replace(/<\/head>/i, `  ${tag}\n</head>`);
  fs.writeFileSync(f, html);
  console.log('Corregido: ' + f);
}
console.log('Listo. Ahora ejecute: npm run desktop:exe');
