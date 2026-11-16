import detect from '../../../utils/lang_detect';
import { osType } from '../../../utils/env';
import { invoke } from '@tauri-apps/api';
import { Language } from './info';

const windowsLangMap = {
    auto: 'auto',
    zh_cn: 'zh-CN',
    zh_tw: 'zh-TW',
    en: 'en-US',
    yue: 'zh-HK',
    ja: 'ja-JP',
    ko: 'ko-KR',
    fr: 'fr-FR',
    es: 'es-ES',
    ru: 'ru-RU',
    de: 'de-DE',
    it: 'it-IT',
    tr: 'tr-TR',
    pt: 'pt-PT',
    pt_br: 'pt-BR',
    vi: 'vi-VN',
    id: 'id-ID',
    th: 'th-TH',
    ms: 'ms-MY',
    ar: 'ar-SA',
    hi: 'hi-IN',
    uk: 'uk-UA',
    he: 'he-IL',
};

export async function recognize(_, lang) {
    const linuxLangMap = {
        auto: 'auto',
        zh_cn: 'chi_sim',
        zh_tw: 'chi_tra',
        en: 'eng',
        yue: 'chi_sim',
        ja: 'jpn',
        ko: 'kor',
        fr: 'fra',
        es: 'spa',
        ru: 'rus',
        de: 'deu',
        it: 'ita',
        tr: 'tur',
        pt: 'por',
        pt_br: 'por',
        vi: 'vie',
        id: 'ind',
        th: 'tha',
        ms: 'msa',
        ar: 'ara',
        hi: 'hin',
        uk: 'ukr',
        he: 'heb',
    };
    const macOSLangMap = {
        auto: 'auto',
        zh_cn: 'zh-Hans',
        zh_tw: 'zh-Hant',
        en: 'en-US',
        yue: 'zh-Hans',
        ja: 'ja-JP',
        ko: 'ko-KR',
        fr: 'fr-FR',
        es: 'es-ES',
        ru: 'ru-RU',
        de: 'de-DE',
        it: 'it-IT',
        tr: 'tr-TR',
        pt: 'pt-PT',
        pt_br: 'pt-BR',
        vi: 'vi-VN',
        id: 'id-ID',
        th: 'th-TH',
        ms: 'ms-MY',
        ar: 'ar-SA',
        hi: 'hi-IN',
        uk: 'uk-UA',
        he: 'he-IL',
    };
    let result = '';
    switch (osType) {
        case 'Linux':
            result = await invoke('system_ocr', { lang: linuxLangMap[lang] });
            if (lang === Language.auto && (await detect(result)) === Language.zh_cn) {
                result = result.replaceAll(' ', '');
            } else {
                if (lang === Language.zh_cn || lang === Language.zh_tw) {
                    result = result.replaceAll(' ', '');
                }
            }
            return result.trim();
        case 'Darwin':
            result = await invoke('system_ocr', { lang: macOSLangMap[lang] });
            return result.trim();
        case 'Windows_NT':
            result = await invoke('system_ocr', { lang: windowsLangMap[lang] });
            if (lang === Language.auto && (await detect(result)) === Language.zh_cn) {
                result = result.replaceAll(' ', '');
            } else {
                if (lang === Language.zh_cn || lang === Language.zh_tw || lang === Language.ja) {
                    result = result.replaceAll(' ', '');
                }
            }
            return result.trim();
    }
}

const CJK_GAP = /([\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+(?=[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])/g;
const CJK_PUNCT_BEFORE = /([\u3000-\u303f\uff00-\uffef])\s+/g;
const CJK_PUNCT_AFTER = /\s+([\u3000-\u303f\uff00-\uffef])/g;

function normalizeOcrText(text) {
    return String(text ?? '')
        .replace(CJK_GAP, '$1')
        .replace(CJK_PUNCT_BEFORE, '$1')
        .replace(CJK_PUNCT_AFTER, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeOcrBoxes(boxes) {
    return (boxes ?? []).map((box) => ({
        ...box,
        text: normalizeOcrText(box.text),
    }));
}

function scoreOcrBoxes(boxes) {
    const text = (boxes ?? []).map((box) => box.text).join(' ');
    const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z0-9]/g) ?? []).length;
    const cjkGaps = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]\s+[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    const replacement = (text.match(/\uFFFD/g) ?? []).length;
    return cjk * 3 + latin - cjkGaps * 2 - replacement * 5;
}

export async function recognizeWithBoxes(lang) {
    if (osType !== 'Windows_NT') {
        throw new Error('only windows');
    }

    const language = windowsLangMap[lang] ?? 'auto';
    if (language !== 'auto') {
        return normalizeOcrBoxes(await invoke('system_ocr_boxes', { lang: language }));
    }

    // Windows' "auto" only uses the first installed user-profile language,
    // which often picks an English engine for Chinese screenshots. Try the
    // common OCR packs and keep the result with the most real characters.
    const candidates = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
        try {
            const boxes = normalizeOcrBoxes(await invoke('system_ocr_boxes', { lang: candidate }));
            if (boxes.length === 0) {
                continue;
            }
            const score = scoreOcrBoxes(boxes);
            if (score > bestScore) {
                best = boxes;
                bestScore = score;
            }
        } catch {
            // Language pack not installed; try the next one.
        }
    }
    if (best !== null) {
        return best;
    }

    return normalizeOcrBoxes(await invoke('system_ocr_boxes', { lang: 'auto' }));
}

export * from './Config';
export * from './info';
