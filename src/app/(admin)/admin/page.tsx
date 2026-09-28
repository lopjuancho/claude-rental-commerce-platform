import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaff } from "@/server/auth/context";

export default async function AdminDashboard() {
  const ctx = await requireStaff("org.read");
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <Card>
        <CardHeader>
          <CardTitle>Foundation ready</CardTitle>
          <CardDescription>
            Catalog, availability, quotes and the assistant arrive in the next milestones.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Your permissions: {[...ctx.permissions].sort().join(", ")}
        </CardContent>
      </Card>
    </div>
  );
}
