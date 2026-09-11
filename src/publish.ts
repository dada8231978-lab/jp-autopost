import { relative } from 'node:path';
import { loadConfig } from './config.js';
import { ButtondownClient } from './buttondown.js';
import { appendHistory, loadHistory, saveArticle } from './topics.js';
import { archiveDraft, inspectDraft, listDrafts, pct, type DraftInspection } from './draft-file.js';
import { buildBody, filterLiveLinks } from './publisher.js';

/**
 * Publish a draft the author has rewritten and fact-checked.
 *
 * This is the only path to publication, and a human has to walk it: the draft
 * must differ enough from what the model wrote, every factual claim on its
 * checklist must be ticked or removed, and nothing is sent without --confirm.
 * Buttondown's acceptable use policy prohibits prose that is primarily machine
 * generated; these checks are what keep that from happening by accident.
 */

const HELP = `
Check a draft and publish it.

Usage:
  npm run publish                              List drafts and whether each can be published
  npm run publish -- drafts/<slug>.md          Check one draft and show what would be sent
  npm run publish -- drafts/<slug>.md --confirm  Publish it (cannot be undone)

A draft can be published only when:
  - at least MIN_EDIT_RATIO of its words differ from the AI draft
  - every item under "公開前に必ず確認する事実" is ticked [x] or removed
`.trim();

const show = (path: string): string => relative(process.cwd(), path).replace(/\\/g, '/');

function report(d: DraftInspection, minEditRatio: number): void {
  const title = d.parsed?.meta.title ?? '(読み込めません)';
  console.log(`  ${d.ready ? '[公開可] ' : '[未完了] '} ${show(d.path)}`);
  console.log(`             ${title}`);
  if (d.parsed) {
    const change = d.hasBaseline ? `変更率 ${pct(d.editRatio)}（必要 ${pct(minEditRatio)}）` : 'AI下書きなし（一から作成）';
    console.log(`             ${change} / 未確認の事実 ${d.unchecked}件 / 無料 ${d.freeWords}語・有料 ${d.paidWords}語`);
  }
  for (const p of d.problems) console.log(`             - ${p}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  const min = config.MIN_EDIT_RATIO;
  const confirm = argv.includes('--confirm');
  const file = argv.find((a) => !a.startsWith('-'));

  if (!file) {
    const drafts = await listDrafts(min);
    if (drafts.length === 0) {
      console.log('drafts/ に下書きがありません。npm run draft で作成できます。');
      return;
    }
    console.log(`下書き ${drafts.length}件\n`);
    for (const d of drafts) {
      report(d, min);
      console.log();
    }
    return;
  }

  const inspection = await inspectDraft(file, min);
  console.log();
  report(inspection, min);
  console.log();

  const parsed = inspection.parsed;
  if (!inspection.ready || !parsed) {
    console.log('公開できません。上の項目を直してから、もう一度実行してください。');
    process.exitCode = 1;
    return;
  }

  const { meta, free, paid } = parsed;

  const history = await loadHistory();
  const candidates = history
    .filter((h) => h.slug !== meta.slug)
    .reverse()
    .slice(0, config.SEO_RELATED_LINKS * 3)
    .map((h) => ({ title: h.title, url: h.url }));
  const related = await filterLiveLinks(candidates, config.SEO_RELATED_LINKS);

  const body = buildBody({ free, paid, related, category: meta.category });

  if (!confirm) {
    console.log('公開すると、次の内容で送信します。');
    console.log(`  件名        ${meta.title}`);
    console.log(`  slug        ${meta.slug}`);
    console.log(`  説明文      ${meta.meta_description || '(なし)'}`);
    console.log(`  内部リンク  ${related.length}件`);
    console.log(`  医療免責文  ${meta.category === 'healthcare' ? 'あり' : 'なし'}`);
    console.log('\n何も公開していません。公開するには --confirm を付けてください（取り消せません）。');
    return;
  }

  const client = new ButtondownClient(config);
  const { username, subscribers } = await client.verify();
  console.log(`Buttondown: ${username} / 購読者 ${subscribers}人`);

  const created = await client.createEmail({
    subject: meta.title,
    body,
    slug: meta.slug,
    description: meta.meta_description,
  });

  // Creating an email always yields a draft; sending is a separate transition.
  let status = created.status;
  if (status === 'draft') {
    try {
      status = (await client.setEmailStatus(created.id, 'about_to_send')).status;
    } catch (error) {
      console.warn(
        `\n[publish] 記事は作成しましたが、公開状態にできませんでした: ` +
          `${error instanceof Error ? error.message.slice(0, 300) : error}`,
      );
    }
  }

  const url = created.absolute_url ?? '';
  const live = url ? (await filterLiveLinks([{ title: meta.title, url }], 1)).length > 0 : false;

  await appendHistory({
    publishedAt: new Date().toISOString(),
    topic: meta.topic,
    category: meta.category,
    title: meta.title,
    slug: created.slug ?? meta.slug,
    targetQuery: meta.target_query,
    metaTitle: meta.title,
    postId: created.id,
    url,
    model: meta.model,
    usage: { inputTokens: meta.input_tokens, outputTokens: meta.output_tokens },
    editRatio: inspection.editRatio,
  });

  await saveArticle({
    title: meta.title,
    slug: created.slug ?? meta.slug,
    category: meta.category,
    target_query: meta.target_query,
    meta_description: meta.meta_description,
    body_markdown: `${free}\n\n${paid}`,
    tags: meta.tags,
    editRatio: inspection.editRatio,
  });

  let archived = '';
  try {
    archived = show(await archiveDraft(inspection.path));
  } catch {
    // A synced folder can hold the file open; the draft simply stays put.
  }

  console.log(`\n状態       ${status}`);
  console.log(`URL        ${url || '(不明)'}`);
  console.log(`公開ページ ${live ? '確認できました' : 'まだ見えません'}`);
  if (archived) console.log(`下書き     ${archived} に移動`);
  if (!live) {
    console.log(
      '\n公開ページが見えない場合、Buttondown アカウントが承認されていない可能性があります。' +
        '\nnpm run status でニュースレター全体が 404 になっていないか確認してください。',
    );
  }
  console.log('\n履歴を残すには:  git add data/history data/articles && git commit -m "record published article"');
}

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
