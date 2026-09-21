import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('buildSystemPrompt (pt-BR)', () => {
  it('writes the scaffold in Brazilian Portuguese', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(p).toContain('assistente de atendimento')
    expect(p).toContain('português do Brasil')
    expect(p).not.toMatch(/You are|Guidelines|Write the next reply/)
  })

  it('teaches the handoff sentinel in auto-reply mode only', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft' })).not.toContain(HANDOFF_SENTINEL)
    const auto = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(auto).toContain(HANDOFF_SENTINEL)
    expect(auto).toContain('atendente humano')
  })

  it('appends business context and knowledge excerpts in Portuguese', () => {
    const p = buildSystemPrompt({
      userPrompt: '  Somos uma imobiliária.  ',
      mode: 'draft',
      knowledge: ['Prazo de entrega: 30 dias'],
    })
    expect(p).toContain('Contexto e instruções do negócio:\nSomos uma imobiliária.')
    expect(p).toContain('Base de conhecimento')
    expect(p).toContain('[1] Prazo de entrega: 30 dias')
  })
})
