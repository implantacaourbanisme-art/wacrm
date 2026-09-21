import { describe, expect, it } from 'vitest'
import { AUTOMATION_TEMPLATES, getTemplate } from './templates'

// The templates ship in Brazilian Portuguese for this deployment. These
// checks pin the visible copy so an English string can't sneak back in.
const ENGLISH_HINTS = /\b(the|and|thanks|hi|our|you|we|your|team|reach|help|questions?)\b/i

describe('automation templates (pt-BR)', () => {
  it('has the expected names and descriptions', () => {
    expect(AUTOMATION_TEMPLATES.welcome_message.name).toBe('Mensagem de boas-vindas')
    expect(AUTOMATION_TEMPLATES.out_of_office.name).toBe('Fora do expediente')
    expect(AUTOMATION_TEMPLATES.lead_qualifier.name).toBe('Qualificação de leads')
    expect(AUTOMATION_TEMPLATES.follow_up_reminder.name).toBe('Lembrete de acompanhamento')
    for (const t of Object.values(AUTOMATION_TEMPLATES)) {
      expect(t.description).not.toMatch(ENGLISH_HINTS)
    }
  })

  it('has no English left in the message texts', () => {
    for (const t of Object.values(AUTOMATION_TEMPLATES)) {
      for (const step of t.steps) {
        const text = (step.step_config as { text?: string }).text
        if (text) expect(text).not.toMatch(ENGLISH_HINTS)
      }
    }
  })

  it('keeps the structure (slugs, triggers, step order) unchanged', () => {
    expect(Object.keys(AUTOMATION_TEMPLATES)).toEqual([
      'welcome_message', 'out_of_office', 'lead_qualifier', 'follow_up_reminder',
    ])
    expect(AUTOMATION_TEMPLATES.welcome_message.trigger_type).toBe('first_inbound_message')
    expect(AUTOMATION_TEMPLATES.out_of_office.steps.map((s) => s.step_type)).toEqual(['condition', 'send_message'])
    expect(AUTOMATION_TEMPLATES.lead_qualifier.steps.map((s) => s.step_type)).toEqual(['send_message', 'wait', 'assign_conversation'])
    expect(AUTOMATION_TEMPLATES.follow_up_reminder.steps.map((s) => s.step_type)).toEqual(['wait', 'send_message'])
    expect(getTemplate('nope')).toBeNull()
  })

  it('matches Portuguese price keywords with and without accents', () => {
    const cfg = AUTOMATION_TEMPLATES.lead_qualifier.trigger_config as { keywords: string[]; match_type: string }
    expect(cfg.match_type).toBe('contains')
    for (const k of ['preço', 'preco', 'valor', 'orçamento', 'orcamento', 'comprar']) {
      expect(cfg.keywords).toContain(k)
    }
  })
})
