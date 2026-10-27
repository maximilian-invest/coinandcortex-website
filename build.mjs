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
  { file: "about.html",          out: "about/index.html" },
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
// Supports: headings (h2/h3 get stable ids), paragraphs, bold/italic, inline
// code, links, images, lists, blockquotes, fenced code, GFM tables, <hr>, and
// one-line tokens: [[toc]], [[video:ID|Title]], [[cta:kit]], [[cta:checklist]].
// -----------------------------------------------------------------------------
function slugify(t) {
  return String(t)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 70);
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function inlineMd(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy" decoding="async">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    const ext = /^https?:\/\//.test(url);
    const rel = ext ? ' rel="noopener"' : "";
    return `<a href="${url}"${rel}>${txt}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function markdownToHtml(md, ctx = {}) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const headings = [];
  const usedIds = new Set();
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

    if (/^```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    // one-line tokens
    const tok = line.trim().match(/^\[\[(toc|video:[^\]|]+(?:\|[^\]]*)?|cta:[a-z]+)\]\]$/);
    if (tok) {
      flushPara();
      const t = tok[1];
      if (t === "toc") out.push("\u0000TOC\u0000");
      else if (t.startsWith("video:")) {
        const [id, title] = t.slice(6).split("|");
        out.push(videoEmbed(id.trim(), (title || "").trim()));
        if (ctx.hasVideo) ctx.hasVideo.v = true;
      } else if (t.startsWith("cta:")) out.push(ctaBox(t.slice(4)));
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      // Markdown "#" inside a post body is demoted: the page title is the only h1.
      const level = Math.max(2, h[1].length);
      const inner = inlineMd(h[2].trim());
      let id = slugify(h[2]);
      let n = 2;
      while (usedIds.has(id)) id = `${slugify(h[2])}-${n++}`;
      usedIds.add(id);
      if (level === 2) headings.push({ id, text: stripTags(inner) });
      out.push(`<h${level} id="${id}">${inner}</h${level}>`);
      i++;
      continue;
    }

    // GFM table: header row, separator row, body rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        `<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${head.map((c) => `<th scope="col">${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      // paragraphs inside the quote are separated by empty "> " lines
      const paras = buf.join("\n").split(/\n\s*\n/).map((p) => `<p>${inlineMd(p.replace(/\n/g, " "))}</p>`);
      out.push(`<blockquote>${paras.join("")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
      out.push(`<ul>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      out.push(`<ol>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ol>`);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();

  let html = out.join("\n");
  const tocItems = headings.filter((x) => !/^(sources|references)$/i.test(x.text));
  const toc = tocItems.length
    ? `<nav class="toc card" aria-label="On this page"><p class="toc-title">On this page</p><ol>${tocItems.map((x) => `<li><a href="#${x.id}">${esc(x.text)}</a></li>`).join("")}</ol></nav>`
    : "";
  html = html.replace("\u0000TOC\u0000", toc);
  return { html, headings };
}

// FAQ extraction for FAQPage JSON-LD: "## Frequently asked questions" section,
// each "### Question?" followed by answer paragraphs, until the next "## ".
function extractFaq(md) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+(frequently asked questions|faq)/i.test(l));
  if (start < 0) return [];
  const items = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;
    const q = l.match(/^###\s+(.*)$/);
    if (q) { cur = { q: stripTags(inlineMd(q[1])), a: [] }; items.push(cur); continue; }
    if (cur && l.trim()) cur.a.push(l.trim().replace(/^[-*]\s+|^\d+\.\s+/, ""));
  }
  return items.filter((x) => x.a.length).map((x) => ({ q: x.q, a: stripTags(inlineMd(x.a.join(" "))) }));
}

// -----------------------------------------------------------------------------
// Computed snippets
// -----------------------------------------------------------------------------
function videoById(id) {
  return config.VIDEOS.find((v) => v.url.includes(id));
}

