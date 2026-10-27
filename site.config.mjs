// =============================================================================
// Coin & Cortex — site configuration
// -----------------------------------------------------------------------------
// This is the ONE place to change swappable values. Nothing below should be
// hard-coded anywhere else in the templates. Every page receives these values
// through {{KEY}} placeholders at build time (see build.mjs).
//
// After editing this file, run:  node build.mjs
// =============================================================================

export default {
  // ---------------------------------------------------------------------------
  // Commerce
  // ---------------------------------------------------------------------------

  // Stripe Payment Link for the Switching Day Kit.
  // While this starts with "#", the buy button still renders but shows a small
  // "Checkout opens soon" note and points to the free checklist as alternative.
  // Replace with the real https Stripe Payment Link before launch.
  STRIPE_KIT_LINK: "https://buy.stripe.com/eVq4gy5LLd68cIv5In08g00",

  // Display price string for the kit (shown as-is; not used for any maths).
  KIT_PRICE: "7 €",

  // ---------------------------------------------------------------------------
  // Contact & channel
  // ---------------------------------------------------------------------------

  // Public contact address. Placeholder until a real inbox is decided.
  // Swap before launch (appears in Impressum, Privacy, Terms and the Shop FAQ).
  CONTACT_EMAIL: "coinandcortex@gmail.com",

  // YouTube channel URL (used for all "Watch on YouTube" links and the footer).
  YOUTUBE_CHANNEL: "https://www.youtube.com/@coinandcortex",

  // ---------------------------------------------------------------------------
  // Domain
  // ---------------------------------------------------------------------------

  // Leave empty for a domain-agnostic build (works from any domain and from a
  // GitHub Pages project subfolder). When set to a full origin such as
  // "https://coinandcortex.example", the build adds canonical + absolute OG
  // URLs and generates sitemap.xml. Do NOT include a trailing slash.
  SITE_URL: "https://coinandcortex.com",

  // ---------------------------------------------------------------------------
  // Seller details (used in Impressum / Privacy / Terms)
  // ---------------------------------------------------------------------------
  SELLER_NAME: "Maximilian Hölzl",
  SELLER_ADDRESS: "Eich 56, 5310 Mondsee, Austria",
  SELLER_VAT: "ATU82656706",

  // ---------------------------------------------------------------------------
  // Latest videos (newest first). `thumb` matches a file in src/assets/img/.
  // ---------------------------------------------------------------------------
  VIDEOS: [
    {
      title: "The Psychology of Financial Intelligence: Why Smart People Stay Broke",
      url: "https://youtu.be/7jiqngd_VxM",
      thumb: "thumb_video03",
    },
    {
      title: "Why You and Your Neighbor Now Pay Different Prices (And How to Stop Overpaying)",
      url: "https://youtu.be/X7BITLlTogA",
      thumb: "thumb_video02",
    },
    {
      title: "The Psychology of People Who Quietly Get Rich (And Never Look It)",
      url: "https://youtu.be/IHQU1KyB7Aw",
      thumb: "thumb_video01",
    },
  ],
};
