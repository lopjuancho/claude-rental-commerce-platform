import {
  handleAssistantDelete,
  handleAssistantGet,
  handleAssistantPost,
} from "@/server/ai/handler";

/** Storefront assistant endpoint (ADR 0017). All logic and checks live in the server module. */
export function POST(request: Request) {
  return handleAssistantPost(request);
}

export function GET() {
  return handleAssistantGet();
}

export function DELETE() {
  return handleAssistantDelete();
}
