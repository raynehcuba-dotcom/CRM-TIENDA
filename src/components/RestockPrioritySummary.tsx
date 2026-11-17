import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';
import {
  getStoredThresholdConfig,
  sanitizeThresholdValue,
  saveThresholdConfig,
  THRESHOLD_CHANGED_EVENT,
  type ThresholdConfig,
  type ThresholdMode,
} from '../utils/thresholdConfig.js';

export interface RestockPrioritySummaryProps {
  apiEndpoint?: string;
  onRestockSuccess?: (sku: string, addedQty: number) => void;
}

type PriorityTier = 1 | 2 | 3;

interface PrioritizedItem {
  item: InventoryItem;
  stock: number;
  threshold: number;
  deficit: number;
  coveragePct: number;
  estimatedCostCup: number;
  tier: PriorityTier;
  tierLabel: string;
}

function formatMoney(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const RestockPrioritySummary: React.FC<RestockPrioritySummaryProps> = ({
  apiEndpoint = '/api/productos',
  onRestockSuccess,
}) => {
  const initialThreshold = useMemo(() => getStoredThresholdConfig(), []);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>(initialThreshold.mode);
  const [fixedThreshold, setFixedThreshold] = useState<number>(initialThreshold.fixedMinimum);
  const [collapsed, setCollapsed] = useState<boolean>(false);

  const updateThreshold = useCallback((nextMode: ThresholdMode, nextFixed: number) => {
    const clean = sanitizeThresholdValue(nextFixed, 25);
    setThresholdMode(nextMode);
    setFixedThreshold(clean);
    saveThresholdConfig({ mode: nextMode, fixedMinimum: clean });
  }, []);

  // Inline quick-restock state for a specific item ID
  const [restockItemId, setRestockItemId] = useState<number | null>(null);
  const [restockQty, setRestockQty] = useState<string>('');
  const [restockSaving, setRestockSaving] = useState<boolean>(false);
  const [restockError, setRestockError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las prioridades de reposición');
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
    };
    window.addEventListener('dashboard:refresh', handleRefresh);
    window.addEventListener('inventory:updated', handleRefresh);
    window.addEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdSync);
    return () => {
      window.removeEventListener('dashboard:refresh', handleRefresh);
      window.removeEventListener('inventory:updated', handleRefresh);
      window.removeEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdSync);
    };
  }, [fetchProducts]);

  useEffect(() => {
    if (!statusNotice) return;
    const timer = window.setTimeout(() => setStatusNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [statusNotice]);

  const prioritizedItems = useMemo<PrioritizedItem[]>(() => {
    const list: PrioritizedItem[] = [];

    for (const item of items) {
      const stock = Number(item.stock_actual);
      const threshold =
        thresholdMode === 'fixed'
          ? Math.max(0, fixedThreshold)
          : Math.max(0, Number(item.stock_minimo));

      if (stock > 0 && stock >= threshold) {
        continue;
      }

      const deficit = Math.max(stock <= 0 && threshold === 0 ? 1 : 0, threshold - stock);
      const coveragePct = threshold > 0 ? Math.max(0, Math.min(100, Math.round((stock / threshold) * 100))) : 0;
      const unitCost = Math.max(0, Number(item.costo_ultimo || 0));
      const estimatedCostCup = deficit * unitCost;

      let tier: PriorityTier = 3;
      let tierLabel = 'Reponer';
      if (stock <= 0) {
        tier = 1;
        tierLabel = 'Crítico · Agotado';
      } else if (coveragePct < 50) {
        tier = 2;
        tierLabel = 'Urgente · <50%';
      }

      list.push({
        item,
        stock,
        threshold,
        deficit,
        coveragePct,
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
  }, [items, thresholdMode, fixedThreshold]);

  const summary = useMemo(() => {
    let criticalCount = 0;
    let lowCount = 0;
    let totalDeficitUnits = 0;
    let totalEstimatedCost = 0;

    for (const entry of prioritizedItems) {
      if (entry.tier === 1) criticalCount += 1;
      else lowCount += 1;
      totalDeficitUnits += entry.deficit;
      totalEstimatedCost += entry.estimatedCostCup;
    }

    return {
      totalAlerts: prioritizedItems.length,
      criticalCount,
      lowCount,
      totalDeficitUnits,
      totalEstimatedCost,
    };
  }, [prioritizedItems]);

  const openQuickRestock = (entry: PrioritizedItem) => {
    setRestockItemId(entry.item.id);
    setRestockQty(String(Math.max(1, entry.deficit)));
    setRestockError(null);
  };

  const submitQuickRestock = async (entry: PrioritizedItem) => {
    const qty = Number(restockQty);
    if (Number.isNaN(qty) || qty <= 0) {
      setRestockError('Ingresa una cantidad mayor a 0.');
      return;
    }

    setRestockSaving(true);
    setRestockError(null);

    try {
      const response = await fetch('/api/productos/entrada', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          producto_id: entry.item.id,
          cantidad: qty,
          costo_unitario: entry.item.costo_ultimo,
          proveedor: entry.item.proveedor_nombre ?? '',
        }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        folio?: string;
        stock_actual?: number;
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Error al registrar reposición en SQLite');
      }

      setRestockItemId(null);
      setRestockQty('');
      setStatusNotice(
        `Reposición ${data.folio ?? ''}: +${qty} u. de "${entry.item.descripcion}" (Stock actual: ${data.stock_actual ?? entry.stock + qty} u.).`
      );

      await fetchProducts();
      window.dispatchEvent(new CustomEvent('inventory:updated'));
      if (onRestockSuccess) {
        onRestockSuccess(entry.item.sku, qty);
      }
    } catch (err) {
      setRestockError(err instanceof Error ? err.message : 'No se pudo completar la reposición');
    } finally {
      setRestockSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="restock-priority-heading"
      className="bg-white rounded-2xl border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden"
      id="restock-priority-summary"
    >
      {/* Notification Header */}
      <div
        className={`px-6 py-4 border-b border-[#E8EEF7] flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
          summary.criticalCount > 0
            ? 'bg-red-50/70'
            : summary.totalAlerts > 0
              ? 'bg-amber-50/70'
              : 'bg-[#F8FAFF]'
        }`}
      >
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
              summary.criticalCount > 0
                ? 'bg-red-600 text-white'
                : summary.totalAlerts > 0
                  ? 'bg-amber-600 text-white'
                  : 'bg-[#ecfdf5] text-[#065f46]'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">
              {summary.totalAlerts > 0 ? 'notifications_active' : 'inventory_2'}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <h2
                className="font-headline-sm text-headline-sm text-[#182034] font-bold"
                id="restock-priority-heading"
              >
                Prioridades de Reposición de Inventario
              </h2>
              <span className="font-code-mono text-label-sm text-[#64748B] tabular-nums">
                · {summary.totalAlerts}{' '}
                {summary.totalAlerts === 1 ? 'artículo bajo umbral' : 'artículos bajo umbral'}
              </span>
            </div>
            <p className="font-label-sm text-label-sm text-[#64748B] tabular-nums mt-0.5">
              {loading
                ? 'Calculando existencias y umbrales desde SQLite...'
                : summary.totalAlerts === 0
                  ? 'Todos los artículos activos cumplen con el umbral configurado.'
                  : `${summary.criticalCount} agotados · ${summary.lowCount} stock bajo · Déficit total: ${summary.totalDeficitUnits} u. · Costo estimado: $${formatMoney(summary.totalEstimatedCost)} CUP`}
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 bg-white px-3 h-9 rounded-xl border border-[#E8EEF7]">
            <label
              className="font-label-sm text-label-sm text-[#64748B] whitespace-nowrap"
              htmlFor="dash-threshold-mode"
            >
              Umbral:
            </label>
            <select
              className="bg-transparent font-label-sm text-label-sm text-[#182034] font-semibold focus:outline-none cursor-pointer"
              id="dash-threshold-mode"
              onChange={(e) => updateThreshold(e.target.value as ThresholdMode, fixedThreshold)}
              value={thresholdMode}
            >
              <option value="item">Mínimo por artículo</option>
              <option value="fixed">Mínimo global definido</option>
            </select>
            {thresholdMode === 'fixed' && (
              <div className="flex items-center gap-1 pl-2 border-l border-[#E8EEF7]">
                <input
                  aria-label="Mínimo global definido en dashboard"
                  className="w-14 h-7 px-1.5 rounded-lg bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums text-label-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                  min={0}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    updateThreshold('fixed', Number.isNaN(val) || val < 0 ? 0 : Math.floor(val));
                  }}
                  type="number"
                  value={fixedThreshold}
                />
                <span className="font-code-mono text-[11px] text-[#64748B]">u.</span>
              </div>
            )}
          </div>

          {summary.totalAlerts > 0 && (
            <button
              className="h-9 px-3.5 rounded-xl bg-white hover:bg-[#F5F7FD] text-[#182034] font-label-sm text-label-sm font-semibold border border-[#E8EEF7] inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              onClick={() => setCollapsed((prev) => !prev)}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">
                {collapsed ? 'expand_more' : 'expand_less'}
              </span>
              <span>{collapsed ? 'Ver lista' : 'Contraer'}</span>
            </button>
          )}

          <a
            className="h-9 px-3.5 rounded-xl bg-white hover:bg-[#F5F7FD] text-[#182034] font-label-sm text-label-sm font-semibold border border-[#E8EEF7] inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
            href="/reporte-stock-bajo"
          >
            <span className="material-symbols-outlined text-[16px]">print</span>
            <span>Reporte Imprimible</span>
          </a>

          <a
            className="h-9 px-4 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 shadow-[0_4px_12px_rgba(14,75,255,0.22)] transition-colors whitespace-nowrap shrink-0"
            href="/inventario"
          >
            <span>Gestionar Inventario</span>
            <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
          </a>
        </div>
      </div>

      {/* Inline Status Notice after Quick Restock */}
      {statusNotice && (
        <div
          className="px-6 py-2.5 bg-[#ecfdf5] text-[#065f46] font-label-sm text-label-sm flex items-center justify-between gap-2 border-b border-[#a7f3d0]"
          role="status"
        >
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            <span>{statusNotice}</span>
          </div>
          <button
            className="text-[#065f46] hover:underline font-semibold"
            onClick={() => setStatusNotice(null)}
            type="button"
          >
            Ocultar
          </button>
        </div>
      )}

      {/* Body */}
      {!collapsed && (
        <div className="p-6">
          {error ? (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-[#182034] flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-red-600 text-[20px]">error_outline</span>
                <span className="font-body-md text-body-md">{error}</span>
              </div>
              <button
                className="px-4 h-9 rounded-xl bg-red-600 text-white font-label-sm text-label-sm font-semibold hover:opacity-90 whitespace-nowrap shrink-0"
                onClick={() => void fetchProducts()}
                type="button"
              >
                Reintentar
              </button>
            </div>
          ) : loading ? (
            <div className="space-y-2.5">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div
                  className="h-12 rounded-xl bg-[#F8FAFF] animate-pulse"
                  key={`dash-skel-${idx}`}
                />
              ))}
            </div>
          ) : prioritizedItems.length === 0 ? (
            <div className="p-4 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#065f46] text-[20px]">check_circle</span>
                <span className="font-body-bold text-body-bold text-[#065f46]">
                  Todos los artículos del inventario se encuentran por encima de su umbral definido.
                </span>
              </div>
              <a
                className="font-label-sm text-label-sm font-bold text-[#0E4BFF] hover:underline whitespace-nowrap shrink-0"
                href="/inventario"
              >
                Ver catálogo completo →
              </a>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Calculated Summary Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7]">
                  <span className="font-label-sm text-label-sm text-[#64748B] block">
                    Artículos en Alerta
                  </span>
                  <span className="font-headline-sm text-headline-sm text-[#182034] font-bold font-code-mono tabular-nums">
                    {summary.totalAlerts}
                  </span>
                </div>
                <div className="p-3.5 rounded-xl bg-red-50/70 border border-red-200/70">
                  <span className="font-label-sm text-label-sm text-red-700 font-semibold block">
                    Sin Existencias (P1)
                  </span>
                  <span className="font-headline-sm text-headline-sm text-red-700 font-bold font-code-mono tabular-nums">
                    {summary.criticalCount}
                  </span>
                </div>
                <div className="p-3.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7]">
                  <span className="font-label-sm text-label-sm text-[#64748B] block">
                    Déficit Total a Reponer
                  </span>
                  <span className="font-headline-sm text-headline-sm text-[#182034] font-bold font-code-mono tabular-nums">
                    {summary.totalDeficitUnits} u.
                  </span>
                </div>
                <div className="p-3.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7]">
                  <span className="font-label-sm text-label-sm text-[#64748B] block">
                    Inversión Mín. Estimada
                  </span>
                  <span className="font-headline-sm text-headline-sm text-[#0E4BFF] font-bold font-code-mono tabular-nums">
                    ${formatMoney(summary.totalEstimatedCost)} CUP
                  </span>
                </div>
              </div>

              {/* Prioritized Items Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-separate border-spacing-y-2" id="restock-priority-table">
                  <thead>
                    <tr className="text-[#64748B] font-label-sm text-label-sm uppercase tracking-wider">
                      <th className="py-2 px-4 font-semibold">Prioridad</th>
                      <th className="py-2 px-4 font-semibold">Artículo</th>
                      <th className="py-2 px-4 font-semibold text-right">Stock / Umbral</th>
                      <th className="py-2 px-4 font-semibold text-right">Faltante</th>
                      <th className="py-2 px-4 font-semibold text-right">Costo Est.</th>
                      <th className="py-2 px-4 font-semibold text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="font-body-md text-body-md">
                    {prioritizedItems.map((entry, index) => {
                      const { item, stock, threshold, deficit, coveragePct, estimatedCostCup, tier, tierLabel } =
                        entry;
                      const isCritical = tier === 1;
                      const isEditing = restockItemId === item.id;

                      return (
                        <React.Fragment key={item.id}>
                          <tr
                            className={`transition-colors ${
                              isCritical
                                ? 'bg-red-50/75 hover:bg-red-50'
                                : 'bg-amber-50/70 hover:bg-amber-50'
                            }`}
                            data-priority-tier={tier}
                          >
                            <td className="py-3 px-4 align-middle whitespace-nowrap rounded-l-xl border-y border-l border-[#E8EEF7]">
                              <span
                                className={`inline-flex items-center gap-1.5 font-label-sm text-label-sm font-semibold tabular-nums ${
                                  isCritical ? 'text-red-700' : 'text-amber-800'
                                }`}
                              >
                                <span
                                  className={`w-2 h-2 rounded-full ${
                                    isCritical ? 'bg-red-500' : 'bg-amber-500'
                                  }`}
                                />
                                <span>
                                  #{index + 1} · {tierLabel}
                                </span>
                              </span>
                            </td>

                            <td className="py-3 px-4 align-middle border-y border-[#E8EEF7]">
                              <div className="font-body-bold text-body-bold text-[#182034]">
                                {item.descripcion}
                              </div>
                              <div className="font-label-sm text-label-sm text-[#64748B] flex flex-wrap items-center gap-1.5">
                                <span className="font-code-mono">{item.sku}</span>
                                <span aria-hidden="true">·</span>
                                <span>{item.categoria_nombre || 'Sin categoría'}</span>
                                <span aria-hidden="true">·</span>
                                <span>{item.proveedor_nombre || 'Sin proveedor'}</span>
                              </div>
                            </td>

                            <td className="py-3 px-4 text-right align-middle whitespace-nowrap border-y border-[#E8EEF7]">
                              <div
                                className={`font-code-mono tabular-nums font-bold ${
                                  isCritical ? 'text-red-700' : 'text-amber-800'
                                }`}
                              >
                                {stock} / {threshold} u.
                              </div>
                              <div className="w-20 h-1.5 rounded-full bg-white/80 border border-[#E8EEF7] ml-auto mt-1 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    isCritical ? 'bg-red-500' : 'bg-amber-500'
                                  }`}
                                  style={{ width: `${isCritical ? 0 : Math.max(8, coveragePct)}%` }}
                                />
                              </div>
                            </td>

                            <td className="py-3 px-4 text-right align-middle whitespace-nowrap font-code-mono tabular-nums font-bold text-[#182034] border-y border-[#E8EEF7]">
                              +{deficit} u.
                            </td>

                            <td className="py-3 px-4 text-right align-middle whitespace-nowrap font-code-mono tabular-nums text-[#182034] border-y border-[#E8EEF7]">
                              ${formatMoney(estimatedCostCup)} CUP
                            </td>

                            <td className="py-3 px-4 text-right align-middle whitespace-nowrap rounded-r-xl border-y border-r border-[#E8EEF7]">
                              <button
                                className="px-3 h-8 rounded-xl bg-white hover:bg-[#0E4BFF] hover:text-white hover:border-[#0E4BFF] text-[#0E4BFF] border border-[#E8EEF7] font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
                                onClick={() =>
                                  isEditing ? setRestockItemId(null) : openQuickRestock(entry)
                                }
                                type="button"
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  {isEditing ? 'close' : 'add_shopping_cart'}
                                </span>
                                <span>{isEditing ? 'Cerrar' : 'Reponer'}</span>
                              </button>
                            </td>
                          </tr>

                          {isEditing && (
                            <tr>
                              <td className="px-4 py-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7]" colSpan={6}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="font-label-sm text-label-sm text-[#182034]">
                                    Entrada rápida en SQLite para{' '}
                                    <span className="font-semibold">{item.descripcion}</span>
                                    {item.costo_ultimo > 0 && (
                                      <span className="text-[#64748B] font-code-mono tabular-nums">
                                        {' '}
                                        · Costo unit.: ${formatMoney(item.costo_ultimo)} CUP
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex flex-wrap items-center gap-2">
                                    <label
                                      className="font-label-sm text-label-sm text-[#64748B]"
                                      htmlFor={`restock-qty-${item.id}`}
                                    >
                                      Cantidad a ingresar:
                                    </label>
                                    <input
                                      className="w-24 h-8 px-2.5 rounded-xl bg-white border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums text-label-md focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                                      id={`restock-qty-${item.id}`}
                                      min={1}
                                      onChange={(e) => {
                                        setRestockQty(e.target.value);
                                        if (restockError) setRestockError(null);
                                      }}
                                      type="number"
                                      value={restockQty}
                                    />
                                    <button
                                      className="px-3.5 h-8 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-label-sm text-label-sm font-semibold transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
                                      disabled={restockSaving}
                                      onClick={() => void submitQuickRestock(entry)}
                                      type="button"
                                    >
                                      {restockSaving ? 'Guardando...' : 'Confirmar Entrada'}
                                    </button>
                                  </div>
                                </div>
                                {restockError && (
                                  <p className="font-label-sm text-label-sm text-red-600 mt-1">
                                    {restockError}
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default RestockPrioritySummary;
