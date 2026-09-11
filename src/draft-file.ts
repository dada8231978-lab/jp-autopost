import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { countWords } from './html.js';
import { CategorySchema, type Category, type Draft } from './types.js';

/**
 * The draft file is the hand-off between the model and the author.
 *
 * Plain Markdown on purpose: the author rewrites it in whatever editor they
 * like, and everything needed to publish it — metadata, the paywall split, the
 * fact-check list — lives in that one file.
 *
 * An untouched copy of the model's version is kept in drafts/.ai so publishing
 * can measure how much of it the author actually changed.
 */

export const DRAFTS_DIR = resolve(process.cwd(), 'drafts');
export const BASELINE_DIR = resolve(DRAFTS_DIR, '.ai');
export const PUBLISHED_DIR = resolve(DRAFTS_DIR, 'published');

const PAYWALL = '<!-- PAYWALL -->';
const NOTES = '<!-- NOTES:';
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface DraftMeta {
  title: string;
  slug: string;
  category: Category;
  topic: string;
  target_query: string;
  meta_description: string;
  tags: string[];
  model: string;
  input_tokens: number;
  output_tokens: number;
  generated_at: string;
}

export interface ParsedDraft {
  meta: DraftMeta;
  free: string;
  paid: string;
  notes: string;
}

export interface DraftInspection {
  path: string;
  file: string;
  parsed: ParsedDraft | null;
  hasBaseline: boolean;
  /** 0 = identical to the AI draft, 1 = nothing in common. */
  editRatio: number;
  unchecked: number;
  freeWords: number;
  paidWords: number;
  problems: string[];
  ready: boolean;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const pct = (r: number): string => `${Math.round(r * 100)}%`;

// ---------------------------------------------------------------------------
// Rendering and parsing
// ---------------------------------------------------------------------------

export function renderDraftFile(
  draft: Draft,
  extra: { topic: string; model: string; inputTokens: number; outputTokens: number },
): string {
  const meta = [
    `title: ${oneLine(draft.title)}`,
    `slug: ${draft.slug}`,
    `category: ${draft.category}`,
    `topic: ${oneLine(extra.topic)}`,
    `target_query: ${oneLine(draft.target_query)}`,
    `meta_description: ${oneLine(draft.meta_description)}`,
    `tags: ${draft.tags.map(oneLine).join(', ')}`,
    `model: ${extra.model}`,
    `input_tokens: ${extra.inputTokens}`,
    `output_tokens: ${extra.outputTokens}`,
    `generated_at: ${new Date().toISOString()}`,
  ].join('\n');

  const list = (items: readonly string[], checkbox: boolean): string =>
    items.length === 0
      ? '- （なし）'
      : items.map((i) => `- ${checkbox ? '[ ] ' : ''}${oneLine(i)}`).join('\n');

  return `---
${meta}
---

<!--
  AIが作った下書きです。このままでは公開できません（npm run publish が確認します）。

  1. 本文をあなた自身の言葉で書き直してください。AIの文章がほぼ残っていると公開を拒否します。
  2. 下の「公開前に必ず確認する事実」を一次情報で確かめ、確認できたら [ ] を [x] にしてください。
     記事から削った主張は、チェックリストからも行ごと消してください。
  3. PAYWALL の行より上は無料部分で、検索エンジンにも見えます。

  このコメントは公開されません。
-->

${draft.free_section_md.trim()}

${PAYWALL}

${draft.paid_body_md.trim()}

${NOTES} この行から下は公開されません -->

## 公開前に必ず確認する事実

${list(draft.claims_to_verify, true)}

## あなたにしか書けないこと

${list(draft.author_prompts, false)}

## 確認すべき一次情報の種類

${list(draft.suggested_sources, false)}
`;
}

export function parseDraftFile(text: string): ParsedDraft {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!fm) throw new Error('先頭の --- で囲まれたメタデータ部分が見つかりません。');

