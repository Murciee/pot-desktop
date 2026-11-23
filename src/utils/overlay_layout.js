export const OVERLAY_MIN_FONT_SIZE = 7;
export const OVERLAY_MAX_AUTO_FONT_SIZE = 180;
export const OVERLAY_MAX_SCALED_FONT_SIZE = 240;

function isCJK(char) {
    return /[\u3000-\u9fff\uf900-\ufaff]/.test(char ?? '');
}

export function joinLineText(left, right) {
    if (/(?:^|\s)[A-Za-z]{2,}-$/i.test(left) && /^[a-z]/.test(right)) {
        return left.slice(0, -1) + right;
    }
    if (/(?:^|\s)--[A-Za-z0-9-]+-$/.test(left) && /^[A-Za-z0-9]/.test(right)) {
        return left + right;
    }
    if (isCJK(left.slice(-1)) || isCJK(right.slice(0, 1))) {
        return left + right;
    }
    return `${left} ${right}`;
}

export function median(values) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function averageColors(samples) {
    if (!samples || samples.length === 0) {
        return null;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    for (const sample of samples) {
        r += sample[0];
        g += sample[1];
        b += sample[2];
    }
    const count = samples.length;
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

/**
 * Merge OCR line boxes that belong to the same paragraph.
 * Uses local line height ratio, orientation consistency, and last-line
 * horizontal overlap so wide headings do not merge separate columns underneath.
 */
export function mergeLineBoxes(lines) {
    const valid = (lines ?? [])
        .filter((line) => line && typeof line.text === 'string' && line.text.trim() !== '' && line.w > 0 && line.h > 0)
        .map((line) => ({
            ...line,
            vertical: Boolean(line.vertical),
            bgColor: Array.isArray(line.bgColor) && line.bgColor.length === 3 ? line.bgColor : null,
        }))
        .sort((a, b) => a.y - b.y || a.x - b.x);

    if (valid.length === 0) {
        return [];
    }

    const blocks = [];

    for (const line of valid) {
        const lineText = line.text.trim();
        const lineSize = line.vertical ? line.w : line.h;
        let target = null;

        if (!line.vertical) {
            for (let i = blocks.length - 1; i >= 0; i -= 1) {
                const block = blocks[i];
                if (block.vertical) {
                    continue;
                }
                const minH = Math.max(1, Math.min(block.lastLineH, line.h));
                const maxH = Math.max(block.lastLineH, line.h);
                if (maxH / minH > 1.55) {
                    continue;
                }
                const gap = line.y - (block.lastLineY + block.lastLineH);
                if (gap < -minH * 0.35 || gap >= minH * 0.75) {
                    continue;
                }
                const overlap =
                    Math.min(block.lastLineX + block.lastLineW, line.x + line.w) -
                    Math.max(block.lastLineX, line.x);
                const minWidth = Math.min(block.lastLineW, line.w);
                if (minWidth > 0 && overlap / minWidth > 0.25) {
                    target = block;
                    break;
                }
            }
        }

        if (target) {
            const right = Math.max(target.x + target.w, line.x + line.w);
            const bottom = Math.max(target.y + target.h, line.y + line.h);
            target.x = Math.min(target.x, line.x);
            target.y = Math.min(target.y, line.y);
            target.w = right - target.x;
            target.h = bottom - target.y;
            target.lastLineX = line.x;
            target.lastLineY = line.y;
            target.lastLineW = line.w;
            target.lastLineH = line.h;
            target.text = joinLineText(target.text, lineText);
            target.lineSizes.push(lineSize);
            if (line.bgColor) {
                target.bgSamples.push(line.bgColor);
            }
        } else {
            blocks.push({
                x: line.x,
                y: line.y,
                w: line.w,
                h: line.h,
                lastLineX: line.x,
                lastLineY: line.y,
                lastLineW: line.w,
                lastLineH: line.h,
                text: lineText,
                vertical: line.vertical,
                lineSizes: [lineSize],
                bgSamples: line.bgColor ? [line.bgColor] : [],
            });
        }
    }

    return blocks.map(({ x, y, w, h, text, vertical, lineSizes, bgSamples }) => ({
        x,
        y,
        w,
        h,
        text,
        vertical,
        lineSize: median(lineSizes),
        lineCount: lineSizes.length,
        bgColor: averageColors(bgSamples),
    }));
}

/**
 * Convert physical pixel boxes into normalized coordinates relative to the
 * captured region, so the overlay can be resized without re-running OCR.
 */
export function normalizeBlocks(blocks, width, height, dpr) {
    const factor = dpr > 0 ? dpr : 1;
    const cssWidth = width / factor;
    const cssHeight = height / factor;
    if (cssWidth <= 0 || cssHeight <= 0) {
        return [];
    }

    return blocks.map((block, index) => {
        const vertical = Boolean(block.vertical);
        const axisSpan = vertical ? cssWidth : cssHeight;
        const nLineSize =
            Number.isFinite(block.lineSize) && block.lineSize > 0
                ? block.lineSize / factor / axisSpan
                : null;
        const lineCount =
            Number.isInteger(block.lineCount) && block.lineCount > 0 ? block.lineCount : null;

        return {
            id: index,
            nx: block.x / factor / cssWidth,
            ny: block.y / factor / cssHeight,
            nw: block.w / factor / cssWidth,
            nh: block.h / factor / cssHeight,
            text: block.text,
            vertical,
            nLineSize,
            lineCount,
            bgColor: block.bgColor ?? null,
        };
    });
}

export function computeBlockMaxFontSize({
    blockWidth,
    blockHeight,
    vertical = false,
    lineSizePx = null,
    text = '',
}) {
    const axisSize = Math.max(
        OVERLAY_MIN_FONT_SIZE,
        Number(vertical ? blockWidth : blockHeight) || OVERLAY_MIN_FONT_SIZE
    );
    let raw;
    if (Number.isFinite(lineSizePx) && lineSizePx > 0) {
        // Match the original OCR line thickness without letting shorter translations
        // in merged multi-line paragraphs inflate beyond the original font size.
        raw = Math.min(lineSizePx, axisSize);
    } else {
        const nonEmptyLines =
            String(text ?? '')
                .split(/\r?\n/)
                .filter((line) => line.trim() !== '').length || 1;
        raw = (axisSize / nonEmptyLines) * 0.85;
    }
    return Math.max(OVERLAY_MIN_FONT_SIZE, Math.min(OVERLAY_MAX_AUTO_FONT_SIZE, raw));
}

export function shouldSkipTranslation(text, targetLang) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
        return true;
    }
    if (!/\p{L}/u.test(trimmed)) {
        return true;
    }
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
        return true;
    }
    const lang = String(targetLang ?? '').toLowerCase();
    if (lang === 'zh_cn' || lang === 'zh_tw') {
        const hasHan = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(trimmed);
        const hasForeignScript = /[A-Za-z]{2,}|[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/.test(
            trimmed
        );
        if (hasHan && !hasForeignScript) {
            return true;
        }
    } else if (lang === 'ko') {
        const hasHangul = /[\uac00-\ud7af]/.test(trimmed);
        const hasForeignScript = /[A-Za-z]{2,}|[\u4e00-\u9fff\u3040-\u30ff\u0400-\u04ff]/.test(trimmed);
        if (hasHangul && !hasForeignScript) {
            return true;
        }
    }
    return false;
}

