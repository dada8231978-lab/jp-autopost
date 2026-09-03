import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Article, Category, PublishRecord } from './types.js';

const HISTORY_PATH = resolve(process.cwd(), 'data/published.json');
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
  ],
};

/** Read the publish history (empty on first run). */
export async function loadHistory(): Promise<PublishRecord[]> {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PublishRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Append one record to the history file. */
export async function appendHistory(record: PublishRecord): Promise<void> {
  const history = await loadHistory();
  history.push(record);
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
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

/** Resolve the configured category, expanding "mixed" into a coin flip. */
export function resolveCategory(configured: 'culture' | 'healthcare' | 'mixed'): Category {
  if (configured !== 'mixed') return configured;
  return Math.random() < 0.5 ? 'culture' : 'healthcare';
}

/**
 * Persist the generated article body. The publish history only records
 * metadata; the Reddit command needs the actual text to work from.
 */
export async function saveArticle(article: Article): Promise<void> {
  await mkdir(ARTICLES_DIR, { recursive: true });
  await writeFile(
    resolve(ARTICLES_DIR, `${article.slug}.json`),
    `${JSON.stringify(article, null, 2)}\n`,
    'utf8',
  );
}

export async function loadArticle(slug: string): Promise<Article> {
  const raw = await readFile(resolve(ARTICLES_DIR, `${slug}.json`), 'utf8');
  return JSON.parse(raw) as Article;
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
