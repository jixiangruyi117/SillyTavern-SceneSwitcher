import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SwitchQueue,
    applyScene,
    createSceneFromCurrent,
    normalizeScene,
    normalizeStore,
    saveScene,
} from '../modules/SceneModel.js';
import { applyThemeWithOptionalPreferences, DEFAULT_THEME_PREFERENCE_KEYS, normalizeThemePreferenceKeys } from '../modules/ThemePreferenceBridge.js';
import { syncThemePreferenceControls } from '../modules/ThemePreferenceControls.js';
import { configureNativeApiProfileFields, getApiOnlyProfiles, getImportableApiProfiles, isApiOnlyProfile } from '../modules/ApiOnlyProfile.js';
import { normalizeApiProfiles, removeApiProfile, saveApiProfile } from '../modules/ApiProfileModel.js';
import { applyApiCustomProfile } from '../modules/ApiProfileBridge.js';
import { createCharacterSearchIndex, createTimedQueryCache, findCharacters, findCharactersInIndex, findPersonas, normalizeChatSearchResults, paginateCharacters } from '../modules/QuickPickerModel.js';
import { clampFloatingPosition, normalizeFloatingPosition } from '../modules/FloatingPosition.js';
import { normalizeFloatingAppearance, normalizeFloatingImageUrl } from '../modules/FloatingAppearance.js';
import { applySceneWithRecovery, getRecoverableKeys } from '../modules/SceneRecovery.js';
import { createSwitchHistoryEntry, markRecentCharacter, normalizeApiTestHistory, normalizeSwitchHistory } from '../modules/SwitchHistory.js';

const current = {
    api: 'openai',
    characterAvatar: 'alice.png',
    characterName: 'Alice',
    presetApi: 'openai',
    presetName: 'Default',
    themeName: 'Tavern',
};

function adapter(calls, overrides = {}) {
    return {
        getCurrent: () => current,
        hasConnectionProfile: () => true,
        getConnectionProfileApi: () => 'openai',
        hasApi: () => true,
        hasCharacter: () => true,
        hasPreset: () => true,
        hasTheme: () => true,
        applyApi: async value => calls.push(`api:${value}`),
        applyCharacter: async value => calls.push(`character:${value}`),
        applyPreset: async (value, api) => calls.push(`preset:${api}:${value}`),
        applyTheme: async value => calls.push(`theme:${value}`),
        ...overrides,
    };
}

test('saved scenes normalize invalid records and preserve optional bindings only', () => {
    const valid = createSceneFromCurrent(current, 'one', 1);
    const store = normalizeStore({
        scenes: [valid, { ...valid }, { id: '' }],
        recents: ['one', 'missing'],
    });
    assert.equal(store.scenes.length, 1);
    assert.deepEqual(store.recents, ['one']);

    const noTheme = { ...valid, scope: { ...valid.scope, theme: false } };
    const saved = saveScene(store, noTheme);
    assert.equal(saved.scenes[0].scope.theme, false);
    assert.deepEqual(saved.themePreferenceKeys, DEFAULT_THEME_PREFERENCE_KEYS);
    assert.equal(saved.showFloatingSwitcher, false);
    assert.equal(saved.floatingPosition, null);
    assert.deepEqual(saved.floatingAppearance, { accent: 'coral', imageUrl: '' });
    assert.equal(normalizeStore({ showFloatingSwitcher: true }).showFloatingSwitcher, true);
    assert.equal(normalizeStore({ floatingOpenMode: 'longpress' }).floatingOpenMode, 'longpress');
    assert.equal(normalizeStore({ floatingOpenMode: 'anything-else' }).floatingOpenMode, 'tap');
    assert.deepEqual(normalizeStore({ floatingPosition: { x: 23.6, y: 47.2 } }).floatingPosition, { x: 24, y: 47 });
});

