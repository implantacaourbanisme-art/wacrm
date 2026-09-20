// ============================================================
// CPF / CNPJ helpers. The document lives in a custom field named
// CPF_CNPJ_FIELD_NAME, always stored as digits only (11 = CPF,
// 14 = CNPJ). Pure, no I/O.
// ============================================================

export const CPF_CNPJ_FIELD_NAME = 'CPF/CNPJ'

/** Digits-only CPF/CNPJ, or null when the input is not a plausible one. */
export function normalizeDocument(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  return digits.length === 11 || digits.length === 14 ? digits : null
}

export function formatDocument(digits: string): string {
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
  }
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
  }
  return digits
}

/** Formatted, with the identifying edges hidden (LGPD-friendly default view). */
export function maskDocument(digits: string): string {
  if (digits.length === 11) {
    return `•••.${digits.slice(3, 6)}.${digits.slice(6, 9)}-••`
  }
  if (digits.length === 14) {
    return `••.•••.${digits.slice(5, 8)}/${digits.slice(8, 12)}-••`
  }
  return '•'.repeat(digits.length)
}
