import React, { useEffect, useMemo, useState } from 'react';
import type { InventoryItem } from './InventoryTable.js';

export interface CategoryOption {
  id: number;
  nombre: string;
}

export interface SupplierOption {
  id: number;
  nombre_comercial: string;
}

export interface InventoryItemFormProps {
  isOpen: boolean;
  item: InventoryItem | null;
  initialIntent?: 'form' | 'delete';
  variant?: 'modal' | 'inline';
  onClose: () => void;
  onSaved?: (savedItem: InventoryItem, mode: 'create' | 'edit') => void;
  onDeleted?: (deletedId: number, descripcion: string) => void;
}

interface FormState {
  sku: string;
  codigo_barras: string;
  descripcion: string;
  categoria_id: string;
  proveedor_id: string;
  unidad_medida: string;
  stock_actual: string;
  stock_minimo: string;
  costo_ultimo: string;
  precio_venta_cup: string;
}

const DEFAULT_CATEGORIES: CategoryOption[] = [
  { id: 1, nombre: 'Alimentos y Bebidas' },
  { id: 2, nombre: 'Aseo y Hogar' },
  { id: 3, nombre: 'Ferretería y Herramientas' },
  { id: 4, nombre: 'Electrónica menor' },
];

const UNIT_OPTIONS = ['UNIDAD', 'PAQUETE', 'CAJA', 'KG', 'LITRO'];

function buildInitialState(item: InventoryItem | null): FormState {
  if (item) {
    return {
      sku: item.sku ?? '',
      codigo_barras: item.codigo_barras ?? '',
      descripcion: item.descripcion ?? '',
      categoria_id: String(item.categoria_id ?? 1),
      proveedor_id: item.proveedor_id ? String(item.proveedor_id) : '',
      unidad_medida: item.unidad_medida || 'UNIDAD',
      stock_actual: String(item.stock_actual ?? 0),
      stock_minimo: String(item.stock_minimo ?? 10),
      costo_ultimo: String(item.costo_ultimo ?? 0),
      precio_venta_cup: String(item.precio_venta_cup ?? 0),
    };
  }
  return {
    sku: '',
    codigo_barras: '',
    descripcion: '',
    categoria_id: '1',
    proveedor_id: '',
    unidad_medida: 'UNIDAD',
    stock_actual: '0',
    stock_minimo: '10',
    costo_ultimo: '0',
    precio_venta_cup: '',
  };
}

