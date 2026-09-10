import { loadConfig } from './config.js';
import { ButtondownClient, type ButtondownEmail } from './buttondown.js';

/**
 * Publish articles that were created but never sent.
 *
 * Every email the API creates lands as a draft, whatever `status` the create
 * call asked for, and a draft has no public archive page — its URL 404s. So an
 * article that the daily job reports as published is invisible until something
 * moves it out of draft. Until now that something was a human clicking send in
 * the Buttondown UI, which is not automation.
 *
 * Separating publish from create also makes the dangerous half explicit: this
 * is the command that makes writing public, so it refuses to act without
 * --confirm and shows exactly what it would touch first.
 */

const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 5000;

/** States that mean the article is on its way out or already out. */
const PUBLISHED = new Set(['sent', 'about_to_send', 'in_flight', 'scheduled', 'throttled']);

const HELP = `
Publish articles that are still sitting as drafts.

Usage:
  npm run publish              List the drafts and what would happen (no changes)
  npm run publish -- --confirm Actually publish them
  npm run publish -- --limit 1 Only the oldest N drafts

A draft has no public archive page, so an unpublished article is invisible to
readers and to search engines no matter what the workflow reported.
`.trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return;
  }

  const confirm = argv.includes('--confirm');
  const limitFlag = argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : Infinity;

  const config = loadConfig();
  const client = new ButtondownClient(config);

  const { subscribers } = await client.verify();
  const emails = await client.listEmails();
  const drafts = emails.filter((e) => e.status === 'draft').slice(0, limit);

  if (drafts.length === 0) {
    console.log('公開待ちの下書きはありません。');
    return;
  }

  console.log(`公開待ち: ${drafts.length}件  /  購読者: ${subscribers}人\n`);
  for (const d of drafts) {
    console.log(`  ${d.subject}`);
    console.log(`    ${d.absolute_url ?? '(URL不明)'}`);
  }

  if (!confirm) {
    console.log(
      `\n何も変更していません。実行するには --confirm を付けてください。\n` +
        (subscribers === 0
          ? '  購読者0人なのでメールは誰にも届きません。効果はアーカイブページの公開のみです。\n'
          : `  警告: ${subscribers}人の購読者にメールが届きます。\n`),
    );
    return;
  }

  console.log();
  let published = 0;

  for (const draft of drafts) {
    process.stdout.write(`${draft.subject.slice(0, 45)} ... `);

    try {
      const updated = await client.setEmailStatus(draft.id, 'about_to_send');
      const settled = await waitForStatus(client, draft.id, updated.status);

      // Buttondown moves through about_to_send -> in_flight -> sent, so the
      // status right after the call says little. What matters is whether the
      // archive page exists, which is the thing readers and crawlers hit.
      const live = draft.absolute_url ? await isLive(draft.absolute_url) : null;

      if (live === true) {
        console.log(`OK (${settled}) — ページ公開を確認`);
        published += 1;
      } else if (PUBLISHED.has(settled)) {
        console.log(`${settled} — 反映待ち（ページはまだ404）`);
      } else {
        console.log(`失敗: status が ${settled} のままです`);
      }
    } catch (error) {
      console.log(`エラー: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
    }
  }

  console.log(`\n公開を確認: ${published}/${drafts.length}`);
  if (published < drafts.length) {
    console.log(
      '反映に時間がかかることがあります。数分後に `npm run status` で再確認してください。',
    );
  }
}

/** Poll until the status stops being a transitional one. */
async function waitForStatus(
  client: ButtondownClient,
  id: string,
  initial: string,
): Promise<string> {
  let status = initial;

  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    if (status === 'sent' || status === 'draft' || status === 'errored') return status;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      status = (await client.getEmail(id)).status;
    } catch {
      return status;
    }
  }
  return status;
}

async function isLive(url: string): Promise<boolean | null> {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return null;
  }
}

export type { ButtondownEmail };

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
