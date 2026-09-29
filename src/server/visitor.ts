import "server-only";
import { cookies } from "next/headers";
import { isWellFormedVisitorToken, VISITOR_COOKIE } from "./visitor-token";

export {
  generateVisitorToken,
  hashVisitorToken,
  isWellFormedVisitorToken,
  VISITOR_COOKIE,
  visitorCookieOptions,
} from "./visitor-token";

/**
 * The current visitor's token from the cookie the storefront issued, or null. Booking actions only
 * READ it: they never mint an identity (a request without one is refused and the page reload
 * establishes it), so concurrent first-use actions cannot each create their own visitor.
 */
export async function readVisitorToken(): Promise<string | null> {
  const current = (await cookies()).get(VISITOR_COOKIE)?.value;
  return isWellFormedVisitorToken(current) ? current : null;
}
