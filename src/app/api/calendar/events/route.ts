import { NextRequest, NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  listCalendarEvents,
  groupEventsByDay,
  createGoogleCalendarEvent,
} from "@/lib/calendar/google-calendar";

export async function GET(req: NextRequest) {
  try {
    // Require authenticated user
    await getCurrentAccount();

    const { searchParams } = new URL(req.url);
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const maxResultsParam = searchParams.get("maxResults");
    const maxResults = maxResultsParam ? parseInt(maxResultsParam, 10) : undefined;

    const events = await listCalendarEvents({
      timeMin: startDate,
      timeMax: endDate,
      maxResults,
    });

    const groups = groupEventsByDay(events);

    return NextResponse.json({
      success: true,
      calendarId: process.env.GOOGLE_CALENDAR_ID || "implantacaourbanisme@gmail.com",
      events,
      groups,
      total: events.length,
    });
  } catch (err: any) {
    console.error("[API /api/calendar/events GET]", err);
    if (err?.status === 401 || err?.name === "UnauthorizedError") {
      return toErrorResponse(err);
    }
    return NextResponse.json(
      {
        success: false,
        error: err?.message || "Erro ao consultar eventos do Google Calendar",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await getCurrentAccount();

    const body = await req.json();
    const { summary, description, startDateTime, endDateTime, location } = body;

    if (!summary || !startDateTime || !endDateTime) {
      return NextResponse.json(
        {
          success: false,
          error: "Campos obrigatórios ausentes (summary, startDateTime, endDateTime).",
        },
        { status: 400 }
      );
    }

    const createdEvent = await createGoogleCalendarEvent({
      summary,
      description,
      startDateTime,
      endDateTime,
      location,
    });

    return NextResponse.json({
      success: true,
      event: createdEvent,
    });
  } catch (err: any) {
    console.error("[API /api/calendar/events POST]", err);
    if (err?.status === 401 || err?.name === "UnauthorizedError") {
      return toErrorResponse(err);
    }
    return NextResponse.json(
      {
        success: false,
        error: err?.message || "Erro ao criar agendamento no Google Calendar",
      },
      { status: 500 }
    );
  }
}
