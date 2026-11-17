import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrintableLowStockReport } from './components/PrintableLowStockReport.js';

function mountLowStockReportApp(): void {
  const rootEl = document.getElementById('low-stock-report-root');
  if (!rootEl) return;

  createRoot(rootEl).render(
    <React.StrictMode>
      <PrintableLowStockReport apiEndpoint="/api/productos" />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountLowStockReportApp);
} else {
  mountLowStockReportApp();
}
