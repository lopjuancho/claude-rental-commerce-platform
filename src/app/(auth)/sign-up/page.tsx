import type { Metadata } from "next";
import { safeRedirectPath } from "@/domain/http/redirect";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeRedirectPath((await searchParams).next);
  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Create your account</h1>
        <p className="text-sm text-muted-foreground">
          You&apos;ll join your team after accepting your invitation.
        </p>
      </div>
      <SignUpForm next={next} />
    </>
  );
}
