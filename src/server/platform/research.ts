import * as cheerio from "cheerio";
import ZAI from "z-ai-web-dev-sdk";
import { safeFetch } from "./net";
import { upsertGraph } from "./graph";
import { zaiPlatformChat } from "@/server/agent/platform-llm";
import { openHeaders } from "@/server/agent/vault";
import { db } from "@/lib/db";

/**
 * AREA Research Agent — cited external research.
 *
 * Capabilities: platform web search (with citations), GitHub repository
 * analysis (REST API), documentation discovery (llms.txt convention + /docs
 * probing), YouTube metadata (oEmbed), and an LLM-synthesized cited report.
 * Every claim in a report must carry a source URL — the synthesis prompt is
 * explicitly instructed to mark anything it cannot source as UNKNOWN.
 */

export interface ResearchSource {
  title: string;
  url: string;
  snippet?: string;
  kind: "web" | "github" | "docs" | "youtube" | "note";
}

export interface ResearchResult {
  query: string;
  reportMd: string;
  summary: string;
  sources: ResearchSource[];
}

// --- Web search (platform capability) -------------------------------------

export async function platformWebSearch(query: string, num = 8): Promise<Array<{ name: string; url: string; snippet: string; host?: string }>> {
  const zai = await ZAI.create();
  const results = (await zai.functions.invoke("web_search", {
    query,
    num: Math.min(Math.max(num, 3), 12),
  })) as Array<{ name?: string; url?: string; snippet?: string; host_name?: string }>;
  return (results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      name: (r.name ?? r.url!).slice(0, 200),
      url: r.url!,
      snippet: (r.snippet ?? "").slice(0, 400),
      host: r.host_name,
    }));
}

// --- GitHub repository analysis --------------------------------------------

