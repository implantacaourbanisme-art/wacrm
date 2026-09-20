// src/lib/contacts/sync.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  fieldRow: null as null | { id: string },
  currentValue: null as null | { value: string },
  contactUpdates: [] as Record<string, unknown>[],
  fieldInserts: [] as Record<string, unknown>[],
  valueUpserts: [] as Record<string, unknown>[],
  fieldSelectEq: [] as unknown[][],
  contactEq: [] as unknown[][],
  fieldIlike: [] as unknown[][],
}))

vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: vi.fn() }))
vi.mock('@/lib/api/v1/contacts', () => {
  class ContactError extends Error {
    status: number
    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  }
  return { ContactError, findOrCreateContact: vi.fn() }
})

import { findExistingContact } from '@/lib/contacts/dedupe'
import { ContactError, findOrCreateContact } from '@/lib/api/v1/contacts'
import { applyContactSync, parseSyncBody, MAX_SYNC_CONTACTS } from './sync'

function makeDb(): any {
  return {
    from(table: string) {
      let op = 'select'
      let payload: unknown
      const result = () => {
        if (table === 'contacts' && op === 'update') {
          h.contactUpdates.push(payload as Record<string, unknown>)
          return { data: null, error: null }
        }
        if (table === 'custom_fields' && op === 'select') return { data: h.fieldRow, error: null }
        if (table === 'custom_fields' && op === 'insert') {
          h.fieldInserts.push(payload as Record<string, unknown>)
          return { data: { id: 'field-new' }, error: null }
        }
        if (table === 'contact_custom_values' && op === 'select') {
          return { data: h.currentValue, error: null }
        }
        if (table === 'contact_custom_values' && op === 'upsert') {
          h.valueUpserts.push(payload as Record<string, unknown>)
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      const proxy: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
            }
            return (...args: unknown[]) => {
              if (['insert', 'update', 'upsert'].includes(prop)) {
                op = prop
                payload = args[0]
              }
              if (prop === 'eq' && table === 'custom_fields') h.fieldSelectEq.push(args)
              if (prop === 'eq' && table === 'contacts') h.contactEq.push(args)
              if (prop === 'ilike' && table === 'custom_fields') h.fieldIlike.push(args)
              return proxy
            }
          },
        }
      )
      return proxy
    },
  }
}

const item = {
  index: 0,
  phone: '+558296004382',
  name: 'Mickael',
  email: 'novo@x.com',
  customFields: { 'CPF/CNPJ': '52998224725' },
}

beforeEach(() => {
  h.fieldRow = { id: 'field1' }
  h.currentValue = null
  h.contactUpdates.length = 0
  h.fieldInserts.length = 0
  h.valueUpserts.length = 0
  h.fieldSelectEq.length = 0
  h.contactEq.length = 0
  h.fieldIlike.length = 0
  vi.mocked(findExistingContact).mockReset()
  vi.mocked(findOrCreateContact).mockReset()
})

