import {
  handleAssistantDelete,
  handleAssistantGet,
  handleAssistantPost,
} from "@/server/ai/handler";

/** Storefront assistant endpoint (ADR 0017). All logic and checks live in the server module. */
export function POST(request: Request) {
  return handleAssistantPost(request);
}

export function GET(request: Request) {
  return handleAssistantGet(request);
}

export function DELETE(request: Request) {
  return handleAssistantDelete(request);
}
