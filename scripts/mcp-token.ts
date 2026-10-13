#!/usr/bin/env bun
/**
 * Mint an REA session token for the MCP server (scripts/mcp-server.ts).
 *
 * The MCP bridge authenticates to the running REA platform with the same
 * HMAC-signed session the web app stores in its `rea_session` cookie —
 * so every MCP tool call runs under your account with the platform's own
 * ownership, rate-limit and audit rules applied.
 *
 * Usage:
 *   bun scripts/mcp-token.ts --demo
 *   bun scripts/mcp-token.ts --email you@example.com --password '…'
 *   bun scripts/mcp-token.ts --base http://127.0.0.1:3000 --demo
 *
 * The token is printed once, to stdout, and never persisted by this script.
 * Feed it to the MCP server via the REA_MCP_TOKEN environment variable.
 */

interface ParsedArgs {
  base: string;
  demo: boolean;
  email?: string;
  password?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { base: "http://127.0.0.1:3000", demo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = (argv[++i] ?? out.base).replace(/\/+$/, "");
    else if (a === "--demo") out.demo = true;
    else if (a === "--email") out.email = argv[++i];
    else if (a === "--password") out.password = argv[++i];
  }
  return out;
}

async function mint(parsed: ParsedArgs): Promise<void> {
  const path = parsed.demo ? "/api/auth/demo" : "/api/auth/login";
  const body = parsed.demo
    ? {}
    : {
        email: parsed.email ?? process.env.REA_EMAIL,
        password: parsed.password ?? process.env.REA_PASSWORD,
      };

  if (!parsed.demo && (!body.email || !body.password)) {
    console.error("usage: bun scripts/mcp-token.ts --demo | --email <email> --password <pw>");
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetch(`${parsed.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(`Could not reach REA at ${parsed.base}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Login failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }

  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const sessionCookie = cookies.find((c) => c.startsWith("rea_session="));
  const token = sessionCookie?.match(/rea_session=([^;]+)/)?.[1];

  if (!token) {
    console.error("Login succeeded but no rea_session cookie was returned.");
    process.exit(1);
  }

  console.log(token);
  console.error(
    `\n[rea-mcp] token minted from ${parsed.base}${path}\n` +
    `[rea-mcp] run the MCP server with:\n` +
    `[rea-mcp]   REA_MCP_TOKEN=<token> REA_MCP_URL=${parsed.base} bun scripts/mcp-server.ts`
  );
}

const parsed = parseArgs(process.argv.slice(2));
mint(parsed).catch((err) => {
  console.error(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
