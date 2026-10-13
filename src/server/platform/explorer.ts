import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { db } from "@/lib/db";
import { safeFetch, BlockedUrlError } from "./net";
import { upsertGraph, type NodeRef, type EdgeRef } from "./graph";

/**
 * REA Explorer — polite website crawler.
 *
 * Discovers a site's publicly observable surface: pages, navigation links,
 * page titles/descriptions, and technology fingerprints from headers/markup.
 * Everything is treated as UNTRUSTED DATA: bounded page counts, bounded
 * extraction, robots.txt respected, SSRF-guarded fetches, no script execution.
 *
 * Findings flow into the knowledge graph as OBSERVED page/asset/tech nodes.
 */

export interface CrawlOptions {
  maxPages?: number; // hard cap per run
  maxDepth?: number;
  concurrency?: number; // same-origin politeness: small
  includePaths?: string[]; // substring filters
  excludePaths?: string[];
}

export interface CrawlSummary {
  pages: number;
  errors: number;
  tech: string[];
  urls: string[];
  robots: { fetched: boolean; sitemaps: number; disallowCount: number };
}

const EXTRACT_BUDGET = 6_000; // text excerpt chars per page
const MAX_LINKS_PER_PAGE = 120;

interface RobotsRules {
  fetched: boolean;
  disallow: string[];
  sitemaps: string[];
}

async function fetchRobots(origin: string): Promise<RobotsRules> {
  const empty: RobotsRules = { fetched: false, disallow: [], sitemaps: [] };
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { maxBytes: 256 * 1024 });
    if (res.status !== 200) return empty;
    const text = res.body.toString("utf8").slice(0, 256 * 1024);
    const rules: RobotsRules = { fetched: true, disallow: [], sitemaps: [] };
    let appliesToUs = false; // only the * group (we don't authenticate)
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split("#")[0].trim();
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "user-agent") appliesToUs = value === "*";
      if (!appliesToUs) continue;
      if (key === "disallow" && value) rules.disallow.push(value);
      if (key === "sitemap" && value) rules.sitemaps.push(value);
    }
    return rules;
  } catch {
    return empty; // unreachable robots.txt — proceed politely with our own caps
  }
}

function robotsAllows(rules: RobotsRules, pathname: string): boolean {
  for (const d of rules.disallow) {
    if (d === "/") return false;
    if (d.endsWith("*")) {
      if (pathname.startsWith(d.slice(0, -1))) return false;
    } else if (pathname.startsWith(d)) {
      return false;
    }
  }
  return true;
}

// --- Technology fingerprinting (all signals observed from public responses) --

interface TechSignal {
  name: string;
  where: "header" | "markup";
  detail?: string;
}

