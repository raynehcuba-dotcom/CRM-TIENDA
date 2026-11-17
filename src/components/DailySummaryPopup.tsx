import React, { useCallback, useEffect, useState } from 'react';

interface DailyPaymentBreakdown {
  metodo: string;
  tickets: number;
  total_cup: number;
}

interface DailyExpenseBreakdown {
  rubro: string;
  vales: number;
  total_cup: number;
}

export interface DailySummaryData {
  fecha_operativa: string;
  total_ventas_cup: number;
  costo_mercancia_cup: number;
  gastos_operativos_cup: number;
  total_gastos_cup: number;
  ganancia_bruta_cup: number;
  ganancia_neta_cup: number;
  margen_neto_pct: number;
  tickets_count: number;
  vales_count: number;
  descuentos_cup: number;
  desglose_pagos: DailyPaymentBreakdown[];
  desglose_gastos: DailyExpenseBreakdown[];
  comparativa_ayer: {
    fecha: string;
    total_ventas_cup: number;
    total_gastos_cup: number;
    ganancia_neta_cup: number;
  };
  cerrado: boolean;
  cerrado_en: string | null;
  observaciones: string | null;
}

interface DailySummaryConfig {
  hora_cierre_operativo: string;
  auto_resumen_diario: boolean;
}

interface RecentClosedSummary {
  id: number;
  fecha_operativa: string;
  total_ventas_cup: number;
  total_gastos_cup: number;
  ganancia_neta_cup: number;
  margen_neto_pct: number;
  tickets_count: number;
  vales_count: number;
  cerrado_en: string;
}

interface DailySummaryApiResponse {
  summary: DailySummaryData;
  today: string;
  now_hhmm: string;
  config: DailySummaryConfig;
  should_auto_prompt: boolean;
  auto_prompt_reason: 'closing_time' | 'previous_day_unclosed' | null;
  auto_prompt_date: string;
  pending_previous_date: string | null;
  recent_summaries: RecentClosedSummary[];
}

interface OpenEventDetail {
  date?: string;
  reason?: string;
}

const DISMISS_PREFIX = 'gt_daily_summary_dismissed_';

