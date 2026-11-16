export function removeNewlines(text) {
    return String(text ?? '')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.replace(/\-\s+/g, '').replace(/\s+/g, ' ').trim())
        .filter((paragraph) => paragraph !== '')
        .join('\n\n');
}
