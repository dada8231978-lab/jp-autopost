import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectStatus, renderHtml, jst } from './status-core.js';

const OUT_PATH = resolve(process.cwd(), 'data/status.html');

/**
 * Print the operational picture and write the visual version.
 *
 * The same data drives `npm run dashboard`, which adds the buttons. This
 * command stays strictly read-only, so it is safe to run anywhere, any time.
 */
async function main(): Promise<void> {
  const s = await collectStatus((m) => console.warn(`[status] ${m}`));

  const line = (label: string, value: string): void =>
    console.log(`  ${label.padEnd(16)} ${value}`);

  console.log('\n=== jp-autopost 実施状況 ===\n');

  console.log('[稼働]');
  line(
    '最新の実行',
    s.lastRun
      ? `#${s.lastRun.number} ${jst(s.lastRun.createdAt)} JST — ${s.lastRun.conclusion ?? s.lastRun.status}`
      : '(取得できません)',
  );
  line(
    '直近30件の失敗',
    s.failures.length === 0
      ? 'なし'
      : `${s.failures.length}件 (#${s.failures.map((f) => f.number).join(', #')})`,
  );
  if (s.cron && s.avgDelay !== null) {
    line(
      'スケジュール遅延',
      `平均 ${Math.floor(s.avgDelay / 60)}時間${s.avgDelay % 60}分 / 最大 ${Math.max(...s.delays)}分`,
    );
  }
  line(
    '次回予定',
    s.next ? `${jst(s.next)} JST (遅延見込み込みで +${s.avgDelay ?? 0}分)` : '自動実行なし（人が公開する運用）',
  );

  console.log('\n[記事]');
  line('公開ページ', `${s.live}/${s.emails.length}`);
  line('下書きのまま', s.drafts.length === 0 ? 'なし' : `${s.drafts.length}件 — 公開ページなし`);
  line('リンク切れ', s.dead.length === 0 ? 'なし' : `${s.dead.length}件`);
  line(
    '医療比率',
    `${Math.round(s.hcShare * 100)}% (直近10件 / 目標 ${Math.round(s.config.HEALTHCARE_RATIO * 100)}%)`,
  );
  line(
    '14日カレンダー',
    s.cal.map((d) => (d.before ? ' ' : d.count === 0 ? '·' : d.count > 1 ? '#' : '■')).join(''),
  );

  console.log('\n[コスト]');
  line(
    '生成コスト累計',
    `$${s.cost.toFixed(2)} (${s.history.length}記事 / 平均 $${(s.cost / Math.max(1, s.history.length)).toFixed(3)})`,
  );
  line('損益分岐', `有料会員 ${s.breakEven}人 で Buttondownアドオン($9/月)を回収`);
  line('現在の月額費用', '$0 (有料アドオン未契約)');

  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  await writeFile(OUT_PATH, renderHtml(s), 'utf8');
  console.log(`\nダッシュボード: ${OUT_PATH}`);
  console.log('ボタンから操作したい場合は npm run dashboard\n');
}

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
