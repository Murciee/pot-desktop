import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractReleaseNotes(changelogText, version) {
    const cleanVersion = String(version ?? '')
        .trim()
        .replace(/^v/i, '');
    if (!cleanVersion) {
        return '';
    }

    const lines = String(changelogText ?? '').split(/\r?\n/);
    const headerPattern = new RegExp(`^##\\s+v?${escapeRegExp(cleanVersion)}(?:\\s|\\(|$)`, 'i');
    const anyVersionPattern = /^##\s+/;

    let startIndex = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (headerPattern.test(lines[i].trim())) {
            startIndex = i + 1;
            break;
        }
    }

    if (startIndex === -1) {
        return `Release ${cleanVersion}`;
    }

    let endIndex = lines.length;
    for (let i = startIndex; i < lines.length; i += 1) {
        if (anyVersionPattern.test(lines[i].trim())) {
            endIndex = i;
            break;
        }
    }

    const bodyLines = lines.slice(startIndex, endIndex);
    const trimmed = bodyLines.join('\n').trim();
    if (!trimmed) {
        return `Release ${cleanVersion}`;
    }

    // Keep short single-version releases crisp without redundant category headings when <= 5 bullets.
    const bullets = bodyLines.filter((line) => /^\s*[-*]\s+/.test(line));
    const subheadings = bodyLines.filter((line) => /^\s*###\s+/.test(line));
    if (bullets.length > 0 && bullets.length <= 5 && subheadings.length > 0) {
        return bodyLines
            .filter((line) => !/^\s*###\s+/.test(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    return trimmed;
}

export function formatUpdaterNotes(version, changelog) {
    const cleanVersion = String(version ?? '').trim();
    const cleanBody = String(changelog ?? '').trim();
    if (!cleanBody) {
        return cleanVersion ? `## ${cleanVersion}` : '';
    }
    if (/^\s*#{1,2}\s+v?\d+\.\d+/i.test(cleanBody)) {
        return cleanBody;
    }
    return cleanVersion ? `## ${cleanVersion}\n\n${cleanBody}` : cleanBody;
}

const isMain =
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const version = process.argv[2] ?? '';
    const changelogPath = process.argv[3] ?? 'CHANGELOG';
    const text = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    process.stdout.write(`${extractReleaseNotes(text, version)}\n`);
}
