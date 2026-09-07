import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { generateArticle } from './generator.js';
import { Publisher, buildPostHtml, type RelatedLink } from './publisher.js';
import {
  appendHistory,
  loadHistory,
  pickTopic,
  recentTitles,
  resolveCategory,
  saveArticle,
} from './topics.js';
import { countWords } from './html.js';
import { CategorySchema, type Category } from './types.js';

interface CliArgs {
  dryRun: boolean;
  topic?: string;
  category?: Category;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dryRun: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--topic':
        args.topic = argv[++i];
        break;
      case '--category': {
        const parsed = CategorySchema.safeParse(argv[++i]);
        if (!parsed.success) {
          throw new Error('--category must be "culture" or "healthcare"');
        }
        args.category = parsed.data;
        break;
      }
      default:
        if (arg?.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return args;
}

const HELP = `
Generate one English article about Japan and publish it to Buttondown behind a paywall.

Usage:
  npm run post                            Generate + publish using .env settings
  npm run dry-run                         Generate only; write an HTML preview, publish nothing
  npm run verify                          Check the Buttondown connection and show the economics
  npx tsx src/index.ts --topic "..."      Override the seed topic
  npx tsx src/index.ts --category culture Force a beat (culture | healthcare)

Flags:
  --dry-run          Do not touch Buttondown. Writes data/preview-<slug>.html
  --topic <text>     Seed topic instead of picking from the rotation
  --category <name>  culture | healthcare
  -h, --help         Show this help
`.trim();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  const startedAt = Date.now();

  // ---- 1. Choose the topic -------------------------------------------------
  const history = await loadHistory();
  const category =
    args.category ?? resolveCategory(config.TOPIC_CATEGORY, config.HEALTHCARE_RATIO, history);
  const topic = args.topic ?? pickTopic(category, history).topic;

  console.log(`[1/4] Topic  : ${topic}`);
  console.log(
    `      Beat   : ${category}` +
      (config.TOPIC_CATEGORY === 'mixed'
        ? ` (target ${Math.round(config.HEALTHCARE_RATIO * 100)}% healthcare)`
        : ''),
  );
  console.log(`      Model  : ${config.ANTHROPIC_MODEL} (effort: ${config.ANTHROPIC_EFFORT})`);

  // ---- 2. Verify Buttondown before spending on generation -------------------
  let publisher: Publisher | undefined;

  if (!args.dryRun) {
    publisher = new Publisher(config);
    const who = await publisher.verifyConnection();
    console.log(`[2/4] Buttondown: ${who}`);
    console.log(
      `      Posting as status="${config.BUTTONDOWN_EMAIL_STATUS}", ` +
        `audience="${config.BUTTONDOWN_EMAIL_TYPE}"`,
    );
  } else {
    console.log('[2/4] Buttondown: skipped (--dry-run)');
  }

  // ---- 3. Generate ---------------------------------------------------------
  const { article, usage, model } = await generateArticle({
    topic,
    category,
    avoidTitles: recentTitles(history),
    targetWords: config.TARGET_WORD_COUNT,
  });

  const freeWords = countWords(article.free_section_html);
  const paidWords = countWords(article.paid_body_html);
  // Internal links to earlier archive pages, newest first. These go above the
  // paywall so crawlers can actually follow them.
  const related: RelatedLink[] = history
    .filter((h) => /^https?:\/\//.test(h.url) && h.slug !== article.slug)
    .slice(-config.SEO_RELATED_LINKS)
    .reverse()
    .map((h) => ({ title: h.title, url: h.url }));

  console.log(`[3/4] Title  : ${article.title}`);
  console.log(`      Query  : "${article.target_query}"`);
  console.log(`      Links  : ${related.length} internal (above paywall)`);
  console.log(`      Words  : ${freeWords} free + ${paidWords} paid`);
  console.log(`      Tags   : ${article.tags.join(', ')}`);
  console.log(`      Tokens : ${usage.inputTokens} in / ${usage.outputTokens} out`);

  // Persist the body so `npm run reddit` can work from it later.
  await saveArticle(article);

  // ---- 4. Publish (or preview) ---------------------------------------------
  if (args.dryRun || !publisher) {
    const previewPath = resolve(process.cwd(), `data/preview-${article.slug}.html`);
    await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
    await writeFile(
      previewPath,
      renderPreview(article.title, buildPostHtml(article, related)),
      'utf8',
    );
    console.log(`[4/4] Preview: ${previewPath}`);
    console.log('      Nothing was published (--dry-run).');
    return;
  }

  const result = await publisher.publish(article, related);
  console.log(`[4/4] Posted : ${result.url}`);
  console.log(`      Status : ${result.status}`);
  if (result.status === 'draft') {
    console.log('      This is a DRAFT. Open Buttondown and hit send when you are happy with it.');
  }

  await appendHistory({
    publishedAt: new Date().toISOString(),
    topic,
    category,
    title: result.subject,
    slug: result.slug,
    targetQuery: article.target_query,
    metaTitle: article.meta_title,
    postId: result.id,
    url: result.url,
    model,
    usage,
  });

  console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

/** Wrap the post HTML in a minimal page so the preview is readable in a browser. */
function renderPreview(title: string, html: string): string {
  const marked = html.replace(
    '<div role="paywall"></div>',
    '<hr style="border:none;border-top:3px dashed #c00;margin:2.5rem 0"><p style="color:#c00;font-weight:700">▼ PAYWALL — everything below is paid-only ▼</p>',
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{max-width:44rem;margin:3rem auto;padding:0 1.25rem;font:17px/1.7 Georgia,serif;color:#222}h1{font-size:2rem;line-height:1.25}h2{margin-top:2.5rem}</style>
</head><body><h1>${title}</h1>
${marked}
</body></html>`;
}

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