describe('parseSyncBody', () => {
  it('accepts a batch and normalizes fields', () => {
    const r = parseSyncBody({
      contacts: [
        { phone: ' +558296004382 ', name: ' Ana ', email: ' A@B.com ', custom_fields: { 'CPF/CNPJ': '529.982.247-25' } },
      ],
    })
    expect(r).toEqual({
      ok: true,
      invalid: [],
      items: [
        { index: 0, phone: '+558296004382', name: 'Ana', email: 'A@B.com', customFields: { 'CPF/CNPJ': '52998224725' } },
      ],
    })
  })
  it('drops an invalid CPF/CNPJ but keeps the contact', () => {
    const r = parseSyncBody({ contacts: [{ phone: '5582', custom_fields: { 'CPF/CNPJ': '123' } }] })
    expect(r).toEqual({
      ok: true,
      invalid: [],
      items: [{ index: 0, phone: '5582', name: null, email: null, customFields: {} }],
    })
  })
  it('ignores empty custom field values', () => {
    const r = parseSyncBody({ contacts: [{ phone: '5582', custom_fields: { Outro: '  ' } }] })
    expect(r).toEqual({
      ok: true,
      invalid: [],
      items: [{ index: 0, phone: '5582', name: null, email: null, customFields: {} }],
    })
  })
  it('rejects a bad body and an empty or oversized batch', () => {
    expect(parseSyncBody(null).ok).toBe(false)
    expect(parseSyncBody({}).ok).toBe(false)
    expect(parseSyncBody({ contacts: [] }).ok).toBe(false)
    const many = Array.from({ length: MAX_SYNC_CONTACTS + 1 }, () => ({ phone: '5582' }))
    expect(parseSyncBody({ contacts: many }).ok).toBe(false)
  })
  it('puts items without phone / non-objects in invalid, keeping request indexes', () => {
    const r = parseSyncBody({ contacts: [{ name: 'x' }, { phone: '5582' }, 'oops', null] })
    expect(r).toEqual({
      ok: true,
      items: [{ index: 1, phone: '5582', name: null, email: null, customFields: {} }],
      invalid: [
        { index: 0, phone: '', error: 'contacts[0].phone is required' },
        { index: 2, phone: '', error: 'contacts[2] must be an object' },
        { index: 3, phone: '', error: 'contacts[3] must be an object' },
      ],
    })
  })
  it('skips (does not truncate) custom field names longer than the limit', () => {
    const r = parseSyncBody({
      contacts: [{ phone: '5582', custom_fields: { ['x'.repeat(61)]: 'v', Ok: 'v' } }],
    }) as any
    expect(r.items[0].customFields).toEqual({ Ok: 'v' })
  })
})

