import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth redirection for the workspace routes.
 *
 * Middleware can only check cookie PRESENCE (the signed `rea_session` cookie
 * the platform issues on login) — the cookie's validity is verified
 * per-request by the API/server via the AuthSession table. Its job here is
 * to bounce obviously-unauthenticated deep links to the landing page with
 * `?auth=signin`, which opens the sign-in tab of the auth gate.
 */
const PROTECTED_PREFIXES = ["/chat", "/projects", "/targets", "/settings", "/admin"];

export function middleware(req: NextRequest) {
  if (req.cookies.has("rea_session")) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  if (!isProtected) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("auth", "signin");
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/chat/:path*",
    "/projects/:path*",
    "/targets/:path*",
    "/settings/:path*",
    "/admin/:path*",
  ],
};
