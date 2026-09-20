// src/lib/contacts/sync.ts
// ============================================================
// Bulk contact sync (used by the n8n "Leads → WACRM" workflow).
// Idempotent: finds the contact by phone (same fuzzy dedupe as the
// webhook), fills/updates e-mail, fills a missing name, and upserts
// custom-field values — writing nothing when nothing changed.
// Conflict rules: incoming e-mail / custom values win when non-empty
// and different; nothing is ever blanked; an existing human-edited
// name is never overwritten.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { ContactError, findOrCreateContact } from '@/lib/api/v1/contacts'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { CPF_CNPJ_FIELD_NAME, normalizeDocument } from '@/lib/contacts/document'

export const MAX_SYNC_CONTACTS = 100
const MAX_TEXT = 500
const MAX_FIELD_NAME = 60

export interface SyncItem {
  /** Position of this item in the original request. */
  index: number
  phone: string
  name: string | null
  email: string | null
  customFields: Record<string, string>
}

export type ParsedSync =
  | {
      ok: true
      items: SyncItem[]
      invalid: { index: number; phone: string; error: string }[]
    }
  | { ok: false; message: string }

export interface SyncResult {
  created: number
  updated: number
  unchanged: number
  failed: { index: number; phone: string; error: string }[]
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

export function parseSyncBody(body: unknown): ParsedSync {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Request body must be a JSON object' }
  }
  const contacts = (body as Record<string, unknown>).contacts
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return { ok: false, message: "'contacts' must be a non-empty array" }
  }
  if (contacts.length > MAX_SYNC_CONTACTS) {
    return { ok: false, message: `'contacts' must have at most ${MAX_SYNC_CONTACTS} items` }
  }

  const items: SyncItem[] = []
  const invalid: { index: number; phone: string; error: string }[] = []
  for (let i = 0; i < contacts.length; i++) {
    const raw = contacts[i]
    if (typeof raw !== 'object' || raw === null) {
      invalid.push({ index: i, phone: '', error: `contacts[${i}] must be an object` })
      continue
    }
    const c = raw as Record<string, unknown>
    const phone = text(c.phone, 40)
    if (!phone) {
      const rawPhone = typeof c.phone === 'string' ? c.phone.trim().slice(0, 40) : ''
      invalid.push({ index: i, phone: rawPhone, error: `contacts[${i}].phone is required` })
      continue
    }

    const customFields: Record<string, string> = {}
    const rawFields = c.custom_fields
    if (typeof rawFields === 'object' && rawFields !== null) {
      for (const [name, value] of Object.entries(rawFields as Record<string, unknown>)) {
        const fieldName = text(name, Number.MAX_SAFE_INTEGER)
        if (!fieldName || fieldName.length > MAX_FIELD_NAME) continue
        if (fieldName === CPF_CNPJ_FIELD_NAME) {
          const doc = normalizeDocument(value)
          if (doc) customFields[fieldName] = doc
          continue
        }
        const v = text(value)
        if (v) customFields[fieldName] = v
      }
    }

    items.push({ index: i, phone, name: text(c.name, 200), email: text(c.email, 320), customFields })
  }
  return { ok: true, items, invalid }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch)
}

/**
 * Resolves a custom field id (case-insensitive name match). Only the
 * CPF/CNPJ field may be created on demand; any other unknown name
 * returns null and the value is skipped.
 */
async function ensureCustomField(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  name: string,
  cache: Map<string, string>
): Promise<string | null> {
  if (name.includes('*')) return null
  const key = name.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const escaped = escapeLike(name)
  const lookup = () =>
    db
      .from('custom_fields')
      .select('id')
      .eq('account_id', accountId)
      .ilike('field_name', escaped)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

  const { data: found } = await lookup()
  if (found?.id) {
    cache.set(key, found.id as string)
    return found.id as string
  }
  if (name !== CPF_CNPJ_FIELD_NAME) return null

  const { data: created, error } = await db
    .from('custom_fields')
    .insert({ account_id: accountId, user_id: auditUserId, field_name: name, field_type: 'text' })
    .select('id')
    .single()
  if (error || !created) {
    // Lost a race against a concurrent run: re-read the winner.
    const { data: raced } = await lookup()
    if (raced?.id) {
      cache.set(key, raced.id as string)
      return raced.id as string
    }
    throw new ContactError(`Failed to create custom field '${name}'`, 500)
  }
  cache.set(key, created.id as string)
  return created.id as string
}

type Status = 'created' | 'updated' | 'unchanged'

async function syncOne(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  item: SyncItem,
  fieldCache: Map<string, string>
): Promise<Status> {
  const existing = (await findExistingContact(db, accountId, item.phone)) as
    | { id: string; name?: string | null; email?: string | null; phone?: string | null }
    | null

  let contactId: string
  let created = false
  let changed = false

  if (!existing) {
    const made = await findOrCreateContact(db, accountId, auditUserId, {
      phone: item.phone,
      name: item.name,
      email: item.email,
    })
    contactId = made.id
    created = made.created
  } else {
    contactId = existing.id
    const patch: Record<string, unknown> = {}
    if (item.email && item.email.toLowerCase() !== (existing.email ?? '').toLowerCase()) {
      patch.email = item.email
    }
    const nameIsBlank =
      !existing.name || normalizePhone(existing.name) === normalizePhone(existing.phone ?? '')
    if (item.name && nameIsBlank) patch.name = item.name
    if (Object.keys(patch).length > 0) {
      const { error } = await db
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', contactId)
        .eq('account_id', accountId)
      if (error) throw new ContactError('Failed to update contact', 500)
      changed = true
    }
  }

  for (const [name, value] of Object.entries(item.customFields)) {
    const fieldId = await ensureCustomField(db, accountId, auditUserId, name, fieldCache)
    if (!fieldId) continue
    const { data: current } = await db
      .from('contact_custom_values')
      .select('value')
      .eq('contact_id', contactId)
      .eq('custom_field_id', fieldId)
      .maybeSingle()
    if ((current?.value as string | undefined) === value) continue
    const { error } = await db
      .from('contact_custom_values')
      .upsert(
        { contact_id: contactId, custom_field_id: fieldId, value },
        { onConflict: 'contact_id,custom_field_id' }
      )
    if (error) throw new ContactError(`Failed to store custom value '${name}'`, 500)
    changed = true
  }

  return created ? 'created' : changed ? 'updated' : 'unchanged'
}

export async function applyContactSync(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  items: SyncItem[],
  invalid: { index: number; phone: string; error: string }[] = []
): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, unchanged: 0, failed: [...invalid] }
  const fieldCache = new Map<string, string>()

  for (const item of items) {
    try {
      const status = await syncOne(db, accountId, auditUserId, item, fieldCache)
      result[status] += 1
    } catch (err) {
      console.error('[contacts/sync] item failed:', item.index, err)
      result.failed.push({
        index: item.index,
        phone: item.phone,
        error: err instanceof ContactError ? err.message : 'Unexpected error',
      })
    }
  }
  return result
}
