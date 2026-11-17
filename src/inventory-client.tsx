import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  InventoryTable,
  type InventoryItem,
  type InventoryStats,
} from './components/InventoryTable.js';
import { InventoryItemForm } from './components/InventoryItemForm.js';

declare global {
  interface Window {
    openAdjustment?: (name: string, sku: string, currentStock: number, minStock: number) => void;
    openNewProductModal?: () => void;
    openEditProductModal?: (item: InventoryItem) => void;
  }
}

interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'danger';
}

function handleItemsLoaded(items: InventoryItem[], stats: InventoryStats | null): void {
  const datalist = document.getElementById('product-list');
  if (datalist) {
    datalist.innerHTML = items
      .map(
        (p) =>
          `<option value="${p.sku.replace(/"/g, '&quot;')} - ${p.descripcion.replace(
            /"/g,
            '&quot;'
          )}">Stock actual: ${p.stock_actual} u.</option>`
      )
      .join('');
  }

  if (stats) {
    const kpiTotal = document.getElementById('kpi-total-productos');
    const kpiVenta = document.getElementById('kpi-valor-venta');
    const kpiCosto = document.getElementById('kpi-valor-costo');
    const kpiBajo = document.getElementById('kpi-bajo-stock');

    if (kpiTotal) kpiTotal.textContent = String(stats.total_productos ?? items.length);
    if (kpiVenta) {
      kpiVenta.textContent = `$${Math.round(stats.valor_venta_total || 0).toLocaleString('en-US')}`;
    }
    if (kpiCosto) {
      kpiCosto.textContent = `Costo: $${Math.round(stats.valor_costo_total || 0).toLocaleString(
        'en-US'
      )} CUP`;
    }
    if (kpiBajo) kpiBajo.textContent = String(stats.bajo_stock_count ?? 0);
  }
}

const InventoryWorkspace: React.FC = () => {
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const [activeItem, setActiveItem] = useState<InventoryItem | null>(null);
  const [formIntent, setFormIntent] = useState<'form' | 'delete'>('form');
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string, tone: 'success' | 'danger' = 'success') => {
    setToast({ id: Date.now(), text, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openCreateForm = useCallback(() => {
    setActiveItem(null);
    setFormIntent('form');
    setFormOpen(true);
  }, []);

  const openEditForm = useCallback((item: InventoryItem) => {
    setActiveItem(item);
    setFormIntent('form');
    setFormOpen(true);
  }, []);

  const openDeleteForm = useCallback((item: InventoryItem) => {
    setActiveItem(item);
    setFormIntent('delete');
    setFormOpen(true);
  }, []);

  useEffect(() => {
    window.openNewProductModal = openCreateForm;
    window.openEditProductModal = openEditForm;
    const handleOpenCreateEvent = () => openCreateForm();
    window.addEventListener('inventory:open-create', handleOpenCreateEvent);
    return () => {
      window.removeEventListener('inventory:open-create', handleOpenCreateEvent);
    };
  }, [openCreateForm, openEditForm]);

  return (
    <>
      <InventoryTable
        apiEndpoint="/api/productos"
        onAdjustItem={(item) => {
          if (typeof window.openAdjustment === 'function') {
            window.openAdjustment(
              item.descripcion,
              item.sku,
              item.stock_actual,
              item.stock_minimo
            );
          }
        }}
        onCreateProduct={openCreateForm}
        onDeleteItem={openDeleteForm}
        onEditItem={openEditForm}
        onExportCsv={(count, filename) => {
          showToast(`Reporte CSV "${filename}" exportado (${count} artículos).`, 'success');
        }}
        onItemsLoaded={handleItemsLoaded}
      />

      <InventoryItemForm
        initialIntent={formIntent}
        isOpen={formOpen}
        item={activeItem}
        onClose={() => setFormOpen(false)}
        onDeleted={(_deletedId, descripcion) => {
          showToast(`Artículo "${descripcion}" eliminado de SQLite.`, 'danger');
        }}
        onSaved={(savedItem, mode) => {
          showToast(
            mode === 'create'
              ? `Artículo "${savedItem.descripcion}" guardado en SQLite.`
              : `Artículo "${savedItem.descripcion}" actualizado en SQLite.`,
            'success'
          );
        }}
      />

      {toast && (
        <div
          className="fixed bottom-6 right-6 z-[60] bg-inverse-surface text-inverse-on-surface px-space-lg py-space-md rounded-xl shadow-xl font-label-md text-label-md flex items-center gap-space-sm max-w-md"
          role="status"
        >
          <span
            className={`material-symbols-outlined text-[18px] ${
              toast.tone === 'danger' ? 'text-error-container' : 'text-primary-fixed'
            }`}
          >
            {toast.tone === 'danger' ? 'delete_sweep' : 'check_circle'}
          </span>
          <span>{toast.text}</span>
        </div>
      )}
    </>
  );
};

function mountInventoryApp(): void {
  const rootEl = document.getElementById('inventory-react-root');
  if (!rootEl) return;

  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <InventoryWorkspace />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountInventoryApp);
} else {
  mountInventoryApp();
}
