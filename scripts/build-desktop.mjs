import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const REQUIRED_BUNDLES = [
  'assets/inventory-app.js',
  'assets/dashboard-app.js',
  'assets/pos-app.js',
  'assets/suppliers-app.js',
  'assets/petty-cash-app.js',
  'assets/low-stock-report-app.js',
  'assets/daily-summary-app.js',
  'assets/stock-alert-monitor-app.js',
];

for (const rel of REQUIRED_BUNDLES) {
  const full = path.join(ROOT_DIR, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`Falta bundle de cliente requerido: ${rel}. Ejecuta "npm run build" primero.`);
  }
}

const outDir = path.join(ROOT_DIR, 'dist-electron');
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(ROOT_DIR, 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  external: ['node:sqlite', 'esbuild', 'electron'],
  define: {
    'process.env.GESTOR_TIENDA_PACKAGED': '"1"',
    'process.env.GESTOR_TIENDA_EMBEDDED': '"1"',
  },
  outfile: path.join(outDir, 'server.cjs'),
});

console.log('Bundle embebido generado correctamente en dist-electron/server.cjs');
