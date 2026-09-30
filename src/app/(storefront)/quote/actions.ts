"use server";

import type { FormState } from "@/components/form-message";
import { toFormError } from "@/server/actions";
import {
  cancelPublicBooking,
  renewPublicHold,
  requestPublicBooking,
  submitQuoteRequest,
} from "@/server/public/quotes";
import { readContactForm, readEventForm, readItemsForm } from "@/server/quotes/form";
import { getClientIp, getRequestId } from "@/server/request";
import { readVisitorToken } from "@/server/visitor";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";
import { headers } from "next/headers";

/**
 * Storefront server actions (ADR 0001): the tenant comes from the Host header only; the browser
 * sends form fields, never an organization id. Every action is rate-limited and audited inside the
 * public services. Actions return `redirectTo` for the browser to follow (useFollowRedirect) and
 * never call redirect(): Next renders a redirect target through an internal request that does not
 * carry the visitor's Host, so the tenant would not resolve (ADR 0016 §14).
 */
async function context() {
  const tenant = await getRequestTenant();
  if (!tenant) throw new Error("Unknown storefront");
  const h = await headers();
  const requestId = await getRequestId();
  return {
    tenant,
    meta: {
      ip: await getClientIp(),
      ...(h.get("user-agent") ? { userAgent: h.get("user-agent") ?? "" } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}

export async function submitQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let token: string;
  try {
    const { tenant, meta } = await context();
    const message = fd.get("message");
    const code = fd.get("discountCode");
    ({ token } = await submitQuoteRequest(
      tenant,
      {
        contact: readContactForm(fd),
        event: readEventForm(fd),
        items: readItemsForm(fd),
        delivery: fd.get("delivery") === "pickup" ? "pickup" : "delivery",
        ...(typeof code === "string" && code.trim() ? { discountCode: code.trim() } : {}),
        ...(typeof message === "string" && message.trim() ? { message: message.trim() } : {}),
      },
      meta,
    ));
  } catch (error) {
    return toFormError(error);
  }
  return { status: "success", message: "Opening your quote…", redirectTo: `/q/${token}` };
}

const tokenOf = (fd: FormData) => {
  const t = fd.get("token");
  return typeof t === "string" ? t : "";
};

export async function requestBookingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { tenant, meta } = await context();
    const message = fd.get("message");
    await requestPublicBooking(
      tenant,
      tokenOf(fd),
      typeof message === "string" && message.trim() ? { message: message.trim() } : {},
      // The anonymous visitor (HttpOnly cookie set by the storefront page) that live holds count
      // against. Never minted here: without it the request is refused and a reload establishes it.
      { ...meta, visitorToken: (await readVisitorToken()) ?? undefined },
    );
  } catch (error) {
    return toFormError(error);
  }
  return { status: "success", redirectTo: `/q/${tokenOf(fd)}` };
}

export async function renewHoldAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { tenant, meta } = await context();
    await renewPublicHold(tenant, tokenOf(fd), meta);
  } catch (error) {
    return toFormError(error);
  }
  return { status: "success", redirectTo: `/q/${tokenOf(fd)}` };
}

export async function cancelBookingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const { tenant, meta } = await context();
    await cancelPublicBooking(tenant, tokenOf(fd), meta);
  } catch (error) {
    return toFormError(error);
  }
  return { status: "success", redirectTo: `/q/${tokenOf(fd)}` };
}
