import React from 'react';
import { createRoot } from 'react-dom/client';
import { SupplierManager, type SupplierRecord } from './components/SupplierManager.js';

declare global {
  interface Window {
    loadProvidersFromSqlite?: () => Promise<void> | void;
    focusPaymentForm?: (providerKey: string | number, amount: number) => void;
  }
}

function mountSuppliersManager(): void {
  const rootEl = document.getElementById('suppliers-manager-root');
  if (!rootEl) return;

  createRoot(rootEl).render(
    <React.StrictMode>
      <SupplierManager
        onPaySupplier={(supplier: SupplierRecord) => {
          if (typeof window.focusPaymentForm === 'function') {
            window.focusPaymentForm(supplier.id, supplier.saldo_pendiente_efectivo);
          }
        }}
        onSuppliersChanged={() => {
          if (typeof window.loadProvidersFromSqlite === 'function') {
            void window.loadProvidersFromSqlite();
          }
        }}
      />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountSuppliersManager);
} else {
  mountSuppliersManager();
}
