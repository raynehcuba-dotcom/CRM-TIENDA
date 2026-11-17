import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, '..', '..')
  : path.resolve(__dirname, '..');

export const DB_PATH = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : path.join(ROOT_DIR, 'tienda_data.db');

export function hashSha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS configuracion_negocio (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    nombre_tienda TEXT NOT NULL DEFAULT 'Gestor Tienda',
    razon_social TEXT NOT NULL DEFAULT 'Gestor Tienda S.R.L.',
    rut_fiscal TEXT DEFAULT '40019283741',
    direccion TEXT DEFAULT 'Calle Principal #102 e/ Central y Línea',
    telefono TEXT DEFAULT '+53 52000000',
    moneda_principal TEXT NOT NULL DEFAULT 'CUP',
    tasa_cambio_usd_cup REAL NOT NULL DEFAULT 320.00,
    tasa_cambio_mlc_cup REAL NOT NULL DEFAULT 270.00,
    fondo_fijo_caja_chica REAL NOT NULL DEFAULT 25000.00,
    tope_vale_caja_chica REAL NOT NULL DEFAULT 5000.00,
    margen_utilidad_default REAL NOT NULL DEFAULT 25.00,
    dias_alerta_caducidad INTEGER NOT NULL DEFAULT 90,
    version_db TEXT NOT NULL DEFAULT 'v1.0.0',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_completo TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    pin_hash TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('admin', 'cajero', 'almacenero', 'auditor')),
    activo INTEGER NOT NULL DEFAULT 1,
    carnet_identidad TEXT,
    telefono TEXT,
    ultimo_acceso DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS proveedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_ref TEXT NOT NULL UNIQUE,
    nombre_comercial TEXT NOT NULL,
    razon_social TEXT,
    identificacion_fiscal TEXT,
    contacto_nombre TEXT,
    telefono TEXT,
    direccion TEXT,
    tipo_proveedor TEXT DEFAULT 'Consignación / Venta Devengada',
    saldo_pendiente_efectivo REAL NOT NULL DEFAULT 0.00,
    saldo_pendiente_transferencia REAL NOT NULL DEFAULT 0.00,
    activo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    descripcion TEXT,
    icono TEXT DEFAULT 'folder'
  );

  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    codigo_barras TEXT UNIQUE,
    descripcion TEXT NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    proveedor_id INTEGER REFERENCES proveedores(id),
    unidad_medida TEXT NOT NULL DEFAULT 'UNIDAD',
    stock_actual REAL NOT NULL DEFAULT 0.0,
    stock_minimo REAL NOT NULL DEFAULT 10.0,
    costo_ultimo REAL NOT NULL DEFAULT 0.0,
    costo_pmp REAL NOT NULL DEFAULT 0.0,
    precio_venta_cup REAL NOT NULL,
    precio_venta_usd REAL DEFAULT 0.0,
    es_perecedero INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS producto_lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
    codigo_lote TEXT NOT NULL,
    fecha_fabricacion DATE,
    fecha_vencimiento DATE NOT NULL,
    cantidad_inicial REAL NOT NULL,
    cantidad_disponible REAL NOT NULL,
    costo_unitario REAL NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_cliente TEXT NOT NULL UNIQUE,
    nombre_completo TEXT NOT NULL,
    carnet_identidad TEXT UNIQUE,
    telefono TEXT,
    direccion TEXT,
    limite_credito REAL NOT NULL DEFAULT 5000.00,
    saldo_deudor_actual REAL NOT NULL DEFAULT 0.00,
    estado_credito TEXT NOT NULL DEFAULT 'ACTIVO',
    observaciones TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS turnos_caja (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio_cierre TEXT UNIQUE,
    caja_numero TEXT NOT NULL DEFAULT 'Gaveta 01',
    cajero_id INTEGER NOT NULL REFERENCES usuarios(id),
    supervisor_id INTEGER REFERENCES usuarios(id),
    fecha_apertura DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fondo_inicial_cup REAL NOT NULL DEFAULT 0.0,
    fondo_inicial_usd REAL NOT NULL DEFAULT 0.0,
    fondo_inicial_mlc REAL NOT NULL DEFAULT 0.0,
    fecha_cierre DATETIME,
    estado TEXT NOT NULL DEFAULT 'ABIERTA',
    total_ventas_efectivo_cup REAL DEFAULT 0.0,
    total_ventas_transferencia_cup REAL DEFAULT 0.0,
    total_ventas_usd REAL DEFAULT 0.0,
    total_ventas_mlc REAL DEFAULT 0.0,
    total_sangrias_cup REAL DEFAULT 0.0,
    total_abonos_credito_cup REAL DEFAULT 0.0,
    total_egresos_caja_chica_cup REAL DEFAULT 0.0,
    efectivo_declarado_cup REAL DEFAULT 0.0,
    efectivo_declarado_usd REAL DEFAULT 0.0,
    efectivo_declarado_mlc REAL DEFAULT 0.0,
    diferencia_cup REAL DEFAULT 0.0,
    justificacion_descuadre TEXT,
    firma_cajero_token TEXT,
    hash_inmutable_sha256 TEXT
  );

  CREATE TABLE IF NOT EXISTS sangrias_caja (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio TEXT NOT NULL UNIQUE,
    turno_id INTEGER NOT NULL REFERENCES turnos_caja(id),
    cajero_id INTEGER NOT NULL REFERENCES usuarios(id),
    autorizado_por INTEGER NOT NULL REFERENCES usuarios(id),
    custodio_boveda_nombre TEXT NOT NULL,
    monto_retirado_cup REAL NOT NULL,
    motivo TEXT NOT NULL DEFAULT 'Exceso de gaveta / Aseguramiento en caja fuerte',
    bolsa_seguridad_numero TEXT,
    hash_sha256 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio_ticket TEXT NOT NULL UNIQUE,
    turno_id INTEGER NOT NULL REFERENCES turnos_caja(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    cliente_id INTEGER REFERENCES clientes(id),
    tipo_comprobante TEXT NOT NULL DEFAULT 'TICKET_VENTA',
    metodo_pago TEXT NOT NULL,
    subtotal_cup REAL NOT NULL,
    descuento_cup REAL NOT NULL DEFAULT 0.0,
    total_neto_cup REAL NOT NULL,
    pago_recibido_cup REAL DEFAULT 0.0,
    pago_recibido_usd REAL DEFAULT 0.0,
    pago_recibido_mlc REAL DEFAULT 0.0,
    vuelto_entregado_cup REAL DEFAULT 0.0,
    referencia_transferencia TEXT,
    estado TEXT NOT NULL DEFAULT 'COMPLETADA',
    anulada_por INTEGER REFERENCES usuarios(id),
    motivo_anulacion TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS venta_detalles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id INTEGER NOT NULL REFERENCES productos(id),
    lote_id INTEGER REFERENCES producto_lotes(id),
    proveedor_id INTEGER REFERENCES proveedores(id),
    cantidad REAL NOT NULL,
    costo_unitario_historico REAL NOT NULL,
    precio_unitario_cobrado REAL NOT NULL,
    subtotal REAL NOT NULL,
    deuda_generada_proveedor REAL NOT NULL DEFAULT 0.0
  );

  CREATE TABLE IF NOT EXISTS credito_abonos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio_recibo TEXT NOT NULL UNIQUE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    turno_id INTEGER NOT NULL REFERENCES turnos_caja(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    monto_abonado_cup REAL NOT NULL,
    metodo_pago TEXT NOT NULL,
    referencia_bancaria TEXT,
    saldo_anterior REAL NOT NULL,
    saldo_posterior REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comprobantes_pago_proveedor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio_comprobante TEXT NOT NULL UNIQUE,
    proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
    usuario_emisor_id INTEGER NOT NULL REFERENCES usuarios(id),
    monto_liquidado_cup REAL NOT NULL,
    canal_pago TEXT NOT NULL,
    referencia_bancaria TEXT,
    receptor_nombre TEXT NOT NULL,
    receptor_ci TEXT NOT NULL,
    receptor_vehiculo_chapa TEXT,
    receptor_vinculo TEXT,
    documento_fuente_ref TEXT,
    hash_sha256 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS caja_chica_vales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio_vale TEXT NOT NULL UNIQUE,
    turno_id INTEGER REFERENCES turnos_caja(id),
    autorizado_por INTEGER NOT NULL REFERENCES usuarios(id),
    beneficiario_nombre TEXT NOT NULL,
    beneficiario_ci TEXT NOT NULL,
    rubro TEXT NOT NULL,
    monto_desembolsado_cup REAL NOT NULL,
    concepto_justificacion TEXT NOT NULL,
    compromiso_factura_24h INTEGER NOT NULL DEFAULT 1,
    factura_entregada INTEGER NOT NULL DEFAULT 0,
    hash_sha256 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kardex_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL REFERENCES productos(id),
    tipo_movimiento TEXT NOT NULL,
    referencia_folio TEXT NOT NULL,
    lote_id INTEGER REFERENCES producto_lotes(id),
    cantidad REAL NOT NULL,
    stock_previo REAL NOT NULL,
    stock_resultante REAL NOT NULL,
    costo_unitario REAL NOT NULL,
    costo_total REAL NOT NULL,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    hash_sha256 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS liquidaciones_semanales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio_liquidacion TEXT NOT NULL UNIQUE,
    semana_periodo TEXT NOT NULL,
    fecha_cierre DATE NOT NULL,
    efectivo_real_caja REAL NOT NULL,
    transferencias_total REAL NOT NULL DEFAULT 0.0,
    a_pagar_efectivo_proveedores REAL NOT NULL,
    a_pagar_transferencias_proveedores REAL NOT NULL DEFAULT 0.0,
    diferencia_semana REAL NOT NULL DEFAULT 0.0,
    ganancia_semana REAL NOT NULL,
    resto_operativo REAL NOT NULL,
    resto_mas_ganancias REAL NOT NULL,
    total_efectivo_entre_dos REAL NOT NULL,
    total_transferencia_entre_dos REAL NOT NULL DEFAULT 0.0,
    liquidado_por INTEGER NOT NULL REFERENCES usuarios(id),
    observaciones TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_productos_sku ON productos(sku);
  CREATE INDEX IF NOT EXISTS idx_productos_codigo_barras ON productos(codigo_barras);
  CREATE INDEX IF NOT EXISTS idx_ventas_folio ON ventas(folio_ticket);
  CREATE INDEX IF NOT EXISTS idx_kardex_producto ON kardex_movimientos(producto_id);
`);

export function runInTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

function seedIfEmpty(): void {
  const row = db.prepare('SELECT COUNT(*) AS count FROM usuarios').get() as { count: number };
  if (row && row.count > 0) {
    return;
  }

  runInTransaction(() => {
    db.prepare(`
      INSERT INTO configuracion_negocio (
        id, nombre_tienda, razon_social, rut_fiscal, direccion, telefono,
        moneda_principal, tasa_cambio_usd_cup, tasa_cambio_mlc_cup,
        fondo_fijo_caja_chica, tope_vale_caja_chica, margen_utilidad_default
      ) VALUES (
        1, 'Gestor Tienda', 'Gestor Tienda S.R.L.', '40019283741',
        'Calle Principal #102 e/ Central y Línea', '+53 52000000',
        'CUP', 320.00, 270.00, 25000.00, 5000.00, 25.00
      );
    `).run();

    const insertUser = db.prepare(`
      INSERT INTO usuarios (nombre_completo, username, pin_hash, password_hash, rol, carnet_identidad, telefono)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `);
    insertUser.run('Alejandro Morales', 'admin', hashSha256('1234'), hashSha256('admin2024*'), 'admin', '85031209841', '+53 53456789');
    insertUser.run('Laura González', 'cajera1', hashSha256('2024'), hashSha256('caja2024*'), 'cajero', '92051408321', '+53 54123890');
    insertUser.run('Carlos Méndez', 'almacen', hashSha256('0104'), hashSha256('almacen2024*'), 'almacenero', '88102319401', '+53 52998811');
    insertUser.run('Roberto V.', 'socio_inversor', hashSha256('9999'), hashSha256('socio2024*'), 'auditor', '78010219432', '+53 53112233');

    const insertProv = db.prepare(`
      INSERT INTO proveedores (codigo_ref, nombre_comercial, razon_social, identificacion_fiscal, contacto_nombre, telefono, tipo_proveedor, saldo_pendiente_efectivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);
    insertProv.run('PROV-001', 'Comercializadora GAIBE S.R.L.', 'GAIBE Soluciones S.R.L.', '40019283741', 'Juan Carlos Pérez Ramos', '+53 53901120', 'Consignación / Venta Devengada', 53841.00);
    insertProv.run('PROV-002', 'Distribuidora EMELYH', 'EMELYH Alimentos S.R.L.', '40018899211', 'Carlos Viamontes', '+53 52849102', 'Consignación / Venta Devengada', 68400.00);
    insertProv.run('PROV-003', 'Importadora Habana Sur', 'Habana Sur Trading S.A.', '40017722104', 'Margarita Leyva', '+53 78314455', 'Consignación / Venta Devengada', 0.00);
    insertProv.run('PROV-004', 'Distribuidora Caribe S.R.L.', 'Caribe Mayorista S.R.L.', '40016633099', 'Orestes Morales', '+53 52114477', 'Compra Firme', 0.00);
    insertProv.run('PROV-005', 'Cooperativa La Fe', 'Cooperativa Agroindustrial La Fe', '40015522881', 'Elena Rodríguez', '+53 54001122', 'Compra Firme', 0.00);

    const insertCat = db.prepare('INSERT INTO categorias (nombre, descripcion) VALUES (?, ?);');
    insertCat.run('Alimentos y Bebidas', 'Granos, aceites, refrescos, cervezas y cafés');
    insertCat.run('Aseo y Hogar', 'Detergentes, jabones y artículos de limpieza');
    insertCat.run('Ferretería y Herramientas', 'Iluminación LED, materiales eléctricos y ferretería');
    insertCat.run('Electrónica menor', 'Accesorios electrónicos y pilas');

    const insertProd = db.prepare(`
      INSERT INTO productos (sku, codigo_barras, descripcion, categoria_id, proveedor_id, unidad_medida, stock_actual, stock_minimo, costo_ultimo, costo_pmp, precio_venta_cup)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    const insertLote = db.prepare(`
      INSERT INTO producto_lotes (producto_id, codigo_lote, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_unitario)
      VALUES (?, ?, ?, ?, ?, ?);
    `);

    const productosSeed: Array<[string, string, string, number, number, string, number, number, number, number, number, string, string]> = [
      ['SKU-77021', '85910244102', 'Aceite Vegetal Criollo 1L', 1, 4, 'UNIDAD', 0, 15, 710.0, 710.0, 980.0, 'L-2401-A', '2026-11-30'],
      ['SKU-44109', '78912300445', 'Detergente Multiuso 500g', 2, 3, 'PAQUETE', 20, 15, 210.0, 210.0, 350.0, 'L-2402-B', '2027-06-15'],
      ['SKU-31200', '85934110294', 'Café Tostado Molido 250g', 1, 5, 'PAQUETE', 25, 20, 390.0, 390.0, 600.0, 'L-2403-C', '2026-12-20'],
      ['SKU-10944', '85994200118', 'Arroz Grano Largo 1kg', 1, 4, 'KG', 140, 30, 175.0, 175.0, 245.0, 'L-2404-D', '2027-03-10'],
      ['SKU-89211', '77011928371', 'Bombillo LED 12W Luz Fría', 3, 3, 'UNIDAD', 85, 10, 290.0, 290.0, 440.0, 'L-2405-E', '2030-01-01'],
      ['SKU-20512', '85900213459', 'Jabón de Baño Floral 120g', 2, 5, 'UNIDAD', 210, 40, 95.0, 95.0, 150.0, 'L-2406-F', '2027-09-01'],
      ['SKU-BEB-355', '78910001355', 'Refresco Nacional Lata 355ml', 1, 1, 'UNIDAD', 95, 20, 130.0, 130.0, 180.0, 'L-2407-G', '2026-10-15'],
      ['SKU-GAL-002', '78910004002', 'Galletas Dulces Paquete', 1, 2, 'PAQUETE', 60, 15, 85.0, 85.0, 120.0, 'L-2408-H', '2026-08-20'],
      ['CERV-CRIS-355', '78910002', 'Cerveza Cristal Lata 355ml', 1, 1, 'CAJA', 95, 15, 2050.0, 2075.0, 2600.0, 'B-8842', '2026-12-30'],
      ['REF-CM-15', '78910001', 'Refresco Ciego Montero Cola 1.5L', 1, 1, 'PAQUETE', 120, 20, 410.0, 415.5, 520.0, 'L-2310-A', '2026-11-14'],
    ];

    for (const [sku, barcode, desc, catId, provId, unidad, stock, stockMin, cUlt, cPmp, precio, loteCod, venc] of productosSeed) {
      const info = insertProd.run(sku, barcode, desc, catId, provId, unidad, stock, stockMin, cUlt, cPmp, precio);
      const prodId = Number(info.lastInsertRowid);
      insertLote.run(prodId, loteCod, stock, stock, cPmp, venc);
    }

    const insertCliente = db.prepare(`
      INSERT INTO clientes (codigo_cliente, nombre_completo, carnet_identidad, telefono, limite_credito, saldo_deudor_actual)
      VALUES (?, ?, ?, ?, ?, ?);
    `);
    insertCliente.run('CLI-001', 'Elena Martínez Ramos', '74081209142', '+53 53882201', 8000.00, 2350.00);
    insertCliente.run('CLI-002', 'Marcos Santana Morales', '85092014389', '+53 52994411', 10000.00, 4800.00);
    insertCliente.run('CLI-003', 'Fabián González', '91031408123', '+53 54009988', 5000.00, 0.00);

    const turnoInfo = db.prepare(`
      INSERT INTO turnos_caja (
        caja_numero, cajero_id, fondo_inicial_cup, estado, total_ventas_efectivo_cup, total_ventas_transferencia_cup
      ) VALUES ('Gaveta 01', 2, 10000.00, 'ABIERTA', 0.00, 0.00);
    `).run();
    const turnoId = Number(turnoInfo.lastInsertRowid);

    const insertComp = db.prepare(`
      INSERT INTO comprobantes_pago_proveedor (
        folio_comprobante, proveedor_id, usuario_emisor_id, monto_liquidado_cup, canal_pago,
        referencia_bancaria, receptor_nombre, receptor_ci, documento_fuente_ref, hash_sha256
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?);
    `);
    insertComp.run(
      'REC-2023-0891', 3, 30000.00, 'EFECTIVO_GAVETA', null,
      'Carlos Viamontes (Chofer)', '81051409211', 'Lote C-12',
      hashSha256('REC-2023-0891|3|30000')
    );
    insertComp.run(
      'REC-2023-0890', 3, 15800.00, 'TRANSFERENCIA_BANCARIA', 'EnZona 00928174',
      'Margarita Leyva', '76032208411', 'Lote C-11',
      hashSha256('REC-2023-0890|3|15800')
    );

    const insertVale = db.prepare(`
      INSERT INTO caja_chica_vales (
        folio_vale, turno_id, autorizado_por, beneficiario_nombre, beneficiario_ci,
        rubro, monto_desembolsado_cup, concepto_justificacion, hash_sha256
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?);
    `);
    const valesSeed: Array<[string, string, string, string, number, string]> = [
      ['VAL-CC-2023-042', 'Raúl Méndez', '88102319401', 'Insumos y Embalaje', 7250.00, 'Compra de 10 paquetes de bolsas nylon camiseta 500u'],
      ['VAL-CC-2023-041', 'Laura González', '92051408321', 'Servicios Básicos (UNE/ETECSA)', 3400.00, 'Pago de factura eléctrica UNE neveras lácteos Comprobante #948210-C'],
      ['VAL-CC-2023-040', 'Laura González', '92051408321', 'Insumos y Embalaje', 1600.00, 'Adquisición de 10 rollos de papel térmico de 80mm TPV'],
      ['VAL-CC-2023-039', 'Mario Rivero', '74011218902', 'Transporte y Flete', 1680.00, 'Flete bicitaxi: traslado 4 cajas aceite vegetal desde almacén anexo'],
      ['VAL-CC-2023-038', 'Ernesto Cabrera', '81090409812', 'Mantenimiento y Reparación', 1250.00, 'Compra de 4 bombillos LED 50W y cinta aislante para mostrador'],
      ['VAL-CC-2023-037', 'Laura González', '92051408321', 'Alimentación y Estipendio', 1400.00, 'Estipendio almuerzo jornada corrida fin de semana (cajeros)'],
    ];
    for (const [folio, benef, ci, rubro, monto, conc] of valesSeed) {
      insertVale.run(folio, turnoId, benef, ci, rubro, monto, conc, hashSha256(`${folio}|${benef}|${monto}|${conc}`));
    }

    db.prepare(`
      INSERT INTO liquidaciones_semanales (
        folio_liquidacion, semana_periodo, fecha_cierre, efectivo_real_caja, transferencias_total,
        a_pagar_efectivo_proveedores, a_pagar_transferencias_proveedores, diferencia_semana, ganancia_semana,
        resto_operativo, resto_mas_ganancias, total_efectivo_entre_dos, liquidado_por, observaciones
      ) VALUES (
        'LIQ-SEM-2023-37', 'SEMANA 07-13 Sept', '2023-09-13', 127950.00, 0.00,
        122241.00, 0.00, 0.00, 1606.00,
        5709.00, 7315.00, 3657.00, 1, 'Cuadre verificado conforme con libro de ventas y obligaciones GAIBE.'
      );
    `).run();
  });
}

seedIfEmpty();

export async function createSqliteBackup(): Promise<{ destFile: string; hashSha256: string }> {
  const backupDir = path.join(ROOT_DIR, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const relDest = path.join('backups', `respaldo_manual_${stamp}.db`);
  const absDest = path.join(ROOT_DIR, relDest);
  await backup(db, absDest);
  const fileBuffer = fs.readFileSync(absDest);
  const hash = createHash('sha256').update(fileBuffer).digest('hex');
  return { destFile: relDest, hashSha256: hash };
}
