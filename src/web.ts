import { resolveBrowserbaseKey } from "./config.js";
import type { ToolDefinition } from "./zen.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Meteor/0.2.13";

/**
 * Decode basic HTML entities into plain text
 */
function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Convert raw HTML into readable Markdown text
 */
export function htmlToMarkdown(html: string): string {
  let md = html;

  // 1. Remove non-content elements
  md = md.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  md = md.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  md = md.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  md = md.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
  md = md.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  md = md.replace(/<!--[\s\S]*?-->/g, "");

  // 2. Title & Headings
  md = md.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, (_, t) => `# ${t.trim()}\n\n`);
  md = md.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${t.trim()}\n\n`);
  md = md.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${t.trim()}\n\n`);
  md = md.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n\n### ${t.trim()}\n\n`);
  md = md.replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, t) => `\n\n#### ${t.trim()}\n\n`);

  // 3. Preformatted & Code blocks
  md = md.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, c) => `\n\`\`\`\n${decodeHtmlEntities(c.trim())}\n\`\`\`\n`);
  md = md.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${decodeHtmlEntities(c.trim())}\n\`\`\`\n`);
  md = md.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${decodeHtmlEntities(c.trim())}\``);

  // 4. Links & Images
  md = md.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (!cleanText) return "";
    return `[${cleanText}](${href.trim()})`;
  });
  md = md.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, "![$1]");

  // 5. Lists & Formatting
  md = md.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => `\n* ${item.replace(/<[^>]+>/g, "").trim()}`);
  md = md.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  md = md.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, b) => `\n> ${b.replace(/<[^>]+>/g, "").trim()}\n`);
  md = md.replace(/<(p|div|tr)\b[^>]*>/gi, "\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n");

  // 6. Strip all remaining tags
  md = md.replace(/<[^>]+>/g, "");

  // 7. Decode HTML entities & normalize whitespace
  md = decodeHtmlEntities(md);
  md = md.replace(/[ \t]+/g, " ");
  md = md.replace(/\n\s+\n/g, "\n\n");
  md = md.replace(/\n{3,}/g, "\n\n");

  return md.trim();
}

/**
 * Fetch and extract clean readable text or markdown content from a given URL
 */