test('scene groups are trimmed, persisted, and limited to a compact label', () => {
    const grouped = normalizeScene({ id: 'grouped', name: 'Grouped', group: '  Daily  ' });
    assert.equal(grouped.group, 'Daily');
    assert.equal(normalizeScene({ group: 'x'.repeat(50) }).group.length, 40);
    const store = saveScene(normalizeStore({}), grouped);
    assert.equal(store.scenes[0].group, 'Daily');
});

test('floating appearance accepts supported accents and HTTPS image links only', () => {
    assert.equal(normalizeFloatingImageUrl('https://cdn.example.com/ball.png?style=1'), 'https://cdn.example.com/ball.png?style=1');
    assert.equal(normalizeFloatingImageUrl('http://cdn.example.com/ball.png'), '');
    assert.equal(normalizeFloatingImageUrl('javascript:alert(1)'), '');
    assert.deepEqual(normalizeFloatingAppearance({ accent: 'violet', imageUrl: 'https://cdn.example.com/ball.png' }), {
        accent: 'violet', imageUrl: 'https://cdn.example.com/ball.png',
    });
    assert.deepEqual(normalizeFloatingAppearance({ accent: 'unknown', imageUrl: 'bad url' }), { accent: 'coral', imageUrl: '' });
});

test('floating switcher position is persisted safely and stays inside a resized viewport', () => {
    assert.equal(normalizeFloatingPosition({ x: 'bad', y: 10 }), null);
    assert.deepEqual(clampFloatingPosition({ x: 480, y: 900 }, { width: 360, height: 640 }), { x: 308, y: 588 });
    assert.deepEqual(clampFloatingPosition({ x: -30, y: -1 }, { width: 360, height: 640 }), { x: 8, y: 8 });
});

test('character picker searches both native and embedded tags, then favors relevant favorites', () => {
    const characters = [
        { avatar: 'alice.png', name: '爱丽丝', fav: 'true' },
        { avatar: 'bob.png', name: '鲍勃', data: { tags: ['奇幻'] } },
        { avatar: 'cindy.png', name: '辛迪' },
    ];
    const tags = [{ id: 'tag-1', name: '科幻' }];
    const tagMap = { 'alice.png': ['tag-1'] };

    assert.deepEqual(findCharacters(characters, tags, tagMap, '科幻').map(item => item.avatar), ['alice.png']);
    assert.deepEqual(findCharacters(characters, tags, tagMap, '奇幻').map(item => item.avatar), ['bob.png']);
    assert.deepEqual(findCharacters(characters, tags, tagMap, '', { favoritesOnly: true }).map(item => item.avatar), ['alice.png']);
});

test('character picker keeps favorite entries first and then prioritizes recently used characters', () => {
    const characters = [
        { avatar: 'alice.png', name: '爱丽丝', fav: true },
        { avatar: 'bob.png', name: '鲍勃' },
        { avatar: 'cindy.png', name: '辛迪' },
    ];
    assert.deepEqual(findCharacters(characters, [], {}, '', { recentAvatars: ['cindy.png', 'bob.png'] }).map(item => item.avatar), [
        'alice.png', 'cindy.png', 'bob.png',
    ]);
    assert.deepEqual(markRecentCharacter(['bob.png', 'cindy.png'], 'cindy.png'), ['cindy.png', 'bob.png']);
});

test('character picker builds its search index once and pages matching results without rendering every match', () => {
    const characters = Array.from({ length: 25 }, (_, index) => ({ avatar: `card-${index}.png`, name: `角色 ${String(index).padStart(2, '0')}` }));
    const index = createCharacterSearchIndex(characters, [], {});
    const matches = findCharactersInIndex(index, '角色');
    const first = paginateCharacters(matches, 1, 12);
    const last = paginateCharacters(matches, 99, 12);
    assert.equal(index.length, 25);
    assert.equal(first.items.length, 12);
    assert.equal(first.pageCount, 3);
    assert.equal(last.page, 3);
    assert.equal(last.items.length, 1);
});

