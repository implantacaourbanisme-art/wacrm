import { describe, expect, it } from "vitest";
import { getFlowTemplate, listFlowTemplates } from "./templates";

// The flow templates ship in Brazilian Portuguese for this deployment.
// These checks pin the visible copy so English can't sneak back in.
const ENGLISH_HINTS =
  /\b(the|and|thanks|hi|our|you|we|your|welcome|customer|help|questions?|pricing|refunds?|name|email|company)\b/i;

function visibleStrings(): string[] {
  const out: string[] = [];
  for (const t of listFlowTemplates()) {
    out.push(t.name, t.description);
    for (const n of t.nodes) {
      const c = n.config as Record<string, unknown>;
      for (const k of ["text", "footer_text", "button_label", "prompt_text", "note"]) {
        if (typeof c[k] === "string") out.push(c[k] as string);
      }
      for (const b of (c.buttons as { title: string }[] | undefined) ?? []) out.push(b.title);
      for (const s of (c.sections as { title: string; rows: { title: string }[] }[] | undefined) ?? []) {
        out.push(s.title, ...s.rows.map((r) => r.title));
      }
    }
  }
  return out;
}

describe("flow templates (pt-BR)", () => {
  it("has the expected names", () => {
    expect(getFlowTemplate("welcome_menu")?.name).toBe("Menu de boas-vindas");
    expect(getFlowTemplate("faq_bot")?.name).toBe("Bot de perguntas frequentes");
    expect(getFlowTemplate("lead_capture")?.name).toBe("Captação de leads");
  });

  it("has no English left in visible copy", () => {
    for (const s of visibleStrings()) expect(s.replace(/{{[^}]*}}/g, "")).not.toMatch(ENGLISH_HINTS);
  });

  it("keeps slugs, node keys and reply ids unchanged", () => {
    expect(listFlowTemplates().map((t) => t.slug)).toEqual([
      "welcome_menu", "faq_bot", "lead_capture",
    ]);
    const faq = getFlowTemplate("faq_bot")!;
    expect(faq.nodes.map((n) => n.node_key)).toEqual([
      "start", "topics", "answer_hours", "answer_pricing", "answer_refunds", "human_handoff", "end",
    ]);
    const welcome = getFlowTemplate("welcome_menu")!.nodes[1].config as {
      buttons: { reply_id: string }[];
    };
    expect(welcome.buttons.map((b) => b.reply_id)).toEqual(["existing", "new"]);
    expect(getFlowTemplate("nope")).toBeNull();
  });

  it("uses Brazilian currency in the pricing answer", () => {
    const n = getFlowTemplate("faq_bot")!.nodes.find((x) => x.node_key === "answer_pricing")!;
    expect((n.config as { text: string }).text).toMatch(/R\$ 9\/mês/);
  });
});
