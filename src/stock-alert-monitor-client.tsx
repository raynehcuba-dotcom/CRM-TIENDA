import React from 'react';
import { createRoot } from 'react-dom/client';
import { StockAlertMonitor } from './components/StockAlertMonitor.js';

function mountStockAlertMonitor(): void {
  let rootEl = document.getElementById('gt-stock-alert-monitor-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'gt-stock-alert-monitor-root';
    document.body.appendChild(rootEl);
  }

  createRoot(rootEl).render(
    <React.StrictMode>
      <StockAlertMonitor />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountStockAlertMonitor);
} else {
  mountStockAlertMonitor();
}
