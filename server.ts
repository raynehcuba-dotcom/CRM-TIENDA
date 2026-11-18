import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, hashSha256, runInTransaction, createSqliteBackup, listSqliteBackups, restoreSqliteBackup, closeDatabase } from './src/db.js';
import { buildInventoryCsv, getInventoryCsvFilename, type InventoryCsvRow } from './src/utils/csvExport.js';

const currentDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.env.APP_RESOURCES_DIR
  ? path.resolve(process.env.APP_RESOURCES_DIR)
  : currentDir.endsWith(`${path.sep}dist`) || currentDir.endsWith(`${path.sep}dist-electron`)
    ? path.resolve(currentDir, '..')
    : currentDir;

async function ensureDevClientBundles(): Promise<void> {
  if (
    process.env.GESTOR_TIENDA_PACKAGED === '1' ||
    process.env.GESTOR_TIENDA_EMBEDDED === '1' ||
    process.env.NODE_ENV === 'production'
  ) {
    return;
  }

  const reactEntryPoints: Array<{ src: string; out: string }> = [
    {
      src: path.join(ROOT_DIR, 'src', 'inventory-client.tsx'),
      out: path.join(ROOT_DIR, 'assets', 'inventory-app.js'),
    },
    {
      src: path.join(ROOT_DIR, 'src', 'dashboard-client.tsx'),
      out: path.join(ROOT_DIR, 'assets', 'dashboard-app.js'),
    },
    {
      src: path.join(ROOT_DIR, 'src', 'pos-client.tsx'),
      out: path.join(ROOT_DIR, 'assets', 'pos-app.js'),
    },
    {
      src: path.join(ROOT_DIR, 'src', 'suppliers-client.tsx'),
      out: path.join(ROOT_DIR, 'assets', 'suppliers-app.js'),
    },
    {
      src: path.join(ROOT_DIR, 'src', 'petty-cash-client.tsx'),
      out: path.join(ROOT_DIR, 'assets', 'petty-cash-app.js'),
    },
    {
      src: path.join(ROOT_DIR, 'src', 'stock-alert-monitor-client.tsx'),
      out: path.join(ROOT_DIR, 'assets', 'stock-alert-monitor-app.js'),
    },
  ];

  const existingEntries = reactEntryPoints.filter((entry) => fs.existsSync(entry.src));
  if (existingEntries.length === 0) return;

  const esbuild = await import('esbuild');
  for (const entry of existingEntries) {
    await esbuild.build({
      entryPoints: [entry.src],
      bundle: true,
      format: 'esm',
      minify: true,
      outfile: entry.out,
    });
  }
}

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
export const app = express();

app.use(express.json());

// ---------------------------------------------------------------------------
// VALIDATION & MONEY HELPERS
// ---------------------------------------------------------------------------

const PAYMENT_METHODS = new Set(['EFECTIVO', 'TRANSFERENCIA', 'MIXTO']);
const SUPPLIER_PAYMENT_CHANNELS = new Set(['EFECTIVO_GAVETA', 'TRANSFERENCIA_BANCARIA']);

/** Error controlado con código HTTP; el mensaje se devuelve al cliente. */
class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function respondError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/** Redondeo monetario a 2 decimales, evitando el arrastre binario de REAL. */
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseMoney(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, `${fieldName} debe ser un monto numérico válido.`);
  }
  return roundMoney(parsed);
}

interface TurnoCajaRow extends Record<string, unknown> {
  id: number;
  caja_numero: string;
  estado: string;
  fondo_inicial_cup: number;
  total_ventas_efectivo_cup: number;
  total_abonos_credito_cup: number;
  total_sangrias_cup: number;
  total_egresos_caja_chica_cup: number;
  total_reposiciones_cup?: number;
}

function getTurno(turnoId: number): TurnoCajaRow | undefined {
  return db.prepare('SELECT * FROM turnos_caja WHERE id = ?').get(turnoId) as TurnoCajaRow | undefined;
}

/** Verifica que la gaveta exista y esté abierta; corta la operación si no. */
function requireOpenTurno(turnoId: number): TurnoCajaRow {
  const turno = getTurno(turnoId);
  if (!turno) {
    throw new ApiError(400, `La gaveta #${turnoId} no existe.`);
  }
  if (String(turno.estado) !== 'ABIERTA') {
    throw new ApiError(
      409,
      `La gaveta ${turno.caja_numero} está ${turno.estado}. Abre un nuevo turno antes de registrar movimientos.`
    );
  }
  return turno;
}

function requireActiveUser(usuarioId: number, label = 'usuario'): void {
  const row = db.prepare('SELECT id FROM usuarios WHERE id = ? AND activo = 1').get(usuarioId);
  if (!row) {
    throw new ApiError(400, `El ${label} #${usuarioId} no existe o está inactivo.`);
  }
}

const FOLIO_TABLES = {
  comprobantes: 'comprobantes_pago_proveedor',
} as const;

/** Folio secuencial sin colisiones (MAX(id)+1 con ids AUTOINCREMENT). */
function nextFolio(prefix: string, table: (typeof FOLIO_TABLES)[keyof typeof FOLIO_TABLES], datePart: string): string {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next_seq FROM ${table}`).get() as {
    next_seq: number;
  };
  return `${prefix}-${datePart}-${String(Number(row?.next_seq ?? 1)).padStart(4, '0')}`;
}

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// API ENDPOINTS: INVENTORY & PRODUCTS (SQLite)
// ---------------------------------------------------------------------------

app.get('/api/categorias', (_req: Request, res: Response) => {
  const categorias = db.prepare('SELECT * FROM categorias ORDER BY id ASC').all();
  res.status(200).json({ categorias });
});

app.get('/api/productos', (req: Request, res: Response) => {
  const buscar = String(req.query.q ?? '').trim();
  let productos;

  if (buscar) {
    const like = `%${buscar}%`;
    productos = db.prepare(`
      SELECT p.*, c.nombre AS categoria_nombre, pr.nombre_comercial AS proveedor_nombre
      FROM productos p
      JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.activo = 1 AND (p.descripcion LIKE ? OR p.sku LIKE ? OR p.codigo_barras LIKE ?)
      ORDER BY p.id ASC
    `).all(like, like, like);
  } else {
    productos = db.prepare(`
      SELECT p.*, c.nombre AS categoria_nombre, pr.nombre_comercial AS proveedor_nombre
      FROM productos p
      JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.activo = 1
      ORDER BY p.id ASC
    `).all();
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_productos,
      COALESCE(SUM(stock_actual * precio_venta_cup), 0.0) AS valor_venta_total,
      COALESCE(SUM(stock_actual * costo_pmp), 0.0) AS valor_costo_total,
      SUM(CASE WHEN stock_actual <= stock_minimo THEN 1 ELSE 0 END) AS bajo_stock_count
    FROM productos
    WHERE activo = 1
  `).get();

  res.status(200).json({ productos, stats });
});

app.get('/api/productos/export/csv', (req: Request, res: Response) => {
  const filter = String(req.query.filter ?? '').trim().toLowerCase();
  const q = String(req.query.q ?? '').trim();
  const clauses = ['p.activo = 1'];
  const params: string[] = [];

  if (filter === 'bajo-stock') {
    clauses.push('p.stock_actual <= p.stock_minimo');
  }
  if (q) {
    const like = `%${q}%`;
    clauses.push('(p.descripcion LIKE ? OR p.sku LIKE ? OR p.codigo_barras LIKE ?)');
    params.push(like, like, like);
  }

  const rows = db.prepare(`
    SELECT
      p.sku,
      p.codigo_barras,
      p.descripcion,
      c.nombre AS categoria_nombre,
      pr.nombre_comercial AS proveedor_nombre,
      p.unidad_medida,
      p.stock_actual,
      p.stock_minimo,
      p.costo_ultimo,
      p.costo_pmp,
      p.precio_venta_cup,
      p.precio_venta_usd
    FROM productos p
    JOIN categorias c ON p.categoria_id = c.id
    LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY p.stock_actual ASC, p.descripcion ASC
  `).all(...params) as unknown as InventoryCsvRow[];

  const csvContent = buildInventoryCsv(rows);
  const filename = getInventoryCsvFilename();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(csvContent);
});

