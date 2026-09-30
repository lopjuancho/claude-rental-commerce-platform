export interface FormState {
  status: "idle" | "error" | "success";
  message?: string;
  /**
   * Where the browser should go next (storefront actions). Navigating client-side keeps the
   * visitor's own Host header; a server-action redirect() would render the target through an
   * internal request without it, and host-based tenant resolution would 404.
   */
  redirectTo?: string;
}

export const idleState: FormState = { status: "idle" };

export function FormMessage({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={
        state.status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {state.message}
    </p>
  );
}
