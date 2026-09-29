"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Route } from "next";
import type { FormState } from "@/components/form-message";
import { toFormError } from "@/server/actions";
import {
  confirmBookingRequest,
  declineBookingRequest,
  requestBookingForQuote,
} from "@/server/bookings/service";
import { archiveCustomer, createOrMatchCustomer, updateCustomer } from "@/server/customers/service";
import { FormReader } from "@/server/forms";
import { readContactForm, readEventForm, readItemsForm } from "@/server/quotes/form";
import {
  approveQuoteReview,
  createQuote,
  createQuoteLink,
  repriceQuote,
  transitionQuote,
  updateDraftQuote,
} from "@/server/quotes/service";

// ── customers ──
export async function createCustomerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    id = await createOrMatchCustomer(readContactForm(fd));
  } catch (error) {
    return toFormError(error);
  }
  redirect(`/admin/customers/${id}` as Route);
}

export async function updateCustomerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    await updateCustomer({
      id: f.text("id"),
      contact: readContactForm(fd),
      notes: f.text("notes"),
    });
    revalidatePath("/admin/customers");
    return { status: "success", message: "Saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function archiveCustomerAction(fd: FormData) {
  const id = fd.get("id");
  await archiveCustomer(typeof id === "string" ? id : "");
  redirect("/admin/customers");
}

// ── quotes ──
function readStaffQuote(fd: FormData, customerId: string) {
  const f = new FormReader(fd);
  const amount = f.cents("adjustment");
  return {
    customerId,
    event: readEventForm(fd),
    items: readItemsForm(fd),
    delivery: f.text("delivery") === "pickup" ? "pickup" : "delivery",
    discountCodes: f.list("codes"),
    adjustments:
      amount !== null && amount !== 0
        ? [
            {
              label: f.text("adjustmentLabel") ?? "Manual adjustment",
              amountCents: f.checkbox("adjustmentCredit") ? -Math.abs(amount) : amount,
              reason: f.text("adjustmentReason") ?? "",
            },
          ]
        : [],
    ...(f.text("customerNotes") ? { customerNotes: f.text("customerNotes") } : {}),
    ...(f.text("internalNotes") ? { internalNotes: f.text("internalNotes") } : {}),
  };
}

export async function createQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const f = new FormReader(fd);
    const customerId = f.text("customerId") ?? (await createOrMatchCustomer(readContactForm(fd)));
    ({ quoteId: id } = await createQuote(readStaffQuote(fd, customerId)));
  } catch (error) {
    return toFormError(error);
  }
  redirect(`/admin/quotes/${id}` as Route);
}

export async function updateDraftAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    await updateDraftQuote(f.text("id") ?? "", readStaffQuote(fd, f.text("customerId") ?? ""));
    revalidatePath(`/admin/quotes/${f.text("id")}`);
    return { status: "success", message: "Updated and re-priced." };
  } catch (error) {
    return toFormError(error);
  }
}

export interface QuoteActionState extends FormState {
  link?: { path: string; url: string | null };
}

export async function quoteAction(
  _prev: QuoteActionState,
  fd: FormData,
): Promise<QuoteActionState> {
  const f = new FormReader(fd);
  const id = f.text("id") ?? "";
  try {
    let result: QuoteActionState = { status: "success", message: "Done." };
    switch (f.text("op")) {
      case "reprice":
        await repriceQuote(id);
        result = { status: "success", message: "Re-priced with current rates." };
        break;
      case "approve":
        await approveQuoteReview(id, f.text("note") ?? "");
        result = { status: "success", message: "Price review approved." };
        break;
      case "link":
        result = {
          status: "success",
          message: "New customer link created.",
          link: await createQuoteLink(id),
        };
        break;
      case "hold":
        await requestBookingForQuote(id);
        result = { status: "success", message: "Items held for the customer." };
        break;
      case "send":
      case "declined":
      case "cancelled":
      case "draft":
        await transitionQuote(id, f.text("op") === "send" ? "sent" : (f.text("op") ?? ""));
        break;
      default:
        return { status: "error", message: "Unknown action." };
    }
    revalidatePath(`/admin/quotes/${id}`);
    return result;
  } catch (error) {
    return toFormError(error);
  }
}

// ── booking requests ──
export async function bookingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const f = new FormReader(fd);
  try {
    if (f.text("op") === "confirm") {
      await confirmBookingRequest(f.text("id") ?? "", f.checkbox("ignoreWeather"));
    } else {
      await declineBookingRequest(f.text("id") ?? "", f.text("note"));
    }
    revalidatePath("/admin/bookings");
    if (f.text("quoteId")) revalidatePath(`/admin/quotes/${f.text("quoteId")}`);
    return {
      status: "success",
      message: f.text("op") === "confirm" ? "Booking confirmed." : "Request declined.",
    };
  } catch (error) {
    return toFormError(error);
  }
}
