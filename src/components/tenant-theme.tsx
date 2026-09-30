import type * as React from "react";

interface TenantThemeProps {
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor?: string | null;
  children: React.ReactNode;
  className?: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text color that reads best on the brand color (white unless the brand is light). */
export function readableOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance("#111827") + 0.05);
  return onWhite >= onDark ? "#ffffff" : "#111827";
}

/**
 * Applies a tenant's brand colors as CSS variables. Colors are validated as #rrggbb by a database
 * CHECK constraint and re-validated here, so nothing else can reach the style attribute.
 */
export function TenantTheme({
  primaryColor,
  secondaryColor,
  accentColor,
  children,
  className,
}: TenantThemeProps) {
  const style: Record<string, string> = {};
  if (primaryColor && HEX.test(primaryColor)) {
    style["--brand"] = primaryColor;
    style["--brand-foreground"] = readableOn(primaryColor);
  }
  if (secondaryColor && HEX.test(secondaryColor)) style["--brand-secondary"] = secondaryColor;
  if (accentColor && HEX.test(accentColor)) style["--brand-accent"] = accentColor;
  return (
    <div style={style} className={className}>
      {children}
    </div>
  );
}
