import { startServer } from '/workspace/server.ts';

const s = await startServer({ port: 3987, host: '127.0.0.1', allowPortFallback: true });
console.log('PORT=' + s.port);

const pages = ['/dashboard','/pos','/inventario','/kardex','/proveedores','/cierre-caja','/caja-chica','/sangria','/cuadre','/clientes','/reportes','/reporte-stock-bajo','/recepcion','/comprobantes','/mantenimiento'];
let fail = 0;
for (const p of pages) {
  const r = await fetch(`http://127.0.0.1:${s.port}${p}`);
  const b = await r.text();
  const hits = [...new Set([...b.matchAll(/(?:src|href)=["']https?:\/\/[^"']+/gi)].map(m => m[0]))];
  console.log(r.status, p, hits.length ? 'REMOTO-> ' + hits.join(' | ') : 'OFFLINE-OK');
  if (r.status !== 200 || hits.length) fail++;
}
for (const a of ['/assets/tailwind-cdn.js','/css/material-icons.css','/css/tailwind.min.css','/assets/dashboard-app.js','/assets/logo-placeholder.svg']) {
  const r = await fetch(`http://127.0.0.1:${s.port}${a}`);
  console.log(r.status, a, r.status === 200 ? 'OFFLINE-OK' : 'FAIL');
  if (r.status !== 200) fail++;
}
console.log(fail === 0 ? 'TEST OFFLINE: PASS' : `TEST OFFLINE: FAIL (${fail})`);
await s.close();
process.exit(0);
