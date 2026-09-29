import Link from "next/link";
import { Button } from "@/components/ui/button";

export function PricingNav({ current }: { current: "rules" | "delivery" | "tax" | "calculator" }) {
  const tabs = [
    ["rules", "/admin/pricing", "Rules"],
    ["delivery", "/admin/pricing/delivery", "Delivery"],
    ["tax", "/admin/pricing/tax", "Tax"],
    ["calculator", "/admin/pricing/calculator", "Price calculator"],
  ] as const;
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Pricing sections">
      {tabs.map(([key, href, label]) => (
        <Button key={key} asChild size="sm" variant={key === current ? "default" : "outline"}>
          <Link href={href} aria-current={key === current ? "page" : undefined}>
            {label}
          </Link>
        </Button>
      ))}
    </nav>
  );
}
