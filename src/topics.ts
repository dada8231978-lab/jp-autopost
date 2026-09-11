import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Category, PublishRecord, StoredArticle } from './types.js';

const HISTORY_PATH = resolve(process.cwd(), 'data/published.json');
const HISTORY_DIR = resolve(process.cwd(), 'data/history');
const ARTICLES_DIR = resolve(process.cwd(), 'data/articles');

/**
 * Seed topics. The generator is told to find its own specific angle inside the
 * seed, so the same seed does not produce the same article twice — but we still
 * prefer unused seeds first.
 */
export const TOPIC_POOL: Record<Category, string[]> = {
  culture: [
    'Shokunin: the Japanese ideal of mastery through repetition',
    'Why Japanese cities are clean despite having almost no public bins',
    'Omotenashi vs. Western hospitality: what actually differs',
    'The economics and etiquette of the Japanese convenience store',
    'Hanko seals in a digital state: a bureaucracy in transition',
    'Kintsugi and the aesthetics of visible repair',
    'Nemawashi: how Japanese organisations build consensus before meetings',
    'Onsen etiquette and the social meaning of communal bathing',
    'Japanese school cleaning time (souji) as moral education',
    'Ma: the use of negative space in Japanese design and speech',
    'The vending machine density of Japan and what it reveals',
    'Chindonya, enka and other vanishing Japanese street professions',
    'Ikigai: what the concept actually means in Japan vs. abroad',
    'Setsubun, Obon and the living calendar of Japanese seasonal ritual',
    'Why Japanese apologies are grammatically different from Western ones',
    'Depachika: the underground food halls of Japanese department stores',
  ],
  healthcare: [
    "Japan's universal health insurance system explained for outsiders",
    'Kampo: traditional herbal medicine inside a modern hospital system',
    'The Japanese annual health check (ningen dock) and preventive culture',
    'How Japan reached the world’s highest life expectancy',
    "Japan's long-term care insurance and the ageing society",
    'Metabo law: the legal waistline check and what it achieved',
    'Karoshi, overwork and Japanese occupational health regulation',
    'Why Japanese hospital stays are far longer than in the West',
    'Maternal and child health handbooks (boshi techo) as a public health tool',
    'Mental health care in Japan: stigma, hikikomori and reform',
    'Japanese pharmacy culture and the role of the kakaritsuke pharmacist',
    'The Okinawan diet: evidence, myth and what changed',
    'Japan’s response to infectious disease: masks before the pandemic',
    'Dementia care villages and community-based support in rural Japan',
    'Emergency medicine in Japan and the "ambulance refusal" problem',
    'Dietary salt, stroke and the Japanese public health campaign that worked',
    'Why Japan has more CT and MRI scanners per capita than any other country',
    'Japan’s brain-death law and why organ transplantation stayed rare',
    'The long practice of withholding cancer diagnoses from Japanese patients',
    'Antibiotic prescribing culture and antimicrobial resistance in Japan',
    'Why Japan has the world’s highest per-capita rate of dialysis',
    'Drug lag: why new medicines reached Japan years after the West',
    'Mass gastric cancer screening: endoscopy as national policy',
    'Why Japan has far more hospital beds per capita than comparable countries',
    'The 7-to-1 nurse staffing rule and how reimbursement reshaped hospitals',
    'Medical corporations (iryo hojin) and why Japanese hospitals stay family-run',
    'The HPV vaccine suspension and a decade of vaccine hesitancy',
    'Palliative care and Japan’s late adoption of hospice medicine',
    'Why Japanese patients see doctors more often than anyone else on earth',
    'Free ambulance rides in Japan and the consequences of zero price',
    'Japan’s fast-track approval pathway for regenerative medicine',
    'Tuberculosis in Japan: a persistent outlier among wealthy countries',
    'The foreign care worker programs filling Japan’s kaigo shortage',
    'Blood donation and Japan’s domestic self-sufficiency policy',
    'Suicide prevention policy in Japan and what actually moved the numbers',
    'Pharmacogenomics: why standard drug doses differ for Japanese patients',
    'Japan’s national cancer registry and what it revealed about survival',
    'Health effects research after Fukushima and the thyroid screening debate',
  ],
};

/**
 * Read the publish history, oldest first.
 *
 * Merges the one-file-per-publish records in data/history with the legacy
 * data/published.json array, so histories written before the split are not
 * lost and no migration step is needed.
 */
