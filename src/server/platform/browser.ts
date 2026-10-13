import fsSync from "node:fs";
import path from "node:path";

/**
 * Optional browser runtime (playwright-core, Apache-2.0).
 *
 * The package is present, but a working capability needs a browser binary
 * too. Detection is honest: we check the standard ms-playwright cache and a
 * few system locations, and report exactly what is missing. If unavailable,
 * callers degrade to HTTP-level operation — never a fake success.
 */

export interface BrowserStatus {
  available: boolean;
  detail: string;
  executablePath?: string;
}

const globalForBrowser = globalThis as unknown as {
  __reaBrowserStatus?: BrowserStatus;
};

export function detectBrowser(): BrowserStatus {
  if (globalForBrowser.__reaBrowserStatus) return globalForReaStatus();
  let status: BrowserStatus = {
    available: false,
    detail:
      "no Chromium runtime found — install with `bunx playwright-core install chromium` (or set REA_BROWSER_PATH). HTTP-level checks still work.",
  };
  const candidates: string[] = [];
  const home = process.env.HOME ?? "/root";
  // ms-playwright cache layout (chromium-<rev>/chrome-linux*/chrome|headless_shell).
  try {
    const cacheDir = path.join(home, ".cache", "ms-playwright");
    if (fsSync.existsSync(cacheDir)) {
      for (const entry of fsSync.readdirSync(cacheDir)) {
        if (entry.startsWith("chromium-")) {
          candidates.push(
            path.join(cacheDir, entry, "chrome-linux64", "chrome"),
            path.join(cacheDir, entry, "chrome-linux", "chrome"),
            path.join(cacheDir, entry, "chrome-linux", "headless_shell")
          );
        }
        if (entry.startsWith("chromium_headless_shell-")) {
          candidates.push(
            path.join(cacheDir, entry, "chrome-linux64", "headless_shell"),
            path.join(cacheDir, entry, "chrome-linux", "headless_shell")
          );
        }
      }
    }
  } catch {
    /* cache unreadable */
  }
  if (process.env.REA_BROWSER_PATH) candidates.push(process.env.REA_BROWSER_PATH);
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");

  for (const c of candidates) {
    try {
      if (c && fsSync.existsSync(c) && fsSync.statSync(c).isFile()) {
        status = { available: true, detail: `Chromium runtime detected: ${path.basename(path.dirname(c))}`, executablePath: c };
        break;
      }
    } catch {
      /* skip */
    }
  }
  globalForBrowser.__reaBrowserStatus = status;
  return status;
}

function globalForReaStatus(): BrowserStatus {
  return globalForBrowser.__reaBrowserStatus!;
}

export interface RenderResult {
  available: boolean;
  title?: string;
  text?: string;
  screenshotBase64?: string;
  consoleErrors?: string[];
  ms?: number;
  detail?: string;
}

/** Render a URL in headless Chromium (JS executed). Errors are honest. */
export async function tryBrowser(url: string, opts?: { screenshot?: boolean; timeoutMs?: number }): Promise<RenderResult> {
  const status = detectBrowser();
  if (!status.available) {
    return { available: false, detail: status.detail };
  }
  const started = Date.now();
  try {
    // Dynamic import keeps the app functional when playwright-core is absent.
    const { chromium } = (await import("playwright-core")) as typeof import("playwright-core");
    const browser = await chromium.launch({
      headless: true,
      executablePath: status.executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error" && consoleErrors.length < 20) {
          consoleErrors.push(msg.text().slice(0, 200));
        }
      });
      await page.goto(url, { timeout: opts?.timeoutMs ?? 25_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600); // let SPA hydration settle briefly
      const title = await page.title();
      const text = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")) ?? "";
      const result: RenderResult = {
        available: true,
        title,
        text: text.slice(0, 6_000),
        consoleErrors,
        ms: Date.now() - started,
      };
      if (opts?.screenshot) {
        const buf = await page.screenshot({ type: "png", timeout: 10_000 });
        result.screenshotBase64 = buf.toString("base64");
      }
      return result;
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (err) {
    return {
      available: false,
      detail: `browser render failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      ms: Date.now() - started,
    };
  }
}
