import React from 'react';
import { createRoot } from 'react-dom/client';
import { RestockPrioritySummary } from './components/RestockPrioritySummary.js';
import { WeeklySalesChart } from './components/WeeklySalesChart.js';

declare global {
  interface Window {
    loadDashboardData?: () => Promise<void> | void;
  }
}

function mountDashboardWidgets(): void {
  const restockRootEl = document.getElementById('dashboard-restock-root');
  if (restockRootEl) {
    createRoot(restockRootEl).render(
      <React.StrictMode>
        <RestockPrioritySummary
          apiEndpoint="/api/productos"
          onRestockSuccess={() => {
            if (typeof window.loadDashboardData === 'function') {
              void window.loadDashboardData();
            }
          }}
        />
      </React.StrictMode>
    );
  }

  const weeklyChartRootEl = document.getElementById('dashboard-weekly-sales-chart-root');
  if (weeklyChartRootEl) {
    createRoot(weeklyChartRootEl).render(
      <React.StrictMode>
        <WeeklySalesChart apiEndpoint="/api/dashboard/weekly-sales" />
      </React.StrictMode>
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountDashboardWidgets);
} else {
  mountDashboardWidgets();
}