// Click-to-play facade: no request to YouTube until the visitor clicks.
function videoEmbed(id, title) {
  const v = videoById(id);
  const t = title || (v ? v.title : "Watch on YouTube");
  const thumb = v ? `{{BASE}}assets/img/${v.thumb}.webp` : "";
  // The consent notice sits on top of the facade as a sibling (not inside the
  // <a>) so its privacy link stays a valid, separately clickable link.
  return `<figure class="video-embed">
  <div class="yt-box">
  <a class="yt-facade" href="https://www.youtube.com/watch?v=${escAttr(id)}" data-yt="${escAttr(id)}" rel="noopener">
    ${thumb ? `<img src="${thumb}" width="640" height="360" loading="lazy" decoding="async" alt="">` : ""}
    <span class="yt-play" aria-hidden="true"></span>
    <span class="sr-only">Play video: </span><span class="yt-title">${esc(t)}</span>
  </a>
  <p class="yt-consent">Loads YouTube; Google may set cookies. <a href="{{BASE}}privacy/#youtube">Privacy policy</a></p>
  </div>
  <figcaption>Video: ${esc(t)}. Nothing is loaded from YouTube until you press play.</figcaption>
</figure>`;
}

function ctaBox(kind) {
  if (kind === "kit") {
    return `<aside class="cta card cta-kit" aria-label="The Switching Day Kit">
  <img src="{{BASE}}assets/img/cover_1_hero-480.webp" width="480" height="480" loading="lazy" decoding="async" alt="Cover of the Switching Day Kit">
  <div><p class="cta-title">Want it done in one calm hour a year?</p>
  <p>The <strong>Switching Day Kit</strong> gives you the plan, a contracts tracker, calendar reminders and five ready-to-use call &amp; chat scripts. Instant download, {{KIT_PRICE}}.</p>
  <p><a class="btn btn-primary" href="{{BASE}}shop/">See what's inside</a></p></div>
</aside>`;
  }
  if (kind === "checklist") {
    return `<aside class="cta card cta-checklist" aria-label="Free checklist">
  <img src="{{BASE}}assets/img/checklist_preview-480.webp" width="480" height="338" loading="lazy" decoding="async" alt="Preview of the Fair Price Protocol checklist">
  <div><p class="cta-title">Free: the Fair Price Protocol checklist</p>
  <p>Six moves to check you're paying a fair price, on two printable pages. No sign-up, no email.</p>
  <p><a class="btn btn-secondary" href="{{BASE}}free-checklist/">Get the free checklist</a></p></div>
</aside>`;
  }
  return "";
}

const VIDEO_SCRIPT = `<script>
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-yt]");if(!a||e.ctrlKey||e.metaKey||e.shiftKey)return;e.preventDefault();var f=document.createElement("iframe");f.src="https://www.youtube-nocookie.com/embed/"+a.getAttribute("data-yt")+"?autoplay=1&rel=0";f.title=a.querySelector(".yt-title").textContent;f.allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture";f.allowFullscreen=true;f.width=640;f.height=360;(a.closest(".yt-box")||a).replaceWith(f);});
</script>`;

