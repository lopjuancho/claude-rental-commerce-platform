import "server-only";
import { z } from "zod";
import { priceRequestSchema } from "@/domain/pricing/context";
import { DomainError } from "@/domain/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { getDistanceProvider } from "@/server/delivery/provider";
import { systemGateway } from "@/server/trusted/gateway";
import { runPricing, userPricingSource, verifyStoredCalculation } from "./run";

/**
 * Staff pricing (admin calculator, quotes). Staff choose items, times, address, codes and — with
 * quotes.write — adjustments with a reason; the server computes and (if asked) stores the result.
 * Saved adjustments are audited (staff member, amounts, reasons) by runPricing.
 */
export async function priceForStaff(raw: unknown, opts: { save?: boolean } = {}) {
  const ctx = await requireStaff("org.read");
  const request = priceRequestSchema.parse(raw);
  if ((request.adjustments.length > 0 || opts.save) && !ctx.permissions.has("quotes.write")) {
    throw new DomainError("FORBIDDEN");
  }
  const db = await createUserClient();
  const run = await runPricing(
    {
      source: userPricingSource(db, ctx.organizationId),
      gateway: systemGateway(),
      provider: getDistanceProvider(),
      actor: { type: "user", userId: ctx.user.id },
    },
    ctx.organizationId,
    request,
    { channel: "staff", save: opts.save ?? false },
  );
  return run;
}

export async function verifyCalculation(id: string) {
  const ctx = await requireStaff("org.read");
  return verifyStoredCalculation(await createUserClient(), ctx.organizationId, z.uuid().parse(id));
}
