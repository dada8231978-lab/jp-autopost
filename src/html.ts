/** Tags we allow through to Ghost. Anything else is unwrapped or dropped. */
const ALLOWED_TAGS = new Set([
  'p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote',
  'strong', 'em', 'b', 'i', 'a', 'br', 'hr', 'code', 'pre',
]);

/**
 * Defensive clean-up of model-authored HTML.
 *
 * The schema already tells Claude which tags to use; this exists so a stray
 * markdown fence or a <script> can never reach the published post.
 */
export function sanitizeHtml(input: string): string {
  let html = input.trim();

  // Strip markdown code fences the model sometimes wraps HTML in.
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '');

  // Remove entire dangerous elements including their content.
  html = html.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '');

  // Remove inline event handlers and javascript: URLs.
  html = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');

  // Drop document-level wrappers, keeping their children.
  html = html.replace(/<\/?(?:html|head|body|main|article|section|div)\b[^>]*>/gi, '');

  // Unwrap any remaining tag that is not on the allowlist.
  html = html.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (match, rawTag: string) =>
    ALLOWED_TAGS.has(rawTag.toLowerCase()) ? match : '',
  );

  return html.replace(/\n{3,}/g, '\n\n').trim();
}

/** Rough word count of rendered text, used for logging and sanity checks. */
export function countWords(html: string): number {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .trim();
  return text ? text.split(/\s+/).length : 0;
}

/** Escape a plain string for safe interpolation into HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