function fingerprintHeaders(headers: Record<string, string>): TechSignal[] {
  const out: TechSignal[] = [];
  const h = (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? "";
  const server = h("server");
  if (server) out.push({ name: `server:${server.split("/")[0].trim().toLowerCase()}`, where: "header", detail: server });
  const powered = h("x-powered-by");
  if (powered) out.push({ name: `x-powered-by:${powered.toLowerCase().slice(0, 60)}`, where: "header", detail: powered });
  const gen = h("x-generator");
  if (gen) out.push({ name: `x-generator:${gen.toLowerCase().slice(0, 60)}`, where: "header", detail: gen });
  const cf = h("cf-ray");
  if (cf) out.push({ name: "cdn:cloudflare", where: "header" });
  if (h("x-vercel-id")) out.push({ name: "host:vercel", where: "header" });
  if (h("x-amz-cf-id")) out.push({ name: "cdn:aws-cloudfront", where: "header" });
  return out;
}

function fingerprintMarkup($: cheerio.CheerioAPI, html: string): TechSignal[] {
  const out: TechSignal[] = [];
  const gen = $('meta[name="generator"]').attr("content");
  if (gen) out.push({ name: `generator:${gen.toLowerCase().slice(0, 60)}`, where: "markup", detail: gen });
  // Framework markers in served markup (observed, not inferred).
  if ($("__next").length || html.includes("/_next/static")) out.push({ name: "framework:nextjs", where: "markup" });
  if (html.includes("ng-version=")) {
    const v = $("app-root, [ng-version]").attr("ng-version");
    out.push({ name: `framework:angular${v ? " " + v : ""}`, where: "markup" });
  }
  if ($("[data-reactroot]").length || html.includes("react-dom")) out.push({ name: "framework:react", where: "markup" });
  if ($("[data-v-app]").length || html.includes("vue.runtime")) out.push({ name: "framework:vue", where: "markup" });
  if ($("[data-svelte-h]").length || html.includes("svelte-")) out.push({ name: "framework:svelte", where: "markup" });
  if (html.includes("wp-content/") || html.includes("wp-includes/")) out.push({ name: "cms:wordpress", where: "markup" });
  for (const s of $("script[src]").toArray().slice(0, 40)) {
    const src = $(s).attr("src") ?? "";
    if (/gtag\(|googletagmanager|google-analytics/.test(src)) out.push({ name: "analytics:google", where: "markup" });
    if (/plausible\.io/.test(src)) out.push({ name: "analytics:plausible", where: "markup" });
    if (/segment\.com|analytics\.js/.test(src)) out.push({ name: "analytics:segment", where: "markup" });
    if (/hotjar/.test(src)) out.push({ name: "analytics:hotjar", where: "markup" });
    if (/stripe\.com\/v3/.test(src)) out.push({ name: "payments:stripe", where: "markup" });
    if (/js\.stripe|paypal\.com/.test(src)) out.push({ name: "payments:paypal", where: "markup" });
  }
  return out;
}

// --- Extraction ----------------------------------------------------------

interface ExtractedPage {
  url: string;
  status: number;
  title: string | null;
  description: string | null;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  textExcerpt: string | null;
  links: Array<{ href: string; text: string }>;
  tech: TechSignal[];
  contentHash: string;
}

function extractPage(res: { url: string; status: number; headers: Record<string, string>; body: Buffer; contentType: string }): ExtractedPage | null {
  const ct = res.contentType.toLowerCase();
  if (!ct.includes("html") && !ct.includes("xhtml")) return null; // binary/asset — recorded, not parsed
  const html = res.body.toString("utf8").slice(0, 2 * 1024 * 1024);
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const links: Array<{ href: string; text: string }> = [];
  for (const a of $("a[href]").toArray()) {
    const href = $(a).attr("href") ?? "";
    const textAttr = $(a).text().replace(/\s+/g, " ").trim().slice(0, 120);
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    links.push({ href, text: textAttr });
    if (links.length >= MAX_LINKS_PER_PAGE) break;
  }
  const headings: ExtractedPage["headings"] = { h1: [], h2: [], h3: [] };
  for (const tag of ["h1", "h2", "h3"] as const) {
    for (const el of $(tag).toArray().slice(0, 12)) {
      const t = $(el).text().replace(/\s+/g, " ").trim().slice(0, 160);
      if (t) headings[tag].push(t);
    }
  }
  const tech = [...fingerprintHeaders(res.headers), ...fingerprintMarkup(cheerio.load(html), html)];
  return {
    url: res.url,
    status: res.status,
    title: $("title").first().text().trim().slice(0, 200) || null,
    description: $('meta[name="description"]').attr("content")?.trim().slice(0, 300) || null,
    headings,
    textExcerpt: text.slice(0, EXTRACT_BUDGET) || null,
    links,
    tech,
    contentHash: createHash("sha256").update(res.body).digest("hex"),
  };
}

// --- Single-page probe (chat agent / lightweight inspection) ---------------

export interface ProbeResult {
  requestUrl: string;
  finalUrl: string; // after redirects
  status: number;
  ms: number;
  contentType: string;
  title: string | null;
  description: string | null;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  links: Array<{ href: string; text: string }>;
  tech: string[];
  textExcerpt: string | null;
  contentHash: string;
}

export const PROBE_TIMEOUT_MS = 12_000;
export const PROBE_MAX_BYTES = 1024 * 1024; // 1 MB — chat probes stay light
const PROBE_TEXT_BUDGET = 1_200; // visible-text excerpt chars

/**
 * Fetch and extract ONE public page — the Explorer's capability in a single
 * call, with no project and no database writes. The full SSRF guard applies
 * (scheme allowlist, private-IP DNS checks, metadata-host blocklist, size
 * cap, timeout, re-validated redirects). Throws BlockedUrlError for refused
 * URLs; network/DNS failures propagate as thrown errors with real messages.
 */
export async function probeUrl(
  rawUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number; includeText?: boolean }
): Promise<ProbeResult> {
  const res = await safeFetch(rawUrl, {
    timeoutMs: opts?.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxBytes: opts?.maxBytes ?? PROBE_MAX_BYTES,
  });
  const base: ProbeResult = {
    requestUrl: rawUrl,
    finalUrl: res.url,
    status: res.status,
    ms: res.ms,
    contentType: res.contentType,
    title: null,
    description: null,
    headings: { h1: [], h2: [], h3: [] },
    links: [],
    tech: fingerprintHeaders(res.headers).map((t) => t.name),
    textExcerpt: null,
    contentHash: createHash("sha256").update(res.body).digest("hex"),
  };
  const ct = res.contentType.toLowerCase();
  if (!ct.includes("html") && !ct.includes("xhtml")) return base; // non-HTML: headers observed, body not parsed
  const page = extractPage({ ...res });
  if (!page) return base;
  return {
    ...base,
    title: page.title,
    description: page.description,
    headings: page.headings,
    links: page.links,
    tech: [...new Set([...base.tech, ...page.tech.map((t) => t.name)])],
    textExcerpt:
      opts?.includeText === false ? null : page.textExcerpt?.slice(0, PROBE_TEXT_BUDGET) || null,
    contentHash: page.contentHash,
  };
}

// --- Crawler --------------------------------------------------------------

function normalizeUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Strip common tracking noise so the same page dedupes.
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"]) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return null;
  }
}

