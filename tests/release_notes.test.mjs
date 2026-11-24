import test from 'node:test';
import assert from 'node:assert/strict';

import { extractReleaseNotes } from '../.scripts/extract-release-notes.mjs';

const SAMPLE_CHANGELOG = `## 3.0.25 (2026-11-24)

### Bugs fixed:

-   Fix overlay font direction and size matching.
-   Fix overlay window sizing on high-DPI displays.
-   Publish per-tag release notes instead of the entire CHANGELOG.

## 3.0.24 (2026-11-23)

### Bugs fixed:

-   Fix settings reverting after restart.

## 3.0.22 (2026-11-23)

### New features:

-   Feature A
-   Feature B

### Improvements:

-   Improvement C
-   Improvement D

### Bugs fixed:

-   Fix E
-   Fix F
`;

test('extractReleaseNotes extracts only the requested version and omits older versions', () => {
    const notes25 = extractReleaseNotes(SAMPLE_CHANGELOG, 'v3.0.25');
    assert.ok(notes25.includes('Fix overlay font direction and size matching.'));
    assert.ok(!notes25.includes('3.0.24'));
    assert.ok(!notes25.includes('Fix settings reverting'));
    assert.ok(!notes25.includes('### Bugs fixed:'));

    const notes24 = extractReleaseNotes(SAMPLE_CHANGELOG, '3.0.24');
    assert.equal(notes24, '-   Fix settings reverting after restart.');

    const notes22 = extractReleaseNotes(SAMPLE_CHANGELOG, '3.0.22');
    assert.ok(notes22.includes('### New features:'));
    assert.ok(notes22.includes('Fix F'));
    assert.ok(!notes22.includes('3.0.24'));
});

test('extractReleaseNotes returns fallback when version is missing', () => {
    assert.equal(extractReleaseNotes(SAMPLE_CHANGELOG, '9.9.9'), 'Release 9.9.9');
});
