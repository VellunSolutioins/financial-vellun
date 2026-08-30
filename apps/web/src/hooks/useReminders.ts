'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface Reminder {
  id: string;
  title: string;
  amount: number | null;
  dueDate: string;
  isRecurrent: boolean;
  status: 'pending' | 'paid';
  derivedStatus: 'paid' | 'overdue' | 'pending';
}

export function useReminders() {
  const [data, setData] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const reminders = await apiClient.get<Reminder[]>('/reminders');
      setData(reminders);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, refetch };
}
