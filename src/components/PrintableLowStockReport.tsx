import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';
import { escapeCsvCell } from '../utils/csvExport.js';
import {
  getStoredThresholdConfig,
  sanitizeThresholdValue,
  saveThresholdConfig,
  THRESHOLD_CHANGED_EVENT,
  type ThresholdConfig,
  type ThresholdMode,
} from '../utils/thresholdConfig.js';

export interface PrintableLowStockReportProps {
  apiEndpoint?: string;
}

type PriorityTier = 1 | 2 | 3;
type SeverityFilter = 'all' | 'critical' | 'low';

interface LowStockEntry {
  item: InventoryItem;
  stock: number;
  threshold: number;
  deficit: number;
  coveragePct: number;
  unitCost: number;
  estimatedCostCup: number;
  tier: PriorityTier;
  tierLabel: string;
}

interface SupplierGroup {
  supplierName: string;
  entries: LowStockEntry[];
  totalDeficit: number;
  totalEstimatedCost: number;
}

function formatMoney(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatFolioDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `REP-STK-${yyyy}${mm}${dd}`;
}

function formatReadableTimestamp(date: Date): string {
  return date.toLocaleString('es-ES', {
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const PrintableLowStockReport: React.FC<PrintableLowStockReportProps> = ({
  apiEndpoint = '/api/productos',
}) => {
  const initialThreshold = useMemo(() => getStoredThresholdConfig(), []);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<Date>(() => new Date());

  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>(initialThreshold.mode);
  const [fixedThreshold, setFixedThreshold] = useState<number>(initialThreshold.fixedMinimum);
  const [thresholdInputText, setThresholdInputText] = useState<string>(
    String(initialThreshold.fixedMinimum)
  );

  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [groupBySupplier, setGroupBySupplier] = useState<boolean>(false);
  const [includeCosts, setIncludeCosts] = useState<boolean>(true);
  const [includeSignatures, setIncludeSignatures] = useState<boolean>(true);
  const [notes, setNotes] = useState<string>('');

  const updateThreshold = useCallback((nextMode: ThresholdMode, nextFixed: number) => {
    const clean = sanitizeThresholdValue(nextFixed, 25);
    setThresholdMode(nextMode);
    setFixedThreshold(clean);
    setThresholdInputText(String(clean));
    saveThresholdConfig({ mode: nextMode, fixedMinimum: clean });
  }, []);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiEndpoint);
      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status} al consultar SQLite`);
      }
      const data = (await response.json()) as { productos?: InventoryItem[] };
      setItems(Array.isArray(data.productos) ? data.productos : []);
      setGeneratedAt(new Date());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo cargar el inventario para generar el reporte'
      );
    } finally {
      setLoading(false);
    }
  }, [apiEndpoint]);

  useEffect(() => {
    void fetchProducts();

    const handleRefresh = () => {
      void fetchProducts();
    };
    const handleThresholdSync = (event: Event) => {
      const detail = (event as CustomEvent<ThresholdConfig>).detail;
      if (!detail) return;
      setThresholdMode(detail.mode);
      setFixedThreshold(detail.fixedMinimum);
      setThresholdInputText(String(detail.fixedMinimum));
    };

    window.addEventListener('inventory:updated', handleRefresh);
    window.addEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdSync);
    return () => {
      window.removeEventListener('inventory:updated', handleRefresh);
      window.removeEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdSync);
    };
  }, [fetchProducts]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      const name = (item.categoria_nombre ?? '').trim();
      if (name) set.add(name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [items]);

  const entries = useMemo<LowStockEntry[]>(() => {
    const list: LowStockEntry[] = [];

    for (const item of items) {
      const stock = Number(item.stock_actual);
      const threshold =
        thresholdMode === 'fixed'
          ? Math.max(0, fixedThreshold)
          : Math.max(0, Number(item.stock_minimo));

      if (stock > 0 && stock >= threshold) {
        continue;
      }

      if (categoryFilter !== 'all' && (item.categoria_nombre ?? '') !== categoryFilter) {
        continue;
      }

      const isCritical = stock <= 0;
      if (severityFilter === 'critical' && !isCritical) continue;
      if (severityFilter === 'low' && isCritical) continue;

      const deficit = Math.max(stock <= 0 && threshold === 0 ? 1 : 0, threshold - stock);
      const coveragePct =
        threshold > 0
          ? Math.max(0, Math.min(100, Math.round((stock / threshold) * 100)))
          : 0;
      const unitCost = Math.max(0, Number(item.costo_ultimo || 0));
      const estimatedCostCup = deficit * unitCost;

      let tier: PriorityTier = 3;
      let tierLabel = 'Stock bajo';
      if (isCritical) {
        tier = 1;
        tierLabel = 'Agotado';
      } else if (coveragePct < 50) {
        tier = 2;
        tierLabel = 'Urgente (<50%)';
      }

      list.push({
        item,
        stock,
        threshold,
        deficit,
        coveragePct,
        unitCost,
        estimatedCostCup,
        tier,
        tierLabel,
      });
    }

    list.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.coveragePct !== b.coveragePct) return a.coveragePct - b.coveragePct;
      if (b.deficit !== a.deficit) return b.deficit - a.deficit;
      return a.item.descripcion.localeCompare(b.item.descripcion, 'es');
    });

    return list;
  }, [items, thresholdMode, fixedThreshold, categoryFilter, severityFilter]);

  const summary = useMemo(() => {
    let criticalCount = 0;
    let lowCount = 0;
    let totalDeficitUnits = 0;
    let totalEstimatedCost = 0;
    const suppliers = new Set<string>();

    for (const entry of entries) {
      if (entry.tier === 1) criticalCount += 1;
      else lowCount += 1;
      totalDeficitUnits += entry.deficit;
      totalEstimatedCost += entry.estimatedCostCup;
      suppliers.add((entry.item.proveedor_nombre ?? '').trim() || 'Sin proveedor asignado');
    }

    return {
      totalAlerts: entries.length,
      criticalCount,
      lowCount,
      totalDeficitUnits,
      totalEstimatedCost,
      supplierCount: suppliers.size,
      totalEvaluated: items.length,
    };
  }, [entries, items.length]);

  const supplierGroups = useMemo<SupplierGroup[]>(() => {
    const map = new Map<string, SupplierGroup>();
    for (const entry of entries) {
      const name = (entry.item.proveedor_nombre ?? '').trim() || 'Sin proveedor asignado';
      let group = map.get(name);
      if (!group) {
        group = {
          supplierName: name,
          entries: [],
          totalDeficit: 0,
          totalEstimatedCost: 0,
        };
        map.set(name, group);
      }
      group.entries.push(entry);
      group.totalDeficit += entry.deficit;
      group.totalEstimatedCost += entry.estimatedCostCup;
    }

    return Array.from(map.values()).sort((a, b) => {
      if (b.totalDeficit !== a.totalDeficit) return b.totalDeficit - a.totalDeficit;
      return a.supplierName.localeCompare(b.supplierName, 'es');
    });
  }, [entries]);

  const handlePrint = () => {
    setGeneratedAt(new Date());
    window.setTimeout(() => {
      window.print();
    }, 60);
  };

  const handleExportLowStockCsv = () => {
    if (entries.length === 0) return;

    const headers = [
      'Prioridad',
      'SKU',
      'Articulo',
      'Categoria',
      'Proveedor',
      'Unidad',
      'Stock_Actual',
      'Umbral_Minimo',
      'Faltante_Reponer',
      'Estado',
      'Costo_Unitario_CUP',
      'Costo_Estimado_Reposicion_CUP',
    ];

    const lines = [headers.map(escapeCsvCell).join(',')];

    entries.forEach((entry, idx) => {
      lines.push(
        [
          `#${idx + 1}`,
          entry.item.sku,
          entry.item.descripcion,
          entry.item.categoria_nombre ?? 'Sin categoría',
          entry.item.proveedor_nombre ?? 'Sin proveedor asignado',
          entry.item.unidad_medida ?? 'UNIDAD',
          entry.stock,
          entry.threshold,
          entry.deficit,
          entry.tierLabel,
          entry.unitCost.toFixed(2),
          entry.estimatedCostCup.toFixed(2),
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    });

    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const yyyy = generatedAt.getFullYear();
    const mm = String(generatedAt.getMonth() + 1).padStart(2, '0');
    const dd = String(generatedAt.getDate()).padStart(2, '0');

    const link = document.createElement('a');
    link.href = url;
    link.download = `reporte_stock_bajo_${yyyy}-${mm}-${dd}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const thresholdSummaryText =
    thresholdMode === 'fixed'
      ? `Umbral global definido (${fixedThreshold} u.)`
      : 'Mínimo individual configurado por artículo';

  const severitySummaryText =
    severityFilter === 'critical'
      ? 'Solo artículos agotados (0 u.)'
      : severityFilter === 'low'
        ? 'Solo stock bajo (>0 y menor al umbral)'
        : 'Todos los artículos bajo umbral';

  return (
    <div className="flex flex-col gap-5 pt-2 print:pt-0 print:gap-0">
      {/* Screen-only Configuration & Action Bar */}
      <section className="no-print print:hidden bg-white rounded-2xl shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-6 border border-[#E8EEF7] flex flex-col gap-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <a
                className="inline-flex items-center gap-1 text-[#0E4BFF] hover:underline font-label-sm text-label-sm font-semibold whitespace-nowrap shrink-0"
                href="/inventario"
              >
                <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                <span>Volver a Inventario</span>
              </a>
              <span aria-hidden="true" className="text-[#CBD5E1]">
                /
              </span>
              <a
                className="inline-flex items-center gap-1 text-[#64748B] hover:text-[#182034] hover:underline font-label-sm text-label-sm whitespace-nowrap shrink-0"
                href="/reportes"
              >
                <span>Centro de Reportes</span>
              </a>
            </div>
            <h1 className="font-display-md text-display-md text-[#182034] font-bold tracking-tight">
              Vista Imprimible de Stock Bajo Umbral
            </h1>
            <p className="font-body-md text-body-md text-[#64748B]">
              Resumen listo para imprimir o exportar con los artículos actualmente por debajo de su mínimo de reposición.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              className="h-10 px-4 rounded-xl bg-white border border-[#E8EEF7] hover:bg-[#F8FAFF] text-[#182034] font-label-md text-label-md font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              onClick={() => void fetchProducts()}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px] text-[#64748B]">refresh</span>
              <span>Actualizar</span>
            </button>

            <button
              className="h-10 px-4 rounded-xl bg-white border border-[#E8EEF7] hover:bg-[#F8FAFF] text-[#182034] font-label-md text-label-md font-semibold inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
              disabled={loading || entries.length === 0}
              id="btn-export-low-stock-csv"
              onClick={handleExportLowStockCsv}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px] text-[#64748B]">
                file_download
              </span>
              <span>Exportar CSV</span>
            </button>

            <button
              className="h-10 px-5 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-body-bold text-body-bold shadow-[0_4px_12px_rgba(14,75,255,0.22)] inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
              disabled={loading}
              id="btn-print-low-stock-report"
              onClick={handlePrint}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">print</span>
              <span>Imprimir Reporte</span>
            </button>
          </div>
        </div>

        {/* Report Filters & Print Preferences */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 pt-4 border-t border-[#F1F5FD]">
          {/* Threshold Rule */}
          <div className="flex flex-col gap-1.5">
            <label
              className="font-label-sm text-label-sm text-[#64748B] font-semibold"
              htmlFor="print-threshold-mode"
            >
              Criterio de Umbral Mínimo
            </label>
            <div className="flex items-center gap-2 bg-[#F8FAFF] rounded-xl px-3 h-10 border border-[#E8EEF7]">
              <select
                className="bg-transparent flex-1 min-w-0 font-label-md text-label-md text-[#182034] font-semibold focus:outline-none cursor-pointer"
                id="print-threshold-mode"
                onChange={(e) =>
                  updateThreshold(e.target.value as ThresholdMode, fixedThreshold)
                }
                value={thresholdMode}
              >
                <option value="item">Mínimo por artículo</option>
                <option value="fixed">Mínimo global definido</option>
              </select>
              {thresholdMode === 'fixed' && (
                <div className="flex items-center gap-1 pl-2 border-l border-[#E8EEF7] shrink-0">
                  <input
                    aria-label="Mínimo global en unidades"
                    className="w-16 h-7 px-1.5 rounded-lg bg-white border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums text-label-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                    id="print-fixed-threshold"
                    min={0}
                    onBlur={() => {
                      const parsed = Number(thresholdInputText);
                      const clean = sanitizeThresholdValue(
                        thresholdInputText.trim() === '' ? fixedThreshold : parsed,
                        25
                      );
                      updateThreshold('fixed', clean);
                    }}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setThresholdInputText(raw);
                      if (raw.trim() !== '') {
                        const parsed = Number(raw);
                        if (Number.isFinite(parsed) && parsed >= 0) {
                          const clean = Math.floor(parsed);
                          setFixedThreshold(clean);
                          saveThresholdConfig({ mode: 'fixed', fixedMinimum: clean });
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
          </div>

          {/* Category Filter */}
          <div className="flex flex-col gap-1.5">
            <label
              className="font-label-sm text-label-sm text-[#64748B] font-semibold"
              htmlFor="print-category-filter"
            >
              Categoría
            </label>
            <select
              className="h-10 px-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] font-label-md text-label-md text-[#182034] font-semibold focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25 cursor-pointer"
              id="print-category-filter"
              onChange={(e) => setCategoryFilter(e.target.value)}
              value={categoryFilter}
            >
              <option value="all">Todas las categorías</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Severity Filter */}
          <div className="flex flex-col gap-1.5">
            <label
              className="font-label-sm text-label-sm text-[#64748B] font-semibold"
              htmlFor="print-severity-filter"
            >
              Nivel de Severidad
            </label>
            <select
              className="h-10 px-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] font-label-md text-label-md text-[#182034] font-semibold focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25 cursor-pointer"
              id="print-severity-filter"
              onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
              value={severityFilter}
            >
              <option value="all">Todos los artículos bajo umbral</option>
              <option value="critical">Solo agotados (0 u.)</option>
              <option value="low">Solo stock bajo (&gt;0 u. y &lt; mínimo)</option>
            </select>
          </div>

          {/* Layout Mode */}
          <div className="flex flex-col gap-1.5">
            <span className="font-label-sm text-label-sm text-[#64748B] font-semibold">
              Organización del Reporte
            </span>
            <div className="flex items-center p-1 bg-[#F8FAFF] rounded-xl border border-[#E8EEF7] h-10">
              <button
                className={`flex-1 h-8 rounded-lg font-label-sm text-label-sm transition-colors whitespace-nowrap ${
                  !groupBySupplier
                    ? 'bg-[#0E4BFF] text-white font-semibold shadow-sm'
                    : 'text-[#64748B] hover:text-[#182034]'
                }`}
                onClick={() => setGroupBySupplier(false)}
                type="button"
              >
                Por Prioridad
              </button>
              <button
                className={`flex-1 h-8 rounded-lg font-label-sm text-label-sm transition-colors whitespace-nowrap ${
                  groupBySupplier
                    ? 'bg-[#0E4BFF] text-white font-semibold shadow-sm'
                    : 'text-[#64748B] hover:text-[#182034]'
                }`}
                onClick={() => setGroupBySupplier(true)}
                type="button"
              >
                Por Proveedor
              </button>
            </div>
          </div>
        </div>

        {/* Toggle Options & Observations */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
          <div className="flex flex-wrap items-center gap-6">
            <label className="inline-flex items-center gap-2 font-label-md text-label-md text-[#182034] cursor-pointer">
              <input
                checked={includeCosts}
                className="rounded accent-[#0E4BFF]"
                onChange={(e) => setIncludeCosts(e.target.checked)}
                type="checkbox"
              />
              <span>Incluir costos estimados de reposición (CUP)</span>
            </label>
            <label className="inline-flex items-center gap-2 font-label-md text-label-md text-[#182034] cursor-pointer">
              <input
                checked={includeSignatures}
                className="rounded accent-[#0E4BFF]"
                onChange={(e) => setIncludeSignatures(e.target.checked)}
                type="checkbox"
              />
              <span>Incluir bloque de firmas para orden de compra</span>
            </label>
          </div>

          <span className="font-code-mono text-[12px] text-[#64748B] tabular-nums">
            Catálogo evaluado: {summary.totalEvaluated} artículos activos
          </span>
        </div>
      </section>

      {/* Printable Report Sheet */}
      <article
        className="w-full max-w-[1060px] mx-auto bg-white text-slate-900 rounded-xl shadow-sm border border-slate-200 p-6 sm:p-10 print:max-w-none print:mx-0 print:rounded-none print:shadow-none print:border-0 print:p-0"
        id="printable-low-stock-sheet"
      >
        {/* Document Header */}
        <header className="pb-5 border-b-2 border-slate-900 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="font-label-sm text-[12px] uppercase tracking-wider text-slate-600 font-semibold">
              Gestor Tienda · Tienda Central
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-950">
              Reporte de Reposición — Stock Bajo Umbral Mínimo
            </h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 mt-1">
              <span>{thresholdSummaryText}</span>
              <span aria-hidden="true">·</span>
              <span>
                Categoría: {categoryFilter === 'all' ? 'Todas' : categoryFilter}
              </span>
              <span aria-hidden="true">·</span>
              <span>{severitySummaryText}</span>
            </div>
          </div>

          <div className="flex flex-col sm:items-end gap-0.5 text-xs text-slate-700 shrink-0 font-code-mono tabular-nums">
            <span className="text-sm font-bold text-slate-950">
              {formatFolioDate(generatedAt)}
            </span>
            <span>Emitido: {formatReadableTimestamp(generatedAt)}</span>
            <span>Fuente: SQLite Local (Existencias activas)</span>
          </div>
        </header>

        {/* Executive Summary Strip */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-5 border-b border-slate-200">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-600">
              Artículos Bajo Umbral
            </span>
            <span className="block text-2xl font-bold font-code-mono tabular-nums text-slate-950 mt-0.5">
              {summary.totalAlerts}
            </span>
            <span className="block text-[11px] text-slate-600 tabular-nums mt-0.5">
              {summary.criticalCount} agotados · {summary.lowCount} stock bajo
            </span>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-600">
              Déficit Total a Reponer
            </span>
            <span className="block text-2xl font-bold font-code-mono tabular-nums text-slate-950 mt-0.5">
              +{summary.totalDeficitUnits} u.
            </span>
            <span className="block text-[11px] text-slate-600 mt-0.5">
              Unidades mínimas requeridas
            </span>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-600">
              Inversión Mín. Estimada
            </span>
            <span className="block text-2xl font-bold font-code-mono tabular-nums text-slate-950 mt-0.5">
              ${formatMoney(summary.totalEstimatedCost)}
            </span>
            <span className="block text-[11px] text-slate-600 mt-0.5">
              CUP (según último costo)
            </span>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-600">
              Proveedores Involucrados
            </span>
            <span className="block text-2xl font-bold font-code-mono tabular-nums text-slate-950 mt-0.5">
              {summary.supplierCount}
            </span>
            <span className="block text-[11px] text-slate-600 tabular-nums mt-0.5">
              De {summary.totalEvaluated} artículos evaluados
            </span>
          </div>
        </section>

        {/* Body Content */}
        <section className="py-5">
          {error ? (
            <div className="p-6 rounded-lg bg-red-50 border border-red-200 text-red-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-bold text-base">No se pudo cargar el inventario</h3>
                <p className="text-sm mt-0.5">{error}</p>
              </div>
              <button
                className="no-print print:hidden px-4 h-9 rounded-lg bg-red-700 text-white text-sm font-semibold hover:bg-red-800 whitespace-nowrap shrink-0"
                onClick={() => void fetchProducts()}
                type="button"
              >
                Reintentar
              </button>
            </div>
          ) : loading ? (
            <div className="space-y-3 py-4">
              {Array.from({ length: 5 }).map((_, idx) => (
                <div
                  className="h-10 rounded bg-slate-100 animate-pulse"
                  key={`report-skel-${idx}`}
                />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="p-8 rounded-lg bg-emerald-50 border border-emerald-200 text-center flex flex-col items-center gap-2">
              <span className="material-symbols-outlined text-emerald-700 text-[32px]">
                verified
              </span>
              <h3 className="text-lg font-bold text-emerald-950">
                Sin novedades de reposición
              </h3>
              <p className="text-sm text-emerald-900 max-w-xl">
                Ningún artículo coincide actualmente por debajo del umbral configurado ({thresholdSummaryText}). Puedes ajustar el umbral o los filtros arriba para auditar otros niveles.
              </p>
            </div>
          ) : groupBySupplier ? (
            <div className="flex flex-col gap-6">
              {supplierGroups.map((group) => (
                <div
                  className="border border-slate-200 rounded-lg overflow-hidden break-inside-avoid"
                  key={group.supplierName}
                >
                  <div className="px-4 py-2.5 bg-slate-100 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-950">
                        Proveedor: {group.supplierName}
                      </span>
                      <span className="text-xs text-slate-600 tabular-nums">
                        · {group.entries.length}{' '}
                        {group.entries.length === 1 ? 'artículo' : 'artículos'}
                      </span>
                    </div>
                    <div className="text-xs font-code-mono tabular-nums font-semibold text-slate-800">
                      Reponer: +{group.totalDeficit} u.
                      {includeCosts && ` · Est.: $${formatMoney(group.totalEstimatedCost)} CUP`}
                    </div>
                  </div>

                  <table className="w-full text-left border-collapse text-[13px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-600">
                        <th className="py-2 px-3 font-semibold w-10">#</th>
                        <th className="py-2 px-3 font-semibold">SKU / Artículo</th>
                        <th className="py-2 px-3 font-semibold">Categoría</th>
                        <th className="py-2 px-3 font-semibold text-right">Stock</th>
                        <th className="py-2 px-3 font-semibold text-right">Mínimo</th>
                        <th className="py-2 px-3 font-semibold text-right">Faltante</th>
                        <th className="py-2 px-3 font-semibold">Estado</th>
                        {includeCosts && (
                          <>
                            <th className="py-2 px-3 font-semibold text-right">Costo Unit.</th>
                            <th className="py-2 px-3 font-semibold text-right">Subtotal CUP</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {group.entries.map((entry, idx) => (
                        <tr
                          className={
                            entry.tier === 1 ? 'bg-red-50/40' : 'bg-white'
                          }
                          key={entry.item.id}
                        >
                          <td className="py-2 px-3 font-code-mono tabular-nums text-slate-600">
                            {idx + 1}
                          </td>
                          <td className="py-2 px-3">
                            <div className="font-semibold text-slate-950">
                              {entry.item.descripcion}
                            </div>
                            <div className="text-[11px] font-code-mono text-slate-600">
                              {entry.item.sku} · {entry.item.unidad_medida}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-slate-700">
                            {entry.item.categoria_nombre ?? 'Sin categoría'}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-code-mono tabular-nums font-bold ${
                              entry.tier === 1 ? 'text-red-700' : 'text-amber-800'
                            }`}
                          >
                            {entry.stock}
                          </td>
                          <td className="py-2 px-3 text-right font-code-mono tabular-nums text-slate-700">
                            {entry.threshold}
                          </td>
                          <td className="py-2 px-3 text-right font-code-mono tabular-nums font-bold text-slate-950">
                            +{entry.deficit}
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            <span
                              className={`text-xs font-semibold ${
                                entry.tier === 1 ? 'text-red-700' : 'text-amber-800'
                              }`}
                            >
                              {entry.tierLabel}
                            </span>
                          </td>
                          {includeCosts && (
                            <>
                              <td className="py-2 px-3 text-right font-code-mono tabular-nums text-slate-700">
                                ${formatMoney(entry.unitCost)}
                              </td>
                              <td className="py-2 px-3 text-right font-code-mono tabular-nums font-semibold text-slate-950">
                                ${formatMoney(entry.estimatedCostCup)}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table
                className="w-full text-left border-collapse text-[13px]"
                id="printable-low-stock-table"
              >
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-300 text-[11px] uppercase tracking-wider text-slate-700">
                    <th className="py-2.5 px-3 font-semibold w-10">#</th>
                    <th className="py-2.5 px-3 font-semibold">SKU / Artículo</th>
                    <th className="py-2.5 px-3 font-semibold">Categoría</th>
                    <th className="py-2.5 px-3 font-semibold">Proveedor</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Stock</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Mínimo</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Faltante</th>
                    <th className="py-2.5 px-3 font-semibold">Estado</th>
                    {includeCosts && (
                      <>
                        <th className="py-2.5 px-3 font-semibold text-right">Costo Unit.</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Subtotal CUP</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {entries.map((entry, idx) => (
                    <tr
                      className={entry.tier === 1 ? 'bg-red-50/40' : 'bg-white'}
                      key={entry.item.id}
                    >
                      <td className="py-2.5 px-3 font-code-mono tabular-nums text-slate-600 align-middle">
                        {idx + 1}
                      </td>
                      <td className="py-2.5 px-3 align-middle">
                        <div className="font-semibold text-slate-950">
                          {entry.item.descripcion}
                        </div>
                        <div className="text-[11px] font-code-mono text-slate-600">
                          {entry.item.sku} · {entry.item.unidad_medida}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 align-middle">
                        {entry.item.categoria_nombre ?? 'Sin categoría'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 align-middle">
                        {entry.item.proveedor_nombre ?? 'Sin proveedor'}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-code-mono tabular-nums font-bold align-middle ${
                          entry.tier === 1 ? 'text-red-700' : 'text-amber-800'
                        }`}
                      >
                        {entry.stock}
                      </td>
                      <td className="py-2.5 px-3 text-right font-code-mono tabular-nums text-slate-700 align-middle">
                        {entry.threshold}
                      </td>
                      <td className="py-2.5 px-3 text-right font-code-mono tabular-nums font-bold text-slate-950 align-middle">
                        +{entry.deficit}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap align-middle">
                        <span
                          className={`text-xs font-semibold ${
                            entry.tier === 1 ? 'text-red-700' : 'text-amber-800'
                          }`}
                        >
                          {entry.tierLabel}
                        </span>
                      </td>
                      {includeCosts && (
                        <>
                          <td className="py-2.5 px-3 text-right font-code-mono tabular-nums text-slate-700 align-middle">
                            ${formatMoney(entry.unitCost)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-code-mono tabular-nums font-semibold text-slate-950 align-middle">
                            ${formatMoney(entry.estimatedCostCup)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-100 border-t-2 border-slate-300 font-bold text-slate-950">
                    <td className="py-2.5 px-3" colSpan={4}>
                      Totales ({entries.length}{' '}
                      {entries.length === 1 ? 'artículo listado' : 'artículos listados'})
                    </td>
                    <td className="py-2.5 px-3 text-right font-code-mono tabular-nums">—</td>
                    <td className="py-2.5 px-3 text-right font-code-mono tabular-nums">—</td>
                    <td className="py-2.5 px-3 text-right font-code-mono tabular-nums">
                      +{summary.totalDeficitUnits} u.
                    </td>
                    <td className="py-2.5 px-3" />
                    {includeCosts && (
                      <>
                        <td className="py-2.5 px-3" />
                        <td className="py-2.5 px-3 text-right font-code-mono tabular-nums">
                          ${formatMoney(summary.totalEstimatedCost)}
                        </td>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>

        {/* Editable Notes (Screen) & Plain Notes (Print) */}
        <section className="pt-4 border-t border-slate-200 flex flex-col gap-2">
          <label
            className="text-xs uppercase tracking-wider font-semibold text-slate-600"
            htmlFor="report-observations"
          >
            Observaciones para Compra / Reposición
          </label>
          <textarea
            className="no-print print:hidden w-full p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/30"
            id="report-observations"
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Añade notas de compra, plazos de entrega o prioridades para proveedores antes de imprimir..."
            rows={2}
            value={notes}
          />
          <div className="hidden print:block min-h-[36px] p-2 border border-slate-200 rounded text-xs text-slate-800 whitespace-pre-wrap">
            {notes.trim() || 'Sin observaciones adicionales.'}
          </div>
        </section>

        {/* Printable Sign-off Block */}
        {includeSignatures && (
          <footer className="mt-8 pt-6 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-8 break-inside-avoid">
            <div className="flex flex-col">
              <div className="h-10 border-b border-slate-400" />
              <span className="text-xs font-semibold text-slate-800 mt-1.5">
                Control de Almacén
              </span>
              <span className="text-[11px] text-slate-500">
                Verificación física de existencias
              </span>
            </div>
            <div className="flex flex-col">
              <div className="h-10 border-b border-slate-400" />
              <span className="text-xs font-semibold text-slate-800 mt-1.5">
                Aprobación de Compra
              </span>
              <span className="text-[11px] text-slate-500">
                Autorización de presupuesto
              </span>
            </div>
            <div className="flex flex-col">
              <div className="h-10 border-b border-slate-400" />
              <span className="text-xs font-semibold text-slate-800 mt-1.5">
                Recepción / Fecha de Pedido
              </span>
              <span className="text-[11px] text-slate-500">
                Folio: {formatFolioDate(generatedAt)}
              </span>
            </div>
          </footer>
        )}
      </article>
    </div>
  );
};

export default PrintableLowStockReport;
