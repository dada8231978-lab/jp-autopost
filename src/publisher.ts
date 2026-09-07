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
    const email: ButtondownEmail = await this.client.createEmail({
      subject: article.title,
      body: buildPostHtml(article, related),
      slug: article.slug,
      description: article.meta_description,
    });

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
