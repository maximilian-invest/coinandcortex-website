// =============================================================================
// check-links.mjs — tiny post-build sanity check (node: built-ins only)
//
//   node scripts/check-links.mjs
//
// Verifies, against dist/:
//   * every internal href/src resolves to a real file
//   * no leftover "{{...}}" placeholders
//   * no year numbers like 20xx in visible page text (content must stay evergreen;
//     machine-readable dates in <script>/<meta>/<time datetime> are fine)
//   * embedded resources (src=) only from allow-listed hosts; outbound
//     <a href> links (article sources) may point to any https host
//   * #fragment links point to an existing id
// Prints "OK" and exits 0 on success; otherwise lists problems and exits 1.
// =============================================================================

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../site.config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");

// Hosts allowed to appear as external links anywhere in the output.
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "buy.stripe.com",
  "youtu.be",
  "stripe.com",
  "www.stripe.com",
  "dsb.gv.at",
  "www.dsb.gv.at",
  "www.youtube-nocookie.com",
  "i.ytimg.com",
]);
// When SITE_URL is set, the site's own canonical / OG / sitemap URLs are absolute.
if (config.SITE_URL) {
  try {
    ALLOWED_HOSTS.add(new URL(config.SITE_URL).host);
  } catch {
    /* ignore malformed SITE_URL here; build.mjs is the source of truth */
  }
}

const problems = [];

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

function extractLinks(html) {
  const links = [];
  const re = /\b(href|src|srcset)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].toLowerCase() === "srcset") {
      for (const part of m[2].split(",")) {
        const u = part.trim().split(/\s+/)[0];
        if (u) links.push({ attr: "src", url: u });
      }
    } else links.push({ attr: m[1].toLowerCase(), url: m[2] });
  }
  return links;
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<[^>]+>/g, " ");
}

function idsOf(html) {
  const ids = new Set();
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return ids;
}

function resolveTarget(link, fileDir) {
  // strip fragment and query
  let clean = link.split("#")[0].split("?")[0];
  if (clean === "") return null; // pure anchor / query — nothing to resolve
  let target;
  if (clean.startsWith("/")) {
    // root-relative (used by 404.html) — resolve from dist root
    target = path.join(DIST, clean);
  } else {
    target = path.resolve(fileDir, clean);
  }
  if (clean.endsWith("/")) target = path.join(target, "index.html");
  return target;
}

function isExternal(link) {
  return /^[a-z][a-z0-9+.-]*:/i.test(link); // has a scheme (http:, https:, mailto:, tel:)
}

async function main() {
  if (!existsSync(DIST)) {
    console.error("dist/ not found — run `node build.mjs` first.");
    process.exit(1);
  }

  const files = await walk(DIST);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));

  for (const file of htmlFiles) {
    const rel = path.relative(DIST, file);
    const html = await readFile(file, "utf8");

    // leftover placeholders. Match the build's own placeholder grammar
    // ({{UPPER_SNAKE}}) so legitimate content braces (e.g. a BibTeX
    // "author = {{Coin and Cortex}}" citation) are not false-flagged.
    const ph = html.match(/\{\{[A-Z_]+\}\}/g);
    if (ph) problems.push(`${rel}: leftover placeholder(s): ${[...new Set(ph)].join(", ")}`);

    // year numbers (evergreen check). The dedicated research/dataset page is
    // exempt: per the project rules it may show study publication years and its
    // own "data compiled" date (see COMMON.md).
    const evergreenExempt = rel.startsWith("research/");
    const years = evergreenExempt ? null : visibleText(html).match(/\b20\d\d\b/g);
    if (years) problems.push(`${rel}: contains year number(s): ${[...new Set(years)].join(", ")}`);

    // links
    const ownIds = idsOf(html);
    for (const { attr, url: link } of extractLinks(html)) {
      if (link.startsWith("data:")) continue;
      if (link.startsWith("#")) {
        if (link.length > 1 && !ownIds.has(decodeURIComponent(link.slice(1))))
          problems.push(`${rel}: fragment without matching id -> ${link}`);
        continue;
      }

      if (isExternal(link)) {
        if (/^https?:/i.test(link)) {
          let host;
          try {
            host = new URL(link).host;
          } catch {
            problems.push(`${rel}: malformed URL: ${link}`);
            continue;
          }
          if (attr === "src" && !ALLOWED_HOSTS.has(host)) {
            problems.push(`${rel}: external resource not allowed: ${link}`);
          } else if (/^http:/i.test(link) && !ALLOWED_HOSTS.has(host)) {
            problems.push(`${rel}: insecure http:// link: ${link}`);
          }
        }
        continue; // mailto:/tel: etc. are fine
      }

      const target = resolveTarget(link, path.dirname(file));
      if (target === null) continue;
      if (!existsSync(target)) {
        problems.push(`${rel}: broken link -> ${link}`);
      } else if (link.includes("#") && target.endsWith(".html")) {
        const frag = decodeURIComponent(link.split("#")[1] || "");
        if (frag && !idsOf(await readFile(target, "utf8")).has(frag))
          problems.push(`${rel}: fragment not found -> ${link}`);
      } else if ((await stat(target)).isDirectory()) {
        problems.push(`${rel}: link points to a directory -> ${link}`);
      }
    }
  }

  if (problems.length) {
    console.error("Link / content check FAILED:");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log(`OK — checked ${htmlFiles.length} HTML file(s), no problems found.`);
}

await main();
