import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { collectStatus, renderHtml } from './status-core.js';
import { DRAFTS_DIR, listDrafts, pct, type DraftInspection } from './draft-file.js';

/**
 * Local control panel: the status report plus the actions it points to.
 *
 * Bound to 127.0.0.1 on purpose. Publishing cannot be undone and there is no
 * authentication, which is only acceptable because nothing off this machine
 * can connect.
 *
 * Nothing here can publish a draft the author has not worked on. The publish
 * button runs `publish.ts`, which re-checks the edit ratio and the fact list
 * itself and refuses a draft that fails them, whatever the page showed.
 */

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);
const HOST = '127.0.0.1';
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

interface Action {
  label: string;
  hint: string;
  argv: string[];
}

/** Fixed allowlist. None of these publish anything. */
const ACTIONS: Record<string, Action> = {
  draft: {
    label: '下書きを作成',
    hint: 'AIが事実チェックリスト付きの下書きを drafts/ に作ります。何も公開しません。',
    argv: ['tsx', 'src/index.ts'],
  },
  verify: {
    label: 'Buttondown 接続確認',
    hint: '接続と収支を表示します。何も変更しません。',
    argv: ['tsx', 'src/verify.ts'],
  },
  seo: {
    label: '検索構造レポート',
    hint: '公開済み記事のクエリ重複やタイトル長を点検します。',
    argv: ['tsx', 'src/seo.ts'],
  },
  reddit: {
    label: 'Reddit 投稿の下書き',
    hint: 'data/reddit/ にファイルを書くだけです。自分の言葉に直してから投稿してください。',
    argv: ['tsx', 'src/reddit-post.ts'],
  },
};

interface Job {
  label: string;
  output: string;
  running: boolean;
  exitCode: number | null;
}

/** One at a time — two publishes at once is a race worth never having. */
let job: Job | null = null;

