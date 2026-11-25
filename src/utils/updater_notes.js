function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeVersionLabel(version) {
    return String(version ?? '')
        .trim()
        .replace(/^v+/i, '');
}

export function stripLeadingVersionHeading(markdown, version) {
    const cleanBody = String(markdown ?? '').trim();
    const cleanVersion = normalizeVersionLabel(version);
    if (!cleanBody || !cleanVersion) {
        return cleanBody;
    }

    const lines = cleanBody.split(/\r?\n/);
    const headingPattern = new RegExp(`^#{1,2}\\s+v?${escapeRegExp(cleanVersion)}(?:\\s|\\(|$)`, 'i');
    if (!headingPattern.test(lines[0].trim())) {
        return cleanBody;
    }

    let nextIndex = 1;
    while (nextIndex < lines.length && lines[nextIndex].trim() === '') {
        nextIndex += 1;
    }
    const rest = lines.slice(nextIndex).join('\n').trim();
    return rest || `Release ${cleanVersion}`;
}
