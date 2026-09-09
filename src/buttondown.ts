import { assertButtondownConfig, loadConfig, type Config } from './config.js';

export interface ButtondownEmail {
  id: string;
  subject: string;
  slug?: string;
  status: string;
  email_type?: string;
  absolute_url?: string;
  publish_date?: string;
}

export interface CreateEmailInput {
  subject: string;
  body: string;
  slug?: string;
  description?: string;
}

/** Fields beyond the required two. Dropped on retry if the API rejects them. */
const OPTIONAL_FIELDS = ['slug', 'description', 'email_type', 'status'] as const;

export class ButtondownError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ButtondownError';
  }
}

export class ButtondownClient {
  private readonly config: Config;

  constructor(config: Config = loadConfig()) {
    assertButtondownConfig(config);
    this.config = config;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.config.BUTTONDOWN_API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Token ${this.config.BUTTONDOWN_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const text = await response.text();

    if (!response.ok) {
      // Buttondown returns the offending field and its allowed values in the
      // body, so surface it verbatim rather than a generic status message.
      throw new ButtondownError(
        `Buttondown ${init.method ?? 'GET'} /${path} failed (${response.status}): ${text.slice(0, 1000)}`,
        response.status,
        text,
      );
    }

    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Confirm the API key works and report who it belongs to. */
  async verify(): Promise<{ username: string; subscribers: number }> {
    // This endpoint is paginated - the newsletter lives in results[0], and the
    // object it returns carries no subscriber count, so that comes separately.
    const page = await this.request<{
      results?: Array<{ username?: string; name?: string }>;
    }>('newsletters');

    const newsletter = page.results?.[0];
    const name = newsletter?.name?.trim();
    const username = newsletter?.username?.trim();

    const label = name && username ? `${name} (@${username})` : (name ?? username ?? '(unknown)');

    return { username: label, subscribers: await this.countSubscribers() };
  }

  /** Total subscriber count, read from the paginated list endpoint. */
  async countSubscribers(): Promise<number> {
    const page = await this.request<{ count?: number }>('subscribers?page=1');
    return page.count ?? 0;
  }

  /** Number of subscribers on a paid plan, if the account exposes it. */
  async countPaidSubscribers(): Promise<number | null> {
    try {
      const page = await this.request<{ count?: number }>(
        'subscribers?type=premium&page=1',
      );
      return page.count ?? 0;
    } catch {
      // Paid subscriptions add-on not enabled, or the filter is unsupported.
      return null;
    }
  }

  /**
   * Create an email.
   *
   * Buttondown's optional fields have drifted between API versions, so if the
   * full payload is rejected with a validation error we retry with only
   * `subject` and `body` rather than failing the whole run.
   */
  async createEmail(input: CreateEmailInput): Promise<ButtondownEmail> {
    const full: Record<string, unknown> = {
      subject: input.subject,
      body: this.withEditorMode(input.body),
      email_type: this.config.BUTTONDOWN_EMAIL_TYPE,
      status: this.config.BUTTONDOWN_EMAIL_STATUS,
    };
    if (input.slug) full.slug = input.slug;
    if (input.description) full.description = input.description;

    try {
      return await this.request<ButtondownEmail>('emails', { method: 'POST', body: full });
    } catch (error) {
      // Buttondown reports schema violations as 422, not 400. Checking only for
      // 400 meant this fallback could never fire: the daily run would abort on
      // exactly the field-drift it was written to survive.
      const validationFailed =
        error instanceof ButtondownError && (error.status === 400 || error.status === 422);
      if (!validationFailed) throw error;

      const rejected = OPTIONAL_FIELDS.filter((f) => error.body.includes(f));
      if (rejected.length === 0) throw error;

      console.warn(
        `[buttondown] The API rejected ${rejected.join(', ')}. ` +
          'Retrying with subject + body only. The email will be created as a draft ' +
          'with default settings - set the audience and paywall in the Buttondown UI, ' +
          'then fix these values in .env.',
      );
      console.warn(`[buttondown] Original error: ${error.body.slice(0, 400)}`);

      return this.request<ButtondownEmail>('emails', {
        method: 'POST',
        body: { subject: full.subject, body: full.body },
      });
    }
  }

  /** Prepend the editor-mode comment when the mode is pinned in .env. */
  private withEditorMode(body: string): string {
    const mode = this.config.BUTTONDOWN_EDITOR_MODE;
    if (mode === 'auto') return body;
    return `<!-- buttondown-editor-mode: ${mode} -->\n${body}`;
  }
}
