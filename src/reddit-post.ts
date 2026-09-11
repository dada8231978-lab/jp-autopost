import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { loadConfig, type Config } from './config.js';
import { RedditClient } from './reddit.js';
import { loadArticle, latestArticleSlug } from './topics.js';
import { countWords } from './html.js';
import type { StoredArticle } from './types.js';

const HISTORY_PATH = resolve(process.cwd(), 'data/reddit-posts.json');

interface RedditRecord {
  postedAt: string;
  subreddit: string;
  slug: string;
  title: string;
  url: string;
  mode: 'draft' | 'submit';
}

const RedditPostSchema = z.object({
  title: z
    .string()
    .describe(
      'Reddit post title, under 280 characters. Plain, specific, no clickbait, no emoji, ' +
        'no "I wrote about", no colon-subtitle marketing format. Written the way a regular ' +
        'user posts something they found interesting.',
    ),
  body: z
    .string()
    .describe(
      'Reddit self-post body in Markdown, 250-450 words. It must be a complete, satisfying ' +
        'read ON ITS OWN - a reader who never clicks anything should still have learned ' +
        'something concrete. Do not tease. Do not say "read more". Do not summarize an ' +
        'article; write a Reddit post. End with an open question inviting people who live ' +
        'in Japan to add their own experience.',
    ),
  discussion_prompt: z
    .string()
    .describe('One sentence: the question the post ends on, to check it invites replies.'),
});

type RedditPost = z.infer<typeof RedditPostSchema>;

const SYSTEM_PROMPT = `You draft Reddit posts for an author to rewrite in their own words and post under their own name. Do not invent a persona or personal experience, and do not claim to live anywhere; write plainly about the material.

Reddit punishes promotional writing harder than any other platform. A post that reads like content marketing gets downvoted, reported, and removed, and repeat offences get the account and the linked domain banned site-wide. So the post you write must earn its place on its own merits.

HARD RULES
- The post must stand alone. Someone who reads it and clicks nothing must feel they got the whole thing.
- Never tease withheld information. No "the full story", no "I dug into this", no "more on my site".
- No marketing voice. No em-dash-heavy listicle rhythm. No "Here's why that matters."
- Write like a Reddit comment that got long: direct, specific, slightly informal, no headings unless genuinely useful.
- Lead with the most concrete or surprising fact, not with context-setting.
- Include real specifics: numbers, years, named policies, concrete scenes.
- Do not fabricate statistics or cite studies you are not certain exist. Describe magnitude in words when unsure.
- End with a real question that people living in Japan can answer from experience.
- Never mention a newsletter, subscription, paywall, or the word "article".`;

export async function generateRedditPost(
  article: StoredArticle,
  subreddit: string,
): Promise<RedditPost> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  // Articles published before the draft workflow stored HTML sections instead.
  const legacy = article as unknown as { free_section_html?: string; paid_body_html?: string };
  const source = (
    article.body_markdown ?? `${legacy.free_section_html ?? ''}
${legacy.paid_body_html ?? ''}`
  ).replace(/<[^>]+>/g, ' ');

  const response = await client.messages.parse({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content:
          `Target subreddit: r/${subreddit}\n\n` +
          'Below is research material. Pick the ONE most interesting thread in it and write a ' +
          'self-contained Reddit post about that. Ignore everything else. Do not try to cover ' +
          'the whole thing.\n\n' +
          '--- MATERIAL ---\n' +
          source.replace(/\s+/g, ' ').slice(0, 12000),
      },
    ],
    output_config: {
      effort: config.ANTHROPIC_EFFORT,
      format: zodOutputFormat(RedditPostSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error(`Claude returned no usable Reddit post (stop_reason: ${response.stop_reason}).`);
  }

  const post = response.parsed_output;
  const cleaned: RedditPost = {
    ...post,
    title: normalize(post.title),
    body: normalize(post.body),
  };
  assertNotPromotional(cleaned);
  return cleaned;
}

