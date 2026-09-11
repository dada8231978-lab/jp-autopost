import { relative } from 'node:path';
import { loadConfig } from './config.js';
import { generateDraft } from './generator.js';
import { loadHistory, pickTopic, recentTitles, resolveCategory } from './topics.js';
import { writeNewDraft } from './draft-file.js';
import { countWords } from './html.js';
import { CategorySchema, type Category } from './types.js';

interface CliArgs {
  topic?: string;
  category?: Category;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--topic':
        args.topic = argv[++i];
        break;
      case '--category': {
        const parsed = CategorySchema.safeParse(argv[++i]);
        if (!parsed.success) throw new Error('--category must be "culture" or "healthcare"');
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
Draft a piece for you to rewrite. Publishes nothing.

Usage:
  npm run draft                             Pick the next topic and write drafts/<slug>.md
  npm run draft -- --topic "..."            Use your own topic
  npm run draft -- --category healthcare    Force an area (culture | healthcare)

Then:
  1. Rewrite the draft in your own words
  2. Check every claim in its fact list against a primary source
  3. npm run publish -- drafts/<slug>.md    Checks the draft; add --confirm to publish
`.trim();

/** claude-sonnet-5, USD per million tokens — for the cost line only. */
const PRICE_IN = 2;
const PRICE_OUT = 10;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  const history = await loadHistory();
  const category =
    args.category ?? resolveCategory(config.TOPIC_CATEGORY, config.HEALTHCARE_RATIO, history);
  const topic = args.topic ?? pickTopic(category, history).topic;

  console.log(`Topic : ${topic}`);
  console.log(`Area  : ${category}`);
  console.log(`Model : ${config.ANTHROPIC_MODEL} (effort: ${config.ANTHROPIC_EFFORT})\n`);
  console.log('下書きを作成しています（1分ほどかかります）…');

  const { draft, usage, model } = await generateDraft({
    topic,
    category,
    avoidTitles: recentTitles(history),
  });

  const path = await writeNewDraft(draft, {
    topic,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  const cost = (usage.inputTokens * PRICE_IN + usage.outputTokens * PRICE_OUT) / 1_000_000;
  const shown = relative(process.cwd(), path).replace(/\\/g, '/');

  console.log(`\n下書き: ${shown}`);
  console.log(`  見出し          ${draft.title}`);
  console.log(`  分量            無料 ${countWords(draft.free_section_md)}語 / 有料 ${countWords(draft.paid_body_md)}語`);
  console.log(`  確認すべき事実  ${draft.claims_to_verify.length}件`);
  console.log(`  あなたへの問い  ${draft.author_prompts.length}件`);
  console.log(`  生成コスト      $${cost.toFixed(3)}`);
  console.log('\n次にやること:');
  console.log('  1. ファイルを開き、本文を自分の言葉で書き直す');
  console.log('  2. 「公開前に必ず確認する事実」を一次情報で確かめ、[ ] を [x] にする');
  console.log(`  3. npm run publish -- ${shown}   （公開できる状態か確認。公開は --confirm を付けたときだけ）\n`);
}

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
