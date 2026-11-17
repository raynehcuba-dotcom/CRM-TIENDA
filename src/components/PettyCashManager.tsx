import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface PettyCashVoucher {
  id: number;
  folio_vale: string;
  turno_id: number | null;
  autorizado_por: number;
  beneficiario_nombre: string;
  beneficiario_ci: string;
  rubro: string;
  monto_desembolsado_cup: number;
  concepto_justificacion: string;
  compromiso_factura_24h: number;
  factura_entregada: number;
  estado_ciclo: string;
  hash_sha256: string;
  created_at: string;
}

export interface PettyCashReconciliation {
  id: number;
  folio_arqueo: string;
  fondo_fijo_cup: number;
  total_vales_cup: number;
  saldo_esperado_cup: number;
  efectivo_contado_cup: number;
  diferencia_cup: number;
  estado: 'CUADRADO' | 'SOBRANTE' | 'FALTANTE' | string;
  desglose_billetes_json: string | null;
  responsable_nombre: string;
  observaciones: string | null;
  vales_incluidos: number;
  reintegro_aplicado: number;
  hash_sha256: string;
  created_at: string;
}

export interface RubroBreakdown {
  rubro: string;
  total: number;
  porcentaje: number;
}

export interface PettyCashSnapshot {
  fondo_fijo: number;
  tope_vale: number;
  total_desembolsado: number;
  saldo_disponible: number;
  porcentaje_disponible: number;
  vales_activos_count: number;
  pendientes_factura_count: number;
  vales_hoy: number;
  total_hoy: number;
  desglose_rubros: RubroBreakdown[];
  vales: PettyCashVoucher[];
  arqueos: PettyCashReconciliation[];
  ultimo_arqueo: PettyCashReconciliation | null;
}

export interface PettyCashManagerProps {
  onStatusMessage?: (text: string, tone?: 'success' | 'danger') => void;
}

type StatusFilter = 'active' | 'all' | 'reintegrado' | 'pendiente-factura' | 'factura-ok';

const RUBRO_OPTIONS = [
  'Insumos y Embalaje',
  'Servicios Básicos (UNE/ETECSA)',
  'Mantenimiento y Reparación',
  'Transporte y Flete',
  'Alimentación y Estipendio',
  'Gastos Administrativos',
];

const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1] as const;

const RUBRO_COLORS: Record<string, string> = {
  'Insumos y Embalaje': 'bg-blue-600',
  'Servicios Básicos (UNE/ETECSA)': 'bg-purple-600',
  'Mantenimiento y Reparación': 'bg-emerald-600',
  'Transporte y Flete': 'bg-amber-500',
  'Alimentación y Estipendio': 'bg-rose-500',
  'Gastos Administrativos': 'bg-slate-600',
};

const RUBRO_BADGE_CLASSES: Record<string, string> = {
  'Insumos y Embalaje': 'bg-blue-100 text-blue-800',
  'Servicios Básicos (UNE/ETECSA)': 'bg-purple-100 text-purple-800',
  'Mantenimiento y Reparación': 'bg-emerald-100 text-emerald-900',
  'Transporte y Flete': 'bg-amber-100 text-amber-900',
  'Alimentación y Estipendio': 'bg-rose-100 text-rose-800',
  'Gastos Administrativos': 'bg-surface-container-high text-on-surface',
};

