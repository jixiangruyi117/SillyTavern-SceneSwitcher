import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('发布资源版本与包版本一致，避免浏览器继续使用旧扩展缓存', async () => {
    const [manifestText, packageText, indexText] = await Promise.all([
        readFile(new URL('manifest.json', root), 'utf8'),
        readFile(new URL('package.json', root), 'utf8'),
        readFile(new URL('index.js', root), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText);
    const packageInfo = JSON.parse(packageText);
    const version = packageInfo.version;

    assert.equal(manifest.version, version);
    assert.equal(manifest.js, `index.js?v=${version}`);
    assert.equal(manifest.css, `style.css?v=${version}`);
    const moduleVersions = [...indexText.matchAll(/from '\.\/modules\/[^']+\?v=([^']+)'/g)].map(match => match[1]);
    assert.ok(moduleVersions.length > 0);
    assert.ok(moduleVersions.every(moduleVersion => moduleVersion === version));
});
