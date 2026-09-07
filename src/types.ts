import { z } from 'zod';

/** Topic category for an article. */
export const CategorySchema = z.enum(['culture', 'healthcare']);
export type Category = z.infer<typeof CategorySchema>;

/**
 * The shape Claude must return. Enforced server-side via structured outputs,
 * so we never have to repair malformed JSON.
 */
export const ArticleSchema = z.object({
  title: z
    .string()
    .describe('Compelling English headline, 50-70 characters, no clickbait, no emoji.'),
  slug: z
    .string()
    .describe('URL slug: lowercase ASCII words separated by hyphens, max 60 chars.'),
  category: CategorySchema.describe('Which of the two pillars this article belongs to.'),
  hook: z
    .string()
    .describe('One-sentence teaser (max 200 chars) shown in feeds and share cards.'),
  target_query: z
    .string()
    .describe(
      'The search query this article targets, written the way a real person types it into ' +
        'Google. Lowercase, 4-9 words, no branding, phrased as a question or a specific ' +
        'noun phrase. Example: "why are hospital stays so long in japan". It must be a ' +
        'query someone outside Japan would plausibly search.',
    ),
  free_section_html: z
    .string()
    .describe(
      'A COMPLETE SHORT ARTICLE shown above the paywall — not an introduction, not a teaser. This is THE ONLY PART SEARCH ENGINES CAN ' +
        'SEE, so it must stand on its own as a page worth ranking. 280-420 words in 4-5 <p> ' +
        'paragraphs. Structure: (1) the first sentence answers target_query directly and ' +
        'concretely - no throat-clearing, no scene-setting; (2) two or three paragraphs of ' +
        'real supporting substance with specifics; (3) a final paragraph that opens the ' +
        'deeper question the paid section resolves. A reader who stops here must feel the ' +
        'query was fully answered. Plain HTML only: <p>, <strong>, <em>. No headings.',
    ),
  paid_body_html: z
    .string()
    .describe(
      'The PAID body shown below the paywall. 1100-1600 words of real substance. ' +
        'Plain HTML only: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <blockquote>, <strong>, <em>. ' +
        'No <html>/<body>/<script>/<style>, no inline styles, no markdown fences.',
    ),
  key_takeaways: z
    .array(z.string())
    .describe('3-5 concrete takeaways, one sentence each. Rendered as a list at the end.'),
  tags: z
    .array(z.string())
    .describe('4-6 English topic tags in Title Case, e.g. "Kampo Medicine". No hashtags.'),
  meta_title: z
    .string()
    .describe(
      'SEO title, max 60 characters. Front-load the words from target_query - what a ' +
        'searcher scans for must appear in the first half. Plainer than the headline.',
    ),
  meta_description: z.string().describe('SEO description, 120-155 characters.'),
});

export type Article = z.infer<typeof ArticleSchema>;

/** A record of one successful publish, used to avoid repeating topics. */
export interface PublishRecord {
  publishedAt: string;
  topic: string;
  category: Category;
  title: string;
  slug: string;
  /** The search query this article was written to rank for. */
  targetQuery: string;
  metaTitle: string;
  postId: string;
  url: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}
