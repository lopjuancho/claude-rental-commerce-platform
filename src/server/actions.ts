import "server-only";
import { z } from "zod";
import { isDomainError } from "@/domain/errors";
import type { FormState } from "@/components/form-message";

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You don't have permission to do that.",
  RATE_LIMITED: "Too many attempts. Please wait a minute and try again.",
  CONFLICT: "That already exists.",
  NOT_FOUND: "Not found.",
};

/** Maps any thrown error to a safe form state. Unknown errors are logged, never shown. */
export function toFormError(error: unknown): FormState {
  if (error instanceof z.ZodError) {
    return { status: "error", message: error.issues[0]?.message ?? "Please check the form." };
  }
  if (isDomainError(error)) {
    return { status: "error", message: MESSAGES[error.code] ?? error.message };
  }
  console.error(error);
  return { status: "error", message: "Something went wrong. Please try again." };
}
