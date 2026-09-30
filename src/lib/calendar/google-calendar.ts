/**
 * Google Calendar Integration Service for CRM Urbanisme
 * 
 * Manages OAuth2 token refresh, API interactions with Google Calendar v3,
 * and normalizes calendar events into structured agenda items.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  clientName: string;
  serviceOrLoteamento?: string;
  phone?: string;
  description?: string;
  location?: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  dateKey: string;   // YYYY-MM-DD
  formattedStartTime: string; // e.g. "09:00"
  formattedEndTime: string;   // e.g. "10:00"
  htmlLink?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface CalendarDayGroup {
  dateKey: string;      // YYYY-MM-DD
  dayLabel: string;     // e.g. "HOJE", "QUARTA-FEIRA"
  formattedDate: string; // e.g. "19/08/2026"
  countLabel: string;   // e.g. "8 HORÁRIOS"
  events: CalendarEvent[];
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Retrieves a valid Google OAuth2 access token using the configured refresh token.
 * Caches the token in memory until 60 seconds before expiration.
 */
export async function getGoogleAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Credenciais do Google Calendar não configuradas no ambiente (GOOGLE_CALENDAR_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)."
    );
  }

  // Return cached token if still valid
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[GoogleCalendar] Erro ao renovar token OAuth:", errorBody);
    throw new Error(`Falha na autenticação do Google Calendar: ${response.statusText} (${errorBody})`);
  }

  const data = await response.json();
  const expiresIn = data.expires_in || 3600;

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return data.access_token;
}

/**
 * Normalizes and extracts structured details (clientName, service/loteamento, phone)
 * from a raw Google Calendar event item.
 */
export function normalizeGoogleEvent(item: any): CalendarEvent {
  const rawTitle = item.summary || "Sem título";
  const description = item.description || "";
  const location = item.location || "";

  let clientName = rawTitle.trim();
  let serviceOrLoteamento = "";
  let phone = "";

  // 1. Check title patterns:
  // e.g. "Visita Jatobá — Tatiane Moraes" or "Visita Jatobá - Tatiane Moraes"
  if (rawTitle.includes(" — ")) {
    const parts = rawTitle.split(" — ");
    serviceOrLoteamento = parts[0].trim();
    clientName = parts.slice(1).join(" — ").trim();
  } else if (rawTitle.includes(" - ")) {
    const parts = rawTitle.split(" - ");
    if (parts.length === 2) {
      if (parts[0].toLowerCase().includes("visita") || parts[0].toLowerCase().includes("atendimento")) {
        serviceOrLoteamento = parts[0].trim();
        clientName = parts[1].trim();
      } else {
        clientName = parts[0].trim();
        serviceOrLoteamento = parts[1].trim();
      }
    }
  }

  // 2. Parse description for explicit metadata
  // E.g.: "Cliente: João\nTelefone: 5582999999999\nLoteamento: Jatobá"
  const clientMatch = description.match(/(?:Cliente|Nome):\s*([^\n\r]+)/i);
  if (clientMatch && clientMatch[1]) {
    clientName = clientMatch[1].trim();
  }

  const loteamentoMatch = description.match(/(?:Loteamento|Empreendimento|Serviço):\s*([^\n\r]+)/i);
  if (loteamentoMatch && loteamentoMatch[1]) {
    serviceOrLoteamento = loteamentoMatch[1].trim();
  }

  // 3. Extract phone number from description or title
  const phoneMatch = (description + " " + rawTitle).match(
    /(?:Telefone|Fone|WhatsApp|Contato)?[:\s]*(55\d{10,11}|\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4})/i
  );
  if (phoneMatch && phoneMatch[1]) {
    phone = phoneMatch[1].replace(/\D/g, "");
    if (!phone.startsWith("55") && phone.length >= 10) {
      phone = "55" + phone;
    }
  }

  // Handle start/end time formatting
  const startRaw = item.start?.dateTime || item.start?.date || new Date().toISOString();
  const endRaw = item.end?.dateTime || item.end?.date || startRaw;

  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);

  const pad = (n: number) => n.toString().padStart(2, "0");

  const dateKey = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
  const formattedStartTime = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
  const formattedEndTime = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;

  return {
    id: item.id || Math.random().toString(36).substring(2),
    title: rawTitle,
    clientName: clientName || "Cliente",
    serviceOrLoteamento: serviceOrLoteamento || undefined,
    phone: phone || undefined,
    description: description || undefined,
    location: location || undefined,
    startTime: startRaw,
    endTime: endRaw,
    dateKey,
    formattedStartTime,
    formattedEndTime,
    htmlLink: item.htmlLink,
    status: item.status || "confirmed",
  };
}