describe('applyContactSync', () => {
  it('creates an unknown contact and stores the CPF/CNPJ custom value', async () => {
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockResolvedValue({ id: 'c1', created: true })
    const r = await applyContactSync(makeDb(), 'acc1', 'owner1', [item])
    expect(findOrCreateContact).toHaveBeenCalledWith(expect.anything(), 'acc1', 'owner1', {
      phone: '+558296004382',
      name: 'Mickael',
      email: 'novo@x.com',
    })
    expect(h.valueUpserts[0]).toEqual({ contact_id: 'c1', custom_field_id: 'field1', value: '52998224725' })
    expect(r).toEqual({ created: 1, updated: 0, unchanged: 0, failed: [] })
  })

  it('creates the custom field (scoped to the account) when it does not exist yet', async () => {
    h.fieldRow = null
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockResolvedValue({ id: 'c1', created: true })
    await applyContactSync(makeDb(), 'acc1', 'owner1', [item])
    expect(h.fieldInserts[0]).toEqual({
      account_id: 'acc1',
      user_id: 'owner1',
      field_name: 'CPF/CNPJ',
      field_type: 'text',
    })
    expect(h.valueUpserts[0]).toMatchObject({ custom_field_id: 'field-new' })
    expect(h.fieldSelectEq).toContainEqual(['account_id', 'acc1'])
  })

  it('updates a changed e-mail and fills a phone-only name, never touching an edited name', async () => {
    vi.mocked(findExistingContact).mockResolvedValue({
      id: 'c1', name: '558296004382', email: 'velho@x.com', phone: '558296004382',
    } as any)
    let r = await applyContactSync(makeDb(), 'acc1', 'owner1', [{ ...item, customFields: {} }])
    expect(h.contactUpdates[0]).toMatchObject({ email: 'novo@x.com', name: 'Mickael' })
    expect(h.contactEq).toContainEqual(['account_id', 'acc1'])
    expect(r).toEqual({ created: 0, updated: 1, unchanged: 0, failed: [] })

    h.contactUpdates.length = 0
    vi.mocked(findExistingContact).mockResolvedValue({
      id: 'c1', name: 'Amorzinho', email: 'novo@x.com', phone: '558296004382',
    } as any)
    r = await applyContactSync(makeDb(), 'acc1', 'owner1', [{ ...item, customFields: {} }])
    expect(h.contactUpdates).toHaveLength(0)
    expect(r).toEqual({ created: 0, updated: 0, unchanged: 1, failed: [] })
  })

  it('never blanks an existing e-mail when the incoming one is empty', async () => {
    vi.mocked(findExistingContact).mockResolvedValue({
      id: 'c1', name: 'Amorzinho', email: 'velho@x.com', phone: '558296004382',
    } as any)
    await applyContactSync(makeDb(), 'acc1', 'owner1', [{ ...item, email: null, customFields: {} }])
    expect(h.contactUpdates).toHaveLength(0)
  })

  it('skips the upsert when the custom value is already identical', async () => {
    h.currentValue = { value: '52998224725' }
    vi.mocked(findExistingContact).mockResolvedValue({
      id: 'c1', name: 'Amorzinho', email: 'novo@x.com', phone: '558296004382',
    } as any)
    const r = await applyContactSync(makeDb(), 'acc1', 'owner1', [item])
    expect(h.valueUpserts).toHaveLength(0)
    expect(r.unchanged).toBe(1)
  })

  it('isolates a failing item and keeps going', async () => {
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact)
      .mockRejectedValueOnce(new ContactError("'phone' must be a valid phone number", 400))
      .mockResolvedValueOnce({ id: 'c2', created: true })
    const r = await applyContactSync(makeDb(), 'acc1', 'owner1', [
      { ...item, phone: 'bad' },
      { ...item, phone: '+558296004383' },
    ])
    expect(r.created).toBe(1)
    expect(r.failed).toEqual([
      { index: 0, phone: 'bad', error: "'phone' must be a valid phone number" },
    ])
  })

  it('one bad item does not stop the good ones and is reported with its request index', async () => {
    const parsed = parseSyncBody({ contacts: [{ name: 'no phone' }, { phone: '+558296004383' }] })
    if (!parsed.ok) throw new Error('should be ok')
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockResolvedValue({ id: 'c2', created: true })
    const r = await applyContactSync(makeDb(), 'acc1', 'owner1', parsed.items, parsed.invalid)
    expect(r.created).toBe(1)
    expect(r.failed).toEqual([{ index: 0, phone: '', error: 'contacts[0].phone is required' }])
  })

  it('reports item failures with the original request index', async () => {
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockRejectedValueOnce(new ContactError('boom', 400))
    const r = await applyContactSync(makeDb(), 'acc1', 'owner1', [{ ...item, index: 5 }])
    expect(r.failed).toEqual([{ index: 5, phone: item.phone, error: 'boom' }])
  })

  it('never creates a custom field other than CPF/CNPJ and skips its value', async () => {
    h.fieldRow = null
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockResolvedValue({ id: 'c1', created: true })
    const r = await applyContactSync(makeDb(), 'acc1', 'owner1', [
      { ...item, customFields: { Desconhecido: 'x' } },
    ])
    expect(h.fieldInserts).toHaveLength(0)
    expect(h.valueUpserts).toHaveLength(0)
    expect(r).toEqual({ created: 1, updated: 0, unchanged: 0, failed: [] })
  })

  it('reuses an existing field regardless of case (ilike, no insert)', async () => {
    h.fieldRow = { id: 'field-lower' }
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockResolvedValue({ id: 'c1', created: true })
    await applyContactSync(makeDb(), 'acc1', 'owner1', [
      { ...item, customFields: { 'cpf/cnpj': '52998224725' } },
    ])
    expect(h.fieldInserts).toHaveLength(0)
    expect(h.fieldIlike).toContainEqual(['field_name', 'cpf/cnpj'])
    expect(h.valueUpserts[0]).toMatchObject({ custom_field_id: 'field-lower' })
  })

  it('escapes LIKE wildcards in the field name lookup', async () => {
    h.fieldRow = { id: 'f' }
    vi.mocked(findExistingContact).mockResolvedValue(null)
    vi.mocked(findOrCreateContact).mockResolvedValue({ id: 'c1', created: true })
    await applyContactSync(makeDb(), 'acc1', 'owner1', [
      { ...item, customFields: { 'a_b%c': 'x' } },
    ])
    expect(h.fieldIlike).toContainEqual(['field_name', 'a\\_b\\%c'])
  })
})
