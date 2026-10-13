/**
 * Platform API client — typed wrappers over the Universal Platform endpoints
 * (projects, explorer, recon, research, graph, builder workspace, verifier,
 * orchestrations, connectors). Uses the shared envelope-aware fetch helpers.
 */

import { apiGet, apiPost, apiDelete } from "@/lib/api-client";

// --- Types -----------------------------------------------------------------

export interface ProjectCounts {
  pages: number;
  nodes: number;
  reports: number;
  orchestrations: number;
  verifications: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  kind: "website" | "github" | "file";
  reference: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  counts: ProjectCounts;
  lastOrchestration: { id: string; status: string; progress: number; currentStage: string | null } | null;
}

export interface OrchestrationStepView {
  id: string;
  stage: string;
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "awaiting_approval" | "cancelled";
  attempts: number;
  maxAttempts: number;
  error: string | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  output: unknown;
}

export interface OrchestrationView {
  id: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled" | "awaiting_approval";
  progress: number;
  currentStage: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  steps: OrchestrationStepView[];
}

export interface ProjectDetail {
  ok: true;
  project: { id: string; name: string; kind: string; reference: string; description: string | null; status: string; createdAt: string; updatedAt: string };
  counts: { pages: number; nodes: number; edges: number; reports: number; verifications: number };
  reports: Array<{ id: string; query: string; summary: string | null; createdAt: string }>;
  verifications: Array<{ id: string; url: string | null; score: number | null; regression: boolean | null; createdAt: string }>;
  orchestrations: OrchestrationView[];
}

export interface CrawlPageView {
  id: string;
  url: string;
  status: number;
  title: string | null;
  description: string | null;
  depth: number;
  tech: string[];
  excerpt: string | null;
  contentHash: string | null;
  fetchedAt: string;
}

export interface CrawlResponse {
  ok: true;
  summary: { pages: number; errors: number; tech: string[]; urls: string[]; robots: { fetched: boolean; sitemaps: number; disallowCount: number } };
  render: { available: boolean; title?: string; detail?: string; screenshotBase64?: string } | null;
}