  const fields: Record<string, string> = {};
  for (const line of (fm[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const rest = text.slice(fm[0].length);
  const notesAt = rest.indexOf(NOTES);
  const body = notesAt >= 0 ? rest.slice(0, notesAt) : rest;
  const notes = notesAt >= 0 ? rest.slice(notesAt) : '';

  const payAt = body.indexOf(PAYWALL);
  if (payAt < 0) {
    throw new Error(`${PAYWALL} の行が見つかりません。無料部分と有料部分の境目に置いてください。`);
  }

  const title = fields.title ?? '';
  const slug = fields.slug ?? '';
  const category = CategorySchema.safeParse(fields.category);

  if (!title) throw new Error('title が空です。');
  if (!SLUG.test(slug)) throw new Error('slug は半角の英小文字・数字・ハイフンだけにしてください。');
  if (!category.success) throw new Error('category は culture か healthcare にしてください。');

  const clean = (s: string): string =>
    s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const num = (v: string | undefined): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

  return {
    meta: {
      title,
      slug,
      category: category.data,
      topic: fields.topic ?? '',
      target_query: fields.target_query ?? '',
      meta_description: fields.meta_description ?? '',
      tags: (fields.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      model: fields.model ?? '',
      input_tokens: num(fields.input_tokens),
      output_tokens: num(fields.output_tokens),
      generated_at: fields.generated_at ?? '',
    },
    free: clean(body.slice(0, payAt)),
    paid: clean(body.slice(payAt + PAYWALL.length)),
    notes,
  };
}

// ---------------------------------------------------------------------------
// How much did the author change?
// ---------------------------------------------------------------------------

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Share of words that differ between the AI draft and the edited version,
 * from the longest common subsequence of words.
 *
 * This measures change, not authorship. It exists to stop machine prose from
 * going out unedited by accident; it cannot prove who wrote anything, and
 * someone determined to defeat it could.
 */
export function computeEditRatio(original: string, edited: string): number {
  const a = words(original);
  const b = words(edited);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }

  const lcs = prev[b.length] ?? 0;
  return 1 - lcs / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function inspectDraft(path: string, minEditRatio: number): Promise<DraftInspection> {
  const abs = resolve(process.cwd(), path);
  const file = basename(abs);
  const empty: DraftInspection = {
    path: abs,
    file,
    parsed: null,
    hasBaseline: false,
    editRatio: 0,
    unchecked: 0,
    freeWords: 0,
    paidWords: 0,
    problems: [],
    ready: false,
  };

  let parsed: ParsedDraft;
  try {
    parsed = parseDraftFile(await readFile(abs, 'utf8'));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...empty, problems: [message] };
  }

  const baselinePath = [resolve(BASELINE_DIR, file), resolve(BASELINE_DIR, `${parsed.meta.slug}.md`)].find(
    (p) => existsSync(p),
  );

  // No baseline means the author started this file themselves, not from a
  // generated draft, so there is nothing to have left unedited.
  let editRatio = 1;
  if (baselinePath) {
    const original = parseDraftFile(await readFile(baselinePath, 'utf8'));
    editRatio = computeEditRatio(`${original.free}\n${original.paid}`, `${parsed.free}\n${parsed.paid}`);
  }

  const unchecked = (parsed.notes.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  const freeWords = countWords(parsed.free);
  const paidWords = countWords(parsed.paid);

  const problems: string[] = [];
  if (baselinePath && editRatio < minEditRatio) {
    problems.push(
      `AIの下書きからの変更が ${pct(editRatio)} です。${pct(minEditRatio)} 以上、自分の言葉に書き直してください。`,
    );
  }
  if (unchecked > 0) {
    problems.push(
      `未確認の事実が ${unchecked} 件あります。一次情報で確かめて [x] にするか、記事から削った主張なら行ごと消してください。`,
    );
  }
  if (freeWords === 0) problems.push('無料部分が空です。');
  if (paidWords === 0) problems.push('有料部分が空です。');

  return {
    ...empty,
    parsed,
    hasBaseline: Boolean(baselinePath),
    editRatio,
    unchecked,
    freeWords,
    paidWords,
    problems,
    ready: problems.length === 0,
  };
}

export async function listDrafts(minEditRatio: number): Promise<DraftInspection[]> {
  let files: string[];
  try {
    files = await readdir(DRAFTS_DIR);
  } catch {
    return [];
  }
  return Promise.all(
    files
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => inspectDraft(resolve(DRAFTS_DIR, f), minEditRatio)),
  );
}

/** Write a new draft plus its untouched baseline. Never overwrites. */
export async function writeNewDraft(
  draft: Draft,
  extra: { topic: string; model: string; inputTokens: number; outputTokens: number },
): Promise<string> {
  await mkdir(BASELINE_DIR, { recursive: true });

  let name = `${draft.slug}.md`;
  for (let n = 2; existsSync(resolve(DRAFTS_DIR, name)) || existsSync(resolve(PUBLISHED_DIR, name)); n += 1) {
    name = `${draft.slug}-${n}.md`;
  }

  const text = renderDraftFile(draft, extra);
  await writeFile(resolve(DRAFTS_DIR, name), text, 'utf8');
  await writeFile(resolve(BASELINE_DIR, name), text, 'utf8');
  return resolve(DRAFTS_DIR, name);
}

/** Move a published draft and its baseline out of the working folder. */
export async function archiveDraft(path: string): Promise<string> {
  await mkdir(PUBLISHED_DIR, { recursive: true });
  const file = basename(path);
  const target = resolve(PUBLISHED_DIR, file);
  await rename(path, target);

  const baseline = resolve(BASELINE_DIR, file);
  if (existsSync(baseline)) {
    await rename(baseline, resolve(PUBLISHED_DIR, file.replace(/\.md$/, '.ai.md')));
  }
  return target;
}