function videoCards() {
  return config.VIDEOS.map(
    (v) => `        <a class="video-card card" href="${escAttr(v.url)}" rel="noopener">
          <img src="{{BASE}}assets/img/${v.thumb}.webp" width="640" height="360" loading="lazy" decoding="async" alt="Thumbnail for the video: ${escAttr(v.title)}">
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
// Blog hubs (topic clusters). Order = display order on the blog index.
// -----------------------------------------------------------------------------
const HUBS = [
  { id: "fair-prices", name: "Fair prices", blurb: "Personalized and dynamic pricing, the loyalty penalty, and simple habits to stop overpaying." },
  { id: "money-mind", name: "Money mind", blurb: "Why clever people still make money mistakes, and the systems that beat willpower." },
  { id: "lifestyle-creep", name: "Spending & lifestyle creep", blurb: "Why earning more doesn't automatically make you richer, and how to keep more of each raise." },
  { id: "work-time-money", name: "Work, time & money", blurb: "Where the 40-hour week came from, and how to think about money as hours of your life." },
];
const hubById = (id) => HUBS.find((h) => h.id === id);

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
    const hasVideo = { v: false };
    const { html } = markdownToHtml(body, { hasVideo });
    const words = stripTags(html).split(/\s+/).filter(Boolean).length;
    const image = (meta.image || "").replace(/^\//, "");
    posts.push({
      slug,
      title: meta.title || slug,
      seoTitle: meta.seo_title || meta.title || slug,
      description: meta.description || "",
      keyword: meta.keyword || "",
      hub: meta.hub || "",
      pillar: meta.pillar === "true",
      image,
      imageAlt: meta.image_alt || "",
      date: meta.date || "",
      updated: meta.updated || meta.date || "",
      html,
      hasVideo: hasVideo.v,
      faq: extractFaq(body),
      words,
      minutes: Math.max(1, Math.round(words / 230)),
    });
  }
  // Pillars first inside each hub, then newest (by date), then slug.
  posts.sort((a, b) => (b.pillar - a.pillar) || (b.date || "").localeCompare(a.date || "") || a.slug.localeCompare(b.slug));
  return posts;
}

// Responsive <img> for a blog hero (variants: -400, -800, full 1200).
function heroImg(post, { eager = false, sizes = "(min-width: 48rem) 46rem, 100vw" } = {}) {
  if (!post.image) return "";
  const base = post.image.replace(/\.webp$/, "");
  const attrs = eager ? `fetchpriority="high" decoding="async"` : `loading="lazy" decoding="async"`;
  return `<img src="{{BASE}}${base}-800.webp" srcset="{{BASE}}${base}-400.webp 400w, {{BASE}}${base}-800.webp 800w, {{BASE}}${post.image} 1200w" sizes="${sizes}" width="1200" height="675" ${attrs} alt="${escAttr(post.imageAlt)}">`;
}

function postCard(p, headingLevel = 3) {
  const h = `h${headingLevel}`;
  return `<li class="post-card card">
        <a class="post-card-img" href="{{BASE}}blog/${p.slug}/" tabindex="-1" aria-hidden="true">${heroImg(p, { sizes: "(min-width: 42rem) 22rem, 100vw" })}</a>
        <div class="post-card-body">
          ${p.pillar ? `<p class="badge">Start here</p>` : ""}
          <${h}><a href="{{BASE}}blog/${p.slug}/">${esc(p.title)}</a></${h}>
          <p>${esc(p.description)}</p>
          <p class="meta">${p.minutes} min read</p>
        </div>
      </li>`;
}

function blogListHtml(posts) {
  if (!posts.length) return `<p>No posts yet — check back soon.</p>`;
  const parts = [];
  for (const hub of HUBS) {
    const inHub = posts.filter((p) => p.hub === hub.id);
    if (!inHub.length) continue;
    parts.push(`<section class="hub" id="${hub.id}" aria-labelledby="hub-${hub.id}">
      <h2 id="hub-${hub.id}">${esc(hub.name)}</h2>
      <p>${esc(hub.blurb)}</p>
      <ul class="post-grid">
      ${inHub.map((p) => postCard(p, 3)).join("\n      ")}
      </ul>
    </section>`);
  }
  const rest = posts.filter((p) => !hubById(p.hub));
  if (rest.length) {
    parts.push(`<section class="hub" id="more" aria-labelledby="hub-more">
      <h2 id="hub-more">More articles</h2>
      <ul class="post-grid">
      ${rest.map((p) => postCard(p, 3)).join("\n      ")}
      </ul>
    </section>`);
  }
  return parts.join("\n");
}

function blogTeaserHtml(posts) {
  if (!posts.length) return `<p>Articles are on the way.</p>`;
  const pillars = posts.filter((p) => p.pillar);
  const top = (pillars.length >= 2 ? pillars : posts).slice(0, 4);
  return top.map((p) => postCard(p, 3)).join("\n");
}

function relatedHtml(post, posts) {
  const same = posts.filter((p) => p.slug !== post.slug && p.hub === post.hub);
  const pillar = posts.find((p) => p.pillar && p.hub === post.hub && p.slug !== post.slug);
  const others = posts.filter((p) => p.slug !== post.slug && p.hub !== post.hub && p.pillar);
  const list = [...new Set([...(pillar ? [pillar] : []), ...same, ...others])].slice(0, 4);
  if (!list.length) return "";
  return `<section class="related" aria-labelledby="related-h">
        <h2 id="related-h">Keep reading</h2>
        <ul class="post-grid">
        ${list.map((p) => postCard(p, 3)).join("\n        ")}
        </ul>
      </section>`;
}

// -----------------------------------------------------------------------------
// Structured data (JSON-LD)
// -----------------------------------------------------------------------------
const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;
function orgLd() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/assets/img/logo.webp`, width: 256, height: 256 },
    description: "Coin & Cortex explains the psychology of money and behavioral economics with doodle videos and practical, sourced articles.",
    sameAs: [config.YOUTUBE_CHANNEL],
    founder: { "@type": "Person", name: config.SELLER_NAME },
    email: config.CONTACT_EMAIL,
  };
}
function websiteLd() {
  return { "@type": "WebSite", "@id": SITE_ID, url: `${SITE_URL}/`, name: SITE_NAME, publisher: { "@id": ORG_ID }, inLanguage: "en" };
}
function breadcrumbLd(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
  };
}
function faqLd(faq) {
  return {
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}
function ldScript(graph) {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `  <script type="application/ld+json">${json}</script>`;
}
function priceNumber() {
  const m = String(config.KIT_PRICE).replace(",", ".").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]).toFixed(2) : "";
}
function priceCurrency() {
  const s = String(config.KIT_PRICE);
  if (/€|eur/i.test(s)) return "EUR";
  if (/\$|usd/i.test(s)) return "USD";
  if (/£|gbp/i.test(s)) return "GBP";
  return "EUR";
}

