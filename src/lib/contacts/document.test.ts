import { describe, expect, it } from 'vitest'
import {
  CPF_CNPJ_FIELD_NAME,
  formatDocument,
  maskDocument,
  normalizeDocument,
} from './document'

describe('CPF_CNPJ_FIELD_NAME', () => {
  it('is the shared custom field name', () => {
    expect(CPF_CNPJ_FIELD_NAME).toBe('CPF/CNPJ')
  })
})

describe('normalizeDocument', () => {
  it('keeps only digits of a CPF', () => {
    expect(normalizeDocument('529.982.247-25')).toBe('52998224725')
  })
  it('keeps only digits of a CNPJ', () => {
    expect(normalizeDocument('12.345.678/0001-90')).toBe('12345678000190')
  })
  it('rejects anything that is not 11 or 14 digits, and non-strings', () => {
    expect(normalizeDocument('123')).toBeNull()
    expect(normalizeDocument('123456789012')).toBeNull()
    expect(normalizeDocument('')).toBeNull()
    expect(normalizeDocument(null)).toBeNull()
    expect(normalizeDocument(52998224725)).toBeNull()
  })
})

describe('formatDocument', () => {
  it('formats a CPF', () => {
    expect(formatDocument('52998224725')).toBe('529.982.247-25')
  })
  it('formats a CNPJ', () => {
    expect(formatDocument('12345678000190')).toBe('12.345.678/0001-90')
  })
  it('returns unknown lengths untouched', () => {
    expect(formatDocument('123')).toBe('123')
  })
})

describe('maskDocument', () => {
  it('masks a CPF keeping the middle digits', () => {
    expect(maskDocument('52998224725')).toBe('•••.982.247-••')
  })
  it('masks a CNPJ keeping the middle digits', () => {
    expect(maskDocument('12345678000190')).toBe('••.•••.678/0001-••')
  })
  it('fully masks unknown lengths', () => {
    expect(maskDocument('1234')).toBe('••••')
  })
})
