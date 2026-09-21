/**
 * Turn a Meta Graph API failure into something a person can act on.
 *
 * Meta's error envelope is precise but terse — "(#100) Unsupported get
 * request" says nothing about *which* of the four values on the settings
 * form is wrong. This module maps `code` / `error_subcode` (plus the
 * step of the connect flow that failed) onto: a plain-English summary,
 * the form field to check, and whether the fix is on the user's side
 * (HTTP 400) or Meta's (HTTP 502). The raw code, subcode and
 * `fbtrace_id` ride along so the user can quote them to Meta support.
 *
 * Pure — no I/O, no env. Issue #505.
 *
 * Error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */

/** Which call of the connect flow failed. */
export type MetaConnectStep =
  | 'verify_number'
  | 'waba_phone_numbers'
  | 'register'
  | 'subscribe_waba'
  | 'subscribed_apps'

/** The settings-form field (or external place) the user should look at. */
export type MetaErrorField =
  | 'access_token'
  | 'phone_number_id'
  | 'waba_id'
  | 'pin'
  | 'meta_account'
  | null

/**
 * Structural shape of `MetaApiError` from ./meta-api — declared here so
 * this module stays free of I/O imports and so callers can feed it any
 * object carrying Meta's envelope fields.
 */
export interface MetaErrorLike {
  message: string
  code?: number | null
  subcode?: number | null
  type?: string | null
  fbtraceId?: string | null
  httpStatus?: number | null
  details?: string | null
}

export interface MetaErrorExplanation {
  /** Actionable, user-facing text. */
  summary: string
  field: MetaErrorField
  /** Who has to change something. Drives the HTTP status. */
  side: 'user' | 'meta'
  httpStatus: 400 | 502
  step: MetaConnectStep
  code: number | null
  subcode: number | null
  fbtraceId: string | null
  /** Meta's own message (with `error_data.details` appended when present). */
  metaMessage: string
}

/** Values the caller already knows — quoted back so the text names the id that failed. */
export interface MetaErrorContext {
  phoneNumberId?: string | null
  wabaId?: string | null
}

const STEP_LABEL: Record<MetaConnectStep, string> = {
  verify_number: 'a leitura do número de telefone',
  waba_phone_numbers: 'a listagem dos números da conta do WhatsApp Business',
  register: 'o registro do número de telefone',
  subscribe_waba: 'a inscrição da conta do WhatsApp Business no app',
  subscribed_apps: 'a leitura das inscrições da conta do WhatsApp Business',
}

const TOKEN_HINT =
  'Gere um token permanente em Configurações do Meta Business → Usuários do sistema → Gerar token, ' +
  'com as permissões whatsapp_business_management e whatsapp_business_messaging, ' +
  'e cole em Token de acesso permanente.'

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056])
const TEMPORARY_CODES = new Set([1, 2, 131000, 133004, 133016])

function isMetaErrorLike(err: unknown): err is MetaErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    ('code' in err || 'fbtraceId' in err || 'httpStatus' in err)
  )
}

/** Which id the failing step was addressing — and the field it lives in. */
function objectForStep(
  step: MetaConnectStep,
  ctx: MetaErrorContext,
): { field: MetaErrorField; noun: string; id: string | null } {
  if (step === 'verify_number' || step === 'register') {
    return { field: 'phone_number_id', noun: 'ID do número de telefone', id: ctx.phoneNumberId ?? null }
  }
  return { field: 'waba_id', noun: 'ID da conta do WhatsApp Business', id: ctx.wabaId ?? null }
}

function withId(noun: string, id: string | null): string {
  return id ? `${noun} ${id}` : `o ${noun}`
}

/**
 * Explain any error thrown while talking to Meta during the connect flow.
 * Non-Meta errors (network failures, unexpected throws) get a generic
 * Meta-side explanation so the route never has to special-case them.
 */
