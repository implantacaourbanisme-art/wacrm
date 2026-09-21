'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { getAccountWhatsAppProvider } from '@/lib/whatsapp/provider';

/** The account's WhatsApp provider ('meta' | 'zapi'), or null while unknown. */
export function useWhatsAppProvider(): 'meta' | 'zapi' | null {
  const { accountId } = useAuth();
  const [provider, setProvider] = useState<'meta' | 'zapi' | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    getAccountWhatsAppProvider(createClient(), accountId)
      .then((p) => {
        if (!cancelled) setProvider(p);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return provider;
}
