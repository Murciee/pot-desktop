import fetch from 'node-fetch';
import fs from 'fs';

const REPO = 'Murciee/pot-desktop';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

async function resolveUpdater() {
    if (process.env.GITHUB_TOKEN === undefined) {
        throw new Error('GITHUB_TOKEN is required');
    }

    const TOKEN = process.env.GITHUB_TOKEN;
    let version = await getVersion(TOKEN);
    let changelog = await getChangeLog(TOKEN);

    const releaseBase = `https://github.com/${REPO}/releases/download/${version}`;

    const windows_x86_64 = `${releaseBase}/pot_${version}_x64-setup.nsis.zip`;
    const windows_x86_64_sig = await getSignature(`${releaseBase}/pot_${version}_x64-setup.nsis.zip.sig`);

    let updateData = {
        name: version,
        notes: changelog,
        pub_date: new Date().toISOString(),
        platforms: {
            'windows-x86_64': { signature: windows_x86_64_sig, url: windows_x86_64 },
        },
    };
    fs.writeFileSync('./update.json', JSON.stringify(updateData, null, 2));
}

async function getVersion(token) {
    const res = await fetch(LATEST_RELEASE_API, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.ok) {
        let data = await res.json();
        if (data['tag_name']) {
            return data['tag_name'];
        }
    }
}

async function getChangeLog(token) {
    const res = await fetch(LATEST_RELEASE_API, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.ok) {
        let data = await res.json();
        if (data['body']) {
            let changelog_md = data['body'];

            return changelog_md;
        }
    }
}

async function getSignature(url) {
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (response.ok) {
        return response.text();
    } else {
        return '';
    }
}

resolveUpdater().catch(console.error);
