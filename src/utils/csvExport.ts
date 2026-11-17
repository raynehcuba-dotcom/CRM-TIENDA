export interface InventoryCsvRow {
  sku: string;
  codigo_barras?: string | null;
  descripcion: string;
  categoria_nombre?: string | null;
  proveedor_nombre?: string | null;
  unidad_medida?: string | null;
  stock_actual: number;
  stock_minimo: number;
  costo_ultimo?: number | null;
  costo_pmp?: number | null;
  precio_venta_cup: number;
  precio_venta_usd?: number | null;
}

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function getInventoryCsvFilename(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `reporte_inventario_${yyyy}-${mm}-${dd}.csv`;
}

export function buildInventoryCsv(
  rows: InventoryCsvRow[],
  getThreshold?: (row: InventoryCsvRow) => number
): string {
  const headers = [
    'SKU',
    'Codigo_Barras',
    'Nombre',
    'Categoria',
    'Proveedor',
    'Unidad_Medida',
    'Stock_Actual',
    'Stock_Minimo',
    'Estado_Stock',
    'Costo_Ultimo_CUP',
    'Costo_PMP_CUP',
    'Precio_Venta_CUP',
    'Precio_Venta_USD',
    'Valor_Inventario_Costo_CUP',
    'Valor_Inventario_Venta_CUP',
  ];

  const lines: string[] = [headers.map(escapeCsvCell).join(',')];

  for (const row of rows) {
    const stock = Number(row.stock_actual || 0);
    const threshold = getThreshold ? getThreshold(row) : Number(row.stock_minimo || 0);
    const costoUltimo = Number(row.costo_ultimo || 0);
    const costoPmp = Number(row.costo_pmp ?? row.costo_ultimo ?? 0);
    const precioCup = Number(row.precio_venta_cup || 0);
    const precioUsd = Number(row.precio_venta_usd || 0);
    const valorCostoTotal = stock * costoPmp;
    const valorVentaTotal = stock * precioCup;

    const estadoStock =
      stock <= 0 ? 'Agotado' : stock < threshold ? 'Bajo umbral' : 'Disponible';

    const cells = [
      row.sku,
      row.codigo_barras ?? '',
      row.descripcion,
      row.categoria_nombre ?? 'Sin categoría',
      row.proveedor_nombre ?? 'Sin proveedor',
      row.unidad_medida ?? 'UNIDAD',
      stock,
      threshold,
      estadoStock,
      costoUltimo.toFixed(2),
      costoPmp.toFixed(2),
      precioCup.toFixed(2),
      precioUsd.toFixed(2),
      valorCostoTotal.toFixed(2),
      valorVentaTotal.toFixed(2),
    ];

    lines.push(cells.map(escapeCsvCell).join(','));
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
