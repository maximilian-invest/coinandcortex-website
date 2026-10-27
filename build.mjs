// =============================================================================
// Coin & Cortex — static site build
// -----------------------------------------------------------------------------
// Zero dependencies. Node 20, only node: built-ins.
//
//   node build.mjs           -> clean + write dist/
//   node build.mjs --serve   -> build, then serve dist/ on http://localhost:8080
//
// How it works:
//   * One shared layout (src/layout.html) wraps every page.
//   * Pages are HTML partials in src/pages/*.html with a tiny <!-- --> front
//     matter block (title, description).
//   * Blog posts are Markdown in src/blog/*.md with a --- front matter block.
//   * All internal links use the {{BASE}} placeholder; the build fills it with
//     the correct relative prefix per page ("./", "../", "../../"), so the site
//     works from any domain and from a project subfolder. The 404 page uses a
//     root-relative "/" base (see note in README).
//   * A single final substitution pass fills config + computed placeholders,
//     so generated snippets may themselves contain {{BASE}} / {{KIT_PRICE}} etc.
// =============================================================================

import { readFile, writeFile, mkdir, rm, readdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import config from "./site.config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const SITE_NAME = "Coin & Cortex";
const SITE_URL = (config.SITE_URL || "").replace(/\/+$/, ""); // no trailing slash

// -----------------------------------------------------------------------------
// Page registry. `out` is the output path relative to dist/.
// `base` (relative prefix) is derived from the folder depth of `out`.
// -----------------------------------------------------------------------------
const PAGES = [
  { file: "index.html",          out: "index.html" },
  { file: "shop.html",           out: "shop/index.html" },
  { file: "free-checklist.html", out: "free-checklist/index.html" },
  { file: "blog.html",           out: "blog/index.html" },
  { file: "impressum.html",      out: "impressum/index.html" },
  { file: "privacy.html",        out: "privacy/index.html" },
  { file: "terms.html",          out: "terms/index.html" },
  // 404 is served at arbitrary depths; it uses a root-relative base ("/").
  { file: "404.html",            out: "404.html", rootRelative: true },
];

// Relative prefix for a given output path. "shop/index.html" -> "../".
function baseFor(outPath, rootRelative) {
  if (rootRelative) return "/";
  const depth = outPath.split("/").length - 1; // number of folders above the file
  return depth === 0 ? "./" : "../".repeat(depth);
}

// -----------------------------------------------------------------------------
// Tiny front-matter parser for HTML partials:
//   <!--
//   title: ...
//   description: ...
//   -->
// -----------------------------------------------------------------------------
function parseHtmlFrontMatter(raw) {
  const m = raw.match(/^\s*<!--([\s\S]*?)-->/);
  const meta = {};
  let body = raw;
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
    body = raw.slice(m[0].length);
  }
  return { meta, body: body.trim() };
}

// Front matter for Markdown (--- fenced block of key: value lines).
function parseMdFrontMatter(raw) {
  const m = raw.match(/^\s*---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  let body = raw;
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
    body = raw.slice(m[0].length);
  }
  return { meta, body: body.trim() };
}

// -----------------------------------------------------------------------------
// HTML escaping helpers
// -----------------------------------------------------------------------------
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escAttr(s) {
  return esc(s);
}

