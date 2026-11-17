import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PettyCashManager } from './components/PettyCashManager.js';

interface ToastState {
  id: number;
  text: string;
  tone: 'success' | 'danger';
}

const PettyCashWorkspace: React.FC = () => {
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((text: string, tone: 'success' | 'danger' = 'success') => {
    setToast({ id: Date.now(), text, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <>
      <PettyCashManager onStatusMessage={showToast} />

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
            {toast.tone === 'danger' ? 'warning' : 'check_circle'}
          </span>
          <span>{toast.text}</span>
        </div>
      )}
    </>
  );
};

function mountPettyCashApp(): void {
  const rootEl = document.getElementById('petty-cash-react-root');
  if (!rootEl) return;

  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <PettyCashWorkspace />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountPettyCashApp);
} else {
  mountPettyCashApp();
}