test('chat search results keep only usable native chat entries and mark the active one', () => {
    assert.deepEqual(normalizeChatSearchResults([
        { file_name: '第一章', preview_message: '你好', last_mes: '2026-08-09', message_count: 12 },
        { file_name: '第一章', preview_message: '重复', message_count: 2 },
        { file_name: '', preview_message: '无效' },
    ], '第一章'), [{
        id: '第一章', preview: '你好', lastMessage: '2026-08-09', messageCount: 12, current: true,
    }]);
});

test('chat result pages keep the mounted list bounded for long histories', () => {
    const chats = Array.from({ length: 25 }, (_, index) => ({ id: `chat-${index}` }));
    const second = paginateCharacters(chats, 2, 12);
    const last = paginateCharacters(chats, 3, 12);
    assert.equal(second.items.length, 12);
    assert.equal(second.items[0].id, 'chat-12');
    assert.equal(last.items.length, 1);
});

test('short-lived chat cache avoids repeated identical searches without retaining stale results', () => {
    const cache = createTimedQueryCache({ limit: 2, ttlMs: 50 });
    cache.set('alice:hello', ['one'], 100);
    assert.deepEqual(cache.get('alice:hello', 149), ['one']);
    assert.equal(cache.get('alice:hello', 151), null);
    cache.set('one', 1, 200);
    cache.set('two', 2, 200);
    cache.set('three', 3, 200);
    assert.equal(cache.get('one', 200), null);
    assert.equal(cache.get('three', 200), 3);
});

test('connected personas are ordered before the current and default personas', () => {
    const personas = findPersonas(['a.png', 'b.png', 'c.png'], {
        personas: { 'a.png': 'Alpha', 'b.png': 'Beta', 'c.png': 'Gamma' },
        persona_descriptions: { 'b.png': { title: 'Bound', description: 'A complete persona description.' } },
        default_persona: 'c.png',
    }, { connectedIds: ['b.png'], currentAvatar: 'a.png' });
    assert.deepEqual(personas.map(persona => persona.avatar), ['b.png', 'a.png', 'c.png']);
    assert.equal(personas[0].description, 'A complete persona description.');
    assert.deepEqual(findPersonas(['a.png', 'b.png'], { personas: { 'a.png': 'Alpha', 'b.png': 'Beta' } }, { query: 'bet' }).map(item => item.avatar), ['b.png']);
});

test('a scene is preflight-validated before any setting is changed', async () => {
    const calls = [];
    const scene = createSceneFromCurrent(current, 'bad', 1);
    const result = await applyScene(scene, adapter(calls, { hasCharacter: () => false }));
    assert.equal(result.applied, false);
    assert.equal(calls.length, 0);
});

test('scene application uses native actions in stable order', async () => {
    const calls = [];
    const scene = createSceneFromCurrent(current, 'ordered', 1);
    const result = await applyScene(scene, adapter(calls));
    assert.equal(result.applied, true);
    assert.deepEqual(calls, [
        'api:openai',
        'character:alice.png',
        'preset:openai:Default',
        'theme:Tavern',
    ]);
});

test('a failed scene restores only independently safe bindings and never reapplies a theme', async () => {
    const calls = [];
    const target = createSceneFromCurrent({
        ...current,
        api: 'new-api',
        characterAvatar: 'target.png',
        characterName: 'Target',
        themeName: 'Target Theme',
    }, 'recovery', 1);
    const result = await applySceneWithRecovery(target, adapter(calls, {
        applyCharacter: async value => {
            calls.push(`character:${value}`);
            throw new Error('角色切换失败');
        },
    }), {
        ...current,
        api: 'old-api',
        connectionProfileId: '',
    });
    assert.equal(result.applied, false);
    assert.deepEqual(result.recovered, ['api']);
    assert.deepEqual(result.unrecovered, []);
    assert.deepEqual(calls, ['api:new-api', 'character:target.png', 'api:old-api']);
    assert.deepEqual(getRecoverableKeys({ ...current, api: 'old-api', connectionProfileId: '' }, ['api', 'theme']), ['api']);
});

