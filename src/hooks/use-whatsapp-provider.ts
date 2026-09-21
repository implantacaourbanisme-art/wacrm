'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { getAccountWhatsAppProvider } from '@/lib/whatsapp/account-provider';

export interface WhatsAppProviderState {
  /** 'meta' | 'zapi', or null while unknown / no connection. */
  provider: 'meta' | 'zapi' | null;
  /** True until the first lookup for the current account has settled. */
  loading: boolean;
}

/** The account's WhatsApp provider plus a `loading` flag for first render. */
export function useWhatsAppProviderState(): WhatsAppProviderState {
  const { accountId } = useAuth();
  const [state, setState] = useState<WhatsAppProviderState>({
    provider: null,
    loading: true,
  });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    getAccountWhatsAppProvider(createClient(), accountId)
      .then((p) => {
        if (!cancelled) setState({ provider: p, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ provider: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return state;
}

/** The account's WhatsApp provider ('meta' | 'zapi'), or null while unknown. */
export function useWhatsAppProvider(): 'meta' | 'zapi' | null {
  return useWhatsAppProviderState().provider;
}