export const InventoryItemForm: React.FC<InventoryItemFormProps> = ({
  isOpen,
  item,
  initialIntent = 'form',
  variant = 'modal',
  onClose,
  onSaved,
  onDeleted,
}) => {
  const isEditMode = Boolean(item);
  const [form, setForm] = useState<FormState>(() => buildInitialState(item));
  const [categories, setCategories] = useState<CategoryOption[]>(DEFAULT_CATEGORIES);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(buildInitialState(item));
    setErrorMsg(null);
    setSubmitting(false);
    setDeleting(false);
    setConfirmingDelete(Boolean(item && initialIntent === 'delete'));
  }, [isOpen, item, initialIntent]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const loadReferenceData = async () => {
      try {
        const [catRes, provRes] = await Promise.all([
          fetch('/api/categorias'),
          fetch('/api/proveedores'),
        ]);
        if (catRes.ok) {
          const catData = (await catRes.json()) as { categorias?: CategoryOption[] };
          if (!cancelled && Array.isArray(catData.categorias) && catData.categorias.length > 0) {
            setCategories(catData.categorias);
          }
        }
        if (provRes.ok) {
          const provData = (await provRes.json()) as { proveedores?: SupplierOption[] };
          if (!cancelled && Array.isArray(provData.proveedores)) {
            setSuppliers(provData.proveedores);
          }
        }
      } catch {
        // Keep fallback categories if offline lookup fails briefly
      }
    };

    void loadReferenceData();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || variant !== 'modal') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting && !deleting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, variant, submitting, deleting, onClose]);

  const marginPreview = useMemo(() => {
    const cost = Number(form.costo_ultimo || 0);
    const price = Number(form.precio_venta_cup || 0);
    if (Number.isNaN(cost) || Number.isNaN(price) || price <= 0) {
      return null;
    }
    const profit = price - cost;
    const pct = cost > 0 ? (profit / cost) * 100 : 100;
    return { profit, pct };
  }, [form.costo_ultimo, form.precio_venta_cup]);

  if (!isOpen) {
    return null;
  }

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errorMsg) setErrorMsg(null);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting || deleting) return;

    const descripcion = form.descripcion.trim();
    const sku = form.sku.trim();
    const stockActual = Number(form.stock_actual);
    const stockMinimo = Number(form.stock_minimo);
    const costoUltimo = Number(form.costo_ultimo);
    const precioVenta = Number(form.precio_venta_cup);

    if (!descripcion) {
      setErrorMsg('El nombre del artículo es obligatorio.');
      return;
    }
    if (isEditMode && !sku) {
      setErrorMsg('El SKU no puede quedar vacío al editar un artículo.');
      return;
    }
    if (Number.isNaN(precioVenta) || precioVenta <= 0) {
      setErrorMsg('El precio unitario de venta debe ser mayor a 0 CUP.');
      return;
    }
    if (
      Number.isNaN(stockActual) ||
      stockActual < 0 ||
      Number.isNaN(stockMinimo) ||
      stockMinimo < 0 ||
      Number.isNaN(costoUltimo) ||
      costoUltimo < 0
    ) {
      setErrorMsg('El nivel de stock, umbral mínimo y costo deben ser iguales o mayores a 0.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const payload = {
        sku: sku || undefined,
        codigo_barras: form.codigo_barras.trim() || undefined,
        descripcion,
        categoria_id: Number(form.categoria_id) || 1,
        proveedor_id: form.proveedor_id ? Number(form.proveedor_id) : null,
        unidad_medida: form.unidad_medida || 'UNIDAD',
        stock_actual: stockActual,
        stock_minimo: stockMinimo,
        costo_ultimo: costoUltimo,
        precio_venta_cup: precioVenta,
      };

      const endpoint = isEditMode && item ? `/api/productos/${item.id}` : '/api/productos';
      const method = isEditMode ? 'PUT' : 'POST';

      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as {
        success?: boolean;
        producto?: InventoryItem;
        error?: string;
      };

      if (!response.ok || !data.success || !data.producto) {
        throw new Error(data.error || 'No se pudo guardar el artículo en SQLite');
      }

      window.dispatchEvent(new CustomEvent('inventory:updated'));
      if (onSaved) {
        onSaved(data.producto, isEditMode ? 'edit' : 'create');
      }
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error inesperado al guardar en SQLite');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!item || deleting || submitting) return;
    setDeleting(true);
    setErrorMsg(null);

    try {
      const response = await fetch(`/api/productos/${item.id}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as {
        success?: boolean;
        error?: string;
      };

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo eliminar el artículo de SQLite');
      }

      window.dispatchEvent(new CustomEvent('inventory:updated'));
      if (onDeleted) {
        onDeleted(item.id, item.descripcion);
      }
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error inesperado al eliminar de SQLite');
    } finally {
      setDeleting(false);
    }
  };

  const cardContent = (
    <div
      aria-labelledby="inventory-form-title"
      aria-modal={variant === 'modal' ? 'true' : undefined}
      className="w-full max-w-2xl bg-surface-container-lowest rounded-xl shadow-xl overflow-hidden"
      role={variant === 'modal' ? 'dialog' : undefined}
    >
      {/* Form Header */}
      <div className="px-space-xl py-space-lg bg-surface-container-low flex items-center justify-between gap-space-md">
        <div className="flex items-center gap-space-sm min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
              confirmingDelete
                ? 'bg-error text-on-error'
                : 'bg-primary-container text-on-primary'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">
              {confirmingDelete ? 'delete_forever' : isEditMode ? 'edit_square' : 'add_box'}
            </span>
          </div>
          <div className="min-w-0">
            <h3
              className="font-headline-sm text-headline-sm text-on-surface truncate"
              id="inventory-form-title"
            >
              {confirmingDelete
                ? 'Eliminar Artículo del Inventario'
                : isEditMode
                  ? 'Editar Artículo de Inventario'
                  : 'Agregar Nuevo Artículo'}
            </h3>
            <p className="font-label-sm text-label-sm text-on-surface-variant truncate">
              {isEditMode && item
                ? `${item.sku} · Persistido en SQLite`
                : 'Registro directo en catálogo SQLite'}
            </p>
          </div>
        </div>
        <button
          aria-label="Cerrar formulario"
          className="w-9 h-9 rounded-xl flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors shrink-0"
          disabled={submitting || deleting}
          onClick={onClose}
          type="button"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>

      {/* Error Feedback */}
      {errorMsg && (
        <div
          className="mx-space-xl mt-space-lg p-space-md rounded-xl bg-error-container text-on-error-container flex items-start gap-space-sm"
          role="alert"
        >
          <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">error</span>
          <span className="font-body-md text-body-md">{errorMsg}</span>
        </div>
      )}

      {/* Delete Confirmation View or Full Form */}
      {confirmingDelete && item ? (
        <div className="p-space-xl flex flex-col gap-space-lg">
          <div className="p-space-lg rounded-xl bg-error-container/30 flex flex-col gap-space-xs">
            <span className="font-label-sm text-label-sm text-error font-semibold">
              Confirmación requerida
            </span>
            <p className="font-body-md text-body-md text-on-surface">
              ¿Deseas eliminar <span className="font-semibold">{item.descripcion}</span> (
              <span className="font-code-mono">{item.sku}</span>) del inventario activo en SQLite?
            </p>
            <div className="font-label-sm text-label-sm text-on-surface-variant tabular-nums flex flex-wrap items-center gap-2 pt-1">
              <span>Stock actual: {item.stock_actual} u.</span>
              <span aria-hidden="true">·</span>
              <span>Precio: ${Number(item.precio_venta_cup).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CUP</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-space-sm">
            <button
              className="px-space-lg h-10 rounded-xl bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-label-md transition-colors whitespace-nowrap shrink-0"
              disabled={deleting}
              onClick={() => {
                if (initialIntent === 'delete') {
                  onClose();
                } else {
                  setConfirmingDelete(false);
                }
              }}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="px-space-lg h-10 rounded-xl bg-error hover:opacity-90 text-on-error font-body-bold text-body-bold shadow-sm transition-all inline-flex items-center gap-space-xs whitespace-nowrap shrink-0 disabled:opacity-60"
              disabled={deleting}
              onClick={() => void handleDelete()}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              <span>{deleting ? 'Eliminando...' : 'Confirmar Eliminación'}</span>
            </button>
          </div>
        </div>
      ) : (
        <form className="p-space-xl flex flex-col gap-space-md" onSubmit={handleSubmit}>
          {/* Name & SKU */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-space-md">
            <div className="sm:col-span-8 flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-desc"
              >
                Nombre del Artículo *
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-body-md text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-desc"
                onChange={(e) => updateField('descripcion', e.target.value)}
                placeholder="Ej: Aceite Vegetal Criollo 1L"
                required
                type="text"
                value={form.descripcion}
              />
            </div>

            <div className="sm:col-span-4 flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-sku"
              >
                SKU {isEditMode ? '*' : '(opcional)'}
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-code-mono text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-sku"
                onChange={(e) => updateField('sku', e.target.value)}
                placeholder="Auto o SKU-90001"
                required={isEditMode}
                type="text"
                value={form.sku}
              />
            </div>
          </div>

          {/* Category, Supplier, Unit, Barcode */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-space-md">
            <div className="sm:col-span-5 flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-category"
              >
                Categoría *
              </label>
              <select
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="inv-form-category"
                onChange={(e) => updateField('categoria_id', e.target.value)}
                value={form.categoria_id}
              >
                {categories.map((cat) => (
                  <option key={cat.id} value={String(cat.id)}>
                    {cat.nombre}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-4 flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-supplier"
              >
                Proveedor
              </label>
              <select
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="inv-form-supplier"
                onChange={(e) => updateField('proveedor_id', e.target.value)}
                value={form.proveedor_id}
              >
                <option value="">Sin proveedor</option>
                {suppliers.map((sup) => (
                  <option key={sup.id} value={String(sup.id)}>
                    {sup.nombre_comercial}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-3 flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-unit"
              >
                Unidad
              </label>
              <select
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
                id="inv-form-unit"
                onChange={(e) => updateField('unidad_medida', e.target.value)}
                value={form.unidad_medida}
              >
                {UNIT_OPTIONS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Stock Level, Min Stock, Unit Cost, Unit Sale Price */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-md">
            <div className="flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-stock"
              >
                Nivel de Stock *
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-code-mono tabular-nums text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-stock"
                min="0"
                onChange={(e) => updateField('stock_actual', e.target.value)}
                required
                step="any"
                type="number"
                value={form.stock_actual}
              />
            </div>

            <div className="flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-min-stock"
              >
                Stock Mínimo
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-code-mono tabular-nums text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-min-stock"
                min="0"
                onChange={(e) => updateField('stock_minimo', e.target.value)}
                step="any"
                type="number"
                value={form.stock_minimo}
              />
            </div>

            <div className="flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-cost"
              >
                Costo Unit. (CUP)
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-code-mono tabular-nums text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-cost"
                min="0"
                onChange={(e) => updateField('costo_ultimo', e.target.value)}
                step="0.01"
                type="number"
                value={form.costo_ultimo}
              />
            </div>

            <div className="flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-price"
              >
                Precio Unit. (CUP) *
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-code-mono tabular-nums text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-price"
                min="0.01"
                onChange={(e) => updateField('precio_venta_cup', e.target.value)}
                placeholder="Ej: 245.00"
                required
                step="0.01"
                type="number"
                value={form.precio_venta_cup}
              />
            </div>
          </div>

          {/* Barcode & Margin Preview */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-space-md items-end">
            <div className="sm:col-span-6 flex flex-col gap-space-xs">
              <label
                className="font-label-sm text-label-sm text-on-surface font-semibold"
                htmlFor="inv-form-barcode"
              >
                Código de Barras EAN (opcional)
              </label>
              <input
                className="w-full h-10 px-space-md bg-surface-container-low rounded-xl text-on-surface font-code-mono text-body-md focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/30"
                id="inv-form-barcode"
                onChange={(e) => updateField('codigo_barras', e.target.value)}
                placeholder="Ej: 78910001355"
                type="text"
                value={form.codigo_barras}
              />
            </div>

            <div className="sm:col-span-6 h-10 px-space-md rounded-xl bg-surface-container-low flex items-center justify-between font-label-sm text-label-sm tabular-nums">
              <span className="text-on-surface-variant">Margen estimado</span>
              {marginPreview ? (
                <span
                  className={`font-code-mono font-semibold ${
                    marginPreview.profit >= 0 ? 'text-primary' : 'text-error'
                  }`}
                >
                  {marginPreview.profit >= 0 ? '+' : ''}$
                  {marginPreview.profit.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  ({marginPreview.pct.toFixed(1)}%)
                </span>
              ) : (
                <span className="font-code-mono text-outline">—</span>
              )}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex flex-wrap items-center justify-between gap-space-sm pt-space-md border-t border-surface-container-low">
            <div>
              {isEditMode && (
                <button
                  className="px-space-md h-10 rounded-xl bg-error-container/50 hover:bg-error-container text-error font-label-md text-label-md font-semibold transition-colors inline-flex items-center gap-space-xs whitespace-nowrap shrink-0"
                  disabled={submitting || deleting}
                  onClick={() => setConfirmingDelete(true)}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                  <span>Eliminar</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-space-sm">
              <button
                className="px-space-lg h-10 rounded-xl bg-surface-container-low hover:bg-surface-container font-label-md text-label-md text-on-surface transition-colors whitespace-nowrap shrink-0"
                disabled={submitting || deleting}
                onClick={onClose}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="px-space-lg h-10 rounded-xl bg-primary-container hover:bg-primary text-on-primary font-body-bold text-body-bold shadow-sm transition-all inline-flex items-center gap-space-xs whitespace-nowrap shrink-0 disabled:opacity-60"
                disabled={submitting || deleting}
                type="submit"
              >
                <span className="material-symbols-outlined text-[18px]">save</span>
                <span>
                  {submitting
                    ? 'Guardando...'
                    : isEditMode
                      ? 'Guardar Cambios'
                      : 'Guardar Producto'}
                </span>
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );

  if (variant === 'inline') {
    return cardContent;
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-inverse-surface/40 backdrop-blur-xs flex items-center justify-center p-margin overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting && !deleting) {
          onClose();
        }
      }}
    >
      {cardContent}
    </div>
  );
};

export default InventoryItemForm;