test('switch and API test histories retain only references and bounded safe fields', () => {
    const history = normalizeSwitchHistory([createSwitchHistoryEntry({
        id: 'switch-1',
        at: 1,
        label: '组合：主力',
        changed: ['api', 'character', 'unknown'],
        reversible: ['api', 'theme'],
        before: { api: 'openai', managedApiProfileId: 'api-1', apiKey: 'must-not-be-stored' },
    })]);
    assert.deepEqual(history[0].changed, ['api', 'character']);
    assert.deepEqual(history[0].reversible, ['api']);
    assert.equal(JSON.stringify(history).includes('must-not-be-stored'), false);
    assert.deepEqual(normalizeApiTestHistory([{ id: 'test-1', profileId: 'api-1', profileName: '主力', startedAt: 1, finishedAt: 2, status: 'success', apiKey: 'must-not-be-stored' }]), [{
        id: 'test-1', profileId: 'api-1', profileName: '主力', startedAt: 1, finishedAt: 2, status: 'success',
    }]);
});

test('a saved preset stays independent from the API selected by the scene', async () => {
    const calls = [];
    const scene = createSceneFromCurrent({ ...current, api: 'kobold', presetApi: 'openai' }, 'preset-only', 1);
    let presetLookup;
    const result = await applyScene(scene, adapter(calls, {
        hasPreset: (api, name) => {
            presetLookup = `${api}:${name}`;
            return true;
        },
    }));
    assert.equal(result.applied, true);
    assert.equal(presetLookup, 'openai:Default');
    assert.ok(calls.includes('api:kobold'));
    assert.ok(calls.includes('preset:openai:Default'));
});

test('a native connection profile replaces the fallback API type and runs first', async () => {
    const calls = [];
    const scene = createSceneFromCurrent({
        ...current,
        connectionProfileId: 'profile-1',
        connectionProfileName: '主力 OpenAI',
    }, 'profile-scene', 1);
    const result = await applyScene(scene, adapter(calls, {
        applyConnectionProfile: async value => calls.push(`profile:${value}`),
    }));
    assert.equal(result.applied, true);
    assert.equal(scene.scope.api, false);
    assert.deepEqual(calls, [
        'profile:profile-1',
        'character:alice.png',
        'preset:openai:Default',
        'theme:Tavern',
    ]);
});

test('a missing native connection profile prevents every setting from changing', async () => {
    const calls = [];
    const scene = createSceneFromCurrent({
        ...current,
        connectionProfileId: 'missing-profile',
        connectionProfileName: '已删除档案',
    }, 'missing-profile-scene', 1);
    const result = await applyScene(scene, adapter(calls, { hasConnectionProfile: () => false }));
    assert.equal(result.applied, false);
    assert.equal(calls.length, 0);
});

test('switch queue declines repeated triggering while a switch is running', async () => {
    const queue = new SwitchQueue();
    let release;
    const running = queue.run(() => new Promise(resolve => { release = resolve; }));
    const duplicate = await queue.run(async () => 'should not run');
    assert.deepEqual(duplicate, { skipped: true, reason: 'busy' });
    release('done');
    assert.equal(await running, 'done');
});

