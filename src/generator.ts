import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { loadConfig } from './config.js';
import { DraftSchema, type Category, type Draft } from './types.js';
import { countWords } from './html.js';

export interface GenerateOptions {
  topic: string;
  category: Category;
  /** Titles already published, so the draft takes a different angle. */
  avoidTitles?: readonly string[];
}

export interface GenerateResult {
  draft: Draft;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/**
 * Stable system prompt, kept byte-identical across runs so the cached prefix
 * is reused.
 *
 * The model is cast as a research assistant preparing material for an author,
 * not as the author. Writing in a first-person persona invites invented
 * experience, and the output is meant to be rewritten, not published.
 */
const SYSTEM_PROMPT = `You prepare first drafts and research notes for an author who writes in English about Japan for an international readership. The author covers two areas: Japanese culture, and Japanese healthcare and public health.

WHAT YOU PRODUCE
A working draft that the author will substantially rewrite in their own voice, check against primary sources, and publish under their own name. It is raw material, not a finished article. Your most useful output is often the claims list and the questions to the author, not the prose.

VOICE AND HONESTY
- Do not write as the author. No first-person experience, no "when I lived in Tokyo", no invented anecdotes, no scenes presented as observed, no quotes.
- Do not invent credentials, sources, studies, statistics or URLs.
- If you are not confident a number is correct, describe the magnitude in words.
- Never present a contested claim as settled. Where evidence is mixed, say so.

CLAIMS
Every specific factual statement in the draft — a number, a date, a law or policy, a named institution, a causal claim — must also appear in claims_to_verify, phrased as the claim itself, so the author can check each one before publishing.

HEALTHCARE
- Journalism about systems and evidence, not medical advice.
- No treatment, dosage or self-diagnosis recommendations.

STRUCTURE
The piece is split at a paywall, and search engines see only the free section.
- free_section_md: a complete short piece that genuinely answers target_query. Its first sentence answers it directly. It ends by opening the deeper question.
- paid_body_md: the deeper layer — mechanism, tension, consequences. It opens by taking up that question.
- Never mention subscribing, paywalls, or "read more".

FORMAT
Markdown only. "## " for section headings in paid_body_md. Plain paragraphs. No HTML, no code fences, no tables.`;

function buildUserPrompt(opts: GenerateOptions): string {
  const area =
    opts.category === 'healthcare'
      ? 'Japanese healthcare / public health'
      : 'Japanese culture and society';

  const avoid =
    opts.avoidTitles && opts.avoidTitles.length > 0
      ? `\n\nAlready published — take a different angle and do not reuse these titles:\n${opts.avoidTitles
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '';

  return `Area: ${area}
Seed topic: ${opts.topic}

Pick ONE specific, non-obvious angle inside the seed topic — a tension, a surprising mechanism, something that changed, or a comparison that reframes it. Do not write a general overview.

First decide target_query: what a curious person outside Japan would type into Google to land on this angle. Then draft so the free section genuinely answers it.

Lengths:
- free_section_md: 280-420 words.
- paid_body_md: 800-1200 words with 3-5 "## " headings.${avoid}`;
}

/** Thrown when output is well-formed but too thin to be useful to the author. */
class QualityGateError extends Error {
  constructor(
    message: string,
    readonly nudge: string,
  ) {
    super(message);
  }
}

const NUDGE_FREE =
  '\n\nCORRECTION — the previous attempt was rejected: free_section_md was too short. ' +
  'Write all 280-420 words: answer target_query in the first sentence, then give real supporting detail.';

const NUDGE_PAID =
  '\n\nCORRECTION — the previous attempt was rejected: paid_body_md was too short. ' +
  'Write at least 800 words across 3-5 "## " sections, fully, not as an outline.';

const NUDGE_CLAIMS =
  '\n\nCORRECTION — the previous attempt was rejected: claims_to_verify was nearly empty. ' +
  'List every specific factual claim the draft makes, one per item.';

export async function generateDraft(opts: GenerateOptions): Promise<GenerateResult> {
  const attempts = loadConfig().GENERATION_ATTEMPTS;
  let nudge = '';
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await generateOnce(opts, nudge);
    } catch (error) {
      lastError = error;
      // Only the quality gate is worth retrying; auth and schema failures are
      // deterministic and retrying just spends money.
      if (!(error instanceof QualityGateError) || attempt === attempts) throw error;
      nudge = error.nudge;
      console.warn(`[generator] Attempt ${attempt}/${attempts} rejected: ${error.message} Retrying.`);
    }
  }

  throw lastError;
}

async function generateOnce(opts: GenerateOptions, nudge: string): Promise<GenerateResult> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const response = await client.messages.parse({
    model: config.ANTHROPIC_MODEL,
    max_tokens: config.ANTHROPIC_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt(opts) + nudge }],
    output_config: {
      effort: config.ANTHROPIC_EFFORT,
      format: zodOutputFormat(DraftSchema),
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined to draft this topic (category: ${response.stop_details?.category ?? 'unknown'}). ` +
        'Try a different topic.',
    );
  }

  if (!response.parsed_output) {
    throw new Error(
      `Claude returned no parsable draft (stop_reason: ${response.stop_reason}). ` +
        'If stop_reason is "max_tokens", raise ANTHROPIC_MAX_TOKENS.',
    );
  }

  const raw = response.parsed_output;
  const draft: Draft = {
    ...raw,
    slug: normalizeSlug(raw.slug || raw.title),
    free_section_md: cleanMarkdown(raw.free_section_md),
    paid_body_md: cleanMarkdown(raw.paid_body_md),
    tags: dedupeTags(raw.tags.length > 0 ? raw.tags : fallbackTags(raw.category)),
  };

  assertUsable(draft);

  return {
    draft,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

function cleanMarkdown(value: string): string {
  return value
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
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
  return slug || `draft-${Date.now()}`;
}

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

function assertUsable(draft: Draft): void {
  const freeWords = countWords(draft.free_section_md);
  const paidWords = countWords(draft.paid_body_md);

  if (freeWords < 200) {
    throw new QualityGateError(`Free section too short (${freeWords} words).`, NUDGE_FREE);
  }
  if (paidWords < 600) {
    throw new QualityGateError(`Paid section too short (${paidWords} words).`, NUDGE_PAID);
  }
  if (draft.claims_to_verify.length < 3) {
    throw new QualityGateError(
      `Only ${draft.claims_to_verify.length} claims listed for verification.`,
      NUDGE_CLAIMS,
    );
  }
}
