import React, { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface DailySalesPoint {
  date: string;
  day_short: string;
  day_full: string;
  total_ventas: number;
  costo_total: number;
  ganancia_neta: number;
  tickets: number;
  efectivo_cup: number;
  digital_cup: number;
  is_today: boolean;
}

export interface WeeklySalesResponse {
  week_start: string;
  week_end: string;
  today: string;
  days: DailySalesPoint[];
  summary: {
    total_semana: number;
    costo_semana: number;
    ganancia_semana: number;
    tickets_semana: number;
    promedio_diario: number;
    mejor_dia: string | null;
    mejor_dia_monto: number;
  };
}

export interface WeeklySalesChartProps {
  apiEndpoint?: string;
}

type ChartViewMode = 'bar' | 'area';

function formatMoney(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatAxisCup(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `$${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `$${Math.round(value)}`;
}

function formatShortDate(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}`;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: DailySalesPoint }>;
}

const WeeklyTooltip: React.FC<CustomTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;

  return (
    <div className="bg-inverse-surface text-inverse-on-surface rounded-xl px-space-md py-space-sm shadow-xl text-label-sm font-label-sm min-w-[205px]">
      <div className="flex items-center justify-between gap-space-md pb-1.5 mb-1.5 border-b border-white/15">
        <span className="font-body-bold text-body-bold">
          {row.day_full} {row.is_today ? '(Hoy)' : ''}
        </span>
        <span className="font-code-mono text-[11px] opacity-80">
          {formatShortDate(row.date)}
        </span>
      </div>
      <div className="space-y-1 tabular-nums">
        <div className="flex items-center justify-between gap-space-md">
          <span className="flex items-center gap-1.5 opacity-85">
            <span className="w-2 h-2 rounded-full bg-[#3b82f6]" />
            Ventas Totales
          </span>
          <span className="font-code-mono font-bold">${formatMoney(row.total_ventas)} CUP</span>
        </div>
        <div className="flex items-center justify-between gap-space-md">
          <span className="flex items-center gap-1.5 opacity-85">
            <span className="w-2 h-2 rounded-full bg-[#10b981]" />
            Ganancia Neta
          </span>
          <span className="font-code-mono font-semibold text-[#6ee7b7]">
            ${formatMoney(row.ganancia_neta)} CUP
          </span>
        </div>
        <div className="flex items-center justify-between gap-space-md">
          <span className="flex items-center gap-1.5 opacity-85">
            <span className="w-2 h-2 rounded-full bg-[#94a3b8]" />
            Costo Mercancía
          </span>
          <span className="font-code-mono">${formatMoney(row.costo_total)} CUP</span>
        </div>
        <div className="flex items-center justify-between gap-space-md pt-1 mt-1 border-t border-white/15">
          <span className="opacity-85">Operaciones (Tickets)</span>
          <span className="font-code-mono font-bold">{row.tickets}</span>
        </div>
      </div>
    </div>
  );
};

