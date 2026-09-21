import { beforeEach, describe, expect, it, vi } from 'vitest'

// Local templates for Z-API accounts: the three template routes must skip
// Meta entirely when whatsapp_config.provider === 'zapi'.

const submitMessageTemplate = vi.fn()
const editMessageTemplate = vi.fn()
const deleteMessageTemplate = vi.fn()
const ensureMediaHeaderHandle = vi.fn()
const decrypt = vi.fn<(...a: unknown[]) => string>(() => 'token')
const fetchSpy = vi.fn()

vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: (...a: unknown[]) => submitMessageTemplate(...a),
  editMessageTemplate: (...a: unknown[]) => editMessageTemplate(...a),
  deleteMessageTemplate: (...a: unknown[]) => deleteMessageTemplate(...a),
}))
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureMediaHeaderHandle: (...a: unknown[]) => ensureMediaHeaderHandle(...a),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (...a: unknown[]) => decrypt(...a),
}))

interface State {
  provider: string | null // null => no whatsapp_config row
  existing: Record<string, unknown> | null
  upserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
  deletes: number
  filters: Array<[string, string]>
}
let state: State

function makeSupabase() {
  function builder(table: string) {
    let op: 'select' | 'upsert' | 'update' | 'delete' = 'select'
    let payload: Record<string, unknown> | null = null
    const b: Record<string, unknown> = {}
    const result = () => {
      if (table === 'whatsapp_config') {
        return state.provider === null
          ? { data: null, error: null }
          : {
              data: {
                provider: state.provider,
                waba_id: 'waba-1',
                access_token: 'enc',
              },
              error: null,
            }
      }
      if (table === 'profiles') {
        return { data: { account_id: 'acct-1' }, error: null }
      }
      if (table === 'message_templates') {
        if (op === 'upsert' || op === 'update') {
          return { data: { id: 't1', ...payload }, error: null }
        }
        if (op === 'delete') return { data: null, error: null }
        return { data: state.existing, error: null }
      }
      return { data: null, error: null }
    }
    b.select = () => b
    b.eq = (col: string, val: string) => {
      state.filters.push([`${table}.${col}`, val])
      return b
    }
    b.upsert = (row: Record<string, unknown>) => {
      op = 'upsert'
      payload = row
      state.upserts.push(row)
      return b
    }
    b.update = (row: Record<string, unknown>) => {
      op = 'update'
      payload = row
      state.updates.push(row)
      return b
    }
    b.delete = () => {
      op = 'delete'
      state.deletes++
      return b
    }
    b.single = async () => result()
    b.maybeSingle = async () => result()
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res)
    return b
  }
  return {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  }
}

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account',
  )
  return {
    ...actual,
    requireRole: async () => ({
      supabase: makeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
    }),
  }
})
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeSupabase(),
}))

import { POST as submit } from './submit/route'
import { PATCH, DELETE } from './[id]/route'
import { POST as sync } from './sync/route'

