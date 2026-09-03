import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { loadConfig } from './config.js';
import { ArticleSchema, type Article, type Category } from './types.js';
import { sanitizeHtml, countWords } from './html.js';

export interface GenerateOptions {
  topic: string;
  category: Category;
  /** Titles to avoid duplicating. */
  avoidTitles?: readonly string[];
  /** Target total word count (free intro + paid body). */
  targetWords?: number;
}

export interface GenerateResult {
  article: Article;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/**
 * Stable system prompt. Kept byte-identical across runs so the prompt-cache
 * prefix hits on every scheduled invocation (~90% cheaper on the cached part).
 */
const SYSTEM_PROMPT = `You are a Tokyo-based journalist writing in English for an international, paying audience. You cover two beats: Japanese culture, and Japanese healthcare and public health.

Your readers are curious, well-educated non-Japanese adults. They have seen the surface-level takes. They are paying money for this article, so it must contain things they could not get from a tourist blog.

WRITING STANDARDS
- Write in clear, concrete English. Prefer specifics over adjectives.
- Every section must carry at least one hard detail: a number, a date, a law, an institution, a named practice, or a concrete scene.
- Explain Japanese terms in-line the first time: romaji, then a short gloss. Do not over-use Japanese words.
- No listicles-as-articles, no "In this article we will explore", no filler transitions, no invented quotes, no fabricated statistics.
- Never present a contested claim as settled. Where evidence is mixed, say so.
- British/American spelling: use American.

ACCURACY RULES (non-negotiable)
- If you are not confident a number is correct, describe the magnitude in words instead of stating a precise figure.
- Do not attribute statements to named living individuals.
- Never cite a specific study, author, or URL you are not certain exists.

HEALTHCARE BEAT — EXTRA RULES
- Write as journalism, not as medical advice.
- Do not recommend treatments, dosages, or self-diagnosis.
- Describe what the Japanese system does and what the evidence says; leave clinical decisions to clinicians.

PAYWALL STRUCTURE AND SEARCH
The article is split at a paywall. Search engines crawl the page as an anonymous visitor, so THEY SEE ONLY free_section_html. Everything below the paywall is invisible to Google. This dictates the structure.

- free_section_html must work as a standalone page that deserves to rank for target_query. Its first sentence answers that query directly and concretely. A searcher who reads only this must leave satisfied, not baited. Then, and only at the end, it opens the deeper question.
- Do NOT withhold the basic answer. A page that poses a question and refuses to answer it ranks badly and reads as a trick. Give away the "what". Sell the "why it works that way, what it costs, and what happens next".
- paid_body_html is the deeper layer: mechanism, tension, consequences, the things a casual search result would never contain. It must open by taking up the question the free section ended on.
- Never say "subscribe", "read more", "in the paid section", or reference the paywall in any way.

Write for a person first. An article that is obviously shaped around a search phrase reads as spam and converts nobody.

HTML RULES
Return HTML fragments only. No markdown, no code fences, no <html>/<body>/<div>/<script>/<style>, no inline style attributes, no class attributes.`;

function buildUserPrompt(opts: Required<Pick<GenerateOptions, 'topic' | 'category'>> & {
  avoidTitles: readonly string[];
  targetWords: number;
}): string {
  const beat =
    opts.category === 'healthcare'
      ? 'Japanese healthcare / public health'
      : 'Japanese culture and society';

  const avoid =
    opts.avoidTitles.length > 0
      ? `\n\nAlready published — do not repeat these angles or reuse these titles:\n${opts.avoidTitles
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '';

  const paidWords = Math.max(600, opts.targetWords - 350);

  return `Beat: ${beat}
Seed topic: ${opts.topic}

Pick ONE specific, non-obvious angle inside that seed topic — a tension, a surprising mechanism, a thing that changed, or a comparison that reframes it. Do not write a general overview of the seed topic.

First decide target_query: the phrase a curious person outside Japan would actually type into Google to land on this angle. Then write so that free_section_html genuinely answers it.

Note on free_section_html: despite the name, it is NOT a short intro or teaser. It is a complete, self-sufficient short article that fully answers target_query. Write all 280-420 words of it. An attempt that produces two or three sentences here will be rejected.

Length targets:
- free_section_html: 280-420 words, 4-5 paragraphs. This is the only part search engines see.
- paid_body_html: about ${paidWords} words, with 3-5 <h2> sections.

Then produce the full structured output.${avoid}`;
}

/**
 * Generate one article with Claude.
 *
 * Uses structured outputs so the response is schema-validated server-side —
 * there is no JSON repair path to maintain.
 */
export async function generateArticle(opts: GenerateOptions): Promise<GenerateResult> {
  const attempts = loadConfig().GENERATION_ATTEMPTS;
  let nudge = '';
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await generateOnce(opts, nudge);
    } catch (error) {
      lastError = error;
      // Only the quality gate is worth retrying; auth and schema failures are
      // deterministic and retrying just burns money.
      if (!(error instanceof QualityGateError) || attempt === attempts) throw error;

      // Tell the model what specifically failed. A generic "it was too short"
      // nudge aimed at the wrong section wastes a whole extra request.
      nudge = error.nudge;
      console.warn(
        `[generator] Attempt ${attempt}/${attempts} rejected: ${error.message} Retrying.`,
      );
    }
  }

  throw lastError;
}

/**
 * Thrown when output is structurally fine but too thin to publish. Carries the
 * corrective instruction for the next attempt.
 */
class QualityGateError extends Error {
  constructor(
    message: string,
    readonly nudge: string,
  ) {
    super(message);
  }
}

const NUDGE_FREE =
  '\n\nCORRECTION — the previous attempt was rejected: free_section_html was too short. ' +
  'It must be 280-420 words across 4-5 full <p> paragraphs. This is the only part search ' +
  'engines can see, so write it out completely: answer target_query in the first sentence, ' +
  'then give three or four paragraphs of real supporting detail. Do not outline or abbreviate it.';

const NUDGE_PAID =
  '\n\nCORRECTION — the previous attempt was rejected: paid_body_html was too short. ' +
  'It must be at least 900 words across 3-5 <h2> sections, fully written out. ' +
  'Do not summarize or outline.';

async function generateOnce(opts: GenerateOptions, nudge: string): Promise<GenerateResult> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const response = await client.messages.parse({
    model: config.ANTHROPIC_MODEL,
    max_tokens: config.ANTHROPIC_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          buildUserPrompt({
            topic: opts.topic,
            category: opts.category,
            avoidTitles: opts.avoidTitles ?? [],
            targetWords: opts.targetWords ?? 1600,
          }) +
          nudge,
      },
    ],
    output_config: {
      effort: config.ANTHROPIC_EFFORT,
      format: zodOutputFormat(ArticleSchema),
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined to generate this article (category: ${
        response.stop_details?.category ?? 'unknown'
      }). Try a different topic.`,
    );
  }

  if (!response.parsed_output) {
    throw new Error(
      `Claude returned no parsable article (stop_reason: ${response.stop_reason}). ` +
        'If stop_reason is "max_tokens", raise ANTHROPIC_MAX_TOKENS.',
    );
  }

  const raw = response.parsed_output;
  const article: Article = {
    ...raw,
    slug: normalizeSlug(raw.slug || raw.title),
    free_section_html: sanitizeHtml(raw.free_section_html),
    paid_body_html: sanitizeHtml(raw.paid_body_html),
    tags: dedupeTags(raw.tags.length > 0 ? raw.tags : fallbackTags(raw.category)),
  };

  assertUsable(article);

  return {
    article,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

function normalizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return slug || `article-${Date.now()}`;
}

/** Last resort so a post is never published completely untagged. */
function fallbackTags(category: Category): string[] {
  return category === 'healthcare'
    ? ['Japanese Healthcare', 'Public Health', 'Japan']
    : ['Japanese Culture', 'Japan', 'Society'];
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const clean = tag.replace(/^#/, '').trim();
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

/** Guard against publishing something structurally broken or too thin to sell. */
function assertUsable(article: Article): void {
  const introWords = countWords(article.free_section_html);
  const bodyWords = countWords(article.paid_body_html);

  // The free section is the only indexable content; thin pages do not rank.
  if (introWords < 200) {
    throw new QualityGateError(
      `Free section too short (${introWords} words) — will not rank and gives search ` +
        'engines nothing to index.',
      NUDGE_FREE,
    );
  }
  if (!article.target_query.trim()) {
    throw new QualityGateError('No target search query was produced.', NUDGE_FREE);
  }
  if (bodyWords < 700) {
    throw new QualityGateError(
      `Paid body too short (${bodyWords} words) — not worth charging for.`,
      NUDGE_PAID,
    );
  }
  if (!article.title.trim()) {
    throw new QualityGateError('Generated article has an empty title.', NUDGE_PAID);
  }
}
