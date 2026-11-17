export type ThresholdMode = 'item' | 'fixed';

export interface ThresholdConfig {
  mode: ThresholdMode;
  fixedMinimum: number;
}

const STORAGE_KEY = 'nexus_inventory_threshold_v1';
export const THRESHOLD_CHANGED_EVENT = 'inventory:threshold-changed';

export const DEFAULT_THRESHOLD_CONFIG: ThresholdConfig = {
  mode: 'item',
  fixedMinimum: 25,
};

export function sanitizeThresholdValue(value: number, fallback = 25): number {
  if (!Number.isFinite(value) || Number.isNaN(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function getStoredThresholdConfig(): ThresholdConfig {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_THRESHOLD_CONFIG;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THRESHOLD_CONFIG;
    const parsed = JSON.parse(raw) as Partial<ThresholdConfig>;
    const mode: ThresholdMode = parsed.mode === 'fixed' ? 'fixed' : 'item';
    const fixedMinimum = sanitizeThresholdValue(Number(parsed.fixedMinimum), 25);
    return { mode, fixedMinimum };
  } catch {
    return DEFAULT_THRESHOLD_CONFIG;
  }
}

export function saveThresholdConfig(config: ThresholdConfig, notify = true): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    const normalized: ThresholdConfig = {
      mode: config.mode === 'fixed' ? 'fixed' : 'item',
      fixedMinimum: sanitizeThresholdValue(config.fixedMinimum, 25),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    if (notify) {
      window.dispatchEvent(new CustomEvent(THRESHOLD_CHANGED_EVENT, { detail: normalized }));
    }
  } catch {
    // Ignore storage quota or private-mode restriction errors
  }
}
