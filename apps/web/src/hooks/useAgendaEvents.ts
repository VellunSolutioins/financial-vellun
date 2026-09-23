'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface AgendaEvent {
  id: string;
  title: string;
  description?: string | null;
  eventDate: string;
  eventTime?: string | null;
  color?: string | null;
}

export function useAgendaEvents(month: string) {
  const [data, setData] = useState<AgendaEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const events = await apiClient.get<AgendaEvent[]>(`/agenda-events?month=${month}`);
      setData(events);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, refetch };
}
