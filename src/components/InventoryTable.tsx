import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { buildInventoryCsv, getInventoryCsvFilename } from '../utils/csvExport.js';
import {
  getStoredThresholdConfig,
  sanitizeThresholdValue,
  saveThresholdConfig,
  THRESHOLD_CHANGED_EVENT,
  type ThresholdConfig,
  type ThresholdMode,
} from '../utils/thresholdConfig.js';

export interface InventoryItem {
  id: number;
  sku: string;
  codigo_barras: string | null;
  descripcion: string;
  categoria_id: number;
  categoria_nombre?: string;
  proveedor_id: number | null;
  proveedor_nombre?: string | null;
  unidad_medida: string;
  stock_actual: number;
  stock_minimo: number;
  costo_ultimo: number;
  costo_pmp: number;
  precio_venta_cup: number;
  precio_venta_usd?: number;
  activo: number;
}

export interface InventoryStats {
  total_productos: number;
  valor_venta_total: number;
  valor_costo_total: number;
  bajo_stock_count: number;
}

export interface InventoryAlertSummary {
  lowStock: number;
  outOfStock: number;
  belowOnly: number;
  totalDeficit: number;
  thresholdMode: ThresholdMode;
  fixedThreshold: number;
}

export interface InventoryTableProps {
  apiEndpoint?: string;
  lowStockThreshold?: number;
  onAdjustItem?: (item: InventoryItem) => void;
  onEditItem?: (item: InventoryItem) => void;
  onDeleteItem?: (item: InventoryItem) => void;
  onCreateProduct?: () => void;
  onExportCsv?: (count: number, filename: string) => void;
  onItemsLoaded?: (items: InventoryItem[], stats: InventoryStats | null) => void;
  onAlertSummaryChange?: (summary: InventoryAlertSummary) => void;
  onMinThresholdSaved?: (item: InventoryItem, newMin: number) => void;
}

type CategoryFilter = 'all' | 'alimentos' | 'aseo' | 'ferreteria' | 'electronica' | 'bajo-stock';
type SortKey = 'nombre' | 'stock-asc' | 'stock-desc' | 'precio-desc' | 'precio-asc';
type SearchScope = 'name' | 'all';

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function renderHighlightedName(name: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return name;

  const normQuery = normalizeSearchText(trimmed);
  if (!normQuery) return name;

  // Map normalized character positions back to original string indices
  const origChars = Array.from(name);
  let normStr = '';
  const normToOrigIndex: number[] = [];
  for (let i = 0; i < origChars.length; i += 1) {
    const piece = normalizeSearchText(origChars[i]);
    for (let j = 0; j < piece.length; j += 1) {
      normStr += piece[j];
      normToOrigIndex.push(i);
    }
  }

  const matchStart = normStr.indexOf(normQuery);
  if (matchStart === -1) return name;

  const origStart = normToOrigIndex[matchStart];
  const origEnd = normToOrigIndex[matchStart + normQuery.length - 1] + 1;

  return (
    <>
      {origChars.slice(0, origStart).join('')}
      <mark className="bg-primary-fixed text-on-primary-fixed rounded-xs px-0.5">
        {origChars.slice(origStart, origEnd).join('')}
      </mark>
      {origChars.slice(origEnd).join('')}
    </>
  );
}

function getCategorySlug(categoryName?: string): Exclude<CategoryFilter, 'all' | 'bajo-stock'> {
  const normalized = (categoryName ?? '').toLowerCase();
  if (normalized.includes('aseo')) return 'aseo';
  if (normalized.includes('ferreter')) return 'ferreteria';
  if (normalized.includes('electr')) return 'electronica';
  return 'alimentos';
}

