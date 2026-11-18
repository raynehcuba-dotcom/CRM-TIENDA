import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';
import {
  getStoredThresholdConfig,
  THRESHOLD_CHANGED_EVENT,
  type ThresholdConfig,
  type ThresholdMode,
} from '../utils/thresholdConfig.js';

interface AlertItemSnapshot {
  stock: number;
  threshold: number;
  isAlert: boolean;
}

interface PersistedAlertState {
  items: Record<string, AlertItemSnapshot>;
  acknowledgedSignature: string | null;
  browserNotifiedSignature: string | null;
}

export interface LowStockAlertEntry {
  item: InventoryItem;
  stock: number;
  threshold: number;
  deficit: number;
  isCritical: boolean;
}

const ALERT_STORAGE_KEY = 'gt_stock_alert_state_v1';
const POLL_INTERVAL_MS = 20000;

function readPersistedAlertState(): PersistedAlertState {
  try {
    const raw = window.localStorage.getItem(ALERT_STORAGE_KEY);
    if (!raw) {
      return { items: {}, acknowledgedSignature: null, browserNotifiedSignature: null };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedAlertState>;
    return {
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
      acknowledgedSignature: parsed.acknowledgedSignature ?? null,
      browserNotifiedSignature: parsed.browserNotifiedSignature ?? null,
    };
  } catch {
    return { items: {}, acknowledgedSignature: null, browserNotifiedSignature: null };
  }
}

function writePersistedAlertState(state: PersistedAlertState): void {
  try {
    window.localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private mode issues
  }
}

function getCurrentPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return window.Notification.permission;
}