test('theme switch restores personal preferences only after the native theme is applied', async () => {
    const originalPreferences = {
        blur_strength: 0,
        shadow_width: 0,
        font_scale: 1.15,
        fast_ui_mode: true,
        chat_width: 72,
        avatar_style: 2,
        noShadows: true,
        custom_css: '.custom { color: red; }',
    };
    const targetThemeDefaults = Object.fromEntries(DEFAULT_THEME_PREFERENCE_KEYS.map(key => [key, `theme-${key}`]));
    const powerUserModule = {
        power_user: { ...originalPreferences, themeColor: '#111111' },
        applyPowerUserSettingsCalls: 0,
        applyPowerUserSettings() { this.applyPowerUserSettingsCalls += 1; },
    };
    let currentThemeName = '旧主题';
    let saveCalls = 0;

    const preferencesRestored = await applyThemeWithOptionalPreferences({
        name: '新主题',
        preservePreferences: true,
        preferenceKeys: DEFAULT_THEME_PREFERENCE_KEYS,
        getCurrentThemeName: () => currentThemeName,
        applyNativeTheme: async name => {
            currentThemeName = name;
            Object.assign(powerUserModule.power_user, targetThemeDefaults, { themeColor: '#eeeeee' });
        },
        powerUserModule,
        saveSettingsDebounced: () => { saveCalls += 1; },
    });

    assert.equal(preferencesRestored, true);
    assert.equal(currentThemeName, '新主题');
    assert.deepEqual(Object.fromEntries(DEFAULT_THEME_PREFERENCE_KEYS.map(key => [key, powerUserModule.power_user[key]])), originalPreferences);
    assert.equal(powerUserModule.power_user.themeColor, '#eeeeee');
    assert.equal(powerUserModule.applyPowerUserSettingsCalls, 1);
    assert.equal(saveCalls, 1);
});

test('theme preference selection persists only supported keys and allows the user to select none', () => {
    assert.deepEqual(normalizeThemePreferenceKeys(['blur_strength', 'unknown', 'blur_strength']), ['blur_strength']);
    assert.deepEqual(normalizeThemePreferenceKeys([]), []);
    assert.deepEqual(normalizeThemePreferenceKeys(undefined), DEFAULT_THEME_PREFERENCE_KEYS);

    const configuredStore = normalizeStore({ themePreferenceKeys: ['noShadows'] });
    const savedStore = saveScene(configuredStore, createSceneFromCurrent(current, 'with-preferences', 2));
    assert.deepEqual(savedStore.themePreferenceKeys, ['noShadows']);
});

test('theme switch restores only the preference keys selected by the user', async () => {
    const powerUserModule = {
        power_user: { noShadows: true, font_scale: 1.2 },
        applyPowerUserSettings() {},
    };

    await applyThemeWithOptionalPreferences({
        name: '新主题',
        preservePreferences: true,
        preferenceKeys: ['noShadows'],
        getCurrentThemeName: () => '旧主题',
        applyNativeTheme: async () => Object.assign(powerUserModule.power_user, { noShadows: false, font_scale: 0.9 }),
        powerUserModule,
    });

    assert.equal(powerUserModule.power_user.noShadows, true);
    assert.equal(powerUserModule.power_user.font_scale, 0.9);
});

test('preference checkbox interaction updates the controls without rerendering the panel', () => {
    const count = { textContent: '' };
    const inputs = [
        { dataset: { preferenceKey: 'blur_strength' }, checked: false },
        { dataset: { preferenceKey: 'noShadows' }, checked: true },
    ];
    const root = {
        querySelector: selector => selector === '[data-theme-preference-count]' ? count : null,
        querySelectorAll: selector => selector === '[data-preference-key]' ? inputs : [],
    };

    syncThemePreferenceControls(root, ['blur_strength']);

    assert.equal(count.textContent, '1');
    assert.equal(inputs[0].checked, true);
    assert.equal(inputs[1].checked, false);
});

test('only API-only native profiles are offered so a preset cannot be applied by profile switching', () => {
    const apiOnly = { id: 'api-only', name: '主力接口', mode: 'cc', api: 'openai', 'api-url': 'https://example.com', model: 'gpt-test', 'secret-id': 'secret-1', exclude: ['preset'] };
    const bundledPreset = { ...apiOnly, id: 'bundled', preset: '默认预设' };

    assert.equal(isApiOnlyProfile(apiOnly), true);
    assert.equal(isApiOnlyProfile(bundledPreset), false);
    assert.deepEqual(getApiOnlyProfiles([apiOnly, bundledPreset]), [apiOnly]);
});

