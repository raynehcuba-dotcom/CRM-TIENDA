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

  // Inline per-item minimum threshold editor & active row selection
  const [editingMinItemId, setEditingMinItemId] = useState<number | null>(null);
  const [editingMinDraft, setEditingMinDraft] = useState<string>('');
  const [savingMinItemId, setSavingMinItemId] = useState<number | null>(null);
  const [minEditError, setMinEditError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);

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
    <div className="flex flex-col gap-5 mb-8">
      {/* Toolbar: Search, Sort & Underline Category Tabs */}
      <section className="bg-white rounded-2xl border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] px-6 pt-5 pb-0 flex flex-col gap-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
          <div className="lg:col-span-5 flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <label className="sr-only" htmlFor="inventory-search-input">
                Filtrar artículos por nombre
              </label>
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#94A3B8]">
                <span className="material-symbols-outlined text-[20px]">search</span>
              </div>
              <input
                aria-label="Filtrar artículos por nombre en tiempo real"
                autoComplete="off"
                className={`w-full h-10 pl-10 ${
                  searchQuery ? 'pr-24' : 'pr-4'
                } bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl text-[#182034] placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 transition-all font-body-md text-body-md`}
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
                  <span className="font-code-mono text-[11px] text-[#64748B] tabular-nums">
                    {filteredItems.length}
                  </span>
                  <button
                    aria-label="Limpiar búsqueda"
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-[#64748B] hover:text-[#182034] hover:bg-[#F1F5FD] transition-colors"
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
              className="h-10 px-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-label-sm text-label-sm focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25 cursor-pointer shrink-0"
              onChange={(e) => setSearchScope(e.target.value as SearchScope)}
              title="Alcance del filtro"
              value={searchScope}
            >
              <option value="name">Por nombre</option>
              <option value="all">Todo</option>
            </select>
          </div>

          <div className="lg:col-span-7 flex flex-wrap items-center justify-start lg:justify-end gap-2">
            <div className="flex flex-wrap items-center gap-1.5 bg-[#F8FAFF] px-3 py-1.5 min-h-10 rounded-xl border border-[#E8EEF7]">
              <span className="material-symbols-outlined text-[18px] text-amber-600">tune</span>
              <label
                className="font-label-sm text-label-sm text-[#64748B] whitespace-nowrap"
                htmlFor="react-inv-threshold-mode"
              >
                Alerta mínima:
              </label>
              <select
                className="bg-transparent font-label-sm text-label-sm font-semibold text-[#182034] focus:outline-none cursor-pointer"
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
                <div className="flex items-center gap-1 pl-2 border-l border-[#E8EEF7]">
                  <input
                    aria-label="Mínimo global definido para alertas de stock"
                    className="w-16 h-7 px-1.5 rounded-lg bg-white border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums text-label-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
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
                  <span className="font-code-mono text-[11px] text-[#64748B]">u.</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 bg-[#F8FAFF] border border-[#E8EEF7] px-3 h-10 rounded-xl">
              <span className="material-symbols-outlined text-[18px] text-[#64748B]">sort</span>
              <label className="font-label-sm text-label-sm text-[#64748B]" htmlFor="react-inv-sort">
                Ordenar:
              </label>
              <select
                className="bg-transparent font-label-sm text-label-sm font-semibold text-[#182034] focus:outline-none cursor-pointer pr-1"
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
              className="h-10 px-3.5 rounded-xl bg-white border border-[#E8EEF7] hover:bg-[#F8FAFF] flex items-center gap-1.5 text-[#182034] font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading || filteredItems.length === 0}
              id="btn-export-inventory-csv"
              onClick={handleExportCsv}
              title={`Descargar CSV con ${filteredItems.length} artículos, niveles de stock y precios`}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px] text-[#64748B]">
                file_download
              </span>
              <span>Exportar CSV</span>
            </button>

            <button
              aria-label="Actualizar inventario desde SQLite"
              className="h-10 px-3.5 rounded-xl bg-white border border-[#E8EEF7] hover:bg-[#F8FAFF] flex items-center gap-1.5 text-[#182034] font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0"
              onClick={() => void fetchInventory()}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px] text-[#64748B]">refresh</span>
              <span>Actualizar</span>
            </button>

            {onCreateProduct && (
              <button
                aria-label="Agregar nuevo artículo al inventario"
                className="h-10 px-4 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] flex items-center gap-1.5 text-white font-label-sm text-label-sm font-semibold shadow-[0_4px_12px_rgba(14,75,255,0.22)] transition-colors whitespace-nowrap shrink-0"
                onClick={onCreateProduct}
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Agregar</span>
              </button>
            )}
          </div>
        </div>

        {/* Underline Category Tabs */}
        <div className="flex items-center gap-6 overflow-x-auto border-t border-[#F1F5FD] pt-1 -mb-px">
          {filterTabs.map((tab) => {
            const isActive = categoryFilter === tab.key;
            const isAlertTab = tab.key === 'bajo-stock';
            return (
              <button
                className={`py-3 border-b-2 font-label-md text-label-md transition-all whitespace-nowrap shrink-0 inline-flex items-center gap-2 ${
                  isActive
                    ? isAlertTab
                      ? 'border-red-600 text-red-700 font-semibold'
                      : 'border-[#0E4BFF] text-[#182034] font-semibold'
                    : isAlertTab
                      ? 'border-transparent text-red-600/80 hover:text-red-700 font-medium'
                      : 'border-transparent text-[#94A3B8] hover:text-[#182034] font-medium'
                }`}
                key={tab.key}
                onClick={() => setCategoryFilter(tab.key)}
                type="button"
              >
                <span>{tab.label}</span>
                <span
                  className={`font-code-mono text-[11px] tabular-nums px-1.5 py-0.5 rounded-md ${
                    isActive
                      ? isAlertTab
                        ? 'bg-red-50 text-red-700'
                        : 'bg-[#EEF3FF] text-[#0E4BFF]'
                      : 'bg-[#F8FAFF] text-[#64748B]'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Threshold-Based Alert System Banner */}
      {!loading && !error && (
        <section
          aria-live="polite"
          className={`rounded-2xl px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border ${
            counts.lowStock === 0
              ? 'bg-[#ecfdf5] border-[#a7f3d0] text-[#182034]'
              : counts.outOfStock > 0
                ? 'bg-red-50/85 border-red-200 text-[#182034]'
                : 'bg-amber-50/90 border-amber-200 text-[#182034]'
          }`}
          id="inventory-alert-system"
          role="status"
        >
          <div className="flex items-start sm:items-center gap-3 min-w-0">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                counts.lowStock === 0
                  ? 'bg-[#065f46] text-white'
                  : counts.outOfStock > 0
                    ? 'bg-red-600 text-white'
                    : 'bg-amber-600 text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">
                {counts.lowStock === 0 ? 'verified' : 'notifications_active'}
              </span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-body-bold text-body-bold text-[#182034] tabular-nums">
                {counts.lowStock === 0
                  ? 'Niveles de stock saludables según el umbral mínimo activo'
                  : `Alerta de umbral mínimo: ${counts.lowStock} ${
                      counts.lowStock === 1
                        ? 'artículo resaltado por debajo del mínimo'
                        : 'artículos resaltados por debajo del mínimo'
                    }`}
              </span>
              <span className="font-label-sm text-label-sm text-[#64748B] tabular-nums">
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

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {thresholdMode === 'fixed' && (
              <div className="flex items-center gap-1 mr-1">
                {[10, 25, 50].map((preset) => (
                  <button
                    className={`h-8 px-2.5 rounded-xl font-code-mono text-[11px] font-semibold border transition-colors ${
                      fixedThreshold === preset
                        ? 'bg-[#0E4BFF] text-white border-[#0E4BFF]'
                        : 'bg-white text-[#64748B] border-[#E8EEF7] hover:bg-[#F8FAFF]'
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
                className={`px-3.5 h-9 rounded-xl font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  categoryFilter === 'bajo-stock'
                    ? 'bg-white text-[#182034] border border-[#E8EEF7] hover:bg-[#F8FAFF]'
                    : counts.outOfStock > 0
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'bg-amber-600 text-white hover:bg-amber-700'
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

      {/* Inventory Floating-Card Data Table */}
      <section className="bg-white rounded-2xl border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 sm:p-5 overflow-hidden">
        {error ? (
          <div className="p-10 flex flex-col items-center justify-center text-center gap-3">
            <span className="material-symbols-outlined text-red-600 text-[32px]">error_outline</span>
            <div>
              <h3 className="font-headline-sm text-headline-sm text-[#182034]">
                No se pudo leer el inventario desde SQLite
              </h3>
              <p className="font-body-md text-body-md text-[#64748B] mt-1">{error}</p>
            </div>
            <button
              className="px-5 h-10 rounded-xl bg-[#0E4BFF] text-white font-label-md text-label-md font-semibold hover:bg-[#0B3EDB] transition-colors"
              onClick={() => void fetchInventory()}
              type="button"
            >
              Reintentar
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto px-1">
              <table className="w-full text-left border-separate border-spacing-y-2.5" id="stock-table">
                <thead>
                  <tr className="text-[#64748B] font-label-sm text-label-sm tracking-wide uppercase">
                    <th className="py-2 px-4 font-semibold w-12 text-center">#</th>
                    <th className="py-2 px-4 font-semibold">SKU</th>
                    <th className="py-2 px-4 font-semibold">Nombre</th>
                    <th className="py-2 px-4 font-semibold text-right">Nivel de Stock</th>
                    <th className="py-2 px-4 font-semibold text-right">Precio Unitario</th>
                    {(onAdjustItem || onEditItem || onDeleteItem) && (
                      <th className="py-2 px-4 font-semibold text-right">Acciones</th>
                    )}
                  </tr>
                </thead>
                <tbody className="font-body-md text-body-md text-[#182034]">
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

                      const isSelected = selectedRowId === item.id;
                      const rowSurfaceClass = isSelected
                        ? 'bg-[#0E4BFF] text-white shadow-[0_12px_28px_-6px_rgba(14,75,255,0.42)]'
                        : isOut
                          ? 'bg-red-50/80 hover:bg-red-50 text-[#182034]'
                          : isLow
                            ? 'bg-amber-50/85 hover:bg-amber-50 text-[#182034]'
                            : 'bg-white hover:bg-[#F8FAFF] text-[#182034]';

                      const cellBorderClass = isSelected
                        ? 'border-y border-[#0E4BFF]'
                        : isOut
                          ? 'border-y border-red-200/80'
                          : isLow
                            ? 'border-y border-amber-200/80'
                            : 'border-y border-[#E8EEF7]';

                      const leftCellBorderClass = isSelected
                        ? 'rounded-l-xl border-y border-l border-[#0E4BFF]'
                        : isOut
                          ? 'rounded-l-xl border-y border-l-4 border-l-red-600 border-red-200/80'
                          : isLow
                            ? 'rounded-l-xl border-y border-l-4 border-l-amber-500 border-amber-200/80'
                            : 'rounded-l-xl border-y border-l border-[#E8EEF7]';

                      const rightCellBorderClass = isSelected
                        ? 'rounded-r-xl border-y border-r border-[#0E4BFF]'
                        : isOut
                          ? 'rounded-r-xl border-y border-r border-red-200/80'
                          : isLow
                            ? 'rounded-r-xl border-y border-r border-amber-200/80'
                            : 'rounded-r-xl border-y border-r border-[#E8EEF7]';

                      const stockColor = isSelected
                        ? 'text-white font-bold'
                        : isOut
                          ? 'text-red-700 font-bold'
                          : isLow
                            ? 'text-amber-900 font-bold'
                            : 'text-[#182034] font-semibold';

                      const stockStatusLabel = isOut
                        ? 'Agotado'
                        : isLow
                          ? 'Bajo mínimo'
                          : 'Óptimo';

                      const isEditingMin = editingMinItemId === item.id;
                      const isSavingMin = savingMinItemId === item.id;

                      return (
                        <tr
                          className={`cursor-pointer transition-all ${rowSurfaceClass}`}
                          data-stock-alert={isOut ? 'critical' : isLow ? 'warning' : 'ok'}
                          data-threshold-active={effectiveThreshold}
                          key={item.id}
                          onClick={() =>
                            setSelectedRowId((prev) => (prev === item.id ? null : item.id))
                          }
                        >
                          <td
                            className={`py-3.5 px-4 text-center font-code-mono tabular-nums text-label-sm ${leftCellBorderClass} ${
                              isSelected ? 'text-white/85' : 'text-[#94A3B8]'
                            }`}
                          >
                            {String(idx + 1).padStart(2, '0')}
                          </td>
                          <td className={`py-3.5 px-4 align-middle ${cellBorderClass}`}>
                            <span
                              className={`font-code-mono text-code-mono font-medium block ${
                                isSelected
                                  ? 'text-white font-semibold'
                                  : isOut
                                    ? 'text-red-700'
                                    : isLow
                                      ? 'text-amber-900'
                                      : 'text-[#64748B]'
                              }`}
                            >
                              {item.sku}
                            </span>
                            {item.codigo_barras && (
                              <span
                                className={`font-label-sm text-[11px] tabular-nums ${
                                  isSelected ? 'text-white/75' : 'text-[#94A3B8]'
                                }`}
                              >
                                EAN: {item.codigo_barras}
                              </span>
                            )}
                          </td>
                          <td className={`py-3.5 px-4 align-middle ${cellBorderClass}`}>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span
                                className={`font-body-bold text-body-bold ${
                                  isSelected ? 'text-white' : 'text-[#182034]'
                                }`}
                              >
                                {renderHighlightedName(item.descripcion, searchQuery)}
                              </span>
                              {(isOut || isLow) && (
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-label-sm text-[11px] font-semibold tabular-nums ${
                                    isSelected
                                      ? 'bg-white/20 text-white'
                                      : isOut
                                        ? 'bg-red-600 text-white'
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
                            <div
                              className={`font-label-sm text-label-sm flex flex-wrap items-center gap-1.5 mt-0.5 ${
                                isSelected ? 'text-white/80' : 'text-[#64748B]'
                              }`}
                            >
                              <span>{item.categoria_nombre || 'Sin categoría'}</span>
                              <span aria-hidden="true">·</span>
                              <span>{item.proveedor_nombre || 'Sin proveedor'}</span>
                              <span aria-hidden="true">·</span>
                              <span>{item.unidad_medida}</span>
                            </div>
                          </td>
                          <td
                            className={`py-3.5 px-4 text-right align-middle ${cellBorderClass}`}
                            onClick={(e) => {
                              if (isEditingMin) e.stopPropagation();
                            }}
                          >
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {(isOut || isLow) && (
                                <span
                                  className={`material-symbols-outlined text-[16px] ${
                                    isSelected
                                      ? 'text-white'
                                      : isOut
                                        ? 'text-red-600'
                                        : 'text-amber-700'
                                  }`}
                                >
                                  {isOut ? 'error' : 'warning'}
                                </span>
                              )}
                              <span className={`font-code-mono tabular-nums ${stockColor}`}>
                                {stock} u.
                              </span>
                            </div>
                            <div
                              className={`w-24 h-1.5 rounded-full ml-auto mt-1 overflow-hidden ${
                                isSelected ? 'bg-white/25' : 'bg-[#EEF3FF]'
                              }`}
                            >
                              <div
                                className={`h-full rounded-full transition-all ${
                                  isSelected
                                    ? 'bg-white'
                                    : isOut
                                      ? 'bg-red-600'
                                      : isLow
                                        ? 'bg-amber-600'
                                        : 'bg-[#0E4BFF]'
                                }`}
                                style={{ width: `${fillPct}%` }}
                              />
                            </div>
                            <div
                              className={`font-label-sm text-[11px] tabular-nums mt-1 flex items-center justify-end gap-1 ${
                                isSelected
                                  ? 'text-white/85'
                                  : isOut
                                    ? 'text-red-700 font-semibold'
                                    : isLow
                                      ? 'text-amber-900 font-semibold'
                                      : 'text-[#64748B]'
                              }`}
                            >
                              <span>{stockStatusLabel}</span>
                              <span aria-hidden="true">·</span>
                              {isEditingMin ? (
                                <span
                                  className="inline-flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    aria-label={`Nuevo stock mínimo para ${item.descripcion}`}
                                    className="w-14 h-6 px-1 rounded bg-white border border-[#0E4BFF]/50 text-[#182034] font-code-mono text-[11px] text-right focus:outline-none"
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
                                    className="w-5 h-5 rounded bg-[#0E4BFF] text-white inline-flex items-center justify-center hover:bg-[#0B3EDB] disabled:opacity-50"
                                    disabled={isSavingMin}
                                    onClick={() => void handleSaveItemMinimum(item)}
                                    title="Guardar mínimo"
                                    type="button"
                                  >
                                    <span className="material-symbols-outlined text-[13px]">check</span>
                                  </button>
                                  <button
                                    aria-label="Cancelar edición de mínimo"
                                    className="w-5 h-5 rounded bg-[#F1F5FD] text-[#64748B] inline-flex items-center justify-center hover:bg-[#E8EEF7]"
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleStartEditMin(item);
                                  }}
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
                              <div className={`text-[11px] mt-0.5 ${isSelected ? 'text-white' : 'text-red-600'}`}>
                                {minEditError}
                              </div>
                            )}
                          </td>
                          <td
                            className={`py-3.5 px-4 text-right align-middle ${
                              onAdjustItem || onEditItem || onDeleteItem
                                ? cellBorderClass
                                : rightCellBorderClass
                            }`}
                          >
                            <div
                              className={`font-code-mono tabular-nums text-body-bold font-bold ${
                                isSelected ? 'text-white' : 'text-[#182034]'
                              }`}
                            >
                              ${formatCurrency(unitPrice)} CUP
                            </div>
                            <div
                              className={`font-label-sm text-[11px] tabular-nums ${
                                isSelected ? 'text-white/75' : 'text-[#64748B]'
                              }`}
                            >
                              Costo: ${formatCurrency(unitCost)}
                            </div>
                          </td>
                          {(onAdjustItem || onEditItem || onDeleteItem) && (
                            <td
                              className={`py-3.5 px-4 text-right align-middle ${rightCellBorderClass}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="inline-flex items-center justify-end gap-1.5">
                                {onAdjustItem && (
                                  <button
                                    aria-label={`Ajustar stock de ${item.descripcion}`}
                                    className={`w-8 h-8 rounded-xl transition-colors inline-flex items-center justify-center ${
                                      isSelected
                                        ? 'bg-white text-[#0E4BFF] hover:bg-white/90'
                                        : 'bg-[#F8FAFF] border border-[#E8EEF7] hover:bg-[#0E4BFF] hover:text-white hover:border-[#0E4BFF] text-[#0E4BFF]'
                                    }`}
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
                                    className={`w-8 h-8 rounded-xl transition-colors inline-flex items-center justify-center ${
                                      isSelected
                                        ? 'bg-white/15 text-white hover:bg-white/25'
                                        : 'bg-[#F8FAFF] border border-[#E8EEF7] hover:bg-[#0E4BFF] hover:text-white hover:border-[#0E4BFF] text-[#64748B]'
                                    }`}
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
                                    className={`w-8 h-8 rounded-xl transition-colors inline-flex items-center justify-center ${
                                      isSelected
                                        ? 'bg-white/15 text-white hover:bg-red-500'
                                        : 'bg-red-50 border border-red-200/60 hover:bg-red-600 hover:text-white text-red-600'
                                    }`}
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
            <div className="px-4 pt-3 mt-1 border-t border-[#F1F5FD] flex flex-col sm:flex-row items-center justify-between gap-2">
              <div className="font-label-sm text-label-sm text-[#64748B] tabular-nums">
                Mostrando <span className="font-semibold text-[#182034]">{filteredItems.length}</span> de{' '}
                <span className="font-semibold text-[#182034]">{items.length}</span> artículos registrados en SQLite
              </div>
              <div className="font-code-mono text-[11px] text-[#94A3B8]">
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