export function explainMetaError(
  err: unknown,
  step: MetaConnectStep,
  ctx: MetaErrorContext = {},
): MetaErrorExplanation {
  if (!isMetaErrorLike(err)) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      summary:
        `Não foi possível acessar a API Graph da Meta durante ${STEP_LABEL[step]}: ${message}. ` +
        'Verifique se este servidor tem acesso à internet para graph.facebook.com e tente novamente.',
      field: null,
      side: 'meta',
      httpStatus: 502,
      step,
      code: null,
      subcode: null,
      fbtraceId: null,
      metaMessage: message,
    }
  }

  const code = err.code ?? null
  const subcode = err.subcode ?? null
  const fbtraceId = err.fbtraceId ?? null
  const metaMessage = err.details ? `${err.message} (${err.details})` : err.message
  const target = objectForStep(step, ctx)

  const build = (
    summary: string,
    field: MetaErrorField,
    side: 'user' | 'meta',
  ): MetaErrorExplanation => ({
    summary,
    field,
    side,
    httpStatus: side === 'user' ? 400 : 502,
    step,
    code,
    subcode,
    fbtraceId,
    metaMessage,
  })

  // --- Access token -----------------------------------------------------
  if (code === 190 || (code === null && err.type === 'OAuthException')) {
    const why =
      subcode === 463
        ? 'O token de acesso expirou.'
        : subcode === 460 || subcode === 467
          ? 'O token de acesso foi invalidado (troca de senha, sessão revogada ou redefinição do token).'
          : 'A Meta rejeitou o token de acesso como inválido.'
    return build(
      `${why} Tokens temporários da página de Configuração da API expiram após 24 horas. ${TOKEN_HINT}`,
      'access_token',
      'user',
    )
  }

  // --- Permissions --------------------------------------------------------
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return build(
      `O token de acesso não tem permissão para esta ação (${STEP_LABEL[step]}). ` +
        'O usuário do sistema dele precisa das permissões whatsapp_business_management e whatsapp_business_messaging ' +
        'e também precisa estar atribuído a esta conta do WhatsApp Business ' +
        '(Configurações do Business → Usuários do sistema → Adicionar ativos → Contas do WhatsApp). Depois gere um novo token.',
      'access_token',
      'user',
    )
  }

  if (code === 131005) {
    return build(
      `A Meta negou o acesso durante ${STEP_LABEL[step]}: a empresa dona do token não pode gerenciar ` +
        `${withId(target.noun, target.id)}. Atribua o usuário do sistema a esta conta do WhatsApp Business ` +
        'nas Configurações do Business e confirme que o token tem a permissão whatsapp_business_management.',
      'access_token',
      'user',
    )
  }

  // --- Wrong / foreign object ids ----------------------------------------
  const looksLikeMissingObject =
    code === 33 ||
    (code === 100 && subcode === 33) ||
    (code === 100 &&
      /unsupported (get|post) request|does not exist|cannot be loaded due to missing permissions|unknown path components/i.test(
        err.message,
      ))
  if (looksLikeMissingObject) {
    return build(
      `A Meta não encontrou ${withId(target.noun, target.id)}, ou a empresa dona do token de acesso ` +
        `não é dona dele. Copie o ${target.noun} exatamente de Meta → WhatsApp → Configuração da API e confirme que o ` +
        'token foi gerado no mesmo portfólio de negócios.',
      target.field,
      'user',
    )
  }

  if (code === 100) {
    if (step === 'register' && /pin/i.test(err.message)) {
      return build(
        `A Meta rejeitou o PIN da verificação em duas etapas: ${err.message}. Informe o PIN de 6 dígitos definido em ` +
          'Gerenciador do WhatsApp → Números de telefone → Verificação em duas etapas.',
        'pin',
        'user',
      )
    }
    return build(
      `A Meta rejeitou um parâmetro durante ${STEP_LABEL[step]}: ${err.message}. Confira se o ` +
        `${target.noun} foi copiado exatamente (somente dígitos, sem espaços).`,
      target.field,
      'user',
    )
  }

  // --- Registration / PIN --------------------------------------------------
  if (code === 133010) {
    return build(
      'Este número de telefone ainda não está registrado na Cloud API do WhatsApp. Informe abaixo o PIN da ' +
        'verificação em duas etapas e salve novamente para o wacrm registrá-lo (POST /register).',
      'pin',
      'user',
    )
  }
  if (code === 133005 || code === 136025) {
    return build(
      'O PIN da verificação em duas etapas está errado. Use o PIN de 6 dígitos definido em Gerenciador do WhatsApp → ' +
        'Números de telefone → Verificação em duas etapas (ou redefina-o lá) e salve novamente.',
      'pin',
      'user',
    )
  }
  if (code === 133008 || code === 133009) {
    return build(
      'A Meta bloqueou temporariamente as tentativas de PIN deste número após muitos erros. ' +
        'Aguarde um pouco antes de salvar novamente com o PIN correto.',
      'pin',
      'meta',
    )
  }
  if (code === 133006) {
    return build(
      'A Meta exige que este número de telefone seja verificado novamente. Abra Gerenciador do WhatsApp → Números de telefone, ' +
        'conclua a verificação (SMS ou chamada de voz) e salve novamente.',
      'meta_account',
      'meta',
    )
  }
  if (code === 133015) {
    return build(
      'Este número foi excluído recentemente do WhatsApp e ainda não pode ser registrado. ' +
        'A Meta bloqueia um novo registro por um período após a exclusão — tente novamente mais tarde.',
      'meta_account',
      'meta',
    )
  }

  // --- Account state ------------------------------------------------------
  if (code === 131031) {
    return build(
      'A Meta restringiu ou bloqueou esta conta do WhatsApp Business, então nada no wacrm consegue ' +
        'conectá-la. Abra Gerenciador de Negócios da Meta → Qualidade da conta (ou Gerenciador do WhatsApp → Visão geral) ' +
        'para ver a restrição e recorrer.',
      'meta_account',
      'meta',
    )
  }
  if (code === 368) {
    return build(
      'A Meta bloqueou temporariamente esta conta por violação de política. Veja o aviso em ' +
        'Gerenciador de Negócios da Meta → Qualidade da conta; o bloqueio é removido sozinho ou após um recurso.',
      'meta_account',
      'meta',
    )
  }

  // --- Throttling / transient ------------------------------------------------
  if (RATE_LIMIT_CODES.has(code ?? -1)) {
    return build(
      'A Meta está limitando o volume de requisições deste app ou conta do WhatsApp Business agora. Nada precisa ' +
        'ser alterado — aguarde alguns minutos e tente novamente.',
      null,
      'meta',
    )
  }
  if (TEMPORARY_CODES.has(code ?? -1)) {
    return build(
      `A Meta retornou um erro temporário durante ${STEP_LABEL[step]} (código ${code}). Tente novamente em um minuto; ` +
        'se continuar, consulte metastatus.com e informe o trace id ao suporte da Meta.',
      null,
      'meta',
    )
  }

  // --- Fallback: keep Meta's words -------------------------------------------
  const trace = fbtraceId ? ` Trace id ${fbtraceId}.` : ''
  const codeText = code !== null ? ` (código ${code}${subcode !== null ? `/${subcode}` : ''})` : ''
  return build(
    `A Meta retornou um erro durante ${STEP_LABEL[step]}${codeText}: ${metaMessage}.${trace}`,
    null,
    'meta',
  )
}

/**
 * The `meta` object POST /api/whatsapp/config attaches to every failed
 * Meta call — everything a user needs to quote to support.
 */
export function metaErrorPayload(x: MetaErrorExplanation): {
  code: number | null
  subcode: number | null
  fbtrace_id: string | null
  step: MetaConnectStep
  field: MetaErrorField
  message: string
} {
  return {
    code: x.code,
    subcode: x.subcode,
    fbtrace_id: x.fbtraceId,
    step: x.step,
    field: x.field,
    message: x.metaMessage,
  }
}
