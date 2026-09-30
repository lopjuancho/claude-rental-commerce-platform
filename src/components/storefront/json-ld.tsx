import { headers } from "next/headers";
import { type JsonLd as Data, serializeJsonLd } from "@/domain/storefront/seo";

/** Structured data block (nonce'd for the CSP; `<` escaped so it cannot break out). */
export async function JsonLd({ data }: { data: Data | Data[] }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // Built only from configured tenant data by the pure builders in domain/storefront/seo.ts,
      // serialized with <, > and & escaped.
      // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
