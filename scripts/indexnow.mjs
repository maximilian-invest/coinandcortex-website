// =============================================================================
// indexnow.mjs — submit the site's URLs to IndexNow (node: built-ins only)
//
//   node scripts/indexnow.mjs            # submit every URL in dist/sitemap.xml
//   node scripts/indexnow.mjs --dry-run  # print the payload, send nothing
//
// IndexNow (https://www.indexnow.org/) pings Bing, Yandex, Seznam and partners
// so freshly deployed/changed pages get picked up quickly. Bing's index also
// powers Copilot and ChatGPT search, so this helps AI answer engines too.
//
// Run this AFTER deploying dist/ to production (the orchestrator does this; it
// is intentionally NOT invoked by build.mjs). The key must already be live at
//   https://<host>/<INDEXNOW_KEY>.txt
// which build.mjs writes into dist/ from site.config.mjs.
// =============================================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../site.config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITEMAP = path.join(ROOT, "dist", "sitemap.xml");
const ENDPOINT = "https://api.indexnow.org/indexnow";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const siteUrl = (config.SITE_URL || "").replace(/\/+$/, "");
  const key = config.INDEXNOW_KEY;
  if (!siteUrl) {
    console.error("SITE_URL is not set in site.config.mjs — nothing to submit.");
    process.exit(1);
  }
  if (!key) {
    console.error("INDEXNOW_KEY is not set in site.config.mjs — nothing to submit.");
    process.exit(1);
  }

  let xml;
  try {
    xml = await readFile(SITEMAP, "utf8");
  } catch {
    console.error(`${SITEMAP} not found — run \`node build.mjs\` first.`);
    process.exit(1);
  }

  const host = new URL(siteUrl).host;
  const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((u) => {
      try {
        return new URL(u).host === host;
      } catch {
        return false;
      }
    });
  const uniqueUrls = [...new Set(urlList)];

  if (!uniqueUrls.length) {
    console.error("No URLs found in sitemap.xml — nothing to submit.");
    process.exit(1);
  }

  const payload = {
    host,
    key,
    keyLocation: `${siteUrl}/${key}.txt`,
    urlList: uniqueUrls,
  };

  console.log(`IndexNow: ${uniqueUrls.length} URL(s) for host ${host}`);
  console.log(`Key location: ${payload.keyLocation}`);

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    console.log("--dry-run: nothing submitted.");
    return;
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => "");
  // IndexNow returns 200 (accepted) or 202 (received, validation pending).
  if (res.ok) {
    console.log(`IndexNow accepted the submission (HTTP ${res.status}).`);
  } else {
    console.error(`IndexNow returned HTTP ${res.status}. Body: ${text || "(empty)"}`);
    process.exit(1);
  }
}

await main();
