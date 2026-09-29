import "server-only";
import { z } from "zod";
import { priceRequestSchema } from "@/domain/pricing/context";
import { DomainError } from "@/domain/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { runPricing, verifyStoredCalculation } from "./run";

/** Staff pricing (admin calculator, quotes). Adjustments and saving need quotes.write. */
export async function priceForStaff(raw: unknown, opts: { save?: boolean } = {}) {
  const ctx = await requireStaff("org.read");
  const request = priceRequestSchema.parse(raw);
  if ((request.adjustments.length > 0 || opts.save) && !ctx.permissions.has("quotes.write")) {
    throw new DomainError("FORBIDDEN");
  }
  return runPricing(await createUserClient(), ctx.organizationId, request, {
    channel: "staff",
    save: opts.save ?? false,
  });
}

export async function verifyCalculation(id: string) {
  const ctx = await requireStaff("org.read");
  return verifyStoredCalculation(await createUserClient(), ctx.organizationId, z.uuid().parse(id));
}
