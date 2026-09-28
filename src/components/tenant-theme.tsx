import type * as React from "react";

interface TenantThemeProps {
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor?: string | null;
  children: React.ReactNode;
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
}: TenantThemeProps) {
  const hex = /^#[0-9a-fA-F]{6}$/;
  const style: Record<string, string> = {};
  if (primaryColor && hex.test(primaryColor)) style["--brand"] = primaryColor;
  if (secondaryColor && hex.test(secondaryColor)) style["--brand-secondary"] = secondaryColor;
  if (accentColor && hex.test(accentColor)) style["--brand-accent"] = accentColor;
  return <div style={style}>{children}</div>;
}
