import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';

export interface SupplierRecord {
  id: number;
  codigo_ref: string;
  nombre_comercial: string;
  razon_social?: string | null;
  identificacion_fiscal?: string | null;
  contacto_nombre?: string | null;
  telefono?: string | null;
  direccion?: string | null;
  tipo_proveedor: string;
  saldo_pendiente_efectivo: number;
  saldo_pendiente_transferencia?: number;
  total_pagado_historico?: number;
  unidades_vendidas?: number;
  productos_vinculados?: number;
  activo: number;
}

export interface SupplierManagerProps {
  onSuppliersChanged?: () => void;
  onPaySupplier?: (supplier: SupplierRecord) => void;
}

type SupplierFilter = 'all' | 'linked' | 'unlinked' | 'debt';

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

export const SupplierManager: React.FC<SupplierManagerProps> = ({
  onSuppliersChanged,
  onPaySupplier,
}) => {
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [products, setProducts] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [supplierFilter, setSupplierFilter] = useState<SupplierFilter>('all');
  const [selectedSupplierId, setSelectedSupplierId] = useState<number | null>(null);

  // Registration Form State
  const [showRegisterForm, setShowRegisterForm] = useState<boolean>(false);
  const [nombreComercial, setNombreComercial] = useState<string>('');
  const [razonSocial, setRazonSocial] = useState<string>('');
  const [identificacionFiscal, setIdentificacionFiscal] = useState<string>('');
  const [contactoNombre, setContactoNombre] = useState<string>('');
  const [telefono, setTelefono] = useState<string>('');
  const [direccion, setDireccion] = useState<string>('');
  const [tipoProveedor, setTipoProveedor] = useState<string>('Consignación / Venta Devengada');
  const [initialLinkedIds, setInitialLinkedIds] = useState<number[]>([]);
  const [initialProductFilter, setInitialProductFilter] = useState<string>('');
  const [registerSubmitting, setRegisterSubmitting] = useState<boolean>(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  // Origin Linking Panel State
  const [linkSelectProductId, setLinkSelectProductId] = useState<string>('');
  const [linkingBusy, setLinkingBusy] = useState<boolean>(false);
  const [actionStatus, setActionStatus] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);

  const fetchSuppliersAndProducts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [provRes, prodRes] = await Promise.all([
        fetch('/api/proveedores'),
        fetch('/api/productos'),
      ]);

      if (!provRes.ok) {
        throw new Error(`Error HTTP ${provRes.status} al cargar proveedores`);
      }
      if (!prodRes.ok) {
        throw new Error(`Error HTTP ${prodRes.status} al cargar inventario`);
      }

      const provData = (await provRes.json()) as { proveedores?: SupplierRecord[] };
      const prodData = (await prodRes.json()) as { productos?: InventoryItem[] };

      const loadedSuppliers = Array.isArray(provData.proveedores) ? provData.proveedores : [];
      const loadedProducts = Array.isArray(prodData.productos) ? prodData.productos : [];

      setSuppliers(loadedSuppliers);
      setProducts(loadedProducts);

      setSelectedSupplierId((prev) => {
        if (prev && loadedSuppliers.some((s) => s.id === prev)) return prev;
        return loadedSuppliers.length > 0 ? loadedSuppliers[0].id : null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar los datos de proveedores');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSuppliersAndProducts();

    const handleRefresh = () => {
      void fetchSuppliersAndProducts();
    };
    const handleOpenCreate = () => {
      setShowRegisterForm(true);
      setRegisterError(null);
    };

    window.addEventListener('inventory:updated', handleRefresh);
    window.addEventListener('suppliers:open-create', handleOpenCreate);
    return () => {
      window.removeEventListener('inventory:updated', handleRefresh);
      window.removeEventListener('suppliers:open-create', handleOpenCreate);
    };
  }, [fetchSuppliersAndProducts]);

  // Clear feedback toast after a few seconds
  useEffect(() => {
    if (!actionStatus) return;
    const timer = window.setTimeout(() => setActionStatus(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionStatus]);

  const productsBySupplier = useMemo(() => {
    const map = new Map<number, InventoryItem[]>();
    for (const item of products) {
      if (item.proveedor_id) {
        const list = map.get(Number(item.proveedor_id)) ?? [];
        list.push(item);
        map.set(Number(item.proveedor_id), list);
      }
    }
    return map;
  }, [products]);

  const filteredSuppliers = useMemo(() => {
    const q = normalizeText(searchQuery.trim());
    return suppliers.filter((s) => {
      const linkedCount = productsBySupplier.get(s.id)?.length ?? 0;
      if (supplierFilter === 'linked' && linkedCount === 0) return false;
      if (supplierFilter === 'unlinked' && linkedCount > 0) return false;
      if (supplierFilter === 'debt' && Number(s.saldo_pendiente_efectivo || 0) <= 0) return false;

      if (q) {
        const hay = normalizeText(
          [
            s.nombre_comercial,
            s.razon_social ?? '',
            s.codigo_ref,
            s.identificacion_fiscal ?? '',
            s.contacto_nombre ?? '',
            s.telefono ?? '',
            s.direccion ?? '',
            s.tipo_proveedor,
          ].join(' ')
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [suppliers, productsBySupplier, searchQuery, supplierFilter]);

  const selectedSupplier = useMemo(
    () => suppliers.find((s) => s.id === selectedSupplierId) ?? null,
    [suppliers, selectedSupplierId]
  );

  const selectedSupplierProducts = useMemo(
    () => (selectedSupplier ? productsBySupplier.get(selectedSupplier.id) ?? [] : []),
    [selectedSupplier, productsBySupplier]
  );

  const assignableProducts = useMemo(() => {
    if (!selectedSupplier) return products;
    return products
      .filter((p) => Number(p.proveedor_id || 0) !== selectedSupplier.id)
      .sort((a, b) => {
        const aUnlinked = a.proveedor_id ? 1 : 0;
        const bUnlinked = b.proveedor_id ? 1 : 0;
        if (aUnlinked !== bUnlinked) return aUnlinked - bUnlinked;
        return a.descripcion.localeCompare(b.descripcion, 'es');
      });
  }, [products, selectedSupplier]);

  useEffect(() => {
    if (assignableProducts.length === 0) {
      setLinkSelectProductId('');
      return;
    }
    if (!assignableProducts.some((p) => String(p.id) === linkSelectProductId)) {
      setLinkSelectProductId(String(assignableProducts[0].id));
    }
  }, [assignableProducts, linkSelectProductId]);

  const filteredInitialProducts = useMemo(() => {
    const q = normalizeText(initialProductFilter.trim());
    const list = q
      ? products.filter((p) =>
          normalizeText(`${p.descripcion} ${p.sku} ${p.proveedor_nombre ?? ''}`).includes(q)
        )
      : products;
    return [...list].sort((a, b) => {
      const aUnlinked = a.proveedor_id ? 1 : 0;
      const bUnlinked = b.proveedor_id ? 1 : 0;
      if (aUnlinked !== bUnlinked) return aUnlinked - bUnlinked;
      return a.descripcion.localeCompare(b.descripcion, 'es');
    });
  }, [products, initialProductFilter]);

  const toggleInitialProductId = (productId: number) => {
    setInitialLinkedIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const resetRegistrationForm = () => {
    setNombreComercial('');
    setRazonSocial('');
    setIdentificacionFiscal('');
    setContactoNombre('');
    setTelefono('');
    setDireccion('');
    setTipoProveedor('Consignación / Venta Devengada');
    setInitialLinkedIds([]);
    setInitialProductFilter('');
    setRegisterError(null);
  };

  const handleRegisterSupplier = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (registerSubmitting) return;

    const cleanName = nombreComercial.trim();
    if (!cleanName) {
      setRegisterError('El nombre comercial del proveedor es obligatorio.');
      return;
    }

    setRegisterSubmitting(true);
    setRegisterError(null);

    try {
      const res = await fetch('/api/proveedores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre_comercial: cleanName,
          razon_social: razonSocial.trim() || cleanName,
          identificacion_fiscal: identificacionFiscal.trim(),
          contacto_nombre: contactoNombre.trim(),
          telefono: telefono.trim(),
          direccion: direccion.trim(),
          tipo_proveedor: tipoProveedor,
          producto_ids: initialLinkedIds,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        proveedor?: SupplierRecord;
        linked_count?: number;
        error?: string;
      };

      if (!res.ok || !data.success || !data.proveedor) {
        throw new Error(data.error || 'No se pudo registrar el proveedor en SQLite');
      }

      const newProv = data.proveedor;
      const linkedCount = Number(data.linked_count ?? initialLinkedIds.length);

      resetRegistrationForm();
      setShowRegisterForm(false);
      setSelectedSupplierId(newProv.id);

      await fetchSuppliersAndProducts();
      window.dispatchEvent(new CustomEvent('inventory:updated'));
      onSuppliersChanged?.();

      setActionStatus({
        text:
          linkedCount > 0
            ? `Proveedor "${newProv.nombre_comercial}" (${newProv.codigo_ref}) registrado con ${linkedCount} artículo(s) vinculado(s).`
            : `Proveedor "${newProv.nombre_comercial}" (${newProv.codigo_ref}) registrado en SQLite.`,
        tone: 'success',
      });
    } catch (err) {
      setRegisterError(
        err instanceof Error ? err.message : 'Error al registrar proveedor en SQLite'
      );
    } finally {
      setRegisterSubmitting(false);
    }
  };

  const handleLinkProducts = async (
    supplierId: number,
    productIds: number[],
    mode: 'assign' | 'unlink'
  ) => {
    if (linkingBusy || productIds.length === 0) return;
    setLinkingBusy(true);
    setActionStatus(null);

    try {
      const res = await fetch(`/api/proveedores/${supplierId}/productos`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          producto_ids: productIds,
          mode,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        updated_count?: number;
        error?: string;
      };

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'No se pudo actualizar el origen del inventario');
      }

      await fetchSuppliersAndProducts();
      window.dispatchEvent(new CustomEvent('inventory:updated'));
      onSuppliersChanged?.();

      const targetName =
        suppliers.find((s) => s.id === supplierId)?.nombre_comercial ?? 'Proveedor';

      setActionStatus({
        text:
          mode === 'unlink'
            ? `Origen desvinculado del inventario para "${targetName}".`
            : `${data.updated_count ?? productIds.length} artículo(s) vinculados a "${targetName}" para trazabilidad de origen.`,
        tone: 'success',
      });
    } catch (err) {
      setActionStatus({
        text:
          err instanceof Error
            ? err.message
            : 'Error al vincular artículos con el proveedor en SQLite',
        tone: 'error',
      });
    } finally {
      setLinkingBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-space-lg">
      {/* Status Banner */}
      {actionStatus && (
        <div
          className={`p-space-md rounded-xl flex items-center justify-between gap-space-sm font-label-md text-label-md shadow-sm ${
            actionStatus.tone === 'error'
              ? 'bg-error-container text-on-error-container'
              : 'bg-[#ecfdf5] text-[#065f46]'
          }`}
          role="status"
        >
          <div className="flex items-center gap-space-xs">
            <span className="material-symbols-outlined text-[20px]">
              {actionStatus.tone === 'error' ? 'error' : 'check_circle'}
            </span>
            <span>{actionStatus.text}</span>
          </div>
          <button
            aria-label="Cerrar notificación"
            className="p-1 rounded hover:bg-black/5"
            onClick={() => setActionStatus(null)}
            type="button"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Search, Filter & Register Trigger */}
      <div className="p-space-md bg-surface-container-lowest rounded-xl shadow-sm flex flex-col md:flex-row items-stretch md:items-center justify-between gap-space-md">
        <div className="relative flex-1 min-w-0">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[18px]">
            search
          </span>
          <input
            aria-label="Buscar proveedor por nombre, contacto o código"
            className="w-full h-10 pl-9 pr-4 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary-container transition-all placeholder:text-outline"
            id="supplier-manager-search"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar proveedor por nombre, contacto, RIF o dirección..."
            type="text"
            value={searchQuery}
          />
        </div>

        <div className="flex flex-wrap items-center gap-space-xs shrink-0">
          <select
            aria-label="Filtrar lista de proveedores"
            className="h-10 px-space-sm rounded-lg bg-surface-container-low text-on-surface font-label-md text-label-md focus:outline-none cursor-pointer"
            onChange={(e) => setSupplierFilter(e.target.value as SupplierFilter)}
            value={supplierFilter}
          >
            <option value="all">Todos ({suppliers.length})</option>
            <option value="linked">Con artículos vinculados</option>
            <option value="unlinked">Sin artículos vinculados</option>
            <option value="debt">Con saldo pendiente</option>
          </select>

          <button
            className="h-10 px-space-md rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-md text-label-md font-semibold inline-flex items-center gap-space-xs transition-colors shadow-sm"
            id="btn-toggle-register-supplier"
            onClick={() => {
              setShowRegisterForm((prev) => !prev);
              setRegisterError(null);
            }}
            type="button"
          >
            <span className="material-symbols-outlined text-[18px]">
              {showRegisterForm ? 'expand_less' : 'person_add'}
            </span>
            <span>{showRegisterForm ? 'Ocultar Registro' : 'Registrar Proveedor'}</span>
          </button>

          <button
            aria-label="Refrescar proveedores desde SQLite"
            className="h-10 w-10 flex items-center justify-center rounded-lg bg-surface-container-low text-on-surface-variant hover:text-on-surface transition-colors"
            onClick={() => void fetchSuppliersAndProducts()}
            title="Refrescar desde SQLite"
            type="button"
          >
            <span className="material-symbols-outlined text-[20px]">refresh</span>
          </button>
        </div>
      </div>

      {/* Collapsible Supplier Registration Form */}
      {showRegisterForm && (
        <form
          className="bg-surface-container-lowest rounded-xl shadow-md p-space-lg flex flex-col gap-space-md border border-primary/20"
          id="supplier-register-form"
          onSubmit={handleRegisterSupplier}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-space-xs">
              <span className="material-symbols-outlined text-primary text-[22px]">
                local_shipping
              </span>
              <div>
                <h3 className="font-headline-sm text-headline-sm text-on-surface">
                  Registrar Nuevo Proveedor y Trazabilidad
                </h3>
                <p className="font-label-sm text-label-sm text-on-surface-variant">
                  Guarda datos comerciales y vincula artículos del inventario existente en SQLite.
                </p>
              </div>
            </div>
            <button
              aria-label="Cerrar formulario de proveedor"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container"
              onClick={() => setShowRegisterForm(false)}
              type="button"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="sup-nombre-comercial"
              >
                Nombre Comercial *
              </label>
              <input
                className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="sup-nombre-comercial"
                onChange={(e) => setNombreComercial(e.target.value)}
                placeholder="Ej: Distribuidora Oriente S.R.L."
                required
                type="text"
                value={nombreComercial}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="sup-razon-social"
              >
                Razón Social
              </label>
              <input
                className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="sup-razon-social"
                onChange={(e) => setRazonSocial(e.target.value)}
                placeholder="Nombre legal o entidad"
                type="text"
                value={razonSocial}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="sup-contacto"
              >
                Persona de Contacto
              </label>
              <input
                className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="sup-contacto"
                onChange={(e) => setContactoNombre(e.target.value)}
                placeholder="Ej: María Elena Torres"
                type="text"
                value={contactoNombre}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="sup-telefono"
              >
                Teléfono
              </label>
              <input
                className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-code-mono text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="sup-telefono"
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="+53 5000-0000"
                type="text"
                value={telefono}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="sup-identificacion"
              >
                Identificación Fiscal / NIT
              </label>
              <input
                className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-code-mono text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="sup-identificacion"
                onChange={(e) => setIdentificacionFiscal(e.target.value)}
                placeholder="400XXXXXXXX"
                type="text"
                value={identificacionFiscal}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="sup-tipo-contrato"
              >
                Tipo de Contrato
              </label>
              <select
                className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="sup-tipo-contrato"
                onChange={(e) => setTipoProveedor(e.target.value)}
                value={tipoProveedor}
              >
                <option value="Consignación / Venta Devengada">
                  Consignación / Venta Devengada
                </option>
                <option value="Compra Firme">Compra Firme</option>
                <option value="Crédito Directo">Crédito Directo</option>
                <option value="Mixto">Mixto</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label
              className="font-label-sm text-label-sm text-on-surface font-semibold"
              htmlFor="sup-direccion"
            >
              Dirección / Ubicación de Origen
            </label>
            <input
              className="h-10 px-3 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
              id="sup-direccion"
              onChange={(e) => setDireccion(e.target.value)}
              placeholder="Ej: Almacén Zona Industrial, Municipio Playa, La Habana"
              type="text"
              value={direccion}
            />
          </div>

          {/* Optional Inventory Origin Assignment on Creation */}
          <div className="p-space-sm rounded-xl bg-surface-container-low flex flex-col gap-space-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs">
              <span className="font-label-sm text-label-sm text-on-surface font-semibold">
                Vincular Artículos de Inventario Existentes (Opcional · {initialLinkedIds.length}{' '}
                seleccionados)
              </span>
              <input
                aria-label="Filtrar artículos para vincular al nuevo proveedor"
                className="h-8 px-2.5 rounded-lg bg-surface-container-lowest text-on-surface font-label-sm text-label-sm focus:outline-none focus:ring-1 focus:ring-primary"
                onChange={(e) => setInitialProductFilter(e.target.value)}
                placeholder="Filtrar artículos..."
                type="text"
                value={initialProductFilter}
              />
            </div>

            <div className="max-h-36 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 pr-1">
              {filteredInitialProducts.map((prod) => {
                const checked = initialLinkedIds.includes(prod.id);
                return (
                  <label
                    className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-label-sm font-label-sm transition-colors ${
                      checked
                        ? 'bg-primary-fixed text-on-primary-fixed font-semibold'
                        : 'bg-surface-container-lowest text-on-surface hover:bg-surface-container'
                    }`}
                    key={prod.id}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <input
                        checked={checked}
                        className="w-4 h-4 accent-primary shrink-0"
                        onChange={() => toggleInitialProductId(prod.id)}
                        type="checkbox"
                      />
                      <span className="truncate">{prod.descripcion}</span>
                    </span>
                    <span className="font-code-mono text-[11px] opacity-75 shrink-0">
                      {prod.proveedor_nombre ? prod.proveedor_nombre.split(' ')[0] : 'Sin prov.'}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {registerError && (
            <div
              className="p-space-sm rounded-lg bg-error-container text-on-error-container font-label-sm text-label-sm flex items-center gap-1.5"
              role="alert"
            >
              <span className="material-symbols-outlined text-[18px]">error</span>
              <span>{registerError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-space-sm pt-1">
            <button
              className="h-10 px-space-md rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-label-md"
              onClick={() => {
                resetRegistrationForm();
                setShowRegisterForm(false);
              }}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="h-10 px-space-lg rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-md text-label-md font-semibold inline-flex items-center gap-space-xs shadow-sm disabled:opacity-60"
              disabled={registerSubmitting}
              id="btn-submit-register-supplier"
              type="submit"
            >
              <span className="material-symbols-outlined text-[18px]">save</span>
              <span>{registerSubmitting ? 'Guardando en SQLite...' : 'Guardar Proveedor'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Suppliers Master Table */}
      <div className="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden">
        <div className="px-space-lg py-space-md flex flex-wrap items-center justify-between gap-space-sm bg-surface-container-low">
          <div className="flex items-center gap-space-sm">
            <span className="material-symbols-outlined text-primary text-[20px]">
              account_balance_wallet
            </span>
            <span className="font-headline-sm text-headline-sm text-on-surface">
              Catálogo de Proveedores y Origen de Inventario
            </span>
          </div>
          <span className="font-code-mono text-code-mono text-on-surface-variant tabular-nums">
            {filteredSuppliers.length} de {suppliers.length} proveedores · {products.length} artículos
          </span>
        </div>

        {loadError ? (
          <div className="p-space-xl text-center flex flex-col items-center gap-space-sm">
            <span className="material-symbols-outlined text-error text-[32px]">error_outline</span>
            <p className="font-body-md text-body-md text-on-surface">{loadError}</p>
            <button
              className="px-space-md h-9 rounded-lg bg-primary text-on-primary font-label-sm font-semibold"
              onClick={() => void fetchSuppliersAndProducts()}
              type="button"
            >
              Reintentar
            </button>
          </div>
        ) : loading && suppliers.length === 0 ? (
          <div className="p-space-xl text-center text-on-surface-variant">
            Cargando proveedores e inventario desde SQLite...
          </div>
        ) : filteredSuppliers.length === 0 ? (
          <div className="p-space-xl text-center text-on-surface-variant">
            No se encontraron proveedores con el criterio seleccionado.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse" id="react-suppliers-table">
              <thead>
                <tr className="bg-surface-container-low text-on-surface-variant font-label-sm text-label-sm uppercase">
                  <th className="py-3 px-space-md font-semibold">Proveedor / Origen</th>
                  <th className="py-3 px-space-md font-semibold text-center">Artículos Vinculados</th>
                  <th className="py-3 px-space-md font-semibold text-right">Saldo Pendiente</th>
                  <th className="py-3 px-space-md font-semibold text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container-low font-body-md text-body-md">
                {filteredSuppliers.map((sup) => {
                  const linkedItems = productsBySupplier.get(sup.id) ?? [];
                  const debt = Number(sup.saldo_pendiente_efectivo || 0);
                  const isSelected = sup.id === selectedSupplier?.id;

                  return (
                    <tr
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-primary-fixed/35'
                          : 'bg-surface-container-lowest hover:bg-surface-container-low/60'
                      }`}
                      key={sup.id}
                      onClick={() => setSelectedSupplierId(sup.id)}
                    >
                      <td className="py-3 px-space-md">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-space-xs flex-wrap">
                            <span className="font-body-bold text-body-bold text-on-surface">
                              {sup.nombre_comercial}
                            </span>
                            <span className="font-code-mono text-[11px] text-primary font-semibold">
                              {sup.codigo_ref}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-space-sm gap-y-0.5 font-label-sm text-label-sm text-on-surface-variant mt-0.5">
                            <span>{sup.tipo_proveedor}</span>
                            {sup.contacto_nombre && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>Contacto: {sup.contacto_nombre}</span>
                              </>
                            )}
                            {sup.telefono && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-code-mono">{sup.telefono}</span>
                              </>
                            )}
                          </div>
                          {sup.direccion && (
                            <span className="font-label-sm text-[11px] text-on-surface-variant mt-0.5 truncate max-w-md">
                              Origen: {sup.direccion}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-space-md text-center align-middle">
                        <span
                          className={`font-code-mono tabular-nums font-bold ${
                            linkedItems.length > 0 ? 'text-primary' : 'text-on-surface-variant'
                          }`}
                        >
                          {linkedItems.length} {linkedItems.length === 1 ? 'artículo' : 'artículos'}
                        </span>
                        {linkedItems.length > 0 && (
                          <span className="block text-[11px] text-on-surface-variant truncate max-w-[190px] mx-auto">
                            {linkedItems.slice(0, 2).map((i) => i.sku).join(', ')}
                            {linkedItems.length > 2 ? ` +${linkedItems.length - 2}` : ''}
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-space-md text-right align-middle tabular-nums">
                        <span
                          className={`font-code-mono font-bold ${
                            debt > 0 ? 'text-error' : 'text-on-surface'
                          }`}
                        >
                          ${formatMoney(debt)}
                        </span>
                        <span className="block text-[10px] uppercase font-semibold text-on-surface-variant">
                          CUP
                        </span>
                      </td>

                      <td
                        className="py-3 px-space-md text-right align-middle"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            className={`px-2.5 h-8 rounded-lg font-label-sm text-label-sm font-semibold inline-flex items-center gap-1 transition-colors ${
                              isSelected
                                ? 'bg-primary text-on-primary'
                                : 'bg-surface-container hover:bg-surface-container-high text-on-surface'
                            }`}
                            onClick={() => setSelectedSupplierId(sup.id)}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-[16px]">link</span>
                            <span>Origen</span>
                          </button>

                          {onPaySupplier && debt > 0 && (
                            <button
                              className="px-2.5 h-8 rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-sm text-label-sm font-semibold transition-colors"
                              onClick={() => onPaySupplier(sup)}
                              type="button"
                            >
                              Abonar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Selected Supplier Inventory Origin Linking Panel */}
      {selectedSupplier && (
        <section
          aria-label="Vinculación de artículos de inventario por proveedor"
          className="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md"
          id="supplier-origin-panel"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
            <div>
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary text-[20px]">
                  inventory_2
                </span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface">
                  Trazabilidad de Origen: {selectedSupplier.nombre_comercial}
                </h3>
              </div>
              <p className="font-label-sm text-label-sm text-on-surface-variant mt-0.5 tabular-nums">
                {selectedSupplier.codigo_ref}
                {selectedSupplier.identificacion_fiscal
                  ? ` · NIT: ${selectedSupplier.identificacion_fiscal}`
                  : ''}
                {selectedSupplier.direccion ? ` · ${selectedSupplier.direccion}` : ''}
              </p>
            </div>

            <span className="font-code-mono text-label-sm text-primary font-bold tabular-nums shrink-0">
              {selectedSupplierProducts.length} artículos vinculados
            </span>
          </div>

          {/* Link Existing Inventory Item Controls */}
          <div className="p-space-md rounded-xl bg-surface-container-low flex flex-col sm:flex-row items-stretch sm:items-center gap-space-sm">
            <div className="flex-1 min-w-0">
              <label
                className="block font-label-sm text-label-sm text-on-surface font-semibold mb-1"
                htmlFor="supplier-link-product-select"
              >
                Vincular Artículo Existente del Inventario a este Proveedor
              </label>
              <select
                className="w-full h-10 px-3 rounded-lg bg-surface-container-lowest text-on-surface font-body-md text-label-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                disabled={assignableProducts.length === 0 || linkingBusy}
                id="supplier-link-product-select"
                onChange={(e) => setLinkSelectProductId(e.target.value)}
                value={linkSelectProductId}
              >
                {assignableProducts.length === 0 ? (
                  <option value="">Todos los artículos ya pertenecen a este proveedor</option>
                ) : (
                  assignableProducts.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.sku} · {p.descripcion} ({p.stock_actual} u. ·{' '}
                      {p.proveedor_nombre
                        ? `Origen actual: ${p.proveedor_nombre}`
                        : 'Sin proveedor asignado'}
                      )
                    </option>
                  ))
                )}
              </select>
            </div>

            <button
              className="h-10 px-space-md rounded-lg bg-primary-container hover:bg-primary text-on-primary font-label-md text-label-md font-semibold inline-flex items-center justify-center gap-1.5 transition-colors shrink-0 sm:self-end disabled:opacity-50"
              disabled={!linkSelectProductId || linkingBusy || assignableProducts.length === 0}
              id="btn-link-inventory-item"
              onClick={() => {
                const pid = Number(linkSelectProductId);
                if (pid > 0) {
                  void handleLinkProducts(selectedSupplier.id, [pid], 'assign');
                }
              }}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">add_link</span>
              <span>{linkingBusy ? 'Vinculando...' : 'Vincular Artículo'}</span>
            </button>
          </div>

          {/* Linked Inventory Items Table */}
          {selectedSupplierProducts.length === 0 ? (
            <div className="p-space-lg rounded-xl bg-surface-container-low/60 text-center text-on-surface-variant text-label-md">
              Este proveedor aún no tiene artículos vinculados en SQLite. Selecciona un producto arriba para rastrear su origen.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-surface-container">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-surface-container-low text-on-surface-variant font-label-sm text-label-sm uppercase">
                    <th className="py-2.5 px-space-md font-semibold">SKU</th>
                    <th className="py-2.5 px-space-md font-semibold">Artículo</th>
                    <th className="py-2.5 px-space-md font-semibold text-right">Stock</th>
                    <th className="py-2.5 px-space-md font-semibold text-right">Costo PMP</th>
                    <th className="py-2.5 px-space-md font-semibold text-right">Precio CUP</th>
                    <th className="py-2.5 px-space-md font-semibold text-right">Origen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-low font-body-md text-label-md">
                  {selectedSupplierProducts.map((item) => (
                    <tr className="hover:bg-surface-container-low/40" key={item.id}>
                      <td className="py-2.5 px-space-md font-code-mono text-on-surface-variant">
                        {item.sku}
                      </td>
                      <td className="py-2.5 px-space-md font-semibold text-on-surface">
                        {item.descripcion}
                      </td>
                      <td className="py-2.5 px-space-md text-right font-code-mono tabular-nums">
                        {item.stock_actual} u.
                      </td>
                      <td className="py-2.5 px-space-md text-right font-code-mono tabular-nums text-on-surface-variant">
                        ${formatMoney(item.costo_pmp || item.costo_ultimo)}
                      </td>
                      <td className="py-2.5 px-space-md text-right font-code-mono tabular-nums font-semibold text-primary">
                        ${formatMoney(item.precio_venta_cup)}
                      </td>
                      <td className="py-2.5 px-space-md text-right">
                        <button
                          aria-label={`Desvincular ${item.descripcion} de ${selectedSupplier.nombre_comercial}`}
                          className="px-2 h-7 rounded bg-surface-container-low hover:bg-error-container hover:text-on-error-container text-on-surface-variant font-label-sm text-[11px] font-semibold inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                          disabled={linkingBusy}
                          onClick={() =>
                            void handleLinkProducts(selectedSupplier.id, [item.id], 'unlink')
                          }
                          title="Quitar vínculo de origen"
                          type="button"
                        >
                          <span className="material-symbols-outlined text-[14px]">link_off</span>
                          <span>Desvincular</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default SupplierManager;
