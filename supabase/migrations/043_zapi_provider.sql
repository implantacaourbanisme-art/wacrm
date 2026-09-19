-- ============================================================
-- whatsapp_config: add Z-API as a second connection provider
--
-- Until now `whatsapp_config` assumed every row was a Meta Cloud API
-- connection (`phone_number_id` + `access_token` both NOT NULL). This
-- adds a `provider` discriminator column and a parallel set of
-- nullable Z-API columns, so the same one-row-per-account table now
-- serves both providers — an account picks exactly one, matching the
-- existing UNIQUE(account_id).
--
-- Z-API is not a WhatsApp Business Account: it automates a regular
-- WhatsApp Web session paired by QR code, addressed by an
-- `instance_id` instead of a `phone_number_id`, and authenticated
-- with two credentials instead of one:
--   - the instance token (embedded in every REST call's URL)
--   - the account-level "Client-Token" security token (sent as a
--     header on every call, and used to validate inbound webhooks —
--     Z-API has no HMAC-signed-payload scheme like Meta's).
-- Both are stored encrypted at rest with the same AES-GCM helper
-- already used for Meta's `access_token` (see src/lib/whatsapp/encryption.ts).
--
-- Default `provider = 'meta'` means every existing row is classified
-- as Meta automatically and the new CHECK constraint is satisfied by
-- their current data (phone_number_id + access_token already NOT
-- NULL) — zero behavior change for accounts already connected via
-- Meta.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Discriminator column. Existing rows default to 'meta'.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'zapi'));
  END IF;
END $$;

-- 2. Z-API columns. All nullable — only populated for provider='zapi'.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS zapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS zapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS zapi_client_token TEXT,
  ADD COLUMN IF NOT EXISTS zapi_connected_at TIMESTAMPTZ;

-- One wacrm account can claim one Z-API instance. Mirrors the
-- phone_number_id UNIQUE constraint from migration 013 — the inbound
-- webhook will do the same "resolve tenancy by this id" lookup Z-API
-- side. Postgres UNIQUE allows multiple NULLs, so Meta-provider rows
-- (which never set this column) never conflict with each other.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_zapi_instance_id_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_zapi_instance_id_key
      UNIQUE (zapi_instance_id);
  END IF;
END $$;

-- 3. Relax the Meta-only NOT NULLs so a zapi row can omit them.
--    DROP NOT NULL is a no-op (does not error) if already nullable,
--    so this is safe to re-run.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- 4. Require the right credentials for whichever provider is chosen.
--    Existing Meta rows already satisfy the left branch (both columns
--    were NOT NULL before step 3), so this never fails on old data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_check
      CHECK (
        (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
        OR
        (provider = 'zapi' AND zapi_instance_id IS NOT NULL AND zapi_instance_token IS NOT NULL)
      );
  END IF;
END $$;
