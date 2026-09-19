'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare, QrCode, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { ZApiConfig } from './zapi-config';

type Provider = 'meta' | 'zapi';

/**
 * Top-level WhatsApp connection settings: lets the account pick which
 * provider to connect through, then renders that provider's own panel
 * unmodified — `WhatsAppConfig` (Meta) is untouched by this addition,
 * `ZApiConfig` is new. One provider per account (mirrors the existing
 * UNIQUE(account_id) on whatsapp_config) — switching overwrites the
 * other provider's saved credentials, which the warning banner below
 * calls out before it happens.
 */
export function WhatsAppConnectionSettings() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [savedProvider, setSavedProvider] = useState<Provider | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider>('meta');
  const loadedAccountIdRef = useRef<string | null>(null);

  const loadProvider = useCallback(async (acctId: string) => {
    setLoading(true);
    const { data } = await supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', acctId)
      .maybeSingle();
    const provider = (data?.provider as Provider | undefined) ?? null;
    setSavedProvider(provider);
    setSelectedProvider(provider ?? 'meta');
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId) {
      loadedAccountIdRef.current = null;
      // Legitimate sync with auth state clearing, not a derived value
      // — same pattern already accepted elsewhere in this codebase
      // (see pipelines/page.tsx).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    loadProvider(accountId);
  }, [authLoading, profileLoading, accountId, loadProvider]);

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const switchingAway = savedProvider !== null && savedProvider !== selectedProvider;

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setSelectedProvider('meta')}
          className={pickerCardClass(selectedProvider === 'meta')}
        >
          <MessageSquare className="size-5 shrink-0 text-primary" />
          <div>
            <p className="font-medium text-foreground">{t('providerMetaTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('providerMetaDesc')}</p>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setSelectedProvider('zapi')}
          className={pickerCardClass(selectedProvider === 'zapi')}
        >
          <QrCode className="size-5 shrink-0 text-primary" />
          <div>
            <p className="font-medium text-foreground">{t('providerZapiTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('providerZapiDesc')}</p>
          </div>
        </button>
      </div>

      {switchingAway && (
        <Alert className="bg-amber-950/30 border-amber-700/50">
          <AlertTitle className="text-amber-200">{t('providerSwitchWarningTitle')}</AlertTitle>
          <AlertDescription className="text-amber-100/80 text-sm">
            {t('providerSwitchWarningDesc')}
          </AlertDescription>
        </Alert>
      )}

      {selectedProvider === 'meta' ? (
        <WhatsAppConfig />
      ) : (
        <ZApiConfig onConnected={() => setSavedProvider('zapi')} />
      )}
    </section>
  );
}

function pickerCardClass(active: boolean): string {
  const base = 'flex items-start gap-3 rounded-lg border p-4 text-left transition-colors';
  return active
    ? `${base} border-primary bg-primary/5`
    : `${base} border-border hover:bg-muted`;
}
