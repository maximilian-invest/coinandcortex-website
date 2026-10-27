// =============================================================================
// check-links.mjs — tiny post-build sanity check (node: built-ins only)
//
//   node scripts/check-links.mjs
//
// Verifies, against dist/:
//   * every internal href/src resolves to a real file
//   * no leftover "{{...}}" placeholders
//   * no year numbers like 20xx in page text (content must stay evergreen)
//   * no external URLs outside the allow-list
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
  "youtu.be",
  "stripe.com",
  "www.stripe.com",
  "dsb.gv.at",
  "www.dsb.gv.at",
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
  const re = /(?:href|src)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
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

    // leftover placeholders
    const ph = html.match(/\{\{[^}]*\}\}/g);
    if (ph) problems.push(`${rel}: leftover placeholder(s): ${[...new Set(ph)].join(", ")}`);

    // year numbers (evergreen check)
    const years = html.match(/\b20\d\d\b/g);
    if (years) problems.push(`${rel}: contains year number(s): ${[...new Set(years)].join(", ")}`);

    // links
    for (const link of extractLinks(html)) {
      if (link.startsWith("#") || link.startsWith("data:")) continue;

      if (isExternal(link)) {
        if (/^https?:/i.test(link)) {
          let host;
          try {
            host = new URL(link).host;
          } catch {
            problems.push(`${rel}: malformed URL: ${link}`);
            continue;
          }
          if (!ALLOWED_HOSTS.has(host)) {
            problems.push(`${rel}: external URL not allowed: ${link}`);
          }
        }
        continue; // mailto:/tel: etc. are fine
      }

      const target = resolveTarget(link, path.dirname(file));
      if (target === null) continue;
      if (!existsSync(target)) {
        problems.push(`${rel}: broken link -> ${link}`);
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
