import { z } from 'zod';

/** Topic area for a piece. */
export const CategorySchema = z.enum(['culture', 'healthcare']);
export type Category = z.infer<typeof CategorySchema>;

/**
 * What the model returns: raw material for a human author, not an article.
 *
 * The prose is a starting point the author rewrites. The claims list and the
 * questions exist so the author has to engage with the substance — checking
 * each factual claim and adding what only they can — before anything goes out
 * under their name.
 */
export const DraftSchema = z.object({
  title: z
    .string()
    .describe('Working headline, 50-70 characters, no clickbait, no emoji. The author will likely rewrite it.'),
  slug: z
    .string()
    .describe('URL slug: lowercase ASCII words separated by hyphens, max 60 chars.'),
  category: CategorySchema.describe('Which of the two areas this piece belongs to.'),
  target_query: z
    .string()
    .describe(
      'The search query this piece answers, written the way a real person outside Japan would ' +
        'type it into Google. Lowercase, 4-9 words.',
    ),
  meta_description: z.string().describe('Search result description, 120-155 characters.'),
  free_section_md: z
    .string()
    .describe(
      'The free section, shown above the paywall and the only part search engines see. ' +
        '280-420 words of Markdown paragraphs, no headings. The first sentence answers ' +
        'target_query directly; the last paragraph opens the deeper question.',
    ),
  paid_body_md: z
    .string()
    .describe(
      'The paid section. 800-1200 words of Markdown with 3-5 "## " section headings. Opens by ' +
        'taking up the question the free section ended on.',
    ),
  claims_to_verify: z
    .array(z.string())
    .describe(
      'Every specific factual claim in either section — numbers, dates, laws, policies, named ' +
        'institutions, causal claims — each phrased as the claim itself, so the author can check ' +
        'it against a primary source.',
    ),
  author_prompts: z
    .array(z.string())
    .describe(
      '3-5 questions to the author pointing at places where their own knowledge, experience or ' +
        'judgement would add something this draft cannot. Specific to this piece, not generic ' +
        'writing advice.',
    ),
  suggested_sources: z
    .array(z.string())
    .describe(
      'Kinds of primary source the author should check: official bodies, statistical series, ' +
        'laws, government reports. Names only — no URLs and no specific papers or articles, ' +
        'which may not exist.',
    ),
  tags: z.array(z.string()).describe('3-6 English topic tags in Title Case.'),
});

export type Draft = z.infer<typeof DraftSchema>;

/** The version the author actually published, kept for later tools. */
export interface StoredArticle {
  title: string;
  slug: string;
  category: Category;
  target_query: string;
  meta_description: string;
  /** Free and paid sections as published, in Markdown. */
  body_markdown: string;
  tags: string[];
  /** Share of words that differed from the AI draft when it was published. */
  editRatio: number;
}

/** A record of one publish, used for topic rotation and internal links. */
export interface PublishRecord {
  publishedAt: string;
  topic: string;
  category: Category;
  title: string;
  slug: string;
  /** The search query this article was written to answer. */
  targetQuery: string;
  metaTitle: string;
  postId: string;
  url: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Absent on records written before publishing required a human edit. */
  editRatio?: number;
}