/**
 * Fetches events from Google Calendar and returns them grouped by day.
 */
export async function listCalendarEvents(options?: {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}): Promise<CalendarEvent[]> {
  const token = await getGoogleAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  // Default window: from start of today to 60 days ahead
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const defaultMin = now.toISOString();
  const defaultMaxDate = new Date();
  defaultMaxDate.setDate(defaultMaxDate.getDate() + 45);
  defaultMaxDate.setHours(23, 59, 59, 999);
  const defaultMax = defaultMaxDate.toISOString();

  const timeMin = options?.timeMin || defaultMin;
  const timeMax = options?.timeMax || defaultMax;
  const maxResults = options?.maxResults || 250;

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: maxResults.toString(),
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    // Avoid caching raw API responses in Next.js data cache for real-time sync
    cache: "no-store",
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("[GoogleCalendar] Erro ao listar eventos:", errorText);
    throw new Error(`Falha ao buscar eventos do Google Calendar (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];

  return items
    .filter((item: any) => item.status !== "cancelled")
    .map(normalizeGoogleEvent);
}

const WEEKDAYS = [
  "DOMINGO",
  "SEGUNDA-FEIRA",
  "TERÇA-FEIRA",
  "QUARTA-FEIRA",
  "QUINTA-FEIRA",
  "SEXTA-FEIRA",
  "SÁBADO",
];

/**
 * Groups an array of CalendarEvent items by dateKey into structured day sections.
 * Matches the reference image format:
 * - "HOJE · X HORÁRIOS"
 * - "QUARTA-FEIRA · 19/08/2026 · X HORÁRIOS"
 */
export function groupEventsByDay(events: CalendarEvent[]): CalendarDayGroup[] {
  const groupsMap = new Map<string, CalendarEvent[]>();

  for (const ev of events) {
    const key = ev.dateKey;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, []);
    }
    groupsMap.get(key)!.push(ev);
  }

  const today = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

  const groups: CalendarDayGroup[] = [];

  // Sort keys chronologically
  const sortedKeys = Array.from(groupsMap.keys()).sort();

  for (const key of sortedKeys) {
    const dayEvents = groupsMap.get(key)!;
    // Sort events inside the day by start time
    dayEvents.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    // Parse date parts for timezone-safe display
    const [year, month, day] = key.split("-").map(Number);
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = WEEKDAYS[dateObj.getDay()];
    const formattedDate = `${pad(day)}/${pad(month)}/${year}`;

    let dayLabel = dayOfWeek;
    if (key === todayKey) {
      dayLabel = "HOJE";
    } else if (key === tomorrowKey) {
      dayLabel = "AMANHÃ";
    }

    const count = dayEvents.length;
    const countLabel = `${count} ${count === 1 ? "HORÁRIO" : "HORÁRIOS"}`;

    groups.push({
      dateKey: key,
      dayLabel,
      formattedDate,
      countLabel,
      events: dayEvents,
    });
  }

  return groups;
}

/**
 * Creates a new event in Google Calendar.
 */
export async function createGoogleCalendarEvent(eventData: {
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  location?: string;
}): Promise<CalendarEvent> {
  const token = await getGoogleAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

  const body = {
    summary: eventData.summary,
    description: eventData.description,
    location: eventData.location,
    start: {
      dateTime: eventData.startDateTime,
      timeZone: "America/Sao_Paulo",
    },
    end: {
      dateTime: eventData.endDateTime,
      timeZone: "America/Sao_Paulo",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[GoogleCalendar] Erro ao criar evento:", err);
    throw new Error(`Falha ao criar evento no Google Calendar: ${err}`);
  }

  const created = await res.json();
  return normalizeGoogleEvent(created);
}