const GH_HEADERS: Record<string, string> = {
  "accept": "application/vnd.github+json",
  "user-agent": "AREA-Platform/1.0",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

/**
 * GitHub REST calls honor the user's own credentials: when the user has a
 * registered HTTP connector targeting api.github.com, its sealed headers
 * (e.g. a personal access token) are opened from the vault and layered over
 * the platform defaults — lifting the shared-IP 60/hr unauthenticated quota.
 * Headers are resolved per call and never logged or returned to any client.
 */
async function githubHeadersForUser(userId: string | undefined): Promise<Record<string, string>> {
  if (!userId) return {};
  try {
    const connectors = await db.connector.findMany({
      where: { userId, kind: "http" },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    const rank = (s: string) => (s === "healthy" ? 0 : s === "unknown" ? 1 : 2);
    const match = connectors
      .filter((c) => {
        try {
          return Boolean(c.endpoint && new URL(c.endpoint).host === "api.github.com");
        } catch {
          return false;
        }
      })
      .sort((a, b) => rank(a.status) - rank(b.status))[0];
    if (!match) return {};
    return openHeaders(match.sealedHeaders);
  } catch {
    return {};
  }
}

/** Parse "owner/repo", a github.com URL, or a full git URL into owner/repo. */
export function parseGitHubRef(raw: string): { owner: string; repo: string } | null {
  const cleaned = raw.trim().replace(/\.git$/, "");
  let m = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (m) return { owner: m[1], repo: m[2] };
  m = cleaned.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

export interface GitHubAnalysis {
  fullName: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  language: string;
  license: string;
  pushedAt: string;
  defaultBranch: string;
  homepage: string;
  topics: string[];
  languages: Record<string, number>;
  treeTopLevel: Array<{ name: string; type: string }>;
  readmeExcerpt: string | null;
  latestRelease: { tag: string; name: string; date: string } | null;
  err?: string;
}

export async function analyzeGitHubRepo(
  ref: string,
  userId?: string
): Promise<{ analysis: GitHubAnalysis | null; sources: ResearchSource[] }> {
  const parsed = parseGitHubRef(ref);
  if (!parsed) return { analysis: null, sources: [] };
  const { owner, repo } = parsed;
  const sources: ResearchSource[] = [];
  const headers = { ...GH_HEADERS, ...(await githubHeadersForUser(userId)) };
  const j = async (path: string): Promise<unknown> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status}`);
    return res.json();
  };

  try {
    const repoMeta = (await j(`/repos/${owner}/${repo}`)) as Record<string, unknown>;
    const fullName = String(repoMeta.full_name ?? `${owner}/${repo}`);
    sources.push({ title: `${fullName} — repository metadata`, url: `https://github.com/${fullName}`, kind: "github" });

    let languages: Record<string, number> = {};
    try {
      languages = (await j(`/repos/${fullName}/languages`)) as Record<string, number>;
    } catch {
      /* optional */
    }

    let treeTopLevel: Array<{ name: string; type: string }> = [];
    try {
      const branch = String(repoMeta.default_branch ?? "main");
      const tree = (await j(`/repos/${fullName}/git/trees/${branch}`)) as { tree?: Array<{ path: string; type: string }> };
      treeTopLevel = (tree.tree ?? []).slice(0, 40).map((t) => ({ name: t.path, type: t.type }));
    } catch {
      /* optional */
    }

    let readmeExcerpt: string | null = null;
    try {
      const readme = (await j(`/repos/${fullName}/readme`)) as { content?: string };
      if (readme.content) {
        readmeExcerpt = Buffer.from(readme.content, "base64").toString("utf8").slice(0, 4_000);
      }
    } catch {
      /* optional */
    }

    let latestRelease: GitHubAnalysis["latestRelease"] = null;
    try {
      const rel = (await j(`/repos/${fullName}/releases/latest`)) as Record<string, unknown>;
      latestRelease = {
        tag: String(rel.tag_name ?? ""),
        name: String(rel.name ?? ""),
        date: String(rel.published_at ?? ""),
      };
    } catch {
      /* no releases */
    }

    const analysis: GitHubAnalysis = {
      fullName,
      description: String(repoMeta.description ?? ""),
      stars: Number(repoMeta.stargazers_count ?? 0),
      forks: Number(repoMeta.forks_count ?? 0),
      openIssues: Number(repoMeta.open_issues_count ?? 0),
      language: String(repoMeta.language ?? ""),
      license: String((repoMeta.license as { spdx_id?: string } | null)?.spdx_id ?? "unknown"),
      pushedAt: String(repoMeta.pushed_at ?? ""),
      defaultBranch: String(repoMeta.default_branch ?? "main"),
      homepage: String(repoMeta.homepage ?? ""),
      topics: (repoMeta.topics as string[] | undefined) ?? [],
      languages,
      treeTopLevel,
      readmeExcerpt,
      latestRelease,
    };
    return { analysis, sources };
  } catch (err) {
    return {
      analysis: null,
      sources: [
        ...sources,
        {
          title: `GitHub API error: ${err instanceof Error ? err.message : String(err)}`,
          url: `https://github.com/${owner}/${repo}`,
          kind: "note",
        },
      ],
    };
  }
}

// --- Documentation discovery ------------------------------------------------

export async function discoverDocs(baseUrl: string): Promise<{ sources: ResearchSource[] }> {
  const sources: ResearchSource[] = [];
  const origin = new URL(baseUrl).origin;
  const candidates = [`${origin}/llms.txt`, `${origin}/docs`, `${origin}/documentation`, `${origin}/docs/index.html`];
  for (const url of candidates.slice(0, 3)) {
    try {
      const res = await safeFetch(url, { maxBytes: 512 * 1024, timeoutMs: 10_000 });
      if (res.status !== 200) continue;
      const ct = res.contentType;
      if (ct.includes("html")) {
        const $ = cheerio.load(res.body.toString("utf8").slice(0, 300_000));
        const title = ($("title").first().text() || url).slice(0, 160);
        const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 800);
        sources.push({ title, url, snippet: text, kind: "docs" });
      } else {
        const text = res.body.toString("utf8").slice(0, 1_200);
        sources.push({ title: url.endsWith("llms.txt") ? "llms.txt (docs index)" : "documentation", url, snippet: text, kind: "docs" });
      }
      if (sources.length >= 2) break;
    } catch {
      /* probe failed — fine */
    }
  }
  return { sources };
}

// --- YouTube metadata -------------------------------------------------------

export async function youtubeMetadata(rawUrl: string): Promise<ResearchSource | null> {
  let id: string | null = null;
  let m = rawUrl.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/);
  if (m) id = m[1];
  if (!id) return null;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    return {
      title: `YouTube: ${j.title ?? id} (by ${j.author_name ?? "unknown"})`,
      url: `https://www.youtube.com/watch?v=${id}`,
      snippet: "Metadata via oEmbed. Transcript extraction is not available without a licensed transcript source — marked UNKNOWN rather than guessed.",
      kind: "youtube",
    };
  } catch {
    return null;
  }
}

// --- Synthesis --------------------------------------------------------------

