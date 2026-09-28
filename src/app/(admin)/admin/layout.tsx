import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { safeRedirectPath } from "@/domain/http/redirect";
import { getSessionUser } from "@/server/auth/session";
import { getRequestPathname } from "@/server/request";
import { getStaffContext } from "@/server/auth/context";
import { signOutAction } from "../../(auth)/actions";
import { switchOrganizationAction } from "./actions";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) {
    const next = safeRedirectPath(await getRequestPathname());
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }
  const ctx = await getStaffContext();

  if (!ctx) {
    return (
      <main className="mx-auto grid max-w-md gap-4 p-6">
        <h1 className="text-xl font-semibold">No organization access</h1>
        <p className="text-sm text-muted-foreground">
          Your account ({user.email}) is not a member of any organization. Ask an owner or admin for
          an invitation.
        </p>
        <form action={signOutAction}>
          <Button variant="outline" type="submit">
            Sign out
          </Button>
        </form>
      </main>
    );
  }

  const active = ctx.memberships.find((m) => m.organizationId === ctx.organizationId);

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="font-semibold">{active?.organizationName}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{ctx.role}</span>
        {ctx.memberships.length > 1 ? (
          <form action={switchOrganizationAction} className="flex items-center gap-2">
            <label htmlFor="organizationId" className="sr-only">
              Organization
            </label>
            <select
              id="organizationId"
              name="organizationId"
              defaultValue={ctx.organizationId}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              {ctx.memberships.map((m) => (
                <option key={m.organizationId} value={m.organizationId}>
                  {m.organizationName}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" type="submit">
              Switch
            </Button>
          </form>
        ) : null}
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin">Dashboard</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin/catalog">Catalog</Link>
          </Button>
          {ctx.permissions.has("members.manage") ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/members">Team</Link>
            </Button>
          ) : null}
          <form action={signOutAction}>
            <Button size="sm" variant="ghost" type="submit">
              Sign out
            </Button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-6">{children}</main>
    </div>
  );
}
