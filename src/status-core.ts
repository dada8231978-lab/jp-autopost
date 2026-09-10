import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { ButtondownClient } from './buttondown.js';
import { loadHistory } from './topics.js';
import { netAfterStripe } from './publisher.js';
import type { PublishRecord } from './types.js';

const REPO = 'dada8231978-lab/jp-autopost';

/** claude-sonnet-5, USD per million tokens. */
const PRICE_IN = 2;
const PRICE_OUT = 10;

const DAY_MS = 86_400_000;

export interface Run {
  number: number;
  event: string;
  conclusion: string | null;
  status: string;
  createdAt: Date;
  /** Minutes between the cron's nominal time and when the run was created. */
  delayMinutes: number | null;
  url: string;
}

export interface Email {
  subject: string;
  status: string;
  url: string;
  createdAt: Date;
  live: boolean | null;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/** Read the cron from the workflow so this report cannot drift from reality. */
async function readCron(): Promise<{ minute: number; hour: number } | null> {
  try {
    const yaml = await readFile(resolve(process.cwd(), '.github/workflows/daily-post.yml'), 'utf8');
    const match = /-\s*cron:\s*'(\d+)\s+(\d+)\s/.exec(yaml);
    if (!match) return null;
    return { minute: Number(match[1]), hour: Number(match[2]) };
  } catch {
    return null;
  }
}

/**
 * Workflow runs. The repository is public, so this needs no token — which
 * matters: the report must work from any machine without GitHub credentials.
 */
async function fetchRuns(cron: { minute: number; hour: number } | null): Promise<Run[]> {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/runs?per_page=30`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);

  const data = (await response.json()) as {
    workflow_runs: Array<{
      run_number: number;
      event: string;
      conclusion: string | null;
      status: string;
      created_at: string;
      html_url: string;
    }>;
  };

  return data.workflow_runs.map((r) => {
    const createdAt = new Date(r.created_at);
    let delayMinutes: number | null = null;

    if (cron && r.event === 'schedule') {
      // The nominal firing time is that same UTC day at the cron's hour:minute.
      const due = new Date(createdAt);
      due.setUTCHours(cron.hour, cron.minute, 0, 0);
      if (due > createdAt) due.setUTCDate(due.getUTCDate() - 1);
      delayMinutes = Math.round((createdAt.getTime() - due.getTime()) / 60_000);
    }

    return {
      number: r.run_number,
      event: r.event,
      conclusion: r.conclusion,
      status: r.status,
      createdAt,
      delayMinutes,
      url: r.html_url,
    };
  });
}

/** Articles as Buttondown sees them, with each archive page probed for real. */
async function fetchEmails(client: ButtondownClient): Promise<Email[]> {
  const page = await client.listEmails();

  return Promise.all(
    page.map(async (e) => ({
      subject: e.subject,
      status: e.status,
      url: e.absolute_url ?? '',
      createdAt: new Date(e.creation_date ?? e.publish_date ?? Date.now()),
      live: e.absolute_url ? await isLive(e.absolute_url) : null,
    })),
  );
}

async function isLive(url: string): Promise<boolean | null> {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000) });
    return r.ok;
  } catch {
    return null; // unknown, not "missing"
  }
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

export function costOf(history: readonly PublishRecord[]): number {
  return history.reduce(
    (sum, r) =>
      sum + (r.usage.inputTokens * PRICE_IN + r.usage.outputTokens * PRICE_OUT) / 1_000_000,
    0,
  );
}

/**
 * One cell per day: did an article get published that day?
 *
 * `before` marks days earlier than the first article ever published. Counting
 * those as misses would report a brand-new project as mostly broken.
 */
function calendar(
  history: readonly PublishRecord[],
  days: number,
): Array<{ date: string; count: number; before: boolean }> {
  const counts = new Map<string, number>();
  for (const r of history) {
    const key = r.publishedAt.slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const first = history[0]?.publishedAt.slice(0, 10) ?? '9999-99-99';

  const out: Array<{ date: string; count: number; before: boolean }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ date: key, count: counts.get(key) ?? 0, before: key < first });
  }
  return out;
}

function nextRun(cron: { minute: number; hour: number } | null): Date | null {
  if (!cron) return null;
  const next = new Date();
  next.setUTCHours(cron.hour, cron.minute, 0, 0);
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export const jst = (d: Date): string =>
  new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export interface RenderInput {
  runs: Run[];
  emails: Email[];
  history: PublishRecord[];
  cal: Array<{ date: string; count: number; before: boolean }>;
  cron: { minute: number; hour: number } | null;
  avgDelay: number | null;
  next: Date | null;
  config: ReturnType<typeof loadConfig>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderHtml(d: RenderInput): string {
  const emails = d.emails;
  const live = emails.filter((e) => e.live === true).length;
  const dead = emails.filter((e) => e.live === false);
  const drafts = emails.filter((e) => e.status === 'draft');
  const failures = d.runs.filter((r) => r.conclusion === 'failure');
  const lastRun = d.runs[0];

  const recent = d.history.slice(-10);
  const hcShare = recent.length
    ? Math.round((recent.filter((r) => r.category === 'healthcare').length / recent.length) * 100)
    : 0;
  const cost = costOf(d.history);

  const problems: string[] = [];
  if (drafts.length) problems.push(`${drafts.length}件が下書きのまま — 公開ページが存在しません`);
  if (dead.length) problems.push(`${dead.length}件のアーカイブページが 404 です`);
  if (lastRun && lastRun.conclusion === 'failure') problems.push(`最新の実行 #${lastRun.number} が失敗しています`);
  if (d.avgDelay !== null && d.avgDelay > 60) {
    problems.push(`スケジュール実行が平均 ${Math.floor(d.avgDelay / 60)}時間${d.avgDelay % 60}分 遅れています`);
  }
  const gapDays = d.cal.slice(0, -1).filter((x) => x.count === 0 && !x.before).length;
  if (gapDays > 0) problems.push(`直近14日のうち ${gapDays}日、記事が出ていません`);

  const healthy = problems.length === 0;

  const runRows = d.runs
    .slice(0, 12)
    .map((r) => {
      const ok = r.conclusion === 'success';
      const delay = r.delayMinutes === null ? '—' : `+${Math.floor(r.delayMinutes / 60)}h${String(r.delayMinutes % 60).padStart(2, '0')}m`;
      return `<tr>
        <td class="num">#${r.number}</td>
        <td><span class="dot ${ok ? 'ok' : r.conclusion === null ? 'run' : 'bad'}"></span>${esc(r.conclusion ?? r.status)}</td>
        <td>${esc(r.event)}</td>
        <td class="mono">${jst(r.createdAt)}</td>
        <td class="mono ${r.delayMinutes !== null && r.delayMinutes > 60 ? 'warn' : ''}">${delay}</td>
      </tr>`;
    })
    .join('');

  const emailRows = [...emails]
    .reverse()
    .map(
      (e) => `<tr>
        <td><span class="dot ${e.live === true ? 'ok' : e.live === false ? 'bad' : 'run'}"></span>${e.live === true ? '公開' : e.live === false ? '404' : '不明'}</td>
        <td>${esc(e.status)}</td>
        <td>${e.url ? `<a href="${esc(e.url)}">${esc(e.subject)}</a>` : esc(e.subject)}</td>
      </tr>`,
    )
    .join('');

  const calCells = d.cal
    .map(
      (c) =>
        `<div class="cell ${c.before ? 'before' : c.count === 0 ? 'none' : c.count > 1 ? 'many' : 'one'}" title="${c.date}: ${c.before ? '運用開始前' : `${c.count}件`}"></div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jp-autopost 実施状況</title>
<style>
  :root{--bg:#fbfbfa;--card:#fff;--ink:#1a1a18;--muted:#6b6b66;--line:#e5e4e0;
        --ok:#1a7f5a;--bad:#c0392b;--warn:#b7791f;--run:#8a8a85;}
  @media (prefers-color-scheme:dark){
    :root{--bg:#16161a;--card:#1e1e23;--ink:#eceae6;--muted:#9a9a94;--line:#2f2f36;
          --ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--run:#7a7a80;}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;}
  .wrap{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 4rem}
  h1{font-size:1.4rem;margin:0 0 .25rem}
  .sub{color:var(--muted);font-size:.85rem;margin-bottom:1.5rem}
  .banner{padding:1rem 1.25rem;border-radius:10px;margin-bottom:1.5rem;border:1px solid var(--line)}
  .banner.ok{background:color-mix(in srgb,var(--ok) 10%,transparent);border-color:var(--ok)}
  .banner.bad{background:color-mix(in srgb,var(--warn) 12%,transparent);border-color:var(--warn)}
  .banner h2{margin:0 0 .4rem;font-size:1rem}
  .banner ul{margin:.4rem 0 0;padding-left:1.1rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-bottom:1.5rem}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem}
  .stat .k{color:var(--muted);font-size:.75rem;letter-spacing:.02em}
  .stat .v{font-size:1.5rem;font-weight:600;margin-top:.15rem;font-variant-numeric:tabular-nums}
  .stat .n{color:var(--muted);font-size:.75rem}
  section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.25rem;margin-bottom:1.25rem}
  section h2{margin:0 0 .75rem;font-size:.95rem}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;color:var(--muted);font-weight:500;font-size:.75rem;padding:.3rem .5rem .3rem 0;border-bottom:1px solid var(--line)}
  td{padding:.4rem .5rem .4rem 0;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;font-variant-numeric:tabular-nums}
  .num{color:var(--muted)}
  .warn{color:var(--warn)}
  a{color:inherit}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:.45rem;vertical-align:middle}
  .dot.ok{background:var(--ok)} .dot.bad{background:var(--bad)} .dot.run{background:var(--run)}
  .cal{display:flex;gap:4px}
  .cell{flex:1;height:34px;border-radius:4px;border:1px solid var(--line)}
  .cell.none{background:transparent}
  .cell.before{background:transparent;border-style:dashed;opacity:.4}
  .cell.one{background:var(--ok);opacity:.75}
  .cell.many{background:var(--ok)}
  .cal-legend{display:flex;justify-content:space-between;color:var(--muted);font-size:.72rem;margin-top:.4rem}
  .scroll{overflow-x:auto}
</style></head><body><div class="wrap">

<h1>jp-autopost 実施状況</h1>
<div class="sub">生成 ${jst(new Date())} JST · <span class="mono">npm run status</span> で更新</div>

<div class="banner ${healthy ? 'ok' : 'bad'}">
  <h2>${healthy ? '正常に稼働しています' : '確認が必要な項目があります'}</h2>
  ${healthy
    ? '<div>直近の実行は成功し、公開ページ・内部リンクとも問題ありません。</div>'
    : `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`}
</div>

<!--ACTIONS-->

<div class="grid">
  <div class="stat"><div class="k">記事</div><div class="v">${d.history.length}</div><div class="n">公開ページ ${live}/${emails.length}</div></div>
  <div class="stat"><div class="k">医療比率</div><div class="v">${hcShare}%</div><div class="n">直近10件 / 目標 ${Math.round(d.config.HEALTHCARE_RATIO * 100)}%</div></div>
  <div class="stat"><div class="k">生成コスト累計</div><div class="v">$${cost.toFixed(2)}</div><div class="n">平均 $${(cost / Math.max(1, d.history.length)).toFixed(3)}/記事</div></div>
  <div class="stat"><div class="k">実行の失敗</div><div class="v">${failures.length}</div><div class="n">直近30件中</div></div>
</div>

<section>
  <h2>直近14日の公開</h2>
  <div class="cal">${calCells}</div>
  <div class="cal-legend"><span>${d.cal[0]?.date ?? ''}</span><span>今日</span></div>
</section>

<section>
  <h2>スケジュール</h2>
  <table>
    <tr><td>cron</td><td class="mono">${d.cron ? `${String(d.cron.hour).padStart(2, '0')}:${String(d.cron.minute).padStart(2, '0')} UTC` : '(未検出)'}</td></tr>
    <tr><td>平均遅延</td><td class="mono ${d.avgDelay !== null && d.avgDelay > 60 ? 'warn' : ''}">${d.avgDelay === null ? '—' : `${Math.floor(d.avgDelay / 60)}時間${d.avgDelay % 60}分`}</td></tr>
    <tr><td>次回の予定</td><td class="mono">${d.next ? `${jst(d.next)} JST` : '—'}</td></tr>
  </table>
</section>

<section>
  <h2>実行履歴</h2>
  <div class="scroll"><table>
    <tr><th>#</th><th>結果</th><th>種別</th><th>実行(JST)</th><th>遅延</th></tr>
    ${runRows || '<tr><td colspan="5">取得できませんでした</td></tr>'}
  </table></div>
</section>

<section>
  <h2>記事とアーカイブページ</h2>
  <div class="scroll"><table>
    <tr><th>ページ</th><th>状態</th><th>タイトル</th></tr>
    ${emailRows || '<tr><td colspan="3">取得できませんでした</td></tr>'}
  </table></div>
</section>

</div></body></html>`;
}



// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface Status extends RenderInput {
  lastRun: Run | undefined;
  failures: Run[];
  delays: number[];
  live: number;
  dead: Email[];
  drafts: Email[];
  hcShare: number;
  gaps: number;
  cost: number;
  breakEven: number;
}

/**
 * Gather everything the report needs.
 *
 * Neither source is allowed to take the report down: GitHub is reachable
 * without a token but can rate-limit, and Buttondown needs a key that a given
 * machine may not have. A partial report still answers most questions.
 */
export async function collectStatus(
  onWarn: (message: string) => void = () => {},
): Promise<Status> {
  const config = loadConfig();
  const cron = await readCron();
  const history = await loadHistory();

  const [runs, emails] = await Promise.all([
    fetchRuns(cron).catch((e: unknown) => {
      onWarn(`GitHub unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return [] as Run[];
    }),
    (async () => {
      try {
        return await fetchEmails(new ButtondownClient(config));
      } catch (e) {
        onWarn(`Buttondown unreachable: ${e instanceof Error ? e.message : String(e)}`);
        return [] as Email[];
      }
    })(),
  ]);

  const delays = runs
    .filter((r) => r.event === 'schedule')
    .map((r) => r.delayMinutes)
    .filter((d): d is number => d !== null);

  const recent = history.slice(-10);
  const cal = calendar(history, 14);

  return {
    runs,
    emails,
    history,
    cal,
    cron,
    config,
    next: nextRun(cron),
    avgDelay: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
    lastRun: runs[0],
    failures: runs.filter((r) => r.conclusion === 'failure'),
    delays,
    live: emails.filter((e) => e.live === true).length,
    dead: emails.filter((e) => e.live === false),
    drafts: emails.filter((e) => e.status === 'draft'),
    hcShare: recent.length
      ? recent.filter((r) => r.category === 'healthcare').length / recent.length
      : 0,
    gaps: cal.slice(0, -1).filter((d) => d.count === 0 && !d.before).length,
    cost: costOf(history),
    breakEven: Math.ceil(900 / netAfterStripe(config.SUBSCRIPTION_PRICE_CENTS)),
  };
}