function formatCurrency(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const InventoryTable: React.FC<InventoryTableProps> = ({
  apiEndpoint = '/api/productos',
  lowStockThreshold,
  onAdjustItem,
  onEditItem,
  onDeleteItem,
  onCreateProduct,
  onExportCsv,
  onItemsLoaded,
  onAlertSummaryChange,
  onMinThresholdSaved,
}) => {
  const initialThreshold = useMemo<ThresholdConfig>(() => {
    if (lowStockThreshold !== undefined) {
      return { mode: 'fixed', fixedMinimum: sanitizeThresholdValue(lowStockThreshold, 25) };
    }
    return getStoredThresholdConfig();
  }, [lowStockThreshold]);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchScope, setSearchScope] = useState<SearchScope>('name');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('stock-asc');
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>(initialThreshold.mode);
  const [fixedThreshold, setFixedThreshold] = useState<number>(initialThreshold.fixedMinimum);
  const [thresholdInputText, setThresholdInputText] = useState<string>(
    String(initialThreshold.fixedMinimum)
  );

  // Inline per-item minimum threshold editor
  const [editingMinItemId, setEditingMinItemId] = useState<number | null>(null);
  const [editingMinDraft, setEditingMinDraft] = useState<string>('');
  const [savingMinItemId, setSavingMinItemId] = useState<number | null>(null);
  const [minEditError, setMinEditError] = useState<string | null>(null);

  const getEffectiveThreshold = useCallback(
    (item: InventoryItem): number =>
      thresholdMode === 'fixed'
        ? Math.max(0, fixedThreshold)
        : Math.max(0, Number(item.stock_minimo)),
    [thresholdMode, fixedThreshold]
  );

  const updateThresholdConfig = useCallback(
    (nextMode: ThresholdMode, nextFixed: number) => {
      const normalizedFixed = sanitizeThresholdValue(nextFixed, 25);
      setThresholdMode(nextMode);
      setFixedThreshold(normalizedFixed);
      setThresholdInputText(String(normalizedFixed));
      if (lowStockThreshold === undefined) {
        saveThresholdConfig({ mode: nextMode, fixedMinimum: normalizedFixed });
      }
    },
    [lowStockThreshold]
  );

  const fetchInventory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiEndpoint);
      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status} al consultar SQLite`);
      }
      const data = (await response.json()) as {
        productos?: InventoryItem[];
        stats?: InventoryStats;
      };
      const loaded = Array.isArray(data.productos) ? data.productos : [];
      setItems(loaded);
      if (onItemsLoaded) {
        onItemsLoaded(loaded, data.stats ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el inventario');
    } finally {
      setLoading(false);
    }
  }, [apiEndpoint, onItemsLoaded]);

  useEffect(() => {
    void fetchInventory();

    const handleExternalUpdate = () => {
      void fetchInventory();
    };
    const handleThresholdSync = (event: Event) => {
      if (lowStockThreshold !== undefined) return;
      const detail = (event as CustomEvent<ThresholdConfig>).detail;
      if (!detail) return;
      setThresholdMode(detail.mode);
      setFixedThreshold(detail.fixedMinimum);
      setThresholdInputText(String(detail.fixedMinimum));
    };

    window.addEventListener('inventory:updated', handleExternalUpdate);
    window.addEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdSync);
    return () => {
      window.removeEventListener('inventory:updated', handleExternalUpdate);
      window.removeEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdSync);
    };
  }, [fetchInventory, lowStockThreshold]);

  const counts = useMemo(() => {
    const summary = {
      all: items.length,
      alimentos: 0,
      aseo: 0,
      ferreteria: 0,
      electronica: 0,
      lowStock: 0,
      outOfStock: 0,
      belowOnly: 0,
      totalDeficit: 0,
    };
    for (const item of items) {
      const slug = getCategorySlug(item.categoria_nombre);
      summary[slug] += 1;
      const stock = Number(item.stock_actual);
      const threshold = getEffectiveThreshold(item);
      if (stock <= 0) {
        summary.lowStock += 1;
        summary.outOfStock += 1;
        summary.totalDeficit += Math.max(1, threshold);
      } else if (stock < threshold) {
        summary.lowStock += 1;
        summary.belowOnly += 1;
        summary.totalDeficit += Math.max(0, threshold - stock);
      }
    }
    return summary;
  }, [items, getEffectiveThreshold]);

  useEffect(() => {
    if (loading || !onAlertSummaryChange) return;
    onAlertSummaryChange({
      lowStock: counts.lowStock,
      outOfStock: counts.outOfStock,
      belowOnly: counts.belowOnly,
      totalDeficit: counts.totalDeficit,
      thresholdMode,
      fixedThreshold,
    });
  }, [loading, counts, thresholdMode, fixedThreshold, onAlertSummaryChange]);

  const handleStartEditMin = (item: InventoryItem) => {
    setEditingMinItemId(item.id);
    setEditingMinDraft(String(Math.max(0, Number(item.stock_minimo ?? 0))));
    setMinEditError(null);
  };

  const handleSaveItemMinimum = async (item: InventoryItem) => {
    const trimmed = editingMinDraft.trim();
    const nextMin = Number(trimmed);
    if (!trimmed || Number.isNaN(nextMin) || nextMin < 0) {
      setMinEditError('Ingresa un mínimo válido (>= 0).');
      return;
    }

    setSavingMinItemId(item.id);
    setMinEditError(null);

    try {
      const response = await fetch(`/api/productos/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_minimo: Math.floor(nextMin) }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        producto?: InventoryItem;
        error?: string;
      };
      if (!response.ok || !data.success || !data.producto) {
        throw new Error(data.error || 'No se pudo actualizar el stock mínimo en SQLite');
      }

      setItems((prev) =>
        prev.map((row) => (row.id === item.id ? { ...row, stock_minimo: data.producto!.stock_minimo } : row))
      );
      setEditingMinItemId(null);
      setEditingMinDraft('');
      window.dispatchEvent(new CustomEvent('inventory:updated'));
      onMinThresholdSaved?.(data.producto, Number(data.producto.stock_minimo));
    } catch (err) {
      setMinEditError(err instanceof Error ? err.message : 'Error al guardar umbral mínimo');
    } finally {
      setSavingMinItemId(null);
    }
  };

  const filteredItems = useMemo(() => {
    const q = normalizeSearchText(searchQuery.trim());
    const list = items.filter((item) => {
      const stock = Number(item.stock_actual);
      const threshold = getEffectiveThreshold(item);
      if (categoryFilter === 'bajo-stock' && !(stock <= 0 || stock < threshold)) {
        return false;
      }
      if (
        categoryFilter !== 'all' &&
        categoryFilter !== 'bajo-stock' &&
        getCategorySlug(item.categoria_nombre) !== categoryFilter
      ) {
        return false;
      }
      if (q) {
        const haystack =
          searchScope === 'name'
            ? normalizeSearchText(item.descripcion)
            : normalizeSearchText(
                [
                  item.descripcion,
                  item.sku,
                  item.codigo_barras ?? '',
                  item.categoria_nombre ?? '',
                  item.proveedor_nombre ?? '',
                ].join(' ')
              );
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      switch (sortBy) {
        case 'nombre':
          return a.descripcion.localeCompare(b.descripcion, 'es');
        case 'stock-asc':
          return Number(a.stock_actual) - Number(b.stock_actual);
        case 'stock-desc':
          return Number(b.stock_actual) - Number(a.stock_actual);
        case 'precio-desc':
          return Number(b.precio_venta_cup) - Number(a.precio_venta_cup);
        case 'precio-asc':
          return Number(a.precio_venta_cup) - Number(b.precio_venta_cup);
      }
    });

    return list;
  }, [items, searchQuery, searchScope, categoryFilter, sortBy, getEffectiveThreshold]);

  const handleExportCsv = useCallback(() => {
    if (loading || filteredItems.length === 0) return;

    const csvContent = buildInventoryCsv(filteredItems, (row) =>
      getEffectiveThreshold(row as InventoryItem)
    );
    const filename = getInventoryCsvFilename();
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onExportCsv?.(filteredItems.length, filename);
  }, [loading, filteredItems, getEffectiveThreshold, onExportCsv]);

  useEffect(() => {
    const onExternalExport = () => {
      handleExportCsv();
    };
    window.addEventListener('inventory:export-csv', onExternalExport);
    return () => {
      window.removeEventListener('inventory:export-csv', onExternalExport);
    };
  }, [handleExportCsv]);

  const filterTabs: Array<{ key: CategoryFilter; label: string; count: number }> = [
    { key: 'all', label: 'Todos', count: counts.all },
    { key: 'alimentos', label: 'Alimentos y Bebidas', count: counts.alimentos },
    { key: 'aseo', label: 'Aseo y Hogar', count: counts.aseo },
    { key: 'ferreteria', label: 'Ferretería', count: counts.ferreteria },
    { key: 'electronica', label: 'Electrónica', count: counts.electronica },
    { key: 'bajo-stock', label: 'Bajo Stock / Agotados', count: counts.lowStock },
  ];

  return (
    <div className="flex flex-col gap-space-lg mb-space-2xl">
      {/* Toolbar: Search, Sort & Category Filters */}
      <section className="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-center">
          <div className="lg:col-span-5 flex items-center gap-space-xs">
            <div className="relative flex-1 min-w-0">
              <label className="sr-only" htmlFor="inventory-search-input">
                Filtrar artículos por nombre
              </label>
              <div className="absolute inset-y-0 left-0 pl-space-md flex items-center pointer-events-none text-outline">
                <span className="material-symbols-outlined text-[20px]">search</span>
              </div>
              <input
                aria-label="Filtrar artículos por nombre en tiempo real"
                autoComplete="off"
                className={`w-full h-10 pl-10 ${
                  searchQuery ? 'pr-24' : 'pr-4'
                } bg-surface-container-low rounded-xl text-on-surface placeholder:text-outline focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30 transition-all font-body-md text-body-md`}
                id="inventory-search-input"
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery) {
                    setSearchQuery('');
                  }
                }}
                placeholder={
                  searchScope === 'name'
                    ? 'Filtrar por nombre del artículo...'
                    : 'Filtrar por nombre, SKU o proveedor...'
                }
                type="text"
                value={searchQuery}
              />
              {searchQuery && (
                <div className="absolute inset-y-0 right-1.5 flex items-center gap-1">
                  <span className="font-code-mono text-[11px] text-on-surface-variant tabular-nums">
                    {filteredItems.length}
                  </span>
                  <button
                    aria-label="Limpiar búsqueda"
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
                    onClick={() => setSearchQuery('')}
                    title="Limpiar búsqueda"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                </div>
              )}
            </div>

            <select
              aria-label="Campo de búsqueda"
              className="h-10 px-space-sm rounded-xl bg-surface-container-low text-on-surface font-label-sm text-label-sm focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-pointer shrink-0"
              onChange={(e) => setSearchScope(e.target.value as SearchScope)}
              title="Alcance del filtro"
              value={searchScope}
            >
              <option value="name">Por nombre</option>
              <option value="all">Todo</option>
            </select>
          </div>

          <div className="lg:col-span-7 flex flex-wrap items-center justify-start lg:justify-end gap-space-sm">
            <div className="flex flex-wrap items-center gap-space-xs bg-surface-container-low px-space-sm py-1.5 min-h-10 rounded-xl border border-outline-variant/40">
              <span className="material-symbols-outlined text-[18px] text-amber-700">tune</span>
              <label
                className="font-label-sm text-label-sm text-on-surface-variant whitespace-nowrap"
                htmlFor="react-inv-threshold-mode"
              >
                Alerta mínima:
              </label>
              <select
                className="bg-transparent font-label-sm text-label-sm font-semibold text-on-surface focus:outline-none cursor-pointer"
                id="react-inv-threshold-mode"
                onChange={(e) =>
                  updateThresholdConfig(e.target.value as ThresholdMode, fixedThreshold)
                }
                value={thresholdMode}
              >
                <option value="item">Mínimo por artículo</option>
                <option value="fixed">Mínimo global definido</option>
              </select>
              {thresholdMode === 'fixed' && (
                <div className="flex items-center gap-1 pl-1.5 border-l border-outline-variant/40">
                  <input
                    aria-label="Mínimo global definido para alertas de stock"
                    className="w-16 h-7 px-1.5 rounded-lg bg-surface-container-lowest border border-outline-variant/60 text-on-surface font-code-mono tabular-nums text-label-sm text-right focus:outline-none focus:ring-2 focus:ring-primary/30"
                    id="react-inv-fixed-threshold"
                    min={0}
                    onBlur={() => {
                      const parsed = Number(thresholdInputText);
                      const clean = sanitizeThresholdValue(
                        thresholdInputText.trim() === '' ? fixedThreshold : parsed,
                        25
                      );
                      updateThresholdConfig('fixed', clean);
                    }}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setThresholdInputText(raw);
                      if (raw.trim() !== '') {
                        const parsed = Number(raw);
                        if (Number.isFinite(parsed) && parsed >= 0) {
                          const clean = Math.floor(parsed);
                          setFixedThreshold(clean);
                          if (lowStockThreshold === undefined) {
                            saveThresholdConfig({ mode: 'fixed', fixedMinimum: clean });
                          }
                        }
                      }
                    }}
                    type="number"
                    value={thresholdInputText}
                  />
                  <span className="font-code-mono text-[11px] text-on-surface-variant">u.</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-space-xs bg-surface-container-low px-space-sm h-10 rounded-xl">
              <span className="material-symbols-outlined text-[18px] text-secondary">sort</span>
              <label className="font-label-sm text-label-sm text-on-surface-variant" htmlFor="react-inv-sort">
                Ordenar:
              </label>
              <select
                className="bg-transparent font-label-sm text-label-sm text-on-surface focus:outline-none cursor-pointer pr-space-xs"
                id="react-inv-sort"
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                value={sortBy}
              >
                <option value="stock-asc">Stock (Menor a Mayor)</option>
                <option value="stock-desc">Stock (Mayor a Menor)</option>
                <option value="nombre">Nombre (A–Z)</option>
                <option value="precio-desc">Precio (Mayor a Menor)</option>
                <option value="precio-asc">Precio (Menor a Mayor)</option>
              </select>
            </div>

            <button
              aria-label="Exportar reporte de inventario actual a CSV"
              className="h-10 px-space-md rounded-xl bg-surface-container-low hover:bg-surface-container flex items-center gap-space-xs text-on-surface font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading || filteredItems.length === 0}
              id="btn-export-inventory-csv"
              onClick={handleExportCsv}
              title={`Descargar CSV con ${filteredItems.length} artículos, niveles de stock y precios`}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px] text-secondary">
                file_download
              </span>
              <span>Exportar CSV</span>
            </button>

            <button
              aria-label="Actualizar inventario desde SQLite"
              className="h-10 px-space-md rounded-xl bg-surface-container-low hover:bg-surface-container flex items-center gap-space-xs text-on-surface font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0"
              onClick={() => void fetchInventory()}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">refresh</span>
              <span>Actualizar</span>
            </button>

            {onCreateProduct && (
              <button
                aria-label="Agregar nuevo artículo al inventario"
                className="h-10 px-space-md rounded-xl bg-surface-container hover:bg-surface-container-high flex items-center gap-space-xs text-primary font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0"
                onClick={onCreateProduct}
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Agregar</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-space-xs overflow-x-auto pb-0.5 pt-space-xs">
          {filterTabs.map((tab) => {
            const isActive = categoryFilter === tab.key;
            const isAlertTab = tab.key === 'bajo-stock';
            return (
              <button
                className={`px-space-md py-space-xs rounded-xl font-label-sm text-label-sm transition-all whitespace-nowrap shrink-0 ${
                  isActive
                    ? isAlertTab
                      ? 'bg-error text-on-error shadow-sm font-semibold'
                      : 'bg-primary-container text-on-primary shadow-sm font-semibold'
                    : isAlertTab
                      ? 'bg-error-container/50 text-error hover:bg-error-container font-semibold'
                      : 'bg-surface-container-low text-on-surface-variant hover:text-on-surface hover:bg-surface-container'
                }`}
                key={tab.key}
                onClick={() => setCategoryFilter(tab.key)}
                type="button"
              >
                {tab.label} ({tab.count})
              </button>
            );
          })}
        </div>
      </section>

      {/* Threshold-Based Alert System Banner */}
      {!loading && !error && (
        <section
          aria-live="polite"
          className={`rounded-xl px-space-lg py-space-md flex flex-col lg:flex-row lg:items-center justify-between gap-space-md border ${
            counts.lowStock === 0
              ? 'bg-[#ecfdf5] border-[#a7f3d0] text-on-surface'
              : counts.outOfStock > 0
                ? 'bg-error-container/25 border-error/30 text-on-surface'
                : 'bg-amber-50 border-amber-300 text-on-surface'
          }`}
          id="inventory-alert-system"
          role="status"
        >
          <div className="flex items-start sm:items-center gap-space-sm min-w-0">
            <div
              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                counts.lowStock === 0
                  ? 'bg-[#065f46] text-white'
                  : counts.outOfStock > 0
                    ? 'bg-error text-on-error'
                    : 'bg-amber-700 text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">
                {counts.lowStock === 0 ? 'verified' : 'notifications_active'}
              </span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-body-bold text-body-bold text-on-surface tabular-nums">
                {counts.lowStock === 0
                  ? 'Niveles de stock saludables según el umbral mínimo activo'
                  : `Alerta de umbral mínimo: ${counts.lowStock} ${
                      counts.lowStock === 1
                        ? 'artículo resaltado por debajo del mínimo'
                        : 'artículos resaltados por debajo del mínimo'
                    }`}
              </span>
              <span className="font-label-sm text-label-sm text-on-surface-variant tabular-nums">
                {counts.lowStock === 0
                  ? thresholdMode === 'fixed'
                    ? `Ningún artículo está por debajo de ${fixedThreshold} u.`
                    : 'Todos los artículos superan o igualan su mínimo individual en SQLite (puedes editar cada mínimo en la tabla).'
                  : `${counts.outOfStock} agotados · ${counts.belowOnly} por debajo del mínimo · Déficit acumulado: ${counts.totalDeficit} u. · ${
                      thresholdMode === 'fixed'
                        ? `Mínimo global definido: < ${fixedThreshold} u.`
                        : 'Evaluado por stock mínimo individual (editable en cada fila)'
                    }`}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-space-xs shrink-0">
            {thresholdMode === 'fixed' && (
              <div className="flex items-center gap-1 mr-space-xs">
                {[10, 25, 50].map((preset) => (
                  <button
                    className={`h-8 px-2.5 rounded-lg font-code-mono text-[11px] font-semibold border transition-colors ${
                      fixedThreshold === preset
                        ? 'bg-primary-container text-on-primary border-primary-container'
                        : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant/50 hover:bg-surface-container'
                    }`}
                    key={preset}
                    onClick={() => updateThresholdConfig('fixed', preset)}
                    type="button"
                  >
                    {preset} u.
                  </button>
                ))}
              </div>
            )}

            {counts.lowStock > 0 && (
              <button
                className={`px-space-md h-9 rounded-xl font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  categoryFilter === 'bajo-stock'
                    ? 'bg-surface-container-lowest text-on-surface border border-outline-variant/50 hover:bg-surface-container'
                    : counts.outOfStock > 0
                      ? 'bg-error text-on-error hover:opacity-90'
                      : 'bg-amber-700 text-white hover:bg-amber-800'
                }`}
                onClick={() =>
                  setCategoryFilter((prev) => (prev === 'bajo-stock' ? 'all' : 'bajo-stock'))
                }
                type="button"
              >
                {categoryFilter === 'bajo-stock'
                  ? 'Mostrar todo el catálogo'
                  : `Solo en alerta (${counts.lowStock})`}
              </button>
            )}
          </div>
        </section>
      )}

      {/* Inventory Data Table */}
      <section className="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden">
        {error ? (
          <div className="p-space-2xl flex flex-col items-center justify-center text-center gap-space-md">
            <span className="material-symbols-outlined text-error text-[32px]">error_outline</span>
            <div>
              <h3 className="font-headline-sm text-headline-sm text-on-surface">
                No se pudo leer el inventario desde SQLite
              </h3>
              <p className="font-body-md text-body-md text-on-surface-variant mt-1">{error}</p>
            </div>
            <button
              className="px-space-lg h-10 rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold hover:bg-primary-container transition-colors"
              onClick={() => void fetchInventory()}
              type="button"
            >
              Reintentar
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse" id="stock-table">
                <thead>
                  <tr className="bg-surface-container-low text-on-surface-variant font-label-sm text-label-sm tracking-wide uppercase">
                    <th className="py-space-md px-space-lg font-semibold w-12 text-center">#</th>
                    <th className="py-space-md px-space-lg font-semibold">SKU</th>
                    <th className="py-space-md px-space-lg font-semibold">Nombre</th>
                    <th className="py-space-md px-space-lg font-semibold text-right">Nivel de Stock</th>
                    <th className="py-space-md px-space-lg font-semibold text-right">Precio Unitario</th>
                    {(onAdjustItem || onEditItem || onDeleteItem) && (
                      <th className="py-space-md px-space-lg font-semibold text-right">Acciones</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-low font-body-md text-body-md text-on-surface">
                  {loading ? (
                    Array.from({ length: 5 }).map((_, idx) => (
                      <tr className="animate-pulse" key={`skeleton-${idx}`}>
                        <td className="py-space-md px-space-lg text-center">
                          <div className="h-4 w-5 bg-surface-container rounded mx-auto" />
                        </td>
                        <td className="py-space-md px-space-lg">
                          <div className="h-4 w-24 bg-surface-container rounded" />
                        </td>
                        <td className="py-space-md px-space-lg">
                          <div className="h-4 w-48 bg-surface-container rounded mb-1.5" />
                          <div className="h-3 w-32 bg-surface-container-low rounded" />
                        </td>
                        <td className="py-space-md px-space-lg text-right">
                          <div className="h-4 w-20 bg-surface-container rounded ml-auto" />
                        </td>
                        <td className="py-space-md px-space-lg text-right">
                          <div className="h-4 w-24 bg-surface-container rounded ml-auto" />
                        </td>
                        {(onAdjustItem || onEditItem || onDeleteItem) && (
                          <td className="py-space-md px-space-lg text-right">
                            <div className="h-8 w-24 bg-surface-container rounded ml-auto" />
                          </td>
                        )}
                      </tr>
                    ))
                  ) : filteredItems.length === 0 ? (
                    <tr>
                      <td
                        className="py-space-2xl px-space-lg text-center"
                        colSpan={onAdjustItem || onEditItem || onDeleteItem ? 6 : 5}
                      >
                        <div className="flex flex-col items-center gap-space-sm max-w-md mx-auto">
                          <span className="material-symbols-outlined text-outline text-[36px]">
                            inventory_2
                          </span>
                          <h3 className="font-headline-sm text-headline-sm text-on-surface">
                            {items.length === 0
                              ? 'El inventario en SQLite está vacío'
                              : 'Ningún artículo coincide con tu búsqueda'}
                          </h3>
                          <p className="font-body-md text-body-md text-on-surface-variant">
                            {items.length === 0
                              ? 'Registra tu primer producto para empezar a controlar existencias y precios.'
                              : 'Prueba limpiando el filtro o buscando otro nombre o código SKU.'}
                          </p>
                          <div className="flex items-center gap-space-sm pt-space-xs">
                            {(searchQuery || categoryFilter !== 'all') && (
                              <button
                                className="px-space-md h-9 rounded-xl bg-surface-container text-on-surface font-label-md text-label-md hover:bg-surface-container-high transition-colors"
                                onClick={() => {
                                  setSearchQuery('');
                                  setCategoryFilter('all');
                                }}
                                type="button"
                              >
                                Limpiar filtros
                              </button>
                            )}
                            {onCreateProduct && (
                              <button
                                className="px-space-md h-9 rounded-xl bg-primary-container text-on-primary font-label-md text-label-md font-semibold hover:bg-primary transition-colors"
                                onClick={onCreateProduct}
                                type="button"
                              >
                                + Nuevo Producto
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map((item, idx) => {
                      const stock = Number(item.stock_actual);
                      const effectiveThreshold = getEffectiveThreshold(item);
                      const unitPrice = Number(item.precio_venta_cup);
                      const unitCost = Number(item.costo_ultimo || 0);
                      const isOut = stock <= 0;
                      const isLow = !isOut && stock < effectiveThreshold;
                      const deficit = Math.max(0, effectiveThreshold - stock);
                      const fillPct =
                        effectiveThreshold > 0
                          ? Math.min(
                              100,
                              Math.max(isOut ? 0 : 8, Math.round((stock / effectiveThreshold) * 100))
                            )
                          : 100;

                      const rowClass = isOut
                        ? 'bg-error-container/25 border-l-4 border-l-error hover:bg-error-container/35 transition-colors'
                        : isLow
                          ? 'bg-amber-50/95 border-l-4 border-l-amber-500 hover:bg-amber-100/75 transition-colors'
                          : 'border-l-4 border-l-transparent hover:bg-surface-container-low transition-colors';

                      const stockColor = isOut
                        ? 'text-error font-bold'
                        : isLow
                          ? 'text-amber-900 font-bold'
                          : 'text-on-surface font-semibold';

                      const stockStatusLabel = isOut
                        ? 'Agotado'
                        : isLow
                          ? 'Bajo mínimo'
                          : 'Óptimo';

                      const isEditingMin = editingMinItemId === item.id;
                      const isSavingMin = savingMinItemId === item.id;

                      return (
                        <tr
                          className={rowClass}
                          data-stock-alert={isOut ? 'critical' : isLow ? 'warning' : 'ok'}
                          data-threshold-active={effectiveThreshold}
                          key={item.id}
                        >
                          <td className="py-space-md px-space-lg text-center font-code-mono tabular-nums text-outline text-label-sm">
                            {String(idx + 1).padStart(2, '0')}
                          </td>
                          <td className="py-space-md px-space-lg align-middle">
                            <span
                              className={`font-code-mono text-code-mono font-medium block ${
                                isOut
                                  ? 'text-error'
                                  : isLow
                                    ? 'text-amber-900'
                                    : 'text-on-surface-variant'
                              }`}
                            >
                              {item.sku}
                            </span>
                            {item.codigo_barras && (
                              <span className="font-label-sm text-[11px] text-secondary tabular-nums">
                                EAN: {item.codigo_barras}
                              </span>
                            )}
                          </td>
                          <td className="py-space-md px-space-lg align-middle">
                            <div className="flex flex-wrap items-center gap-x-space-sm gap-y-0.5">
                              <span className="font-body-bold text-body-bold text-on-surface">
                                {renderHighlightedName(item.descripcion, searchQuery)}
                              </span>
                              {(isOut || isLow) && (
                                <span
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-label-sm text-[11px] font-semibold tabular-nums ${
                                    isOut
                                      ? 'bg-error text-on-error'
                                      : 'bg-amber-200/80 text-amber-950'
                                  }`}
                                >
                                  <span className="material-symbols-outlined text-[14px]">
                                    {isOut ? 'error' : 'warning'}
                                  </span>
                                  <span>
                                    {isOut
                                      ? `Sin existencias (faltan ${deficit} u.)`
                                      : `Bajo mínimo: ${stock} < ${effectiveThreshold} (faltan ${deficit} u.)`}
                                  </span>
                                </span>
                              )}
                            </div>
                            <div className="font-label-sm text-label-sm text-on-surface-variant flex flex-wrap items-center gap-1.5 mt-0.5">
                              <span>{item.categoria_nombre || 'Sin categoría'}</span>
                              <span aria-hidden="true">·</span>
                              <span>{item.proveedor_nombre || 'Sin proveedor'}</span>
                              <span aria-hidden="true">·</span>
                              <span>{item.unidad_medida}</span>
                            </div>
                          </td>
                          <td className="py-space-md px-space-lg text-right align-middle">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {(isOut || isLow) && (
                                <span
                                  className={`material-symbols-outlined text-[16px] ${
                                    isOut ? 'text-error' : 'text-amber-700'
                                  }`}
                                >
                                  {isOut ? 'error' : 'warning'}
                                </span>
                              )}
                              <span className={`font-code-mono tabular-nums ${stockColor}`}>
                                {stock} u.
                              </span>
                            </div>
                            <div className="w-24 h-1.5 rounded-full bg-surface-container-high ml-auto mt-1 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  isOut
                                    ? 'bg-error'
                                    : isLow
                                      ? 'bg-amber-600'
                                      : 'bg-primary/60'
                                }`}
                                style={{ width: `${fillPct}%` }}
                              />
                            </div>
                            <div
                              className={`font-label-sm text-[11px] tabular-nums mt-1 flex items-center justify-end gap-1 ${
                                isOut
                                  ? 'text-error font-semibold'
                                  : isLow
                                    ? 'text-amber-900 font-semibold'
                                    : 'text-on-surface-variant'
                              }`}
                            >
                              <span>{stockStatusLabel}</span>
                              <span aria-hidden="true">·</span>
                              {isEditingMin ? (
                                <span className="inline-flex items-center gap-1">
                                  <input
                                    aria-label={`Nuevo stock mínimo para ${item.descripcion}`}
                                    className="w-14 h-6 px-1 rounded bg-surface-container-lowest border border-primary/50 text-on-surface font-code-mono text-[11px] text-right focus:outline-none"
                                    disabled={isSavingMin}
                                    min={0}
                                    onChange={(e) => {
                                      setEditingMinDraft(e.target.value);
                                      if (minEditError) setMinEditError(null);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleSaveItemMinimum(item);
                                      } else if (e.key === 'Escape') {
                                        setEditingMinItemId(null);
                                        setMinEditError(null);
                                      }
                                    }}
                                    type="number"
                                    value={editingMinDraft}
                                  />
                                  <button
                                    aria-label="Guardar mínimo en SQLite"
                                    className="w-5 h-5 rounded bg-primary text-on-primary inline-flex items-center justify-center hover:bg-primary-container disabled:opacity-50"
                                    disabled={isSavingMin}
                                    onClick={() => void handleSaveItemMinimum(item)}
                                    title="Guardar mínimo"
                                    type="button"
                                  >
                                    <span className="material-symbols-outlined text-[13px]">check</span>
                                  </button>
                                  <button
                                    aria-label="Cancelar edición de mínimo"
                                    className="w-5 h-5 rounded bg-surface-container text-on-surface-variant inline-flex items-center justify-center hover:bg-surface-container-high"
                                    disabled={isSavingMin}
                                    onClick={() => {
                                      setEditingMinItemId(null);
                                      setMinEditError(null);
                                    }}
                                    title="Cancelar"
                                    type="button"
                                  >
                                    <span className="material-symbols-outlined text-[13px]">close</span>
                                  </button>
                                </span>
                              ) : (
                                <button
                                  aria-label={`Editar mínimo de ${item.descripcion}`}
                                  className="inline-flex items-center gap-0.5 hover:underline decoration-dotted cursor-pointer"
                                  onClick={() => handleStartEditMin(item)}
                                  title={
                                    thresholdMode === 'fixed'
                                      ? `Mínimo global activo: ${effectiveThreshold} u. (clic para editar mínimo SQLite del artículo: ${item.stock_minimo} u.)`
                                      : `Mínimo SQLite: ${item.stock_minimo} u. (clic para editar)`
                                  }
                                  type="button"
                                >
                                  <span>
                                    Mín: {effectiveThreshold} u.
                                    {thresholdMode === 'fixed' && item.stock_minimo !== effectiveThreshold
                                      ? ` (SQLite ${item.stock_minimo})`
                                      : ''}
                                  </span>
                                  <span className="material-symbols-outlined text-[12px] opacity-70">
                                    edit
                                  </span>
                                </button>
                              )}
                            </div>
                            {isEditingMin && minEditError && (
                              <div className="text-[11px] text-error mt-0.5">{minEditError}</div>
                            )}
                          </td>
                          <td className="py-space-md px-space-lg text-right align-middle">
                            <div className="font-code-mono tabular-nums text-body-bold text-on-surface font-bold">
                              ${formatCurrency(unitPrice)} CUP
                            </div>
                            <div className="font-label-sm text-[11px] text-on-surface-variant tabular-nums">
                              Costo: ${formatCurrency(unitCost)}
                            </div>
                          </td>
                          {(onAdjustItem || onEditItem || onDeleteItem) && (
                            <td className="py-space-md px-space-lg text-right align-middle">
                              <div className="inline-flex items-center justify-end gap-space-xs">
                                {onAdjustItem && (
                                  <button
                                    aria-label={`Ajustar stock de ${item.descripcion}`}
                                    className="p-space-xs rounded-lg bg-surface-container-high hover:bg-primary-container hover:text-on-primary text-primary transition-colors inline-flex items-center justify-center"
                                    onClick={() => onAdjustItem(item)}
                                    title="Ajustar Stock"
                                    type="button"
                                  >
                                    <span className="material-symbols-outlined text-[18px]">exposure</span>
                                  </button>
                                )}
                                {onEditItem && (
                                  <button
                                    aria-label={`Editar ${item.descripcion}`}
                                    className="p-space-xs rounded-lg bg-surface-container-high hover:bg-primary-container hover:text-on-primary text-on-surface-variant transition-colors inline-flex items-center justify-center"
                                    onClick={() => onEditItem(item)}
                                    title="Editar Artículo"
                                    type="button"
                                  >
                                    <span className="material-symbols-outlined text-[18px]">edit</span>
                                  </button>
                                )}
                                {onDeleteItem && (
                                  <button
                                    aria-label={`Eliminar ${item.descripcion}`}
                                    className="p-space-xs rounded-lg bg-error-container/40 hover:bg-error hover:text-on-error text-error transition-colors inline-flex items-center justify-center"
                                    onClick={() => onDeleteItem(item)}
                                    title="Eliminar Artículo"
                                    type="button"
                                  >
                                    <span className="material-symbols-outlined text-[18px]">delete</span>
                                  </button>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Table Footer */}
            <div className="px-space-lg py-space-md bg-surface-container-low flex flex-col sm:flex-row items-center justify-between gap-space-md">
              <div className="font-label-sm text-label-sm text-on-surface-variant tabular-nums">
                Mostrando <span className="font-semibold text-on-surface">{filteredItems.length}</span> de{' '}
                <span className="font-semibold text-on-surface">{items.length}</span> artículos registrados en SQLite
              </div>
              <div className="font-code-mono text-[11px] text-on-surface-variant">
                Sincronización directa · tienda_data.db
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default InventoryTable;