export async function crawlSite(
  projectId: string,
  startUrl: string,
  opts?: CrawlOptions
): Promise<CrawlSummary> {
  const maxPages = Math.min(opts?.maxPages ?? 20, 40);
  const maxDepth = Math.min(opts?.maxDepth ?? 2, 3);
  const concurrency = Math.min(opts?.concurrency ?? 3, 5);

  const start = new URL(startUrl);
  const origin = start.origin;
  const rules = await fetchRobots(origin);

  const queue: Array<{ url: string; depth: number }> = [
    { url: start.toString(), depth: 0 },
  ];
  const seen = new Set<string>([start.toString()]);
  const techSeen = new Map<string, TechSignal>();
  const fetchedUrls: string[] = [];
  let errors = 0;
  let pagesStored = 0;

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item || pagesStored >= maxPages) return;
      const { url, depth } = item;
      let res;
      try {
        res = await safeFetch(url, { timeoutMs: 15_000 });
      } catch (err) {
        errors++;
        const detail = err instanceof BlockedUrlError ? err.message : "fetch failed";
        await db.crawlPage.upsert({
          where: { projectId_url: { projectId, url } },
          create: { projectId, url, status: 0, textExcerpt: detail.slice(0, 300), depth },
          update: { status: 0, textExcerpt: detail.slice(0, 300), fetchedAt: new Date(), depth },
        });
        continue;
      }

      // Only parse HTML; record non-HTML as asset nodes.
      const contentType = res.contentType;
      if (!contentType.includes("html") && !contentType.includes("xhtml")) {
        pagesStored++;
        fetchedUrls.push(res.url);
        await db.crawlPage.upsert({
          where: { projectId_url: { projectId, url } },
          create: {
            projectId,
            url: res.url,
            status: res.status,
            tech: JSON.stringify([`content-type:${contentType.split(";")[0]}`]),
            depth,
            contentHash: createHash("sha256").update(res.body).digest("hex"),
          },
          update: { status: res.status, fetchedAt: new Date(), depth },
        });
        continue;
      }

      const page = extractPage({ ...res });
      if (!page) continue;
      pagesStored++;
      fetchedUrls.push(res.url);
      await db.crawlPage.upsert({
        where: { projectId_url: { projectId, url: res.url } },
        create: {
          projectId,
          url: res.url,
          status: page.status,
          title: page.title,
          description: page.description,
          textExcerpt: page.textExcerpt,
          links: JSON.stringify(page.links.slice(0, 60)),
          tech: JSON.stringify(page.tech.map((t) => t.name)),
          depth,
          contentHash: page.contentHash,
        },
        update: {
          status: page.status,
          title: page.title,
          description: page.description,
          textExcerpt: page.textExcerpt,
          links: JSON.stringify(page.links.slice(0, 60)),
          tech: JSON.stringify(page.tech.map((t) => t.name)),
          depth,
          contentHash: page.contentHash,
          fetchedAt: new Date(),
        },
      });

      for (const t of page.tech) techSeen.set(t.name, t);

      // Enqueue same-origin links (depth-bounded, robots-allowed).
      if (depth < maxDepth) {
        const next: Array<{ url: string; depth: number }> = [];
        for (const l of page.links) {
          const abs = normalizeUrl(l.href, res.url);
          if (!abs) continue;
          if (new URL(abs).origin !== origin) continue;
          if (seen.has(abs)) continue;
          seen.add(abs);
          if (!robotsAllows(rules, new URL(abs).pathname)) continue;
          if (opts?.includePaths?.length && !opts.includePaths.some((p) => abs.includes(p))) continue;
          if (opts?.excludePaths?.some((p) => abs.includes(p))) continue;
          // Skip obvious asset URLs.
          if (/\.(png|jpe?g|gif|svg|ico|css|js|woff2?|ttf|eot|pdf|zip|mp4|webm|wasm)(\?|$)/i.test(abs)) continue;
          next.push({ url: abs, depth: depth + 1 });
        }
        queue.push(...next.slice(0, maxPages * 4));
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Persist the crawl into the knowledge graph: page nodes + links-to edges
  // + tech nodes.
  const pages = await db.crawlPage.findMany({ where: { projectId }, take: 200 });
  const nodes: NodeRef[] = [];
  const edges: EdgeRef[] = [];
  for (const p of pages) {
    nodes.push({
      kind: "page",
      key: p.url,
      label: p.title || p.url,
      meta: { status: p.status, depth: p.depth, description: p.description ?? undefined },
      provenance: p.status === 0 ? "UNKNOWN" : "OBSERVED",
    });
  }
  const pageKeys = new Set(pages.map((p) => p.url));
  for (const p of pages) {
    let links: Array<{ href: string; text: string }> = [];
    try {
      links = p.links ? JSON.parse(p.links) : [];
    } catch {
      /* none */
    }
    for (const l of links) {
      const abs = normalizeUrl(l.href, p.url);
      if (abs && pageKeys.has(abs)) {
        edges.push({ fromKind: "page", fromKey: p.url, toKind: "page", toKey: abs, kind: "links-to" });
      }
    }
  }
  for (const [name, signal] of techSeen) {
    nodes.push({
      kind: "tech",
      key: name,
      label: signal.detail ?? name,
      meta: { where: signal.where },
      provenance: "OBSERVED",
    });
  }
  // homepage serves the site tech stack
  const homeKey = start.toString();
  for (const [name] of techSeen) {
    edges.push({ fromKind: "page", fromKey: homeKey, toKind: "tech", toKey: name, kind: "depends-on" });
  }
  await upsertGraph(projectId, nodes, edges);

  return {
    pages: pagesStored,
    errors,
    tech: [...techSeen.keys()],
    urls: fetchedUrls,
    robots: { fetched: rules.fetched, sitemaps: rules.sitemaps.length, disallowCount: rules.disallow.length },
  };
}
