import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';

export interface RestockPrioritySummaryProps {
  apiEndpoint?: string;
  onRestockSuccess?: (sku: string, addedQty: number) => void;
}

type PriorityTier = 1 | 2 | 3;
type ThresholdMode = 'item' | 'fixed';

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
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>('item');
  const [fixedThreshold, setFixedThreshold] = useState<number>(25);
  const [collapsed, setCollapsed] = useState<boolean>(false);

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
    window.addEventListener('dashboard:refresh', handleRefresh);
    window.addEventListener('inventory:updated', handleRefresh);
    return () => {
      window.removeEventListener('dashboard:refresh', handleRefresh);
      window.removeEventListener('inventory:updated', handleRefresh);
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
          ? Math.max(1, fixedThreshold)
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
      className="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-outline-variant/40"
      id="restock-priority-summary"
    >
      {/* Notification Header */}
      <div
        className={`px-space-lg py-space-md flex flex-col lg:flex-row lg:items-center justify-between gap-space-md ${
          summary.criticalCount > 0
            ? 'bg-error-container/25'
            : summary.totalAlerts > 0
              ? 'bg-amber-50'
              : 'bg-surface-container-low'
        }`}
      >
        <div className="flex items-start sm:items-center gap-space-sm min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
              summary.criticalCount > 0
                ? 'bg-error text-on-error'
                : summary.totalAlerts > 0
                  ? 'bg-amber-700 text-white'
                  : 'bg-[#ecfdf5] text-[#065f46]'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">
              {summary.totalAlerts > 0 ? 'notifications_active' : 'inventory_2'}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-space-sm gap-y-0.5">
              <h2
                className="font-headline-sm text-headline-sm text-on-surface"
                id="restock-priority-heading"
              >
                Prioridades de Reposición de Inventario
              </h2>
              <span className="font-code-mono text-label-sm text-on-surface-variant tabular-nums">
                · {summary.totalAlerts}{' '}
                {summary.totalAlerts === 1 ? 'artículo bajo umbral' : 'artículos bajo umbral'}
              </span>
            </div>
            <p className="font-label-sm text-label-sm text-on-surface-variant tabular-nums mt-0.5">
              {loading
                ? 'Calculando existencias y umbrales desde SQLite...'
                : summary.totalAlerts === 0
                  ? 'Todos los artículos activos cumplen con el umbral configurado.'
                  : `${summary.criticalCount} agotados · ${summary.lowCount} stock bajo · Déficit total: ${summary.totalDeficitUnits} u. · Costo estimado: $${formatMoney(summary.totalEstimatedCost)} CUP`}
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-space-sm shrink-0">
          <div className="flex items-center gap-space-xs bg-surface-container-lowest px-space-sm h-9 rounded-lg border border-outline-variant/40">
            <label
              className="font-label-sm text-label-sm text-on-surface-variant whitespace-nowrap"
              htmlFor="dash-threshold-mode"
            >
              Umbral:
            </label>
            <select
              className="bg-transparent font-label-sm text-label-sm text-on-surface focus:outline-none cursor-pointer"
              id="dash-threshold-mode"
              onChange={(e) => setThresholdMode(e.target.value as ThresholdMode)}
              value={thresholdMode}
            >
              <option value="item">Mínimo por artículo</option>
              <option value="fixed">Umbral fijo</option>
            </select>
            {thresholdMode === 'fixed' && (
              <div className="flex items-center gap-1 pl-1 border-l border-outline-variant/40">
                <input
                  aria-label="Umbral fijo de stock en dashboard"
                  className="w-14 h-7 px-1.5 rounded bg-surface-container-low text-on-surface font-code-mono tabular-nums text-label-sm text-right focus:outline-none focus:ring-1 focus:ring-primary"
                  min={1}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setFixedThreshold(Number.isNaN(val) || val < 1 ? 1 : Math.floor(val));
                  }}
                  type="number"
                  value={fixedThreshold}
                />
                <span className="font-code-mono text-[11px] text-on-surface-variant">u.</span>
              </div>
            )}
          </div>

          {summary.totalAlerts > 0 && (
            <button
              className="h-9 px-space-md rounded-lg bg-surface-container-lowest hover:bg-surface-container text-on-surface font-label-sm text-label-sm font-semibold border border-outline-variant/40 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
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
            className="h-9 px-space-md rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
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
          className="px-space-lg py-space-sm bg-[#ecfdf5] text-[#065f46] font-label-sm text-label-sm flex items-center justify-between gap-space-sm border-b border-outline-variant/30"
          role="status"
        >
          <div className="flex items-center gap-space-xs">
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
        <div className="p-space-lg">
          {error ? (
            <div className="p-space-md rounded-lg bg-error-container/30 text-on-surface flex items-center justify-between gap-space-md">
              <div className="flex items-center gap-space-sm">
                <span className="material-symbols-outlined text-error text-[20px]">error_outline</span>
                <span className="font-body-md text-body-md">{error}</span>
              </div>
              <button
                className="px-space-md h-9 rounded-lg bg-error text-on-error font-label-sm text-label-sm font-semibold hover:opacity-90 whitespace-nowrap shrink-0"
                onClick={() => void fetchProducts()}
                type="button"
              >
                Reintentar
              </button>
            </div>
          ) : loading ? (
            <div className="space-y-space-sm">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div
                  className="h-12 rounded-lg bg-surface-container-low animate-pulse"
                  key={`dash-skel-${idx}`}
                />
              ))}
            </div>
          ) : prioritizedItems.length === 0 ? (
            <div className="p-space-md rounded-lg bg-[#ecfdf5] flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
              <div className="flex items-center gap-space-sm">
                <span className="material-symbols-outlined text-[#065f46] text-[20px]">check_circle</span>
                <span className="font-body-bold text-body-bold text-[#065f46]">
                  Todos los artículos del inventario se encuentran por encima de su umbral definido.
                </span>
              </div>
              <a
                className="font-label-sm text-label-sm font-bold text-primary hover:underline whitespace-nowrap shrink-0"
                href="/inventario"
              >
                Ver catálogo completo →
              </a>
            </div>
          ) : (
            <div className="flex flex-col gap-space-md">
              {/* Calculated Summary Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-space-sm">
                <div className="p-space-sm rounded-lg bg-surface-container-low">
                  <span className="font-label-sm text-label-sm text-on-surface-variant block">
                    Artículos en Alerta
                  </span>
                  <span className="font-headline-sm text-headline-sm text-on-surface font-bold font-code-mono tabular-nums">
                    {summary.totalAlerts}
                  </span>
                </div>
                <div className="p-space-sm rounded-lg bg-error-container/20">
                  <span className="font-label-sm text-label-sm text-error font-semibold block">
                    Sin Existencias (P1)
                  </span>
                  <span className="font-headline-sm text-headline-sm text-error font-bold font-code-mono tabular-nums">
                    {summary.criticalCount}
                  </span>
                </div>
                <div className="p-space-sm rounded-lg bg-surface-container-low">
                  <span className="font-label-sm text-label-sm text-on-surface-variant block">
                    Déficit Total a Reponer
                  </span>
                  <span className="font-headline-sm text-headline-sm text-on-surface font-bold font-code-mono tabular-nums">
                    {summary.totalDeficitUnits} u.
                  </span>
                </div>
                <div className="p-space-sm rounded-lg bg-surface-container-low">
                  <span className="font-label-sm text-label-sm text-on-surface-variant block">
                    Inversión Mín. Estimada
                  </span>
                  <span className="font-headline-sm text-headline-sm text-primary font-bold font-code-mono tabular-nums">
                    ${formatMoney(summary.totalEstimatedCost)} CUP
                  </span>
                </div>
              </div>

              {/* Prioritized Items Table */}
              <div className="overflow-x-auto rounded-lg border border-outline-variant/30">
                <table className="w-full text-left border-collapse" id="restock-priority-table">
                  <thead>
                    <tr className="bg-surface-container-low text-on-surface-variant font-label-sm text-label-sm uppercase tracking-wider">
                      <th className="py-space-sm px-space-md font-semibold">Prioridad</th>
                      <th className="py-space-sm px-space-md font-semibold">Artículo</th>
                      <th className="py-space-sm px-space-md font-semibold text-right">Stock / Umbral</th>
                      <th className="py-space-sm px-space-md font-semibold text-right">Faltante</th>
                      <th className="py-space-sm px-space-md font-semibold text-right">Costo Est.</th>
                      <th className="py-space-sm px-space-md font-semibold text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-container-low font-body-md text-body-md">
                    {prioritizedItems.map((entry, index) => {
                      const { item, stock, threshold, deficit, coveragePct, estimatedCostCup, tier, tierLabel } =
                        entry;
                      const isCritical = tier === 1;
                      const isEditing = restockItemId === item.id;

                      return (
                        <React.Fragment key={item.id}>
                          <tr
                            className={
                              isCritical
                                ? 'bg-error-container/15 hover:bg-error-container/25 transition-colors'
                                : 'bg-amber-50/70 hover:bg-amber-100/60 transition-colors'
                            }
                            data-priority-tier={tier}
                          >
                            <td className="py-space-sm px-space-md align-middle whitespace-nowrap">
                              <span
                                className={`inline-flex items-center gap-1 font-label-sm text-label-sm font-semibold tabular-nums ${
                                  isCritical ? 'text-error' : 'text-amber-900'
                                }`}
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  {isCritical ? 'error' : 'warning'}
                                </span>
                                <span>
                                  #{index + 1} · {tierLabel}
                                </span>
                              </span>
                            </td>

                            <td className="py-space-sm px-space-md align-middle">
                              <div className="font-body-bold text-body-bold text-on-surface">
                                {item.descripcion}
                              </div>
                              <div className="font-label-sm text-label-sm text-on-surface-variant flex flex-wrap items-center gap-1.5">
                                <span className="font-code-mono">{item.sku}</span>
                                <span aria-hidden="true">·</span>
                                <span>{item.categoria_nombre || 'Sin categoría'}</span>
                                <span aria-hidden="true">·</span>
                                <span>{item.proveedor_nombre || 'Sin proveedor'}</span>
                              </div>
                            </td>

                            <td className="py-space-sm px-space-md text-right align-middle whitespace-nowrap">
                              <div
                                className={`font-code-mono tabular-nums font-bold ${
                                  isCritical ? 'text-error' : 'text-amber-900'
                                }`}
                              >
                                {stock} / {threshold} u.
                              </div>
                              <div className="w-20 h-1.5 rounded-full bg-surface-container-high ml-auto mt-1 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    isCritical ? 'bg-error' : 'bg-amber-600'
                                  }`}
                                  style={{ width: `${isCritical ? 0 : Math.max(8, coveragePct)}%` }}
                                />
                              </div>
                            </td>

                            <td className="py-space-sm px-space-md text-right align-middle whitespace-nowrap font-code-mono tabular-nums font-bold text-on-surface">
                              +{deficit} u.
                            </td>

                            <td className="py-space-sm px-space-md text-right align-middle whitespace-nowrap font-code-mono tabular-nums text-on-surface">
                              ${formatMoney(estimatedCostCup)} CUP
                            </td>

                            <td className="py-space-sm px-space-md text-right align-middle whitespace-nowrap">
                              <button
                                className="px-space-sm h-8 rounded-lg bg-surface-container-lowest hover:bg-primary-container hover:text-on-primary text-primary border border-outline-variant/40 font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
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
                            <tr className="bg-surface-container-low">
                              <td className="px-space-md py-space-sm" colSpan={6}>
                                <div className="flex flex-wrap items-center justify-between gap-space-sm">
                                  <div className="font-label-sm text-label-sm text-on-surface">
                                    Entrada rápida en SQLite para{' '}
                                    <span className="font-semibold">{item.descripcion}</span>
                                    {item.costo_ultimo > 0 && (
                                      <span className="text-on-surface-variant font-code-mono tabular-nums">
                                        {' '}
                                        · Costo unit.: ${formatMoney(item.costo_ultimo)} CUP
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex flex-wrap items-center gap-space-xs">
                                    <label
                                      className="font-label-sm text-label-sm text-on-surface-variant"
                                      htmlFor={`restock-qty-${item.id}`}
                                    >
                                      Cantidad a ingresar:
                                    </label>
                                    <input
                                      className="w-24 h-8 px-2 rounded-lg bg-surface-container-lowest border border-outline-variant/60 text-on-surface font-code-mono tabular-nums text-label-md focus:outline-none focus:ring-1 focus:ring-primary"
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
                                      className="px-space-md h-8 rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-sm text-label-sm font-semibold transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
                                      disabled={restockSaving}
                                      onClick={() => void submitQuickRestock(entry)}
                                      type="button"
                                    >
                                      {restockSaving ? 'Guardando...' : 'Confirmar Entrada'}
                                    </button>
                                  </div>
                                </div>
                                {restockError && (
                                  <p className="font-label-sm text-label-sm text-error mt-1">
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