export async function fetchUrl(rawUrl: string, options?: { maxChars?: number }): Promise<string> {
  let url = rawUrl.trim();
  if (!url) return "Error: empty URL";
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  const maxChars = options?.maxChars ?? 25000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const res = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return `Failed to fetch URL ${url}: HTTP ${res.status} ${res.statusText}`;
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const rawText = await res.text();

    let content = "";
    if (contentType.includes("application/json")) {
      try {
        content = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch {
        content = rawText;
      }
    } else if (contentType.includes("text/html") || rawText.includes("<html") || rawText.includes("<!DOCTYPE")) {
      content = htmlToMarkdown(rawText);
    } else {
      content = rawText.trim();
    }

    if (!content) {
      return `Fetched ${url} successfully, but no readable text content was found.`;
    }

    if (content.length > maxChars) {
      const truncated = content.slice(0, maxChars);
      return `${truncated}\n\n[Content truncated — showing first ${maxChars.toLocaleString()} characters from ${url}]`;
    }

    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching URL ${url}: ${msg}`;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Fallback web search using DuckDuckGo HTML endpoint
 */
async function fallbackSearch(query: string, numResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "text/html",
    },
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) throw new Error(`Search engine returned HTTP ${res.status}`);

  const html = await res.text();
  const results: SearchResult[] = [];

  // Match DuckDuckGo HTML results: class="result__snippet" & class="result__url"
  const resultRegex = /<a[^>]*class="result__snippet[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const titleRegex = /<a[^>]*class="result__url[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  // Simple block parser for DuckDuckGo HTML output
  const blocks = html.split(/class="result\s+results_links/i).slice(1);
  for (const block of blocks) {
    if (results.length >= numResults) break;

    // Extract link & title from result__a
    const aMatch = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippetMatch = /<a[^>]*class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

    if (aMatch) {
      let link = aMatch[1];
      // Skip sponsored/ad links
      if (link.includes("duckduckgo.com/y.js") || block.includes("badge--ad") || block.includes("result--ad")) {
        continue;
      }
      // DuckDuckGo redirect link unwrap
      if (link.includes("uddg=")) {
        try {
          const match = /[?&]uddg=([^&]+)/.exec(link);
          if (match) link = decodeURIComponent(match[1]);
        } catch {}
      }

      const title = aMatch[2].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

      if (title && link && !link.includes("duckduckgo.com/y.js")) {
        results.push({
          title: decodeHtmlEntities(title),
          url: link,
          snippet: decodeHtmlEntities(snippet),
        });
      }
    }
  }

  return results;
}

/**
 * Search the internet using Browserbase Search API with automatic fallback
 */
export async function searchInternet(query: string, options?: { numResults?: number }): Promise<string> {
  const q = query.trim();
  if (!q) return "Error: empty search query";

  const num = Math.min(Math.max(options?.numResults ?? 5, 1), 10);
  const bbKey = resolveBrowserbaseKey();

  // If Browserbase key is configured, use official Browserbase Search API
  if (bbKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch("https://api.browserbase.com/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bb-api-key": bbKey,
        },
        body: JSON.stringify({
          query: q,
          numResults: num,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as {
          results?: Array<{ title?: string; url?: string; snippet?: string; description?: string }>;
        };
        const items = data.results || [];
        if (items.length > 0) {
          const formatted = items
            .map((item, idx) => {
              const title = item.title || "Untitled";
              const url = item.url || "";
              const desc = item.snippet || item.description || "";
              return `${idx + 1}. **[${title}](${url})**\n   ${desc}`;
            })
            .join("\n\n");
          return `### Web Search Results for "${q}" (via Browserbase)\n\n${formatted}`;
        }
      }
    } catch {
      // Fall through to fallback search if Browserbase call encounters error
    }
  }

  // Fallback search
  try {
    const results = await fallbackSearch(q, num);
    if (results.length === 0) {
      return `No web results found for query: "${q}".`;
    }

    const formatted = results
      .map((r, idx) => `${idx + 1}. **[${r.title}](${r.url})**\n   ${r.snippet}`)
      .join("\n\n");

    const bbNotice = bbKey
      ? ""
      : "\n\n*(Tip: You can configure your Browserbase API key via `meteor auth set-browserbase <key>` or BROWSERBASE_API_KEY for Browserbase search).*";

    return `### Web Search Results for "${q}"\n\n${formatted}${bbNotice}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching the web for "${q}": ${msg}`;
  }
}

/**
 * Built-in Web tool definitions exposed to Meteor models
 */
export const WEB_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    server: "web",
    name: "fetch_url",
    description:
      "Fetch and extract clean readable markdown or text content from any URL (documentation, GitHub repositories/files, web pages, APIs, or articles) thrown at you by the user or discovered during research.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full HTTP or HTTPS web URL to fetch (e.g. 'https://docs.github.com' or 'https://example.com')",
        },
      },
      required: ["url"],
    },
  },
  {
    server: "web",
    name: "search_internet",
    description:
      "Search the live internet via Browserbase to get real-time search results, documentation, news, current facts, library APIs, or troubleshooting steps whenever you think needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to look up on the internet (e.g. 'react 19 release date' or 'next.js server actions tutorial')",
        },
      },
      required: ["query"],
    },
  },
];

/**
 * Execute web tools
 */
export async function executeWebTool(name: string, args: unknown): Promise<string> {
  const toolName = name.replace(/^web__/, "");
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;

  if (toolName === "fetch_url") {
    const url = String(record.url || "").trim();
    if (!url) return "Error: No URL provided to fetch_url";
    return await fetchUrl(url);
  }

  if (toolName === "search_internet") {
    const query = String(record.query || "").trim();
    if (!query) return "Error: No query provided to search_internet";
    return await searchInternet(query);
  }

  return `Error: Unknown web tool '${name}'`;
}
