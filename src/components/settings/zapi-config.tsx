'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  RotateCcw,
  QrCode as QrCodeIcon,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED = '••••••••••••••••';
// Poll while a QR code is on screen — Z-API doesn't document an exact
// expiry, so re-fetching regularly keeps the code from ever looking
// stale to someone scanning it.
const POLL_INTERVAL_MS = 5000;

interface SavedRow {
  zapi_instance_id: string | null;
  status: 'connected' | 'disconnected';
}

export function ZApiConfig({ onConnected }: { onConnected?: () => void }) {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading, canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saved, setSaved] = useState<SavedRow | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);

  const [instanceId, setInstanceId] = useState('');
  const [instanceToken, setInstanceToken] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [showInstanceToken, setShowInstanceToken] = useState(false);
  const [showClientToken, setShowClientToken] = useState(false);
  const [tokenEdited, setTokenEdited] = useState(false);
  const [skipWebhooks, setSkipWebhooks] = useState(false);

  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    const { data } = await supabase
      .from('whatsapp_config')
      .select('zapi_instance_id, status')
      .eq('account_id', acctId)
      .eq('provider', 'zapi')
      .maybeSingle();

    if (data) {
      setSaved(data);
      setInstanceId(data.zapi_instance_id || '');
      setInstanceToken(MASKED);
      setClientToken(MASKED);
      setTokenEdited(false);
      setConnected(data.status === 'connected');
    } else {
      setSaved(null);
      setInstanceId('');
      setInstanceToken('');
      setClientToken('');
      setTokenEdited(false);
      setConnected(false);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, accountId, fetchConfig]);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/zapi/status');
      const data = await res.json();
      if (!res.ok) return;
      if (data.connected) {
        setConnected(true);
        setConnectedPhone(data.phone ?? null);
        setQrCode(null);
        onConnected?.();
        toast.success(t('zapiConnected'));
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch {
      // Transient network blip — the next tick tries again.
    }
  }, [onConnected, t]);

  const fetchQrCode = useCallback(async () => {
    setQrLoading(true);
    setQrError(null);
    try {
      const res = await fetch('/api/whatsapp/zapi/qrcode');
      const data = await res.json();
      if (!res.ok) {
        setQrError(data.error || t('zapiQrFailed'));
        return;
      }
      if (data.connected) {
        setConnected(true);
        onConnected?.();
        return;
      }
      setQrCode(data.qr_code ?? null);
    } catch {
      setQrError(t('zapiQrFailed'));
    } finally {
      setQrLoading(false);
    }
  }, [onConnected, t]);

  // While saved-but-not-connected, keep the QR code fresh and poll for
  // the phone to finish pairing. Stops as soon as we're connected, or
  // when the component unmounts (leaving Settings).
  useEffect(() => {
    if (!saved || connected) return;
    fetchQrCode();
    const qrTimer = setInterval(fetchQrCode, POLL_INTERVAL_MS);
    pollRef.current = setInterval(pollStatus, POLL_INTERVAL_MS);
    return () => {
      clearInterval(qrTimer);
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, connected]);

  async function handleSave() {
    if (!instanceId.trim()) {
      toast.error(t('zapiInstanceIdRequired'));
      return;
    }
    if (!tokenEdited && !saved) {
      toast.error(t('zapiTokensRequired'));
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const payload: Record<string, string | boolean> = { instance_id: instanceId.trim() };
      if (tokenEdited) {
        payload.instance_token = instanceToken.trim();
        payload.client_token = clientToken.trim();
        if (skipWebhooks) payload.skip_webhook_registration = true;
      } else if (!saved) {
        toast.error(t('zapiTokensRequired'));
        setSaving(false);
        return;
      } else {
        toast.error(t('zapiReenterTokens'));
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/zapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        setSaveError(data.error || t('saveFailed'));
        toast.error(data.error || t('saveFailed'), { duration: 10000 });
        return;
      }

      toast.success(data.connected ? t('zapiConnected') : t('zapiSavedAwaitingScan'));
      // Best-effort webhook registration — credentials are saved either
      // way, but delivery/read receipts silently won't update if the
      // status webhook didn't register. Surface it rather than letting
      // the operator discover it later as "receipts never move."
      if (data.status_webhook_error) {
        toast.warning(t('zapiStatusWebhookWarning'), { duration: 12000 });
      }
      if (accountId) await fetchConfig(accountId);
    } catch {
      setSaveError(t('saveFailed'));
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm(t('resetConfirm'))) return;
    setResetting(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('resetFailed'));
        return;
      }
      toast.success(t('resetDone'));
      setSaved(null);
      setInstanceId('');
      setInstanceToken('');
      setClientToken('');
      setTokenEdited(false);
      setConnected(false);
      setQrCode(null);
    } catch {
      toast.error(t('resetFailed'));
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead title={t('zapiTitle')} description={t('zapiDescription')} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        {saveError && (
          <Alert className="bg-red-950/30 border-red-700/50">
            <XCircle className="size-4 text-red-400" />
            <AlertTitle className="text-red-200">{t('lastSaveFailed')}</AlertTitle>
            <AlertDescription className="text-red-100/80 text-sm">{saveError}</AlertDescription>
          </Alert>
        )}

        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connected ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connected ? t('zapiConnectedTitle') : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connected
              ? t('zapiConnectedDesc', { phone: connectedPhone || '' })
              : t('zapiNotConnectedDesc')}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('zapiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('zapiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('zapiInstanceId')}</Label>
              <Input
                placeholder={t('zapiInstanceIdPlaceholder')}
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('zapiInstanceToken')}</Label>
              <div className="relative">
                <Input
                  type={showInstanceToken ? 'text' : 'password'}
                  placeholder={t('zapiInstanceTokenPlaceholder')}
                  value={instanceToken}
                  onChange={(e) => {
                    setInstanceToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (instanceToken === MASKED) {
                      setInstanceToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowInstanceToken(!showInstanceToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showInstanceToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('zapiClientToken')}</Label>
              <div className="relative">
                <Input
                  type={showClientToken ? 'text' : 'password'}
                  placeholder={t('zapiClientTokenPlaceholder')}
                  value={clientToken}
                  onChange={(e) => {
                    setClientToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (clientToken === MASKED) {
                      setClientToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowClientToken(!showClientToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showClientToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('zapiClientTokenHint')}</p>
            </div>

            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={skipWebhooks}
                onCheckedChange={(v) => setSkipWebhooks(v === true)}
                className="mt-0.5"
              />
              <span>
                {t('zapiSkipWebhooks')}
                <span className="block text-xs">{t('zapiSkipWebhooksHint')}</span>
              </span>
            </label>
          </CardContent>
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button onClick={handleSave} disabled={saving || !canEditSettings}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          {saved && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base flex items-center gap-2">
              <QrCodeIcon className="size-4" />
              {t('zapiQrTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('zapiQrDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!saved ? (
              <p className="text-sm text-muted-foreground">{t('zapiQrSaveFirst')}</p>
            ) : connected ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <CheckCircle2 className="size-8 text-primary" />
                <p className="text-sm text-foreground">{t('zapiConnectedTitle')}</p>
              </div>
            ) : qrLoading && !qrCode ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-6 animate-spin text-primary" />
              </div>
            ) : qrError ? (
              <Alert className="bg-red-950/30 border-red-700/50">
                <AlertDescription className="text-red-100/80 text-sm">{qrError}</AlertDescription>
              </Alert>
            ) : qrCode ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrCode}
                alt={t('zapiQrTitle')}
                className="mx-auto w-full max-w-[240px] rounded-md border border-border bg-white p-2"
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('zapiQrUnavailable')}</p>
            )}

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developer.z-api.io/api-reference/introduction"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80"
              >
                <ExternalLink className="size-3.5" />
                {t('zapiDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
    </div>
  );
}
