import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness only; reveals no configuration or dependency details. */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