export async function loadHistory(): Promise<PublishRecord[]> {
  const [legacy, split] = await Promise.all([readLegacyHistory(), readSplitHistory()]);

  const byKey = new Map<string, PublishRecord>();
  for (const record of [...legacy, ...split]) {
    byKey.set(record.postId || `${record.publishedAt}-${record.slug}`, record);
  }

  return [...byKey.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

async function readLegacyHistory(): Promise<PublishRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
    return Array.isArray(parsed) ? (parsed as PublishRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readSplitHistory(): Promise<PublishRecord[]> {
  let files: string[];
  try {
    files = await readdir(HISTORY_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const records = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => JSON.parse(await readFile(resolve(HISTORY_DIR, f), 'utf8')) as PublishRecord),
  );
  return records;
}

/**
 * Write one record as its own file.
 *
 * Deliberately not an append to a shared array. Two runs dispatched from the
 * same commit both edited the tail of data/published.json, so the second one's
 * rebase conflicted and its record was silently lost while the article itself
 * had already been published. Separate files cannot collide.
 */
export async function appendHistory(record: PublishRecord): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });
  const stamp = record.publishedAt.replace(/[:.]/g, '-');
  await writeFile(
    resolve(HISTORY_DIR, `${stamp}-${record.slug}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Pick the next topic: prefer a seed never used before; if every seed in the
 * category has been used, fall back to the least-recently-used one.
 */
export function pickTopic(
  category: Category,
  history: readonly PublishRecord[],
): { topic: string; category: Category } {
  const pool = TOPIC_POOL[category];
  const usedOrder = history.filter((h) => h.category === category).map((h) => h.topic);
  const unused = pool.filter((t) => !usedOrder.includes(t));

  if (unused.length > 0) {
    const index = Math.floor(Math.random() * unused.length);
    return { topic: unused[index] as string, category };
  }

  const lastUseIndex = (topic: string): number => usedOrder.lastIndexOf(topic);
  const leastRecent = [...pool].sort((a, b) => lastUseIndex(a) - lastUseIndex(b))[0] as string;
  return { topic: leastRecent, category };
}

/** How many recent posts the mix is balanced over. */
const MIX_WINDOW = 10;

/**
 * Resolve the configured category, expanding "mixed" using the recent history.
 *
 * A coin flip does not hold a ratio - it happily produces five culture pieces
 * in a row. This looks at what was actually published recently and picks
 * whichever beat moves the mix back toward `healthcareRatio`, so the balance
 * self-corrects instead of drifting.
 */
export function resolveCategory(
  configured: 'culture' | 'healthcare' | 'mixed',
  healthcareRatio = 0.7,
  history: readonly PublishRecord[] = [],
): Category {
  if (configured !== 'mixed') return configured;
  if (healthcareRatio >= 1) return 'healthcare';
  if (healthcareRatio <= 0) return 'culture';

  const recent = history.slice(-MIX_WINDOW);
  if (recent.length === 0) return 'healthcare';

  const share = recent.filter((h) => h.category === 'healthcare').length / recent.length;
  return share < healthcareRatio ? 'healthcare' : 'culture';
}

/**
 * Persist the generated article body. The publish history only records
 * metadata; the Reddit command needs the actual text to work from.
 */
export async function saveArticle(article: StoredArticle): Promise<void> {
  await mkdir(ARTICLES_DIR, { recursive: true });
  await writeFile(
    resolve(ARTICLES_DIR, `${article.slug}.json`),
    `${JSON.stringify(article, null, 2)}\n`,
    'utf8',
  );
}

export async function loadArticle(slug: string): Promise<StoredArticle> {
  const raw = await readFile(resolve(ARTICLES_DIR, `${slug}.json`), 'utf8');
  return JSON.parse(raw) as StoredArticle;
}

/** Slug of the most recently published article that still has a saved body. */
export async function latestArticleSlug(): Promise<string | null> {
  const history = await loadHistory();
  let files: string[];
  try {
    files = await readdir(ARTICLES_DIR);
  } catch {
    return null;
  }
  const available = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const slug = history[i]?.slug;
    if (slug && available.has(slug)) return slug;
  }

  // Nothing published yet (e.g. only dry runs so far) - fall back to the most
  // recently written article file.
  const stats = await Promise.all(
    [...available].map(async (slug) => ({
      slug,
      mtime: (await stat(resolve(ARTICLES_DIR, `${slug}.json`))).mtimeMs,
    })),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0]?.slug ?? null;
}

/** Titles already used, so the generator can be told to avoid them. */
export function recentTitles(history: readonly PublishRecord[], limit = 20): string[] {
  return history.slice(-limit).map((h) => h.title);
}
