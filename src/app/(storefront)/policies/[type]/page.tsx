import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs, Container } from "@/components/storefront/ui";
import { metaDescription } from "@/domain/storefront/seo";
import { storefrontMetadata } from "@/server/public/site";
import { getShell } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

type Params = Promise<{ type: string }>;

/** Only published, non-placeholder policies of the host's tenant are exposed (the view enforces it). */
async function context(params: Params) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const store = await getShell(tenant);
  const { type } = await params;
  const policy = store.profile.policies.find((p) => p.type === type);
  if (!policy) notFound();
  return { tenant, policy };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tenant, policy } = await context(params);
  return storefrontMetadata({
    tenant,
    path: `/policies/${policy.type}`,
    title: `${policy.title} | ${tenant.name}`,
    description: metaDescription(policy.body),
    type: "article",
  });
}

export default async function PolicyPage({ params }: { params: Params }) {
  const { policy } = await context(params);
  const updated = policy.updatedAt ? new Date(policy.updatedAt) : null;
  return (
    <Container className="grid max-w-3xl gap-6 py-8 sm:py-12">
      <Breadcrumbs
        crumbs={[
          { name: "Home", path: "/" },
          { name: policy.title, path: `/policies/${policy.type}` },
        ]}
      />
      <article className="grid gap-4">
        <h1 className="text-3xl font-extrabold tracking-tight">{policy.title}</h1>
        {updated && !Number.isNaN(updated.getTime()) ? (
          <p className="text-sm text-muted-foreground">
            Last updated{" "}
            <time dateTime={updated.toISOString()}>
              {updated.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })}
            </time>
          </p>
        ) : null}
        {/* Rendered as plain text: policy bodies are tenant-authored and never interpreted as HTML. */}
        {policy.body.split(/\n{2,}/).map((para, i) => (
          // Paragraphs of immutable text: position is their identity.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <p key={i} className="whitespace-pre-line leading-relaxed">
            {para}
          </p>
        ))}
      </article>
    </Container>
  );
}
