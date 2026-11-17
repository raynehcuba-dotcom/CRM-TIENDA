import React from 'react';
import { createRoot } from 'react-dom/client';
import { DailySummaryPopup } from './components/DailySummaryPopup.js';

declare global {
  interface Window {
    openDailySummaryPopup?: (date?: string, reason?: string) => void;
  }
}

function mountDailySummaryPopup(): void {
  let rootEl = document.getElementById('gt-daily-summary-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'gt-daily-summary-root';
    document.body.appendChild(rootEl);
  }

  window.openDailySummaryPopup = (date?: string, reason?: string) => {
    window.dispatchEvent(new CustomEvent('daily-summary:open', { detail: { date, reason } }));
  };

  createRoot(rootEl).render(
    <React.StrictMode>
      <DailySummaryPopup />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountDailySummaryPopup);
} else {
  mountDailySummaryPopup();
}
