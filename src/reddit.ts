import { loadConfig, type Config } from './config.js';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

export interface SubmitResult {
  id: string;
  url: string;
  subreddit: string;
}

export interface Flair {
  id: string;
  text: string;
}

export class RedditError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RedditError';
  }
}

/** Validate the Reddit half of the config, only where it is actually used. */
export function assertRedditConfig(config: Config): void {
  const missing = (
    [
      ['REDDIT_CLIENT_ID', config.REDDIT_CLIENT_ID],
      ['REDDIT_CLIENT_SECRET', config.REDDIT_CLIENT_SECRET],
      ['REDDIT_USERNAME', config.REDDIT_USERNAME],
      ['REDDIT_PASSWORD', config.REDDIT_PASSWORD],
    ] as const
  )
    .filter(([, v]) => !v.trim())
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Reddit is not configured: ${missing.join(', ')} missing.\n` +
        '  Create a "script" app at https://www.reddit.com/prefs/apps\n' +
        '  The client ID is the string under the app name; the secret is labelled "secret".\n\n' +
        'Run `npm run reddit -- --draft` to write the post to a file without submitting.',
    );
  }
}

export class RedditClient {
  private readonly config: Config;
  private token: string | null = null;

  constructor(config: Config = loadConfig()) {
    assertRedditConfig(config);
    this.config = config;
  }

  /** Reddit requires a descriptive, unique User-Agent or it returns 429/403. */
  private userAgent(): string {
    return (
      this.config.REDDIT_USER_AGENT.trim() ||
      `nodejs:jp-autopost:1.0.0 (by /u/${this.config.REDDIT_USERNAME})`
    );
  }

  /** OAuth2 password grant - the flow intended for personal "script" apps. */
  private async authenticate(): Promise<string> {
    if (this.token) return this.token;

    const basic = Buffer.from(
      `${this.config.REDDIT_CLIENT_ID.trim()}:${this.config.REDDIT_CLIENT_SECRET.trim()}`,
    ).toString('base64');

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent(),
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username: this.config.REDDIT_USERNAME.trim(),
        password: this.config.REDDIT_PASSWORD,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RedditError(
        `Reddit auth failed (${response.status}): ${text.slice(0, 400)}\n` +
          '  If the account has 2FA enabled, the password grant needs "password:OTP" ' +
          'and will break every 30 seconds - use an account without 2FA for the bot, ' +
          'or switch to draft mode.',
      );
    }

    const data = JSON.parse(text) as { access_token?: string; error?: string };
    if (!data.access_token) {
      throw new RedditError(`Reddit auth returned no token: ${text.slice(0, 300)}`);
    }

    this.token = data.access_token;
    return this.token;
  }

  private async request<T>(
    path: string,
    init: { method?: string; form?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.authenticate();

    const response = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': this.userAgent(),
        ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.form ? new URLSearchParams(init.form) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RedditError(`Reddit ${init.method ?? 'GET'} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  }

  /** Account identity plus the signals that decide whether posting will stick. */
  async me(): Promise<{ name: string; linkKarma: number; commentKarma: number; ageDays: number }> {
    const me = await this.request<{
      name: string;
      link_karma: number;
      comment_karma: number;
      created_utc: number;
    }>('/api/v1/me');

    return {
      name: me.name,
      linkKarma: me.link_karma,
      commentKarma: me.comment_karma,
      ageDays: Math.floor((Date.now() / 1000 - me.created_utc) / 86400),
    };
  }

  /** Post flairs available in a subreddit. Many subreddits reject unflaired posts. */
  async flairs(subreddit: string): Promise<Flair[]> {
    try {
      const list = await this.request<Array<{ id: string; text: string }>>(
        `/r/${subreddit}/api/link_flair_v2`,
      );
      return list.map((f) => ({ id: f.id, text: f.text }));
    } catch {
      return [];
    }
  }

  /**
   * Submit a self (text) post.
   *
   * Reddit returns HTTP 200 with the real failure inside `json.errors`, so the
   * status code alone is not a success signal.
   */
  async submitSelfPost(input: {
    subreddit: string;
    title: string;
    text: string;
    flairId?: string;
    flairText?: string;
  }): Promise<SubmitResult> {
    const form: Record<string, string> = {
      api_type: 'json',
      kind: 'self',
      sr: input.subreddit,
      title: input.title,
      text: input.text,
      sendreplies: 'true',
      resubmit: 'false',
    };
    if (input.flairId) form.flair_id = input.flairId;
    if (input.flairText) form.flair_text = input.flairText;

    const response = await this.request<{
      json: {
        errors: Array<[string, string, string?]>;
        data?: { url?: string; id?: string; name?: string };
      };
    }>('/api/submit', { method: 'POST', form });

    const errors = response.json?.errors ?? [];
    if (errors.length > 0) {
      const [code, message] = errors[0] as [string, string];
      throw new RedditError(explainSubmitError(code, message, input.subreddit), code);
    }

    const data = response.json?.data ?? {};
    return {
      id: data.id ?? data.name ?? '(unknown)',
      url: data.url ?? `https://www.reddit.com/r/${input.subreddit}/`,
      subreddit: input.subreddit,
    };
  }
}

/** Turn Reddit's terse error codes into something actionable. */
function explainSubmitError(code: string, message: string, subreddit: string): string {
  const base = `Reddit rejected the post (${code}): ${message}`;

  switch (code) {
    case 'SUBREDDIT_NOTALLOWED':
      return `${base}\n  You are not allowed to post in r/${subreddit} - banned, or the subreddit requires minimum karma/account age.`;
    case 'RATELIMIT':
      return `${base}\n  Reddit is throttling this account. New accounts are rate-limited hard. Wait, and post less often.`;
    case 'NO_SELFS':
      return `${base}\n  r/${subreddit} does not accept text posts. This tool only submits text posts by design.`;
    case 'DOMAIN_BANNED':
      return `${base}\n  Your link's domain is banned in r/${subreddit}. Remove the link (REDDIT_INCLUDE_LINK=false) or stop posting it here.`;
    case 'SUBMIT_VALIDATION_FLAIR_REQUIRED':
    case 'MISSING_FLAIR':
      return `${base}\n  r/${subreddit} requires post flair. Run \`npm run reddit -- --flairs ${subreddit}\` and set REDDIT_FLAIR_ID.`;
    default:
      return base;
  }
}
