"use client";

import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { FormState } from "@/components/form-message";

/** Follows a storefront action's `redirectTo` in the browser (same URL → refresh its data). */
export function useFollowRedirect(state: FormState) {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (state.status !== "success" || !state.redirectTo) return;
    if (state.redirectTo === pathname) router.refresh();
    else router.push(state.redirectTo as Route);
  }, [state, router, pathname]);
}
