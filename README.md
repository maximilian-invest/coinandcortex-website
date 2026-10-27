# Coin & Cortex — website

A tiny, zero-dependency static site for the Coin & Cortex channel
(*the psychology of money, explained in doodles*). One Node build script turns
HTML partials + Markdown into a ready-to-host `dist/` folder.

- **No dependencies.** Node 20, only `node:` built-ins.
- **No JavaScript needed** for content. No external requests, no cookies, no analytics.
- **Domain-agnostic.** All internal links are relative, so the site works from any
  domain *and* from a project subfolder (e.g. GitHub Pages `/<repo>/`).

## Quick start

```sh
node build.mjs            # clean + write dist/
node build.mjs --serve    # build, then serve dist/ at http://localhost:8080
node scripts/check-links.mjs   # verify all links + evergreen/placeholder checks
```

## Structure

```
site.config.mjs           # ALL swappable values live here (price, links, seller, videos)
build.mjs                 # the whole build (layout, pages, blog, markdown, assets, robots/sitemap)
scripts/check-links.mjs   # post-build sanity check (prints OK)
src/
  layout.html             # shared shell: <head>, header nav, footer
  post.html               # wrapper for a single blog post
  pages/*.html            # one partial per page, with a tiny <!-- title/description --> block
  blog/*.md               # blog posts in Markdown with a --- front-matter block
  assets/                 # css, fonts, images (copied verbatim to dist/)
  downloads/              # the FREE checklist PDF (the paid kit PDF must never live here)
  favicon.png, apple-touch-icon.png
dist/                     # build output (generated; git-ignored)
```

### Placeholders

Templates use `{{KEY}}` substitution, filled at build time:

- `{{BASE}}` — relative prefix for the current page (`./`, `../`, `../../`; `/` for 404).
  Use it in front of every internal link/asset, e.g. `href="{{BASE}}shop/"`.
- Config values: `{{KIT_PRICE}}`, `{{CONTACT_EMAIL}}`, `{{YOUTUBE_CHANNEL}}`,
  `{{SELLER_NAME}}`, `{{SELLER_ADDRESS}}`, `{{SELLER_VAT}}`, `{{STRIPE_KIT_LINK}}`, `{{SITE_URL}}`.
- Computed blocks: `{{LATEST_VIDEOS}}`, `{{BLOG_TEASER}}`, `{{BLOG_LIST}}`, `{{BUY_BUTTON}}`,
  and (per page) `{{TITLE}}`, `{{DESCRIPTION}}`, `{{HEAD_EXTRA}}`, `{{CONTENT}}`.

## How to add a blog post

1. Create `src/blog/<slug>.md`.
2. Start the file with a front-matter block:

   ```markdown
   ---
   title: Your post title
   description: One sentence used for the meta description and the blog listing.
   date: optional   # omit it — posts are evergreen; date is only used for ordering
   ---

   Your Markdown here…
   ```

3. Link internally with the base placeholder, e.g. `[free checklist]({{BASE}}free-checklist/)`.
   The build fills `{{BASE}}` with the correct relative prefix.
4. Run `node build.mjs`. The post is rendered to `dist/blog/<slug>/index.html` and the
   blog index + home teaser pick it up automatically.

Supported Markdown: headings, paragraphs, **bold**/*italic*, `inline code`, links,
images, unordered/ordered lists, blockquotes, fenced code blocks, and `---` horizontal rules.

## Configuration

Everything swappable is in `site.config.mjs`:

- `STRIPE_KIT_LINK` — while it starts with `#`, the buy button still renders but shows a
  "Checkout opens soon" note and links to the free checklist. Set a real `https` Stripe
  Payment Link to make it a live buy button (`target` normal, `rel="noopener"`).
- `KIT_PRICE`, `CONTACT_EMAIL`, `YOUTUBE_CHANNEL`, seller details, and the `VIDEOS` list.
- `SITE_URL` — leave empty for a domain-agnostic build. When set to a full origin
  (no trailing slash), the build adds `<link rel="canonical">`, absolute OG URLs, and
  generates `sitemap.xml`. `robots.txt` is always generated (allow all).

## Deploy

### Cloudflare Pages
- Framework preset: **None**.
- Build command: `node build.mjs`
- Build output directory: `dist`
- Node version: 20

### GitHub Pages
A ready workflow is included at `.github/workflows/pages.yml`. It runs `node build.mjs`
on Node 20 and publishes `dist/` with the official `actions/upload-pages-artifact` +
`actions/deploy-pages`. Enable **Settings → Pages → Source: GitHub Actions**.

> Note on the 404 page: `dist/404.html` uses **root-relative** links (`/…`) because it is
> served at arbitrary URL depths. This assumes the site is hosted at the root of a domain
> (e.g. a custom domain or `user.github.io`). On a GitHub Pages **project** subfolder
> (`user.github.io/<repo>/`) the 404's own links would point at the domain root — acceptable,
> but worth knowing. Every other page uses fully relative links and works from any subfolder.

### Stripe note
Configure the Stripe **Payment Link** to:
- collect the withdrawal-waiver consent (a custom checkbox / terms-consent toggle so the
  buyer confirms immediate performance and the loss of the 14-day withdrawal right), and
- redirect after payment to a download-delivery step (Payment Links can show a confirmation
  page / redirect).

The actual file-delivery mechanism is still an open decision. **Do not** put the paid kit
PDF anywhere in this repo or in `dist/` — only the free checklist ships with the site.

## Swap before launch

- [ ] `STRIPE_KIT_LINK` → real Stripe Payment Link (with withdrawal-consent + delivery redirect)
- [ ] `KIT_PRICE` → final price string
- [ ] `CONTACT_EMAIL` → real contact address (currently a placeholder)
- [ ] `SITE_URL` / custom domain → set for canonical + sitemap
- [ ] Privacy: fill in the actual **hosting provider** name
- [ ] Legal drafts (Impressum / Privacy / Terms) → reviewed by a professional before publishing
- [ ] Impressum `[to confirm]` items → Gewerbebehörde, WKO chamber membership, consumer-arbitration line
- [ ] Privacy / Terms `[date]` → set a "Last updated" date

## Fonts & licences

- **Permanent Marker** (`src/assets/fonts/PermanentMarker-Regular.woff2`) — Apache License 2.0.
  Used for headings and the logo wordmark only; body text uses the system font stack.

## Paid kit download (Switching Day Kit)

The kit ZIP is never committed in plain form. `private/kit.zip.enc` is the ZIP
encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` (key = repo
secret `KIT_ZIP_KEY`). The Pages workflow decrypts it to
`/dl/<KIT_DL_TOKEN>/switching-day-kit.zip` (token = repo secret
`KIT_DL_TOKEN`), after the link check, so it is not in the sitemap and
`/dl/` is disallowed in robots.txt. That URL is the Stripe Payment Link's
after-payment confirmation link. To update the kit: re-encrypt the new ZIP with
the same key, commit `private/kit.zip.enc`, push.