function formatMoney(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateEs(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatMethodLabel(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === 'EFECTIVO') return 'Efectivo en gaveta';
  if (upper === 'TRANSFERMOVIL') return 'Transfermóvil QR';
  if (upper === 'ENZONA') return 'EnZona QR';
  if (upper === 'MIXTO') return 'Pago Mixto';
  if (upper === 'CREDITO') return 'Crédito a Cliente';
  return raw;
}

function isDismissedForDate(ymd: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISS_PREFIX}${ymd}`) === '1';
  } catch {
    return false;
  }
}

function markDismissedForDate(ymd: string): void {
  try {
    window.localStorage.setItem(`${DISMISS_PREFIX}${ymd}`, '1');
  } catch {
    // Ignore storage errors
  }
}

export const DailySummaryPopup: React.FC = () => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedDate, setSelectedDate] = useState<string>('');
  const [summary, setSummary] = useState<DailySummaryData | null>(null);
  const [config, setConfig] = useState<DailySummaryConfig>({
    hora_cierre_operativo: '19:00',
    auto_resumen_diario: true,
  });
  const [recentSummaries, setRecentSummaries] = useState<RecentClosedSummary[]>([]);
  const [triggerBanner, setTriggerBanner] = useState<string | null>(null);

  const [notes, setNotes] = useState<string>('');
  const [closingDay, setClosingDay] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [showScheduleEditor, setShowScheduleEditor] = useState<boolean>(false);
  const [draftHour, setDraftHour] = useState<string>('19:00');
  const [draftAuto, setDraftAuto] = useState<boolean>(true);
  const [savingConfig, setSavingConfig] = useState<boolean>(false);

  const fetchDailySummary = useCallback(
    async (dateParam?: string, options?: { allowAutoOpen?: boolean; customBanner?: string }) => {
      setLoading(true);
      setError(null);
      try {
        const query = dateParam ? `?fecha=${encodeURIComponent(dateParam)}` : '';
        const response = await fetch(`/api/resumen-diario${query}`);
        if (!response.ok) {
          throw new Error(`Error HTTP ${response.status} al calcular resumen diario`);
        }
        const data = (await response.json()) as DailySummaryApiResponse;

        setConfig(data.config);
        setDraftHour(data.config.hora_cierre_operativo);
        setDraftAuto(data.config.auto_resumen_diario);
        setRecentSummaries(Array.isArray(data.recent_summaries) ? data.recent_summaries : []);

        // If auto-prompt targets yesterday's unclosed day while querying today
        if (
          options?.allowAutoOpen &&
          data.should_auto_prompt &&
          !isDismissedForDate(data.auto_prompt_date)
        ) {
          const isPrintableReportPage = window.location.pathname.includes('reporte-stock-bajo');
          if (!isPrintableReportPage) {
            if (data.auto_prompt_date !== data.summary.fecha_operativa) {
              const prevRes = await fetch(
                `/api/resumen-diario?fecha=${encodeURIComponent(data.auto_prompt_date)}`
              );
              if (prevRes.ok) {
                const prevData = (await prevRes.json()) as DailySummaryApiResponse;
                setSummary(prevData.summary);
                setSelectedDate(prevData.summary.fecha_operativa);
                setNotes(prevData.summary.observaciones ?? '');
              } else {
                setSummary(data.summary);
                setSelectedDate(data.summary.fecha_operativa);
                setNotes(data.summary.observaciones ?? '');
              }
            } else {
              setSummary(data.summary);
              setSelectedDate(data.summary.fecha_operativa);
              setNotes(data.summary.observaciones ?? '');
            }

            setTriggerBanner(
              data.auto_prompt_reason === 'previous_day_unclosed'
                ? `Cierre pendiente detectado para la jornada anterior (${data.auto_prompt_date}).`
                : `Fin de jornada operativa (${data.config.hora_cierre_operativo} h): resumen automático calculado.`
            );
            setIsOpen(true);
            return;
          }
        }

        setSummary(data.summary);
        setSelectedDate(data.summary.fecha_operativa);
        setNotes(data.summary.observaciones ?? '');
        if (options?.customBanner) {
          setTriggerBanner(options.customBanner);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar el resumen diario');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void fetchDailySummary(undefined, { allowAutoOpen: true });

    const intervalId = window.setInterval(() => {
      if (!isOpen) {
        void fetchDailySummary(undefined, { allowAutoOpen: true });
      }
    }, 30000);

    const handleOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenEventDetail | undefined>).detail;
      setFeedback(null);
      setIsOpen(true);
      void fetchDailySummary(detail?.date, {
        allowAutoOpen: false,
        customBanner:
          detail?.reason || 'Resumen financiero calculado en tiempo real desde SQLite.',
      });
    };

    window.addEventListener('daily-summary:open', handleOpenEvent);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('daily-summary:open', handleOpenEvent);
    };
  }, [fetchDailySummary, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (summary?.fecha_operativa) {
          markDismissedForDate(summary.fecha_operativa);
        }
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, summary?.fecha_operativa]);

  const handleDismiss = (snoozeForDay: boolean) => {
    if (snoozeForDay && summary?.fecha_operativa) {
      markDismissedForDate(summary.fecha_operativa);
    }
    setIsOpen(false);
  };

  const handleConfirmDayClose = async () => {
    if (!summary || closingDay) return;
    setClosingDay(true);
    setFeedback(null);

    try {
      const response = await fetch('/api/resumen-diario/cerrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fecha: summary.fecha_operativa,
          observaciones: notes.trim() || null,
        }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        summary?: DailySummaryData;
        error?: string;
      };
      if (!response.ok || !data.success || !data.summary) {
        throw new Error(data.error || 'No se pudo guardar el cierre operativo del día');
      }

      setSummary(data.summary);
      markDismissedForDate(data.summary.fecha_operativa);
      setFeedback({
        tone: 'success',
        text: `Cierre operativo de ${data.summary.fecha_operativa} guardado en SQLite.`,
      });
      await fetchDailySummary(data.summary.fecha_operativa, { allowAutoOpen: false });
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Error al confirmar cierre diario',
      });
    } finally {
      setClosingDay(false);
    }
  };

  const handleSaveSchedule = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (savingConfig) return;
    setSavingConfig(true);
    setFeedback(null);

    try {
      const response = await fetch('/api/resumen-diario/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hora_cierre_operativo: draftHour,
          auto_resumen_diario: draftAuto,
        }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        config?: DailySummaryConfig;
        error?: string;
      };
      if (!response.ok || !data.success || !data.config) {
        throw new Error(data.error || 'No se pudo actualizar la hora de cierre');
      }

      setConfig(data.config);
      setShowScheduleEditor(false);
      setFeedback({
        tone: 'success',
        text: `Hora de cierre automático actualizada a las ${data.config.hora_cierre_operativo} h.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Error al guardar configuración',
      });
    } finally {
      setSavingConfig(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const netPositive = (summary?.ganancia_neta_cup ?? 0) >= 0;
  const salesDelta = summary
    ? summary.total_ventas_cup - summary.comparativa_ayer.total_ventas_cup
    : 0;
  const profitDelta = summary
    ? summary.ganancia_neta_cup - summary.comparativa_ayer.ganancia_neta_cup
    : 0;

  return (
    <div
      aria-labelledby="daily-summary-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[100] bg-slate-950/45 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto print:hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleDismiss(true);
        }
      }}
      role="dialog"
    >
      <div className="w-full max-w-4xl bg-white text-[#182034] rounded-2xl shadow-2xl border border-[#E8EEF7] overflow-hidden my-auto max-h-[92vh] flex flex-col">
        {/* Modal Header */}
        <div className="px-6 py-4 bg-[#F8FAFF] border-b border-[#E8EEF7] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
              <span className="font-semibold text-[#0E4BFF]">Cierre de Jornada Operativa</span>
              <span aria-hidden="true">·</span>
              <span className="font-code-mono tabular-nums">
                Hora cierre: {config.hora_cierre_operativo} h
              </span>
              {summary?.cerrado && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-[#059669]">Día cerrado y archivado</span>
                </>
              )}
            </div>
            <h2
              className="font-display-md text-[22px] font-bold text-[#182034] tracking-tight mt-0.5"
              id="daily-summary-dialog-title"
            >
              Resumen Financiero del Día
            </h2>
            {summary && (
              <p className="font-label-sm text-label-sm text-[#64748B] capitalize">
                {formatDateEs(summary.fecha_operativa)}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5 bg-white px-2.5 h-9 rounded-xl border border-[#E8EEF7]">
              <label
                className="font-label-sm text-label-sm text-[#64748B]"
                htmlFor="daily-summary-date-picker"
              >
                Fecha:
              </label>
              <input
                className="bg-transparent font-code-mono text-label-sm text-[#182034] focus:outline-none cursor-pointer"
                id="daily-summary-date-picker"
                onChange={(e) => {
                  const next = e.target.value;
                  if (next) {
                    setSelectedDate(next);
                    void fetchDailySummary(next, { allowAutoOpen: false });
                  }
                }}
                type="date"
                value={selectedDate || summary?.fecha_operativa || ''}
              />
            </div>

            <button
              aria-label="Configurar hora de cierre automático"
              className="h-9 px-3 rounded-xl bg-white hover:bg-[#F5F7FD] border border-[#E8EEF7] text-[#182034] font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              onClick={() => setShowScheduleEditor((prev) => !prev)}
              type="button"
            >
              <span className="material-symbols-outlined text-[17px] text-[#0E4BFF]">schedule</span>
              <span>Horario</span>
            </button>

            <button
              aria-label="Cerrar ventana de resumen diario"
              className="w-9 h-9 rounded-xl bg-white hover:bg-[#F5F7FD] border border-[#E8EEF7] text-[#64748B] hover:text-[#182034] flex items-center justify-center transition-colors shrink-0"
              onClick={() => handleDismiss(true)}
              type="button"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-5 bg-[#FFFFFF]">
          {triggerBanner && (
            <div className="px-4 py-2.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-label-sm text-label-sm flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#0E4BFF] text-[18px]">
                  event_available
                </span>
                <span>{triggerBanner}</span>
              </div>
              <button
                className="text-[#0E4BFF] hover:underline font-semibold whitespace-nowrap shrink-0"
                onClick={() => void fetchDailySummary(selectedDate || undefined, { allowAutoOpen: false })}
                type="button"
              >
                Recalcular
              </button>
            </div>
          )}

          {/* Collapsible Schedule Configurator */}
          {showScheduleEditor && (
            <form
              className="p-4 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] flex flex-wrap items-end justify-between gap-4"
              onSubmit={(e) => void handleSaveSchedule(e)}
            >
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex flex-col gap-1">
                  <label
                    className="font-label-sm text-label-sm font-semibold text-[#182034]"
                    htmlFor="config-closing-hour"
                  >
                    Hora de cierre operativo automático
                  </label>
                  <input
                    className="h-9 px-3 rounded-xl bg-white border border-[#E8EEF7] font-code-mono text-label-md text-[#182034] focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                    id="config-closing-hour"
                    onChange={(e) => setDraftHour(e.target.value)}
                    required
                    type="time"
                    value={draftHour}
                  />
                </div>

                <label className="inline-flex items-center gap-2 font-label-md text-label-md text-[#182034] cursor-pointer pt-4">
                  <input
                    checked={draftAuto}
                    className="rounded accent-[#0E4BFF]"
                    onChange={(e) => setDraftAuto(e.target.checked)}
                    type="checkbox"
                  />
                  <span>Mostrar popup automáticamente al llegar la hora de cierre</span>
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  className="h-9 px-3 rounded-xl bg-white hover:bg-[#F5F7FD] border border-[#E8EEF7] text-[#182034] font-label-sm text-label-sm font-semibold transition-colors"
                  onClick={() => setShowScheduleEditor(false)}
                  type="button"
                >
                  Cancelar
                </button>
                <button
                  className="h-9 px-4 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-label-sm text-label-sm font-semibold disabled:opacity-60 transition-colors"
                  disabled={savingConfig}
                  type="submit"
                >
                  {savingConfig ? 'Guardando...' : 'Guardar Horario'}
                </button>
              </div>
            </form>
          )}

          {feedback && (
            <div
              className={`px-4 py-2.5 rounded-xl border font-label-sm text-label-sm flex items-center gap-2 ${
                feedback.tone === 'success'
                  ? 'bg-[#ecfdf5] border-[#a7f3d0] text-[#065f46]'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}
              role="status"
            >
              <span className="material-symbols-outlined text-[18px]">
                {feedback.tone === 'success' ? 'check_circle' : 'error_outline'}
              </span>
              <span>{feedback.text}</span>
            </div>
          )}

          {error ? (
            <div className="p-5 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-red-700">
                <span className="material-symbols-outlined text-[20px]">error_outline</span>
                <span className="font-body-md text-body-md">{error}</span>
              </div>
              <button
                className="h-9 px-4 rounded-xl bg-red-600 text-white font-label-sm text-label-sm font-semibold whitespace-nowrap shrink-0"
                onClick={() => void fetchDailySummary(selectedDate || undefined, { allowAutoOpen: false })}
                type="button"
              >
                Reintentar
              </button>
            </div>
          ) : loading && !summary ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div
                  className="h-28 rounded-2xl bg-[#F8FAFF] border border-[#E8EEF7] animate-pulse"
                  key={`ds-skel-${idx}`}
                />
              ))}
            </div>
          ) : summary ? (
            <>
              {/* 3 Primary Headline Metrics: Sales, Expenses, Net Profit */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* 1. Total Sales */}
                <div className="p-5 rounded-2xl bg-[#F8FAFF] border border-[#E8EEF7] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                      Ventas Totales
                    </span>
                    <div className="w-8 h-8 rounded-xl bg-[#EEF3FF] text-[#0E4BFF] flex items-center justify-center">
                      <span className="material-symbols-outlined text-[18px]">
                        point_of_sale
                      </span>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <div className="font-display-md text-[26px] font-bold font-code-mono tabular-nums text-[#182034]">
                      ${formatMoney(summary.total_ventas_cup)}{' '}
                      <span className="text-xs font-normal text-[#64748B]">CUP</span>
                    </div>
                    <div className="font-label-sm text-label-sm text-[#64748B] tabular-nums mt-1">
                      {summary.tickets_count}{' '}
                      {summary.tickets_count === 1 ? 'venta completada' : 'ventas completadas'}
                      {summary.descuentos_cup > 0 &&
                        ` · Desc.: $${formatMoney(summary.descuentos_cup)}`}
                    </div>
                  </div>
                </div>

                {/* 2. Total Expenses */}
                <div className="p-5 rounded-2xl bg-[#F8FAFF] border border-[#E8EEF7] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                      Gastos Totales
                    </span>
                    <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
                      <span className="material-symbols-outlined text-[18px]">
                        receipt_long
                      </span>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <div className="font-display-md text-[26px] font-bold font-code-mono tabular-nums text-[#182034]">
                      ${formatMoney(summary.total_gastos_cup)}{' '}
                      <span className="text-xs font-normal text-[#64748B]">CUP</span>
                    </div>
                    <div className="font-label-sm text-label-sm text-[#64748B] tabular-nums mt-1">
                      Costo prod.: ${formatMoney(summary.costo_mercancia_cup)} · Caja chica: $
                      {formatMoney(summary.gastos_operativos_cup)}
                    </div>
                  </div>
                </div>

                {/* 3. Net Profit */}
                <div
                  className={`p-5 rounded-2xl border flex flex-col justify-between ${
                    netPositive
                      ? 'bg-[#ecfdf5] border-[#a7f3d0]'
                      : 'bg-red-50 border-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`font-label-sm text-label-sm uppercase tracking-wider font-semibold ${
                        netPositive ? 'text-[#065f46]' : 'text-red-700'
                      }`}
                    >
                      Ganancia Neta
                    </span>
                    <span
                      className={`material-symbols-outlined text-[20px] ${
                        netPositive ? 'text-[#065f46]' : 'text-red-700'
                      }`}
                    >
                      {netPositive ? 'trending_up' : 'trending_down'}
                    </span>
                  </div>
                  <div className="mt-2.5">
                    <div
                      className={`font-display-md text-[26px] font-bold font-code-mono tabular-nums ${
                        netPositive ? 'text-[#065f46]' : 'text-red-700'
                      }`}
                    >
                      {summary.ganancia_neta_cup >= 0 ? '+' : '-'}$
                      {formatMoney(Math.abs(summary.ganancia_neta_cup))}{' '}
                      <span className="text-xs font-normal">CUP</span>
                    </div>
                    <div
                      className={`font-label-sm text-label-sm tabular-nums mt-1 ${
                        netPositive ? 'text-[#065f46]' : 'text-red-700'
                      }`}
                    >
                      {netPositive ? 'Utilidad neta' : 'Déficit operativo'} · Margen:{' '}
                      {summary.margen_neto_pct.toFixed(1)}%
                    </div>
                  </div>
                </div>
              </div>

              {/* Arithmetic Ledger & Breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Left: Income & Profit Equation */}
                <div className="p-5 rounded-2xl border border-[#E8EEF7] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.02)] flex flex-col gap-3">
                  <h3 className="font-headline-sm text-headline-sm text-[#182034] font-bold">
                    Estado de Resultados del Día
                  </h3>

                  <div className="divide-y divide-[#F1F5FD] font-body-md text-body-md tabular-nums">
                    <div className="py-2 flex items-center justify-between">
                      <span className="text-[#64748B]">(+) Ingresos por Ventas</span>
                      <span className="font-code-mono font-semibold text-[#182034]">
                        ${formatMoney(summary.total_ventas_cup)} CUP
                      </span>
                    </div>
                    <div className="py-2 flex items-center justify-between">
                      <span className="text-[#64748B]">
                        (-) Costo de Mercancía Vendida (PMP)
                      </span>
                      <span className="font-code-mono text-[#182034]">
                        -${formatMoney(summary.costo_mercancia_cup)} CUP
                      </span>
                    </div>
                    <div className="py-2 flex items-center justify-between bg-[#F8FAFF] px-2.5 rounded-lg">
                      <span className="font-semibold text-[#182034]">(=) Ganancia Bruta</span>
                      <span className="font-code-mono font-bold text-[#0E4BFF]">
                        ${formatMoney(summary.ganancia_bruta_cup)} CUP
                      </span>
                    </div>
                    <div className="py-2 flex items-center justify-between">
                      <span className="text-[#64748B]">
                        (-) Gastos Operativos ({summary.vales_count}{' '}
                        {summary.vales_count === 1 ? 'vale' : 'vales'} caja chica)
                      </span>
                      <span className="font-code-mono text-red-600">
                        -${formatMoney(summary.gastos_operativos_cup)} CUP
                      </span>
                    </div>
                    <div className="pt-2.5 flex items-center justify-between">
                      <span className="font-body-bold text-body-bold text-[#182034]">
                        (=) Ganancia Neta Final
                      </span>
                      <span
                        className={`font-code-mono font-bold text-base ${
                          netPositive ? 'text-[#065f46]' : 'text-red-700'
                        }`}
                      >
                        {summary.ganancia_neta_cup >= 0 ? '+' : '-'}$
                        {formatMoney(Math.abs(summary.ganancia_neta_cup))} CUP
                      </span>
                    </div>
                  </div>

                  {/* Comparativa vs Ayer */}
                  {(summary.comparativa_ayer.total_ventas_cup > 0 ||
                    summary.comparativa_ayer.total_gastos_cup > 0) && (
                    <div className="pt-2 border-t border-[#F1F5FD] text-xs text-[#64748B] flex flex-wrap items-center justify-between gap-2 tabular-nums">
                      <span>Vs. día anterior ({summary.comparativa_ayer.fecha}):</span>
                      <span className="font-code-mono">
                        Ventas {salesDelta >= 0 ? '+' : '-'}$
                        {formatMoney(Math.abs(salesDelta))} · Neto{' '}
                        {profitDelta >= 0 ? '+' : '-'}${formatMoney(Math.abs(profitDelta))}
                      </span>
                    </div>
                  )}
                </div>

                {/* Right: Payment Methods & Petty Cash Expense Breakdown */}
                <div className="p-5 rounded-2xl border border-[#E8EEF7] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.02)] flex flex-col gap-4">
                  <div>
                    <h3 className="font-headline-sm text-headline-sm text-[#182034] font-bold mb-2">
                      Desglose de Ventas y Gastos
                    </h3>
                    <div className="text-xs font-semibold uppercase tracking-wider text-[#64748B] mb-1.5">
                      Canales de Cobro
                    </div>
                    {summary.desglose_pagos.length === 0 ? (
                      <p className="font-label-sm text-label-sm text-[#64748B] py-1.5">
                        No se registraron ventas en esta fecha.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {summary.desglose_pagos.map((item) => (
                          <div
                            className="flex items-center justify-between text-sm py-1.5 px-2.5 rounded-lg bg-[#F8FAFF] tabular-nums"
                            key={item.metodo}
                          >
                            <span className="text-[#182034]">
                              {formatMethodLabel(item.metodo)}{' '}
                              <span className="text-xs text-[#64748B]">
                                ({item.tickets})
                              </span>
                            </span>
                            <span className="font-code-mono font-semibold text-[#182034]">
                              ${formatMoney(item.total_cup)} CUP
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-[#64748B] mb-1.5">
                      Gastos de Caja Chica por Rubro
                    </div>
                    {summary.desglose_gastos.length === 0 ? (
                      <p className="font-label-sm text-label-sm text-[#64748B] py-1.5">
                        No se emitieron vales de gastos en esta fecha.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {summary.desglose_gastos.map((exp) => (
                          <div
                            className="flex items-center justify-between text-sm py-1.5 px-2.5 rounded-lg bg-[#F8FAFF] tabular-nums"
                            key={exp.rubro}
                          >
                            <span className="text-[#182034] truncate pr-2">
                              {exp.rubro}{' '}
                              <span className="text-xs text-[#64748B]">
                                ({exp.vales})
                              </span>
                            </span>
                            <span className="font-code-mono font-semibold text-red-600 shrink-0">
                              -${formatMoney(exp.total_cup)} CUP
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Closing Observations & Recent History */}
              <div className="flex flex-col gap-2">
                <label
                  className="font-label-sm text-label-sm font-semibold text-[#182034]"
                  htmlFor="daily-summary-notes"
                >
                  Observaciones del Cierre Operativo (opcional)
                </label>
                <input
                  className="w-full h-10 px-3.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] font-body-md text-body-md text-[#182034] placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 transition-all"
                  id="daily-summary-notes"
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Ej. Cuadre completo sin incidencias, caja lista para apertura de mañana..."
                  type="text"
                  value={notes}
                />
              </div>

              {recentSummaries.length > 0 && (
                <div className="pt-3 border-t border-[#E8EEF7]">
                  <div className="font-label-sm text-label-sm uppercase tracking-wider text-[#64748B] font-semibold mb-2">
                    Últimos Cierres Guardados
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-[#E8EEF7]">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#F8FAFF] text-[#64748B] uppercase">
                          <th className="py-2 px-3 font-semibold">Fecha</th>
                          <th className="py-2 px-3 font-semibold text-right">Ventas</th>
                          <th className="py-2 px-3 font-semibold text-right">Gastos</th>
                          <th className="py-2 px-3 font-semibold text-right">Ganancia Neta</th>
                          <th className="py-2 px-3 font-semibold text-right">Margen</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5FD] tabular-nums">
                        {recentSummaries.slice(0, 4).map((row) => (
                          <tr
                            className="hover:bg-[#F8FAFF] cursor-pointer transition-colors"
                            key={row.id}
                            onClick={() => {
                              setSelectedDate(row.fecha_operativa);
                              void fetchDailySummary(row.fecha_operativa, { allowAutoOpen: false });
                            }}
                          >
                            <td className="py-2 px-3 font-code-mono font-semibold text-[#182034]">
                              {row.fecha_operativa}
                            </td>
                            <td className="py-2 px-3 text-right font-code-mono text-[#182034]">
                              ${formatMoney(row.total_ventas_cup)}
                            </td>
                            <td className="py-2 px-3 text-right font-code-mono text-[#64748B]">
                              ${formatMoney(row.total_gastos_cup)}
                            </td>
                            <td
                              className={`py-2 px-3 text-right font-code-mono font-bold ${
                                row.ganancia_neta_cup >= 0 ? 'text-[#065f46]' : 'text-red-700'
                              }`}
                            >
                              {row.ganancia_neta_cup >= 0 ? '+' : '-'}$
                              {formatMoney(Math.abs(row.ganancia_neta_cup))}
                            </td>
                            <td className="py-2 px-3 text-right font-code-mono text-[#182034]">
                              {Number(row.margen_neto_pct).toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-[#F8FAFF] border-t border-[#E8EEF7] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <button
              className="h-10 px-4 rounded-xl bg-white hover:bg-[#F1F5FD] border border-[#E8EEF7] text-[#182034] font-label-md text-label-md font-semibold transition-colors whitespace-nowrap shrink-0"
              onClick={() => handleDismiss(true)}
              type="button"
            >
              Posponer hoy
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="h-10 px-4 rounded-xl bg-white hover:bg-[#F1F5FD] border border-[#E8EEF7] text-[#182034] font-label-md text-label-md font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              onClick={() =>
                void fetchDailySummary(selectedDate || undefined, { allowAutoOpen: false })
              }
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">refresh</span>
              <span>Actualizar</span>
            </button>

            <button
              className="h-10 px-5 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-body-bold text-body-bold shadow-[0_6px_16px_rgba(14,75,255,0.28)] inline-flex items-center gap-1.5 transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
              disabled={!summary || closingDay}
              id="btn-confirm-daily-close"
              onClick={() => void handleConfirmDayClose()}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">task_alt</span>
              <span>
                {closingDay
                  ? 'Guardando Cierre...'
                  : summary?.cerrado
                    ? 'Actualizar Cierre del Día'
                    : 'Confirmar Cierre del Día'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DailySummaryPopup;
