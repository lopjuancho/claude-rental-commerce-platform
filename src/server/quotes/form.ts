import "server-only";
import { FormReader } from "@/server/forms";
import { QUOTE_ITEM_ROWS } from "@/domain/storefront/quote-prefill";

/** Shared FormData → plain values for the quote/event forms (validated later by strict schemas). */
export function readEventForm(fd: FormData) {
  const f = new FormReader(fd);
  const line1 = f.text("line1");
  const fold = f.text("fold");
  return {
    ...(f.text("title") ? { title: f.text("title") } : {}),
    ...(f.text("eventType") ? { eventType: f.text("eventType") } : {}),
    date: f.text("date") ?? "",
    ...(f.text("endDate") ? { endDate: f.text("endDate") } : {}),
    startTime: f.text("startTime") ?? "",
    endTime: f.text("endTime") ?? "",
    ...(fold === "earlier" || fold === "later" ? { timeFold: fold } : {}),
    address: line1
      ? {
          line1,
          city: f.text("city") ?? "",
          state: (f.text("state") ?? "").toUpperCase(),
          postalCode: f.text("postalCode") ?? "",
        }
      : null,
    ...(f.int("guestCount") !== null ? { guestCount: f.int("guestCount") } : {}),
    ...(f.text("eventNotes") ? { notes: f.text("eventNotes") } : {}),
  };
}

export function readItemsForm(fd: FormData, rows = QUOTE_ITEM_ROWS) {
  const f = new FormReader(fd);
  return Array.from({ length: rows }, (_, i) => ({
    variantId: f.text(`variant${i}`),
    quantity: f.int(`quantity${i}`) ?? 1,
  })).filter((i): i is { variantId: string; quantity: number } => i.variantId !== null);
}

export function readContactForm(fd: FormData) {
  const f = new FormReader(fd);
  return {
    ...(f.text("firstName") ? { firstName: f.text("firstName") } : {}),
    ...(f.text("lastName") ? { lastName: f.text("lastName") } : {}),
    ...(f.text("companyName") ? { companyName: f.text("companyName") } : {}),
    ...(f.text("email") ? { email: f.text("email") } : {}),
    ...(f.text("phone") ? { phone: f.text("phone") } : {}),
    smsOptIn: f.checkbox("smsOptIn"),
    emailOptIn: f.checkbox("emailOptIn"),
  };
}
