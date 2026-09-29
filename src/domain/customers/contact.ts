import { z } from "zod";

/** Lower-cased, trimmed email, or null. Matching is case-insensitive in the database too (citext). */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  return v ? v : null;
}

/**
 * North American numbers to E.164 (+1XXXXXXXXXX); numbers already in +E.164 form are kept.
 * Returns null for empty input and throws for anything that is not a plausible phone number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (v.startsWith("+")) {
    const digits = v.slice(1).replace(/[\s().-]/g, "");
    if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
    throw new Error("Enter a valid phone number.");
  }
  let digits = v.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  throw new Error("Enter a valid 10-digit phone number.");
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

/** Contact details as entered by staff or a customer. At least one of email/phone is required. */
export const contactInputSchema = z
  .strictObject({
    firstName: optionalText(100),
    lastName: optionalText(100),
    companyName: optionalText(200),
    email: z
      .string()
      .trim()
      .max(254)
      .optional()
      .transform((v, ctx) => {
        const email = normalizeEmail(v);
        if (email && !z.email().safeParse(email).success) {
          ctx.addIssue({ code: "custom", message: "Enter a valid email address." });
          return z.NEVER;
        }
        return email;
      }),
    phone: z
      .string()
      .max(40)
      .optional()
      .transform((v, ctx) => {
        try {
          return normalizePhone(v);
        } catch (e) {
          ctx.addIssue({ code: "custom", message: (e as Error).message });
          return z.NEVER;
        }
      }),
    smsOptIn: z.boolean().default(false),
    emailOptIn: z.boolean().default(false),
  })
  .refine((c) => c.email !== null || c.phone !== null, {
    message: "Enter an email address or a phone number.",
    path: ["email"],
  });
export type ContactInput = z.infer<typeof contactInputSchema>;

export function displayName(c: {
  first_name: string | null;
  last_name: string | null;
  company_name?: string | null;
  email?: string | null;
  phone_e164?: string | null;
}): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return name || c.company_name || c.email || c.phone_e164 || "Unnamed customer";
}
