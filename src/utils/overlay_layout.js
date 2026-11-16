function isCJK(char) {
    return /[\u3000-\u9fff\uf900-\ufaff]/.test(char ?? '');
}

function joinLineText(left, right) {
    if (left.endsWith('-')) {
        return left.slice(0, -1) + right;
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

/**
 * Merge OCR line boxes that belong to the same paragraph.
 * Lines are sorted by y; a line joins the previous block when the vertical gap
 * is below 0.7 x median line height and the horizontal overlap is above 25%.
 */
export function mergeLineBoxes(lines) {
    const valid = (lines ?? [])
        .filter((line) => line && typeof line.text === 'string' && line.text.trim() !== '' && line.w > 0 && line.h > 0)
        .map((line) => ({ ...line }))
        .sort((a, b) => a.y - b.y || a.x - b.x);

    if (valid.length === 0) {
        return [];
    }

    const medianHeight = median(valid.map((line) => line.h));
    const blocks = [];

    for (const line of valid) {
        let target = null;
        for (let i = blocks.length - 1; i >= 0; i -= 1) {
            const block = blocks[i];
            const gap = line.y - (block.y + block.h);
            const overlap =
                Math.min(block.x + block.w, line.x + line.w) - Math.max(block.x, line.x);
            const minWidth = Math.min(block.w, line.w);
            if (gap < medianHeight * 0.7 && minWidth > 0 && overlap / minWidth > 0.25) {
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
            target.text = joinLineText(target.text, line.text.trim());
        } else {
            blocks.push({
                x: line.x,
                y: line.y,
                w: line.w,
                h: line.h,
                text: line.text.trim(),
            });
        }
    }

    return blocks;
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

    return blocks.map((block, index) => ({
        id: index,
        nx: block.x / factor / cssWidth,
        ny: block.y / factor / cssHeight,
        nw: block.w / factor / cssWidth,
        nh: block.h / factor / cssHeight,
        text: block.text,
    }));
}