function formatCurrency(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateTime(raw: string): string {
  if (!raw) return '—';
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const PettyCashManager: React.FC<PettyCashManagerProps> = ({ onStatusMessage }) => {
  const [snapshot, setSnapshot] = useState<PettyCashSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedRubro, setSelectedRubro] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedVoucherId, setExpandedVoucherId] = useState<number | null>(null);
  const [selectedVoucherId, setSelectedVoucherId] = useState<number | null>(null);
  const [togglingFacturaId, setTogglingFacturaId] = useState<number | null>(null);

  // Expense Form State
  const [montoInput, setMontoInput] = useState<string>('500');
  const [rubroInput, setRubroInput] = useState<string>(RUBRO_OPTIONS[0]);
  const [conceptoInput, setConceptoInput] = useState<string>('');
  const [beneficiarioInput, setBeneficiarioInput] = useState<string>('');
  const [ciInput, setCiInput] = useState<string>('');
  const [compromisoFactura, setCompromisoFactura] = useState<boolean>(true);
  const [facturaEntregadaOnCreate, setFacturaEntregadaOnCreate] = useState<boolean>(false);
  const [avalAdmin, setAvalAdmin] = useState<boolean>(false);
  const [submittingExpense, setSubmittingExpense] = useState<boolean>(false);
  const [expenseError, setExpenseError] = useState<string | null>(null);

  // End-of-Day Reconciliation State
  const [useBillCounter, setUseBillCounter] = useState<boolean>(true);
  const [billCounts, setBillCounts] = useState<Record<number, number>>(() =>
    Object.fromEntries(DENOMINATIONS.map((d) => [d, 0]))
  );
  const [countedCashInput, setCountedCashInput] = useState<string>('');
  const [reconcileResponsible, setReconcileResponsible] = useState<string>('Caja Central');
  const [reconcileNotes, setReconcileNotes] = useState<string>('');
  const [reimburseOnClose, setReimburseOnClose] = useState<boolean>(false);
  const [submittingReconcile, setSubmittingReconcile] = useState<boolean>(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [replenishing, setReplenishing] = useState<boolean>(false);

  const montoInputRef = useRef<HTMLInputElement | null>(null);
  const reconciliationPanelRef = useRef<HTMLDivElement | null>(null);
  const countedCashRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const fetchSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/caja-chica');
      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status} al consultar SQLite`);
      }
      const data = (await response.json()) as PettyCashSnapshot;
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar Caja Chica');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
  }, [fetchSnapshot]);

  const handleExportCsv = useCallback(() => {
    const link = document.createElement('a');
    link.href = '/api/caja-chica/export/csv';
    link.download = `libro_caja_chica_${new Date().toISOString().slice(0, 10)}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    onStatusMessage?.('Libro de Caja Chica exportado en formato CSV.', 'success');
  }, [onStatusMessage]);

  useEffect(() => {
    const onFocusExpense = () => {
      montoInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => montoInputRef.current?.focus(), 180);
    };
    const onFocusReconcile = () => {
      reconciliationPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => countedCashRef.current?.focus(), 200);
    };
    const onExternalExport = () => handleExportCsv();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault();
        onFocusExpense();
      } else if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA' &&
        document.activeElement?.tagName !== 'SELECT'
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('pettycash:focus-expense', onFocusExpense);
    window.addEventListener('pettycash:focus-reconciliation', onFocusReconcile);
    window.addEventListener('pettycash:export-csv', onExternalExport);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('pettycash:focus-expense', onFocusExpense);
      window.removeEventListener('pettycash:focus-reconciliation', onFocusReconcile);
      window.removeEventListener('pettycash:export-csv', onExternalExport);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [handleExportCsv]);

  const fondoFijo = snapshot?.fondo_fijo ?? 25000;
  const topeVale = snapshot?.tope_vale ?? 5000;
  const totalDesembolsado = snapshot?.total_desembolsado ?? 0;
  const saldoDisponible = snapshot?.saldo_disponible ?? 0;
  const porcentajeDisponible = snapshot?.porcentaje_disponible ?? 0;
  const vales = snapshot?.vales ?? [];
  const arqueos = snapshot?.arqueos ?? [];
  const desgloseRubros = snapshot?.desglose_rubros ?? [];

  const billCounterTotal = useMemo(() => {
    return DENOMINATIONS.reduce((sum, denom) => sum + denom * Math.max(0, billCounts[denom] || 0), 0);
  }, [billCounts]);

  const effectiveCountedCash = useMemo(() => {
    if (useBillCounter) return billCounterTotal;
    const parsed = Number(countedCashInput);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }, [useBillCounter, billCounterTotal, countedCashInput]);

  const reconciliationDiff = useMemo(() => {
    return Number((effectiveCountedCash - saldoDisponible).toFixed(2));
  }, [effectiveCountedCash, saldoDisponible]);

  const parsedMonto = useMemo(() => {
    const val = Number(montoInput);
    return Number.isFinite(val) && val > 0 ? val : 0;
  }, [montoInput]);

  const projectedBalance = useMemo(() => {
    return Math.max(0, Number((saldoDisponible - parsedMonto).toFixed(2)));
  }, [saldoDisponible, parsedMonto]);

  const filteredVouchers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return vales.filter((v) => {
      const cycle = v.estado_ciclo || 'ACTIVO';
      if (statusFilter === 'active' && cycle !== 'ACTIVO') return false;
      if (statusFilter === 'reintegrado' && cycle !== 'REINTEGRADO') return false;
      if (statusFilter === 'pendiente-factura' && Number(v.factura_entregada) === 1) return false;
      if (statusFilter === 'factura-ok' && Number(v.factura_entregada) !== 1) return false;
      if (selectedRubro !== 'ALL' && v.rubro !== selectedRubro) return false;

      if (q) {
        const haystack = [
          v.folio_vale,
          v.concepto_justificacion,
          v.beneficiario_nombre,
          v.beneficiario_ci,
          v.rubro,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [vales, statusFilter, selectedRubro, searchQuery]);

  const filteredSubtotal = useMemo(() => {
    return filteredVouchers.reduce((sum, v) => sum + Number(v.monto_desembolsado_cup || 0), 0);
  }, [filteredVouchers]);

  const handleSubmitExpense = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submittingExpense) return;

    const monto = Number(montoInput);
    if (!Number.isFinite(monto) || monto <= 0) {
      setExpenseError('Ingresa un importe válido mayor a 0 CUP.');
      return;
    }
    if (!conceptoInput.trim()) {
      setExpenseError('Describe el concepto y justificación del gasto.');
      return;
    }
    if (!beneficiarioInput.trim()) {
      setExpenseError('Ingresa el nombre del beneficiario.');
      return;
    }
    if (monto > saldoDisponible + 0.001) {
      setExpenseError(`El monto supera el saldo disponible en gaveta ($${formatCurrency(saldoDisponible)} CUP).`);
      return;
    }
    if (monto > topeVale && !avalAdmin) {
      setExpenseError(`Supera el tope de $${formatCurrency(topeVale)} CUP. Marca el aval de administrador.`);
      return;
    }

    setSubmittingExpense(true);
    setExpenseError(null);

    try {
      const response = await fetch('/api/caja-chica/vales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monto_desembolsado_cup: monto,
          rubro: rubroInput,
          concepto_justificacion: conceptoInput.trim(),
          beneficiario_nombre: beneficiarioInput.trim(),
          beneficiario_ci: ciInput.trim(),
          compromiso_factura_24h: compromisoFactura,
          factura_entregada: facturaEntregadaOnCreate,
          aval_admin: avalAdmin,
        }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        folio_vale?: string;
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo registrar el vale de gasto');
      }

      setConceptoInput('');
      setBeneficiarioInput('');
      setCiInput('');
      setFacturaEntregadaOnCreate(false);
      setAvalAdmin(false);
      setStatusFilter('active');

      await fetchSnapshot();
      onStatusMessage?.(
        `Vale ${data.folio_vale ?? ''} registrado por $${formatCurrency(monto)} CUP en SQLite.`,
        'success'
      );
    } catch (err) {
      setExpenseError(err instanceof Error ? err.message : 'Error inesperado al registrar gasto');
    } finally {
      setSubmittingExpense(false);
    }
  };

  const handleToggleFactura = async (vale: PettyCashVoucher) => {
    if (togglingFacturaId === vale.id) return;
    setTogglingFacturaId(vale.id);
    try {
      const nextDelivered = Number(vale.factura_entregada) !== 1;
      const response = await fetch(`/api/caja-chica/vales/${vale.id}/factura`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factura_entregada: nextDelivered }),
      });
      const data = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo actualizar soporte físico');
      }
      await fetchSnapshot();
      onStatusMessage?.(
        nextDelivered
          ? `Factura confirmada para ${vale.folio_vale}.`
          : `Factura marcada como pendiente en ${vale.folio_vale}.`,
        'success'
      );
    } catch (err) {
      onStatusMessage?.(
        err instanceof Error ? err.message : 'Error actualizando soporte físico',
        'danger'
      );
    } finally {
      setTogglingFacturaId(null);
    }
  };

  const handleMatchExpectedCash = () => {
    if (useBillCounter) {
      let remaining = Math.round(saldoDisponible);
      const nextCounts: Record<number, number> = {};
      for (const denom of DENOMINATIONS) {
        const count = Math.floor(remaining / denom);
        nextCounts[denom] = count;
        remaining -= count * denom;
      }
      setBillCounts(nextCounts);
    } else {
      setCountedCashInput(saldoDisponible.toFixed(2));
    }
    setReconcileError(null);
  };

  const handleResetBills = () => {
    setBillCounts(Object.fromEntries(DENOMINATIONS.map((d) => [d, 0])));
    setCountedCashInput('');
    setReconcileError(null);
  };

  const handleSubmitReconciliation = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submittingReconcile) return;

    if (!useBillCounter && countedCashInput.trim() === '') {
      setReconcileError('Ingresa el efectivo físico contado en la gaveta.');
      return;
    }

    setSubmittingReconcile(true);
    setReconcileError(null);

    try {
      const response = await fetch('/api/caja-chica/arqueo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          efectivo_contado_cup: effectiveCountedCash,
          desglose_billetes: useBillCounter ? billCounts : null,
          responsable_nombre: reconcileResponsible.trim() || 'Caja Central',
          observaciones: reconcileNotes.trim() || null,
          cerrar_como_reembolso: reimburseOnClose,
        }),
      });

      const data = (await response.json()) as {
        success?: boolean;
        arqueo?: PettyCashReconciliation;
        error?: string;
      };
      if (!response.ok || !data.success || !data.arqueo) {
        throw new Error(data.error || 'No se pudo registrar el arqueo de caja chica');
      }

      setReconcileNotes('');
      setReimburseOnClose(false);
      handleResetBills();
      await fetchSnapshot();

      const ar = data.arqueo;
      const diffMsg =
        ar.estado === 'CUADRADO'
          ? 'Cuadre exacto ($0.00)'
          : `${ar.estado}: ${ar.diferencia_cup > 0 ? '+' : ''}$${formatCurrency(ar.diferencia_cup)} CUP`;
      onStatusMessage?.(
        `Arqueo ${ar.folio_arqueo} guardado en SQLite (${diffMsg}).`,
        ar.estado === 'FALTANTE' ? 'danger' : 'success'
      );
      window.dispatchEvent(
        new CustomEvent('daily-summary:open', {
          detail: {
            reason: `Arqueo de caja chica (${ar.folio_arqueo}) completado: resumen operativo del día calculado automáticamente.`,
          },
        })
      );
    } catch (err) {
      setReconcileError(err instanceof Error ? err.message : 'Error al registrar arqueo');
    } finally {
      setSubmittingReconcile(false);
    }
  };

  const handleReplenishFund = async () => {
    if (replenishing || totalDesembolsado <= 0) return;
    setReplenishing(true);
    try {
      const response = await fetch('/api/caja-chica/reponer', { method: 'POST' });
      const data = (await response.json()) as {
        success?: boolean;
        reintegrados?: number;
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo reponer el fondo');
      }
      await fetchSnapshot();
      onStatusMessage?.(
        `Fondo fijo restablecido a $${formatCurrency(fondoFijo)} CUP (${data.reintegrados ?? 0} vales liquidados).`,
        'success'
      );
    } catch (err) {
      onStatusMessage?.(
        err instanceof Error ? err.message : 'Error al reponer fondo fijo',
        'danger'
      );
    } finally {
      setReplenishing(false);
    }
  };

  const topRubro = desgloseRubros[0] ?? null;
  const lowBalanceAlert = porcentajeDisponible < 35;

  return (
    <div className="flex flex-col gap-6">
      {/* KPI SUMMARY METRICS ROW */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="p-5 rounded-2xl bg-white border border-[#E8EEF7] flex flex-col justify-between shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                Fondo Fijo Asignado
              </span>
              <span
                className="font-display-md text-display-md text-[#182034] font-code-mono tabular-nums mt-1 font-bold"
                id="kpi-fondo-fijo"
              >
                ${formatCurrency(fondoFijo)}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-[#EEF3FF] flex items-center justify-center text-[#0E4BFF]">
              <span className="material-symbols-outlined text-[20px]">account_balance_wallet</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-[#F1F5FD] flex items-center gap-1.5 text-[#64748B] font-label-sm text-label-sm">
            <span className="material-symbols-outlined text-[14px] text-[#0E4BFF]">verified_user</span>
            <span className="truncate">Tope vale: ${formatCurrency(topeVale)} CUP</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E8EEF7] flex flex-col justify-between shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                  Saldo Disponible
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded-md font-label-sm text-[10px] font-bold tabular-nums ${
                    lowBalanceAlert
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-emerald-100 text-emerald-900'
                  }`}
                >
                  {porcentajeDisponible}%
                </span>
              </div>
              <span
                className={`font-display-md text-display-md font-code-mono tabular-nums mt-1 font-bold ${
                  lowBalanceAlert ? 'text-amber-800' : 'text-[#182034]'
                }`}
                id="kpi-saldo-disponible"
              >
                ${formatCurrency(saldoDisponible)}
              </span>
            </div>
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                lowBalanceAlert
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">payments</span>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            <div className="w-full bg-[#F1F5FD] rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  lowBalanceAlert ? 'bg-amber-600' : 'bg-emerald-600'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, porcentajeDisponible))}%` }}
              />
            </div>
            <div className="flex items-center justify-between font-label-sm text-[11px] font-medium text-[#64748B]">
              <span>{lowBalanceAlert ? 'Umbral alerta (< 35%)' : 'Liquidez saludable'}</span>
              <span className="font-code-mono">CUP</span>
            </div>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E8EEF7] flex flex-col justify-between shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                Egresos en Ciclo
              </span>
              <span
                className="font-display-md text-display-md font-code-mono tabular-nums mt-1 font-bold text-red-600"
                id="kpi-total-egresos"
              >
                ${formatCurrency(totalDesembolsado)}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center text-red-600">
              <span className="material-symbols-outlined text-[20px]">receipt_long</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-[#F1F5FD] flex items-center justify-between text-[#64748B] font-label-sm text-label-sm">
            <span className="font-semibold text-[#182034] tabular-nums">
              {snapshot?.vales_activos_count ?? 0} vales activos
            </span>
            <span className="font-code-mono text-[11px] tabular-nums">
              Hoy: ${formatCurrency(snapshot?.total_hoy ?? 0)}
            </span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E8EEF7] flex flex-col justify-between shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                Último Arqueo EOD
              </span>
              <span className="font-headline-lg text-headline-lg text-[#182034] font-code-mono tabular-nums mt-1 font-bold">
                {snapshot?.ultimo_arqueo
                  ? snapshot.ultimo_arqueo.estado
                  : 'Sin Cierre'}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-[#EEF3FF] flex items-center justify-center text-[#0E4BFF]">
              <span className="material-symbols-outlined text-[20px]">balance</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-[#F1F5FD] flex items-center justify-between text-[#64748B] font-label-sm text-label-sm">
            <span className="truncate font-code-mono text-[11px]">
              {snapshot?.ultimo_arqueo
                ? `${snapshot.ultimo_arqueo.folio_arqueo}`
                : 'Pendiente arqueo hoy'}
            </span>
            <span className="font-semibold text-amber-800 tabular-nums">
              {snapshot?.pendientes_factura_count ?? 0} fact. pend.
            </span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E8EEF7] flex flex-col justify-between shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col min-w-0">
              <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                Rubro Mayor
              </span>
              <span className="font-headline-sm text-headline-sm text-[#182034] mt-1 truncate font-bold">
                {topRubro ? topRubro.rubro : 'Sin egresos'}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] flex items-center justify-center text-[#64748B] shrink-0">
              <span className="material-symbols-outlined text-[20px]">pie_chart</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-[#F1F5FD] flex items-center justify-between text-[#64748B] font-label-sm text-label-sm">
            <span className="font-code-mono text-[#182034] font-bold tabular-nums">
              ${formatCurrency(topRubro?.total ?? 0)} CUP
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[#EEF3FF] font-semibold text-[#0E4BFF] text-[11px] tabular-nums">
              {topRubro ? `${topRubro.porcentaje}%` : '0%'}
            </span>
          </div>
        </div>
      </section>

      {error && (
        <div
          className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 flex items-center justify-between gap-4"
          role="alert"
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px]">error</span>
            <span>{error}</span>
          </div>
          <button
            className="px-4 py-1.5 rounded-xl bg-red-600 text-white font-label-sm text-label-sm font-semibold"
            onClick={() => void fetchSnapshot()}
            type="button"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* MAIN WORKSPACE GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT 8 COLUMNS: LEDGER, CATEGORY BREAKDOWN & RECONCILIATION HISTORY */}
        <div className="lg:col-span-8 flex flex-col gap-5">
          {/* MAIN VOUCHERS LEDGER WITH UNDERLINE TABS & FLOATING ROW CARDS */}
          <section className="bg-white rounded-2xl border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden flex flex-col">
            <div className="px-5 pt-5 pb-0 flex flex-col gap-3 border-b border-[#E8EEF7]">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="relative flex-1 max-w-lg">
                  <span className="material-symbols-outlined absolute left-3.5 top-2.5 text-[18px] text-[#94A3B8]">
                    search
                  </span>
                  <input
                    aria-label="Buscar vales de caja chica"
                    className="w-full pl-10 pr-4 py-2 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-body-md text-body-md text-[#182034] placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 transition-all"
                    id="petty-cash-search"
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Buscar por N° Vale, concepto, beneficiario o CI... (Atajo '/')"
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Filtrar estado de vales"
                    className="px-3 h-10 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-label-md text-label-md font-semibold focus:outline-none cursor-pointer"
                    onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                    value={statusFilter}
                  >
                    <option value="active">Ciclo activo ({snapshot?.vales_activos_count ?? 0})</option>
                    <option value="all">Historial completo ({vales.length})</option>
                    <option value="pendiente-factura">
                      Factura pendiente ({snapshot?.pendientes_factura_count ?? 0})
                    </option>
                    <option value="factura-ok">Factura confirmada</option>
                    <option value="reintegrado">Reintegrados</option>
                  </select>

                  <button
                    className="w-10 h-10 rounded-xl bg-white border border-[#E8EEF7] text-[#64748B] hover:text-[#182034] hover:bg-[#F8FAFF] transition-colors flex items-center justify-center"
                    onClick={handleExportCsv}
                    title="Exportar libro de gastos a CSV"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[18px]">file_download</span>
                  </button>

                  <button
                    className="w-10 h-10 rounded-xl bg-white border border-[#E8EEF7] text-[#64748B] hover:text-[#182034] hover:bg-[#F8FAFF] transition-colors flex items-center justify-center"
                    onClick={() => void fetchSnapshot()}
                    title="Actualizar desde SQLite"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[18px]">refresh</span>
                  </button>
                </div>
              </div>

              {/* UNDERLINE CATEGORY FILTER TABS */}
              <div className="flex items-center gap-6 overflow-x-auto pt-1 -mb-px">
                <button
                  className={`py-3 border-b-2 font-label-sm text-label-sm shrink-0 transition-all flex items-center gap-2 ${
                    selectedRubro === 'ALL'
                      ? 'border-[#0E4BFF] text-[#182034] font-semibold'
                      : 'border-transparent text-[#94A3B8] hover:text-[#182034] font-medium'
                  }`}
                  onClick={() => setSelectedRubro('ALL')}
                  type="button"
                >
                  <span>Todos los Rubros</span>
                  <span
                    className={`px-1.5 py-0.5 rounded-md font-code-mono text-[11px] tabular-nums ${
                      selectedRubro === 'ALL'
                        ? 'bg-[#EEF3FF] text-[#0E4BFF]'
                        : 'bg-[#F8FAFF] text-[#64748B]'
                    }`}
                  >
                    ${formatCurrency(totalDesembolsado)}
                  </span>
                </button>

                {desgloseRubros.map((item) => {
                  const active = selectedRubro === item.rubro;
                  return (
                    <button
                      className={`py-3 border-b-2 font-label-sm text-label-sm shrink-0 transition-all flex items-center gap-2 ${
                        active
                          ? 'border-[#0E4BFF] text-[#182034] font-semibold'
                          : 'border-transparent text-[#94A3B8] hover:text-[#182034] font-medium'
                      }`}
                      key={item.rubro}
                      onClick={() => setSelectedRubro(active ? 'ALL' : item.rubro)}
                      type="button"
                    >
                      <span>{item.rubro}</span>
                      <span
                        className={`font-code-mono text-[11px] tabular-nums ${
                          active ? 'text-[#0E4BFF]' : 'text-[#64748B]'
                        }`}
                      >
                        ${formatCurrency(item.total)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="overflow-x-auto p-4">
              <table className="w-full text-left border-separate border-spacing-y-2" id="petty-cash-ledger-table">
                <thead>
                  <tr className="text-[#64748B] font-label-sm text-[11px] uppercase tracking-wider">
                    <th className="py-2 px-3.5 font-semibold">Folio / Fecha</th>
                    <th className="py-2 px-3.5 font-semibold">Concepto y Justificación</th>
                    <th className="py-2 px-3.5 font-semibold">Rubro</th>
                    <th className="py-2 px-3.5 font-semibold">Beneficiario / CI</th>
                    <th className="py-2 px-3.5 font-semibold">Soporte Físico</th>
                    <th className="py-2 px-3.5 font-semibold text-right">Importe</th>
                    <th className="py-2 px-3.5 font-semibold text-center">Auditoría</th>
                  </tr>
                </thead>
                <tbody className="font-body-md text-body-md text-[#182034]">
                  {loading && !snapshot ? (
                    Array.from({ length: 4 }).map((_, idx) => (
                      <tr className="animate-pulse" key={`cc-skel-${idx}`}>
                        <td className="py-3 px-3.5" colSpan={7}>
                          <div className="h-6 bg-[#F8FAFF] rounded-xl w-full" />
                        </td>
                      </tr>
                    ))
                  ) : filteredVouchers.length === 0 ? (
                    <tr>
                      <td className="py-10 px-6 text-center" colSpan={7}>
                        <div className="flex flex-col items-center gap-1.5 text-[#64748B]">
                          <span className="material-symbols-outlined text-[32px] text-[#CBD5E1]">
                            receipt_long
                          </span>
                          <span className="font-body-bold text-body-bold text-[#182034]">
                            No hay vales que coincidan con los filtros seleccionados
                          </span>
                          <span className="font-label-sm text-label-sm">
                            Registra un nuevo gasto menor o cambia el filtro de ciclo/rubro.
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredVouchers.map((vale) => {
                      const isDelivered = Number(vale.factura_entregada) === 1;
                      const isSettled = (vale.estado_ciclo || 'ACTIVO') === 'REINTEGRADO';
                      const isExpanded = expandedVoucherId === vale.id;
                      const isRowSelected = selectedVoucherId === vale.id;
                      const badgeCls =
                        RUBRO_BADGE_CLASSES[vale.rubro] ||
                        'bg-[#F1F5FD] text-[#182034]';

                      const borderCls = isRowSelected ? 'border-[#0E4BFF]' : 'border-[#E8EEF7]';

                      return (
                        <React.Fragment key={vale.id}>
                          <tr
                            className={`cursor-pointer transition-all ${
                              isRowSelected
                                ? 'bg-[#0E4BFF] text-white shadow-[0_12px_28px_-6px_rgba(14,75,255,0.42)]'
                                : isSettled
                                  ? 'bg-[#F8FAFF] text-[#64748B]'
                                  : 'bg-white hover:bg-[#F8FAFF] text-[#182034]'
                            }`}
                            onClick={() =>
                              setSelectedVoucherId((prev) => (prev === vale.id ? null : vale.id))
                            }
                          >
                            <td className={`py-3 px-3.5 whitespace-nowrap rounded-l-xl border-y border-l ${borderCls}`}>
                              <div className="flex flex-col">
                                <span
                                  className={`font-code-mono text-code-mono font-bold ${
                                    isRowSelected ? 'text-white' : 'text-[#0E4BFF]'
                                  }`}
                                >
                                  {vale.folio_vale}
                                </span>
                                <span
                                  className={`font-label-sm text-[11px] ${
                                    isRowSelected ? 'text-white/75' : 'text-[#64748B]'
                                  }`}
                                >
                                  {formatDateTime(vale.created_at)}
                                </span>
                              </div>
                            </td>

                            <td className={`py-3 px-3.5 min-w-[220px] border-y ${borderCls}`}>
                              <p
                                className={`font-body-md text-body-md leading-tight font-medium ${
                                  isRowSelected ? 'text-white' : 'text-[#182034]'
                                }`}
                              >
                                {vale.concepto_justificacion}
                              </p>
                              <span
                                className={`font-label-sm text-[11px] block mt-0.5 ${
                                  isRowSelected ? 'text-white/75' : 'text-[#64748B]'
                                }`}
                              >
                                {isSettled ? 'Ciclo liquidado / reintegrado' : 'Ciclo operativo activo'}
                              </span>
                            </td>

                            <td className={`py-3 px-3.5 whitespace-nowrap border-y ${borderCls}`}>
                              <span
                                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${
                                  isRowSelected ? 'bg-white/20 text-white' : badgeCls
                                }`}
                              >
                                {vale.rubro}
                              </span>
                            </td>

                            <td className={`py-3 px-3.5 whitespace-nowrap border-y ${borderCls}`}>
                              <div className="flex flex-col">
                                <span
                                  className={`font-body-bold text-[13px] ${
                                    isRowSelected ? 'text-white' : 'text-[#182034]'
                                  }`}
                                >
                                  {vale.beneficiario_nombre}
                                </span>
                                <span
                                  className={`font-code-mono text-[11px] ${
                                    isRowSelected ? 'text-white/75' : 'text-[#64748B]'
                                  }`}
                                >
                                  CI: {vale.beneficiario_ci}
                                </span>
                              </div>
                            </td>

                            <td
                              className={`py-3 px-3.5 whitespace-nowrap border-y ${borderCls}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                                  isRowSelected
                                    ? 'bg-white text-[#0E4BFF]'
                                    : isDelivered
                                      ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                                      : 'bg-amber-100 text-amber-900 hover:bg-amber-200'
                                }`}
                                disabled={togglingFacturaId === vale.id}
                                onClick={() => void handleToggleFactura(vale)}
                                title="Clic para confirmar o revertir entrega de comprobante físico"
                                type="button"
                              >
                                <span className="material-symbols-outlined text-[13px]">
                                  {isDelivered ? 'check_circle' : 'pending_actions'}
                                </span>
                                <span>
                                  {togglingFacturaId === vale.id
                                    ? 'Actualizando...'
                                    : isDelivered
                                      ? 'Factura Recibida'
                                      : 'Pendiente Factura'}
                                </span>
                              </button>
                            </td>

                            <td className={`py-3 px-3.5 text-right whitespace-nowrap border-y ${borderCls}`}>
                              <span
                                className={`font-code-mono tabular-nums text-body-bold font-bold ${
                                  isRowSelected ? 'text-white' : 'text-[#182034]'
                                }`}
                              >
                                ${formatCurrency(vale.monto_desembolsado_cup)}
                              </span>
                              <span
                                className={`block text-[10px] font-code-mono ${
                                  isRowSelected ? 'text-white/75' : 'text-[#64748B]'
                                }`}
                              >
                                CUP
                              </span>
                            </td>

                            <td
                              className={`py-3 px-3.5 text-center whitespace-nowrap rounded-r-xl border-y border-r ${borderCls}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                aria-label={`Ver auditoría SHA-256 de ${vale.folio_vale}`}
                                className={`w-8 h-8 rounded-xl inline-flex items-center justify-center transition-colors ${
                                  isRowSelected
                                    ? 'bg-white/20 text-white hover:bg-white/30'
                                    : isExpanded
                                      ? 'bg-[#0E4BFF] text-white'
                                      : 'bg-[#F8FAFF] border border-[#E8EEF7] text-[#64748B] hover:text-[#0E4BFF]'
                                }`}
                                onClick={() =>
                                  setExpandedVoucherId(isExpanded ? null : vale.id)
                                }
                                title="Ver detalle inmutable y SHA-256"
                                type="button"
                              >
                                <span className="material-symbols-outlined text-[18px]">
                                  {isExpanded ? 'expand_less' : 'visibility'}
                                </span>
                              </button>
                            </td>
                          </tr>

                          {isExpanded && (
                            <tr>
                              <td className="px-4 py-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-label-sm" colSpan={7}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5 font-code-mono text-[11px] text-[#64748B]">
                                    <span className="material-symbols-outlined text-[15px] text-emerald-700">
                                      verified
                                    </span>
                                    <span>SHA-256: {vale.hash_sha256}</span>
                                  </div>
                                  <div className="font-label-sm text-[11px] text-[#64748B]">
                                    Turno #{vale.turno_id ?? 'N/A'} · Compromiso 24h:{' '}
                                    {Number(vale.compromiso_factura_24h) === 1 ? 'Sí' : 'No'}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3.5 bg-[#F8FAFF] border-t border-[#E8EEF7] flex flex-col sm:flex-row items-center justify-between gap-2 font-label-sm text-label-sm text-[#64748B]">
              <div className="flex items-center gap-2 tabular-nums">
                <span>
                  Mostrando <strong className="text-[#182034]">{filteredVouchers.length}</strong>{' '}
                  de <strong className="text-[#182034]">{vales.length}</strong> vales registrados
                </span>
                <span className="text-[#CBD5E1]">|</span>
                <span className="font-code-mono text-[#182034] font-semibold">
                  Subtotal visualizado: ${formatCurrency(filteredSubtotal)} CUP
                </span>
              </div>
              <div className="flex items-center gap-1.5 font-code-mono text-[11px]">
                <span className="material-symbols-outlined text-[14px] text-emerald-600">
                  verified
                </span>
                <span>SQLite: caja_chica_vales · SHA-256</span>
              </div>
            </div>
          </section>

          {/* EXPENSE DISTRIBUTION BAR */}
          <section className="p-5 rounded-2xl bg-white border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] flex flex-col gap-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-[#0E4BFF]">
                  donut_large
                </span>
                <h3 className="font-headline-sm text-headline-sm text-[#182034] font-bold">
                  Composición de Gastos del Ciclo Activo
                </h3>
              </div>
              <span className="font-code-mono text-label-sm text-[#64748B] tabular-nums">
                Total: ${formatCurrency(totalDesembolsado)} CUP
              </span>
            </div>

            {desgloseRubros.length === 0 ? (
              <p className="font-body-md text-body-md text-[#64748B]">
                No existen egresos activos en el ciclo actual de caja chica.
              </p>
            ) : (
              <>
                <div className="w-full h-3 rounded-full bg-[#F1F5FD] overflow-hidden flex">
                  {desgloseRubros.map((r) => (
                    <div
                      className={`${RUBRO_COLORS[r.rubro] || 'bg-[#0E4BFF]'} h-full transition-all`}
                      key={r.rubro}
                      style={{ width: `${Math.max(2, r.porcentaje)}%` }}
                      title={`${r.rubro}: $${formatCurrency(r.total)} CUP (${r.porcentaje}%)`}
                    />
                  ))}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 text-label-sm">
                  {desgloseRubros.map((r) => (
                    <div className="flex items-center gap-2 min-w-0" key={r.rubro}>
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          RUBRO_COLORS[r.rubro] || 'bg-[#0E4BFF]'
                        }`}
                      />
                      <span className="truncate text-[#64748B] font-medium tabular-nums">
                        {r.rubro} ({r.porcentaje}%)
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* END-OF-DAY RECONCILIATIONS HISTORY */}
          <section className="bg-white rounded-2xl border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden">
            <div className="px-6 py-4 bg-[#F8FAFF] border-b border-[#E8EEF7] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-[#0E4BFF]">
                  fact_check
                </span>
                <h3 className="font-headline-sm text-headline-sm text-[#182034] font-bold">
                  Historial de Arqueos y Cierres Diarios
                </h3>
              </div>
              <span className="font-code-mono text-[11px] text-[#64748B] tabular-nums">
                {arqueos.length} registros
              </span>
            </div>

            {arqueos.length === 0 ? (
              <div className="p-6 text-center font-body-md text-body-md text-[#64748B]">
                Aún no se ha registrado ningún arqueo físico de fin de día. Usa el panel derecho para conciliar la gaveta.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse" id="petty-cash-arqueos-table">
                  <thead>
                    <tr className="bg-[#F8FAFF] text-[#64748B] font-label-sm text-[11px] uppercase tracking-wider border-b border-[#E8EEF7]">
                      <th className="py-2.5 px-4 font-semibold">Folio / Fecha</th>
                      <th className="py-2.5 px-4 font-semibold">Responsable</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Esperado</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Contado</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Diferencia</th>
                      <th className="py-2.5 px-4 font-semibold text-center">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5FD] font-body-md text-body-md">
                    {arqueos.map((arq) => {
                      const isOk = arq.estado === 'CUADRADO';
                      const isShort = arq.estado === 'FALTANTE';
                      return (
                        <tr className="hover:bg-[#F8FAFF] transition-colors" key={arq.id}>
                          <td className="py-2.5 px-4 whitespace-nowrap">
                            <span className="font-code-mono font-bold text-[#0E4BFF] block">
                              {arq.folio_arqueo}
                            </span>
                            <span className="font-label-sm text-[11px] text-[#64748B]">
                              {formatDateTime(arq.created_at)}
                            </span>
                          </td>
                          <td className="py-2.5 px-4">
                            <span className="font-medium text-[#182034] block">
                              {arq.responsable_nombre}
                            </span>
                            {arq.observaciones && (
                              <span className="font-label-sm text-[11px] text-[#64748B] block truncate max-w-[220px]">
                                {arq.observaciones}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-4 text-right font-code-mono tabular-nums text-[#182034]">
                            ${formatCurrency(arq.saldo_esperado_cup)}
                          </td>
                          <td className="py-2.5 px-4 text-right font-code-mono tabular-nums font-bold text-[#182034]">
                            ${formatCurrency(arq.efectivo_contado_cup)}
                          </td>
                          <td
                            className={`py-2.5 px-4 text-right font-code-mono tabular-nums font-bold ${
                              isOk ? 'text-emerald-700' : isShort ? 'text-red-600' : 'text-amber-700'
                            }`}
                          >
                            {arq.diferencia_cup > 0 ? '+' : ''}
                            ${formatCurrency(arq.diferencia_cup)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold ${
                                isOk
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : isShort
                                    ? 'bg-red-50 text-red-700'
                                    : 'bg-amber-100 text-amber-900'
                              }`}
                            >
                              {arq.estado}
                            </span>
                            {Number(arq.reintegro_aplicado) === 1 && (
                              <span className="block text-[10px] font-label-sm text-[#0E4BFF] mt-0.5">
                                Reintegrado
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* RIGHT 4 COLUMNS: EXPENSE FORM + END-OF-DAY RECONCILIATION */}
        <div className="lg:col-span-4 flex flex-col gap-5">
          {/* PANEL 1: NEW EXPENSE VOUCHER FORM */}
          <form
            className="rounded-2xl bg-white border border-[#E8EEF7] shadow-[0_4px_20px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col"
            id="petty-cash-expense-form"
            onSubmit={handleSubmitExpense}
          >
            <div className="px-5 py-4 bg-[#F8FAFF] border-b border-[#E8EEF7] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#0E4BFF] text-[20px]">post_add</span>
                <h2 className="font-headline-sm text-headline-sm text-[#182034] font-bold">
                  Registrar Gasto / Vale
                </h2>
              </div>
              <span className="px-2.5 py-0.5 rounded-lg bg-[#0E4BFF] text-white font-code-mono text-[11px] font-bold">
                Nuevo Vale
              </span>
            </div>

            <div className="p-5 flex flex-col gap-4">
              {expenseError && (
                <div
                  className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 font-label-sm text-label-sm flex items-start gap-2"
                  role="alert"
                >
                  <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">
                    error
                  </span>
                  <span>{expenseError}</span>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label
                  className="font-label-sm text-label-sm font-semibold text-[#182034] flex justify-between"
                  htmlFor="input-monto"
                >
                  <span>Monto a Desembolsar (Efectivo)</span>
                  <span className="text-[#64748B] font-code-mono text-[11px]">
                    Máx: ${formatCurrency(topeVale)} CUP
                  </span>
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 font-code-mono font-bold text-[#0E4BFF] text-[15px]">
                    $
                  </span>
                  <input
                    className="w-full pl-8 pr-14 py-2.5 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-code-mono tabular-nums text-headline-sm font-bold text-[#182034] focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 focus:outline-none transition-all"
                    id="input-monto"
                    min="0.01"
                    onChange={(e) => {
                      setMontoInput(e.target.value);
                      if (expenseError) setExpenseError(null);
                    }}
                    placeholder="0.00"
                    ref={montoInputRef}
                    required
                    step="0.01"
                    type="number"
                    value={montoInput}
                  />
                  <span className="absolute right-3.5 top-3 font-code-mono text-label-sm text-[#64748B] font-bold">
                    CUP
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-1.5 mt-1">
                  {[500, 1000, 2000, 5000].map((preset) => (
                    <button
                      className="py-1.5 px-2 rounded-lg bg-[#F8FAFF] border border-[#E8EEF7] hover:bg-[#EEF3FF] hover:border-[#0E4BFF]/30 hover:text-[#0E4BFF] font-code-mono text-[11px] font-semibold text-[#182034] transition-colors text-center"
                      key={preset}
                      onClick={() => {
                        setMontoInput(String(preset));
                        if (expenseError) setExpenseError(null);
                      }}
                      type="button"
                    >
                      +${preset.toLocaleString('en-US')}
                    </button>
                  ))}
                </div>
              </div>

              {parsedMonto > topeVale && (
                <label className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 font-label-sm text-[12px] cursor-pointer">
                  <input
                    checked={avalAdmin}
                    className="mt-0.5 rounded accent-amber-700"
                    onChange={(e) => setAvalAdmin(e.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    Importe superior al tope de ${formatCurrency(topeVale)} CUP. Confirmo autorización de desembolso.
                  </span>
                </label>
              )}

              <div className="flex flex-col gap-1.5">
                <label
                  className="font-label-sm text-label-sm font-semibold text-[#182034]"
                  htmlFor="input-rubro"
                >
                  Rubro / Destino del Gasto
                </label>
                <select
                  className="w-full px-3.5 py-2.5 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-body-md text-body-md text-[#182034] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25"
                  id="input-rubro"
                  onChange={(e) => setRubroInput(e.target.value)}
                  value={rubroInput}
                >
                  {RUBRO_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="font-label-sm text-label-sm font-semibold text-[#182034]"
                  htmlFor="input-concepto"
                >
                  Concepto y Motivo Operativo *
                </label>
                <textarea
                  className="w-full px-3.5 py-2 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-body-md text-body-md text-[#182034] placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 resize-none"
                  id="input-concepto"
                  onChange={(e) => {
                    setConceptoInput(e.target.value);
                    if (expenseError) setExpenseError(null);
                  }}
                  placeholder="Ej: Compra de cinta embalaje, pago mensajería, insumos de limpieza..."
                  required
                  rows={2}
                  value={conceptoInput}
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-1">
                  <label
                    className="font-label-sm text-[11px] font-semibold text-[#182034]"
                    htmlFor="input-beneficiario"
                  >
                    Beneficiario *
                  </label>
                  <input
                    className="w-full px-3 py-2 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-body-md text-body-md text-[#182034] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25"
                    id="input-beneficiario"
                    onChange={(e) => setBeneficiarioInput(e.target.value)}
                    placeholder="Nombre completo"
                    required
                    type="text"
                    value={beneficiarioInput}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    className="font-label-sm text-[11px] font-semibold text-[#182034]"
                    htmlFor="input-ci"
                  >
                    Carnet de Identidad
                  </label>
                  <input
                    className="w-full px-3 py-2 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-code-mono text-body-md text-[#182034] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25"
                    id="input-ci"
                    onChange={(e) => setCiInput(e.target.value)}
                    placeholder="11 dígitos"
                    type="text"
                    value={ciInput}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5 p-3 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl">
                <span className="font-label-sm text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">
                  Soporte Documental
                </span>
                <label className="flex items-center gap-2 font-body-md text-[13px] text-[#182034] cursor-pointer">
                  <input
                    checked={facturaEntregadaOnCreate}
                    className="rounded accent-[#0E4BFF] w-4 h-4"
                    onChange={(e) => setFacturaEntregadaOnCreate(e.target.checked)}
                    type="checkbox"
                  />
                  <span>Ya entregó factura / comprobante físico</span>
                </label>
                {!facturaEntregadaOnCreate && (
                  <label className="flex items-center gap-2 font-body-md text-[13px] text-[#182034] cursor-pointer">
                    <input
                      checked={compromisoFactura}
                      className="rounded accent-[#0E4BFF] w-4 h-4"
                      onChange={(e) => setCompromisoFactura(e.target.checked)}
                      type="checkbox"
                    />
                    <span>Compromiso de entrega en 24 horas</span>
                  </label>
                )}
              </div>

              <div className="p-3 rounded-xl bg-[#EEF3FF] border border-[#DCE6FF] flex items-center justify-between font-label-sm tabular-nums">
                <span className="text-[#64748B]">Saldo proyectado en gaveta:</span>
                <span
                  className={`font-code-mono font-bold text-[14px] ${
                    parsedMonto > saldoDisponible ? 'text-red-600' : 'text-[#0E4BFF]'
                  }`}
                >
                  ${formatCurrency(projectedBalance)} CUP
                </span>
              </div>

              <button
                className="w-full py-3 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-body-bold text-body-bold transition-all flex items-center justify-center gap-2 shadow-[0_6px_18px_rgba(14,75,255,0.25)] disabled:opacity-60"
                disabled={submittingExpense}
                id="btn-submit-petty-expense"
                type="submit"
              >
                <span className="material-symbols-outlined text-[20px]">lock_open</span>
                <span>{submittingExpense ? 'Guardando Vale...' : 'Registrar Vale de Gasto'}</span>
              </button>
            </div>
          </form>

          {/* PANEL 2: END-OF-DAY CASH DRAWER RECONCILIATION */}
          <form
            className="rounded-2xl bg-white shadow-[0_4px_20px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col border border-[#E8EEF7]"
            id="petty-cash-reconciliation-panel"
            onSubmit={handleSubmitReconciliation}
            ref={reconciliationPanelRef as unknown as React.RefObject<HTMLFormElement>}
          >
            <div className="px-5 py-4 bg-[#F8FAFF] border-b border-[#E8EEF7] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#0E4BFF] text-[20px]">balance</span>
                <h3 className="font-headline-sm text-headline-sm text-[#182034] font-bold">
                  Arqueo y Reconciliación EOD
                </h3>
              </div>
              <button
                className="px-2.5 py-1 rounded-lg bg-white hover:bg-[#EEF3FF] text-[#0E4BFF] font-label-sm text-[11px] font-semibold border border-[#E8EEF7] transition-colors"
                onClick={handleMatchExpectedCash}
                type="button"
              >
                Igualar Esperado
              </button>
            </div>

            <div className="p-5 flex flex-col gap-4">
              {/* Expected Balance Breakdown */}
              <div className="flex flex-col divide-y divide-[#E8EEF7] bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl p-3 tabular-nums">
                <div className="py-1.5 flex items-center justify-between font-label-sm text-label-sm">
                  <span className="text-[#64748B]">Fondo fijo autorizado:</span>
                  <span className="font-code-mono font-semibold text-[#182034]">
                    ${formatCurrency(fondoFijo)}
                  </span>
                </div>
                <div className="py-1.5 flex items-center justify-between font-label-sm text-label-sm">
                  <span className="text-[#64748B]">
                    Vales en gaveta ({snapshot?.vales_activos_count ?? 0}):
                  </span>
                  <span className="font-code-mono font-bold text-red-600">
                    -${formatCurrency(totalDesembolsado)}
                  </span>
                </div>
                <div className="py-2 flex items-center justify-between font-body-bold text-body-bold text-[#0E4BFF]">
                  <span>Saldo esperado en efectivo:</span>
                  <span className="font-code-mono font-bold text-[15px]" id="arqueo-saldo-esperado">
                    ${formatCurrency(saldoDisponible)} CUP
                  </span>
                </div>
              </div>

              {/* Counting Mode Switch */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-label-sm text-label-sm font-semibold text-[#182034]">
                  Conteo Físico de Gaveta
                </span>
                <div className="flex items-center p-0.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7]">
                  <button
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                      useBillCounter
                        ? 'bg-[#0E4BFF] text-white shadow-xs'
                        : 'text-[#64748B] hover:text-[#182034]'
                    }`}
                    onClick={() => setUseBillCounter(true)}
                    type="button"
                  >
                    Por Billetes
                  </button>
                  <button
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                      !useBillCounter
                        ? 'bg-[#0E4BFF] text-white shadow-xs'
                        : 'text-[#64748B] hover:text-[#182034]'
                    }`}
                    onClick={() => setUseBillCounter(false)}
                    type="button"
                  >
                    Monto Directo
                  </button>
                </div>
              </div>

              {useBillCounter ? (
                <div className="grid grid-cols-3 gap-1.5 bg-[#F8FAFF] border border-[#E8EEF7] p-2.5 rounded-xl">
                  {DENOMINATIONS.map((denom) => (
                    <label
                      className="flex items-center justify-between gap-1 bg-white px-2 py-1 rounded-lg border border-[#E8EEF7]"
                      key={denom}
                    >
                      <span className="font-code-mono text-[11px] font-semibold text-[#64748B]">
                        ${denom}
                      </span>
                      <input
                        aria-label={`Cantidad de billetes de ${denom} CUP`}
                        className="w-12 text-right font-code-mono text-[12px] font-bold text-[#182034] focus:outline-none"
                        min={0}
                        onChange={(e) => {
                          const qty = Math.max(0, Math.floor(Number(e.target.value) || 0));
                          setBillCounts((prev) => ({ ...prev, [denom]: qty }));
                        }}
                        type="number"
                        value={billCounts[denom] || 0}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 font-code-mono font-bold text-[#0E4BFF] text-[15px]">
                    $
                  </span>
                  <input
                    aria-label="Efectivo físico contado en gaveta"
                    className="w-full pl-8 pr-14 py-2.5 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-code-mono tabular-nums text-headline-sm font-bold text-[#182034] focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 focus:outline-none"
                    id="input-efectivo-contado"
                    min="0"
                    onChange={(e) => {
                      setCountedCashInput(e.target.value);
                      if (reconcileError) setReconcileError(null);
                    }}
                    placeholder="0.00"
                    ref={countedCashRef}
                    step="0.01"
                    type="number"
                    value={countedCashInput}
                  />
                  <span className="absolute right-3.5 top-3 font-code-mono text-label-sm text-[#64748B] font-bold">
                    CUP
                  </span>
                </div>
              )}

              {/* Live Comparison Summary */}
              <div
                className={`p-3 rounded-xl border flex items-center justify-between tabular-nums ${
                  Math.abs(reconciliationDiff) < 0.01
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : reconciliationDiff < 0
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'bg-amber-50 border-amber-300 text-amber-900'
                }`}
              >
                <div className="flex flex-col">
                  <span className="font-label-sm text-[11px] font-semibold uppercase tracking-wide">
                    Contado: ${formatCurrency(effectiveCountedCash)} CUP
                  </span>
                  <span className="font-label-sm text-[12px] font-bold">
                    {Math.abs(reconciliationDiff) < 0.01
                      ? 'Cuadre Exacto (0.00)'
                      : reconciliationDiff < 0
                        ? 'Faltante detectado'
                        : 'Sobrante detectado'}
                  </span>
                </div>
                <span className="font-code-mono font-bold text-[15px]">
                  {reconciliationDiff > 0 ? '+' : ''}${formatCurrency(reconciliationDiff)}
                </span>
              </div>

              {reconcileError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 font-label-sm text-label-sm">
                  {reconcileError}
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label
                  className="font-label-sm text-[11px] font-semibold text-[#182034]"
                  htmlFor="input-reconcile-resp"
                >
                  Responsable del Arqueo
                </label>
                <input
                  className="w-full px-3 py-2 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-body-md text-body-md text-[#182034] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25"
                  id="input-reconcile-resp"
                  onChange={(e) => setReconcileResponsible(e.target.value)}
                  type="text"
                  value={reconcileResponsible}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  className="font-label-sm text-[11px] font-semibold text-[#182034]"
                  htmlFor="input-reconcile-notes"
                >
                  Observaciones de Cierre
                </label>
                <input
                  className="w-full px-3 py-2 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl font-body-md text-body-md text-[#182034] focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25"
                  id="input-reconcile-notes"
                  onChange={(e) => setReconcileNotes(e.target.value)}
                  placeholder="Ej: Arqueo de cierre 18:00 con facturas cuadradas"
                  type="text"
                  value={reconcileNotes}
                />
              </div>

              {totalDesembolsado > 0 && (
                <label className="flex items-center gap-2 p-3 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-label-sm text-[12px] cursor-pointer">
                  <input
                    checked={reimburseOnClose}
                    className="rounded accent-[#0E4BFF] w-4 h-4"
                    onChange={(e) => setReimburseOnClose(e.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    Reintegrar ${formatCurrency(totalDesembolsado)} CUP al cerrar (reiniciar ciclo)
                  </span>
                </label>
              )}

              <button
                className="w-full py-2.5 rounded-xl bg-[#182034] hover:bg-[#0F172A] text-white font-body-bold text-body-bold transition-all flex items-center justify-center gap-2 shadow-sm disabled:opacity-60"
                disabled={submittingReconcile}
                id="btn-submit-arqueo"
                type="submit"
              >
                <span className="material-symbols-outlined text-[18px]">fact_check</span>
                <span>
                  {submittingReconcile ? 'Guardando Arqueo...' : 'Registrar Arqueo de Fin de Día'}
                </span>
              </button>
            </div>
          </form>

          {/* PANEL 3: REPLENISHMENT & POLICY */}
          <section className="rounded-2xl bg-white border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 flex flex-col gap-3 text-label-sm text-[#64748B]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-[#182034]">
                <span className="material-symbols-outlined text-[#0E4BFF] text-[18px]">
                  published_with_changes
                </span>
                <span>Reposición de Fondo Fijo</span>
              </div>
              <span className="font-code-mono text-[11px] text-[#0E4BFF] font-bold">
                ${formatCurrency(totalDesembolsado)} CUP
              </span>
            </div>

            <p className="text-[12px] leading-normal">
              Al aprobar la planilla de reintegro se liquidan los vales activos y se restablece el saldo disponible a{' '}
              <strong className="text-[#182034]">${formatCurrency(fondoFijo)} CUP</strong>.
            </p>

            <button
              className="w-full py-2.5 rounded-xl bg-[#F8FAFF] hover:bg-[#EEF3FF] text-[#182034] hover:text-[#0E4BFF] font-label-md text-label-md font-semibold border border-[#E8EEF7] transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
              disabled={replenishing || totalDesembolsado <= 0}
              id="btn-replenish-petty-cash"
              onClick={() => void handleReplenishFund()}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">sync</span>
              <span>
                {replenishing ? 'Reintegrando...' : 'Liquidar Vales y Reponer Fondo'}
              </span>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
};

export default PettyCashManager;
