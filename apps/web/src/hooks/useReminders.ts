'use client';
import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

export interface Reminder {
  id: string;
  title: string;
  amount: number | null;
  dueDate: string;
  isRecurrent: boolean;
  recurrenceEndDate: string | null;
  status: 'pending' | 'paid';
  derivedStatus: 'paid' | 'overdue' | 'pending';
}

export function useReminders(month: string) {
  const [data, setData] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const reminders = await apiClient.get<Reminder[]>(`/reminders?month=${month}`);
      setData(reminders);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, refetch };
}