function startJob(label: string, argv: string[]): string | null {
  if (job?.running) return `実行中です: ${job.label}`;

  const current: Job = { label, output: '', running: true, exitCode: null };
  job = current;

  // shell is needed on Windows, where npx is a .cmd. That is safe only because
  // every argument is either a literal here or a slug checked against SLUG.
  const child = spawn('npx', argv, {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    env: process.env,
  });

  const append = (chunk: Buffer): void => {
    current.output += chunk.toString();
    if (current.output.length > 200_000) current.output = current.output.slice(-200_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (e) => {
    current.output += `\n[起動できませんでした] ${e.message}\n`;
  });
  child.on('close', (code) => {
    current.running = false;
    current.exitCode = code;
    current.output += `\n--- 終了コード ${code} ---\n`;
  });

  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const [status, drafts] = await Promise.all([
      collectStatus(),
      listDrafts(loadConfig().MIN_EDIT_RATIO),
    ]);
    const html = renderHtml(status).replace('<!--ACTIONS-->', panel(drafts));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/job') {
    json(res, 200, job ?? { label: null, output: '', running: false, exitCode: null });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    const body = await readBody(req);
    const action = ACTIONS[String(body.action ?? '')];
    if (!action) {
      json(res, 400, { error: '不明な操作です' });
      return;
    }
    const error = startJob(action.label, action.argv);
    json(res, error ? 409 : 202, error ? { error } : { started: action.label });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/publish') {
    const body = await readBody(req);
    const name = String(body.draft ?? '');

    if (!SLUG.test(name)) {
      json(res, 400, { error: '下書き名が不正です' });
      return;
    }
    if (!existsSync(resolve(DRAFTS_DIR, `${name}.md`))) {
      json(res, 404, { error: '下書きが見つかりません' });
      return;
    }
    // Confirmation is required in the request itself, not only in a dialog.
    if (body.confirm !== true) {
      json(res, 400, { error: '確認が必要な操作です' });
      return;
    }

    const error = startJob(`公開: ${name}`, ['tsx', 'src/publish.ts', `drafts/${name}.md`, '--confirm']);
    json(res, error ? 409 : 202, error ? { error } : { started: name });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function panel(drafts: readonly DraftInspection[]): string {
  const min = loadConfig().MIN_EDIT_RATIO;

  const buttons = Object.entries(ACTIONS)
    .map(
      ([key, a]) => `
      <button class="act" data-action="${key}" data-label="${esc(a.label)}" data-ready="true">
        <span class="t">${esc(a.label)}</span><span class="h">${esc(a.hint)}</span>
      </button>`,
    )
    .join('');

  const rows = drafts
    .map((d) => {
      const name = d.file.replace(/\.md$/, '');
      const title = d.parsed?.meta.title ?? '(読み込めません)';
      const change = d.parsed ? (d.hasBaseline ? pct(d.editRatio) : '一から作成') : '—';
      const why = d.problems.map((p) => `<div class="why">${esc(p)}</div>`).join('');
      return `<tr>
        <td><div class="dtitle">${esc(title)}</div><div class="mono dim">drafts/${esc(d.file)}</div>${why}</td>
        <td class="mono ${d.hasBaseline && d.editRatio < min ? 'warn' : ''}">${change}</td>
        <td class="mono ${d.unchecked > 0 ? 'warn' : ''}">${d.parsed ? d.unchecked : '—'}</td>
        <td>${SLUG.test(name)
          ? `<button class="pub" data-publish="${esc(name)}" data-title="${esc(title)}" data-ready="${d.ready}" ${d.ready ? '' : 'disabled'}>公開</button>`
          : '<span class="dim">ファイル名を英小文字に</span>'}</td>
      </tr>`;
    })
    .join('');

  return `
<section id="actions">
  <h2>操作</h2>
  <div class="acts">${buttons}</div>
</section>

<section>
  <h2>下書き</h2>
  <p class="dim note">公開できるのは、AIの下書きから ${pct(min)} 以上書き直し、事実チェックリストをすべて確認した下書きだけです。公開ボタンを押しても、実行時にもう一度同じ検査をします。</p>
  ${drafts.length === 0
    ? '<p class="dim">下書きはまだありません。「下書きを作成」から始めてください。</p>'
    : `<div class="scroll"><table>
        <tr><th>下書き</th><th>変更率</th><th>未確認</th><th></th></tr>${rows}
      </table></div>`}
  <div id="log" hidden><div class="loghead"><span id="logtitle"></span><span id="logstate"></span></div><pre id="logbody"></pre></div>
</section>

<style>
  .acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.6rem}
  .act{text-align:left;background:var(--card);border:1px solid var(--line);border-radius:9px;
       padding:.7rem .85rem;cursor:pointer;color:inherit;font:inherit}
  .act:hover{border-color:var(--muted)}
  .act:disabled,.pub:disabled{opacity:.45;cursor:not-allowed}
  .act .t{display:block;font-weight:600;font-size:.9rem}
  .act .h{display:block;color:var(--muted);font-size:.75rem;margin-top:.2rem;line-height:1.45}
  .pub{background:var(--bad);color:#fff;border:0;border-radius:7px;padding:.35rem .9rem;cursor:pointer;font:inherit}
  .dim{color:var(--muted)} .note{font-size:.8rem;margin:0 0 .75rem}
  .dtitle{font-weight:600}
  .why{color:var(--warn);font-size:.75rem;margin-top:.2rem}
  #log{margin-top:1rem;border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .loghead{display:flex;justify-content:space-between;padding:.5rem .75rem;
           background:color-mix(in srgb,var(--muted) 10%,transparent);font-size:.78rem}
  #logbody{margin:0;padding:.75rem;max-height:22rem;overflow:auto;white-space:pre-wrap;
           font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.76rem;line-height:1.5}
</style>

<script>
(function(){
  var log=document.getElementById('log'), body=document.getElementById('logbody'),
      title=document.getElementById('logtitle'), state=document.getElementById('logstate'),
      all=[].slice.call(document.querySelectorAll('[data-ready]')), timer=null;

  function setBusy(b){ all.forEach(function(x){ x.disabled = b || x.dataset.ready==='false'; }); }

  function poll(){
    fetch('/api/job').then(function(r){return r.json();}).then(function(j){
      body.textContent=j.output||'(出力待ち)';
      body.scrollTop=body.scrollHeight;
      if(j.running){ state.textContent='実行中…'; return; }
      clearInterval(timer); timer=null; setBusy(false);
      state.textContent = j.exitCode===0 ? '完了' : '終了コード '+j.exitCode;
      if(j.exitCode===0) setTimeout(function(){ location.reload(); }, 2500);
    });
  }

  function run(url, payload, label){
    setBusy(true);
    log.hidden=false; title.textContent=label; state.textContent='開始しています…'; body.textContent='';
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
      .then(function(res){
        if(!res.ok){ state.textContent='開始できません'; body.textContent=res.d.error||''; setBusy(false); return; }
        timer=setInterval(poll,1000); poll();
      });
  }

  [].slice.call(document.querySelectorAll('[data-action]')).forEach(function(btn){
    btn.addEventListener('click', function(){ run('/api/run', {action:btn.dataset.action}, btn.dataset.label); });
  });

  [].slice.call(document.querySelectorAll('[data-publish]')).forEach(function(btn){
    btn.addEventListener('click', function(){
      if(!confirm('「'+btn.dataset.title+'」を公開します。取り消せません。よろしいですか？')) return;
      run('/api/publish', {draft:btn.dataset.publish, confirm:true}, '公開: '+btn.dataset.title);
    });
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
});

server.listen(PORT, HOST, () => {
  console.log('\njp-autopost ダッシュボード');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  ${HOST} からのみ接続できます。このウィンドウを閉じると止まります（Ctrl+C で終了）。\n`);
});