test('new API configuration keeps only connection fields in the native profile dialog', () => {
    const fields = [
        { value: 'API', checked: true, events: 0, dispatchEvent() { this.events += 1; } },
        { value: 'Server URL', checked: true, events: 0, dispatchEvent() { this.events += 1; } },
        { value: 'Settings Preset', checked: true, events: 0, dispatchEvent() { this.events += 1; } },
        { value: 'Reasoning Template', checked: true, events: 0, dispatchEvent() { this.events += 1; } },
        { value: 'Secret', checked: true, events: 0, dispatchEvent() { this.events += 1; } },
        { value: 'Proxy Preset', checked: true, events: 0, dispatchEvent() { this.events += 1; } },
    ];

    assert.equal(configureNativeApiProfileFields(fields), 3);
    assert.equal(fields[0].checked, true);
    assert.equal(fields[1].checked, true);
    assert.equal(fields[2].checked, false);
    assert.equal(fields[3].checked, false);
    assert.equal(fields[4].checked, true);
    assert.equal(fields[5].checked, false);
    assert.equal(fields[2].events, 1);
    assert.equal(fields[3].events, 1);
    assert.equal(fields[5].events, 1);
});

test('managed API configurations preserve only native secret IDs, never raw keys', () => {
    const profile = {
        id: 'api-1',
        name: '主力接口',
        url: 'https://example.com/v1',
        model: 'test-model',
        secretId: 'native-secret-id',
        apiKey: 'must-not-be-stored',
    };
    const saved = saveApiProfile([], profile);
    assert.deepEqual(saved, [{
        id: 'api-1',
        name: '主力接口',
        url: 'https://example.com/v1',
        model: 'test-model',
        secretId: 'native-secret-id',
        updatedAt: 0,
    }]);
    assert.equal(JSON.stringify(saved).includes('must-not-be-stored'), false);
    assert.deepEqual(normalizeApiProfiles([{ ...profile, id: '' }]), []);
});

test('deleting a managed API configuration removes only its reference', () => {
    const profiles = saveApiProfile([], {
        id: 'api-1', name: '主力接口', url: 'https://example.com/v1', model: 'test-model', secretId: 'native-secret-id',
    });
    assert.deepEqual(removeApiProfile(profiles, 'api-1'), []);
});

test('managed API switching has a fixed API-only action boundary', async () => {
    const calls = [];
    await applyApiCustomProfile({
        id: 'api-1', name: '主力接口', url: 'https://example.com/v1', model: 'test-model', secretId: 'native-secret-id',
    }, {
        hasSecret: id => id === 'native-secret-id',
        ensureApiCustom: async () => calls.push('api-custom'),
        setCustomUrl: async value => calls.push(`url:${value}`),
        setCustomModel: async value => calls.push(`model:${value}`),
        setCustomSecret: async value => calls.push(`secret:${value}`),
    });
    assert.deepEqual(calls, [
        'api-custom',
        'url:https://example.com/v1',
        'model:test-model',
        'secret:native-secret-id',
    ]);
});

test('native connection profile import extracts only API connection fields', () => {
    const imported = getImportableApiProfiles([{
        id: 'native-1',
        name: '完整连接档案',
        api: 'custom',
        'api-url': 'https://example.com/v1',
        model: 'test-model',
        'secret-id': 'native-secret-id',
        preset: '不应导入',
        proxy: '不应导入',
        'regex-preset': '不应导入',
    }, {
        id: 'other-api',
        name: '非 Custom',
        api: 'kobold',
        'api-url': 'https://example.com',
        model: 'ignored',
        'secret-id': 'ignored',
    }]);
    assert.deepEqual(imported, [{
        sourceId: 'native-1',
        name: '完整连接档案',
        url: 'https://example.com/v1',
        model: 'test-model',
        secretId: 'native-secret-id',
    }]);
    assert.equal(JSON.stringify(imported).includes('不应导入'), false);
});
