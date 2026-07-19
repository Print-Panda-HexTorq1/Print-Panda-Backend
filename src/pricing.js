/**
 * Count how many pages will actually be printed given a page selection string.
 * Supports: "all", ranges like "1-5", comma-separated like "1,3,7",
 * or mixed like "1-3,5,8". Pages outside [1, totalPageCount] are ignored.
 */
export function countSelectedPages(pageSelection, totalPageCount) {
  const total = Number(totalPageCount) > 0 ? Number(totalPageCount) : 1;
  const sel = String(pageSelection || "").trim().toLowerCase();
  if (!sel || sel === "all") return total;

  const pageSet = new Set();
  for (const part of sel.split(",")) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const from = Math.max(1, parseInt(rangeMatch[1], 10));
      const to = Math.min(total, parseInt(rangeMatch[2], 10));
      for (let i = from; i <= to; i++) pageSet.add(i);
    } else if (/^\d+$/.test(trimmed)) {
      const p = parseInt(trimmed, 10);
      if (p >= 1 && p <= total) pageSet.add(p);
    }
  }
  return pageSet.size > 0 ? pageSet.size : total;
}

export function getUnitPrice(colorMode, pricing = {}) {
  const bwPrice = Number(pricing.bwPrice);
  const colorPrice = Number(pricing.colorPrice);
  const safeBw = Number.isFinite(bwPrice) && bwPrice >= 0 ? bwPrice : 3;
  const safeColor = Number.isFinite(colorPrice) && colorPrice >= 0 ? colorPrice : 10;
  return colorMode === "color" ? safeColor : safeBw;
}

export function calculateTotalPrice({ colorMode, copies, pageCount, bwPrice, colorPrice }) {
  const unitPrice = getUnitPrice(colorMode, { bwPrice, colorPrice });
  const safeCopies = Number(copies) > 0 ? Number(copies) : 1;
  const safePageCount = Number(pageCount) > 0 ? Number(pageCount) : 1;
  const totalPrice = unitPrice * safeCopies * safePageCount;
  return { unitPrice, totalPrice };
}
