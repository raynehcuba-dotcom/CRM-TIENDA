import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';

export interface CartLine {
  producto_id: number;
  sku: string;
  descripcion: string;
  precio_unitario: number;
  costo_unitario: number;
  stock_disponible: number;
  cantidad: number;
}

export interface SaleStockDelta {
  producto_id: number;
  sku: string;
  descripcion: string;
  stock_previo: number;
  stock_actual: number;
}

export interface RecordedSaleReceipt {
  folio_ticket: string;
  total_neto: number;
  pago_recibido: number;
  vuelto: number;
  metodo_pago: string;
  fecha: string;
  items: CartLine[];
  updated_stocks: SaleStockDelta[];
}

export interface SalesFormProps {
  onSaleRecorded?: (receipt: RecordedSaleReceipt) => void;
  onShiftDataLoaded?: () => void;
}

type CatalogFilter = 'TODOS' | 'Alimentos' | 'Aseo' | 'Ferretería' | 'DISPONIBLES';
type PaymentMethod = 'EFECTIVO' | 'TRANSFERENCIA' | 'MIXTO';

function formatMoney(value: number): string {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export const SalesForm: React.FC<SalesFormProps> = ({
  onSaleRecorded,
  onShiftDataLoaded,
}) => {
  const [products, setProducts] = useState<InventoryItem[]>([]);
  const [activeTurnoId, setActiveTurnoId] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Catalog search & category filter
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>('TODOS');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Quick dropdown selector inside the form
  const [pickerProductId, setPickerProductId] = useState<string>('');
  const [pickerQty, setPickerQty] = useState<string>('1');

  // Sale ticket state
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountPct, setDiscountPct] = useState<string>('0');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('EFECTIVO');
  const [paymentLabel, setPaymentLabel] = useState<string>('Efectivo CUP');
  const [cashReceived, setCashReceived] = useState<string>('');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<RecordedSaleReceipt | null>(null);

  const fetchCatalogAndShift = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [prodRes, turnoRes] = await Promise.all([
        fetch('/api/productos'),
        fetch('/api/turnos/activo'),
      ]);

      if (!prodRes.ok) {
        throw new Error(`Error HTTP ${prodRes.status} al cargar inventario desde SQLite`);
      }

      const prodData = (await prodRes.json()) as { productos?: InventoryItem[] };
      const loadedProducts = Array.isArray(prodData.productos) ? prodData.productos : [];
      setProducts(loadedProducts);

      if (turnoRes.ok) {
        const turnoData = (await turnoRes.json()) as { turno?: { id: number } | null };
        if (turnoData.turno?.id) {
          setActiveTurnoId(Number(turnoData.turno.id));
        }
      }

      if (onShiftDataLoaded) {
        onShiftDataLoaded();
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'No se pudo cargar el catálogo de ventas');
    } finally {
      setLoading(false);
    }
  }, [onShiftDataLoaded]);

  useEffect(() => {
    void fetchCatalogAndShift();

    const handleExternalInventoryChange = () => {
      void fetchCatalogAndShift();
    };
    window.addEventListener('inventory:updated', handleExternalInventoryChange);
    return () => {
      window.removeEventListener('inventory:updated', handleExternalInventoryChange);
    };
  }, [fetchCatalogAndShift]);

  // F2 keyboard shortcut to focus product search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const availableProducts = useMemo(
    () => products.filter((p) => Number(p.stock_actual) > 0),
    [products]
  );

  // Keep picker defaulting to first available item if unset or exhausted
  useEffect(() => {
    if (availableProducts.length === 0) {
      setPickerProductId('');
      return;
    }
    const stillValid = availableProducts.some((p) => String(p.id) === pickerProductId);
    if (!stillValid) {
      setPickerProductId(String(availableProducts[0].id));
    }
  }, [availableProducts, pickerProductId]);

  const filteredCatalog = useMemo(() => {
    const q = normalizeText(searchQuery.trim());
    return products.filter((p) => {
      if (q) {
        const hay = normalizeText(`${p.descripcion} ${p.sku} ${p.codigo_barras ?? ''}`);
        if (!hay.includes(q)) return false;
      }
      if (catalogFilter === 'DISPONIBLES') {
        return Number(p.stock_actual) > 0;
      }
      if (catalogFilter !== 'TODOS') {
        return normalizeText(p.categoria_nombre ?? '').includes(normalizeText(catalogFilter));
      }
      return true;
    });
  }, [products, searchQuery, catalogFilter]);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((sum, line) => sum + line.cantidad * line.precio_unitario, 0);
    const pct = Math.min(100, Math.max(0, Number(discountPct || 0)));
    const descuento = Number((subtotal * (pct / 100)).toFixed(2));
    const totalNeto = Math.max(0, Number((subtotal - descuento).toFixed(2)));
    const totalUnits = cart.reduce((sum, line) => sum + line.cantidad, 0);
    const receivedVal =
      cashReceived.trim() === '' ? totalNeto : Math.max(0, Number(cashReceived || 0));
    const vuelto = Math.max(0, Number((receivedVal - totalNeto).toFixed(2)));
    const faltante = receivedVal < totalNeto ? Number((totalNeto - receivedVal).toFixed(2)) : 0;

    return {
      subtotal,
      descuento,
      totalNeto,
      totalUnits,
      receivedVal,
      vuelto,
      faltante,
    };
  }, [cart, discountPct, cashReceived]);

  const addProductWithQty = useCallback((product: InventoryItem, qtyToAdd: number) => {
    const available = Number(product.stock_actual);
    if (available <= 0) {
      setFormError(`"${product.descripcion}" está agotado en SQLite.`);
      return;
    }
    if (!Number.isFinite(qtyToAdd) || qtyToAdd <= 0) {
      setFormError('La cantidad a vender debe ser mayor a 0.');
      return;
    }

    setFormError(null);
    setCart((prev) => {
      const existing = prev.find((line) => line.producto_id === product.id);
      if (existing) {
        const nextQty = existing.cantidad + qtyToAdd;
        if (nextQty > available) {
          setFormError(
            `Stock máximo disponible para "${product.descripcion}": ${available} u.`
          );
          return prev;
        }
        return prev.map((line) =>
          line.producto_id === product.id
            ? { ...line, cantidad: nextQty, stock_disponible: available }
            : line
        );
      }

      if (qtyToAdd > available) {
        setFormError(
          `Stock insuficiente para "${product.descripcion}": disponible ${available} u.`
        );
        return prev;
      }

      return [
        ...prev,
        {
          producto_id: product.id,
          sku: product.sku,
          descripcion: product.descripcion,
          precio_unitario: Number(product.precio_venta_cup),
          costo_unitario: Number(product.costo_pmp || product.costo_ultimo || 0),
          stock_disponible: available,
          cantidad: qtyToAdd,
        },
      ];
    });
  }, []);

  const handlePickerAdd = () => {
    const prod = products.find((p) => String(p.id) === pickerProductId);
    if (!prod) {
      setFormError('Selecciona un artículo disponible para agregar a la venta.');
      return;
    }
    addProductWithQty(prod, Number(pickerQty));
    setPickerQty('1');
  };

  const updateLineQty = (productId: number, nextQty: number) => {
    setFormError(null);
    setCart((prev) => {
      if (nextQty <= 0) {
        return prev.filter((line) => line.producto_id !== productId);
      }
      return prev.map((line) => {
        if (line.producto_id !== productId) return line;
        if (nextQty > line.stock_disponible) {
          setFormError(
            `Solo hay ${line.stock_disponible} unidades disponibles de "${line.descripcion}".`
          );
          return line;
        }
        return { ...line, cantidad: nextQty };
      });
    });
  };

  const removeLine = (productId: number) => {
    setFormError(null);
    setCart((prev) => prev.filter((line) => line.producto_id !== productId));
  };

  const resetSaleForm = () => {
    setCart([]);
    setDiscountPct('0');
    setCashReceived('');
    setFormError(null);
  };

  const handleRecordSale = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;

    if (cart.length === 0) {
      setFormError('Selecciona al menos un artículo del inventario para registrar la venta.');
      return;
    }

    if (cashReceived.trim() !== '' && totals.faltante > 0) {
      setFormError(
        `El monto recibido ($${formatMoney(totals.receivedVal)} CUP) es menor al total a cobrar ($${formatMoney(totals.totalNeto)} CUP).`
      );
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const pagoRecibido =
        paymentMethod !== 'EFECTIVO' && cashReceived.trim() === ''
          ? totals.totalNeto
          : totals.receivedVal;

      const response = await fetch('/api/ventas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turno_id: activeTurnoId,
          usuario_id: 1,
          metodo_pago: paymentMethod,
          subtotal: totals.subtotal,
          descuento: totals.descuento,
          total_neto: totals.totalNeto,
          pago_recibido: pagoRecibido,
          items: cart.map((line) => ({
            producto_id: line.producto_id,
            cantidad: line.cantidad,
            precio_unitario: line.precio_unitario,
            costo_unitario: line.costo_unitario,
          })),
        }),
      });

      const data = (await response.json()) as {
        success?: boolean;
        folio_ticket?: string;
        subtotal?: number;
        descuento?: number;
        total_neto?: number;
        pago_recibido?: number;
        vuelto?: number;
        updated_stocks?: SaleStockDelta[];
        error?: string;
      };

      if (!response.ok || !data.success || !data.folio_ticket) {
        throw new Error(data.error || 'No se pudo registrar la venta en SQLite');
      }

      const receipt: RecordedSaleReceipt = {
        folio_ticket: data.folio_ticket,
        total_neto: Number(data.total_neto ?? totals.totalNeto),
        pago_recibido: Number(data.pago_recibido ?? pagoRecibido),
        vuelto: Number(data.vuelto ?? totals.vuelto),
        metodo_pago: paymentLabel,
        fecha: new Date().toLocaleString('es-CU'),
        items: [...cart],
        updated_stocks: Array.isArray(data.updated_stocks) ? data.updated_stocks : [],
      };

      setLastReceipt(receipt);
      resetSaleForm();

      await fetchCatalogAndShift();
      window.dispatchEvent(new CustomEvent('inventory:updated'));

      if (onSaleRecorded) {
        onSaleRecorded(receipt);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Error al procesar la venta en SQLite');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-12 gap-5 items-start">
      {/* Left Column: Inventory Catalog Selection */}
      <section className="col-span-12 lg:col-span-7 flex flex-col gap-4">
        <div className="bg-white px-5 pt-5 pb-0 rounded-2xl border border-[#E8EEF7] shadow-[0_2px_12px_rgba(15,23,42,0.03)] flex flex-col gap-3.5">
          <div className="flex items-center gap-2.5">
            <div className="relative flex-1">
              <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#94A3B8] text-[20px]">
                search
              </span>
              <input
                aria-label="Buscar producto del inventario para vender"
                className="w-full h-10 pl-10 pr-24 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-body-md text-body-md focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25 placeholder:text-[#94A3B8] transition-all"
                id="product-search-input"
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const q = searchQuery.trim().toLowerCase();
                    if (!q) return;
                    const exact = products.find(
                      (p) =>
                        p.sku.toLowerCase() === q ||
                        (p.codigo_barras ?? '').toLowerCase() === q
                    );
                    if (exact) {
                      e.preventDefault();
                      addProductWithQty(exact, 1);
                      setSearchQuery('');
                    }
                  }
                }}
                placeholder="Buscar artículo por nombre, SKU o código (F2)..."
                ref={searchInputRef}
                type="text"
                value={searchQuery}
              />
              {searchQuery ? (
                <button
                  aria-label="Limpiar búsqueda de catálogo"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-lg text-[#64748B] hover:text-[#182034]"
                  onClick={() => setSearchQuery('')}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              ) : (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 font-code-mono text-[11px] bg-white border border-[#E8EEF7] px-2 py-0.5 rounded-lg text-[#64748B] font-semibold pointer-events-none">
                  Atajo F2
                </span>
              )}
            </div>
            <button
              className="h-10 px-4 bg-white border border-[#E8EEF7] hover:bg-[#F8FAFF] text-[#182034] rounded-xl font-label-md text-label-md font-semibold flex items-center gap-1.5 transition-colors shrink-0"
              onClick={() => void fetchCatalogAndShift()}
              title="Sincronizar stock desde SQLite"
              type="button"
            >
              <span className="material-symbols-outlined text-[18px] text-[#64748B]">refresh</span>
              <span className="hidden sm:inline">Sincronizar</span>
            </button>
          </div>

          {/* Underline Category Filter Tabs */}
          <div className="flex items-center gap-6 overflow-x-auto border-t border-[#F1F5FD] pt-1 -mb-px text-label-md font-label-md">
            {(
              [
                { key: 'TODOS', label: `Todos (${products.length})` },
                { key: 'Alimentos', label: 'Alimentos y Bebidas' },
                { key: 'Aseo', label: 'Aseo y Hogar' },
                { key: 'Ferretería', label: 'Ferretería' },
                { key: 'DISPONIBLES', label: `En Stock (${availableProducts.length})` },
              ] as Array<{ key: CatalogFilter; label: string }>
            ).map((tab) => {
              const active = catalogFilter === tab.key;
              return (
                <button
                  className={`py-3 border-b-2 shrink-0 transition-all whitespace-nowrap ${
                    active
                      ? 'border-[#0E4BFF] text-[#182034] font-semibold'
                      : 'border-transparent text-[#94A3B8] hover:text-[#182034] font-medium'
                  }`}
                  key={tab.key}
                  onClick={() => setCatalogFilter(tab.key)}
                  type="button"
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Catalog Grid */}
        {loadError ? (
          <div className="bg-white border border-[#E8EEF7] p-8 rounded-2xl text-center flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-red-600 text-[32px]">error_outline</span>
            <p className="font-body-md text-body-md text-[#182034]">{loadError}</p>
            <button
              className="px-4 h-9 rounded-xl bg-[#0E4BFF] text-white font-label-sm font-semibold"
              onClick={() => void fetchCatalogAndShift()}
              type="button"
            >
              Reintentar
            </button>
          </div>
        ) : loading && products.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                className="h-32 rounded-2xl bg-white border border-[#E8EEF7] animate-pulse"
                key={`pos-skel-${idx}`}
              />
            ))}
          </div>
        ) : filteredCatalog.length === 0 ? (
          <div className="bg-white border border-[#E8EEF7] p-8 rounded-2xl text-center text-[#64748B]">
            No hay artículos que coincidan con el filtro actual.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredCatalog.map((item) => {
              const stock = Number(item.stock_actual);
              const min = Number(item.stock_minimo);
              const price = Number(item.precio_venta_cup);
              const inCart = cart.find((c) => c.producto_id === item.id);
              const isOut = stock <= 0;
              const isLow = !isOut && stock < min;

              if (isOut) {
                return (
                  <div
                    className="bg-white border border-[#E8EEF7] p-3.5 rounded-2xl opacity-60 flex flex-col justify-between cursor-not-allowed select-none text-left"
                    key={item.id}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-code-mono text-[10px] text-[#94A3B8] truncate">
                          {item.sku}
                        </span>
                        <span className="font-label-sm text-[11px] font-bold text-red-600 shrink-0">
                          Agotado
                        </span>
                      </div>
                      <h4 className="font-body-bold text-body-bold text-[#182034] line-clamp-2 mt-1">
                        {item.descripcion}
                      </h4>
                      <span className="font-label-sm text-label-sm text-[#64748B] truncate">
                        {item.categoria_nombre || 'General'}
                      </span>
                    </div>
                    <div className="mt-3 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl p-2 flex items-center justify-between">
                      <span className="font-code-mono tabular-nums text-headline-sm text-[#64748B] font-bold">
                        ${formatMoney(price)}
                      </span>
                      <span className="material-symbols-outlined text-[#CBD5E1] text-[20px]">block</span>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  className={`bg-white p-3.5 rounded-2xl border transition-all flex flex-col justify-between text-left group ${
                    inCart
                      ? 'border-[#0E4BFF] ring-2 ring-[#0E4BFF]/25 shadow-[0_8px_20px_rgba(14,75,255,0.12)]'
                      : 'border-[#E8EEF7] shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:border-[#0E4BFF]/40 hover:shadow-[0_6px_18px_rgba(14,75,255,0.08)]'
                  }`}
                  key={item.id}
                  onClick={() => addProductWithQty(item, 1)}
                  type="button"
                >
                  <div className="flex flex-col gap-1 w-full">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-code-mono text-[10px] text-[#94A3B8] truncate">
                        {item.sku}
                      </span>
                      <span
                        className={`font-code-mono tabular-nums text-[11px] font-bold shrink-0 ${
                          isLow ? 'text-amber-700' : 'text-[#0E4BFF]'
                        }`}
                      >
                        {stock} u.
                      </span>
                    </div>
                    <h4 className="font-body-bold text-body-bold text-[#182034] group-hover:text-[#0E4BFF] transition-colors line-clamp-2 mt-1">
                      {item.descripcion}
                    </h4>
                    <span className="font-label-sm text-label-sm text-[#64748B] truncate">
                      {item.categoria_nombre || 'General'}
                      {inCart ? ` · En ticket: ${inCart.cantidad}` : ''}
                    </span>
                  </div>
                  <div className="mt-3 w-full bg-[#F8FAFF] group-hover:bg-[#EEF3FF] rounded-xl p-2 flex items-center justify-between transition-colors">
                    <span className="font-code-mono tabular-nums text-headline-sm text-[#0E4BFF] font-bold">
                      ${formatMoney(price)}
                    </span>
                    <span className="material-symbols-outlined text-[#0E4BFF] text-[20px]">
                      add_circle
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="bg-[#F8FAFF] border border-[#E8EEF7] p-4 rounded-2xl flex items-center justify-between text-[#64748B] text-label-md">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[#0E4BFF] text-[20px]">storage</span>
            <span>
              Despacho sincronizado con <strong className="text-[#182034]">tienda_data.db</strong> · Cada venta descuenta existencias automáticamente en SQLite.
            </span>
          </div>
          <span className="font-code-mono text-[11px] text-[#182034] font-semibold shrink-0 tabular-nums">
            {products.length} SKUs
          </span>
        </div>
      </section>

      {/* Right Column: Interactive Sales Form */}
      <section className="col-span-12 lg:col-span-5 flex flex-col gap-4">
        <form
          className="bg-white rounded-2xl border border-[#E8EEF7] shadow-[0_4px_20px_rgba(15,23,42,0.04)] p-5 flex flex-col gap-4"
          id="sales-entry-form"
          onSubmit={handleRecordSale}
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-2 border-b border-[#F1F5FD]">
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-semibold">
                Formulario de Venta
              </span>
              <span className="font-headline-sm text-headline-sm text-[#0E4BFF] font-bold font-code-mono tabular-nums">
                {cart.length > 0
                  ? `Orden Activa (${totals.totalUnits} u.)`
                  : lastReceipt
                    ? `Último: ${lastReceipt.folio_ticket}`
                    : 'Nueva Venta SQLite'}
              </span>
            </div>
            <button
              className="px-3 h-8 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] hover:bg-[#F1F5FD] text-[#64748B] hover:text-[#182034] font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors"
              onClick={resetSaleForm}
              title="Limpiar formulario de venta"
              type="button"
            >
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>
              <span>Limpiar</span>
            </button>
          </div>

          {/* Direct Form Item Selector */}
          <div className="p-3.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] flex flex-col gap-2">
            <label
              className="font-label-sm text-label-sm text-[#182034] font-semibold"
              htmlFor="sales-item-select"
            >
              Seleccionar Artículo de Inventario
            </label>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 min-w-0 h-9 px-3 rounded-xl bg-white border border-[#E8EEF7] text-[#182034] font-body-md text-label-md focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                disabled={availableProducts.length === 0}
                id="sales-item-select"
                onChange={(e) => setPickerProductId(e.target.value)}
                value={pickerProductId}
              >
                {availableProducts.length === 0 ? (
                  <option value="">Sin artículos con stock disponible</option>
                ) : (
                  availableProducts.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.descripcion} ({p.stock_actual} u. · ${formatMoney(p.precio_venta_cup)})
                    </option>
                  ))
                )}
              </select>

              <input
                aria-label="Cantidad a agregar"
                className="w-16 h-9 px-2 rounded-xl bg-white border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums text-label-md text-center focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25 shrink-0"
                min={1}
                onChange={(e) => setPickerQty(e.target.value)}
                type="number"
                value={pickerQty}
              />

              <button
                className="h-9 px-3 rounded-xl bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors shrink-0 disabled:opacity-50"
                disabled={availableProducts.length === 0}
                onClick={handlePickerAdd}
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Agregar</span>
              </button>
            </div>
          </div>

          {/* Line Items List */}
          <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto pr-1">
            {cart.length === 0 ? (
              <div className="p-4 bg-[#F8FAFF] border border-dashed border-[#E8EEF7] rounded-xl text-center text-[#64748B] text-label-md">
                Selecciona productos del catálogo o usa el selector superior para armar la venta.
              </div>
            ) : (
              cart.map((line) => (
                <div
                  className="flex items-center justify-between p-2.5 bg-[#F8FAFF] border border-[#E8EEF7] rounded-xl gap-2"
                  key={line.producto_id}
                >
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="font-body-bold text-body-bold text-[#182034] truncate">
                      {line.descripcion}
                    </span>
                    <div className="flex items-center gap-1.5 text-[#64748B] font-code-mono tabular-nums text-[12px]">
                      <span>
                        {line.cantidad} × ${formatMoney(line.precio_unitario)}
                      </span>
                      <span>=</span>
                      <span className="font-semibold text-[#182034]">
                        ${formatMoney(line.cantidad * line.precio_unitario)} CUP
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Disp: {line.stock_disponible}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      aria-label={`Disminuir cantidad de ${line.descripcion}`}
                      className="w-7 h-7 rounded-lg bg-white border border-[#E8EEF7] flex items-center justify-center font-bold text-[#182034] hover:bg-[#EEF3FF]"
                      onClick={() => updateLineQty(line.producto_id, line.cantidad - 1)}
                      type="button"
                    >
                      -
                    </button>
                    <input
                      aria-label={`Cantidad de ${line.descripcion}`}
                      className="w-12 h-7 rounded-lg bg-white border border-[#E8EEF7] text-center font-code-mono tabular-nums text-body-bold text-[#182034] focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                      max={line.stock_disponible}
                      min={1}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (!Number.isNaN(val)) {
                          updateLineQty(line.producto_id, Math.floor(val));
                        }
                      }}
                      type="number"
                      value={line.cantidad}
                    />
                    <button
                      aria-label={`Aumentar cantidad de ${line.descripcion}`}
                      className="w-7 h-7 rounded-lg bg-white border border-[#E8EEF7] flex items-center justify-center font-bold text-[#182034] hover:bg-[#EEF3FF]"
                      onClick={() => updateLineQty(line.producto_id, line.cantidad + 1)}
                      type="button"
                    >
                      +
                    </button>
                    <button
                      aria-label={`Quitar ${line.descripcion}`}
                      className="w-7 h-7 rounded-lg text-red-600 hover:bg-red-50 flex items-center justify-center ml-0.5"
                      onClick={() => removeLine(line.producto_id)}
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Totals */}
          <div className="bg-[#F8FAFF] border border-[#E8EEF7] p-4 rounded-xl flex flex-col gap-2">
            <div className="flex justify-between items-center text-[#64748B] font-body-md text-body-md">
              <span className="tabular-nums">Subtotal ({totals.totalUnits} u.)</span>
              <span className="font-code-mono tabular-nums text-[#182034] font-semibold">
                ${formatMoney(totals.subtotal)} CUP
              </span>
            </div>

            <div className="flex justify-between items-center text-[#64748B] font-body-md text-body-md">
              <label className="flex items-center gap-2" htmlFor="sales-discount-input">
                <span>Descuento (%)</span>
                <input
                  className="w-16 h-7 px-2 rounded-lg bg-white border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums text-[12px] text-right focus:outline-none focus:ring-2 focus:ring-[#0E4BFF]/25"
                  id="sales-discount-input"
                  max={100}
                  min={0}
                  onChange={(e) => setDiscountPct(e.target.value)}
                  type="number"
                  value={discountPct}
                />
              </label>
              <span className="font-code-mono tabular-nums text-[#182034] font-semibold">
                {totals.descuento > 0 ? `-$${formatMoney(totals.descuento)} CUP` : '$0.00 CUP'}
              </span>
            </div>

            <div className="my-1 h-px bg-[#E8EEF7]" />

            <div className="flex justify-between items-end">
              <span className="font-label-sm text-label-sm text-[#64748B] uppercase tracking-wider font-bold">
                Total a Cobrar
              </span>
              <span className="font-display-md text-display-md text-[#0E4BFF] font-bold font-code-mono tabular-nums">
                ${formatMoney(totals.totalNeto)}{' '}
                <span className="text-body-md font-semibold">CUP</span>
              </span>
            </div>
          </div>

          {/* Payment Method */}
          <div className="flex flex-col gap-1.5">
            <span className="font-label-sm text-label-sm text-[#64748B] uppercase font-bold tracking-wider">
              Método de Pago
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {(
                [
                  { method: 'EFECTIVO', label: 'Efectivo CUP', icon: 'payments' },
                  { method: 'TRANSFERENCIA', label: 'Transfermóvil', icon: 'phone_iphone' },
                  { method: 'TRANSFERENCIA', label: 'EnZona QR', icon: 'qr_code_2' },
                  { method: 'MIXTO', label: 'Mixto / USD', icon: 'currency_exchange' },
                ] as Array<{ method: PaymentMethod; label: string; icon: string }>
              ).map((opt) => {
                const active = paymentLabel === opt.label;
                return (
                  <button
                    className={`py-2 px-1 rounded-xl font-label-sm text-label-sm flex flex-col items-center gap-1 border transition-colors ${
                      active
                        ? 'bg-[#0E4BFF] border-[#0E4BFF] text-white font-bold shadow-[0_4px_12px_rgba(14,75,255,0.22)]'
                        : 'bg-[#F8FAFF] border-[#E8EEF7] text-[#182034] hover:bg-[#EEF3FF]'
                    }`}
                    key={opt.label}
                    onClick={() => {
                      setPaymentMethod(opt.method);
                      setPaymentLabel(opt.label);
                      if (opt.method === 'TRANSFERENCIA' && totals.totalNeto > 0) {
                        setCashReceived(totals.totalNeto.toFixed(2));
                      }
                    }}
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[18px]">{opt.icon}</span>
                    <span className="whitespace-nowrap">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Cash Received & Change */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-[#64748B] font-semibold"
                htmlFor="sales-cash-input"
              >
                Monto Recibido (CUP)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 font-code-mono text-[#64748B] font-bold">
                  $
                </span>
                <input
                  className="w-full h-10 pl-7 pr-2.5 rounded-xl bg-[#F8FAFF] border border-[#E8EEF7] text-[#182034] font-code-mono tabular-nums font-bold text-headline-sm focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#0E4BFF]/25"
                  id="sales-cash-input"
                  min={0}
                  onChange={(e) => setCashReceived(e.target.value)}
                  placeholder={totals.totalNeto.toFixed(2)}
                  step="0.01"
                  type="number"
                  value={cashReceived}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="font-label-sm text-label-sm text-[#64748B] font-semibold">
                Cambio a Devolver
              </span>
              <div className="h-10 rounded-xl bg-[#EEF3FF] border border-[#DCE6FF] px-3 flex items-center justify-between">
                <span className="font-label-sm text-label-sm text-[#0E4BFF] font-semibold">
                  Vuelto:
                </span>
                <span
                  className={`font-code-mono tabular-nums text-body-bold font-bold ${
                    totals.faltante > 0 ? 'text-red-600' : 'text-[#0E4BFF]'
                  }`}
                >
                  {totals.faltante > 0
                    ? `-$${formatMoney(totals.faltante)}`
                    : `$${formatMoney(totals.vuelto)} CUP`}
                </span>
              </div>
            </div>
          </div>

          {/* Error Feedback */}
          {formError && (
            <div
              className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 flex items-start gap-2 font-label-sm text-label-sm"
              role="alert"
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">error</span>
              <span>{formError}</span>
            </div>
          )}

          {/* Sale Success Confirmation with Updated SQLite Stocks */}
          {lastReceipt && (
            <div
              className="p-4 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] text-[#065f46] flex flex-col gap-1.5"
              role="status"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-body-bold text-body-bold">
                  <span className="material-symbols-outlined text-[18px]">check_circle</span>
                  <span>Venta {lastReceipt.folio_ticket} registrada</span>
                </div>
                <span className="font-code-mono tabular-nums font-bold">
                  ${formatMoney(lastReceipt.total_neto)} CUP
                </span>
              </div>
              {lastReceipt.updated_stocks.length > 0 && (
                <div className="text-label-sm font-label-sm tabular-nums space-y-0.5 pt-1">
                  <span className="font-semibold block">Stock actualizado en SQLite:</span>
                  {lastReceipt.updated_stocks.map((s) => (
                    <div className="flex items-center justify-between" key={s.producto_id}>
                      <span className="truncate pr-2">{s.descripcion}</span>
                      <span className="font-code-mono shrink-0">
                        {s.stock_previo} → <strong>{s.stock_actual} u.</strong>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Submit */}
          <button
            className="w-full h-12 bg-[#0E4BFF] hover:bg-[#0B3EDB] text-white rounded-xl font-headline-sm text-headline-sm font-semibold flex items-center justify-center gap-2 shadow-[0_8px_20px_rgba(14,75,255,0.28)] transition-all active:scale-[0.99] disabled:opacity-60"
            disabled={submitting || cart.length === 0}
            id="btn-confirm-sale"
            type="submit"
          >
            <span className="material-symbols-outlined text-[22px]">point_of_sale</span>
            <span>
              {submitting ? 'Registrando en SQLite...' : 'Registrar Venta y Descontar Stock'}
            </span>
          </button>
        </form>
      </section>
    </div>
  );
};

export default SalesForm;
