import { loadConfig, type Config } from './config.js';
import { ButtondownClient, type ButtondownEmail } from './buttondown.js';
import { escapeHtml } from './html.js';
import type { Article } from './types.js';

/**
 * Buttondown's paywall element. Everything above it is visible to everyone
 * (including the public archive page, which is what search engines index);
 * everything below is premium-only.
 */
const PAYWALL_MARKER = '<div role="paywall"></div>';

const MEDICAL_DISCLAIMER =
  '<hr><p><em>This article is journalism about health systems and practices in Japan. ' +
  'It is not medical advice, diagnosis, or treatment. Consult a qualified clinician about ' +
  'your own health.</em></p>';

export interface PublishResult {
  id: string;
  url: string;
  status: string;
  subject: string;
  slug: string;
}

export class Publisher {
  private readonly config: Config;
  private readonly client: ButtondownClient;

  constructor(config: Config = loadConfig()) {
    this.config = config;
    this.client = new ButtondownClient(config);
  }

  /** Fail fast on a bad API key before spending money on generation. */
  async verifyConnection(): Promise<string> {
    const { username, subscribers } = await this.client.verify();
    return `${username} (${subscribers} subscribers)`;
  }

  async publish(article: Article, related: RelatedLink[] = []): Promise<PublishResult> {
    let email: ButtondownEmail = await this.client.createEmail({
      subject: article.title,
      body: buildPostHtml(article, related),
      slug: article.slug,
      description: article.meta_description,
    });

    // Creating an email always yields a draft, whatever status the create call
    // asked for — and a draft has no public archive page, so the article is
    // invisible to readers and crawlers while the run reports success.
    // Publishing is a separate transition, so make it here rather than leaving
    // the configured status silently meaningless.
    const wanted = this.config.BUTTONDOWN_EMAIL_STATUS;
    if (wanted !== 'draft' && email.status === 'draft') {
      try {
        email = await this.client.setEmailStatus(email.id, wanted);
      } catch (error) {
        // The article exists either way; losing the transition costs visibility,
        // not content. Say so loudly instead of failing a run that did publish.
        console.warn(
          `[publisher] Created the article but could not move it to "${wanted}": ` +
            `${error instanceof Error ? error.message.slice(0, 200) : error}\n` +
            '  It is still a draft with no public page. Run `npm run publish -- --confirm`.',
        );
      }
    }

    return {
      id: email.id,
      url: email.absolute_url ?? '(archive URL not returned by the API)',
      status: email.status ?? this.config.BUTTONDOWN_EMAIL_STATUS,
      subject: email.subject ?? article.title,
      slug: email.slug ?? article.slug,
    };
  }
}

export interface RelatedLink {
  title: string;
  url: string;
}

/**
 * Keep only the links whose archive page actually exists.
 *
 * A Buttondown email that is still a draft has no public page — its archive
 * URL returns 404. Linking to one puts a dead link on a page we want search
 * engines to rank, which is worse than having no link at all. Candidates are
 * checked newest-first and the first `limit` live ones are kept.
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
    // Network trouble is not proof the page is missing, but including a link we
    // could not verify risks publishing a dead one. Skipping costs only a link.
    return false;
  }
}

/**
 * Assemble the post: free section, internal links, paywall, paid body.
 *
 * The related-links block sits ABOVE the paywall on purpose. Search crawlers
 * read the page as anonymous visitors, so anything below the paywall is
 * invisible to them - links placed there would pass no authority and would not
 * help new archive pages get discovered.
 */
export function buildPostHtml(article: Article, related: RelatedLink[] = []): string {
  const takeaways =
    article.key_takeaways.length > 0
      ? `<h2>Key takeaways</h2><ul>${article.key_takeaways
          .map((t) => `<li>${escapeHtml(t)}</li>`)
          .join('')}</ul>`
      : '';

  const disclaimer = article.category === 'healthcare' ? MEDICAL_DISCLAIMER : '';

  return [
    article.free_section_html,
    buildRelatedBlock(related),
    PAYWALL_MARKER,
    article.paid_body_html,
    takeaways,
    disclaimer,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Crawlable internal links to earlier archive pages. */
export function buildRelatedBlock(related: readonly RelatedLink[]): string {
  const usable = related.filter((r) => /^https?:\/\//.test(r.url) && r.title.trim());
  if (usable.length === 0) return '';

  const items = usable
    .map((r) => `<li><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></li>`)
    .join('');

  return `<p><strong>Related</strong></p><ul>${items}</ul>`;
}

export function formatPrice(cents: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** Net revenue per member after Stripe's 2.9% + $0.30 (US cards). */
export function netAfterStripe(grossCents: number): number {
  return grossCents - (grossCents * 0.029 + 30);
}
