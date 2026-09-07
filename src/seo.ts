import { loadConfig } from './config.js';
import { loadHistory } from './topics.js';
import type { PublishRecord } from './types.js';

/** Google truncates titles around here; descriptions around 155. */
const TITLE_MAX = 60;
const DESC_MIN = 120;
const DESC_MAX = 155;

interface Issue {
  slug: string;
  problem: string;
}

/**
 * Report on the searchable surface of everything published so far.
 *
 * Reads only local history - it does not crawl or call any search API, so it
 * cannot tell you rankings. It tells you whether the pages are structurally
 * capable of ranking, which is the part you control.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const history = await loadHistory();

  if (history.length === 0) {
    console.log('Nothing published yet. Run `npm run post` first.');
    return;
  }

  console.log(`${history.length} published article(s)\n`);

  const issues: Issue[] = [];
  const queries = new Map<string, string[]>();

  for (const record of history) {
    const query = (record.targetQuery ?? '').trim();
    const metaTitle = (record.metaTitle ?? '').trim();

    console.log(`${record.slug}`);
    console.log(`  query : ${query || '(not recorded — published before SEO fields existed)'}`);
    console.log(`  title : ${metaTitle || record.title} (${(metaTitle || record.title).length} chars)`);
    console.log(`  url   : ${record.url}`);

    if (!/^https?:\/\//.test(record.url)) {
      issues.push({
        slug: record.slug,
        problem: 'No archive URL recorded — it cannot be linked to internally.',
      });
    }
    if (metaTitle && metaTitle.length > TITLE_MAX) {
      issues.push({
        slug: record.slug,
        problem: `Meta title is ${metaTitle.length} chars; Google truncates past ~${TITLE_MAX}.`,
      });
    }
    if (query) {
      const bucket = queries.get(query.toLowerCase()) ?? [];
      bucket.push(record.slug);
      queries.set(query.toLowerCase(), bucket);
    }
    console.log();
  }

  // Two articles chasing one query split their own authority and compete with
  // each other in the index.
  for (const [query, slugs] of queries) {
    if (slugs.length > 1) {
      issues.push({
        slug: slugs.join(', '),
        problem: `${slugs.length} articles target the same query "${query}" — they cannibalize each other.`,
      });
    }
  }

  console.log('---');
  console.log(`Internal links per article : ${config.SEO_RELATED_LINKS} (above the paywall)`);
  console.log(
    `Link graph                 : ${Math.min(history.length - 1, config.SEO_RELATED_LINKS) * history.length} approximate crawlable edges`,
  );

  if (issues.length === 0) {
    console.log('\nNo structural issues found.');
  } else {
    console.log(`\n${issues.length} issue(s):`);
    for (const issue of issues) console.log(`  [${issue.slug}] ${issue.problem}`);
  }

  console.log(
    '\nWhat this tool cannot do: it does not measure rankings or traffic.\n' +
      'Connect the archive domain to Google Search Console to see real queries,\n' +
      'impressions, and which pages actually get clicks.',
  );

  if (DESC_MIN && DESC_MAX) {
    // Referenced so the constants document the intended range in one place.
    console.log(`Target meta description length: ${DESC_MIN}-${DESC_MAX} characters.`);
  }
}

export type { PublishRecord };

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
