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

function hasHorizontalNeighbor(target, allLines) {
    for (const other of allLines) {
        if (other === target) {
            continue;
        }
        const vOverlap =
            Math.min(target.y + target.h, other.y + other.h) - Math.max(target.y, other.y);
        const minH = Math.min(target.h, other.h);
        if (minH <= 0 || vOverlap / minH <= 0.5) {
            continue;
        }
        const maxH = Math.max(target.h, other.h);
        if (maxH / minH > 1.55) {
            continue;
        }
        const hGap = Math.max(other.x - (target.x + target.w), target.x - (other.x + other.w));
        if (hGap >= -minH * 0.2 && hGap <= Math.min(target.w, other.w) * 0.65) {
            return true;
        }
    }
    return false;
}

function chainSingleCharVerticalColumns(lines) {
    const isCharCandidate = (line) => {
        if (line.vertical) {
            return false;
        }
        const stripped = line.text.replace(/\s+/g, '');
        if (stripped.length === 0 || stripped.length > 2) {
            return false;
        }
        const hasCjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(stripped);
        if (!hasCjk) {
            return false;
        }
        const aspect = line.w / line.h;
        return aspect >= 0.55 && aspect <= 1.6;
    };

    const candidates = lines
        .filter((line) => isCharCandidate(line) && !hasHorizontalNeighbor(line, lines))
        .sort((a, b) => a.y - b.y || b.x + b.w - (a.x + a.w));

    const used = new Set();
    const chains = [];

    for (const item of candidates) {
        let target = null;
        for (let i = chains.length - 1; i >= 0; i -= 1) {
            const chain = chains[i];
            const minW = Math.min(chain.lastW, item.w);
            const minH = Math.min(chain.lastH, item.h);
            const maxH = Math.max(chain.lastH, item.h);
            if (minW <= 0 || minH <= 0 || maxH / minH > 1.55) {
                continue;
            }
            const hOverlap =
                Math.min(chain.lastX + chain.lastW, item.x + item.w) - Math.max(chain.lastX, item.x);
            if (hOverlap / minW <= 0.45) {
                continue;
            }
            const vGap = item.y - (chain.lastY + chain.lastH);
            if (vGap >= -minH * 0.2 && vGap <= minH * 0.9) {
                target = chain;
                break;
            }
        }
        if (target) {
            target.items.push(item);
            target.lastX = item.x;
            target.lastY = item.y;
            target.lastW = item.w;
            target.lastH = item.h;
        } else {
            chains.push({
                items: [item],
                lastX: item.x,
                lastY: item.y,
                lastW: item.w,
                lastH: item.h,
            });
        }
    }

    const result = [];
    for (const chain of chains) {
        if (chain.items.length >= 2) {
            for (const item of chain.items) {
                used.add(item);
            }
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let text = '';
            const widths = [];
            const bgs = [];
            const fgs = [];
            const weights = [];
            for (const item of chain.items) {
                minX = Math.min(minX, item.x);
                minY = Math.min(minY, item.y);
                maxX = Math.max(maxX, item.x + item.w);
                maxY = Math.max(maxY, item.y + item.h);
                text = text ? joinLineText(text, item.text.trim()) : item.text.trim();
                widths.push(item.lineSize > 0 ? item.lineSize : item.w);
                if (item.bgColor) {
                    bgs.push(item.bgColor);
                }
                if (item.fgColor) {
                    fgs.push(item.fgColor);
                }
                weights.push(item.fontWeight || 400);
            }
            result.push({
                x: minX,
                y: minY,
                w: maxX - minX,
                h: maxY - minY,
                text,
                vertical: true,
                lineSize: median(widths),
                bgColor: averageColors(bgs),
                fgColor: averageColors(fgs),
                fontWeight: Math.round(median(weights)) || 400,
            });
        }
    }

    for (const line of lines) {
        if (!used.has(line)) {
            result.push(line);
        }
    }
    return result;
}