// -----------------------------------------------------------------------------
// Head meta (canonical + OG/Twitter).
// -----------------------------------------------------------------------------
function pageUrl(out) {
  const folder = out.replace(/index\.html$/, "").replace(/^(.*)\/$/, "$1");
  return folder ? `${SITE_URL}/${folder}/` : `${SITE_URL}/`;
}

function headExtra({ title, description, out, base, rootRelative, ogType = "website", ogImage, ogImageAlt, extra = [] }) {
  const parts = [];
  const img = ogImage || { url: `${SITE_URL}/assets/img/og_default.jpg`, w: 1200, h: 630, alt: "Coin & Cortex: why your brain is bad with money" };
  let url = "";
  if (SITE_URL && !rootRelative) {
    url = pageUrl(out);
    parts.push(`  <link rel="canonical" href="${escAttr(url)}">`);
  }
  parts.push(`  <meta property="og:type" content="${ogType}">`);
  parts.push(`  <meta property="og:site_name" content="${escAttr(SITE_NAME)}">`);
  parts.push(`  <meta property="og:locale" content="en_US">`);
  parts.push(`  <meta property="og:title" content="${escAttr(title)}">`);
  parts.push(`  <meta property="og:description" content="${escAttr(description)}">`);
  parts.push(`  <meta property="og:image" content="${escAttr(img.url)}">`);
  parts.push(`  <meta property="og:image:width" content="${img.w}">`);
  parts.push(`  <meta property="og:image:height" content="${img.h}">`);
  parts.push(`  <meta property="og:image:alt" content="${escAttr(ogImageAlt || img.alt)}">`);
  if (url) parts.push(`  <meta property="og:url" content="${escAttr(url)}">`);
  parts.push(`  <meta name="twitter:card" content="summary_large_image">`);
  parts.push(`  <meta name="twitter:title" content="${escAttr(title)}">`);
  parts.push(`  <meta name="twitter:description" content="${escAttr(description)}">`);
  parts.push(`  <meta name="twitter:image" content="${escAttr(img.url)}">`);
  parts.push(`  <meta name="twitter:image:alt" content="${escAttr(ogImageAlt || img.alt)}">`);
  return parts.concat(extra).join("\n");
}