export const StockAlertMonitor: React.FC = () => {
  const initialThreshold = useMemo(() => getStoredThresholdConfig(), []);

  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>(initialThreshold.mode);
  const [fixedThreshold, setFixedThreshold] = useState<number>(initialThreshold.fixedMinimum);
  const [alerts, setAlerts] = useState<LowStockAlertEntry[]>([]);
  const [newlyTriggeredIds, setNewlyTriggeredIds] = useState<number[]>([]);
  const [panelOpen, setPanelOpen] = useState<boolean>(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getCurrentPermission()
  );
  const [signature, setSignature] = useState<string>('');
  const [testNotice, setTestNotice] = useState<string | null>(null);

  const isInventoryPage =
    typeof window !== 'undefined' && window.location.pathname.includes('inventario');

  const isFirstEvaluationRef = useRef<boolean>(true);

  const dispatchNativeBrowserNotification = useCallback(
    (entries: LowStockAlertEntry[], breachedEntries: LowStockAlertEntry[], forceNotify = false) => {
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (window.Notification.permission !== 'granted') return;
      if (entries.length === 0 && !forceNotify) return;

      const focusList = breachedEntries.length > 0 ? breachedEntries : entries;
      let title = 'Alerta de Stock Mínimo — Gestor Tienda';
      let body = 'Todos los artículos cumplen con su umbral mínimo.';

      if (focusList.length === 1) {
        const single = focusList[0];
        title = single.isCritical
          ? `Stock Agotado: ${single.item.descripcion}`
          : `Stock Bajo Umbral: ${single.item.descripcion}`;
        body = `Existencia actual: ${single.stock} u. (Mínimo: ${single.threshold} u. · Faltan ${single.deficit} u.)`;
      } else if (focusList.length > 1) {
        const criticalCount = entries.filter((e) => e.isCritical).length;
        const topNames = focusList
          .slice(0, 2)
          .map((e) => `${e.item.descripcion} (${e.stock}/${e.threshold} u.)`)
          .join(' · ');
        title =
          breachedEntries.length > 0
            ? `${breachedEntries.length} artículos cayeron bajo el umbral`
            : `${entries.length} artículos por debajo del umbral mínimo`;
        body = `${criticalCount > 0 ? `${criticalCount} agotados. ` : ''}${topNames}${
          focusList.length > 2 ? ` (+${focusList.length - 2} más)` : ''
        }`;
      }

      try {
        const notif = new window.Notification(title, {
          body,
          tag: 'gestor-tienda-stock-alert',
          icon: '/assets/logo-placeholder.svg',
          requireInteraction: focusList.some((e) => e.isCritical),
        });
        notif.onclick = () => {
          window.focus();
          window.location.href = '/inventario';
          notif.close();
        };
      } catch {
        // Ignore browser notification instantiation restriction
      }
    },
    []
  );

  const evaluateProducts = useCallback(
    async (modeOverride?: ThresholdMode, fixedOverride?: number) => {
      const activeMode = modeOverride ?? thresholdMode;
      const activeFixed = fixedOverride ?? fixedThreshold;

      try {
        const response = await fetch('/api/productos');
        if (!response.ok) return;
        const data = (await response.json()) as { productos?: InventoryItem[] };
        const products = Array.isArray(data.productos) ? data.productos : [];

        const prevState = readPersistedAlertState();
        const nextSnapshots: Record<string, AlertItemSnapshot> = {};
        const lowList: LowStockAlertEntry[] = [];
        const breachedList: LowStockAlertEntry[] = [];

        for (const item of products) {
          const stock = Number(item.stock_actual);
          const threshold =
            activeMode === 'fixed'
              ? Math.max(0, activeFixed)
              : Math.max(0, Number(item.stock_minimo));
          const isAlert = stock <= 0 || stock < threshold;

          nextSnapshots[String(item.id)] = { stock, threshold, isAlert };

          if (isAlert) {
            const deficit = Math.max(stock <= 0 && threshold === 0 ? 1 : 0, threshold - stock);
            const entry: LowStockAlertEntry = {
              item,
              stock,
              threshold,
              deficit,
              isCritical: stock <= 0,
            };
            lowList.push(entry);

            const prev = prevState.items[String(item.id)];
            const newlyBreached =
              prev !== undefined &&
              ((!prev.isAlert && isAlert) ||
                (prev.isAlert && stock < prev.stock) ||
                (prev.isAlert && threshold > prev.threshold));

            if (newlyBreached) {
              breachedList.push(entry);
            }
          }
        }

        lowList.sort((a, b) => {
          if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1;
          if (a.stock !== b.stock) return a.stock - b.stock;
          return a.item.descripcion.localeCompare(b.item.descripcion, 'es');
        });

        const nextSig =
          lowList.length === 0
            ? ''
            : `${activeMode}:${activeFixed}|` +
              lowList.map((e) => `${e.item.id}:${e.stock}/${e.threshold}`).join(',');

        setAlerts(lowList);
        setSignature(nextSig);
        setPermission(getCurrentPermission());

        if (breachedList.length > 0) {
          setNewlyTriggeredIds(breachedList.map((e) => e.item.id));
        }

        // Trigger native browser notification when new breach occurs OR unnotified alert set changes
        let updatedBrowserSig = prevState.browserNotifiedSignature;
        if (
          lowList.length > 0 &&
          (breachedList.length > 0 || nextSig !== prevState.browserNotifiedSignature)
        ) {
          dispatchNativeBrowserNotification(lowList, breachedList, false);
          updatedBrowserSig = nextSig;
        } else if (lowList.length === 0) {
          updatedBrowserSig = null;
        }

        // Open in-app alert notification automatically:
        // - Always on new breach transitions (even if user is elsewhere or just sold an item in POS)
        // - On non-inventory pages whenever there are unacknowledged low-stock items
        if (lowList.length === 0) {
          setPanelOpen(false);
        } else if (breachedList.length > 0) {
          setPanelOpen(true);
        } else if (!isInventoryPage && nextSig !== prevState.acknowledgedSignature) {
          setPanelOpen(true);
        } else if (isFirstEvaluationRef.current && isInventoryPage) {
          setPanelOpen(false);
        }

        isFirstEvaluationRef.current = false;

        writePersistedAlertState({
          items: nextSnapshots,
          acknowledgedSignature:
            lowList.length === 0 ? null : prevState.acknowledgedSignature,
          browserNotifiedSignature: updatedBrowserSig,
        });
      } catch {
        // Silent retry on next poll interval
      }
    },
    [
      dispatchNativeBrowserNotification,
      fixedThreshold,
      isInventoryPage,
      thresholdMode,
    ]
  );

  useEffect(() => {
    void evaluateProducts();

    const intervalId = window.setInterval(() => {
      void evaluateProducts();
    }, POLL_INTERVAL_MS);

    const handleInventoryUpdated = () => {
      void evaluateProducts();
    };

    const handleThresholdChanged = (event: Event) => {
      const detail = (event as CustomEvent<ThresholdConfig>).detail;
      if (!detail) return;
      setThresholdMode(detail.mode);
      setFixedThreshold(detail.fixedMinimum);
      void evaluateProducts(detail.mode, detail.fixedMinimum);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'nexus_inventory_threshold_v1') {
        const updated = getStoredThresholdConfig();
        setThresholdMode(updated.mode);
        setFixedThreshold(updated.fixedMinimum);
        void evaluateProducts(updated.mode, updated.fixedMinimum);
      }
    };

    const handleWindowFocus = () => {
      setPermission(getCurrentPermission());
      void evaluateProducts();
    };

    const handleTogglePanel = () => {
      setPanelOpen((prev) => !prev);
      void evaluateProducts();
    };

    window.addEventListener('inventory:updated', handleInventoryUpdated);
    window.addEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdChanged);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('stock-alert-monitor:toggle', handleTogglePanel);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('inventory:updated', handleInventoryUpdated);
      window.removeEventListener(THRESHOLD_CHANGED_EVENT, handleThresholdChanged);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('stock-alert-monitor:toggle', handleTogglePanel);
    };
  }, [evaluateProducts]);

  useEffect(() => {
    if (!testNotice) return;
    const t = window.setTimeout(() => setTestNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [testNotice]);

  const handleAcknowledgePanel = () => {
    const prev = readPersistedAlertState();
    writePersistedAlertState({
      ...prev,
      acknowledgedSignature: signature || null,
    });
    setNewlyTriggeredIds([]);
    setPanelOpen(false);
  };

  const handleRequestBrowserNotifications = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }

    try {
      const result = await window.Notification.requestPermission();
      setPermission(result);
      if (result === 'granted') {
        dispatchNativeBrowserNotification(alerts, [], true);
        setTestNotice('Notificaciones del navegador activadas.');
      } else if (result === 'denied') {
        setTestNotice('Permiso denegado en el navegador. Las alertas en pantalla siguen activas.');
      }
    } catch {
      setTestNotice('No se pudo solicitar permiso al navegador en este contexto.');
    }
  };

  if (alerts.length === 0) {
    return null;
  }

  const criticalCount = alerts.filter((a) => a.isCritical).length;
  const visibleEntries = alerts.slice(0, 4);

  return (
    <div
      aria-label="Monitor automático de alertas de stock"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-[80] print:hidden flex flex-col items-end gap-2 max-w-[calc(100vw-2rem)]"
      role="region"
    >
      {panelOpen ? (
        <div
          className="w-[385px] max-w-full bg-white text-[#182034] rounded-2xl shadow-[0_18px_48px_-12px_rgba(15,23,42,0.22)] border border-[#E8EEF7] overflow-hidden"
          id="stock-alert-monitor-popup"
          role="alert"
        >
          {/* Alert Header */}
          <div
            className={`px-4 py-3.5 flex items-center justify-between gap-2 border-b ${
              criticalCount > 0
                ? 'bg-[#FFF5F5] border-[#FECACA]'
                : 'bg-[#FFFDF5] border-[#FDE68A]'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  criticalCount > 0 ? 'bg-[#DC2626] text-white' : 'bg-[#D97706] text-white'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">notifications_active</span>
              </div>
              <div className="min-w-0">
                <div className="font-body-bold text-body-bold text-[#182034] leading-tight truncate tabular-nums">
                  {alerts.length}{' '}
                  {alerts.length === 1 ? 'artículo bajo umbral' : 'artículos bajo umbral'}
                </div>
                <div className="font-label-sm text-[11px] text-[#64748B] tabular-nums">
                  {thresholdMode === 'fixed'
                    ? `Umbral global: ${fixedThreshold} u.`
                    : 'Umbral mínimo individual'}
                  {criticalCount > 0 ? ` · ${criticalCount} agotados` : ''}
                </div>
              </div>
            </div>

            <button
              aria-label="Minimizar alerta de stock"
              className="w-8 h-8 rounded-xl bg-white/80 border border-[#E8EEF7] hover:bg-white text-[#64748B] hover:text-[#182034] flex items-center justify-center transition-colors shrink-0"
              onClick={handleAcknowledgePanel}
              title="Minimizar alerta"
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>

          {/* Items List */}
          <div className="p-3.5 space-y-2 max-h-64 overflow-y-auto">
            {visibleEntries.map((entry) => {
              const isNew = newlyTriggeredIds.includes(entry.item.id);
              return (
                <div
                  className="px-3 py-2.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] flex items-center justify-between gap-3"
                  key={entry.item.id}
                >
                  <div className="min-w-0">
                    <div className="font-label-md text-label-md font-semibold text-[#182034] truncate">
                      {entry.item.descripcion}
                    </div>
                    <div className="font-label-sm text-[11px] text-[#64748B] flex items-center gap-1.5 truncate mt-0.5">
                      <span className="font-code-mono text-[#0E4BFF] font-semibold">
                        {entry.item.sku}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {entry.isCritical ? 'Agotado' : isNew ? 'Recién bajo mínimo' : 'Bajo mínimo'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 font-code-mono tabular-nums">
                    <div
                      className={`text-xs font-bold ${
                        entry.isCritical ? 'text-[#DC2626]' : 'text-[#B45309]'
                      }`}
                    >
                      {entry.stock} / {entry.threshold} u.
                    </div>
                    <div className="text-[11px] text-[#64748B]">
                      Faltan {entry.deficit} u.
                    </div>
                  </div>
                </div>
              );
            })}

            {alerts.length > 4 && (
              <div className="pt-1 text-center font-label-sm text-[11px] text-[#64748B] tabular-nums">
                +{alerts.length - 4} artículos adicionales por debajo del mínimo
              </div>
            )}
          </div>

          {/* Browser Notification Permission Strip */}
          <div className="px-4 py-2.5 bg-[#F8FAFF] border-t border-[#E8EEF7] flex items-center justify-between gap-2 text-[11px]">
            {permission === 'granted' ? (
              <>
                <span className="text-[#059669] font-semibold flex items-center gap-1">
                  <span className="material-symbols-outlined text-[15px]">notifications_on</span>
                  <span>Notificaciones del navegador activas</span>
                </span>
                <button
                  className="text-[#0E4BFF] hover:underline font-semibold whitespace-nowrap shrink-0"
                  onClick={() => {
                    dispatchNativeBrowserNotification(alerts, [], true);
                    setTestNotice('Notificación de navegador enviada.');
                  }}
                  type="button"
                >
                  Probar
                </button>
              </>
            ) : permission === 'default' ? (
              <>
                <span className="text-[#64748B]">Alertas del navegador disponibles</span>
                <button
                  className="px-2.5 py-1 rounded-lg bg-[#0E4BFF] hover:bg-[#0A3FE0] text-white font-semibold whitespace-nowrap shrink-0"
                  id="btn-enable-browser-notifications"
                  onClick={() => void handleRequestBrowserNotifications()}
                  type="button"
                >
                  Activar en navegador
                </button>
              </>
            ) : (
              <span className="text-[#64748B]">
                Monitor automático activo en pantalla ({POLL_INTERVAL_MS / 1000}s)
              </span>
            )}
          </div>

          {testNotice && (
            <div className="px-4 py-2 bg-[#ECFDF5] text-[#065F46] text-[11px] font-semibold border-t border-[#A7F3D0]">
              {testNotice}
            </div>
          )}

          {/* Footer Links */}
          <div className="px-4 py-3 bg-white border-t border-[#E8EEF7] flex items-center justify-between gap-2">
            <button
              className="h-8 px-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] hover:bg-[#EEF3FF] text-[#64748B] hover:text-[#182034] font-label-sm text-label-sm font-semibold transition-colors whitespace-nowrap shrink-0"
              onClick={handleAcknowledgePanel}
              type="button"
            >
              Ocultar
            </button>

            <div className="flex items-center gap-2">
              <a
                className="h-8 px-3.5 rounded-xl bg-[#0E4BFF] hover:bg-[#0A3FE0] text-white font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 shadow-[0_6px_16px_-4px_rgba(14,75,255,0.45)] transition-colors whitespace-nowrap shrink-0"
                href="/inventario"
              >
                <span>Ver Inventario</span>
                <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
              </a>
            </div>
          </div>
        </div>
      ) : (
        <button
          aria-label={`Abrir alertas de stock bajo (${alerts.length})`}
          className={`h-10 px-3.5 rounded-xl shadow-[0_10px_24px_-6px_rgba(15,23,42,0.22)] border font-label-sm text-label-sm font-semibold inline-flex items-center gap-2 transition-all tabular-nums whitespace-nowrap shrink-0 ${
            criticalCount > 0
              ? 'bg-[#DC2626] text-white border-[#DC2626] hover:opacity-95'
              : 'bg-white text-[#182034] border-[#E8EEF7] hover:border-[#0E4BFF]'
          }`}
          id="stock-alert-monitor-trigger"
          onClick={() => setPanelOpen(true)}
          type="button"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              criticalCount > 0 ? 'bg-white animate-pulse' : 'bg-[#F59E0B]'
            }`}
          />
          <span className="material-symbols-outlined text-[17px]">notifications_active</span>
          <span>Stock bajo ({alerts.length})</span>
        </button>
      )}
    </div>
  );
};

export default StockAlertMonitor;
