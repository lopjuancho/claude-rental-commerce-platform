export interface FormState {
  status: "idle" | "error" | "success";
  message?: string;
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