export const WeeklySalesChart: React.FC<WeeklySalesChartProps> = ({
  apiEndpoint = '/api/dashboard/weekly-sales',
}) => {
  const [data, setData] = useState<WeeklySalesResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ChartViewMode>('bar');

  const fetchWeeklySales = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiEndpoint);
      if (!res.ok) {
        throw new Error(`Error HTTP ${res.status} al cargar ventas semanales`);
      }
      const json = (await res.json()) as WeeklySalesResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la serie semanal');
    } finally {
      setLoading(false);
    }
  }, [apiEndpoint]);

  useEffect(() => {
    void fetchWeeklySales();

    const handleRefresh = () => {
      void fetchWeeklySales();
    };
    window.addEventListener('dashboard:refresh', handleRefresh);
    window.addEventListener('inventory:updated', handleRefresh);
    return () => {
      window.removeEventListener('dashboard:refresh', handleRefresh);
      window.removeEventListener('inventory:updated', handleRefresh);
    };
  }, [fetchWeeklySales]);

  const days = data?.days ?? [];
  const summary = data?.summary ?? {
    total_semana: 0,
    costo_semana: 0,
    ganancia_semana: 0,
    tickets_semana: 0,
    promedio_diario: 0,
    mejor_dia: null,
    mejor_dia_monto: 0,
  };
  const hasAnySales = summary.total_semana > 0;

  return (
    <section
      aria-label="Gráfico de rendimiento diario de ventas de la semana actual"
      className="bg-white border border-[#E8EEF7] p-6 rounded-2xl shadow-[0_2px_12px_rgba(15,23,42,0.03)] flex flex-col justify-between gap-space-md h-full"
      id="weekly-sales-recharts-card"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-xl bg-[#EEF3FF] text-[#0E4BFF] inline-flex items-center justify-center">
              <span className="material-symbols-outlined text-[19px]">bar_chart</span>
            </span>
            <h3 className="font-headline-sm text-headline-sm text-[#182034] font-bold">
              Ventas Diarias — Semana Actual
            </h3>
          </div>
          <p className="font-label-sm text-label-sm text-[#64748B] tabular-nums mt-1">
            {data
              ? `Lunes ${formatShortDate(data.week_start)} al Domingo ${formatShortDate(data.week_end)} · Totales en CUP desde SQLite`
              : 'Lunes a Domingo · Totales en CUP desde SQLite'}
          </p>
        </div>

        <div className="flex items-center gap-space-xs self-start sm:self-center">
          <div
            aria-label="Tipo de gráfico"
            className="inline-flex p-1 bg-[#F5F7FD] border border-[#E8EEF7] rounded-xl"
            role="group"
          >
            <button
              className={`px-3 py-1 rounded-lg font-label-sm text-label-sm transition-colors ${
                viewMode === 'bar'
                  ? 'bg-[#0E4BFF] text-white font-semibold shadow-sm'
                  : 'text-[#64748B] hover:text-[#182034]'
              }`}
              onClick={() => setViewMode('bar')}
              type="button"
            >
              Barras
            </button>
            <button
              className={`px-3 py-1 rounded-lg font-label-sm text-label-sm transition-colors ${
                viewMode === 'area'
                  ? 'bg-[#0E4BFF] text-white font-semibold shadow-sm'
                  : 'text-[#64748B] hover:text-[#182034]'
              }`}
              onClick={() => setViewMode('area')}
              type="button"
            >
              Tendencia
            </button>
          </div>

          <button
            aria-label="Actualizar ventas semanales"
            className="h-9 w-9 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] hover:border-[#0E4BFF]/40 text-[#64748B] hover:text-[#0E4BFF] inline-flex items-center justify-center transition-colors"
            onClick={() => void fetchWeeklySales()}
            title="Actualizar gráfico semanal"
            type="button"
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
          </button>
        </div>
      </div>

      {/* Weekly Summary Strip */}
      <div className="grid grid-cols-3 gap-space-sm bg-[#F8FAFF] border border-[#E8EEF7] p-3.5 rounded-xl tabular-nums">
        <div className="flex flex-col">
          <span className="font-label-sm text-[11px] text-[#64748B] uppercase tracking-wider font-semibold">
            Total Semana
          </span>
          <span className="font-code-mono text-body-bold font-bold text-[#182034] mt-0.5">
            ${formatMoney(summary.total_semana)} <span className="text-[11px] font-normal text-[#64748B]">CUP</span>
          </span>
        </div>
        <div className="flex flex-col">
          <span className="font-label-sm text-[11px] text-[#64748B] uppercase tracking-wider font-semibold">
            Ganancia Neta
          </span>
          <span className="font-code-mono text-body-bold font-bold text-[#059669] mt-0.5">
            +${formatMoney(summary.ganancia_semana)} <span className="text-[11px] font-normal">CUP</span>
          </span>
        </div>
        <div className="flex flex-col">
          <span className="font-label-sm text-[11px] text-[#64748B] uppercase tracking-wider font-semibold">
            Mejor Día / Tickets
          </span>
          <span className="font-code-mono text-body-bold font-bold text-[#0E4BFF] truncate mt-0.5">
            {summary.mejor_dia
              ? `${summary.mejor_dia} (${summary.tickets_semana} tkt)`
              : `${summary.tickets_semana} tickets`}
          </span>
        </div>
      </div>

      {/* Recharts Canvas */}
      {error ? (
        <div className="h-[260px] rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] flex flex-col items-center justify-center text-center p-space-lg gap-space-sm">
          <span className="material-symbols-outlined text-error text-[28px]">error_outline</span>
          <p className="font-body-md text-body-md text-[#182034]">{error}</p>
          <button
            className="px-4 h-9 rounded-xl bg-[#0E4BFF] text-white font-label-sm font-semibold"
            onClick={() => void fetchWeeklySales()}
            type="button"
          >
            Reintentar
          </button>
        </div>
      ) : loading && !data ? (
        <div className="h-[260px] rounded-xl bg-[#F8FAFF] animate-pulse flex items-center justify-center text-[#64748B] font-label-md text-label-md">
          Cargando serie semanal de ventas desde SQLite...
        </div>
      ) : (
        <div className="w-full h-[260px]">
          <ResponsiveContainer height="100%" width="100%">
            {viewMode === 'bar' ? (
              <BarChart
                data={days}
                margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke="#EEF3FF" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  axisLine={{ stroke: '#E8EEF7' }}
                  dataKey="day_short"
                  tick={{ fill: '#64748B', fontSize: 12, fontWeight: 600 }}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  tick={{ fill: '#94A3B8', fontSize: 11 }}
                  tickFormatter={formatAxisCup}
                  tickLine={false}
                  width={54}
                />
                <Tooltip content={<WeeklyTooltip />} cursor={{ fill: '#F5F7FD' }} />
                <Bar
                  dataKey="total_ventas"
                  maxBarSize={36}
                  name="Ventas Totales"
                  radius={[8, 8, 0, 0]}
                >
                  {days.map((entry) => (
                    <Cell
                      fill={entry.is_today ? '#0E4BFF' : '#6D95FF'}
                      key={`bar-sales-${entry.date}`}
                    />
                  ))}
                </Bar>
                <Bar
                  dataKey="ganancia_neta"
                  fill="#10B981"
                  maxBarSize={36}
                  name="Ganancia Neta"
                  radius={[8, 8, 0, 0]}
                />
              </BarChart>
            ) : (
              <AreaChart
                data={days}
                margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="weeklySalesAreaGrad" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="5%" stopColor="#0E4BFF" stopOpacity={0.26} />
                    <stop offset="95%" stopColor="#0E4BFF" stopOpacity={0.01} />
                  </linearGradient>
                  <linearGradient id="weeklyProfitAreaGrad" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.24} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#EEF3FF" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  axisLine={{ stroke: '#E8EEF7' }}
                  dataKey="day_short"
                  tick={{ fill: '#64748B', fontSize: 12, fontWeight: 600 }}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  tick={{ fill: '#94A3B8', fontSize: 11 }}
                  tickFormatter={formatAxisCup}
                  tickLine={false}
                  width={54}
                />
                <Tooltip content={<WeeklyTooltip />} />
                <Area
                  activeDot={{ r: 5 }}
                  dataKey="total_ventas"
                  fill="url(#weeklySalesAreaGrad)"
                  name="Ventas Totales"
                  stroke="#0E4BFF"
                  strokeWidth={2.5}
                  type="monotone"
                />
                <Area
                  activeDot={{ r: 4 }}
                  dataKey="ganancia_neta"
                  fill="url(#weeklyProfitAreaGrad)"
                  name="Ganancia Neta"
                  stroke="#10B981"
                  strokeWidth={2}
                  type="monotone"
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      )}

      {/* Legend & Context Footer */}
      <div className="flex flex-wrap items-center justify-between gap-space-sm pt-space-xs border-t border-[#F1F5F9] text-label-sm font-label-sm text-[#64748B]">
        <div className="flex items-center gap-space-md">
          <span className="inline-flex items-center gap-1.5 text-[#182034] font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-[#0E4BFF]" />
            Ventas Diarias (CUP)
          </span>
          <span className="inline-flex items-center gap-1.5 text-[#182034] font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-[#10B981]" />
            Ganancia Neta
          </span>
        </div>
        {hasAnySales ? (
          <span className="font-code-mono text-[#182034] font-semibold tabular-nums">
            Promedio diario: ${formatMoney(summary.promedio_diario)} CUP
          </span>
        ) : (
          <span>
            Sin ventas registradas esta semana ·{' '}
            <a className="text-[#0E4BFF] font-semibold hover:underline" href="/pos">
              Registrar venta en TPV
            </a>
          </span>
        )}
      </div>
    </section>
  );
};

export default WeeklySalesChart;
