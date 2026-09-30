import { describe, it, expect } from "vitest";
import {
  normalizeGoogleEvent,
  groupEventsByDay,
  type CalendarEvent,
} from "./google-calendar";

describe("Google Calendar Integration", () => {
  describe("normalizeGoogleEvent", () => {
    it("extracts service and client name from 'Visita [Loteamento] — [Nome]'", () => {
      const item = {
        id: "ev1",
        summary: "Visita Jatobá — Tatiane Moraes",
        description: "Cliente: Tatiane Moraes\nTelefone: 5582999999999",
        start: { dateTime: "2026-08-19T09:00:00-03:00" },
        end: { dateTime: "2026-08-19T10:00:00-03:00" },
      };

      const normalized = normalizeGoogleEvent(item);
      expect(normalized.clientName).toBe("Tatiane Moraes");
      expect(normalized.serviceOrLoteamento).toBe("Visita Jatobá");
      expect(normalized.phone).toBe("5582999999999");
      expect(normalized.formattedStartTime).toBe("09:00");
      expect(normalized.formattedEndTime).toBe("10:00");
      expect(normalized.dateKey).toBe("2026-08-19");
    });

    it("extracts client name and service from 'Nome - Serviço'", () => {
      const item = {
        id: "ev2",
        summary: "Sérgio Cavalcanti - Botox 1 região",
        description: "Telefone: 5511998765432",
        start: { dateTime: "2026-08-19T10:00:00-03:00" },
        end: { dateTime: "2026-08-19T10:40:00-03:00" },
      };

      const normalized = normalizeGoogleEvent(item);
      expect(normalized.clientName).toBe("Sérgio Cavalcanti");
      expect(normalized.serviceOrLoteamento).toBe("Botox 1 região");
      expect(normalized.phone).toBe("5511998765432");
      expect(normalized.formattedStartTime).toBe("10:00");
      expect(normalized.formattedEndTime).toBe("10:40");
    });

    it("handles plain names without separators", () => {
      const item = {
        id: "ev3",
        summary: "Priscila Fontes",
        description: "5511975811462",
        start: { dateTime: "2026-08-19T11:00:00-03:00" },
        end: { dateTime: "2026-08-19T11:45:00-03:00" },
      };

      const normalized = normalizeGoogleEvent(item);
      expect(normalized.clientName).toBe("Priscila Fontes");
      expect(normalized.serviceOrLoteamento).toBeUndefined();
      expect(normalized.phone).toBe("5511975811462");
    });
  });

  describe("groupEventsByDay", () => {
    it("groups events by dateKey and generates matching headers", () => {
      const events: CalendarEvent[] = [
        {
          id: "1",
          title: "Tatiane Moraes",
          clientName: "Tatiane Moraes",
          serviceOrLoteamento: "Limpeza de pele",
          phone: "5511987116934",
          startTime: "2026-08-19T09:00:00-03:00",
          endTime: "2026-08-19T10:00:00-03:00",
          dateKey: "2026-08-19",
          formattedStartTime: "09:00",
          formattedEndTime: "10:00",
          status: "confirmed",
        },
        {
          id: "2",
          title: "Sérgio Cavalcanti",
          clientName: "Sérgio Cavalcanti",
          serviceOrLoteamento: "Botox",
          phone: "5511998765432",
          startTime: "2026-08-19T10:00:00-03:00",
          endTime: "2026-08-19T10:40:00-03:00",
          dateKey: "2026-08-19",
          formattedStartTime: "10:00",
          formattedEndTime: "10:40",
          status: "confirmed",
        },
        {
          id: "3",
          title: "Regina Vilela",
          clientName: "Regina Vilela",
          serviceOrLoteamento: "Botox",
          startTime: "2026-08-20T09:00:00-03:00",
          endTime: "2026-08-20T10:00:00-03:00",
          dateKey: "2026-08-20",
          formattedStartTime: "09:00",
          formattedEndTime: "10:00",
          status: "confirmed",
        },
      ];

      const groups = groupEventsByDay(events);
      expect(groups).toHaveLength(2);

      expect(groups[0].dateKey).toBe("2026-08-19");
      expect(groups[0].events).toHaveLength(2);
      expect(groups[0].formattedDate).toBe("19/08/2026");
      expect(groups[0].countLabel).toBe("2 HORÁRIOS");

      expect(groups[1].dateKey).toBe("2026-08-20");
      expect(groups[1].events).toHaveLength(1);
      expect(groups[1].formattedDate).toBe("20/08/2026");
      expect(groups[1].countLabel).toBe("1 HORÁRIO");
    });
  });
});
