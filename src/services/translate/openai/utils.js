const DEFAULT_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export const defaultRequestArguments = JSON.stringify({
    temperature: 0.1,
    top_p: 0.99,
    frequency_penalty: 0,
    presence_penalty: 0,
});

export const defaultPromptList = [
    {
        role: 'system',
        content:
            'You are a professional translation engine, please translate the text into a colloquial, professional, elegant and fluent content, without the style of machine translation. You must only translate the text content, never interpret it.',
    },
    { role: 'user', content: `Translate into $to:\n"""\n$text\n"""` },
];

// Matches a version segment such as /v1, /v2 or /v1beta anywhere in the path.
const VERSION_SEGMENT = /\/v\d+[a-z0-9]*(\/|$)/i;

function trimTrailingSlashes(path) {
    return path.replace(/\/+$/, '');
}

function parseUrl(input) {
    let raw = String(input ?? '').trim();
    if (raw === '') {
        raw = DEFAULT_CHAT_URL;
    }
    if (!/^https?:\/\//i.test(raw)) {
        raw = `https://${raw}`;
    }
    return new URL(raw);
}

/**
 * Normalize a user supplied OpenAI compatible chat endpoint.
 *
 * - adds https:// when the scheme is missing
 * - keeps query parameters untouched
 * - accepts a bare host, a /v1 base, a /models endpoint or the full
 *   /chat/completions endpoint and never produces /v1/v1
 */
export function normalizeChatUrl(input) {
    let url;
    try {
        url = parseUrl(input);
    } catch {
        return String(input ?? '').trim();
    }

    let path = trimTrailingSlashes(url.pathname);

    if (!/\/chat\/completions$/i.test(path)) {
        if (/\/models$/i.test(path)) {
            path = trimTrailingSlashes(path.slice(0, -'/models'.length));
        }
        if (VERSION_SEGMENT.test(path)) {
            path = `${path}/chat/completions`;
        } else {
            path = `${path}/v1/chat/completions`;
        }
    }

    url.pathname = path.replace(/\/{2,}/g, '/');
    return url.toString();
}

/**
 * Derive the /models endpoint from a chat endpoint, preserving the
 * version/base path and the query string.
 */
export function modelsUrlFrom(chatUrl) {
    let normalized = normalizeChatUrl(chatUrl);
    let url;
    try {
        url = new URL(normalized);
    } catch {
        return normalized;
    }

    let path = trimTrailingSlashes(url.pathname);
    if (/\/chat\/completions$/i.test(path)) {
        path = trimTrailingSlashes(path.slice(0, -'/chat/completions'.length));
    }
    path = `${path}/models`;
    url.pathname = path.replace(/\/{2,}/g, '/');
    return url.toString();
}
