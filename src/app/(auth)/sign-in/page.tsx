import type { Metadata } from "next";
import Link from "next/link";
import { safeRedirectPath } from "@/domain/http/redirect";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeRedirectPath((await searchParams).next);
  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">Staff access for your rental business.</p>
      </div>
      <SignInForm next={next} />
      <p className="text-sm text-muted-foreground">
        Invited to a team?{" "}
        <Link
          className="font-medium text-primary underline"
          href={{ pathname: "/sign-up", query: { next } }}
        >
          Create your account
        </Link>
      </p>
    </>
  );
}