/**
 * Merge OCR line boxes that belong to the same paragraph.
 * Supports top-to-bottom horizontal paragraphs and right-to-left vertical columns.
 */
export function mergeLineBoxes(lines) {
    const normalized = (lines ?? [])
        .filter((line) => line && typeof line.text === 'string' && line.text.trim() !== '' && line.w > 0 && line.h > 0)
        .map((line) => ({
            ...line,
            vertical: Boolean(line.vertical),
            bgColor: Array.isArray(line.bgColor) && line.bgColor.length === 3 ? line.bgColor : null,
            fgColor: Array.isArray(line.fgColor) && line.fgColor.length === 3 ? line.fgColor : null,
            fontWeight: Number(line.fontWeight) || 400,
        }));

    if (normalized.length === 0) {
        return [];
    }

    const prepared = chainSingleCharVerticalColumns(normalized);
    const horizLines = prepared.filter((l) => !l.vertical).sort((a, b) => a.y - b.y || a.x - b.x);
    const vertLines = prepared
        .filter((l) => l.vertical)
        .sort((a, b) => b.x + b.w - (a.x + a.w) || a.y - b.y);

    const blocks = [];

    for (const line of horizLines) {
        const lineText = line.text.trim();
        const lineSize = Number(line.lineSize) > 0 ? Number(line.lineSize) : line.h;
        let target = null;

        for (let i = blocks.length - 1; i >= 0; i -= 1) {
            const block = blocks[i];
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
            if (line.fgColor) {
                target.fgSamples.push(line.fgColor);
            }
            target.fontWeights.push(line.fontWeight || 400);
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
                vertical: false,
                lineSizes: [lineSize],
                bgSamples: line.bgColor ? [line.bgColor] : [],
                fgSamples: line.fgColor ? [line.fgColor] : [],
                fontWeights: [line.fontWeight || 400],
            });
        }
    }

    const vertBlocks = [];
    for (const line of vertLines) {
        const lineText = line.text.trim();
        const lineSize = Number(line.lineSize) > 0 ? Number(line.lineSize) : line.w;
        let target = null;

        for (let i = vertBlocks.length - 1; i >= 0; i -= 1) {
            const block = vertBlocks[i];
            const minW = Math.max(1, Math.min(block.lastLineW, line.w));
            const maxW = Math.max(block.lastLineW, line.w);
            if (maxW / minW > 1.65) {
                continue;
            }
            const gap = block.lastLineX - (line.x + line.w);
            if (gap < -minW * 0.35 || gap > minW * 1.25) {
                continue;
            }
            const overlap =
                Math.min(block.lastLineY + block.lastLineH, line.y + line.h) -
                Math.max(block.lastLineY, line.y);
            const minHeight = Math.min(block.lastLineH, line.h);
            if (minHeight <= 0 || overlap / minHeight <= 0.25) {
                continue;
            }
            if (Math.abs(line.y - block.y) > Math.max(maxW * 2.5, block.h * 0.35)) {
                continue;
            }
            target = block;
            break;
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
            if (line.fgColor) {
                target.fgSamples.push(line.fgColor);
            }
            target.fontWeights.push(line.fontWeight || 400);
        } else {
            vertBlocks.push({
                x: line.x,
                y: line.y,
                w: line.w,
                h: line.h,
                lastLineX: line.x,
                lastLineY: line.y,
                lastLineW: line.w,
                lastLineH: line.h,
                text: lineText,
                vertical: true,
                lineSizes: [lineSize],
                bgSamples: line.bgColor ? [line.bgColor] : [],
                fgSamples: line.fgColor ? [line.fgColor] : [],
                fontWeights: [line.fontWeight || 400],
            });
        }
    }

    return [...blocks, ...vertBlocks].map(
        ({ x, y, w, h, text, vertical, lineSizes, bgSamples, fgSamples, fontWeights }) => ({
            x,
            y,
            w,
            h,
            text,
            vertical,
            lineSize: median(lineSizes),
            lineCount: lineSizes.length,
            bgColor: averageColors(bgSamples),
            fgColor: averageColors(fgSamples),
            fontWeight: Math.round(median(fontWeights)) || 400,
        })
    );
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
        const rawX = block.x / factor;
        const rawY = block.y / factor;
        const rawW = block.w / factor;
        const rawH = block.h / factor;
        const left = Math.max(0, Math.min(cssWidth, rawX));
        const top = Math.max(0, Math.min(cssHeight, rawY));
        const right = Math.max(left, Math.min(cssWidth, rawX + rawW));
        const bottom = Math.max(top, Math.min(cssHeight, rawY + rawH));
        const w = Math.max(Math.min(1, cssWidth - left), right - left);
        const h = Math.max(Math.min(1, cssHeight - top), bottom - top);
        const axisSpan = vertical ? cssWidth : cssHeight;
        const nLineSize =
            Number.isFinite(block.lineSize) && block.lineSize > 0
                ? block.lineSize / factor / axisSpan
                : null;
        const lineCount =
            Number.isInteger(block.lineCount) && block.lineCount > 0 ? block.lineCount : null;

        return {
            id: index,
            nx: left / cssWidth,
            ny: top / cssHeight,
            nw: w / cssWidth,
            nh: h / cssHeight,
            text: block.text,
            vertical,
            nLineSize,
            lineCount,
            bgColor: block.bgColor ?? null,
            fgColor: block.fgColor ?? null,
            fontWeight: block.fontWeight || 400,
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
        const charCount = Array.from(String(text ?? '').replace(/\s+/g, '')).length;
        if (nonEmptyLines === 1 && charCount >= 4 && blockWidth > 0 && blockHeight > 0) {
            const areaCap = Math.max(
                OVERLAY_MIN_FONT_SIZE,
                Math.sqrt((blockWidth * blockHeight * 0.55) / charCount)
            );
            raw = Math.min(raw, areaCap);
        }
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

function relativeLuminance(r, g, b) {
    const toLinear = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(rgb1, rgb2) {
    const l1 = relativeLuminance(rgb1[0], rgb1[1], rgb1[2]);
    const l2 = relativeLuminance(rgb2[0], rgb2[1], rgb2[2]);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function computeBlockColors(bgColor, themeMode, appResolvedTheme, opacity, fgColor = null) {
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

    let color = useDark ? '#f4f4f5' : '#111111';
    if ((!themeMode || themeMode === 'auto') && Array.isArray(fgColor) && fgColor.length === 3) {
        const fg = fgColor.map((v) => Math.min(255, Math.max(0, Math.round(Number(v) || 0))));
        if (contrastRatio(fg, rgb) >= 4.2) {
            color = `rgb(${fg[0]},${fg[1]},${fg[2]})`;
        }
    }

    const borderColor = useDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)';
    return {
        background: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`,
        color,
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

/**
 * The overlay window reserves a 32px strip for the toolbar at creation time
 * (above or below the selected region, or inside it when there is no room).
 * Toggling the toolbar therefore never moves or resizes the native window: the
 * WebView is never re-composited (no flash of the original screen) and the
 * translation blocks keep their exact pixel positions.
 */
export function computeOverlayContentRect({
    locked,
    viewport,
    placement = 'inside',
    toolbarHeight = 32,
}) {
    const vw = Math.max(1, Number(viewport?.width) || 1);
    const vh = Math.max(1, Number(viewport?.height) || 1);
    const atTop = placement === 'top';
    const atBottom = placement === 'bottom';
    const strip = atTop || atBottom ? Math.max(0, Number(toolbarHeight) || 0) : 0;

    return {
        toolbarAtBottom: atBottom,
        toolbarVisible: !locked,
        contentLeft: 0,
        contentTop: atTop ? strip : 0,
        contentWidth: vw,
        contentHeight: Math.max(1, vh - strip),
    };
}
