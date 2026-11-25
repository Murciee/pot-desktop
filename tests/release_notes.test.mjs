import test from 'node:test';
import assert from 'node:assert/strict';

import { extractReleaseNotes, formatUpdaterNotes } from '../.scripts/extract-release-notes.mjs';
import { normalizeVersionLabel, stripLeadingVersionHeading } from '../src/utils/updater_notes.js';

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

test('formatUpdaterNotes prepends version heading when missing and avoids duplicating an existing heading', () => {
    const bodyOnly = '-   Fix overlay window sizing.';
    assert.equal(formatUpdaterNotes('3.0.26', bodyOnly), '## 3.0.26\n\n-   Fix overlay window sizing.');

    const withHeading = '## 3.0.26 (2026-11-25)\n\n-   Fix overlay window sizing.';
    assert.equal(formatUpdaterNotes('3.0.26', withHeading), withHeading);
    assert.equal(formatUpdaterNotes('v3.0.26', ''), '## v3.0.26');
});

test('normalizeVersionLabel and stripLeadingVersionHeading handle both 3.0.25 and 3.0.26 manifest bodies', () => {
    assert.equal(normalizeVersionLabel(' v3.0.26 '), '3.0.26');
    assert.equal(normalizeVersionLabel(''), '');

    const bodyWithoutHeading = '-   Fix overlay font direction and size matching.';
    assert.equal(stripLeadingVersionHeading(bodyWithoutHeading, '3.0.25'), bodyWithoutHeading);

    const bodyWithHeading = '## 3.0.26 (2026-11-25)\n\n-   Fix overlay window sizing.';
    assert.equal(stripLeadingVersionHeading(bodyWithHeading, '3.0.26'), '-   Fix overlay window sizing.');

    const headingOnly = '## v3.0.26';
    assert.equal(stripLeadingVersionHeading(headingOnly, '3.0.26'), 'Release 3.0.26');
});
