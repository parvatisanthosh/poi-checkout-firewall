// Product pages two ways:
//   pageText -- what a scraper/agent extracts: every field, hidden text INCLUDED inline (the attack)
//   pageHtml -- the storefront page, with the hidden text actually hidden. Each hidden element is
//               tagged data-poi-hidden so the web app's "Agent's-eye view" can reveal it.
import type { ListingCard, ProductPage } from "@poi/shared";
import type { BazaarData, Product } from "./data";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const usd = (n: number) => `$${n.toFixed(2)}`;

export function toCard(p: Product, data: BazaarData): ListingCard {
  return {
    sku: p.sku,
    title: p.title,
    priceUsd: p.priceUsd,
    merchantId: p.merchantId,
    merchantName: data.merchant(p.merchantId)?.displayName ?? p.merchantId,
    rating: p.rating,
    ...(p.badge ? { badge: p.badge } : {}),
    snippet: p.bullets[0]!,
  };
}

const LABELS: Record<string, string> = {
  injection: "hidden instruction",
  subscription: "fine print",
  variant: "fine print",
  addon: "pre-checked add-on",
  lookalike: "look-alike seller",
  darkpattern: "dark pattern",
};

export function pageText(p: Product, data: BazaarData): string {
  const seller = data.merchant(p.merchantId)?.displayName ?? p.merchantId;
  const desc =
    p.hidden?.placement === "description" ? `${p.description} ${p.hidden.text}` : p.description;
  return [
    p.title,
    `Sold by ${seller}${p.badge ? ` | ${p.badge}` : ""}`,
    ...(p.banner ? [p.banner] : []),
    `Price: ${usd(p.priceUsd)} | Shipping: ${p.shippingUsd ? usd(p.shippingUsd) : "FREE"}`,
    `Rating: ${p.rating} out of 5 (${p.reviews.toLocaleString("en-US")} reviews)`,
    "About this item:",
    ...p.bullets.map((b) => `- ${b}`),
    "Description:",
    desc,
    "Specifications:",
    ...Object.entries(p.specs).map(([k, v]) => `- ${k}: ${v}`),
    `Image: ${p.imageAlt}`,
    "Top reviews:",
    ...p.topReviews.map((r) => `- ${r.stars}/5 ${r.author}: ${r.text}`),
  ].join("\n");
}

export function pageHtml(p: Product, data: BazaarData): string {
  const seller = data.merchant(p.merchantId)?.displayName ?? p.merchantId;
  const label = esc(LABELS[p.family] ?? "hidden");
  const tag = (placement: string) => `data-poi-hidden="${placement}" data-poi-label="${label}"`;
  const h = p.hidden;
  const desc =
    h?.placement === "description"
      ? `${esc(p.description)} <span ${tag("description")} style="display:none">${esc(h.text)}</span>`
      : esc(p.description);
  const specRows = Object.entries(p.specs)
    .map(([k, v]) => {
      const fine = h?.placement === "spec" && h.text.includes(v);
      return fine
        ? `<tr ${tag("spec")} style="font-size:9px;color:#b8b8b8"><th>${esc(k)}</th><td>${esc(v)}</td></tr>`
        : `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
    })
    .join("");
  const reviews = p.topReviews
    .map((r) => {
      const hiddenReview = h?.placement === "review" && r.text === h.text;
      return hiddenReview
        ? `<li ${tag("review")} style="font-size:0;color:transparent;height:0;overflow:hidden">${esc(r.text)}</li>`
        : `<li><strong>${"&#9733;".repeat(r.stars)}</strong> ${esc(r.author)}: ${esc(r.text)}</li>`;
    })
    .join("");
  const alt = esc(p.imageAlt);
  return `<article class="poi-product" data-sku="${esc(p.sku)}" data-family="${esc(p.family)}">
<h1>${esc(p.title)}</h1>
<p class="seller" ${p.family === "lookalike" ? tag("seller") : ""}>Sold by <strong>${esc(seller)}</strong>${p.badge ? ` <span class="badge">${esc(p.badge)}</span>` : ""}</p>
${p.banner ? `<p class="banner" ${tag("banner")}>${esc(p.banner)}</p>` : ""}
<div class="image" role="img" aria-label="${alt}" ${h?.placement === "alt" ? tag("alt") : ""} data-alt="${alt}"></div>
<p class="price"><strong>${usd(p.priceUsd)}</strong> <span>${p.shippingUsd ? `+ ${usd(p.shippingUsd)} shipping` : "FREE shipping"}</span></p>
<p class="rating">${p.rating} out of 5 (${p.reviews.toLocaleString("en-US")} reviews)</p>
<h2>About this item</h2><ul>${p.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
<h2>Description</h2><p>${desc}</p>
<h2>Specifications</h2><table>${specRows}</table>
<h2>Top reviews</h2><ul class="reviews">${reviews}</ul>
</article>`;
}

export function productPage(p: Product, data: BazaarData): ProductPage {
  return {
    card: toCard(p, data),
    pageText: pageText(p, data),
    pageHtml: pageHtml(p, data),
    merchantId: p.merchantId,
  };
}