const ID = '11111111-1111-4111-8111-111111111111'
const payload = {
  name: 'promo_setembro',
  category: 'Marketing',
  language: 'pt_BR',
  body_text: 'Olá, temos uma oferta.',
}
const req = (body: unknown) =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
const ctx = { params: Promise.resolve({ id: ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN
  vi.stubGlobal('fetch', fetchSpy)
  submitMessageTemplate.mockResolvedValue({ id: 'meta-1', status: 'PENDING' })
  ensureMediaHeaderHandle.mockResolvedValue(undefined)
  editMessageTemplate.mockResolvedValue(undefined)
  deleteMessageTemplate.mockResolvedValue(undefined)
  state = {
    provider: 'zapi',
    existing: null,
    upserts: [],
    updates: [],
    deletes: 0,
    filters: [],
  }
})

describe('POST /templates/submit', () => {
  it('zapi: stores APPROVED locally, no Meta contact', async () => {
    const res = await submit(req(payload))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.local).toBe(true)
    expect(json.dry_run).toBe(false)
    expect(json.template.status).toBe('APPROVED')
    expect(state.upserts).toHaveLength(1)
    expect(state.upserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      status: 'APPROVED',
      meta_template_id: null,
      submission_error: null,
    })
    expect(submitMessageTemplate).not.toHaveBeenCalled()
    expect(ensureMediaHeaderHandle).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    expect(state.filters).toContainEqual(['whatsapp_config.account_id', 'acct-1'])
  })

  it('zapi: still validates the payload', async () => {
    const res = await submit(req({ ...payload, name: 'Nome Invalido' }))
    expect(res.status).toBe(400)
    expect(state.upserts).toHaveLength(0)
  })

  it('meta: unchanged, submits to Meta', async () => {
    state.provider = 'meta'
    const res = await submit(req(payload))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(submitMessageTemplate).toHaveBeenCalledTimes(1)
    expect(json.local).toBeUndefined()
    expect(state.upserts[0]).toMatchObject({
      status: 'PENDING',
      meta_template_id: 'meta-1',
    })
  })

  it('dry-run: unchanged for non-zapi accounts', async () => {
    state.provider = 'meta'
    process.env.WHATSAPP_TEMPLATES_DRY_RUN = 'true'
    const res = await submit(req(payload))
    const json = await res.json()
    expect(json.dry_run).toBe(true)
    expect(submitMessageTemplate).not.toHaveBeenCalled()
    expect(String(state.upserts[0].meta_template_id)).toMatch(/^dry-run-/)
    expect(state.upserts[0].status).toBe('PENDING')
  })
})

describe('PATCH /templates/[id]', () => {
  const patchReq = (b: unknown) =>
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(b) })

  it('zapi: local template (no meta id) is updated locally, stays APPROVED', async () => {
    state.existing = {
      id: ID,
      name: 'promo_setembro',
      status: 'APPROVED',
      meta_template_id: null,
      language: 'pt_BR',
    }
    const res = await PATCH(patchReq({ ...payload, body_text: 'Novo texto' }), ctx)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.template.status).toBe('APPROVED')
    expect(json.template.body_text).toBe('Novo texto')
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({
      body_text: 'Novo texto',
      status: 'APPROVED',
      submission_error: null,
      rejection_reason: null,
    })
    expect(editMessageTemplate).not.toHaveBeenCalled()
    expect(ensureMediaHeaderHandle).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('meta: row without meta_template_id is still rejected', async () => {
    state.provider = 'meta'
    state.existing = {
      id: ID,
      name: 'x',
      status: 'DRAFT',
      meta_template_id: null,
      language: 'pt_BR',
    }
    const res = await PATCH(patchReq(payload), ctx)
    expect(res.status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  it('meta: edit goes to Meta and status flips to PENDING', async () => {
    state.provider = 'meta'
    state.existing = {
      id: ID,
      name: 'x',
      status: 'APPROVED',
      meta_template_id: 'meta-9',
      language: 'pt_BR',
    }
    const res = await PATCH(patchReq(payload), ctx)
    expect(res.status).toBe(200)
    expect(editMessageTemplate).toHaveBeenCalledTimes(1)
    expect(state.updates[0].status).toBe('PENDING')
  })
})

describe('DELETE /templates/[id]', () => {
  it('zapi: local template deletes locally without Meta', async () => {
    state.existing = { id: ID, name: 'promo_setembro', meta_template_id: null }
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx)
    expect(res.status).toBe(200)
    expect(state.deletes).toBe(1)
    expect(deleteMessageTemplate).not.toHaveBeenCalled()
  })
})

describe('POST /templates/sync', () => {
  it('zapi: 400 with Portuguese message, Meta untouched', async () => {
    const res = await sync()
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toBe(
      'A sincronização com a Meta não se aplica a conexões por QR Code (Z-API).',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
  })
})
