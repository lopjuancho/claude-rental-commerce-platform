import type { EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { safeRedirectPath } from "@/domain/http/redirect";
import { createUserClient } from "@/server/db/user";

const OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];
const isOtpType = (value: string | null): value is EmailOtpType =>
  OTP_TYPES.includes(value as EmailOtpType);

/** Email confirmation / magic-link landing (Supabase token-hash flow). */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeRedirectPath(searchParams.get("next"));

  if (tokenHash && isOtpType(type)) {
    const supabase = await createUserClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, request.url));
  }
  return NextResponse.redirect(new URL("/sign-in?error=confirmation", request.url));
}