// -----------------------------------------------------------------------------
// Small Markdown -> HTML converter (built-in, intentionally minimal).
// Supports: headings, paragraphs, bold/italic, inline code, links, images,
// unordered/ordered lists, blockquotes, fenced/indented code, and <hr>.
// -----------------------------------------------------------------------------
function inlineMd(text) {
  // Escape first, then re-introduce the small set of inline constructs.
  let s = esc(text);
  // inline code (protect contents from other rules)
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `${codes.length - 1}`;
  });
  // images ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
    `<img src="${src}" alt="${alt}" loading="lazy">`
  );
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    const ext = /^https?:\/\//.test(url);
    const rel = ext ? ' rel="noopener"' : "";
    return `<a href="${url}"${rel}>${txt}</a>`;
  });
  // bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // restore inline code
  s = s.replace(/(\d+)/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(" "))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // skip closing fence
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // hr
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // blockquote (consecutive > lines)
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ol>`);
      continue;
    }

    // paragraph text
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}

// -----------------------------------------------------------------------------
// Computed snippets
// -----------------------------------------------------------------------------
function videoCards() {
  return config.VIDEOS.map(
    (v) => `        <a class="video-card card" href="${escAttr(v.url)}" rel="noopener">
          <img src="{{BASE}}assets/img/${v.thumb}.webp" width="640" height="360" loading="lazy" alt="Thumbnail for the video: ${escAttr(v.title)}">
          <span class="video-title">${esc(v.title)}</span>
        </a>`
  ).join("\n");
}

function buyButton() {
  const pending = config.STRIPE_KIT_LINK.trim().startsWith("#");
  if (pending) {
    return `<div class="buy">
          <span class="btn btn-primary btn-disabled" role="button" aria-disabled="true">Buy the kit — {{KIT_PRICE}}</span>
          <p class="buy-note">Checkout opens soon. In the meantime, <a href="{{BASE}}free-checklist/">get the free Fair Price Protocol checklist</a>.</p>
        </div>`;
  }
  return `<div class="buy">
          <a class="btn btn-primary" href="{{STRIPE_KIT_LINK}}" rel="noopener">Buy the kit — {{KIT_PRICE}}</a>
        </div>`;
}

// -----------------------------------------------------------------------------
// Blog loading
// -----------------------------------------------------------------------------
async function loadBlogPosts() {
  const dir = path.join(SRC, "blog");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const posts = [];
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), "utf8");
    const { meta, body } = parseMdFrontMatter(raw);
    const slug = f.replace(/\.md$/, "");
    posts.push({
      slug,
      title: meta.title || slug,
      description: meta.description || "",
      date: meta.date || "",
      html: markdownToHtml(body),
    });
  }
  // Keep a stable, deterministic order (newest-first by date when present,
  // otherwise alphabetical by slug). No years are relied upon.
  posts.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.slug.localeCompare(b.slug));
  return posts;
}

function blogListHtml(posts) {
  if (!posts.length) {
    return `<p>No posts yet — check back soon.</p>`;
  }
  return posts
    .map(
      (p) => `      <li class="post-item card">
        <h2><a href="{{BASE}}blog/${p.slug}/">${esc(p.title)}</a></h2>
        <p>${esc(p.description)}</p>
        <p><a href="{{BASE}}blog/${p.slug}/">Read the article →</a></p>
      </li>`
    )
    .join("\n");
}

function blogTeaserHtml(posts) {
  if (!posts.length) return `<p>Articles are on the way.</p>`;
  const top = posts.slice(0, 2);
  return top
    .map(
      (p) => `        <li class="card">
          <h3><a href="{{BASE}}blog/${p.slug}/">${esc(p.title)}</a></h3>
          <p>${esc(p.description)}</p>
        </li>`
    )
    .join("\n");
}

// -----------------------------------------------------------------------------
// Head meta (canonical + OG/Twitter). OG image falls back to a relative URL
// when SITE_URL is empty so the site stays domain-agnostic.
// -----------------------------------------------------------------------------
function headExtra({ title, description, out, base, rootRelative }) {
  const parts = [];
  const ogImage = SITE_URL ? `${SITE_URL}/assets/img/og_image.jpg` : `${base}assets/img/og_image.jpg`;
  let url = "";
  if (SITE_URL && !rootRelative) {
    const folder = out.replace(/index\.html$/, "").replace(/^(.*)\/$/, "$1");
    url = folder ? `${SITE_URL}/${folder}/` : `${SITE_URL}/`;
    parts.push(`  <link rel="canonical" href="${escAttr(url)}">`);
  }
  parts.push(`  <meta property="og:type" content="website">`);
  parts.push(`  <meta property="og:site_name" content="${escAttr(SITE_NAME)}">`);
  parts.push(`  <meta property="og:title" content="${escAttr(title)}">`);
  parts.push(`  <meta property="og:description" content="${escAttr(description)}">`);
  parts.push(`  <meta property="og:image" content="${escAttr(ogImage)}">`);
  if (url) parts.push(`  <meta property="og:url" content="${escAttr(url)}">`);
  parts.push(`  <meta name="twitter:card" content="summary_large_image">`);
  parts.push(`  <meta name="twitter:title" content="${escAttr(title)}">`);
  parts.push(`  <meta name="twitter:description" content="${escAttr(description)}">`);
  parts.push(`  <meta name="twitter:image" content="${escAttr(ogImage)}">`);
  return parts.join("\n");
}

// -----------------------------------------------------------------------------
// Final substitution pass (config + base + computed one-liners).
// Runs on the fully assembled document so snippets can carry placeholders too.
// -----------------------------------------------------------------------------
function substitute(html, base) {
  const map = {
    BASE: base,
    STRIPE_KIT_LINK: config.STRIPE_KIT_LINK,
    KIT_PRICE: config.KIT_PRICE,
    CONTACT_EMAIL: config.CONTACT_EMAIL,
    YOUTUBE_CHANNEL: config.YOUTUBE_CHANNEL,
    SITE_URL: SITE_URL,
    SELLER_NAME: config.SELLER_NAME,
    SELLER_ADDRESS: config.SELLER_ADDRESS,
    SELLER_VAT: config.SELLER_VAT,
    SITE_NAME: SITE_NAME,
  };
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      return map[key] === undefined || map[key] === null ? "" : String(map[key]);
    }
    return full; // leave unknown placeholders so the no-{{ check can catch them
  });
}

// -----------------------------------------------------------------------------
// File helpers
// -----------------------------------------------------------------------------
async function writeOut(relPath, content) {
  const full = path.join(DIST, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------
async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const layout = await readFile(path.join(SRC, "layout.html"), "utf8");
  const posts = await loadBlogPosts();

  const computed = {
    "{{LATEST_VIDEOS}}": videoCards(),
    "{{BLOG_LIST}}": blogListHtml(posts),
    "{{BLOG_TEASER}}": blogTeaserHtml(posts),
    "{{BUY_BUTTON}}": buyButton(),
  };

  // Assemble one page: fill layout, computed snippets, then substitute.
  function assemble({ title, description, body, out, base, rootRelative }) {
    let html = layout
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace(/\{\{DESCRIPTION\}\}/g, esc(description))
      .replace(/\{\{HEAD_EXTRA\}\}/g, headExtra({ title, description, out, base, rootRelative }))
      .replace(/\{\{CONTENT\}\}/g, body);
    for (const [k, v] of Object.entries(computed)) html = html.split(k).join(v);
    return substitute(html, base);
  }

  // --- static pages ---
  for (const p of PAGES) {
    const raw = await readFile(path.join(SRC, "pages", p.file), "utf8");
    const { meta, body } = parseHtmlFrontMatter(raw);
    const base = baseFor(p.out, p.rootRelative);
    const title = meta.title || SITE_NAME;
    const description = meta.description || "";
    const html = assemble({ title, description, body, out: p.out, base, rootRelative: p.rootRelative });
    await writeOut(p.out, html);
  }

  // --- blog posts ---
  const postLayout = await readFile(path.join(SRC, "post.html"), "utf8");
  for (const post of posts) {
    const out = `blog/${post.slug}/index.html`;
    const base = baseFor(out, false);
    const dateLine = post.date ? `<p class="post-date">${esc(post.date)}</p>` : "";
    const body = postLayout
      .replace(/\{\{POST_TITLE\}\}/g, esc(post.title))
      .replace(/\{\{POST_DATE\}\}/g, dateLine)
      .replace(/\{\{POST_BODY\}\}/g, post.html);
    const html = assemble({
      title: `${post.title} — ${SITE_NAME}`,
      description: post.description,
      body,
      out,
      base,
      rootRelative: false,
    });
    await writeOut(out, html);
  }

  // --- static assets ---
  await copyDir(path.join(SRC, "assets"), path.join(DIST, "assets"));
  await copyDir(path.join(SRC, "downloads"), path.join(DIST, "downloads"));
  for (const f of ["favicon.png", "apple-touch-icon.png"]) {
    if (existsSync(path.join(SRC, f))) await copyFile(path.join(SRC, f), path.join(DIST, f));
  }

  // --- robots.txt (always) ---
  const robots = SITE_URL
    ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    : `User-agent: *\nAllow: /\n`;
  await writeOut("robots.txt", robots);

  // --- sitemap.xml (only when SITE_URL is set) ---
  if (SITE_URL) {
    const urls = [];
    for (const p of PAGES) {
      if (p.rootRelative) continue; // skip 404
      const folder = p.out.replace(/index\.html$/, "").replace(/\/$/, "");
      urls.push(folder ? `${SITE_URL}/${folder}/` : `${SITE_URL}/`);
    }
    for (const post of posts) urls.push(`${SITE_URL}/blog/${post.slug}/`);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n") +
      `\n</urlset>\n`;
    await writeOut("sitemap.xml", xml);
  }

  // --- guard: no unresolved placeholders left in HTML ---
  const leftovers = await findLeftovers(DIST);
  if (leftovers.length) {
    console.error("Unresolved {{...}} placeholders found:");
    for (const l of leftovers) console.error("  " + l);
    process.exit(1);
  }

  console.log(`Built ${PAGES.length} pages + ${posts.length} blog post(s) into dist/`);
}

async function findLeftovers(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findLeftovers(full)));
    else if (entry.name.endsWith(".html") || entry.name.endsWith(".xml")) {
      const txt = await readFile(full, "utf8");
      const m = txt.match(/\{\{[A-Z_]+\}\}/g);
      if (m) found.push(`${path.relative(DIST, full)}: ${[...new Set(m)].join(", ")}`);
    }
  }
  return found;
}

// -----------------------------------------------------------------------------
// Optional tiny static server (built-ins only)
// -----------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".ics": "text/calendar",
};

function serve() {
  const port = 8080;
  const server = http.createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let filePath = path.join(DIST, urlPath);
      if (!filePath.startsWith(DIST)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      if (existsSync(filePath) && (await stat(filePath)).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      if (!existsSync(filePath)) {
        const notFound = path.join(DIST, "404.html");
        const body = existsSync(notFound) ? await readFile(notFound) : "Not found";
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }).end(body);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(await readFile(filePath));
    } catch (err) {
      res.writeHead(500).end("Server error");
    }
  });
  server.listen(port, () => console.log(`Serving dist/ on http://localhost:${port}`));
}

// -----------------------------------------------------------------------------
await build();
if (process.argv.includes("--serve")) serve();