app.post('/api/productos', (req: Request, res: Response) => {
  try {
    const sku = String(req.body?.sku ?? '').trim() || `SKU-${Date.now().toString().slice(-5)}`;
    const rawBarcode = String(req.body?.codigo_barras ?? '').trim();
    const codigo_barras = rawBarcode || `789${Date.now().toString().slice(-8)}`;
    const descripcion = String(req.body?.descripcion ?? '').trim();
    const categoria_id = Number(req.body?.categoria_id ?? 1);
    const proveedor_id = req.body?.proveedor_id ? Number(req.body.proveedor_id) : null;
    const unidad_medida = String(req.body?.unidad_medida ?? 'UNIDAD').trim() || 'UNIDAD';
    const stock_actual = Number(req.body?.stock_actual ?? 0);
    const stock_minimo = Number(req.body?.stock_minimo ?? 10);
    const costo = Number(req.body?.costo_ultimo ?? req.body?.costo ?? 0);
    const precio_venta_cup = Number(req.body?.precio_venta_cup ?? 0);

    if (!descripcion || !Number.isFinite(precio_venta_cup) || precio_venta_cup <= 0) {
      res.status(400).json({ success: false, error: 'Descripción y precio de venta mayor a 0 son obligatorios' });
      return;
    }
    if (!Number.isFinite(stock_actual) || stock_actual < 0 || !Number.isFinite(stock_minimo) || stock_minimo < 0 || !Number.isFinite(costo) || costo < 0) {
      res.status(400).json({ success: false, error: 'Stock y costos deben ser valores numéricos no negativos' });
      return;
    }

    const existingSku = db.prepare('SELECT id FROM productos WHERE sku = ?').get(sku) as { id: number } | undefined;
    if (existingSku) {
      res.status(409).json({ success: false, error: `Ya existe un producto con el SKU "${sku}"` });
      return;
    }

    const existingBarcode = db.prepare('SELECT id FROM productos WHERE codigo_barras = ?').get(codigo_barras) as { id: number } | undefined;
    if (existingBarcode) {
      res.status(409).json({ success: false, error: `Ya existe un producto con el código de barras "${codigo_barras}"` });
      return;
    }

    const created = runInTransaction(() => {
      const info = db.prepare(`
        INSERT INTO productos (
          sku, codigo_barras, descripcion, categoria_id, proveedor_id,
          unidad_medida, stock_actual, stock_minimo, costo_ultimo, costo_pmp, precio_venta_cup
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sku, codigo_barras, descripcion, categoria_id, proveedor_id, unidad_medida, stock_actual, stock_minimo, costo, costo, precio_venta_cup);

      const newId = Number(info.lastInsertRowid);
      if (stock_actual > 0) {
        const folio = `ENT-INI-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${newId}`;
        db.prepare(`
          INSERT INTO kardex_movimientos (
            producto_id, tipo_movimiento, referencia_folio, cantidad,
            stock_previo, stock_resultante, costo_unitario, costo_total, usuario_id, hash_sha256
          ) VALUES (?, 'ENTRADA_RECEPCION', ?, ?, 0, ?, ?, ?, 1, ?)
        `).run(newId, folio, stock_actual, stock_actual, costo, stock_actual * costo, hashSha256(`${folio}|${newId}|${stock_actual}`));
      }

      return db.prepare(`
        SELECT p.*, c.nombre AS categoria_nombre, pr.nombre_comercial AS proveedor_nombre
        FROM productos p
        JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
        WHERE p.id = ?
      `).get(newId);
    });

    res.status(201).json({ success: true, producto: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/productos/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Identificador de producto inválido' });
      return;
    }

    const current = db.prepare('SELECT * FROM productos WHERE id = ? AND activo = 1').get(id) as Record<string, unknown> | undefined;
    if (!current) {
      res.status(404).json({ success: false, error: 'Producto no encontrado en SQLite' });
      return;
    }

    const sku = String(req.body?.sku ?? current.sku).trim();
    const rawBarcode = req.body?.codigo_barras !== undefined ? String(req.body.codigo_barras ?? '').trim() : String(current.codigo_barras ?? '').trim();
    const codigo_barras = rawBarcode || null;
    const descripcion = String(req.body?.descripcion ?? current.descripcion).trim();
    const categoria_id = Number(req.body?.categoria_id ?? current.categoria_id);
    const rawProv = req.body?.proveedor_id !== undefined ? req.body.proveedor_id : current.proveedor_id;
    const proveedor_id = rawProv === '' || rawProv === null || rawProv === undefined ? null : Number(rawProv);
    const unidad_medida = String(req.body?.unidad_medida ?? current.unidad_medida).trim() || 'UNIDAD';
    const stock_actual = Number(req.body?.stock_actual ?? current.stock_actual);
    const stock_minimo = Number(req.body?.stock_minimo ?? current.stock_minimo);
    const costo_ultimo = Number(req.body?.costo_ultimo ?? current.costo_ultimo);
    const precio_venta_cup = Number(req.body?.precio_venta_cup ?? current.precio_venta_cup);

    if (!sku || !descripcion || !Number.isFinite(precio_venta_cup) || precio_venta_cup <= 0) {
      res.status(400).json({ success: false, error: 'SKU, nombre y precio de venta mayor a 0 son obligatorios' });
      return;
    }
    if (!Number.isFinite(stock_actual) || stock_actual < 0 || !Number.isFinite(stock_minimo) || stock_minimo < 0 || !Number.isFinite(costo_ultimo) || costo_ultimo < 0) {
      res.status(400).json({ success: false, error: 'Stock y costos deben ser valores numéricos no negativos' });
      return;
    }
    if (!Number.isInteger(categoria_id) || categoria_id <= 0) {
      res.status(400).json({ success: false, error: 'Categoría inválida' });
      return;
    }
    if (proveedor_id !== null && (!Number.isInteger(proveedor_id) || proveedor_id <= 0)) {
      res.status(400).json({ success: false, error: 'Proveedor inválido' });
      return;
    }

    const dupSku = db.prepare('SELECT id FROM productos WHERE sku = ? AND id != ?').get(sku, id) as { id: number } | undefined;
    if (dupSku) {
      res.status(409).json({ success: false, error: `Otro producto ya utiliza el SKU "${sku}"` });
      return;
    }

    if (codigo_barras) {
      const dupBar = db.prepare('SELECT id FROM productos WHERE codigo_barras = ? AND id != ?').get(codigo_barras, id) as { id: number } | undefined;
      if (dupBar) {
        res.status(409).json({ success: false, error: `Otro producto ya utiliza el código de barras "${codigo_barras}"` });
        return;
      }
    }

    const updated = runInTransaction(() => {
      const prevStock = Number(current.stock_actual);
      const nextCostoPmp = costo_ultimo > 0 && Number(current.costo_pmp) === 0 ? costo_ultimo : (costo_ultimo !== Number(current.costo_ultimo) ? costo_ultimo : Number(current.costo_pmp));

      db.prepare(`
        UPDATE productos
        SET sku = ?,
            codigo_barras = ?,
            descripcion = ?,
            categoria_id = ?,
            proveedor_id = ?,
            unidad_medida = ?,
            stock_actual = ?,
            stock_minimo = ?,
            costo_ultimo = ?,
            costo_pmp = ?,
            precio_venta_cup = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        sku,
        codigo_barras,
        descripcion,
        categoria_id,
        proveedor_id,
        unidad_medida,
        stock_actual,
        stock_minimo,
        costo_ultimo,
        nextCostoPmp,
        precio_venta_cup,
        id
      );

      if (stock_actual !== prevStock) {
        const diff = Math.abs(stock_actual - prevStock);
        const folio = `EDT-${Date.now().toString().slice(-6)}`;
        const h = hashSha256(`AJUSTE_ARQUEO|${folio}|${id}|${prevStock}|${stock_actual}`);
        db.prepare(`
          INSERT INTO kardex_movimientos (
            producto_id, tipo_movimiento, referencia_folio, cantidad,
            stock_previo, stock_resultante, costo_unitario, costo_total, usuario_id, hash_sha256
          ) VALUES (?, 'AJUSTE_ARQUEO', ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(id, folio, diff, prevStock, stock_actual, nextCostoPmp, diff * nextCostoPmp, h);
      }

      return db.prepare(`
        SELECT p.*, c.nombre AS categoria_nombre, pr.nombre_comercial AS proveedor_nombre
        FROM productos p
        JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
        WHERE p.id = ?
      `).get(id);
    });

    res.status(200).json({ success: true, producto: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/productos/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Identificador de producto inválido' });
      return;
    }

    const current = db.prepare('SELECT id, sku, descripcion FROM productos WHERE id = ? AND activo = 1').get(id) as
      | { id: number; sku: string; descripcion: string }
      | undefined;

    if (!current) {
      res.status(404).json({ success: false, error: 'Producto no encontrado o ya eliminado' });
      return;
    }

    const result = runInTransaction(() => {
      const salesRef = db.prepare('SELECT COUNT(*) AS count FROM venta_detalles WHERE producto_id = ?').get(id) as { count: number };

      if (salesRef && salesRef.count > 0) {
        const archivedSku = `${current.sku}__DEL_${id}_${Date.now().toString().slice(-4)}`;
        db.prepare(`
          UPDATE productos
          SET activo = 0,
              sku = ?,
              codigo_barras = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(archivedSku, id);
        return { mode: 'archived' as const, id, sku: current.sku, descripcion: current.descripcion };
      }

      db.prepare('DELETE FROM kardex_movimientos WHERE producto_id = ?').run(id);
      db.prepare('DELETE FROM productos WHERE id = ?').run(id);
      return { mode: 'deleted' as const, id, sku: current.sku, descripcion: current.descripcion };
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/productos/entrada', (req: Request, res: Response) => {
  try {
    const skuOrText = String(req.body?.sku ?? req.body?.producto ?? '').trim();
    const productoIdParam = req.body?.producto_id ? Number(req.body.producto_id) : null;
    const cantidad = Number(req.body?.cantidad ?? 0);
    const costoRaw = req.body?.costo_unitario;
    const proveedorNombre = String(req.body?.proveedor ?? '').trim();

    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      res.status(400).json({ success: false, error: 'La cantidad debe ser mayor a 0' });
      return;
    }
    if (productoIdParam !== null && (!Number.isInteger(productoIdParam) || productoIdParam <= 0)) {
      res.status(400).json({ success: false, error: 'Identificador de producto inválido' });
      return;
    }
    if (costoRaw !== undefined && costoRaw !== null && costoRaw !== '') {
      const costoCheck = Number(costoRaw);
      if (!Number.isFinite(costoCheck) || costoCheck < 0) {
        res.status(400).json({ success: false, error: 'El costo unitario debe ser un número mayor o igual a 0' });
        return;
      }
    }

    const result = runInTransaction(() => {
      let prod: Record<string, unknown> | undefined;
      if (productoIdParam) {
        prod = db.prepare('SELECT * FROM productos WHERE id = ?').get(productoIdParam) as Record<string, unknown> | undefined;
      } else {
        const skuCode = skuOrText.split(' - ')[0].trim();
        prod = db.prepare('SELECT * FROM productos WHERE sku = ? OR descripcion LIKE ? LIMIT 1').get(skuCode, `%${skuOrText}%`) as Record<string, unknown> | undefined;
      }

      if (!prod) {
        throw new Error('Producto no encontrado en SQLite');
      }

      const prodId = Number(prod.id);
      const stockPrevio = Number(prod.stock_actual);
      const stockNuevo = stockPrevio + cantidad;
      const costoUnit = costoRaw !== undefined && costoRaw !== '' && Number.isFinite(Number(costoRaw))
        ? Number(costoRaw)
        : Number(prod.costo_ultimo);

      const nuevoPmp = stockNuevo > 0
        ? ((stockPrevio * Number(prod.costo_pmp)) + (cantidad * costoUnit)) / stockNuevo
        : costoUnit;

      let provId = prod.proveedor_id ? Number(prod.proveedor_id) : null;
      if (proveedorNombre) {
        const pRow = db.prepare('SELECT id FROM proveedores WHERE nombre_comercial LIKE ? LIMIT 1').get(`%${proveedorNombre}%`) as { id: number } | undefined;
        if (pRow) provId = pRow.id;
      }

      db.prepare(`
        UPDATE productos
        SET stock_actual = ?, costo_ultimo = ?, costo_pmp = ?, proveedor_id = COALESCE(?, proveedor_id), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(stockNuevo, costoUnit, nuevoPmp, provId, prodId);

      const folio = `REC-ENT-${Date.now().toString().slice(-6)}`;
      const h = hashSha256(`ENTRADA_RECEPCION|${folio}|${prodId}|${cantidad}|${costoUnit}`);
      db.prepare(`
        INSERT INTO kardex_movimientos (
          producto_id, tipo_movimiento, referencia_folio, cantidad,
          stock_previo, stock_resultante, costo_unitario, costo_total, usuario_id, hash_sha256
        ) VALUES (?, 'ENTRADA_RECEPCION', ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(prodId, folio, cantidad, stockPrevio, stockNuevo, costoUnit, cantidad * costoUnit, h);

      return {
        folio,
        producto_id: prodId,
        sku: String(prod.sku),
        descripcion: String(prod.descripcion),
        stock_previo: stockPrevio,
        stock_actual: stockNuevo,
      };
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/productos/ajuste', (req: Request, res: Response) => {
  try {
    const sku = String(req.body?.sku ?? '').trim();
    const productoIdParam = req.body?.producto_id ? Number(req.body.producto_id) : null;
    const nuevaCantidad = Number(req.body?.nueva_cantidad ?? 0);
    const tipoAjuste = String(req.body?.tipo_ajuste ?? 'conteo');
    const motivo = String(req.body?.motivo ?? 'Ajuste manual de inventario').trim();

    if (!Number.isFinite(nuevaCantidad) || nuevaCantidad < 0) {
      res.status(400).json({ success: false, error: 'Cantidad inválida' });
      return;
    }
    if (productoIdParam !== null && (!Number.isInteger(productoIdParam) || productoIdParam <= 0)) {
      res.status(400).json({ success: false, error: 'Identificador de producto inválido' });
      return;
    }

    const result = runInTransaction(() => {
      const prod = productoIdParam
        ? (db.prepare('SELECT * FROM productos WHERE id = ?').get(productoIdParam) as Record<string, unknown> | undefined)
        : (db.prepare('SELECT * FROM productos WHERE sku = ?').get(sku) as Record<string, unknown> | undefined);

      if (!prod) {
        throw new Error('Producto no encontrado en SQLite');
      }

      const prodId = Number(prod.id);
      const stockPrevio = Number(prod.stock_actual);
      const diff = Math.abs(nuevaCantidad - stockPrevio);
      const tipoMov = tipoAjuste === 'merma' ? 'BAJA_MERMA' : 'AJUSTE_ARQUEO';

      db.prepare('UPDATE productos SET stock_actual = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nuevaCantidad, prodId);

      const folio = `AJU-${Date.now().toString().slice(-6)}`;
      const costoUnit = Number(prod.costo_pmp ?? 0);
      const h = hashSha256(`${tipoMov}|${folio}|${prodId}|${stockPrevio}|${nuevaCantidad}|${motivo}`);
      db.prepare(`
        INSERT INTO kardex_movimientos (
          producto_id, tipo_movimiento, referencia_folio, cantidad,
          stock_previo, stock_resultante, costo_unitario, costo_total, usuario_id, hash_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(prodId, tipoMov, folio, diff, stockPrevio, nuevaCantidad, costoUnit, diff * costoUnit, h);

      return {
        folio,
        producto_id: prodId,
        sku: String(prod.sku),
        stock_previo: stockPrevio,
        stock_actual: nuevaCantidad,
      };
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// API ENDPOINTS: SUPPLIERS & SETTLEMENTS (SQLite)
// ---------------------------------------------------------------------------

app.get('/api/proveedores', (_req: Request, res: Response) => {
  const proveedores = db.prepare(`
    SELECT
      pr.*,
      COALESCE((
        SELECT SUM(cp.monto_liquidado_cup)
        FROM comprobantes_pago_proveedor cp
        WHERE cp.proveedor_id = pr.id
      ), 0.0) AS total_pagado_historico,
      COALESCE((
        SELECT SUM(vd.cantidad)
        FROM venta_detalles vd
        WHERE vd.proveedor_id = pr.id
      ), 0.0) AS unidades_vendidas,
      COALESCE((
        SELECT COUNT(*)
        FROM productos p
        WHERE p.proveedor_id = pr.id AND p.activo = 1
      ), 0) AS productos_vinculados
    FROM proveedores pr
    WHERE pr.activo = 1
    ORDER BY pr.saldo_pendiente_efectivo DESC, pr.nombre_comercial ASC
  `).all();

  const comprobantes = db.prepare(`
    SELECT cp.*, pr.nombre_comercial AS proveedor_nombre
    FROM comprobantes_pago_proveedor cp
    JOIN proveedores pr ON cp.proveedor_id = pr.id
    ORDER BY cp.id DESC
    LIMIT 20
  `).all();

  res.status(200).json({ proveedores, comprobantes });
});

app.post('/api/proveedores', (req: Request, res: Response) => {
  try {
    const nombre = String(req.body?.nombre_comercial ?? '').trim();
    const razonSocial = String(req.body?.razon_social ?? '').trim() || nombre;
    const telefono = String(req.body?.telefono ?? '').trim();
    const tipo = String(req.body?.tipo_proveedor ?? 'Consignación / Venta Devengada').trim();
    const identificacion = String(req.body?.identificacion_fiscal ?? '').trim();
    const contacto = String(req.body?.contacto_nombre ?? '').trim();
    const direccion = String(req.body?.direccion ?? '').trim();
    const rawProductIds: number[] = Array.isArray(req.body?.producto_ids)
      ? Array.from(
          new Set(
            (req.body.producto_ids as unknown[])
              .map((id) => Number(id))
              .filter((id) => Number.isInteger(id) && id > 0)
          )
        )
      : [];

    if (!nombre) {
      res.status(400).json({ success: false, error: 'El nombre comercial es obligatorio' });
      return;
    }

    const result = runInTransaction(() => {
      const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM proveedores').get() as { max_id: number };
      const codigoRef = `PROV-${String((maxRow?.max_id ?? 0) + 1).padStart(3, '0')}`;

      const info = db.prepare(`
        INSERT INTO proveedores (
          codigo_ref, nombre_comercial, razon_social, identificacion_fiscal,
          contacto_nombre, telefono, direccion, tipo_proveedor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(codigoRef, nombre, razonSocial, identificacion, contacto, telefono, direccion, tipo);

      const newProvId = Number(info.lastInsertRowid);
      let linkedCount = 0;
      if (rawProductIds.length > 0) {
        const linkStmt = db.prepare(
          'UPDATE productos SET proveedor_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND activo = 1'
        );
        for (const prodId of rawProductIds) {
          const upd = linkStmt.run(newProvId, prodId);
          linkedCount += Number(upd.changes || 0);
        }
      }

      const proveedor = db.prepare(`
        SELECT pr.*,
          COALESCE((SELECT COUNT(*) FROM productos p WHERE p.proveedor_id = pr.id AND p.activo = 1), 0) AS productos_vinculados
        FROM proveedores pr WHERE pr.id = ?
      `).get(newProvId);

      return { proveedor, linkedCount };
    });

    res.status(201).json({ success: true, proveedor: result.proveedor, linked_count: result.linkedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/proveedores/:id/productos', (req: Request, res: Response) => {
  try {
    const supplierId = Number(req.params.id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      res.status(400).json({ success: false, error: 'Identificador de proveedor inválido' });
      return;
    }

    const modeRaw = String(req.body?.mode ?? 'assign').trim().toLowerCase();
    const mode = modeRaw === 'unlink' || modeRaw === 'replace' ? modeRaw : 'assign';
    const rawIds = Array.isArray(req.body?.producto_ids) ? (req.body.producto_ids as unknown[]) : [];
    const productIds: number[] = Array.from(
      new Set(rawIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))
    );

    if (mode !== 'replace' && productIds.length === 0) {
      res.status(400).json({ success: false, error: 'Selecciona al menos un artículo del inventario válido' });
      return;
    }

    const result = runInTransaction(() => {
      const prov = db.prepare('SELECT id, nombre_comercial FROM proveedores WHERE id = ? AND activo = 1').get(supplierId) as
        | { id: number; nombre_comercial: string }
        | undefined;
      if (!prov) {
        throw new Error('Proveedor no encontrado o inactivo');
      }

      let updatedCount = 0;
      if (mode === 'unlink') {
        const stmt = db.prepare(
          'UPDATE productos SET proveedor_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND proveedor_id = ? AND activo = 1'
        );
        for (const pid of productIds) {
          const info = stmt.run(pid, supplierId);
          updatedCount += Number(info.changes || 0);
        }
      } else {
        if (mode === 'replace') {
          db.prepare(
            'UPDATE productos SET proveedor_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE proveedor_id = ? AND activo = 1'
          ).run(supplierId);
        }
        const stmt = db.prepare(
          'UPDATE productos SET proveedor_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND activo = 1'
        );
        for (const pid of productIds) {
          const info = stmt.run(supplierId, pid);
          updatedCount += Number(info.changes || 0);
        }
      }

      const linkedProducts = db.prepare(`
        SELECT p.*, c.nombre AS categoria_nombre, pr.nombre_comercial AS proveedor_nombre
        FROM productos p
        JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
        WHERE p.proveedor_id = ? AND p.activo = 1
        ORDER BY p.descripcion ASC
      `).all(supplierId);

      return { updatedCount, linkedProducts };
    });

    res.status(200).json({
      success: true,
      proveedor_id: supplierId,
      mode,
      updated_count: result.updatedCount,
      productos: result.linkedProducts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no encontrado') ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
  }
});

app.post('/api/proveedores/pago', (req: Request, res: Response) => {
  try {
    const proveedor_id = Number(req.body?.proveedor_id);
    const monto = parseMoney(req.body?.monto_liquidado_cup ?? 0, 'El monto a liquidar');
    const canal = String(req.body?.canal_pago ?? 'EFECTIVO_GAVETA').trim().toUpperCase();
    const receptor = String(req.body?.receptor_nombre ?? 'Representante Proveedor').trim() || 'Representante Proveedor';
    const receptorCi = String(req.body?.receptor_ci ?? '00000000000').trim() || '00000000000';
    const glosa = String(req.body?.documento_fuente_ref ?? 'Liquidación directa de pasivo').trim();
    const refBancaria = req.body?.referencia_bancaria ? String(req.body.referencia_bancaria) : null;
    const folioSolicitado = String(req.body?.folio_comprobante ?? '').trim();

    if (!Number.isInteger(proveedor_id) || proveedor_id <= 0) {
      throw new ApiError(400, 'Proveedor inválido');
    }
    if (monto <= 0) {
      throw new ApiError(400, 'El monto a liquidar debe ser mayor a 0 CUP.');
    }
    if (!SUPPLIER_PAYMENT_CHANNELS.has(canal)) {
      throw new ApiError(400, `Canal de pago no soportado: "${canal}".`);
    }

    const result = runInTransaction(() => {
      const prov = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(proveedor_id) as
        | Record<string, unknown>
        | undefined;
      if (!prov) {
        throw new ApiError(404, 'Proveedor no encontrado');
      }

      const saldoEfectivo = roundMoney(Number(prov.saldo_pendiente_efectivo ?? 0));
      const saldoTransferencia = roundMoney(Number(prov.saldo_pendiente_transferencia ?? 0));
      const saldoTotal = roundMoney(saldoEfectivo + saldoTransferencia);

      if (monto > saldoTotal + 0.009) {
        throw new ApiError(
          400,
          `El pago ($${monto.toFixed(2)} CUP) supera el saldo pendiente del proveedor ($${saldoTotal.toFixed(2)} CUP).`
        );
      }

      // El pago se imputa primero al canal elegido y el excedente al otro saldo.
      let restante = monto;
      let nuevoEfectivo = saldoEfectivo;
      let nuevoTransferencia = saldoTransferencia;
      const orden: Array<'efectivo' | 'transferencia'> =
        canal === 'TRANSFERENCIA_BANCARIA' ? ['transferencia', 'efectivo'] : ['efectivo', 'transferencia'];
      for (const destino of orden) {
        if (restante <= 0) break;
        const saldoDestino = destino === 'efectivo' ? nuevoEfectivo : nuevoTransferencia;
        const aplicado = Math.min(saldoDestino, restante);
        if (destino === 'efectivo') nuevoEfectivo = roundMoney(saldoDestino - aplicado);
        else nuevoTransferencia = roundMoney(saldoDestino - aplicado);
        restante = roundMoney(restante - aplicado);
      }

      let folio: string;
      if (folioSolicitado) {
        const dup = db.prepare('SELECT id FROM comprobantes_pago_proveedor WHERE folio_comprobante = ?').get(folioSolicitado);
        if (dup) {
          throw new ApiError(
            409,
            `Ya existe un comprobante con el folio "${folioSolicitado}". Déjalo vacío para generar uno nuevo.`
          );
        }
        folio = folioSolicitado;
      } else {
        folio = nextFolio('REC', FOLIO_TABLES.comprobantes, String(new Date().getFullYear()));
      }

      const h = hashSha256(`${folio}|${proveedor_id}|${monto}|${canal}|${receptor}`);

      db.prepare(`
        INSERT INTO comprobantes_pago_proveedor (
          folio_comprobante, proveedor_id, usuario_emisor_id, monto_liquidado_cup,
          canal_pago, referencia_bancaria, receptor_nombre, receptor_ci, documento_fuente_ref, hash_sha256
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(folio, proveedor_id, monto, canal, refBancaria, receptor, receptorCi, glosa, h);

      db.prepare(`
        UPDATE proveedores
        SET saldo_pendiente_efectivo = ?, saldo_pendiente_transferencia = ?
        WHERE id = ?
      `).run(nuevoEfectivo, nuevoTransferencia, proveedor_id);

      const updatedProv = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(proveedor_id);
      return {
        folio_comprobante: folio,
        hash_sha256: h,
        monto_liquidado_cup: monto,
        saldo_pendiente_efectivo: nuevoEfectivo,
        saldo_pendiente_transferencia: nuevoTransferencia,
        proveedor: updatedProv,
      };
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    respondError(res, err);
  }
});

// ---------------------------------------------------------------------------
// API ENDPOINTS: SALES / POS & SHIFTS (SQLite)
// ---------------------------------------------------------------------------

app.get('/api/ventas', (_req: Request, res: Response) => {
  const ventas = db.prepare(`
    SELECT v.*, COUNT(vd.id) AS total_items
    FROM ventas v
    LEFT JOIN venta_detalles vd ON vd.venta_id = v.id
    GROUP BY v.id
    ORDER BY v.id DESC
    LIMIT 50
  `).all();
  res.status(200).json({ ventas });
});

app.post('/api/ventas', (req: Request, res: Response) => {
  try {
    const turno_id = Number(req.body?.turno_id ?? 1);
    const usuario_id = Number(req.body?.usuario_id ?? 1);
    const clienteRaw = req.body?.cliente_id;
    const cliente_id =
      clienteRaw === null || clienteRaw === undefined || clienteRaw === '' ? null : Number(clienteRaw);
    const metodo_pago = String(req.body?.metodo_pago ?? 'EFECTIVO').trim().toUpperCase();
    const lineas = Array.isArray(req.body?.items) ? req.body.items : [];
    const descuentoSolicitado = parseMoney(req.body?.descuento ?? 0, 'El descuento');
    const pagoRaw = req.body?.pago_recibido;
    const pagoDeclarado =
      pagoRaw === null || pagoRaw === undefined || pagoRaw === '' ? null : parseMoney(pagoRaw, 'El pago recibido');

    if (lineas.length === 0) {
      throw new ApiError(400, 'El ticket no contiene artículos');
    }
    if (!Number.isInteger(turno_id) || turno_id <= 0) {
      throw new ApiError(400, 'Turno de caja inválido');
    }
    if (!Number.isInteger(usuario_id) || usuario_id <= 0) {
      throw new ApiError(400, 'Usuario inválido');
    }
    if (!PAYMENT_METHODS.has(metodo_pago)) {
      throw new ApiError(400, `Método de pago no soportado: "${metodo_pago}".`);
    }
    if (descuentoSolicitado < 0) {
      throw new ApiError(400, 'El descuento no puede ser negativo.');
    }
    if (pagoDeclarado !== null && pagoDeclarado < 0) {
      throw new ApiError(400, 'El pago recibido no puede ser negativo.');
    }
    if (cliente_id !== null && (!Number.isInteger(cliente_id) || cliente_id <= 0)) {
      throw new ApiError(400, 'Cliente inválido');
    }

    const result = runInTransaction(() => {
      requireOpenTurno(turno_id);
      requireActiveUser(usuario_id, 'usuario');

      if (cliente_id !== null) {
        const clienteRow = db.prepare('SELECT id FROM clientes WHERE id = ?').get(cliente_id);
        if (!clienteRow) {
          throw new ApiError(400, 'El cliente seleccionado no existe.');
        }
      }

      // Primera pasada: precios y existencias se validan contra SQLite, nunca
      // contra los importes que envía el navegador.
      const lineasValidadas: Array<{
        producto_id: number;
        cantidad: number;
        precio_unitario: number;
        costo_unitario: number;
        descripcion: string;
        sku: string;
        proveedor_id: number | null;
        stock_previo: number;
      }> = [];
      const cantidadesPorProducto = new Map<number, number>();
      let subtotal = 0;

      for (const item of lineas) {
        const prod_id = Number(item?.producto_id);
        const cant = Number(item?.cantidad);

        if (!Number.isInteger(prod_id) || prod_id <= 0) {
          throw new ApiError(400, 'El ticket contiene un artículo inválido.');
        }
        if (!Number.isFinite(cant) || cant <= 0) {
          throw new ApiError(400, `Cantidad inválida para el artículo #${prod_id}.`);
        }

        const pRow = db
          .prepare(
            'SELECT sku, descripcion, proveedor_id, stock_actual, costo_pmp, costo_ultimo, precio_venta_cup FROM productos WHERE id = ? AND activo = 1'
          )
          .get(prod_id) as
          | {
              sku: string;
              descripcion: string;
              proveedor_id: number | null;
              stock_actual: number;
              costo_pmp: number;
              costo_ultimo: number;
              precio_venta_cup: number;
            }
          | undefined;

        if (!pRow) {
          throw new ApiError(400, `El producto #${prod_id} no existe o está inactivo.`);
        }

        const precioDb = roundMoney(Number(pRow.precio_venta_cup));
        if (item?.precio_unitario !== undefined && item?.precio_unitario !== null) {
          const precioEnviado = Number(item.precio_unitario);
          if (!Number.isFinite(precioEnviado) || Math.abs(roundMoney(precioEnviado) - precioDb) > 0.009) {
            throw new ApiError(
              409,
              `El precio de "${pRow.descripcion}" cambió a $${precioDb.toFixed(2)} CUP. Sincroniza el catálogo y vuelve a cobrar.`
            );
          }
        }

        const solicitado = (cantidadesPorProducto.get(prod_id) ?? 0) + cant;
        cantidadesPorProducto.set(prod_id, solicitado);
        const stockDisponible = Number(pRow.stock_actual);
        if (solicitado > stockDisponible) {
          throw new ApiError(
            400,
            `Stock insuficiente para "${pRow.descripcion}": disponible ${stockDisponible} u., solicitado ${solicitado} u.`
          );
        }

        const costoUnit =
          Number(pRow.costo_pmp) > 0
            ? roundMoney(Number(pRow.costo_pmp))
            : roundMoney(Number(pRow.costo_ultimo ?? 0));

        lineasValidadas.push({
          producto_id: prod_id,
          cantidad: cant,
          precio_unitario: precioDb,
          costo_unitario: costoUnit,
          descripcion: pRow.descripcion,
          sku: pRow.sku,
          proveedor_id: pRow.proveedor_id ? Number(pRow.proveedor_id) : null,
          stock_previo: stockDisponible,
        });
        subtotal += precioDb * cant;
      }

      subtotal = roundMoney(subtotal);
      if (descuentoSolicitado > subtotal) {
        throw new ApiError(
          400,
          `El descuento ($${descuentoSolicitado.toFixed(2)} CUP) no puede superar el subtotal ($${subtotal.toFixed(2)} CUP).`
        );
      }

      const descuento = descuentoSolicitado;
      const total_neto = roundMoney(subtotal - descuento);
      if (total_neto <= 0) {
        throw new ApiError(400, 'El total del ticket debe ser mayor a 0 CUP.');
      }

      const pago_recibido = pagoDeclarado === null ? total_neto : pagoDeclarado;
      if (pago_recibido + 0.009 < total_neto) {
        throw new ApiError(
          400,
          `Pago insuficiente: recibido $${pago_recibido.toFixed(2)} CUP de un total de $${total_neto.toFixed(2)} CUP.`
        );
      }
      const vuelto = roundMoney(pago_recibido - total_neto);

      const now = new Date();
      const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
      const suffix = `${String(now.getTime()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
      const folio_ticket = `TKV-${ymd}-${suffix}`;

      const ventaInfo = db.prepare(`
        INSERT INTO ventas (
          folio_ticket, turno_id, usuario_id, cliente_id, metodo_pago,
          subtotal_cup, descuento_cup, total_neto_cup, pago_recibido_cup, vuelto_entregado_cup
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `).run(folio_ticket, turno_id, usuario_id, cliente_id, metodo_pago, subtotal, descuento, total_neto, pago_recibido, vuelto);

      const venta_id = Number(ventaInfo.lastInsertRowid);
      const stockChanges: Array<{ producto_id: number; sku: string; descripcion: string; stock_previo: number; stock_actual: number }> = [];

      for (const linea of lineasValidadas) {
        const sub_linea = roundMoney(linea.cantidad * linea.precio_unitario);
        const deuda_prov =
          linea.proveedor_id !== null ? roundMoney(linea.cantidad * linea.costo_unitario) : 0.0;

        db.prepare(`
          INSERT INTO venta_detalles (
            venta_id, producto_id, proveedor_id, cantidad, costo_unitario_historico,
            precio_unitario_cobrado, subtotal, deuda_generada_proveedor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `).run(
          venta_id,
          linea.producto_id,
          linea.proveedor_id,
          linea.cantidad,
          linea.costo_unitario,
          linea.precio_unitario,
          sub_linea,
          deuda_prov
        );

        const stockRow = db.prepare('SELECT stock_actual FROM productos WHERE id = ?').get(linea.producto_id) as
          | { stock_actual: number }
          | undefined;
        const stockPrevio = Number(stockRow?.stock_actual ?? linea.stock_previo);
        const nuevoStock = Math.max(0, roundMoney(stockPrevio - linea.cantidad));
        db.prepare('UPDATE productos SET stock_actual = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          nuevoStock,
          linea.producto_id
        );

        const kHash = hashSha256(`SALIDA_VENTA|${folio_ticket}|${linea.producto_id}|${linea.cantidad}`);
        db.prepare(`
          INSERT INTO kardex_movimientos (
            producto_id, tipo_movimiento, referencia_folio, cantidad,
            stock_previo, stock_resultante, costo_unitario, costo_total, usuario_id, hash_sha256
          ) VALUES (?, 'SALIDA_VENTA', ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(
          linea.producto_id,
          folio_ticket,
          linea.cantidad,
          stockPrevio,
          nuevoStock,
          linea.costo_unitario,
          roundMoney(linea.cantidad * linea.costo_unitario),
          usuario_id,
          kHash
        );

        if (linea.proveedor_id !== null && deuda_prov > 0) {
          db.prepare('UPDATE proveedores SET saldo_pendiente_efectivo = saldo_pendiente_efectivo + ? WHERE id = ?').run(
            deuda_prov,
            linea.proveedor_id
          );
        }

        stockChanges.push({
          producto_id: linea.producto_id,
          sku: linea.sku,
          descripcion: linea.descripcion,
          stock_previo: stockPrevio,
          stock_actual: nuevoStock,
        });
      }

      if (metodo_pago === 'EFECTIVO') {
        db.prepare('UPDATE turnos_caja SET total_ventas_efectivo_cup = total_ventas_efectivo_cup + ? WHERE id = ?').run(
          total_neto,
          turno_id
        );
      } else {
        db.prepare(
          'UPDATE turnos_caja SET total_ventas_transferencia_cup = total_ventas_transferencia_cup + ? WHERE id = ?'
        ).run(total_neto, turno_id);
      }

      return { folio_ticket, subtotal, descuento, total_neto, pago_recibido, vuelto, stockChanges };
    });

    res.status(201).json({
      success: true,
      folio_ticket: result.folio_ticket,
      subtotal: result.subtotal,
      descuento: result.descuento,
      total_neto: result.total_neto,
      pago_recibido: result.pago_recibido,
      vuelto: result.vuelto,
      updated_stocks: result.stockChanges,
    });
  } catch (err) {
    respondError(res, err);
  }
});

app.get('/api/turnos/activo', (_req: Request, res: Response) => {
  const turno = db.prepare(`
    SELECT t.*
    FROM turnos_caja t
    WHERE t.estado = 'ABIERTA'
    ORDER BY t.id DESC
    LIMIT 1
  `).get() as { id: number } | undefined;

  // Estadísticas del turno abierto (no del histórico completo).
  const stats = turno
    ? (db.prepare(`
        SELECT
          COUNT(*) AS tickets_hoy,
          COALESCE(SUM(total_neto_cup), 0.0) AS total_hoy
        FROM ventas
        WHERE estado = 'COMPLETADA' AND turno_id = ?
      `).get(turno.id) as { tickets_hoy: number; total_hoy: number })
    : { tickets_hoy: 0, total_hoy: 0 };

  if (turno) {
    res.status(200).json({ turno, stats });
  } else {
    res.status(200).json({ turno: null, stats, mensaje: 'No hay gaveta abierta actualmente' });
  }
});

// ---------------------------------------------------------------------------
// API ENDPOINTS: EFECTIVO EN GAVETA COMO FONDO (reposición, retiro, ajuste)
// ---------------------------------------------------------------------------

function getOpenTurno(): TurnoCajaRow | undefined {
  return db
    .prepare("SELECT * FROM turnos_caja WHERE estado = 'ABIERTA' ORDER BY id DESC LIMIT 1")
    .get() as TurnoCajaRow | undefined;
}

function gavetaResumen(turno: TurnoCajaRow) {
  const fondoInicial = roundMoney(Number(turno.fondo_inicial_cup ?? 0));
  const reposiciones = roundMoney(Number(turno.total_reposiciones_cup ?? 0));
  const ventasEfectivo = roundMoney(Number(turno.total_ventas_efectivo_cup ?? 0));
  const sangrias = roundMoney(Number(turno.total_sangrias_cup ?? 0));
  const egresosCajaChica = roundMoney(Number(turno.total_egresos_caja_chica_cup ?? 0));
  const efectivoActual = roundMoney(
    fondoInicial + reposiciones + ventasEfectivo - sangrias - egresosCajaChica
  );

  return {
    fondo_inicial_cup: fondoInicial,
    total_reposiciones_cup: reposiciones,
    total_ventas_efectivo_cup: ventasEfectivo,
    total_sangrias_cup: sangrias,
    total_egresos_caja_chica_cup: egresosCajaChica,
    efectivo_actual_cup: efectivoActual,
  };
}

function gavetaPayload(turno: TurnoCajaRow) {
  const movimientos = db
    .prepare('SELECT * FROM caja_gaveta_movimientos WHERE turno_id = ? ORDER BY id DESC LIMIT 50')
    .all(turno.id);
  return { turno, resumen: gavetaResumen(turno), movimientos };
}

app.get('/api/gaveta', (_req: Request, res: Response) => {
  try {
    const turno = getOpenTurno();
    if (!turno) {
      throw new ApiError(409, 'No hay una gaveta abierta. Abre un turno para gestionar el efectivo.');
    }
    res.status(200).json({ success: true, ...gavetaPayload(turno) });
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/gaveta/movimientos', (req: Request, res: Response) => {
  try {
    const tipoRaw = String(req.body?.tipo ?? '').trim().toUpperCase();
    const tipo = tipoRaw === 'REPOSICION' || tipoRaw === 'RETIRO' || tipoRaw === 'AJUSTE' ? tipoRaw : null;
    if (!tipo) {
      throw new ApiError(400, 'Tipo de movimiento inválido. Usa REPOSICION, RETIRO o AJUSTE.');
    }

    const monto = parseMoney(req.body?.monto_cup, 'El monto');
    const concepto = String(req.body?.concepto ?? '').trim();

    if (tipo !== 'AJUSTE' && monto <= 0) {
      throw new ApiError(400, 'El monto debe ser mayor a 0 CUP.');
    }
    if (tipo === 'AJUSTE' && monto < 0) {
      throw new ApiError(400, 'El fondo inicial no puede ser negativo.');
    }
    if (!concepto) {
      throw new ApiError(400, 'Describe el motivo del movimiento.');
    }

    const result = runInTransaction(() => {
      const turno = getOpenTurno();
      if (!turno) {
        throw new ApiError(409, 'No hay una gaveta abierta. Abre un turno para gestionar el efectivo.');
      }

      const resumen = gavetaResumen(turno);
      let efecto = 0;
      let fondoInicial = Number(turno.fondo_inicial_cup ?? 0);
      let reposiciones = Number(turno.total_reposiciones_cup ?? 0);
      let sangrias = Number(turno.total_sangrias_cup ?? 0);

      if (tipo === 'REPOSICION') {
        reposiciones = roundMoney(reposiciones + monto);
        efecto = monto;
      } else if (tipo === 'RETIRO') {
        if (monto > resumen.efectivo_actual_cup + 0.001) {
          throw new ApiError(
            400,
            `No puedes retirar más de lo que hay en gaveta ($${resumen.efectivo_actual_cup.toFixed(2)} CUP).`
          );
        }
        sangrias = roundMoney(sangrias + monto);
        efecto = -monto;
      } else {
        const nuevoEfectivo = roundMoney(
          monto + resumen.total_reposiciones_cup + resumen.total_ventas_efectivo_cup -
            resumen.total_sangrias_cup - resumen.total_egresos_caja_chica_cup
        );
        if (nuevoEfectivo < 0) {
          const fondoMinimo = roundMoney(
            Math.max(
              0,
              resumen.total_sangrias_cup +
                resumen.total_egresos_caja_chica_cup -
                resumen.total_reposiciones_cup -
                resumen.total_ventas_efectivo_cup
            )
          );
          throw new ApiError(
            400,
            `Ese fondo inicial dejaría la gaveta en negativo ($${nuevoEfectivo.toFixed(2)} CUP). ` +
              `El mínimo permitido es $${fondoMinimo.toFixed(2)} CUP.`
          );
        }
        efecto = roundMoney(monto - fondoInicial);
        fondoInicial = monto;
      }

      db.prepare(`
        UPDATE turnos_caja
        SET fondo_inicial_cup = ?,
            total_reposiciones_cup = ?,
            total_sangrias_cup = ?
        WHERE id = ?
      `).run(roundMoney(fondoInicial), roundMoney(reposiciones), roundMoney(sangrias), turno.id);

      const updated = getTurno(Number(turno.id))!;
      const saldoResultante = gavetaResumen(updated).efectivo_actual_cup;
      const h = hashSha256(`${turno.id}|${tipo}|${monto.toFixed(2)}|${saldoResultante.toFixed(2)}|${concepto}`);

      db.prepare(`
        INSERT INTO caja_gaveta_movimientos (
          turno_id, tipo, monto_cup, efecto_cup, saldo_resultante_cup, concepto, usuario_id, hash_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(turno.id, tipo, monto, efecto, saldoResultante, concepto, h);

      return gavetaPayload(updated);
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    respondError(res, err);
  }
});

app.get('/api/dashboard/kpis', (_req: Request, res: Response) => {
  const ventasHoy = db.prepare(`
    SELECT COUNT(*) AS cantidad, COALESCE(SUM(total_neto_cup), 0.0) AS total_ventas
    FROM ventas
    WHERE estado = 'COMPLETADA'
  `).get() as { cantidad: number; total_ventas: number };

  const costosHoy = db.prepare(`
    SELECT COALESCE(SUM(vd.cantidad * vd.costo_unitario_historico), 0.0) AS costo_total
    FROM venta_detalles vd
    JOIN ventas v ON vd.venta_id = v.id
    WHERE v.estado = 'COMPLETADA'
  `).get() as { costo_total: number };

  const provDeuda = db.prepare(`
    SELECT COALESCE(SUM(saldo_pendiente_efectivo), 0.0) AS deuda_prov
    FROM proveedores
    WHERE activo = 1
  `).get() as { deuda_prov: number };

  const bajoStock = db.prepare(`
    SELECT COUNT(*) AS bajo_stock
    FROM productos
    WHERE stock_actual <= stock_minimo AND activo = 1
  `).get() as { bajo_stock: number };

  const canales = db.prepare(`
    SELECT metodo_pago, COALESCE(SUM(total_neto_cup), 0.0) AS total
    FROM ventas
    WHERE estado = 'COMPLETADA'
    GROUP BY metodo_pago
  `).all();

  const topProductos = db.prepare(`
    SELECT
      p.sku,
      p.descripcion,
      p.stock_actual,
      c.nombre AS categoria_nombre,
      SUM(vd.cantidad) AS unidades,
      SUM(vd.subtotal) AS ingresos,
      SUM(vd.cantidad * vd.costo_unitario_historico) AS costo_total
    FROM venta_detalles vd
    JOIN ventas v ON vd.venta_id = v.id
    JOIN productos p ON vd.producto_id = p.id
    JOIN categorias c ON p.categoria_id = c.id
    WHERE v.estado = 'COMPLETADA'
    GROUP BY p.id
    ORDER BY unidades DESC
    LIMIT 5
  `).all();

  res.status(200).json({
    ventas_hoy_monto: ventasHoy.total_ventas,
    ventas_hoy_cantidad: ventasHoy.cantidad,
    ganancia_neta_calculada: Math.max(0, ventasHoy.total_ventas - costosHoy.costo_total),
    costo_deducido: costosHoy.costo_total,
    deuda_proveedores_efectivo: provDeuda.deuda_prov,
    productos_alerta_stock: bajoStock.bajo_stock,
    canales,
    top_productos: topProductos,
  });
});

function formatLocalYmd(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseSqliteTimestamp(raw: string): Date {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return new Date();
  if (trimmed.includes('T') || trimmed.endsWith('Z')) {
    return new Date(trimmed);
  }
  return new Date(`${trimmed.replace(' ', 'T')}Z`);
}

app.get('/api/dashboard/weekly-sales', (_req: Request, res: Response) => {
  const now = new Date();
  const todayStr = formatLocalYmd(now);
  const mondayOffset = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);

  const dayMeta = [
    { short: 'Lun', full: 'Lunes' },
    { short: 'Mar', full: 'Martes' },
    { short: 'Mié', full: 'Miércoles' },
    { short: 'Jue', full: 'Jueves' },
    { short: 'Vie', full: 'Viernes' },
    { short: 'Sáb', full: 'Sábado' },
    { short: 'Dom', full: 'Domingo' },
  ];

  const days = dayMeta.map((meta, idx) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + idx);
    const ymd = formatLocalYmd(d);
    return {
      date: ymd,
      day_short: meta.short,
      day_full: meta.full,
      total_ventas: 0,
      costo_total: 0,
      ganancia_neta: 0,
      tickets: 0,
      efectivo_cup: 0,
      digital_cup: 0,
      is_today: ymd === todayStr,
    };
  });

  const dayMap = new Map(days.map((d) => [d.date, d]));

  const rows = db.prepare(`
    SELECT
      v.id,
      v.created_at,
      v.metodo_pago,
      v.total_neto_cup,
      COALESCE(
        (SELECT SUM(vd.cantidad * vd.costo_unitario_historico) FROM venta_detalles vd WHERE vd.venta_id = v.id),
        0.0
      ) AS costo_total
    FROM ventas v
    WHERE v.estado = 'COMPLETADA'
      AND v.created_at >= datetime('now', '-10 days')
  `).all() as Array<{
    id: number;
    created_at: string;
    metodo_pago: string;
    total_neto_cup: number;
    costo_total: number;
  }>;

  for (const row of rows) {
    const localDate = formatLocalYmd(parseSqliteTimestamp(row.created_at));
    const bucket = dayMap.get(localDate);
    if (!bucket) continue;

    const venta = Number(row.total_neto_cup || 0);
    const costo = Number(row.costo_total || 0);
    bucket.total_ventas = Number((bucket.total_ventas + venta).toFixed(2));
    bucket.costo_total = Number((bucket.costo_total + costo).toFixed(2));
    bucket.ganancia_neta = Math.max(0, Number((bucket.total_ventas - bucket.costo_total).toFixed(2)));
    bucket.tickets += 1;

    if (String(row.metodo_pago || '').toUpperCase() === 'EFECTIVO') {
      bucket.efectivo_cup = Number((bucket.efectivo_cup + venta).toFixed(2));
    } else {
      bucket.digital_cup = Number((bucket.digital_cup + venta).toFixed(2));
    }
  }

  const totalSemana = Number(days.reduce((acc, d) => acc + d.total_ventas, 0).toFixed(2));
  const costoSemana = Number(days.reduce((acc, d) => acc + d.costo_total, 0).toFixed(2));
  const gananciaSemana = Math.max(0, Number((totalSemana - costoSemana).toFixed(2)));
  const ticketsSemana = days.reduce((acc, d) => acc + d.tickets, 0);

  let bestDay: (typeof days)[number] | null = null;
  for (const d of days) {
    if (d.total_ventas > 0 && (!bestDay || d.total_ventas > bestDay.total_ventas)) {
      bestDay = d;
    }
  }

  res.status(200).json({
    week_start: days[0].date,
    week_end: days[6].date,
    today: todayStr,
    days,
    summary: {
      total_semana: totalSemana,
      costo_semana: costoSemana,
      ganancia_semana: gananciaSemana,
      tickets_semana: ticketsSemana,
      promedio_diario: Number((totalSemana / 7).toFixed(2)),
      mejor_dia: bestDay ? bestDay.day_full : null,
      mejor_dia_monto: bestDay ? bestDay.total_ventas : 0,
    },
  });
});

// ---------------------------------------------------------------------------
// API ENDPOINTS: PETTY CASH, CLIENTS, SANGRIAS, LIQUIDACIONES, BACKUP (SQLite)
// ---------------------------------------------------------------------------

interface CajaChicaValeRow {
  id: number;
  folio_vale: string;
  turno_id: number | null;
  autorizado_por: number;
  fondo_id: number | null;
  beneficiario_nombre: string;
  beneficiario_ci: string;
  rubro: string;
  monto_desembolsado_cup: number;
  concepto_justificacion: string;
  compromiso_factura_24h: number;
  factura_entregada: number;
  estado_ciclo: string;
  hash_sha256: string;
  created_at: string;
}

interface CajaChicaArqueoRow {
  id: number;
  folio_arqueo: string;
  fondo_id: number | null;
  fondo_fijo_cup: number;
  total_vales_cup: number;
  saldo_esperado_cup: number;
  efectivo_contado_cup: number;
  diferencia_cup: number;
  estado: string;
  desglose_billetes_json: string | null;
  responsable_nombre: string;
  observaciones: string | null;
  vales_incluidos: number;
  reintegro_aplicado: number;
  hash_sha256: string;
  created_at: string;
}

interface CajaChicaFondoRow {
  id: number;
  nombre: string;
  monto_asignado_cup: number;
  tope_vale_cup: number;
  activo: number;
  created_at: string;
  updated_at: string;
}

interface CajaChicaFondoResumen extends CajaChicaFondoRow {
  total_desembolsado: number;
  saldo_disponible: number;
  vales_activos_count: number;
}

function listFondosResumen(): CajaChicaFondoResumen[] {
  const rows = db
    .prepare(`
      SELECT
        f.*,
        COALESCE(SUM(
          CASE WHEN COALESCE(v.estado_ciclo, 'ACTIVO') = 'ACTIVO' THEN v.monto_desembolsado_cup ELSE 0 END
        ), 0.0) AS total_desembolsado,
        COALESCE(SUM(
          CASE WHEN COALESCE(v.estado_ciclo, 'ACTIVO') = 'ACTIVO' THEN 1 ELSE 0 END
        ), 0) AS vales_activos_count
      FROM caja_chica_fondos f
      LEFT JOIN caja_chica_vales v ON v.fondo_id = f.id
      WHERE f.activo = 1
      GROUP BY f.id
      ORDER BY f.id ASC
    `)
    .all() as unknown as Array<CajaChicaFondoRow & { total_desembolsado: number; vales_activos_count: number }>;

  return rows.map((row) => {
    const monto = roundMoney(Number(row.monto_asignado_cup ?? 0));
    const desembolsado = roundMoney(Number(row.total_desembolsado ?? 0));
    return {
      ...row,
      monto_asignado_cup: monto,
      tope_vale_cup: roundMoney(Number(row.tope_vale_cup ?? 0)),
      total_desembolsado: desembolsado,
      saldo_disponible: roundMoney(Math.max(0, monto - desembolsado)),
      vales_activos_count: Number(row.vales_activos_count ?? 0),
    };
  });
}

function resolveFondo(fondoIdRaw: unknown): CajaChicaFondoRow {
  const fondos = db
    .prepare('SELECT * FROM caja_chica_fondos WHERE activo = 1 ORDER BY id ASC')
    .all() as unknown as CajaChicaFondoRow[];
  if (fondos.length === 0) {
    throw new ApiError(400, 'No hay fondos de caja chica activos. Crea uno en Configuración.');
  }
  if (fondoIdRaw === undefined || fondoIdRaw === null || fondoIdRaw === '') {
    return fondos[0];
  }
  const fondoId = Number(fondoIdRaw);
  if (!Number.isInteger(fondoId) || fondoId <= 0) {
    throw new ApiError(400, 'Fondo de caja chica inválido.');
  }
  const found = fondos.find((f) => Number(f.id) === fondoId);
  if (!found) {
    throw new ApiError(404, 'El fondo de caja chica no existe o está inactivo.');
  }
  return found;
}

function getCajaChicaSnapshot(fondoId?: number) {
  const config = db
    .prepare('SELECT tope_vale_caja_chica FROM configuracion_negocio WHERE id = 1')
    .get() as { tope_vale_caja_chica: number } | undefined;
  const topeFallback = roundMoney(Number(config?.tope_vale_caja_chica ?? 5000.0));

  const fondos = listFondosResumen();
  const selected =
    (fondoId !== undefined ? fondos.find((f) => Number(f.id) === Number(fondoId)) : undefined) ?? fondos[0] ?? null;

  if (!selected) {
    return {
      fondo_fijo: 0,
      tope_vale: topeFallback,
      total_desembolsado: 0,
      saldo_disponible: 0,
      porcentaje_disponible: 0,
      vales_activos_count: 0,
      pendientes_factura_count: 0,
      vales_hoy: 0,
      total_hoy: 0,
      desglose_rubros: [] as Array<{ rubro: string; total: number; porcentaje: number }>,
      vales: [] as CajaChicaValeRow[],
      arqueos: [] as CajaChicaArqueoRow[],
      ultimo_arqueo: null,
      fondos,
      fondo_actual_id: null,
      fondo_actual_nombre: null,
    };
  }

  const fondo_fijo = roundMoney(Number(selected.monto_asignado_cup ?? 0));
  const tope_vale = roundMoney(Number(selected.tope_vale_cup ?? 0)) || topeFallback;

  const vales = db
    .prepare('SELECT * FROM caja_chica_vales WHERE fondo_id = ? ORDER BY id DESC LIMIT 100')
    .all(selected.id) as unknown as CajaChicaValeRow[];

  const activeVales = vales.filter((v) => (v.estado_ciclo || 'ACTIVO') === 'ACTIVO');
  const total_desembolsado = roundMoney(
    activeVales.reduce((sum, v) => sum + Number(v.monto_desembolsado_cup || 0), 0)
  );
  const saldo_disponible = roundMoney(Math.max(0.0, fondo_fijo - total_desembolsado));
  const porcentaje_disponible =
    fondo_fijo > 0 ? Number(((saldo_disponible / fondo_fijo) * 100).toFixed(1)) : 0;

  const rubroTotals = new Map<string, number>();
  let pendientes_factura_count = 0;
  for (const v of activeVales) {
    const monto = Number(v.monto_desembolsado_cup || 0);
    rubroTotals.set(v.rubro, (rubroTotals.get(v.rubro) ?? 0) + monto);
    if (Number(v.compromiso_factura_24h) === 1 && Number(v.factura_entregada) === 0) {
      pendientes_factura_count += 1;
    }
  }

  const desglose_rubros = Array.from(rubroTotals.entries())
    .map(([rubro, total]) => ({
      rubro,
      total: Number(total.toFixed(2)),
      porcentaje:
        total_desembolsado > 0 ? Number(((total / total_desembolsado) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const arqueos = db
    .prepare('SELECT * FROM caja_chica_arqueos WHERE fondo_id = ? ORDER BY id DESC LIMIT 20')
    .all(selected.id) as unknown as CajaChicaArqueoRow[];

  const todayRow = db
    .prepare(`
      SELECT
        COUNT(*) AS vales_hoy,
        COALESCE(SUM(monto_desembolsado_cup), 0.0) AS total_hoy
      FROM caja_chica_vales
      WHERE fondo_id = ?
        AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
        AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'
    `)
    .get(selected.id) as { vales_hoy: number; total_hoy: number };

  return {
    fondo_fijo,
    tope_vale,
    total_desembolsado,
    saldo_disponible,
    porcentaje_disponible,
    vales_activos_count: activeVales.length,
    pendientes_factura_count,
    vales_hoy: Number(todayRow?.vales_hoy ?? 0),
    total_hoy: Number(todayRow?.total_hoy ?? 0),
    desglose_rubros,
    vales,
    arqueos,
    ultimo_arqueo: arqueos[0] ?? null,
    fondos,
    fondo_actual_id: selected.id,
    fondo_actual_nombre: selected.nombre,
  };
}

app.get('/api/caja-chica', (req: Request, res: Response) => {
  try {
    const raw = req.query.fondo_id;
    const fondoId = raw === undefined || raw === '' ? undefined : Number(raw);
    if (fondoId !== undefined && (!Number.isInteger(fondoId) || fondoId <= 0)) {
      throw new ApiError(400, 'Fondo de caja chica inválido.');
    }
    res.status(200).json(getCajaChicaSnapshot(fondoId));
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/caja-chica/fondos', (req: Request, res: Response) => {
  try {
    const nombre = String(req.body?.nombre ?? '').trim();
    const monto = parseMoney(req.body?.monto_asignado_cup ?? 0, 'El monto asignado');
    const tope = parseMoney(req.body?.tope_vale_cup ?? 5000, 'El tope por vale');

    if (!nombre) {
      throw new ApiError(400, 'El nombre del fondo es obligatorio.');
    }
    if (monto < 0) {
      throw new ApiError(400, 'El monto asignado no puede ser negativo.');
    }
    if (tope < 0) {
      throw new ApiError(400, 'El tope por vale no puede ser negativo.');
    }

    const dup = db
      .prepare('SELECT id FROM caja_chica_fondos WHERE LOWER(nombre) = LOWER(?)')
      .get(nombre);
    if (dup) {
      throw new ApiError(409, `Ya existe un fondo llamado "${nombre}".`);
    }

    const info = db
      .prepare(`
        INSERT INTO caja_chica_fondos (nombre, monto_asignado_cup, tope_vale_cup)
        VALUES (?, ?, ?)
      `)
      .run(nombre, monto, tope);

    res.status(201).json({
      success: true,
      fondo_id: Number(info.lastInsertRowid),
      ...getCajaChicaSnapshot(Number(info.lastInsertRowid)),
    });
  } catch (err) {
    respondError(res, err);
  }
});

app.put('/api/caja-chica/fondos/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError(400, 'Fondo de caja chica inválido.');
    }

    const current = db.prepare('SELECT * FROM caja_chica_fondos WHERE id = ?').get(id) as
      | CajaChicaFondoRow
      | undefined;
    if (!current) {
      throw new ApiError(404, 'El fondo de caja chica no existe.');
    }

    const nombre =
      req.body?.nombre === undefined ? current.nombre : String(req.body.nombre ?? '').trim();
    const monto =
      req.body?.monto_asignado_cup === undefined
        ? Number(current.monto_asignado_cup)
        : parseMoney(req.body.monto_asignado_cup, 'El monto asignado');
    const tope =
      req.body?.tope_vale_cup === undefined
        ? Number(current.tope_vale_cup)
        : parseMoney(req.body.tope_vale_cup, 'El tope por vale');
    const activo =
      req.body?.activo === undefined ? Number(current.activo) : req.body.activo === true ? 1 : 0;

    if (!nombre) {
      throw new ApiError(400, 'El nombre del fondo es obligatorio.');
    }
    if (monto < 0 || tope < 0) {
      throw new ApiError(400, 'El monto asignado y el tope por vale no pueden ser negativos.');
    }

    const dup = db
      .prepare('SELECT id FROM caja_chica_fondos WHERE LOWER(nombre) = LOWER(?) AND id <> ?')
      .get(nombre, id);
    if (dup) {
      throw new ApiError(409, `Ya existe otro fondo llamado "${nombre}".`);
    }

    if (monto < Number(current.monto_asignado_cup ?? 0)) {
      const activeSum = db
        .prepare(`
          SELECT COALESCE(SUM(monto_desembolsado_cup), 0.0) AS total
          FROM caja_chica_vales
          WHERE fondo_id = ? AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'
        `)
        .get(id) as { total: number };
      const activoTotal = roundMoney(Number(activeSum?.total ?? 0));
      if (roundMoney(monto) < activoTotal) {
        throw new ApiError(
          400,
          `No puedes reducir el monto por debajo de los vales activos ($${activoTotal.toFixed(2)} CUP).`
        );
      }
    }

    if (activo === 0) {
      const activeVales = db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM caja_chica_vales WHERE fondo_id = ? AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'"
        )
        .get(id) as { cnt: number };
      if (Number(activeVales?.cnt ?? 0) > 0) {
        throw new ApiError(400, 'No puedes desactivar un fondo con vales activos.');
      }
      const activos = db
        .prepare('SELECT COUNT(*) AS cnt FROM caja_chica_fondos WHERE activo = 1')
        .get() as { cnt: number };
      if (Number(activos?.cnt ?? 0) <= 1) {
        throw new ApiError(400, 'Debe quedar al menos un fondo de caja chica activo.');
      }
    }

    db.prepare(`
      UPDATE caja_chica_fondos
      SET nombre = ?, monto_asignado_cup = ?, tope_vale_cup = ?, activo = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nombre, monto, tope, activo, id);

    res.status(200).json({ success: true, ...getCajaChicaSnapshot(id) });
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/caja-chica/vales', (req: Request, res: Response) => {
  try {
    const benef = String(req.body?.beneficiario_nombre ?? '').trim();
    const ci = String(req.body?.beneficiario_ci ?? '').trim();
    const rubro = String(req.body?.rubro ?? 'Insumos y Embalaje').trim() || 'Insumos y Embalaje';
    const monto = parseMoney(req.body?.monto_desembolsado_cup ?? 0, 'El monto a desembolsar');
    const concepto = String(req.body?.concepto_justificacion ?? '').trim();
    const compromisoFactura = req.body?.compromiso_factura_24h === false ? 0 : 1;
    const facturaEntregada = req.body?.factura_entregada === true ? 1 : 0;
    const avalAdmin = req.body?.aval_admin === true;

    if (!benef) {
      throw new ApiError(400, 'El nombre del beneficiario es obligatorio.');
    }
    if (!ci) {
      throw new ApiError(400, 'El carnet de identidad del beneficiario es obligatorio.');
    }
    if (!concepto) {
      throw new ApiError(400, 'El concepto y justificación del gasto son obligatorios.');
    }
    if (monto <= 0) {
      throw new ApiError(400, 'El monto a desembolsar debe ser mayor a 0 CUP.');
    }

    const result = runInTransaction(() => {
      const fondo = resolveFondo(req.body?.fondo_id);
      const topeVale = roundMoney(Number(fondo.tope_vale_cup ?? 0));

      if (topeVale > 0 && monto > topeVale && !avalAdmin) {
        throw new ApiError(
          400,
          `El importe ($${monto.toFixed(2)} CUP) supera el tope operativo de $${topeVale.toFixed(2)} CUP. Marca el aval de administrador para autorizarlo.`
        );
      }

      const activeSumRow = db
        .prepare(`
          SELECT COALESCE(SUM(monto_desembolsado_cup), 0.0) AS total
          FROM caja_chica_vales
          WHERE fondo_id = ? AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'
        `)
        .get(fondo.id) as { total: number };
      const saldoActual = roundMoney(
        Math.max(0, Number(fondo.monto_asignado_cup ?? 0) - Number(activeSumRow?.total ?? 0))
      );

      if (monto > saldoActual + 0.001) {
        throw new ApiError(
          400,
          `Saldo insuficiente en "${fondo.nombre}". Disponible: $${saldoActual.toFixed(2)} CUP.`
        );
      }

      const openTurno = db
        .prepare("SELECT id FROM turnos_caja WHERE estado = 'ABIERTA' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;

      const seqRow = db
        .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next_seq FROM caja_chica_vales')
        .get() as { next_seq: number };
      const nextNum = Number(seqRow?.next_seq ?? 1) + 36;
      const folio = `VAL-CC-${new Date().getFullYear()}-${String(nextNum).padStart(3, '0')}`;
      const h = hashSha256(`${folio}|${benef}|${monto.toFixed(2)}|${concepto}`);

      const info = db
        .prepare(`
          INSERT INTO caja_chica_vales (
            folio_vale, turno_id, autorizado_por, fondo_id, beneficiario_nombre, beneficiario_ci,
            rubro, monto_desembolsado_cup, concepto_justificacion,
            compromiso_factura_24h, factura_entregada, estado_ciclo, hash_sha256
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)
        `)
        .run(
          folio,
          openTurno?.id ?? null,
          fondo.id,
          benef,
          ci,
          rubro,
          monto,
          concepto,
          compromisoFactura,
          facturaEntregada,
          h
        );

      if (openTurno?.id) {
        db.prepare(
          'UPDATE turnos_caja SET total_egresos_caja_chica_cup = COALESCE(total_egresos_caja_chica_cup, 0) + ? WHERE id = ?'
        ).run(monto, openTurno.id);
      }

      const vale = db
        .prepare('SELECT * FROM caja_chica_vales WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as unknown as CajaChicaValeRow;

      return {
        folio_vale: folio,
        hash_sha256: h,
        vale,
        fondo_id: fondo.id,
        saldo_disponible: roundMoney(Math.max(0, saldoActual - monto)),
      };
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    respondError(res, err);
  }
});

app.put('/api/caja-chica/vales/:id/factura', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError(400, 'Identificador de vale inválido.');
    }

    const current = db
      .prepare('SELECT * FROM caja_chica_vales WHERE id = ?')
      .get(id) as CajaChicaValeRow | undefined;
    if (!current) {
      throw new ApiError(404, 'Vale de caja chica no encontrado.');
    }

    const nextValue =
      typeof req.body?.factura_entregada === 'boolean'
        ? req.body.factura_entregada
          ? 1
          : 0
        : Number(current.factura_entregada) === 1
          ? 0
          : 1;

    db.prepare('UPDATE caja_chica_vales SET factura_entregada = ? WHERE id = ?').run(nextValue, id);
    const updated = db
      .prepare('SELECT * FROM caja_chica_vales WHERE id = ?')
      .get(id) as unknown as CajaChicaValeRow;

    res.status(200).json({ success: true, vale: updated });
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/caja-chica/arqueo', (req: Request, res: Response) => {
  try {
    const efectivoContado = parseMoney(req.body?.efectivo_contado_cup, 'El efectivo contado');
    const responsable = String(req.body?.responsable_nombre ?? 'Caja Central').trim() || 'Caja Central';
    const observaciones = String(req.body?.observaciones ?? '').trim() || null;
    const desgloseBilletes = req.body?.desglose_billetes ?? null;
    const cerrarComoReembolso = req.body?.cerrar_como_reembolso === true;

    if (efectivoContado < 0) {
      throw new ApiError(400, 'El efectivo físico contado debe ser un número mayor o igual a 0 CUP.');
    }

    const arqueo = runInTransaction(() => {
      const fondo = resolveFondo(req.body?.fondo_id);
      const fondoFijo = roundMoney(Number(fondo.monto_asignado_cup ?? 0));

      const activeStats = db
        .prepare(`
          SELECT
            COUNT(*) AS cnt,
            COALESCE(SUM(monto_desembolsado_cup), 0.0) AS total
          FROM caja_chica_vales
          WHERE fondo_id = ? AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'
        `)
        .get(fondo.id) as { cnt: number; total: number };

      const totalVales = roundMoney(Number(activeStats?.total ?? 0));
      const valesIncluidos = Number(activeStats?.cnt ?? 0);
      const saldoEsperado = roundMoney(Math.max(0, fondoFijo - totalVales));
      const contadoRounded = roundMoney(efectivoContado);
      const diferencia = roundMoney(contadoRounded - saldoEsperado);

      let estado = 'CUADRADO';
      if (diferencia > 0.009) estado = 'SOBRANTE';
      else if (diferencia < -0.009) estado = 'FALTANTE';

      const seqRow = db
        .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next_seq FROM caja_chica_arqueos')
        .get() as { next_seq: number };
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const folio = `ARQ-CC-${ymd}-${String(seqRow?.next_seq ?? 1).padStart(3, '0')}`;
      const desgloseJson = desgloseBilletes ? JSON.stringify(desgloseBilletes) : null;
      const reintegroAplicado = cerrarComoReembolso && valesIncluidos > 0 ? 1 : 0;
      const h = hashSha256(
        `${folio}|${fondo.id}|${fondoFijo.toFixed(2)}|${totalVales.toFixed(2)}|${contadoRounded.toFixed(2)}|${diferencia.toFixed(2)}`
      );

      const info = db
        .prepare(`
          INSERT INTO caja_chica_arqueos (
            folio_arqueo, fondo_id, fondo_fijo_cup, total_vales_cup, saldo_esperado_cup,
            efectivo_contado_cup, diferencia_cup, estado, desglose_billetes_json,
            responsable_nombre, observaciones, vales_incluidos, reintegro_aplicado, hash_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          folio,
          fondo.id,
          fondoFijo,
          totalVales,
          saldoEsperado,
          contadoRounded,
          diferencia,
          estado,
          desgloseJson,
          responsable,
          observaciones,
          valesIncluidos,
          reintegroAplicado,
          h
        );

      if (reintegroAplicado === 1) {
        db.prepare(`
          UPDATE caja_chica_vales
          SET estado_ciclo = 'REINTEGRADO'
          WHERE fondo_id = ? AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'
        `).run(fondo.id);
      }

      return db
        .prepare('SELECT * FROM caja_chica_arqueos WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as unknown as CajaChicaArqueoRow;
    });

    res.status(201).json({ success: true, arqueo, ...getCajaChicaSnapshot(arqueo.fondo_id ?? undefined) });
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/caja-chica/reponer', (req: Request, res: Response) => {
  try {
    const fondo = resolveFondo(req.body?.fondo_id);
    const settledCount = runInTransaction(() => {
      const info = db
        .prepare(`
          UPDATE caja_chica_vales
          SET estado_ciclo = 'REINTEGRADO'
          WHERE fondo_id = ? AND COALESCE(estado_ciclo, 'ACTIVO') = 'ACTIVO'
        `)
        .run(fondo.id);
      return Number(info.changes ?? 0);
    });

    res.status(200).json({
      success: true,
      reintegrados: settledCount,
      ...getCajaChicaSnapshot(fondo.id),
    });
  } catch (err) {
    respondError(res, err);
  }
});

app.get('/api/caja-chica/export/csv', (req: Request, res: Response) => {
  const rawFondo = req.query.fondo_id;
  const fondoId = rawFondo === undefined || rawFondo === '' ? null : Number(rawFondo);
  const vales = (
    fondoId !== null && Number.isInteger(fondoId) && fondoId > 0
      ? db.prepare('SELECT * FROM caja_chica_vales WHERE fondo_id = ? ORDER BY id DESC').all(fondoId)
      : db.prepare('SELECT * FROM caja_chica_vales ORDER BY id DESC').all()
  ) as unknown as CajaChicaValeRow[];

  const escapeCsv = (val: string | number | null | undefined): string => {
    const text = String(val ?? '');
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const headers = [
    'Folio Vale',
    'Fecha',
    'Rubro',
    'Concepto',
    'Beneficiario',
    'Carnet Identidad',
    'Factura Entregada',
    'Estado Ciclo',
    'Monto CUP',
  ];

  const lines = [
    headers.map(escapeCsv).join(','),
    ...vales.map((v) =>
      [
        v.folio_vale,
        v.created_at,
        v.rubro,
        v.concepto_justificacion,
        v.beneficiario_nombre,
        v.beneficiario_ci,
        Number(v.factura_entregada) === 1 ? 'SI' : 'PENDIENTE',
        v.estado_ciclo || 'ACTIVO',
        Number(v.monto_desembolsado_cup || 0).toFixed(2),
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];

  const csvBody = `\uFEFF${lines.join('\r\n')}`;
  const today = new Date().toISOString().slice(0, 10);
  const filename = `libro_caja_chica_${today}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(csvBody);
});

app.get('/api/liquidaciones', (_req: Request, res: Response) => {
  const liquidaciones = db.prepare('SELECT * FROM liquidaciones_semanales ORDER BY id DESC LIMIT 10').all();
  res.status(200).json({ liquidaciones });
});

app.post('/api/liquidaciones/guardar', (req: Request, res: Response) => {
  try {
    const semana = String(req.body?.semana_periodo ?? 'SEMANA').trim() || 'SEMANA';
    const efectivo_real = parseMoney(req.body?.efectivo_real_caja ?? 0.0, 'El efectivo real de caja');
    const a_pagar_prov = parseMoney(req.body?.a_pagar_efectivo_proveedores ?? 0.0, 'El pago a proveedores');
    const diferencia = parseMoney(req.body?.diferencia_semana ?? 0.0, 'La diferencia de la semana');
    const ganancia = parseMoney(req.body?.ganancia_semana ?? 0.0, 'La ganancia de la semana');

    if (efectivo_real < 0 || a_pagar_prov < 0) {
      throw new ApiError(400, 'El efectivo real y el pago a proveedores no pueden ser negativos.');
    }

    const resto = roundMoney(efectivo_real - a_pagar_prov - diferencia);
    if (resto < 0) {
      throw new ApiError(
        400,
        `El cuadre no cierra: los pagos y la diferencia ($${(a_pagar_prov + diferencia).toFixed(2)} CUP) superan el efectivo real ($${efectivo_real.toFixed(2)} CUP).`
      );
    }
    const resto_mas_ganancias = roundMoney(resto + ganancia);
    const por_socio = roundMoney(resto_mas_ganancias / 2.0);

    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    const folio = `LIQ-SEM-${now.getFullYear()}-${String(weekNum).padStart(2, '0')}`;

    const existente = db.prepare('SELECT id FROM liquidaciones_semanales WHERE folio_liquidacion = ?').get(folio);
    if (existente) {
      throw new ApiError(409, `Ya existe una liquidación guardada para esta semana (${folio}).`);
    }

    db.prepare(`
      INSERT INTO liquidaciones_semanales (
        folio_liquidacion, semana_periodo, fecha_cierre, efectivo_real_caja,
        a_pagar_efectivo_proveedores, diferencia_semana, ganancia_semana,
        resto_operativo, resto_mas_ganancias, total_efectivo_entre_dos, liquidado_por
      ) VALUES (?, ?, CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(folio, semana, efectivo_real, a_pagar_prov, diferencia, ganancia, resto, resto_mas_ganancias, por_socio);

    res.status(201).json({
      success: true,
      folio_liquidacion: folio,
      resto_operativo: resto,
      total_entre_dos: por_socio,
    });
  } catch (err) {
    respondError(res, err);
  }
});

app.get('/api/respaldos', (_req: Request, res: Response) => {
  try {
    res.status(200).json({ success: true, respaldos: listSqliteBackups() });
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/respaldos/crear', async (_req: Request, res: Response) => {
  try {
    const result = await createSqliteBackup();
    res.status(201).json({
      success: true,
      archivo: result.destFile.replace(/^backups[\\/]/, ''),
      ruta: result.destFile,
      hash_sha256: result.hashSha256,
      respaldos: listSqliteBackups(),
      mensaje: 'Respaldo creado correctamente.',
    });
  } catch (err) {
    respondError(res, err);
  }
});

app.post('/api/respaldos/restaurar', (req: Request, res: Response) => {
  try {
    const archivo = String(req.body?.archivo ?? '').trim();
    if (!archivo) {
      throw new ApiError(400, 'Selecciona el respaldo que deseas restaurar.');
    }
    const result = restoreSqliteBackup(archivo);
    res.status(200).json({
      success: true,
      ...result,
      mensaje: 'Respaldo restaurado. Recarga la aplicación para ver los datos.',
    });
  } catch (err) {
    respondError(res, err);
  }
});

// ---------------------------------------------------------------------------
// STATIC ASSETS & HTML VIEW ROUTING
// ---------------------------------------------------------------------------

app.use('/assets', express.static(path.join(ROOT_DIR, 'assets')));
app.use('/css', express.static(path.join(ROOT_DIR, 'css')));

const PAGE_ALIASES: Record<string, string> = {
  '': 'dashboard.html',
  'index': 'dashboard.html',
  'index.html': 'dashboard.html',
  'login': 'dashboard.html',
  'dashboard': 'dashboard.html',
  'pos': 'pos.html',
  'tpv': 'pos.html',
  'ventas': 'pos.html',
  'ventas-tpv': 'pos.html',
  'inventario': 'inventario.html',
  'inventario-y-kardex': 'inventario.html',
  'caja-chica': 'caja_chica.html',
  'caja-chica-y-gastos': 'caja_chica.html',
  'caja-chica-y-gastos-operativos-menores': 'caja_chica.html',
  'proveedores': 'proveedores.html',
  'proveedores-compras': 'proveedores.html',
  'catalogo-y-cuentas-por-pagar': 'proveedores.html',
  'catalogo-de-proveedores-y-cuentas-por-pagar': 'proveedores.html',
  'proveedores-y-obligaciones-de-pago': 'proveedores.html',
  'cuadre': 'cuadre_semanal.html',
  'cuadre-semanal': 'cuadre_semanal.html',
  'cuadre-semanal-y-liquidacion-de-ganancias': 'cuadre_semanal.html',
  'configuracion': 'configuracion.html',
  'mantenimiento': 'configuracion.html',
  'respaldo-y-mantenimiento-sqlite': 'configuracion.html',
  'respaldos': 'configuracion.html',
};

const NAV_BRIDGE_SCRIPT = `
<script>
(function() {
  window.alert = function(msg) {
    var existing = document.getElementById('gt-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'gt-toast';
    toast.className = 'fixed bottom-6 right-6 z-[9999] bg-[#182034] text-white px-4 py-3 rounded-xl shadow-xl font-label-md text-sm flex items-center gap-2 max-w-md border border-white/10';
    toast.innerHTML = '<span class="material-symbols-outlined text-[18px] text-[#7DA4FF]">info</span><span></span>';
    toast.querySelector('span:last-child').textContent = String(msg);
    document.body.appendChild(toast);
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 3500);
  };

  var routeMap = {
    'dashboard': '/dashboard',
    'inventario': '/inventario',
    'inventario-y-kardex': '/inventario',
    'ventas': '/pos',
    'ventas-tpv': '/pos',
    'proveedores': '/proveedores',
    'proveedores-compras': '/proveedores',
    'catalogo-y-cuentas-por-pagar': '/proveedores',
    'catalogo-de-proveedores-y-cuentas-por-pagar': '/proveedores',
    'proveedores-y-obligaciones-de-pago': '/proveedores',
    'caja-chica': '/caja-chica',
    'caja-chica-y-gastos': '/caja-chica',
    'caja-chica-y-gastos-operativos-menores': '/caja-chica',
    'cuadre': '/cuadre',
    'cuadre-semanal-y-liquidacion-de-ganancias': '/cuadre',
    'configuracion': '/configuracion',
    'mantenimiento': '/configuracion',
    'respaldo-y-mantenimiento-sqlite': '/configuracion'
  };

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('a[data-path]').forEach(function(link) {
      var dp = link.getAttribute('data-path');
      if (dp && routeMap[dp]) {
        link.setAttribute('href', routeMap[dp]);
      }
    });
  });
})();
</script>
<div id="gt-stock-alert-monitor-root"></div>
<script type="module" src="/assets/stock-alert-monitor-app.js"></script>
`;

app.use((req: Request, res: Response, next) => {
  if (req.method !== 'GET') {
    next();
    return;
  }
  const cleanPath = req.path.replace(/^\/+|\/+$/g, '');
  let targetFile = PAGE_ALIASES[cleanPath] ?? cleanPath;

  if (!targetFile.endsWith('.html')) {
    const htmlCandidate = `${targetFile}.html`;
    if (fs.existsSync(path.join(ROOT_DIR, htmlCandidate))) {
      targetFile = htmlCandidate;
    }
  }

  const fullPath = path.join(ROOT_DIR, targetFile);
  if (!fullPath.startsWith(ROOT_DIR) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.status(404).send('<h1>404 - Archivo no encontrado en Gestor Tienda</h1><p><a href="/">Volver al inicio</a></p>');
    return;
  }

  if (targetFile.endsWith('.html')) {
    let html = fs.readFileSync(fullPath, 'utf8');
    // Offline hardening: strip any remote resource (Google Fonts, CDNs) so the
    // app never requires an internet connection; local fallbacks are injected.
    html = html.replace(/<link\b[^>]*\bhref=["']https?:\/\/[^"']+["'][^>]*>\s*/gi, '');
    html = html.replace(/<script\b[^>]*\bsrc=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>\s*/gi, '');
    if (!html.includes('/css/tailwind.min.css')) {
      html = html.replace('</head>', '  <link rel="stylesheet" href="/css/tailwind.min.css"/>\n</head>');
    }
    if (!html.includes('/css/material-icons.css')) {
      html = html.replace('</head>', '  <link rel="stylesheet" href="/css/material-icons.css"/>\n</head>');
    }
    html = html.replace(/src=["']https?:\/\/lh3\.googleusercontent\.com\/[^"']+["']/gi, 'src="/assets/logo-placeholder.svg"');
    if (!html.includes('<title>')) {
      html = html.replace('<head>', '<head><title>Gestor Tienda</title>');
    }
    html = html.replace('</body>', `${NAV_BRIDGE_SCRIPT}</body>`);
    res.status(200).type('html').send(html);
    return;
  }

  res.sendFile(fullPath);
});

export interface StartServerOptions {
  port?: number;
  host?: string;
  allowPortFallback?: boolean;
}

export interface StartedServer {
  port: number;
  host: string;
  close: () => Promise<void>;
}

function listenOn(port: number, host: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address() as AddressInfo | null;
      const boundPort = address?.port ?? port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              closeDatabase();
              resolveClose();
            });
          }),
      });
    });
    server.once('error', (err) => {
      reject(err);
    });
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  await ensureDevClientBundles();
  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? DEFAULT_PORT;

  try {
    const started = await listenOn(requestedPort, host);
    console.log(`Gestor Tienda SQLite server running on http://${host}:${started.port}`);
    return { ...started, host };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (options.allowPortFallback && code === 'EADDRINUSE' && requestedPort !== 0) {
      const started = await listenOn(0, host);
      console.log(`Gestor Tienda SQLite server running on http://${host}:${started.port}`);
      return { ...started, host };
    }
    throw err;
  }
}

if (process.env.GESTOR_TIENDA_EMBEDDED !== '1') {
  startServer({ port: DEFAULT_PORT, host: '0.0.0.0' }).catch((err) => {
    console.error('Error iniciando servidor Gestor Tienda:', err);
    process.exit(1);
  });
}
