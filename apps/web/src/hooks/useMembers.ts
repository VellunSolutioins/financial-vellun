'use client';
import { useCallback, useEffect, useState } from 'react';

import { getInvites, getMembers, type MemberInvite, type MembersState } from '@/lib/members';

export function useMembers() {
  const [data, setData] = useState<MembersState | null>(null);
  const [invites, setInvites] = useState<MemberInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const members = await getMembers();
      setData(members);
      try {
        const pendingInvites = await getInvites();
        setInvites(pendingInvites);
      } catch {
        // Membro convidado não pode listar convites (403) — segue sem eles.
        setInvites([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, invites, loading, refetch };
}
