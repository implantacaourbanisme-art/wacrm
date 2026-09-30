"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  Calendar as CalendarIcon,
  RefreshCw,
  Plus,
  ExternalLink,
  Clock,
  Phone,
  MapPin,
  MessageSquare,
  User,
  AlertCircle,
  Building,
  CheckCircle2,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { CalendarEvent, CalendarDayGroup } from "@/lib/calendar/google-calendar";

type FilterRange = "today" | "week" | "month";

export default function AgendaPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [groups, setGroups] = useState<CalendarDayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendarId, setCalendarId] = useState<string>("implantacaourbanisme@gmail.com");
  const [filterRange, setFilterRange] = useState<FilterRange>("month");

  // Selected event for detail modal
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  // New Event Modal State
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [savingEvent, setSavingEvent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    clientName: "",
    serviceOrLoteamento: "Visita Loteamento",
    phone: "",
    date: "",
    startTime: "09:00",
    endTime: "10:00",
    location: "Escritório Urbanisme",
    notes: "",
  });

  // Calculate start/end dates based on selected filter range
  const { startDate, endDate } = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);

    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (filterRange === "today") {
      // already today
    } else if (filterRange === "week") {
      end.setDate(end.getDate() + 7);
    } else if (filterRange === "month") {
      end.setDate(end.getDate() + 35);
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }, [filterRange]);

  const loadEvents = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const query = new URLSearchParams({
          startDate,
          endDate,
        });

        const res = await fetch(`/api/calendar/events?${query.toString()}`, {
          cache: "no-store",
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || "Não foi possível carregar a agenda.");
        }

        setEvents(data.events || []);
        setGroups(data.groups || []);
        if (data.calendarId) {
          setCalendarId(data.calendarId);
        }
      } catch (err: any) {
        console.error("Erro ao buscar agenda:", err);
        setError(err.message || "Erro desconhecido ao carregar os dados.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [startDate, endDate]
  );

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Set default form date to tomorrow or today
  useEffect(() => {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const todayStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    setFormData((prev) => ({ ...prev, date: prev.date || todayStr }));
  }, []);

  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.clientName || !formData.date || !formData.startTime || !formData.endTime) {
      setFormError("Por favor, preencha o nome do cliente, a data e os horários.");
      return;
    }

    setSavingEvent(true);
    try {
      const summary = formData.serviceOrLoteamento
        ? `${formData.serviceOrLoteamento} — ${formData.clientName}`
        : formData.clientName;

      let description = `Cliente: ${formData.clientName}\n`;
      if (formData.phone) description += `Telefone: ${formData.phone}\n`;
      if (formData.serviceOrLoteamento) description += `Loteamento: ${formData.serviceOrLoteamento}\n`;
      if (formData.notes) description += `Observações: ${formData.notes}\n`;

      const startDateTime = `${formData.date}T${formData.startTime}:00-03:00`;
      const endDateTime = `${formData.date}T${formData.endTime}:00-03:00`;

      const res = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary,
          description,
          location: formData.location,
          startDateTime,
          endDateTime,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Falha ao criar agendamento.");
      }

      setNewModalOpen(false);
      // Reset form
      setFormData((prev) => ({
        ...prev,
        clientName: "",
        phone: "",
        notes: "",
      }));
      // Refresh list
      loadEvents(true);
    } catch (err: any) {
      console.error("Erro ao salvar:", err);
      setFormError(err.message || "Erro ao salvar agendamento.");
    } finally {
      setSavingEvent(false);
    }
  };

  return (
    <div className="flex-1 space-y-6 p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            Agenda
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Os horários e visitas agendados, sincronizados diretamente com o Google Agenda da Urbanisme.
          </p>
        </div>

        {/* Actions Bar */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Quick Filter Range */}
          <div className="inline-flex rounded-lg border border-border bg-card p-0.5 text-xs font-medium">
            <button
              onClick={() => setFilterRange("today")}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                filterRange === "today"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Hoje
            </button>
            <button
              onClick={() => setFilterRange("week")}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                filterRange === "week"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Próximos 7 dias
            </button>
            <button
              onClick={() => setFilterRange("month")}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                filterRange === "month"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Próximos 30 dias
            </button>
          </div>

          {/* Sync Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadEvents(true)}
            disabled={refreshing || loading}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            <span className="hidden sm:inline">Sincronizar</span>
          </Button>

          {/* Link to Google Calendar Web */}
          <a
            href="https://calendar.google.com/calendar/u/0/r"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "gap-2 text-muted-foreground hover:text-foreground"
            )}
          >
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">Abrir no Google</span>
          </a>

          {/* New Event Button */}
          <Button size="sm" onClick={() => setNewModalOpen(true)} className="gap-2 font-semibold">
            <Plus className="h-4 w-4" />
            Novo Agendamento
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 flex items-start gap-3 text-destructive text-sm">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">Erro ao conectar com o Google Calendar</p>
            <p className="mt-0.5 text-xs opacity-90">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => loadEvents(true)}>
            Tentar novamente
          </Button>
        </div>
      )}

      {/* Loading state skeleton */}
      {loading && !refreshing && (
        <div className="space-y-8 animate-pulse">
          {[1, 2].map((group) => (
            <div key={group} className="space-y-4">
              <div className="h-4 w-44 bg-muted rounded-md" />
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-20 bg-card border border-border/50 rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && groups.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-border/80 bg-card/50 p-12 text-center max-w-xl mx-auto my-12">
          <div className="h-14 w-14 rounded-2xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center mx-auto mb-4">
            <CalendarIcon className="h-7 w-7" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">Nenhum agendamento encontrado</h3>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-sm mx-auto">
            Não há visitas ou reuniões marcadas para o período selecionado na agenda{" "}
            <span className="font-mono text-xs font-semibold text-foreground/80">{calendarId}</span>.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button onClick={() => setNewModalOpen(true)} className="gap-2 font-semibold">
              <Plus className="h-4 w-4" />
              Criar Primeiro Agendamento
            </Button>
            <a
              href="https://calendar.google.com/calendar/u/0/r"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              Adicionar no Google Agenda
            </a>
          </div>
        </div>
      )}

      {/* Main Events Grid Grouped by Day */}
      {!loading && groups.length > 0 && (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.dateKey} className="space-y-3.5">
              {/* Day Header matching reference image: "HOJE · 8 HORÁRIOS" or "QUARTA-FEIRA · 19/08/2026 · 8" */}
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground border-b border-border/40 pb-2">
                <span className="text-foreground/90">{group.dayLabel}</span>
                <span>·</span>
                <span>{group.formattedDate}</span>
                <span>·</span>
                <span className="text-primary font-semibold">{group.countLabel}</span>
              </div>

              {/* Cards Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {group.events.map((ev) => (
                  <div
                    key={ev.id}
                    onClick={() => setSelectedEvent(ev)}
                    role="button"
                    tabIndex={0}
                    className="group relative bg-card border border-border/80 hover:border-primary/60 transition-all rounded-xl p-3 flex items-center gap-3.5 shadow-xs hover:shadow-sm cursor-pointer hover:bg-muted/15"
                  >
                    {/* Left Time Badge (Lime green soft tint, matching screenshot) */}
                    <div className="shrink-0 bg-primary/15 border border-primary/25 rounded-lg px-2.5 py-1.5 flex flex-col items-center justify-center min-w-[62px] text-center">
                      <span className="text-sm font-bold text-foreground leading-tight">
                        {ev.formattedStartTime}
                      </span>
                      <span className="text-[11px] font-medium text-muted-foreground leading-tight mt-0.5">
                        {ev.formattedEndTime}
                      </span>
                    </div>

                    {/* Right Info Column */}
                    <div className="flex-1 min-w-0 pr-1">
                      {/* Line 1: Client Name in bold */}
                      <p className="font-bold text-sm text-foreground truncate group-hover:text-primary transition-colors leading-snug">
                        {ev.clientName}
                      </p>

                      {/* Line 2: Service / Loteamento / Procedimento */}
                      <p className="text-xs text-muted-foreground truncate font-medium mt-0.5">
                        {ev.serviceOrLoteamento || ev.title}
                      </p>

                      {/* Line 3: Phone number if available */}
                      {ev.phone ? (
                        <p className="text-[11px] text-muted-foreground/80 font-mono tracking-tight flex items-center gap-1.5 mt-0.5 truncate">
                          <span>{ev.phone}</span>
                        </p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground/50 tracking-tight mt-0.5 italic truncate">
                          {ev.location || "Sem telefone"}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Event Details Dialog */}
      <Dialog open={!!selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <DialogContent className="sm:max-w-[480px]">
          {selectedEvent && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="bg-primary/10 border-primary/30 text-foreground font-semibold">
                    <Clock className="h-3 w-3 mr-1 text-primary" />
                    {selectedEvent.formattedStartTime} às {selectedEvent.formattedEndTime}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{selectedEvent.dateKey}</span>
                </div>
                <DialogTitle className="text-xl font-bold">{selectedEvent.clientName}</DialogTitle>
                <DialogDescription>
                  {selectedEvent.serviceOrLoteamento || selectedEvent.title}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2 text-sm">
                {selectedEvent.phone && (
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/30">
                    <div className="flex items-center gap-2.5">
                      <Phone className="h-4 w-4 text-primary" />
                      <div>
                        <p className="text-xs text-muted-foreground">Telefone</p>
                        <p className="font-mono font-medium">{selectedEvent.phone}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/inbox?phone=${encodeURIComponent(selectedEvent.phone)}`}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-1.5 text-xs")}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Inbox
                      </Link>
                      <a
                        href={`https://wa.me/${selectedEvent.phone}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-8 gap-1.5 text-xs font-semibold")}
                      >
                        WhatsApp
                      </a>
                    </div>
                  </div>
                )}

                {selectedEvent.location && (
                  <div className="flex items-start gap-2.5 p-3 rounded-lg border border-border bg-muted/20">
                    <MapPin className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs text-muted-foreground">Local do Encontro</p>
                      <p className="font-medium text-foreground">{selectedEvent.location}</p>
                    </div>
                  </div>
                )}

                {selectedEvent.description && (
                  <div className="p-3 rounded-lg border border-border bg-muted/20">
                    <p className="text-xs text-muted-foreground mb-1">Notas do Agendamento</p>
                    <p className="text-xs whitespace-pre-wrap font-sans text-foreground/90">
                      {selectedEvent.description}
                    </p>
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                {selectedEvent.htmlLink && (
                  <a
                    href={selectedEvent.htmlLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
                  >
                    <ExternalLink className="h-4 w-4" />
                    Ver no Google Agenda
                  </a>
                )}
                <Button variant="secondary" onClick={() => setSelectedEvent(null)}>
                  Fechar
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* New Event Dialog */}
      <Dialog open={newModalOpen} onOpenChange={setNewModalOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <form onSubmit={handleCreateEvent}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarIcon className="h-5 w-5 text-primary" />
                Novo Agendamento
              </DialogTitle>
              <DialogDescription>
                Crie um novo horário na agenda da Urbanisme integrada ao Google Agenda.
              </DialogDescription>
            </DialogHeader>

            {formError && (
              <div className="my-3 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="clientName">Nome do Cliente *</Label>
                  <Input
                    id="clientName"
                    placeholder="Ex: João da Silva"
                    value={formData.clientName}
                    onChange={(e) => setFormData({ ...formData, clientName: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Telefone (WhatsApp)</Label>
                  <Input
                    id="phone"
                    placeholder="Ex: 5582999999999"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="service">Loteamento / Serviço</Label>
                  <Input
                    id="service"
                    placeholder="Ex: Visita Jatobá"
                    value={formData.serviceOrLoteamento}
                    onChange={(e) => setFormData({ ...formData, serviceOrLoteamento: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="date">Data *</Label>
                  <Input
                    id="date"
                    type="date"
                    value={formData.date}
                    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="startTime">Início *</Label>
                  <Input
                    id="startTime"
                    type="time"
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="endTime">Término *</Label>
                  <Input
                    id="endTime"
                    type="time"
                    value={formData.endTime}
                    onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="location">Local</Label>
                <Input
                  id="location"
                  placeholder="Ex: Escritório Urbanisme ou Estande Jatobá"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="notes">Observações</Label>
                <Textarea
                  id="notes"
                  rows={2}
                  placeholder="Informações adicionais da visita..."
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewModalOpen(false)} disabled={savingEvent}>
                Cancelar
              </Button>
              <Button type="submit" disabled={savingEvent} className="font-semibold gap-2">
                {savingEvent ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Salvando...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Confirmar Agendamento
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
