import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { assignableRoles } from "@/domain/auth/permissions";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { revokeInvitationAction } from "../actions";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Team" };

export default async function MembersPage() {
  const ctx = await requireStaff("members.manage");
  const supabase = await createUserClient();

  const [members, invitations] = await Promise.all([
    supabase
      .from("organization_members")
      .select("user_id, role, status")
      .eq("organization_id", ctx.organizationId)
      .order("created_at"),
    supabase
      .from("organization_invitations")
      .select("id, email, role, expires_at")
      .eq("organization_id", ctx.organizationId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);
  if (members.error || invitations.error) throw new Error("Could not load team");

  const profiles = await supabase
    .from("user_profiles")
    .select("id, full_name")
    .in(
      "id",
      members.data.map((m) => m.user_id),
    );
  const names = new Map((profiles.data ?? []).map((p) => [p.id, p.full_name]));

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <Card>
        <CardHeader>
          <CardTitle>Invite a team member</CardTitle>
        </CardHeader>
        <CardContent>
          <InviteForm roles={assignableRoles(ctx.permissions)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {members.data.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between py-2 text-sm">
                <span>{names.get(m.user_id) ?? "Unnamed user"}</span>
                <span className="capitalize text-muted-foreground">
                  {m.role}
                  {m.status === "suspended" ? " · suspended" : ""}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {invitations.data.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {invitations.data.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {inv.email}{" "}
                    <span className="capitalize text-muted-foreground">· {inv.role}</span>
                  </span>
                  <form action={revokeInvitationAction}>
                    <input type="hidden" name="invitationId" value={inv.id} />
                    <Button size="sm" variant="outline" type="submit">
                      Revoke
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
