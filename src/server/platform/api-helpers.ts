import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, type AuthedUser } from "@/lib/auth";

/**
 * Shared request plumbing for the platform API: authentication, project
 * ownership, and uniform error envelopes (matching the existing /api/* style).
 */

export interface AuthedProject {
  user: AuthedUser;
  project: {
    id: string;
    name: string;
    kind: string;
    reference: string;
    description: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  };
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

export function notFound(error = "Not found"): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 404 });
}

export function serverError(error = "Internal error"): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 500 });
}

/** Resolve the authenticated user and verify project ownership in one step. */
export async function requireProject(projectId: string): Promise<AuthedProject | NextResponse> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: {
      id: true, name: true, kind: true, reference: true, description: true,
      status: true, createdAt: true, updatedAt: true,
    },
  });
  if (!project) return notFound("Project not found");
  return { user, project };
}