export interface WorkspaceEntryView {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface WorkspaceStatusView {
  exists: boolean;
  fileCount: number;
  hasManifest: boolean;
  manifestKind: string | null;
  topEntries: WorkspaceEntryView[];
}

export interface GraphNodeView {
  id: string;
  kind: string;
  key: string;
  label: string;
  provenance: string;
  meta: unknown;
}

export interface GraphEdgeView {
  fromKind: string;
  fromKey: string;
  toKind: string;
  toKey: string;
  kind: string;
  provenance: string;
}

export interface GraphSnapshotView {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
}

export interface VerifyCheckView {
  name: string;
  passed: boolean;
  detail: string;
  ms: number;
}

export interface VerifyResultView {
  score: number;
  checks: VerifyCheckView[];
  url: string;
  regression: boolean | null;
  scoreDelta: number | null;
  diffSummary: string | null;
  browserAvailable: boolean;
}

export interface VerifyRunView {
  id: string;
  url: string | null;
  score: number | null;
  regression: boolean | null;
  diffSummary: string | null;
  checks: VerifyCheckView[];
  createdAt: string;
}

export interface ConnectorView {
  id: string;
  name: string;
  kind: "builtin" | "http" | "mcp";
  endpoint: string | null;
  hasSecrets: boolean;
  status: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface BuiltinView {
  id: string;
  name: string;
  description: string;
  inputHint: string;
}

export interface ResearchReportView {
  id: string;
  query: string;
  summary: string | null;
  reportMd: string | null;
  sources: Array<{ title: string; url: string; snippet?: string; kind: string }>;
  createdAt: string;
}

// --- API wrappers ------------------------------------------------------------

export const platformApi = {
  listProjects: () => apiGet<{ ok: true; projects: ProjectSummary[] }>("/api/projects").then((r) => r.projects),

  createProject: (body: { name: string; kind: string; reference?: string; targetId?: string; description?: string }) =>
    apiPost<{ ok: true; project: { id: string } }>("/api/projects", body),

  deleteProject: (id: string) => apiDelete<{ ok: true }>(`/api/projects/${id}`),

  getProject: (id: string) => apiGet<ProjectDetail>(`/api/projects/${id}`),

  crawl: (id: string, body: { maxPages?: number; maxDepth?: number; render?: boolean }) =>
    apiPost<CrawlResponse>(`/api/projects/${id}/crawl`, body),

  listCrawlPages: (id: string) =>
    apiGet<{ ok: true; pages: CrawlPageView[] }>(`/api/projects/${id}/crawl`).then((r) => r.pages),

  recon: (id: string, action: "materialize" | "parse") =>
    apiPost<{ ok: boolean; detail?: string; summary?: unknown }>(`/api/projects/${id}/recon`, { action }),

  workspaceStatus: (id: string) =>
    apiGet<{ ok: true; workspace: WorkspaceStatusView }>(`/api/projects/${id}/workspace`).then((r) => r.workspace),

  workspaceList: (id: string, path: string) =>
    apiPost<{ ok: true; entries: WorkspaceEntryView[] }>(`/api/projects/${id}/workspace`, { op: "list", path }).then((r) => r.entries),

  workspaceRead: (id: string, path: string) =>
    apiPost<{ ok: true; path: string; content: string }>(`/api/projects/${id}/workspace`, { op: "read", path }),

  workspaceWrite: (id: string, path: string, content: string) =>
    apiPost<{ ok: true; path: string; bytes: number; created: boolean }>(`/api/projects/${id}/workspace`, { op: "write", path, content }),

  workspacePatch: (id: string, path: string, find: string, replace: string) =>
    apiPost<{ ok: boolean; path: string; applied: boolean; reason?: string }>(`/api/projects/${id}/workspace`, { op: "patch", path, find, replace }),

  workspaceTerminal: (id: string, command: string) =>
    apiPost<{ ok: boolean; exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number; blocked?: string }>(
      `/api/projects/${id}/workspace`, { op: "terminal", command }
    ),

  graph: (id: string) =>
    apiGet<{ ok: true; graph: GraphSnapshotView }>(`/api/projects/${id}/graph`).then((r) => r.graph),

  research: (id: string, query: string) =>
    apiPost<{ ok: true; result: { reportMd: string; summary: string; sources: ResearchReportView["sources"] } }>(
      `/api/projects/${id}/research`, { query }
    ),

  listResearch: (id: string) =>
    apiGet<{ ok: true; reports: ResearchReportView[] }>(`/api/projects/${id}/research`).then((r) => r.reports),

  verify: (id: string, body: { url?: string; referenceUrl?: string }) =>
    apiPost<{ ok: true; result: VerifyResultView }>(`/api/projects/${id}/verify`, body).then((r) => r.result),

  listVerify: (id: string) =>
    apiGet<{ ok: true; browser: { available: boolean; detail: string }; runs: VerifyRunView[] }>(`/api/projects/${id}/verify`),

  orchestrate: (id: string, goal: string) =>
    apiPost<{ ok: true; orchestrationId: string }>(`/api/projects/${id}/orchestrate`, { action: "start", goal }),

  orchestrateApprove: (id: string, orchestrationId: string, stepId: string, approved: boolean) =>
    apiPost<{ ok: true }>(`/api/projects/${id}/orchestrate`, { action: "approve", orchestrationId, stepId, approved }),

  orchestrateCancel: (id: string, orchestrationId: string) =>
    apiPost<{ ok: true }>(`/api/projects/${id}/orchestrate`, { action: "cancel", orchestrationId }),

  listConnectors: () =>
    apiGet<{ ok: true; builtins: BuiltinView[]; connectors: ConnectorView[] }>("/api/connectors"),

  createConnector: (body: { name: string; kind: "http" | "mcp"; endpoint: string; headers?: Record<string, string>; config?: { args?: string[]; method?: string } }) =>
    apiPost<{ ok: true }>("/api/connectors", body),

  deleteConnector: (id: string) => apiDelete<{ ok: true }>(`/api/connectors/${id}`),

  testConnector: (id: string) =>
    apiPost<{ ok: boolean; result: { ok: boolean; detail: string; tools?: Array<{ name: string; description?: string }> } }>(`/api/connectors/${id}`, { action: "test" }),

  invokeConnector: (id: string, input: Record<string, unknown>) =>
    apiPost<{ ok: true; result: { ok: boolean; detail: string; kind?: string } }>(`/api/connectors/${id}`, { action: "invoke", input }).then((r) => r.result),
};
