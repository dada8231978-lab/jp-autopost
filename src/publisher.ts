import type { Category } from './types.js';

export interface RelatedLink {
  title: string;
  url: string;
}

/** Buttondown's paywall element; everything below it is paid-only. */
const PAYWALL = '<div role="paywall"></div>';

/** Tells Buttondown the body is Markdown rather than leaving it to guess. */
const MARKDOWN_MODE = '<!-- buttondown-editor-mode: plaintext -->';

const MEDICAL_DISCLAIMER =
  '*This article is journalism about health systems and practices in Japan. It is not medical ' +
  'advice, diagnosis, or treatment. Consult a qualified clinician about your own health.*';

/**
 * Assemble the email body from the author's edited sections.
 *
 * Related links sit above the paywall: crawlers read the page as anonymous
 * visitors, so links below it would be invisible to them.
 */
export function buildBody(input: {
  free: string;
  paid: string;
  related: readonly RelatedLink[];
  category: Category;
}): string {
  const parts = [MARKDOWN_MODE, input.free.trim()];

  if (input.related.length > 0) {
    const items = input.related.map((r) => `- [${escapeLinkText(r.title)}](${r.url})`).join('\n');
    parts.push(`**Related**\n\n${items}`);
  }

  parts.push(PAYWALL, input.paid.trim());

  // A blank line before the rule matters: "---" directly under a paragraph
  // would turn that paragraph into a heading.
  if (input.category === 'healthcare') parts.push('* * *', MEDICAL_DISCLAIMER);

  return parts.join('\n\n');
}

function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}

/**
 * Keep only the links whose archive page actually exists.
 *
 * A Buttondown email that never made it out of draft has no public page, so
 * linking to one puts a 404 on a page meant to rank. Candidates are checked
 * newest-first and the first `limit` live ones are kept.
 */
export async function filterLiveLinks(
  candidates: readonly RelatedLink[],
  limit: number,
  timeoutMs = 5000,
): Promise<RelatedLink[]> {
  const live: RelatedLink[] = [];
  for (const candidate of candidates) {
    if (live.length >= limit) break;
    if (await isLive(candidate.url, timeoutMs)) live.push(candidate);
  }
  return live;
}

async function isLive(url: string, timeoutMs: number): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    // Unverifiable is treated as not live: skipping a good link costs one
    // link, publishing a dead one costs the page.
    return false;
  }
}

export function formatPrice(cents: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** Net revenue per member after Stripe's 2.9% + $0.30 (US cards). */
export function netAfterStripe(grossCents: number): number {
  return grossCents - (grossCents * 0.029 + 30);
}
