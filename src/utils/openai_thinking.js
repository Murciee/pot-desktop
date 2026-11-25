export const THINKING_VARIANTS = {
    all: {
        reasoning_effort: 'none',
        enable_thinking: false,
        thinking: { type: 'disabled' },
    },
    cn_dual: {
        enable_thinking: false,
        thinking: { type: 'disabled' },
    },
    enable_thinking: {
        enable_thinking: false,
    },
    thinking_disabled: {
        thinking: { type: 'disabled' },
    },
    reasoning_none: {
        reasoning_effort: 'none',
    },
    reasoning_minimal: {
        reasoning_effort: 'minimal',
    },
    none: {},
};

export const VARIANT_ORDER = [
    'all',
    'cn_dual',
    'enable_thinking',
    'thinking_disabled',
    'reasoning_none',
    'reasoning_minimal',
    'none',
];

const profileCache = new Map();

export function clearThinkingProfileCache() {
    profileCache.clear();
}

export function applyThinkingVariant(baseBody, variantName) {
    const patch = THINKING_VARIANTS[variantName];
    if (!patch || variantName === 'none') {
        return { ...baseBody };
    }
    return {
        ...baseBody,
        ...patch,
    };
}

export function isThinkingParamRejection(status) {
    return status === 400 || status === 422;
}

export function extractErrorText(data) {
    if (data === null || data === undefined) {
        return '';
    }
    if (typeof data === 'string') {
        return data.toLowerCase();
    }
    try {
        return JSON.stringify(data).toLowerCase();
    } catch {
        return String(data).toLowerCase();
    }
}

export function pickNextThinkingVariant(currentVariant, errorText, tried) {
    tried.add(currentVariant);
    const rejected = new Set();
    if (/\breasoning_effort\b/.test(errorText)) {
        rejected.add('reasoning_effort');
    }
    if (/\benable_thinking\b/.test(errorText)) {
        rejected.add('enable_thinking');
    }
    const withoutEnable = errorText.replace(/\benable_thinking\b/g, '');
    if (/\bthinking\b/.test(withoutEnable)) {
        rejected.add('thinking');
    }

    const untried = VARIANT_ORDER.filter((variant) => !tried.has(variant));
    if (untried.length === 0) {
        return null;
    }

    const safe = untried.filter((variant) => {
        const keys = Object.keys(THINKING_VARIANTS[variant]);
        return !keys.some((key) => rejected.has(key));
    });

    return safe[0] ?? untried[0];
}

export async function executeWithDisableThinking({ cacheKey, disableThinking, baseBody, sendRequest }) {
    if (!disableThinking) {
        return await sendRequest(baseBody);
    }

    let variant = (cacheKey && profileCache.get(cacheKey)) || 'all';
    if (!THINKING_VARIANTS[variant]) {
        variant = 'all';
    }
    const tried = new Set();

    while (variant) {
        const res = await sendRequest(applyThinkingVariant(baseBody, variant));
        if (res.ok || !isThinkingParamRejection(res.status)) {
            if (res.ok && cacheKey) {
                profileCache.set(cacheKey, variant);
            }
            return res;
        }

        const next = pickNextThinkingVariant(variant, extractErrorText(res.data), tried);
        if (!next) {
            return res;
        }
        variant = next;
    }
}