// -----------------------------------------------------------------------------
// Final substitution pass
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
    return full;
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

// Minify the stylesheet so it can be inlined (removes a render-blocking request).
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function rfc822(dateStr) {
  const d = new Date(`${dateStr}T08:00:00Z`);
  return isNaN(d) ? "" : d.toUTCString();
}
function isoDate(dateStr) {
  return dateStr ? `${dateStr}T08:00:00+00:00` : "";
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------
async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const layout = await readFile(path.join(SRC, "layout.html"), "utf8");
  const css = minifyCss(await readFile(path.join(SRC, "assets/css/style.css"), "utf8"));
  const posts = await loadBlogPosts();

  const computed = {
    "{{LATEST_VIDEOS}}": videoCards(),
    "{{BLOG_LIST}}": blogListHtml(posts),
    "{{BLOG_TEASER}}": blogTeaserHtml(posts),
    "{{BUY_BUTTON}}": buyButton(),
  };

  function assemble({ title, description, body, out, base, rootRelative, robots, ogType, ogImage, ogImageAlt, ld, extraHead = [], script = "" }) {
    const extra = [...extraHead];
    if (ld && ld.length && SITE_URL) extra.push(ldScript(ld));
    const inlineCss = css.replace(/url\(["']?\.\.\/fonts\//g, 'url("{{BASE}}assets/fonts/').replace(/(woff2)["']?\)/g, '$1")');
    let html = layout
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace(/\{\{DESCRIPTION\}\}/g, esc(description))
      .replace(/\{\{ROBOTS\}\}/g, robots || "index, follow, max-image-preview:large, max-snippet:-1")
      .replace(/\{\{INLINE_CSS\}\}/g, inlineCss)
      .replace(/\{\{HEAD_EXTRA\}\}/g, headExtra({ title, description, out, base, rootRelative, ogType, ogImage, ogImageAlt, extra }))
      .replace(/\{\{BODY_SCRIPT\}\}/g, script)
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
    const url = SITE_URL && !p.rootRelative ? pageUrl(p.out) : "";
    const crumbName = meta.crumb || title.replace(/\s+[—-]\s+Coin & Cortex$/, "");
    const ld = [];
    if (p.out === "index.html") {
      ld.push(orgLd(), websiteLd());
      ld.push({ "@type": "WebPage", "@id": `${url}#webpage`, url, name: title, description, isPartOf: { "@id": SITE_ID }, about: { "@id": ORG_ID }, inLanguage: "en" });
    } else if (!p.rootRelative) {
      ld.push(breadcrumbLd([{ name: "Home", url: `${SITE_URL}/` }, { name: crumbName, url }]));
      const type = p.out === "about/index.html" ? "AboutPage" : p.out === "blog/index.html" ? "CollectionPage" : "WebPage";
      const page = { "@type": type, "@id": `${url}#webpage`, url, name: title, description, isPartOf: { "@id": SITE_ID }, inLanguage: "en" };
      if (type === "AboutPage") { page.about = { "@id": ORG_ID }; ld.push(orgLd()); }
      if (type === "CollectionPage") {
        page.mainEntity = { "@type": "ItemList", itemListElement: posts.map((x, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_URL}/blog/${x.slug}/`, name: x.title })) };
      }
      ld.push(page);
    }
    if (p.out === "shop/index.html") {
      ld.push({
        "@type": "Product",
        "@id": `${url}#product`,
        name: "The Switching Day Kit",
        description,
        image: ["cover_1_hero", "cover_2_whats_inside", "cover_3_tracker_scripts", "kit_preview"].map((n) => `${SITE_URL}/assets/img/${n}.webp`),
        brand: { "@type": "Brand", name: SITE_NAME },
        category: "Digital download",
        offers: {
          "@type": "Offer",
          url,
          price: priceNumber(),
          priceCurrency: priceCurrency(),
          availability: "https://schema.org/InStock",
          seller: { "@id": ORG_ID },
        },
      });
      // Real FAQ on the page (<details> blocks) -> FAQPage
      const faq = [...body.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => ({
        q: stripTags(m[1]),
        a: stripTags(substitute(m[2], base)),
      }));
      if (faq.length) ld.push(faqLd(faq));
    }
    const html = assemble({
      title, description, body, out: p.out, base, rootRelative: p.rootRelative,
      robots: p.rootRelative ? "noindex, follow" : undefined,
      ld,
      extraHead: p.out === "blog/index.html" || p.out === "index.html" ? [`  <link rel="alternate" type="application/rss+xml" title="${SITE_NAME} blog" href="${SITE_URL}/blog/feed.xml">`] : [],
    });
    await writeOut(p.out, html);
  }

  // --- blog posts ---
  const postLayout = await readFile(path.join(SRC, "post.html"), "utf8");
  for (const post of posts) {
    const out = `blog/${post.slug}/index.html`;
    const base = baseFor(out, false);
    const url = pageUrl(out);
    const hub = hubById(post.hub);
    const crumbs = `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="{{BASE}}">Home</a></li><li><a href="{{BASE}}blog/">Blog</a></li>${hub ? `<li><a href="{{BASE}}blog/#${hub.id}">${esc(hub.name)}</a></li>` : ""}<li aria-current="page">${esc(post.title)}</li></ol></nav>`;
    const byline = `<p class="byline">By <a href="{{BASE}}about/">the Coin &amp; Cortex team</a> · ${post.minutes} min read · <a href="{{BASE}}about/#editorial-standards">How we research</a></p>`;
    const hero = post.image ? `<figure class="post-hero">${heroImg(post, { eager: true })}</figure>` : "";
    const body = postLayout
      .replace(/\{\{BREADCRUMBS\}\}/g, crumbs)
      .replace(/\{\{POST_TITLE\}\}/g, esc(post.title))
      .replace(/\{\{POST_BYLINE\}\}/g, byline)
      .replace(/\{\{POST_HERO\}\}/g, hero)
      .replace(/\{\{POST_BODY\}\}/g, post.html)
      .replace(/\{\{RELATED\}\}/g, relatedHtml(post, posts))
      .replace(/\{\{POST_DATE\}\}/g, "");
    const imgUrl = post.image ? `${SITE_URL}/${post.image}` : `${SITE_URL}/assets/img/og_default.jpg`;
    const ogUrl = post.image ? `${SITE_URL}/${post.image.replace(/\.webp$/, "-og.jpg")}` : `${SITE_URL}/assets/img/og_default.jpg`;
    const ld = [
      {
        "@type": "BlogPosting",
        "@id": `${url}#article`,
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
        headline: post.title.length > 110 ? post.seoTitle : post.title,
        description: post.description,
        image: [imgUrl, ogUrl],
        author: { "@type": "Organization", name: SITE_NAME, url: `${SITE_URL}/about/` },
        publisher: { "@id": ORG_ID },
        inLanguage: "en",
        wordCount: post.words,
        ...(post.keyword ? { keywords: post.keyword } : {}),
        ...(hub ? { articleSection: hub.name } : {}),
        ...(post.date ? { datePublished: isoDate(post.date), dateModified: isoDate(post.updated) } : {}),
        isPartOf: { "@id": SITE_ID },
      },
      orgLd(),
      breadcrumbLd([
        { name: "Home", url: `${SITE_URL}/` },
        { name: "Blog", url: `${SITE_URL}/blog/` },
        ...(hub ? [{ name: hub.name, url: `${SITE_URL}/blog/#${hub.id}` }] : []),
        { name: post.title, url },
      ]),
    ];
    if (post.faq.length) ld.push(faqLd(post.faq));
    const extraHead = [`  <link rel="alternate" type="application/rss+xml" title="${SITE_NAME} blog" href="${SITE_URL}/blog/feed.xml">`];
    if (post.date) {
      extraHead.push(`  <meta property="article:published_time" content="${isoDate(post.date)}">`);
      extraHead.push(`  <meta property="article:modified_time" content="${isoDate(post.updated)}">`);
    }
    if (hub) extraHead.push(`  <meta property="article:section" content="${escAttr(hub.name)}">`);
    if (post.image) extraHead.push(`  <link rel="preload" as="image" href="{{BASE}}${post.image.replace(/\.webp$/, "-800.webp")}" imagesrcset="{{BASE}}${post.image.replace(/\.webp$/, "-400.webp")} 400w, {{BASE}}${post.image.replace(/\.webp$/, "-800.webp")} 800w, {{BASE}}${post.image} 1200w" imagesizes="(min-width: 48rem) 46rem, 100vw" fetchpriority="high">`);
    const html = assemble({
      title: `${post.seoTitle} | ${SITE_NAME}`.length <= 65 ? `${post.seoTitle} | ${SITE_NAME}` : post.seoTitle,
      description: post.description,
      body,
      out,
      base,
      rootRelative: false,
      ogType: "article",
      ogImage: { url: ogUrl, w: 1200, h: 630, alt: post.imageAlt },
      ogImageAlt: post.imageAlt,
      ld,
      extraHead,
      script: post.hasVideo ? VIDEO_SCRIPT : "",
    });
    await writeOut(out, html);
  }

  // --- static assets ---
  await copyDir(path.join(SRC, "assets"), path.join(DIST, "assets"));
  await copyDir(path.join(SRC, "downloads"), path.join(DIST, "downloads"));
  for (const f of ["favicon.png", "apple-touch-icon.png"]) {
    if (existsSync(path.join(SRC, f))) await copyFile(path.join(SRC, f), path.join(DIST, f));
  }

  // --- CNAME for GitHub Pages custom domain ---
  if (SITE_URL) await writeOut("CNAME", new URL(SITE_URL).host + "\n");

  // --- robots.txt (always). /dl/ (paid download) must never be crawled. ---
  const robots = SITE_URL
    ? `User-agent: *\nAllow: /\nDisallow: /dl/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    : `User-agent: *\nAllow: /\nDisallow: /dl/\n`;
  await writeOut("robots.txt", robots);

  // --- sitemap.xml + RSS (only when SITE_URL is set) ---
  if (SITE_URL) {
    const newest = posts.map((p) => p.updated).filter(Boolean).sort().pop() || "";
    const entries = [];
    for (const p of PAGES) {
      if (p.rootRelative || p.noSitemap) continue;
      const lastmod = p.out === "index.html" || p.out === "blog/index.html" ? newest : "";
      entries.push({ loc: pageUrl(p.out), lastmod });
    }
    for (const post of posts) entries.push({ loc: `${SITE_URL}/blog/${post.slug}/`, lastmod: post.updated, image: post.image ? `${SITE_URL}/${post.image}` : "" });
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
      entries
        .map((e) => `  <url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ""}${e.image ? `<image:image><image:loc>${esc(e.image)}</image:loc></image:image>` : ""}</url>`)
        .join("\n") +
      `\n</urlset>\n`;
    await writeOut("sitemap.xml", xml);

    const byDate = [...posts].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const rss =
      `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n` +
      `  <title>${esc(SITE_NAME)} blog</title>\n  <link>${SITE_URL}/blog/</link>\n` +
      `  <atom:link href="${SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml"/>\n` +
      `  <description>Plain-English articles about money psychology, behavioral economics and fair prices.</description>\n  <language>en</language>\n` +
      byDate
        .map((p) => `  <item>\n    <title>${esc(p.title)}</title>\n    <link>${SITE_URL}/blog/${p.slug}/</link>\n    <guid isPermaLink="true">${SITE_URL}/blog/${p.slug}/</guid>\n    <description>${esc(p.description)}</description>\n${p.date ? `    <pubDate>${rfc822(p.date)}</pubDate>\n` : ""}  </item>`)
        .join("\n") +
      `\n</channel>\n</rss>\n`;
    await writeOut("blog/feed.xml", rss);
  }

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
