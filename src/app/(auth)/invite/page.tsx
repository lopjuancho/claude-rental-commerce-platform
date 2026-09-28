import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/server/auth/session";
import { AcceptInvitationForm } from "./accept-form";

export const metadata: Metadata = { title: "Accept invitation", referrer: "no-referrer" };

/**
 * Invitation landing page. Accepting is a POST (server action), never a side effect of GET,
 * so link previews and prefetchers cannot consume an invitation.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  const user = await getSessionUser();
  const next = `/invite?token=${encodeURIComponent(token)}`;

  if (token.length < 32) {
    return <h1 className="text-xl font-semibold">This invitation link is incomplete.</h1>;
  }

  if (!user) {
    return (
      <>
        <h1 className="text-2xl font-semibold">You&apos;ve been invited</h1>
        <p className="text-sm text-muted-foreground">
          Sign in, or create an account with the email address the invitation was sent to.
        </p>
        <div className="grid gap-3">
          <Button asChild>
            <Link href={{ pathname: "/sign-in", query: { next } }}>Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={{ pathname: "/sign-up", query: { next } }}>Create account</Link>
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">Join your team</h1>
      <p className="text-sm text-muted-foreground">Signed in as {user.email}.</p>
      <AcceptInvitationForm token={token} />
    </>
  );
}
