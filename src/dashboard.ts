import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { collectStatus, renderHtml } from './status-core.js';

/**
 * A local control panel for the automation.
 *
 * `npm run status` answers "is it working". This adds "and do something about
 * it" — the actions you would otherwise have to remember as shell commands,
 * next to the problem that calls for them.
 *
 * Bound to 127.0.0.1 on purpose. Two of these actions publish writing to the
 * internet and cannot be undone, so the server must not be reachable from the
 * rest of the network. There is no authentication precisely because nothing
 * but this machine can connect.
 */

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);
const HOST = '127.0.0.1';

interface Action {
  label: string;
  hint: string;
  argv: string[];
  /** Publishes something irreversible, so the UI must confirm first. */
  irreversible: boolean;
}

/**
 * Fixed allowlist. Nothing from the request reaches a command line — the
 * client picks a key, never an argument — so a stray request cannot run
 * anything that is not listed here.
 */
const ACTIONS: Record<string, Action> = {
  'dry-run': {
    label: '記事を生成（公開しない）',
    hint: 'プレビューHTMLを出力するだけ。品質確認用で、いつ実行しても安全です。',
    argv: ['tsx', 'src/index.ts', '--dry-run'],
    irreversible: false,
  },
  post: {
    label: '記事を生成して公開',
    hint: '生成した記事をそのまま公開します。取り消せません。',
    argv: ['tsx', 'src/index.ts'],
    irreversible: true,
  },
  publish: {
    label: '取り残された下書きを公開',
    hint: '下書きのまま404になっている記事を公開します。取り消せません。',
    argv: ['tsx', 'src/publish.ts', '--confirm'],
    irreversible: true,
  },
  reddit: {
    label: 'Reddit投稿の下書きを生成',
    hint: 'data/reddit/ にファイルを書くだけ。Redditには投稿しません。',
    argv: ['tsx', 'src/reddit-post.ts'],
    irreversible: false,
  },
  seo: {
    label: '検索構造レポート',
    hint: '公開済み記事のクエリ重複やタイトル長を点検します。',
    argv: ['tsx', 'src/seo.ts'],
    irreversible: false,
  },
};

interface Job {
  action: string;
  startedAt: number;
  output: string;
  running: boolean;
  exitCode: number | null;
}

/** One at a time. Two publishing runs at once is exactly the race to avoid. */
let job: Job | null = null;

function startJob(key: string): { ok: true } | { ok: false; error: string } {
  const action = ACTIONS[key];
  if (!action) return { ok: false, error: `不明な操作: ${key}` };
  if (job?.running) return { ok: false, error: `実行中です: ${job.action}` };

  const current: Job = { action: key, startedAt: Date.now(), output: '', running: true, exitCode: null };
  job = current;

  const child = spawn('npx', action.argv, {
    cwd: process.cwd(),
    shell: process.platform === 'win32', // npx is a .cmd on Windows
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

  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
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
    const status = await collectStatus();
    const html = renderHtml(status).replace('<!--ACTIONS-->', actionPanel());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/job') {
    json(res, 200, job ?? { running: false, output: '', exitCode: null, action: null });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    const body = await readBody(req);
    const key = String(body.action ?? '');
    const action = ACTIONS[key];

    if (!action) {
      json(res, 400, { error: `不明な操作: ${key}` });
      return;
    }
    // The confirmation lives in the request, not just the UI, so a mis-click
    // that skips the dialog cannot publish either.
    if (action.irreversible && body.confirm !== true) {
      json(res, 400, { error: '確認が必要な操作です' });
      return;
    }

    const started = startJob(key);
    json(res, started.ok ? 202 : 409, started.ok ? { started: key } : { error: started.error });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// ---------------------------------------------------------------------------
// Action panel markup
// ---------------------------------------------------------------------------

function actionPanel(): string {
  const buttons = Object.entries(ACTIONS)
    .map(
      ([key, a]) => `
      <button class="act ${a.irreversible ? 'danger' : ''}" data-action="${key}"
              data-irreversible="${a.irreversible}" data-label="${a.label}">
        <span class="t">${a.label}</span>
        <span class="h">${a.hint}</span>
      </button>`,
    )
    .join('');

  return `
<section id="actions">
  <h2>操作</h2>
  <div class="acts">${buttons}</div>
  <div id="log" hidden><div class="loghead"><span id="logtitle"></span><span id="logstate"></span></div><pre id="logbody"></pre></div>
</section>
<style>
  .acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.6rem}
  .act{text-align:left;background:var(--card);border:1px solid var(--line);border-radius:9px;
       padding:.7rem .85rem;cursor:pointer;color:inherit;font:inherit;display:block}
  .act:hover{border-color:var(--muted)}
  .act:disabled{opacity:.45;cursor:not-allowed}
  .act .t{display:block;font-weight:600;font-size:.9rem}
  .act .h{display:block;color:var(--muted);font-size:.75rem;margin-top:.2rem;line-height:1.45}
  .act.danger .t::before{content:"● ";color:var(--bad)}
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
      buttons=[].slice.call(document.querySelectorAll('.act')), timer=null;

  function setBusy(b){ buttons.forEach(function(x){ x.disabled=b; }); }

  function poll(){
    fetch('/api/job').then(function(r){return r.json();}).then(function(j){
      body.textContent=j.output||'(出力待ち)';
      body.scrollTop=body.scrollHeight;
      if(j.running){ state.textContent='実行中…'; }
      else{
        clearInterval(timer); timer=null; setBusy(false);
        state.textContent= j.exitCode===0 ? '完了' : '終了コード '+j.exitCode;
        if(j.exitCode===0) setTimeout(function(){ location.reload(); },2500);
      }
    });
  }

  buttons.forEach(function(btn){
    btn.addEventListener('click',function(){
      var action=btn.dataset.action, label=btn.dataset.label;
      if(btn.dataset.irreversible==='true'){
        if(!confirm(label+'\\n\\nこの操作は取り消せません。実行しますか？')) return;
      }
      setBusy(true);
      log.hidden=false; title.textContent=label; state.textContent='開始しています…'; body.textContent='';
      fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:action,confirm:true})})
        .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
        .then(function(res){
          if(!res.ok){ state.textContent='開始できません'; body.textContent=res.d.error||''; setBusy(false); return; }
          timer=setInterval(poll,1000); poll();
        });
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
  console.log(`\njp-autopost ダッシュボード`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  ${HOST} からのみ接続できます。Ctrl+C で終了。\n`);
});
