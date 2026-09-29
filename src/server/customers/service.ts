import "server-only";
import { z } from "zod";
import { contactInputSchema } from "@/domain/customers/contact";
import { DomainError } from "@/domain/errors";
import { fromEngineError } from "@/server/availability/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";

const CUSTOMER_COLUMNS =
  "id, first_name, last_name, company_name, email, phone_e164, sms_opt_in, email_opt_in, source, notes, archived_at, created_at";

export async function listCustomers(search?: string) {
  const ctx = await requireStaff("customers.read");
  const db = await createUserClient();
  let query = db
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("organization_id", ctx.organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  const q = search?.trim().replace(/[%_,()]/g, " ");
  if (q) {
    query = query.or(
      `first_name.ilike.%${q}%,last_name.ilike.%${q}%,company_name.ilike.%${q}%,email.ilike.%${q}%,phone_e164.ilike.%${q.replace(/\D/g, "") || q}%`,
    );
  }
  const { data, error } = await query;
  if (error) throw fromEngineError(error, "Customer");
  return data;
}

export async function getCustomer(id: string) {
  const ctx = await requireStaff("customers.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("organization_id", ctx.organizationId)
    .eq("id", z.uuid().parse(id))
    .maybeSingle();
  if (error) throw fromEngineError(error, "Customer");
  if (!data) throw new DomainError("NOT_FOUND", "Customer not found.");
  const quotes = await db
    .from("quotes")
    .select("id, quote_number, status, total_cents, currency, created_at")
    .eq("organization_id", ctx.organizationId)
    .eq("customer_id", data.id)
    .order("created_at", { ascending: false });
  if (quotes.error) throw fromEngineError(quotes.error, "Quote");
  return { ...data, quotes: quotes.data };
}

/** Creates a customer, or returns the existing one with the same email/phone (deduplicated). */
export async function createOrMatchCustomer(raw: unknown) {
  const ctx = await requireStaff("customers.write");
  const c = contactInputSchema.parse(raw);
  const db = await createUserClient();
  const { data, error } = await db.rpc("match_or_create_customer", {
    p_organization_id: ctx.organizationId,
    p_customer: { ...c, source: "admin" },
  });
  if (error) throw fromEngineError(error, "Customer");
  return data;
}

const updateSchema = z.object({
  id: z.uuid(),
  contact: contactInputSchema,
  notes: z.string().trim().max(4000).nullable(),
});

export async function updateCustomer(raw: unknown) {
  const ctx = await requireStaff("customers.write");
  const { id, contact, notes } = updateSchema.parse(raw);
  const db = await createUserClient();
  const { data, error } = await db
    .from("customers")
    .update({
      first_name: contact.firstName,
      last_name: contact.lastName,
      company_name: contact.companyName,
      email: contact.email,
      phone_e164: contact.phone,
      sms_opt_in: contact.smsOptIn,
      email_opt_in: contact.emailOptIn,
      notes,
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select("id");
  if (error) {
    if (error.code === "23505") {
      throw new DomainError("CONFLICT", "Another customer already uses that email or phone.");
    }
    throw fromEngineError(error, "Customer");
  }
  if (data.length === 0) throw new DomainError("NOT_FOUND", "Customer not found.");
}

export async function archiveCustomer(id: string) {
  const ctx = await requireStaff("customers.write");
  const db = await createUserClient();
  const { error } = await db
    .from("customers")
    .update({ archived_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("id", z.uuid().parse(id));
  if (error) throw fromEngineError(error, "Customer");
}