export function computeBlockColors(bgColor, themeMode, appResolvedTheme, opacity) {
    const alpha = Math.min(1, Math.max(0.3, Number(opacity) || 0.85));
    let useDark = false;
    let rgb = null;

    if (themeMode === 'dark') {
        useDark = true;
        rgb = [24, 24, 27];
    } else if (themeMode === 'light') {
        useDark = false;
        rgb = [255, 255, 255];
    } else if (Array.isArray(bgColor) && bgColor.length === 3) {
        const [r, g, b] = bgColor.map((v) => Math.min(255, Math.max(0, Math.round(Number(v) || 0))));
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        useDark = luma <= 145;
        rgb = [r, g, b];
    } else {
        useDark = appResolvedTheme === 'dark';
        rgb = useDark ? [24, 24, 27] : [255, 255, 255];
    }

    const borderColor = useDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)';
    return {
        background: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`,
        color: useDark ? '#f4f4f5' : '#111111',
        mutedColor: useDark ? '#a1a1aa' : '#52525b',
        border: `1px solid ${borderColor}`,
        borderColor,
        isDark: useDark,
    };
}

const NON_BATCH_SERVICES = new Set(['ecdict', 'bing_dict', 'cambridge_dict']);

export function isBatchFriendlyService(serviceName) {
    return Boolean(serviceName) && !NON_BATCH_SERVICES.has(serviceName);
}

export function formatBatchPrompt(texts) {
    return (texts ?? [])
        .map((text, index) => `[[${index}]] ${String(text ?? '').trim()}`)
        .join('\n');
}

export function parseBatchTranslation(rawText, expectedCount) {
    if (expectedCount <= 0 || typeof rawText !== 'string') {
        return null;
    }
    const pattern = /(?:^|\n)\s*\[\[(\d+)\]\]\s*/g;
    const matches = [];
    let match;
    while ((match = pattern.exec(rawText)) !== null) {
        matches.push({
            index: Number(match[1]),
            start: match.index,
            contentStart: match.index + match[0].length,
        });
    }
    if (matches.length !== expectedCount) {
        return null;
    }
    const results = new Array(expectedCount);
    const seen = new Set();
    for (let i = 0; i < matches.length; i += 1) {
        const current = matches[i];
        if (!Number.isInteger(current.index) || current.index < 0 || current.index >= expectedCount) {
            return null;
        }
        if (seen.has(current.index)) {
            return null;
        }
        seen.add(current.index);
        const end = i + 1 < matches.length ? matches[i + 1].start : rawText.length;
        const segment = rawText.slice(current.contentStart, end).trim();
        if (!segment) {
            return null;
        }
        results[current.index] = segment;
    }
    return seen.size === expectedCount ? results : null;
}
