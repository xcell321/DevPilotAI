import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import type { Health, Overview } from '../lib/types';

export interface BackendState {
  health: Health | null;
  overview: Overview | null;
  healthError: string | null;
  overviewError: string | null;
  refresh: () => Promise<void>;
}

export function useBackend(): BackendState {
  const [health, setHealth] = useState<Health | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextHealth = await apiGet<Health>('/api/health');
      setHealth(nextHealth);
      setHealthError(null);
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : 'Backend unavailable.');
    }

    try {
      const nextOverview = await apiGet<Overview>('/api/overview');
      setOverview(nextOverview);
      setOverviewError(null);
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : 'Overview unavailable.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { health, overview, healthError, overviewError, refresh };
}