/**
 * Strip full-width spaces and stray whitespace. Japanese-language source
 * material leaks U+3000 into the output, which renders as a visible gap on
 * Reddit and reads as machine-generated.
 */
function normalize(text: string): string {
  return text
    .replace(/　/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Last-line defence. If the model slipped into marketing voice, do not post -
 * a single spammy post is what starts a domain ban.
 */
function assertNotPromotional(post: RedditPost): void {
  const banned = [
    /read (the )?(full|more|rest)/i,
    /subscribe/i,
    /newsletter/i,
    /my (article|blog|post|site|substack)/i,
    /check (it|this) out/i,
    /link in (the )?(comments|bio)/i,
    /paywall/i,
  ];

  const text = `${post.title}\n${post.body}`;
  const hit = banned.find((re) => re.test(text));
  if (hit) {
    throw new Error(
      `Generated Reddit post contains promotional language (${hit}). Refusing to post. ` +
        'Re-run to generate a different draft.',
    );
  }

  const words = countWords(post.body);
  if (words < 150) {
    throw new Error(`Reddit post is only ${words} words - too thin to contribute anything.`);
  }
}

// ---------------------------------------------------------------------------
// History and spacing guard
// ---------------------------------------------------------------------------

async function loadRedditHistory(): Promise<RedditRecord[]> {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RedditRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function appendRedditHistory(record: RedditRecord): Promise<void> {
  const history = await loadRedditHistory();
  history.push(record);
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

/**
 * Refuse to post to a subreddit again inside the configured window.
 *
 * This is the single most important guard in this file: frequency is what
 * separates a contributor from a spammer, in both the moderators' eyes and
 * Reddit's automated spam detection.
 */
async function daysSinceLastPost(subreddit: string): Promise<number> {
  const history = await loadRedditHistory();
  const last = history
    .filter((r) => r.subreddit.toLowerCase() === subreddit.toLowerCase() && r.mode === 'submit')
    .at(-1);

  return last ? (Date.now() - Date.parse(last.postedAt)) / 86_400_000 : Infinity;
}

async function assertSpacing(config: Config, subreddit: string): Promise<void> {
  const daysSince = await daysSinceLastPost(subreddit);
  const required = config.REDDIT_MIN_DAYS_BETWEEN;

  if (daysSince < required) {
    throw new Error(
      `Last post to r/${subreddit} was ${daysSince.toFixed(1)} days ago; ` +
        `REDDIT_MIN_DAYS_BETWEEN is ${required}.\n` +
        '  Posting more often than this is what gets accounts and domains banned. ' +
        'Wait, pick another subreddit, or lower the setting deliberately.',
    );
  }
}

/**
 * Pick the eligible subreddit that has gone longest without a post.
 *
 * Rotating matters for two reasons: no single community sees a repeating
 * pattern, and different subreddits reach different audiences. Posting the
 * same thing everywhere at once is the fastest route to a site-wide ban.
 */
async function pickSubreddit(config: Config): Promise<string> {
  const candidates = config.redditSubreddits;
  if (candidates.length === 0) {
    throw new Error('REDDIT_SUBREDDITS is empty. Set at least one subreddit in .env.');
  }

  const scored = await Promise.all(
    candidates.map(async (sub) => ({ sub, days: await daysSinceLastPost(sub) })),
  );

  const eligible = scored.filter((s) => s.days >= config.REDDIT_MIN_DAYS_BETWEEN);
  if (eligible.length === 0) {
    const soonest = scored.reduce((a, b) => (a.days > b.days ? a : b));
    const waitDays = config.REDDIT_MIN_DAYS_BETWEEN - soonest.days;
    throw new Error(
      `Every subreddit in the rotation was posted to too recently.\n` +
        `  Next available: r/${soonest.sub} in ${waitDays.toFixed(1)} days.\n` +
        '  Add more subreddits to REDDIT_SUBREDDITS, or wait.',
    );
  }

  // Oldest first; never-posted (Infinity) wins.
  eligible.sort((a, b) => b.days - a.days);
  return eligible[0]!.sub;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
Turn a published article into a Reddit-native text post.

Usage:
  npm run reddit                        Write a draft to data/reddit/ (submits nothing)
  npm run reddit -- --submit            Actually submit to Reddit
  npm run reddit -- --sub japanlife     Choose the subreddit
  npm run reddit -- --slug <slug>       Use a specific saved article
  npm run reddit -- --flairs japan      List a subreddit's post flairs and exit
  npm run reddit -- --whoami            Show the bot account's karma and age

Draft mode is the default on purpose. Read what it wrote before you post it.
`.trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const submit = argv.includes('--submit');
  const explicitSub = valueOf('--sub')?.replace(/^\/?r\//, '');

  if (argv.includes('--whoami')) {
    const me = await new RedditClient(config).me();
    console.log(`u/${me.name}`);
    console.log(`  account age  : ${me.ageDays} days`);
    console.log(`  link karma   : ${me.linkKarma}`);
    console.log(`  comment karma: ${me.commentKarma}`);
    if (me.ageDays < 30 || me.commentKarma < 50) {
      console.warn(
        '\n  WARNING: new or low-karma accounts are auto-filtered by most large subreddits.\n' +
          '  Participate normally for a few weeks before posting your own links.',
      );
    }
    return;
  }

  const flairSub = valueOf('--flairs');
  if (flairSub) {
    const flairs = await new RedditClient(config).flairs(flairSub.replace(/^r\//, ''));
    if (flairs.length === 0) {
      console.log(`r/${flairSub} exposes no post flairs (or they are moderator-only).`);
      return;
    }
    for (const f of flairs) console.log(`${f.id}  ${f.text}`);
    return;
  }

  const slug = valueOf('--slug') ?? (await latestArticleSlug());
  if (!slug) {
    throw new Error(
      'No saved article found. Run `npm run post` or `npm run dry-run` first — ' +
        'article bodies are saved to data/articles/.',
    );
  }

  const subreddit = explicitSub ?? (await pickSubreddit(config));

  const article = await loadArticle(slug);
  console.log(`[1/3] Source  : ${article.title}`);
  console.log(
    `      Target  : r/${subreddit}` +
      (explicitSub ? ' (explicit)' : ` (rotation: ${config.redditSubreddits.join(', ')})`),
  );

  if (submit) await assertSpacing(config, subreddit);

  const post = await generateRedditPost(article, subreddit);
  console.log(`[2/3] Title   : ${post.title}`);
  console.log(`      Words   : ${countWords(post.body)}`);

  let body = post.body;
  if (config.REDDIT_INCLUDE_LINK && config.REDDIT_LINK_URL.trim()) {
    // Transparent, single, clearly-labelled link. Undisclosed self-links are
    // what moderators treat as spam.
    body += `\n\n---\n\n^(I write about Japan at ${config.REDDIT_LINK_URL.trim()} — sharing this here because I thought it was interesting, not to sell anything.)`;
  }

  if (!submit) {
    const path = resolve(process.cwd(), `data/reddit/${subreddit}-${slug}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# ${post.title}\n\n${body}\n`, 'utf8');
    console.log(`[3/3] Draft   : ${path}`);
    console.log('      Nothing was submitted. Read it, then re-run with --submit.');
    await appendRedditHistory({
      postedAt: new Date().toISOString(),
      subreddit,
      slug,
      title: post.title,
      url: path,
      mode: 'draft',
    });
    return;
  }

  const client = new RedditClient(config);
  const result = await client.submitSelfPost({
    subreddit,
    title: post.title,
    text: body,
    flairId: config.REDDIT_FLAIR_ID.trim() || undefined,
    flairText: config.REDDIT_FLAIR_TEXT.trim() || undefined,
  });

  console.log(`[3/3] Posted  : ${result.url}`);

  await appendRedditHistory({
    postedAt: new Date().toISOString(),
    subreddit,
    slug,
    title: post.title,
    url: result.url,
    mode: 'submit',
  });
}

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
