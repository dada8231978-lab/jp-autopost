import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(10, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(16000),

  // How many times to retry when generated output fails the quality gate.
  // Unattended daily runs should not lose a whole day to one short response.
  GENERATION_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),

  // Buttondown. Validated lazily by assertButtondownConfig() so `--dry-run`,
  // which never touches Buttondown, works before the account is set up.
  BUTTONDOWN_API_KEY: z.string().default(''),
  BUTTONDOWN_API_BASE: z.string().default('https://api.buttondown.com/v1'),

  // draft            -> saved for review, nothing is sent (safe default)
  // about_to_send    -> queued and sent immediately
  // scheduled        -> requires publish_date; not used by this tool
  BUTTONDOWN_EMAIL_STATUS: z.string().default('draft'),

  // Paywalled emails must go to the public audience: everyone receives the
  // email, and the paywall decides how much of it each reader can see.
  BUTTONDOWN_EMAIL_TYPE: z.string().default('public'),

  // auto     -> let Buttondown detect HTML vs Markdown (our body is HTML)
  // fancy    -> force rich HTML mode
  // plaintext-> force Markdown mode
  BUTTONDOWN_EDITOR_MODE: z.enum(['auto', 'fancy', 'plaintext']).default('auto'),

  // Display only. The real price is set in Buttondown -> Settings -> Paid
  // subscriptions; the API does not manage pricing.
  SUBSCRIPTION_PRICE_CENTS: z.coerce.number().int().positive().default(500),
  SUBSCRIPTION_CURRENCY: z.string().length(3).default('usd'),

  // Reddit. Optional - only needed for `npm run reddit`.
  // Create a "script" app at https://www.reddit.com/prefs/apps
  REDDIT_CLIENT_ID: z.string().default(''),
  REDDIT_CLIENT_SECRET: z.string().default(''),
  REDDIT_USERNAME: z.string().default(''),
  REDDIT_PASSWORD: z.string().default(''),
  REDDIT_USER_AGENT: z.string().default(''),

  // Comma-separated rotation. The tool posts to whichever eligible subreddit
  // has gone longest without a post, which spreads activity and keeps any one
  // community from seeing a repeating pattern.
  REDDIT_SUBREDDITS: z.string().default('foodforthought,TrueReddit,japan'),

  // Minimum days between posts to the same subreddit. Frequency is what
  // separates a contributor from a spammer.
  REDDIT_MIN_DAYS_BETWEEN: z.coerce.number().min(0).default(14),

  REDDIT_INCLUDE_LINK: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  REDDIT_LINK_URL: z.string().default(''),
  REDDIT_FLAIR_ID: z.string().default(''),
  REDDIT_FLAIR_TEXT: z.string().default(''),

  // Number of crawlable internal links to earlier articles, placed above the
  // paywall. 0 disables. More than ~5 starts to read as a link farm.
  SEO_RELATED_LINKS: z.coerce.number().int().min(0).max(5).default(3),

  // Topics
  TOPIC_CATEGORY: z.enum(['culture', 'healthcare', 'mixed']).default('mixed'),
  TARGET_WORD_COUNT: z.coerce.number().int().min(600).max(4000).default(1600),
});

export type Config = z.infer<typeof EnvSchema> & { redditSubreddits: string[] };

let cached: Config | null = null;

/**
 * Parse and validate the environment once. Throws a readable, aggregated error
 * so a misconfigured cron run fails loudly instead of half-publishing.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration. Check your .env file:\n${issues}`);
  }

  cached = {
    ...parsed.data,
    redditSubreddits: parsed.data.REDDIT_SUBREDDITS.split(',')
      .map((s) => s.trim().replace(/^\/?r\//, ''))
      .filter(Boolean),
  };
  return cached;
}

/**
 * Validate the Buttondown half of the config. Called only on paths that
 * actually talk to Buttondown, so generation and previews work without it.
 */
export function assertButtondownConfig(config: Config): void {
  const key = config.BUTTONDOWN_API_KEY.trim();

  if (!key) {
    throw new Error(
      'BUTTONDOWN_API_KEY is empty.\n' +
        '  Get it from Buttondown -> Settings -> Programming -> API key.\n\n' +
        'Run `npm run dry-run` to generate and preview an article without Buttondown.',
    );
  }

  if (key.startsWith('sk-ant-')) {
    throw new Error(
      'BUTTONDOWN_API_KEY looks like an Anthropic key (sk-ant-...).\n' +
        '  That value belongs in ANTHROPIC_API_KEY. Paste the Buttondown API key here instead.',
    );
  }
}
