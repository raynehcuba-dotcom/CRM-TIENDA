import express, { type Request, type Response } from 'express';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, hashSha256, runInTransaction, createSqliteBackup } from './src/db.js';
import { buildInventoryCsv, getInventoryCsvFilename, type InventoryCsvRow } from './src/utils/csvExport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname.endsWith(`${path.sep}dist`) ? path.resolve(__dirname, '..') : __dirname;

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
];
for (const entry of reactEntryPoints) {
  if (fs.existsSync(entry.src)) {
    await esbuild.build({
      entryPoints: [entry.src],
      bundle: true,
      format: 'esm',
      minify: true,
      outfile: entry.out,
    });
  }
}

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(express.json());

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

    if (!descripcion || Number.isNaN(precio_venta_cup) || precio_venta_cup <= 0) {
      res.status(400).json({ success: false, error: 'Descripción y precio de venta mayor a 0 son obligatorios' });
      return;
    }
    if (Number.isNaN(stock_actual) || stock_actual < 0 || Number.isNaN(stock_minimo) || stock_minimo < 0 || Number.isNaN(costo) || costo < 0) {
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

    if (!sku || !descripcion || Number.isNaN(precio_venta_cup) || precio_venta_cup <= 0) {
      res.status(400).json({ success: false, error: 'SKU, nombre y precio de venta mayor a 0 son obligatorios' });
      return;
    }
    if (Number.isNaN(stock_actual) || stock_actual < 0 || Number.isNaN(stock_minimo) || stock_minimo < 0 || Number.isNaN(costo_ultimo) || costo_ultimo < 0) {
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

    if (cantidad <= 0) {
      res.status(400).json({ success: false, error: 'La cantidad debe ser mayor a 0' });
      return;
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
      const costoUnit = costoRaw !== undefined && costoRaw !== '' && !Number.isNaN(Number(costoRaw))
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

    if (nuevaCantidad < 0 || Number.isNaN(nuevaCantidad)) {
      res.status(400).json({ success: false, error: 'Cantidad inválida' });
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

app.get('/api/kardex', (_req: Request, res: Response) => {
  const movimientos = db.prepare(`
    SELECT k.*, p.sku, p.descripcion AS producto_nombre
    FROM kardex_movimientos k
    JOIN productos p ON k.producto_id = p.id
    ORDER BY k.id DESC
    LIMIT 100
  `).all();
  res.status(200).json({ movimientos });
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
    const monto = Number(req.body?.monto_liquidado_cup ?? 0);
    const canal = String(req.body?.canal_pago ?? 'EFECTIVO_GAVETA');
    const receptor = String(req.body?.receptor_nombre ?? 'Representante Proveedor').trim() || 'Representante Proveedor';
    const receptorCi = String(req.body?.receptor_ci ?? '00000000000').trim() || '00000000000';
    const glosa = String(req.body?.documento_fuente_ref ?? 'Liquidación directa de pasivo').trim();
    const refBancaria = req.body?.referencia_bancaria ? String(req.body.referencia_bancaria) : null;
    const folioSolicitado = String(req.body?.folio_comprobante ?? '').trim();

    if (!proveedor_id || monto <= 0) {
      res.status(400).json({ success: false, error: 'Proveedor y monto válidos son obligatorios' });
      return;
    }

    const result = runInTransaction(() => {
      const prov = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(proveedor_id) as Record<string, unknown> | undefined;
      if (!prov) {
        throw new Error('Proveedor no encontrado');
      }

      const folio = folioSolicitado || `REC-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
      const h = hashSha256(`${folio}|${proveedor_id}|${monto}|${canal}|${receptor}`);

      db.prepare(`
        INSERT INTO comprobantes_pago_proveedor (
          folio_comprobante, proveedor_id, usuario_emisor_id, monto_liquidado_cup,
          canal_pago, referencia_bancaria, receptor_nombre, receptor_ci, documento_fuente_ref, hash_sha256
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(folio, proveedor_id, monto, canal, refBancaria, receptor, receptorCi, glosa, h);

      const nuevoSaldoEf = Math.max(0, Number(prov.saldo_pendiente_efectivo) - monto);
      db.prepare('UPDATE proveedores SET saldo_pendiente_efectivo = ? WHERE id = ?').run(nuevoSaldoEf, proveedor_id);

      const updatedProv = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(proveedor_id);
      return { folio_comprobante: folio, hash_sha256: h, proveedor: updatedProv };
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = `${String(now.getTime()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`;
    const folio_ticket = `TKV-${ymd}-${suffix}`;

    const turno_id = Number(req.body?.turno_id ?? 1);
    const usuario_id = Number(req.body?.usuario_id ?? 1);
    const cliente_id = req.body?.cliente_id ? Number(req.body.cliente_id) : null;
    const metodo_pago = String(req.body?.metodo_pago ?? 'EFECTIVO');
    const subtotal = Number(req.body?.subtotal ?? 0.0);
    const descuento = Number(req.body?.descuento ?? 0.0);
    const total_neto = Number(req.body?.total_neto ?? subtotal - descuento);
    const pago_recibido = Number(req.body?.pago_recibido ?? total_neto);
    const vuelto = Math.max(0.0, pago_recibido - total_neto);
    const lineas = Array.isArray(req.body?.items) ? req.body.items : [];

    if (lineas.length === 0) {
      res.status(400).json({ success: false, error: 'El ticket no contiene artículos' });
      return;
    }

    const updatedStocks = runInTransaction(() => {
      const stockChanges: Array<{ producto_id: number; sku: string; descripcion: string; stock_previo: number; stock_actual: number }> = [];

      const ventaInfo = db.prepare(`
        INSERT INTO ventas (
          folio_ticket, turno_id, usuario_id, cliente_id, metodo_pago,
          subtotal_cup, descuento_cup, total_neto_cup, pago_recibido_cup, vuelto_entregado_cup
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `).run(folio_ticket, turno_id, usuario_id, cliente_id, metodo_pago, subtotal, descuento, total_neto, pago_recibido, vuelto);

      const venta_id = Number(ventaInfo.lastInsertRowid);

      for (const item of lineas) {
        const prod_id = Number(item.producto_id);
        const cant = Number(item.cantidad);

        const pRow = db.prepare('SELECT sku, descripcion, proveedor_id, stock_actual, costo_pmp, precio_venta_cup FROM productos WHERE id = ? AND activo = 1').get(prod_id) as
          | { sku: string; descripcion: string; proveedor_id: number | null; stock_actual: number; costo_pmp: number; precio_venta_cup: number }
          | undefined;

        if (!pRow) {
          throw new Error(`Producto #${prod_id} no existe o está inactivo`);
        }
        if (!Number.isFinite(cant) || cant <= 0) {
          throw new Error(`Cantidad inválida para "${pRow.descripcion}"`);
        }
        if (cant > Number(pRow.stock_actual)) {
          throw new Error(`Stock insuficiente para "${pRow.descripcion}": disponible ${pRow.stock_actual} u., solicitado ${cant} u.`);
        }

        const precio_unit = item.precio_unitario !== undefined ? Number(item.precio_unitario) : Number(pRow.precio_venta_cup);
        const costo_unit = item.costo_unitario !== undefined ? Number(item.costo_unitario) : Number(pRow.costo_pmp);
        const sub_linea = cant * precio_unit;
        const prov_id = pRow.proveedor_id;
        const deuda_prov = prov_id ? cant * costo_unit : 0.0;

        db.prepare(`
          INSERT INTO venta_detalles (
            venta_id, producto_id, proveedor_id, cantidad, costo_unitario_historico,
            precio_unitario_cobrado, subtotal, deuda_generada_proveedor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `).run(venta_id, prod_id, prov_id, cant, costo_unit, precio_unit, sub_linea, deuda_prov);

        const stockPrevio = Number(pRow.stock_actual);
        const nuevoStock = Math.max(0, stockPrevio - cant);
        db.prepare('UPDATE productos SET stock_actual = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nuevoStock, prod_id);

        const kHash = hashSha256(`SALIDA_VENTA|${folio_ticket}|${prod_id}|${cant}`);
        db.prepare(`
          INSERT INTO kardex_movimientos (
            producto_id, tipo_movimiento, referencia_folio, cantidad,
            stock_previo, stock_resultante, costo_unitario, costo_total, usuario_id, hash_sha256
          ) VALUES (?, 'SALIDA_VENTA', ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(prod_id, folio_ticket, cant, stockPrevio, nuevoStock, costo_unit, deuda_prov, usuario_id, kHash);

        if (prov_id && deuda_prov > 0) {
          db.prepare('UPDATE proveedores SET saldo_pendiente_efectivo = saldo_pendiente_efectivo + ? WHERE id = ?').run(deuda_prov, prov_id);
        }

        stockChanges.push({
          producto_id: prod_id,
          sku: pRow.sku,
          descripcion: pRow.descripcion,
          stock_previo: stockPrevio,
          stock_actual: nuevoStock,
        });
      }

      if (metodo_pago === 'EFECTIVO') {
        db.prepare('UPDATE turnos_caja SET total_ventas_efectivo_cup = total_ventas_efectivo_cup + ? WHERE id = ?').run(total_neto, turno_id);
      } else {
        db.prepare('UPDATE turnos_caja SET total_ventas_transferencia_cup = total_ventas_transferencia_cup + ? WHERE id = ?').run(total_neto, turno_id);
      }

      return stockChanges;
    });

    res.status(201).json({
      success: true,
      folio_ticket,
      total_neto,
      vuelto,
      updated_stocks: updatedStocks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('Stock insuficiente') || msg.includes('Cantidad inválida') || msg.includes('no existe') ? 400 : 500;
    res.status(status).json({ success: false, error: msg });
  }
});

app.get('/api/turnos/activo', (_req: Request, res: Response) => {
  const turno = db.prepare(`
    SELECT t.*, u.nombre_completo AS cajero_nombre, u.rol
    FROM turnos_caja t
    JOIN usuarios u ON t.cajero_id = u.id
    WHERE t.estado = 'ABIERTA'
    ORDER BY t.id DESC
    LIMIT 1
  `).get();

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS tickets_hoy,
      COALESCE(SUM(total_neto_cup), 0.0) AS total_hoy
    FROM ventas
    WHERE estado = 'COMPLETADA'
  `).get();

  if (turno) {
    res.status(200).json({ turno, stats });
  } else {
    res.status(200).json({ turno: null, stats, mensaje: 'No hay gaveta abierta actualmente' });
  }
});

app.post('/api/turnos/cierre', (req: Request, res: Response) => {
  try {
    const turno_id = Number(req.body?.turno_id);
    const efectivo_declarado = Number(req.body?.efectivo_declarado ?? 0.0);
    const justificacion = String(req.body?.justificacion_descuadre ?? '');

    const result = runInTransaction(() => {
      const turno = db.prepare('SELECT * FROM turnos_caja WHERE id = ?').get(turno_id) as Record<string, number> | undefined;
      if (!turno) {
        throw new Error('Turno no encontrado');
      }

      const teorico =
        turno.fondo_inicial_cup +
        turno.total_ventas_efectivo_cup +
        turno.total_abonos_credito_cup -
        turno.total_sangrias_cup -
        turno.total_egresos_caja_chica_cup;

      const diferencia = efectivo_declarado - teorico;
      const estado = Math.abs(diferencia) < 0.01 ? 'CERRADA_CONFORME' : 'CERRADA_DESCUADRE';
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const folio_z = `Z-${ymd}-${String(turno_id).padStart(4, '0')}`;
      const h_sha = hashSha256(`${folio_z}|${efectivo_declarado}|${teorico}|${diferencia}`);

      db.prepare(`
        UPDATE turnos_caja
        SET folio_cierre = ?, fecha_cierre = CURRENT_TIMESTAMP, estado = ?,
            efectivo_declarado_cup = ?, diferencia_cup = ?, justificacion_descuadre = ?,
            hash_inmutable_sha256 = ?
        WHERE id = ?
      `).run(folio_z, estado, efectivo_declarado, diferencia, justificacion, h_sha, turno_id);

      return {
        folio_cierre: folio_z,
        estado,
        teorico,
        declarado: efectivo_declarado,
        diferencia,
        hash_sha256: h_sha,
      };
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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

app.get('/api/caja-chica', (_req: Request, res: Response) => {
  const config = db.prepare('SELECT fondo_fijo_caja_chica FROM configuracion_negocio WHERE id = 1').get() as { fondo_fijo_caja_chica: number } | undefined;
  const fondo_fijo = config?.fondo_fijo_caja_chica ?? 25000.0;
  const vales = db.prepare('SELECT * FROM caja_chica_vales ORDER BY id DESC LIMIT 50').all() as Array<{ monto_desembolsado_cup: number }>;
  const total_desembolsado = vales.reduce((sum, v) => sum + Number(v.monto_desembolsado_cup), 0);
  const saldo_disponible = Math.max(0.0, fondo_fijo - total_desembolsado);

  res.status(200).json({
    fondo_fijo,
    total_desembolsado,
    saldo_disponible,
    vales,
  });
});

app.post('/api/caja-chica/vales', (req: Request, res: Response) => {
  try {
    const benef = String(req.body?.beneficiario_nombre ?? '');
    const ci = String(req.body?.beneficiario_ci ?? '');
    const rubro = String(req.body?.rubro ?? 'Insumos y Embalaje');
    const monto = Number(req.body?.monto_desembolsado_cup ?? 0.0);
    const concepto = String(req.body?.concepto_justificacion ?? '');
    const folio = `VAL-CC-${new Date().getFullYear()}-${String(Math.floor(Date.now() / 1000) % 1000).padStart(3, '0')}`;
    const h = hashSha256(`${folio}|${benef}|${monto}|${concepto}`);

    db.prepare(`
      INSERT INTO caja_chica_vales (
        folio_vale, turno_id, autorizado_por, beneficiario_nombre, beneficiario_ci,
        rubro, monto_desembolsado_cup, concepto_justificacion, hash_sha256
      ) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?)
    `).run(folio, benef, ci, rubro, monto, concepto, h);

    res.status(201).json({ success: true, folio_vale: folio, hash_sha256: h });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/clientes', (_req: Request, res: Response) => {
  const clientes = db.prepare('SELECT * FROM clientes ORDER BY nombre_completo ASC').all();
  res.status(200).json({ clientes });
});

app.post('/api/clientes/abono', (req: Request, res: Response) => {
  try {
    const cli_id = Number(req.body?.cliente_id);
    const monto = Number(req.body?.monto_abonado_cup ?? 0.0);
    const turno_id = Number(req.body?.turno_id ?? 1);
    const usuario_id = Number(req.body?.usuario_id ?? 1);

    const result = runInTransaction(() => {
      const cRow = db.prepare('SELECT saldo_deudor_actual FROM clientes WHERE id = ?').get(cli_id) as { saldo_deudor_actual: number } | undefined;
      if (!cRow) {
        throw new Error('Cliente no encontrado');
      }

      const saldo_ant = cRow.saldo_deudor_actual;
      const saldo_post = Math.max(0.0, saldo_ant - monto);
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const folio = `ABO-${ym}-${String(Math.floor(Date.now() / 1000) % 10000).padStart(4, '0')}`;

      db.prepare(`
        INSERT INTO credito_abonos (
          folio_recibo, cliente_id, turno_id, usuario_id, monto_abonado_cup,
          metodo_pago, saldo_anterior, saldo_posterior
        ) VALUES (?, ?, ?, ?, ?, 'EFECTIVO', ?, ?)
      `).run(folio, cli_id, turno_id, usuario_id, monto, saldo_ant, saldo_post);

      db.prepare('UPDATE clientes SET saldo_deudor_actual = ? WHERE id = ?').run(saldo_post, cli_id);
      db.prepare('UPDATE turnos_caja SET total_abonos_credito_cup = total_abonos_credito_cup + ? WHERE id = ?').run(monto, turno_id);

      return { folio_recibo: folio, saldo_posterior: saldo_post };
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/sangrias', (req: Request, res: Response) => {
  try {
    const turno_id = Number(req.body?.turno_id ?? 1);
    const cajero_id = Number(req.body?.cajero_id ?? 1);
    const autorizado_por = Number(req.body?.autorizado_por ?? 1);
    const custodio = String(req.body?.custodio_boveda_nombre ?? 'Custodio Bóveda');
    const monto = Number(req.body?.monto_retirado_cup ?? 50000.0);
    const bolsa = String(req.body?.bolsa_seguridad_numero ?? 'B-99812');
    const folio = `SANG-${new Date().getFullYear()}-${String(Math.floor(Date.now() / 1000) % 10000).padStart(4, '0')}`;
    const h = hashSha256(`${folio}|${monto}|${custodio}|${bolsa}`);

    runInTransaction(() => {
      db.prepare(`
        INSERT INTO sangrias_caja (
          folio, turno_id, cajero_id, autorizado_por, custodio_boveda_nombre,
          monto_retirado_cup, bolsa_seguridad_numero, hash_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(folio, turno_id, cajero_id, autorizado_por, custodio, monto, bolsa, h);

      db.prepare('UPDATE turnos_caja SET total_sangrias_cup = total_sangrias_cup + ? WHERE id = ?').run(monto, turno_id);
    });

    res.status(201).json({ success: true, folio, hash_sha256: h });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/liquidaciones', (_req: Request, res: Response) => {
  const liquidaciones = db.prepare('SELECT * FROM liquidaciones_semanales ORDER BY id DESC LIMIT 10').all();
  res.status(200).json({ liquidaciones });
});

app.post('/api/liquidaciones/guardar', (req: Request, res: Response) => {
  try {
    const semana = String(req.body?.semana_periodo ?? 'SEMANA');
    const efectivo_real = Number(req.body?.efectivo_real_caja ?? 0.0);
    const a_pagar_prov = Number(req.body?.a_pagar_efectivo_proveedores ?? 0.0);
    const diferencia = Number(req.body?.diferencia_semana ?? 0.0);
    const ganancia = Number(req.body?.ganancia_semana ?? 0.0);
    const resto = efectivo_real - a_pagar_prov - diferencia;
    const resto_mas_ganancias = resto + ganancia;
    const por_socio = resto_mas_ganancias / 2.0;

    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    const folio = `LIQ-SEM-${now.getFullYear()}-${String(weekNum).padStart(2, '0')}`;

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
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/respaldo/ejecutar', async (_req: Request, res: Response) => {
  try {
    const result = await createSqliteBackup();
    res.status(200).json({
      success: true,
      archivo: result.destFile,
      hash_sha256: result.hashSha256,
      mensaje: 'Checkpoint WAL consolidado y clonación SQLite completada',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
  'cierre': 'cierre_caja.html',
  'cierre-caja': 'cierre_caja.html',
  'caja-chica': 'caja_chica.html',
  'caja-chica-y-gastos': 'caja_chica.html',
  'caja-chica-y-gastos-operativos-menores': 'caja_chica.html',
  'sangria': 'sangria.html',
  'proveedores': 'proveedores.html',
  'proveedores-compras': 'proveedores.html',
  'catalogo-y-cuentas-por-pagar': 'proveedores.html',
  'catalogo-de-proveedores-y-cuentas-por-pagar': 'proveedores.html',
  'proveedores-y-obligaciones-de-pago': 'proveedores.html',
  'cuadre': 'cuadre_semanal.html',
  'cuadre-semanal': 'cuadre_semanal.html',
  'cuadre-semanal-y-liquidacion-de-ganancias': 'cuadre_semanal.html',
  'kardex': 'kardex.html',
  'kardex-y-actas-de-baja-mermas': 'kardex.html',
  'clientes': 'clientes.html',
  'clientes-y-creditos': 'clientes.html',
  'mantenimiento': 'mantenimiento.html',
  'respaldo-y-mantenimiento-sqlite': 'mantenimiento.html',
  'reportes': 'reportes.html',
  'reportes-financieros': 'reportes.html',
  'usuarios': 'usuarios.html',
  'usuarios-roles': 'usuarios.html',
  'usuarios-y-roles': 'usuarios.html',
  'recepcion': 'recepcion.html',
  'recepcion-de-mercancia-entradas': 'recepcion.html',
  'comprobantes': 'comprobantes_pago.html',
  'comprobantes-pago': 'comprobantes_pago.html',
  'historial-de-comprobantes-de-pago': 'comprobantes_pago.html',
};

const NAV_BRIDGE_SCRIPT = `
<script>
(function() {
  window.alert = function(msg) {
    var existing = document.getElementById('gt-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'gt-toast';
    toast.className = 'fixed bottom-6 right-6 z-[9999] bg-inverse-surface text-inverse-on-surface px-4 py-3 rounded-xl shadow-xl font-label-md text-sm flex items-center gap-2 max-w-md';
    toast.innerHTML = '<span class="material-symbols-outlined text-[18px] text-primary-fixed">info</span><span></span>';
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
    'reportes': '/reportes',
    'reportes-financieros': '/reportes',
    'usuarios-roles': '/usuarios',
    'usuarios-y-roles': '/usuarios',
    'clientes-y-creditos': '/clientes',
    'caja-chica-y-gastos': '/caja-chica',
    'caja-chica-y-gastos-operativos-menores': '/caja-chica',
    'cuadre-semanal-y-liquidacion-de-ganancias': '/cuadre',
    'kardex-y-actas-de-baja-mermas': '/kardex',
    'historial-de-comprobantes-de-pago': '/comprobantes',
    'respaldo-y-mantenimiento-sqlite': '/mantenimiento',
    'recepcion-de-mercancia-entradas': '/recepcion'
  };

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('a[data-path]').forEach(function(link) {
      var dp = link.getAttribute('data-path');
      if (dp && routeMap[dp]) {
        link.setAttribute('href', routeMap[dp]);
      }
    });

    var logoutBtn = document.querySelector('button[title="Cerrar sesión"]');
    if (logoutBtn) {
      logoutBtn.style.display = 'none';
    }
  });
})();
</script>
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gestor Tienda SQLite server running on http://0.0.0.0:${PORT}`);
});
