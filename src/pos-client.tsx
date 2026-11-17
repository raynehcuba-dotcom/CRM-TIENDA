import React from 'react';
import { createRoot } from 'react-dom/client';
import { SalesForm, type RecordedSaleReceipt } from './components/SalesForm.js';

declare global {
  interface Window {
    refreshPosShiftStats?: () => Promise<void> | void;
    onReactSaleRecorded?: (receipt: RecordedSaleReceipt) => void;
  }
}

function mountPosSalesForm(): void {
  const rootEl = document.getElementById('pos-sales-root');
  if (!rootEl) return;

  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <SalesForm
        onSaleRecorded={(receipt) => {
          if (typeof window.onReactSaleRecorded === 'function') {
            window.onReactSaleRecorded(receipt);
          }
          if (typeof window.refreshPosShiftStats === 'function') {
            void window.refreshPosShiftStats();
          }
        }}
        onShiftDataLoaded={() => {
          if (typeof window.refreshPosShiftStats === 'function') {
            void window.refreshPosShiftStats();
          }
        }}
      />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountPosSalesForm);
} else {
  mountPosSalesForm();
}
