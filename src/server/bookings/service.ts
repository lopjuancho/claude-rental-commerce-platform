import "server-only";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { fromEngineError } from "@/server/availability/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";

const STATUSES = ["pending", "confirmed", "declined", "cancelled"] as const;

export async function listBookingRequests(status?: string) {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  let query = db
    .from("booking_requests")
    .select(
      "id, status, source, customer_message, created_at, decided_at, quote_id, quotes(quote_number, total_cents, currency, manual_review_required, review_approved_at), customers(first_name, last_name, company_name, email, phone_e164), events(starts_at, ends_at, city), reservations(status, hold_expires_at)",
    )
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false })
    .limit(200);
  const s = z.enum(STATUSES).safeParse(status);
  if (s.success) query = query.eq("status", s.data);
  const { data, error } = await query;
  if (error) throw fromEngineError(error, "Booking request");
  const now = Date.now();
  return data.map((r) => ({
    ...r,
    holdActive:
      r.status === "pending" &&
      r.reservations?.status === "held" &&
      r.reservations.hold_expires_at !== null &&
      Date.parse(r.reservations.hold_expires_at) > now,
  }));
}

/** Staff starts a hold for a quote (e.g. on the phone with the customer). */
export async function requestBookingForQuote(quoteId: string) {
  await requireStaff("quotes.write");
  const db = await createUserClient();
  const { data, error } = await db.rpc("request_booking", {
    p_quote_id: z.uuid().parse(quoteId),
    p_source: "admin",
  });
  if (error) throw fromEngineError(error, "Booking request");
  const row = data[0];
  if (!row) throw new DomainError("INTERNAL");
  return row;
}

export async function confirmBookingRequest(id: string, ignoreWeather = false) {
  await requireStaff("quotes.write");
  const db = await createUserClient();
  const { data, error } = await db.rpc("confirm_booking_request", {
    p_booking_request_id: z.uuid().parse(id),
    p_ignore_weather: ignoreWeather,
  });
  if (error) throw fromEngineError(error, "Booking request");
  return data;
}

export async function declineBookingRequest(id: string, note: string | null) {
  await requireStaff("quotes.write");
  const db = await createUserClient();
  const { error } = await db.rpc("close_booking_request", {
    p_booking_request_id: z.uuid().parse(id),
    p_status: "declined",
    ...(note ? { p_note: z.string().trim().max(1000).parse(note) } : {}),
  });
  if (error) throw fromEngineError(error, "Booking request");
}
