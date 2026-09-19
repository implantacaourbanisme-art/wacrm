import { describe, expect, it } from 'vitest'
import { mapZApiStatus } from './route'

describe('mapZApiStatus', () => {
  it('maps SENT to sent', () => {
    expect(mapZApiStatus('SENT')).toBe('sent')
  })
  it('maps RECEIVED to delivered', () => {
    expect(mapZApiStatus('RECEIVED')).toBe('delivered')
  })
  it('maps READ to read', () => {
    expect(mapZApiStatus('READ')).toBe('read')
  })
  it('maps PLAYED to read', () => {
    expect(mapZApiStatus('PLAYED')).toBe('read')
  })
  it('maps READ_BY_ME to null — not a signal about the customer', () => {
    expect(mapZApiStatus('READ_BY_ME')).toBeNull()
  })
  it('maps an unrecognized value to null', () => {
    expect(mapZApiStatus('SOMETHING_NEW')).toBeNull()
  })
  it('maps undefined to null', () => {
    expect(mapZApiStatus(undefined)).toBeNull()
  })
})
