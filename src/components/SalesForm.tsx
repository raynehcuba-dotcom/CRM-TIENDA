import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';

export interface ClientOption {
  id: number;
  codigo_cliente: string;
  nombre_completo: string;
}

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
  const [clients, setClients] = useState<ClientOption[]>([]);
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
  const [selectedClientId, setSelectedClientId] = useState<string>('');
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
      const [prodRes, cliRes, turnoRes] = await Promise.all([
        fetch('/api/productos'),
        fetch('/api/clientes'),
        fetch('/api/turnos/activo'),
      ]);

      if (!prodRes.ok) {
        throw new Error(`Error HTTP ${prodRes.status} al cargar inventario desde SQLite`);
      }

      const prodData = (await prodRes.json()) as { productos?: InventoryItem[] };
      const loadedProducts = Array.isArray(prodData.productos) ? prodData.productos : [];
      setProducts(loadedProducts);

      if (cliRes.ok) {
        const cliData = (await cliRes.json()) as { clientes?: ClientOption[] };
        setClients(Array.isArray(cliData.clientes) ? cliData.clientes : []);
      }

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

    if (paymentMethod === 'EFECTIVO' && cashReceived.trim() !== '' && totals.faltante > 0) {
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
          cliente_id: selectedClientId ? Number(selectedClientId) : null,
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
        total_neto?: number;
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
        pago_recibido: pagoRecibido,
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
    <div className="grid grid-cols-12 gap-space-lg items-start">
      {/* Left Column: Inventory Catalog Selection */}
      <section className="col-span-12 lg:col-span-7 flex flex-col gap-space-md">
        <div className="bg-surface-container-lowest p-space-md rounded-xl shadow-sm flex flex-col gap-space-sm">
          <div className="flex items-center gap-space-sm">
            <div className="relative flex-1">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]">
                search
              </span>
              <input
                aria-label="Buscar producto del inventario para vender"
                className="w-full h-10 pl-10 pr-24 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30 placeholder:text-outline"
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-on-surface-variant hover:text-on-surface"
                  onClick={() => setSearchQuery('')}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              ) : (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 font-code-mono text-[11px] bg-surface-container px-2 py-0.5 rounded text-on-surface-variant font-semibold pointer-events-none">
                  Atajo F2
                </span>
              )}
            </div>
            <button
              className="h-10 px-space-md bg-surface-container hover:bg-surface-container-high text-on-surface rounded-lg font-label-md text-label-md flex items-center gap-space-xs transition-colors shrink-0"
              onClick={() => void fetchCatalogAndShift()}
              title="Sincronizar stock desde SQLite"
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">refresh</span>
              <span className="hidden sm:inline">Sincronizar</span>
            </button>
          </div>

          {/* Category Filter Tabs */}
          <div className="flex items-center gap-space-xs overflow-x-auto pb-1 text-label-md font-label-md">
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
                  className={`px-space-md py-1.5 rounded-lg shrink-0 transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-primary-container text-on-primary font-bold shadow-sm'
                      : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
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
          <div className="bg-surface-container-lowest p-space-xl rounded-xl text-center flex flex-col items-center gap-space-sm">
            <span className="material-symbols-outlined text-error text-[32px]">error_outline</span>
            <p className="font-body-md text-body-md text-on-surface">{loadError}</p>
            <button
              className="px-space-md h-9 rounded-lg bg-primary text-on-primary font-label-sm font-semibold"
              onClick={() => void fetchCatalogAndShift()}
              type="button"
            >
              Reintentar
            </button>
          </div>
        ) : loading && products.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-space-sm">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                className="h-32 rounded-xl bg-surface-container-lowest animate-pulse"
                key={`pos-skel-${idx}`}
              />
            ))}
          </div>
        ) : filteredCatalog.length === 0 ? (
          <div className="bg-surface-container-lowest p-space-xl rounded-xl text-center text-on-surface-variant">
            No hay artículos que coincidan con el filtro actual.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-space-sm">
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
                    className="bg-surface-container-lowest p-space-sm rounded-xl shadow-sm opacity-60 flex flex-col justify-between cursor-not-allowed select-none text-left"
                    key={item.id}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-code-mono text-[10px] text-on-surface-variant truncate">
                          {item.sku}
                        </span>
                        <span className="font-label-sm text-[11px] font-bold text-error shrink-0">
                          Agotado
                        </span>
                      </div>
                      <h4 className="font-body-bold text-body-bold text-on-surface line-clamp-2 mt-1">
                        {item.descripcion}
                      </h4>
                      <span className="font-label-sm text-label-sm text-on-surface-variant truncate">
                        {item.categoria_nombre || 'General'}
                      </span>
                    </div>
                    <div className="mt-3 pt-2 bg-surface-container-low rounded-lg p-2 flex items-center justify-between">
                      <span className="font-code-mono tabular-nums text-headline-sm text-on-surface-variant font-bold">
                        ${formatMoney(price)}
                      </span>
                      <span className="material-symbols-outlined text-outline text-[20px]">block</span>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  className={`bg-surface-container-lowest p-space-sm rounded-xl shadow-sm hover:shadow-md transition-all flex flex-col justify-between text-left group ${
                    inCart ? 'ring-2 ring-primary' : ''
                  }`}
                  key={item.id}
                  onClick={() => addProductWithQty(item, 1)}
                  type="button"
                >
                  <div className="flex flex-col gap-1 w-full">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-code-mono text-[10px] text-on-surface-variant truncate">
                        {item.sku}
                      </span>
                      <span
                        className={`font-code-mono tabular-nums text-[11px] font-bold shrink-0 ${
                          isLow ? 'text-amber-800' : 'text-primary'
                        }`}
                      >
                        {stock} u.
                      </span>
                    </div>
                    <h4 className="font-body-bold text-body-bold text-on-surface group-hover:text-primary transition-colors line-clamp-2 mt-1">
                      {item.descripcion}
                    </h4>
                    <span className="font-label-sm text-label-sm text-on-surface-variant truncate">
                      {item.categoria_nombre || 'General'}
                      {inCart ? ` · En ticket: ${inCart.cantidad}` : ''}
                    </span>
                  </div>
                  <div className="mt-3 w-full bg-surface-container-low rounded-lg p-2 flex items-center justify-between">
                    <span className="font-code-mono tabular-nums text-headline-sm text-primary font-bold">
                      ${formatMoney(price)}
                    </span>
                    <span className="material-symbols-outlined text-primary text-[20px]">
                      add_circle
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="bg-surface-container-low p-space-md rounded-xl flex items-center justify-between text-on-surface-variant text-label-md">
          <div className="flex items-center gap-space-sm">
            <span className="material-symbols-outlined text-primary text-[20px]">storage</span>
            <span>
              Despacho sincronizado con <strong>tienda_data.db</strong> · Cada venta descuenta existencias automáticamente en SQLite.
            </span>
          </div>
          <span className="font-code-mono text-[11px] text-on-surface font-semibold shrink-0 tabular-nums">
            {products.length} SKUs
          </span>
        </div>
      </section>

      {/* Right Column: Interactive Sales Form */}
      <section className="col-span-12 lg:col-span-5 flex flex-col gap-space-md">
        <form
          className="bg-surface-container-lowest rounded-xl shadow-md p-space-md flex flex-col gap-space-md"
          id="sales-entry-form"
          onSubmit={handleRecordSale}
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-space-xs">
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider">
                Formulario de Venta
              </span>
              <span className="font-headline-sm text-headline-sm text-primary font-bold font-code-mono tabular-nums">
                {cart.length > 0
                  ? `Orden Activa (${totals.totalUnits} u.)`
                  : lastReceipt
                    ? `Último: ${lastReceipt.folio_ticket}`
                    : 'Nueva Venta SQLite'}
              </span>
            </div>
            <button
              className="px-space-sm h-8 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface-variant font-label-sm text-label-sm inline-flex items-center gap-1 transition-colors"
              onClick={resetSaleForm}
              title="Limpiar formulario de venta"
              type="button"
            >
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>
              <span>Limpiar</span>
            </button>
          </div>

          {/* Direct Form Item Selector */}
          <div className="p-space-sm rounded-lg bg-surface-container-low flex flex-col gap-space-xs">
            <label
              className="font-label-sm text-label-sm text-on-surface font-semibold"
              htmlFor="sales-item-select"
            >
              Seleccionar Artículo de Inventario
            </label>
            <div className="flex items-center gap-space-xs">
              <select
                className="flex-1 min-w-0 h-9 px-space-sm rounded-lg bg-surface-container-lowest text-on-surface font-body-md text-label-md focus:outline-none focus:ring-2 focus:ring-primary/30"
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
                className="w-16 h-9 px-2 rounded-lg bg-surface-container-lowest text-on-surface font-code-mono tabular-nums text-label-md text-center focus:outline-none focus:ring-2 focus:ring-primary/30 shrink-0"
                min={1}
                onChange={(e) => setPickerQty(e.target.value)}
                type="number"
                value={pickerQty}
              />

              <button
                className="h-9 px-space-sm rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors shrink-0 disabled:opacity-50"
                disabled={availableProducts.length === 0}
                onClick={handlePickerAdd}
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Agregar</span>
              </button>
            </div>
          </div>

          {/* Customer Selector */}
          <div className="bg-surface-container-low p-space-sm rounded-lg flex items-center justify-between gap-space-sm">
            <div className="flex items-center gap-space-sm min-w-0">
              <span className="material-symbols-outlined text-on-surface-variant text-[20px]">
                person
              </span>
              <label
                className="font-label-md text-label-md text-on-surface font-semibold truncate"
                htmlFor="sales-client-select"
              >
                Cliente
              </label>
            </div>
            <select
              className="px-space-sm h-8 rounded bg-surface-container-lowest text-on-surface font-label-sm text-label-sm font-semibold focus:outline-none max-w-[200px]"
              id="sales-client-select"
              onChange={(e) => setSelectedClientId(e.target.value)}
              value={selectedClientId}
            >
              <option value="">Cliente General (Mostrador)</option>
              {clients.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.nombre_completo}
                </option>
              ))}
            </select>
          </div>

          {/* Line Items List */}
          <div className="flex flex-col gap-space-xs max-h-[240px] overflow-y-auto pr-1">
            {cart.length === 0 ? (
              <div className="p-space-md bg-surface-container-low rounded-lg text-center text-on-surface-variant text-label-md">
                Selecciona productos del catálogo o usa el selector superior para armar la venta.
              </div>
            ) : (
              cart.map((line) => (
                <div
                  className="flex items-center justify-between p-space-xs bg-surface-container-low rounded-lg gap-space-sm"
                  key={line.producto_id}
                >
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="font-body-bold text-body-bold text-on-surface truncate">
                      {line.descripcion}
                    </span>
                    <div className="flex items-center gap-1.5 text-on-surface-variant font-code-mono tabular-nums text-[12px]">
                      <span>
                        {line.cantidad} × ${formatMoney(line.precio_unitario)}
                      </span>
                      <span>=</span>
                      <span className="font-semibold text-on-surface">
                        ${formatMoney(line.cantidad * line.precio_unitario)} CUP
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Disp: {line.stock_disponible}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      aria-label={`Disminuir cantidad de ${line.descripcion}`}
                      className="w-7 h-7 rounded bg-surface-container flex items-center justify-center font-bold text-on-surface hover:bg-surface-container-high"
                      onClick={() => updateLineQty(line.producto_id, line.cantidad - 1)}
                      type="button"
                    >
                      -
                    </button>
                    <input
                      aria-label={`Cantidad de ${line.descripcion}`}
                      className="w-12 h-7 rounded bg-surface-container-lowest text-center font-code-mono tabular-nums text-body-bold text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
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
                      className="w-7 h-7 rounded bg-surface-container flex items-center justify-center font-bold text-on-surface hover:bg-surface-container-high"
                      onClick={() => updateLineQty(line.producto_id, line.cantidad + 1)}
                      type="button"
                    >
                      +
                    </button>
                    <button
                      aria-label={`Quitar ${line.descripcion}`}
                      className="w-7 h-7 rounded text-error hover:bg-error-container/40 flex items-center justify-center ml-0.5"
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
          <div className="bg-surface-container-low p-space-md rounded-xl flex flex-col gap-space-xs">
            <div className="flex justify-between items-center text-on-surface-variant font-body-md text-body-md">
              <span className="tabular-nums">Subtotal ({totals.totalUnits} u.)</span>
              <span className="font-code-mono tabular-nums text-on-surface font-semibold">
                ${formatMoney(totals.subtotal)} CUP
              </span>
            </div>

            <div className="flex justify-between items-center text-on-surface-variant font-body-md text-body-md">
              <label className="flex items-center gap-2" htmlFor="sales-discount-input">
                <span>Descuento (%)</span>
                <input
                  className="w-16 h-7 px-2 rounded bg-surface-container-lowest text-on-surface font-code-mono tabular-nums text-[12px] text-right focus:outline-none focus:ring-1 focus:ring-primary"
                  id="sales-discount-input"
                  max={100}
                  min={0}
                  onChange={(e) => setDiscountPct(e.target.value)}
                  type="number"
                  value={discountPct}
                />
              </label>
              <span className="font-code-mono tabular-nums text-on-surface font-semibold">
                {totals.descuento > 0 ? `-$${formatMoney(totals.descuento)} CUP` : '$0.00 CUP'}
              </span>
            </div>

            <div className="my-1 h-px bg-surface-variant" />

            <div className="flex justify-between items-end">
              <span className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider font-bold">
                Total a Cobrar
              </span>
              <span className="font-display-md text-display-md text-primary font-bold font-code-mono tabular-nums">
                ${formatMoney(totals.totalNeto)}{' '}
                <span className="text-body-md font-semibold">CUP</span>
              </span>
            </div>
          </div>

          {/* Payment Method */}
          <div className="flex flex-col gap-space-xs">
            <span className="font-label-sm text-label-sm text-on-surface-variant uppercase font-bold tracking-wider">
              Método de Pago
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
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
                    className={`py-2 px-1 rounded-lg font-label-sm text-label-sm flex flex-col items-center gap-1 transition-colors ${
                      active
                        ? 'bg-primary-container text-on-primary font-bold shadow-sm'
                        : 'bg-surface-container-low text-on-surface hover:bg-surface-container'
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
          <div className="grid grid-cols-2 gap-space-sm">
            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface-variant"
                htmlFor="sales-cash-input"
              >
                Monto Recibido (CUP)
              </label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-code-mono text-on-surface-variant font-bold">
                  $
                </span>
                <input
                  className="w-full h-10 pl-6 pr-2 rounded-lg bg-surface-container text-on-surface font-code-mono tabular-nums font-bold text-headline-sm focus:outline-none focus:bg-surface-container-low"
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
              <span className="font-label-sm text-label-sm text-on-surface-variant">
                Cambio a Devolver
              </span>
              <div className="h-10 rounded-lg bg-surface-container-high px-space-sm flex items-center justify-between">
                <span className="font-label-sm text-label-sm text-primary font-semibold">
                  Vuelto:
                </span>
                <span
                  className={`font-code-mono tabular-nums text-body-bold font-bold ${
                    totals.faltante > 0 ? 'text-error' : 'text-primary'
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
              className="p-space-sm rounded-lg bg-error-container text-on-error-container flex items-start gap-space-xs font-label-sm text-label-sm"
              role="alert"
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">error</span>
              <span>{formError}</span>
            </div>
          )}

          {/* Sale Success Confirmation with Updated SQLite Stocks */}
          {lastReceipt && (
            <div
              className="p-space-md rounded-xl bg-[#ecfdf5] text-[#065f46] flex flex-col gap-space-xs"
              role="status"
            >
              <div className="flex items-center justify-between gap-space-sm">
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
            className="w-full h-12 bg-primary-container hover:bg-primary text-on-primary rounded-xl font-headline-sm text-headline-sm flex items-center justify-center gap-space-sm shadow-md transition-all active:scale-[0.99] disabled:opacity-60"
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