function buildReportPrompt(query: string, sources: ResearchSource[]): string {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] (${s.kind}) ${s.title}\n    URL: ${s.url}\n    ${s.snippet ?? ""}`)
    .join("\n");
  return `You are the AREA research analyst. Produce a concise cited markdown report for this query: "${query}".

SOURCES (each claim MUST cite [n] pointing at one of these):
${sourceBlock}

Rules:
- Every non-trivial claim gets a [n] citation. If no source supports a claim, either omit it or mark it explicitly as "UNKNOWN (no source)".
- Structure: ## Summary (3-5 bullets), ## Findings (numbered, cited), ## Open questions / UNKNOWN.
- Do not invent URLs, versions, or numbers. Do not pad. Keep under 500 words.`;
}

export async function runResearch(
  projectId: string,
  query: string
): Promise<ResearchResult> {
  const sources: ResearchSource[] = [];

  // 0. The project record — its owner decides whose connectors apply.
  const project = await db.project.findUnique({ where: { id: projectId } });

  // 1. Platform web search (always).
  let webResults: Array<{ name: string; url: string; snippet: string }> = [];
  try {
    webResults = await platformWebSearch(query, 8);
    for (const r of webResults) {
      sources.push({ title: r.name, url: r.url, snippet: r.snippet, kind: "web" });
    }
  } catch (err) {
    sources.push({
      title: `Web search unavailable: ${err instanceof Error ? err.message : String(err)}`,
      url: "platform://web-search",
      kind: "note",
    });
  }

  // 2. GitHub analysis when the query references a repository.
  const ghRefMatch = query.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  if (ghRefMatch && parseGitHubRef(ghRefMatch[1])) {
    const gh = await analyzeGitHubRepo(ghRefMatch[1], project?.userId);
    sources.push(...gh.sources);
    if (gh.analysis) {
      sources.push({
        title: `${gh.analysis.fullName}: ${gh.analysis.stars}★ ${gh.analysis.language}, license ${gh.analysis.license}, last push ${gh.analysis.pushedAt.slice(0, 10)}`,
        url: `https://github.com/${gh.analysis.fullName}`,
        snippet: gh.analysis.description,
        kind: "github",
      });
    }
  }

  // 3. YouTube metadata when the query mentions a video.
  const ytMatch = query.match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/);
  if (ytMatch) {
    const yt = await youtubeMetadata(ytMatch[0]);
    if (yt) sources.push(yt);
  }

  // 4. Docs discovery for website projects.
  if (project?.kind === "website") {
    try {
      const docs = await discoverDocs(project.reference);
      sources.push(...docs.sources);
    } catch {
      /* optional */
    }
  }

  // 5. LLM synthesis (cited). If no platform model is available, return a
  //    source-only report — honest degradation, never a fabricated summary.
  let reportMd = "";
  let summary = "";
  if (sources.some((s) => s.kind !== "note")) {
    try {
      reportMd = await zaiPlatformChat([
        { role: "system", content: "You produce strictly-cited research reports. Never fabricate." },
        { role: "user", content: buildReportPrompt(query, sources.slice(0, 16)) },
      ]);
      summary = reportMd.match(/##\s*Summary\s*\n([\s\S]{0,600}?)(?:\n## |$)/)?.[1]?.trim().slice(0, 600) ?? "";
    } catch (err) {
      reportMd = `> LLM synthesis unavailable (${err instanceof Error ? err.message : String(err)}). Raw sources below — no unverified claims are made.\n\n` +
        sources.map((s, i) => `${i + 1}. **${s.title}** — ${s.url}${s.snippet ? `\n   ${s.snippet}` : ""}`).join("\n");
    }
  } else {
    reportMd = "> No usable sources found for this query. Nothing was fabricated to fill the gap.\n" +
      sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join("\n");
  }

  // Persist the report + reference nodes in the graph.
  const nodes = sources
    .filter((s) => s.kind !== "note")
    .slice(0, 30)
    .map((s) => ({
      kind: "finding" as const,
      key: `source:${s.url}`,
      label: s.title.slice(0, 200),
      meta: { url: s.url, kind: s.kind },
      provenance: "OBSERVED" as const,
    }));
  await upsertGraph(projectId, nodes, []);

  const report = await db.researchReport.create({
    data: {
      projectId,
      query: query.slice(0, 500),
      summary: summary || null,
      reportMd,
      sources: JSON.stringify(sources.slice(0, 40)),
    },
  });
  void report;

  return { query, reportMd, summary, sources };
}
