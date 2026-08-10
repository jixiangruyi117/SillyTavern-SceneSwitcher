import {
    SwitchQueue,
    applyScene,
    cloneScene,
    createSceneFromCurrent,
    getEnabledBindingKeys,
    markRecent,
    normalizeStore,
    removeScene,
    saveScene,
} from './modules/SceneModel.js?v=0.3.21';
import { removeApiProfile, saveApiProfile } from './modules/ApiProfileModel.js?v=0.3.21';
import { applyApiCustomProfile } from './modules/ApiProfileBridge.js?v=0.3.21';
import {
    applyThemeWithOptionalPreferences,
    DEFAULT_THEME_PREFERENCE_KEYS,
    normalizeThemePreferenceKeys,
    THEME_PREFERENCE_OPTIONS,
} from './modules/ThemePreferenceBridge.js?v=0.3.21';
import { syncThemePreferenceControls } from './modules/ThemePreferenceControls.js?v=0.3.21';
import { configureNativeApiProfileFields, getApiOnlyProfiles, getImportableApiProfiles } from './modules/ApiOnlyProfile.js?v=0.3.21';
import { createCharacterSearchIndex, createTimedQueryCache, findCharactersInIndex, findPersonas, normalizeChatSearchResults, paginateCharacters } from './modules/QuickPickerModel.js?v=0.3.21';
import { clampFloatingPosition } from './modules/FloatingPosition.js?v=0.3.21';
import { FLOATING_ACCENTS, normalizeFloatingAppearance, normalizeFloatingImageUrl } from './modules/FloatingAppearance.js?v=0.3.21';
import {
    createSwitchHistoryEntry,
    markRecentCharacter,
    prependApiTestHistory,
    prependSwitchHistory,
    removeSwitchHistory,
} from './modules/SwitchHistory.js?v=0.3.21';
import { applySceneWithRecovery, createRecoveryScene, getRecoverableKeys } from './modules/SceneRecovery.js?v=0.3.21';

const EXTENSION_FOLDER = 'third-party/SillyTavern-SceneSwitcher';
const SETTINGS_KEY = 'srlSceneSwitcher';
const APP_ID = 'srl-scene-switcher-app';
const FLOATING_SWITCHER_ID = 'srl-scene-switcher-floating';
const PICKER_PORTAL_ID = 'srl-scene-switcher-picker-portal';
const CHARACTER_PAGE_SIZE = 12;
const chatSearchCache = createTimedQueryCache();
const SCENE_BINDING_LABELS = {
    connectionProfile: 'API 连接配置',
    api: 'API 类型',
    character: '角色卡',
    preset: '预设',
    theme: '美化主题',
};
const state = {
    store: null,
    editor: null,
    openPicker: null,
    characterQuery: '',
    characterFavoritesOnly: false,
    characterPage: 1,
    characterSearchIndex: null,
    chatQuery: '',
    chatItems: [],
    chatPage: 1,
    chatScope: null,
    chatLoading: false,
    chatError: '',
    personaQuery: '',
    personaSourceIds: [],
    personaItems: [],
    personaPage: 1,
    personaLoading: false,
    sceneResult: null,
    pickerPortal: false,
    floatingOpen: false,
    floatingView: 'main',
    notice: '',
    themeConfirmation: null,
    sceneConfirmation: null,
    apiProfileEditor: null,
};

const queue = new SwitchQueue();
let runtime = null;
let characterSearchTimer = null;
let chatSearchTimer = null;
let chatSearchAbortController = null;
let focusReturnTarget = null;
let keyboardEventsInstalled = false;
let floatingDrag = null;
let floatingDragFrame = 0;
let floatingLongPressTimer = 0;
let floatingClickSuppressed = false;
let floatingResizeInstalled = false;
let openPanelKeys = null;
let appEventsAbortController = null;

function scheduleFloatingFrame(callback) {
    return typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(callback)
        : globalThis.setTimeout(callback, 16);
}

function cancelFloatingFrame(handle) {
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
    else globalThis.clearTimeout(handle);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/gu, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

function createId() {
    return globalThis.crypto?.randomUUID?.() ?? `scene-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function captureOpenPanels(root) {
    const panels = [...root.querySelectorAll('details[data-panel-key]')];
    if (panels.length) openPanelKeys = new Set(panels.filter(panel => panel.open).map(panel => panel.dataset.panelKey));
}

function panelAttributes(key, defaultOpen = false) {
    const open = openPanelKeys === null ? defaultOpen : openPanelKeys.has(key);
    return ` data-panel-key="${key}"${open ? ' open' : ''}`;
}

function isSceneDrawerOpen() {
    const content = document.querySelector('#srl-scene-switcher > .inline-drawer-content');
    return content instanceof HTMLElement && getComputedStyle(content).display !== 'none';
}

function restoreSceneDrawer(shouldRestore) {
    if (!shouldRestore) return;
    const drawer = document.getElementById('srl-scene-switcher');
    const content = drawer?.querySelector(':scope > .inline-drawer-content');
    const icon = drawer?.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    if (!(content instanceof HTMLElement) || !(icon instanceof HTMLElement) || getComputedStyle(content).display !== 'none') return;
    icon.classList.remove('down', 'fa-circle-chevron-down');
    icon.classList.add('up', 'fa-circle-chevron-up');
    content.style.display = 'block';
}

function showToast(level, message) {
    globalThis.toastr?.[level]?.(message, '场景切换器', { timeOut: 5000, closeButton: true, preventDuplicates: true });
}

function requestThemeSwitch(nextThemeName) {
    const currentThemeName = getCurrentSnapshot().themeName;
    if (!nextThemeName || nextThemeName === currentThemeName) return Promise.resolve({ preservePreferences: false });
    return new Promise(resolve => {
        state.themeConfirmation = { currentThemeName, nextThemeName, resolve };
        render();
    });
}

function completeThemeConfirmation({ preservePreferences }) {
    const confirmation = state.themeConfirmation;
    if (!confirmation) return;
    state.themeConfirmation = null;
    render();
    confirmation.resolve({ preservePreferences });
}

function cancelThemeConfirmation() {
    const confirmation = state.themeConfirmation;
    if (!confirmation) return;
    state.themeConfirmation = null;
    render();
    confirmation.resolve(null);
}

function sceneChangePreview(scene) {
    const current = getCurrentSnapshot();
    const changes = [];
    if (scene.scope.connectionProfile) changes.push({ label: 'API 连接配置', from: current.connectionProfileName || '未使用连接配置', to: scene.bindings.connectionProfileName || '目标连接配置' });
    if (scene.scope.api) changes.push({ label: 'API 类型', from: current.api || '未选择', to: scene.bindings.api || '未选择' });
    if (scene.scope.character) changes.push({ label: '角色卡', from: current.characterName || '未选择', to: scene.bindings.characterName || '目标角色' });
    if (scene.scope.preset) changes.push({ label: '预设', from: current.presetName || '未选择', to: scene.bindings.presetName || '目标预设' });
    if (scene.scope.theme) changes.push({ label: '美化主题', from: current.themeName || '未选择', to: scene.bindings.themeName || '目标主题' });
    return changes;
}

function sceneBindingLabels(keys) {
    return keys.map(key => SCENE_BINDING_LABELS[key]).filter(Boolean);
}

function createSceneResult(scene, result) {
    const enabled = getEnabledBindingKeys(scene);
    const kept = Object.keys(SCENE_BINDING_LABELS).filter(key => !enabled.includes(key));
    const missing = result.applied ? [] : getMissingSceneBindings(scene);
    const errors = result.errors?.length
        ? result.errors
        : result.error instanceof Error ? [result.error.message] : [];
    return {
        sceneName: scene.name,
        applied: Boolean(result.applied),
        changed: sceneBindingLabels(result.changed ?? []),
        kept: sceneBindingLabels(kept),
        missing,
        recovered: sceneBindingLabels(result.recovered ?? []),
        errors,
    };
}

function requestSceneSwitch(scene) {
    if (!state.store.confirmSceneSwitch) return Promise.resolve(true);
    return new Promise(resolve => {
        state.sceneConfirmation = { sceneId: scene.id, sceneName: scene.name, changes: sceneChangePreview(scene), resolve };
        render();
    });
}

function completeSceneConfirmation(confirmed) {
    const confirmation = state.sceneConfirmation;
    if (!confirmation) return;
    state.sceneConfirmation = null;
    render();
    confirmation.resolve(confirmed);
}

function getStore(context) {
    const next = normalizeStore(context.extensionSettings?.[SETTINGS_KEY]);
    context.extensionSettings[SETTINGS_KEY] = next;
    return next;
}

function getManagedApiProfile(id) {
    return state.store.apiProfiles.find(profile => profile.id === id) ?? null;
}

function getManagedSecretLabel(id) {
    return runtime.secrets.getSecretLabelById?.(id) || '酒馆密钥引用已失效';
}

function getImportableNativeApiProfiles() {
    const profiles = runtime.context().extensionSettings?.connectionManager?.profiles;
    return getImportableApiProfiles(profiles).filter(candidate => !state.store.apiProfiles.some(profile => (
        profile.url === candidate.url
        && profile.model === candidate.model
        && profile.secretId === candidate.secretId
    )));
}

function getActiveCustomSecretId() {
    const secrets = runtime?.secrets?.secret_state?.[runtime.secrets.SECRET_KEYS.CUSTOM];
    return Array.isArray(secrets) ? secrets.find(secret => secret.active)?.id ?? '' : '';
}

function getCustomApiSnapshot() {
    const settings = runtime.context().chatCompletionSettings ?? {};
    const urlInput = document.getElementById('custom_api_url_text');
    const modelInput = document.getElementById('custom_model_id');
    return {
        url: String(settings.custom_url ?? urlInput?.value ?? '').trim(),
        model: String(settings.custom_model ?? modelInput?.value ?? '').trim(),
        secretId: getActiveCustomSecretId(),
    };
}

function getManagedApiProfileIdForCurrentState() {
    const current = getCustomApiSnapshot();
    return state.store?.apiProfiles.find(profile => (
        profile.url === current.url
        && profile.model === current.model
        && profile.secretId === current.secretId
    ))?.id ?? '';
}

function createApiProfileEditor(profile = null) {
    const current = profile ?? getCustomApiSnapshot();
    return {
        id: profile?.id ?? createId(),
        name: profile?.name ?? '',
        url: current.url,
        model: current.model,
        secretId: current.secretId,
    };
}

async function applyManagedApiProfile(id) {
    const profile = getManagedApiProfile(id);
    if (!profile) throw new Error('该 API 配置不存在或已被删除');
    const customSecretKey = runtime.secrets.SECRET_KEYS.CUSTOM;
    const source = document.getElementById('chat_completion_source');
    const url = document.getElementById('custom_api_url_text');
    const model = document.getElementById('custom_model_id');
    if (!(source instanceof HTMLSelectElement) || !(url instanceof HTMLInputElement) || !(model instanceof HTMLInputElement)) {
        throw new Error('当前酒馆版本未识别到 API Custom 的原生设置控件');
    }
    await applyApiCustomProfile(profile, {
        hasSecret: secretId => Array.isArray(runtime.secrets.secret_state?.[customSecretKey])
            && runtime.secrets.secret_state[customSecretKey].some(secret => secret.id === secretId),
        ensureApiCustom: async () => {
            if (![...runtime.apiSelect.options].some(option => option.value === 'openai')) {
                throw new Error('当前酒馆版本未提供 API Custom 所需的 OpenAI API 类型');
            }
            if (runtime.apiSelect.value !== 'openai') {
                runtime.apiSelect.value = 'openai';
                runtime.apiSelect.dispatchEvent(new Event('change', { bubbles: true }));
                await Promise.resolve();
            }
            if (source.value !== 'custom') {
                source.value = 'custom';
                source.dispatchEvent(new Event('change', { bubbles: true }));
                await Promise.resolve();
            }
        },
        setCustomUrl: async value => {
            if (url.value !== value) {
                url.value = value;
                url.dispatchEvent(new Event('input', { bubbles: true }));
            }
        },
        setCustomModel: async value => {
            if (model.value !== value) {
                model.value = value;
                model.dispatchEvent(new Event('input', { bubbles: true }));
            }
        },
        setCustomSecret: async secretId => {
            if (getActiveCustomSecretId() !== secretId) await runtime.secrets.rotateSecret(customSecretKey, secretId);
        },
    });
}

async function testManagedApiProfile(id) {
    await applyManagedApiProfile(id);
    const connectButton = document.getElementById('api_button_openai');
    if (!(connectButton instanceof HTMLElement)) {
        throw new Error('当前酒馆版本未识别到 API Custom 的原生“连接”按钮');
    }
    const context = runtime.context();
    const eventName = context.eventTypes?.ONLINE_STATUS_CHANGED;
    const eventSource = context.eventSource;
    const startedAt = Date.now();
    if (!eventName || typeof eventSource?.once !== 'function' || typeof eventSource?.removeListener !== 'function') {
        connectButton.click();
        return { startedAt, finishedAt: Date.now(), status: 'unconfirmed' };
    }
    return new Promise(resolve => {
        let finished = false;
        const finish = status => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            eventSource.removeListener(eventName, onStatus);
            resolve({ startedAt, finishedAt: Date.now(), status });
        };
        const onStatus = value => finish(value === 'no_connection' ? 'failed' : 'success');
        const timeout = setTimeout(() => finish('unconfirmed'), 12000);
        eventSource.once(eventName, onStatus);
        connectButton.click();
    });
}

function importNativeApiProfile(sourceId, context) {
    const source = getImportableNativeApiProfiles().find(profile => profile.sourceId === sourceId);
    if (!source) throw new Error('该酒馆连接档案不可导入，或已经导入过');
    state.store = {
        ...state.store,
        apiProfiles: saveApiProfile(state.store.apiProfiles, {
            id: createId(),
            name: source.name,
            url: source.url,
            model: source.model,
            secretId: source.secretId,
            updatedAt: Date.now(),
        }),
    };
    persist(context);
    state.notice = `已导入“${source.name}”的 API、URL、模型和密钥引用；预设等其他字段未导入。`;
}

async function saveManagedApiProfile(context) {
    const root = document.getElementById(APP_ID);
    const editor = state.apiProfileEditor;
    if (!root || !editor) return;
    const value = name => root.querySelector(`[data-api-profile-field="${name}"]`)?.value.trim() ?? '';
    const name = value('name');
    const url = value('url');
    const model = value('model');
    const apiKey = value('key');
    if (!name || !url || !model) throw new Error('请填写名称、Server URL 和模型');

    let secretId = editor.secretId;
    if (apiKey) {
        secretId = await runtime.secrets.writeSecret(runtime.secrets.SECRET_KEYS.CUSTOM, apiKey, name);
    }
    if (!secretId) throw new Error('请填写密钥；密钥会由酒馆原生安全存储保存');
    state.store = {
        ...state.store,
        apiProfiles: saveApiProfile(state.store.apiProfiles, { ...editor, name, url, model, secretId, updatedAt: Date.now() }),
    };
    persist(context);
    state.apiProfileEditor = null;
    state.notice = `已保存 API 配置“${name}”。密钥仅保存在酒馆的 Secrets 中。`;
}

function persist(context) {
    context.extensionSettings[SETTINGS_KEY] = state.store;
    context.saveSettingsDebounced?.();
}

function getCharacter(context, avatar) {
    return context.characters?.find(character => String(character.avatar ?? '') === String(avatar ?? '')) ?? null;
}

function getConnectionProfiles(context = runtime.context()) {
    const profiles = context.extensionSettings?.connectionManager?.profiles;
    return getApiOnlyProfiles(profiles);
}

function getConnectionProfile(context, id) {
    return getConnectionProfiles(context).find(profile => profile.id === id) ?? null;
}

function getProfileSelect() {
    const select = document.getElementById('connection_profiles');
    return select instanceof HTMLSelectElement ? select : null;
}

async function openNativeApiProfileCreate() {
    const createButton = document.getElementById('create_connection_profile');
    if (!(createButton instanceof HTMLElement)) {
        throw new Error('未找到酒馆原生“新建连接档案”入口，请先启用连接管理器扩展');
    }
    createButton.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const fields = [...document.querySelectorAll('input[name="exclude"]')];
        if (!fields.length) continue;
        configureNativeApiProfileFields(fields);
        showToast('info', '已预选 API、URL、模型和密钥引用；其余项目不会随此配置切换。');
        return;
    }
    showToast('warning', '已打开酒馆原生新建窗口；请只保留 API、Server URL、Model 和 Secret。');
}

function getCurrentSnapshot() {
    const context = runtime.context();
    const api = runtime.apiSelect.value;
    const profileSelect = runtime.profileSelect();
    const profile = profileSelect ? getConnectionProfile(context, profileSelect.value) : null;
    const character = context.characters?.[context.characterId] ?? null;
    const presetManager = runtime.presetModule.getPresetManager(api);
    const presetName = presetManager?.getSelectedPresetName?.() ?? '';
    return {
        api,
        connectionProfileId: profile?.id ?? '',
        connectionProfileName: profile?.name ?? '',
        characterAvatar: character?.avatar ?? '',
        characterName: character?.name ?? '',
        presetApi: api,
        presetName,
        themeName: runtime.themeSelect.value ?? '',
        managedApiProfileId: getManagedApiProfileIdForCurrentState(),
    };
}

function encodePresetSelection(api, name) {
    return JSON.stringify([api, name]);
}

function decodePresetSelection(value) {
    try {
        const [api, name] = JSON.parse(value);
        return typeof api === 'string' && typeof name === 'string' && api && name ? { api, name } : null;
    } catch {
        return null;
    }
}

function getPresetOptions(api = runtime.apiSelect.value) {
    const manager = runtime.presetModule.getPresetManager(api);
    return (manager?.getAllPresets?.() ?? []).map(name => ({
        value: encodePresetSelection(api, name),
        label: name,
    }));
}

function findNativePreset(name, preferredApi = '') {
    const apis = [...runtime.apiSelect.options].map(option => option.value);
    const orderedApis = [preferredApi, ...apis.filter(api => api !== preferredApi)];
    for (const api of orderedApis) {
        const manager = runtime.presetModule.getPresetManager(api);
        const preset = manager?.findPreset(name);
        if (preset) return { api, manager, preset };
    }
    return null;
}

function getAdapter({ preserveThemePreferences = false, themePreferenceKeys = state.store?.themePreferenceKeys ?? DEFAULT_THEME_PREFERENCE_KEYS } = {}) {
    return {
        getCurrent: getCurrentSnapshot,
        hasConnectionProfile: id => Boolean(getConnectionProfile(runtime.context(), id) && runtime.profileSelect()),
        getConnectionProfileApi: id => getConnectionProfile(runtime.context(), id)?.api || getCurrentSnapshot().api,
        hasApi: api => [...runtime.apiSelect.options].some(option => option.value === api),
        hasCharacter: avatar => Boolean(getCharacter(runtime.context(), avatar)),
        hasPreset: (api, name) => Boolean(findNativePreset(name, api)),
        hasTheme: name => [...runtime.themeSelect.options].some(option => option.value === name),
        applyApi: async api => {
            if (runtime.apiSelect.value === api) return;
            runtime.apiSelect.value = api;
            runtime.apiSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await Promise.resolve();
        },
        applyConnectionProfile: async id => {
            const context = runtime.context();
            const profile = getConnectionProfile(context, id);
            const profileSelect = runtime.profileSelect();
            if (!profile || !profileSelect || ![...profileSelect.options].some(option => option.value === id)) {
                throw new Error('API 连接档案不存在或酒馆原生连接档案不可用');
            }
            if (profileSelect.value === id) return;
            const loadedEvent = context.eventTypes?.CONNECTION_PROFILE_LOADED;
            if (!loadedEvent || typeof context.eventSource?.once !== 'function') {
                throw new Error('当前酒馆版本没有连接档案切换事件');
            }
            const finished = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('连接档案切换超时')), 20000);
                context.eventSource.once(loadedEvent, name => {
                    clearTimeout(timeout);
                    if (name === profile.name) resolve();
                    else reject(new Error('连接档案切换结果不匹配'));
                });
            });
            profileSelect.value = id;
            profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await finished;
        },
        applyCharacter: async avatar => {
            const context = runtime.context();
            const index = context.characters.findIndex(character => String(character.avatar ?? '') === avatar);
            if (index < 0) throw new Error('角色卡不存在');
            await context.selectCharacterById(index, { switchMenu: false });
            if (String(runtime.context().characters?.[runtime.context().characterId]?.avatar ?? '') !== avatar) {
                throw new Error('酒馆当前无法切换角色，请在生成或保存结束后重试');
            }
        },
        applyPreset: async (name, api) => {
            const match = findNativePreset(name, api);
            if (!match) throw new Error('预设不存在或已被删除');
            match.manager.selectPreset(match.preset);
            await Promise.resolve();
        },
        applyTheme: async name => {
            const preferencesRestored = await applyThemeWithOptionalPreferences({
                name,
                preservePreferences: preserveThemePreferences,
                preferenceKeys: themePreferenceKeys,
                getCurrentThemeName: () => runtime.themeSelect.value,
                applyNativeTheme: async themeName => {
                    runtime.themeSelect.value = themeName;
                    runtime.themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    await Promise.resolve();
                },
                powerUserModule: runtime.powerUserModule,
                saveSettingsDebounced: runtime.context().saveSettingsDebounced,
            });
            if (preferencesRestored) {
                showToast('info', '已保留个人美化偏好，主题配色已切换。');
            }
        },
    };
}

function appendSwitchHistory(context, { label, changed, reversible = [], before }) {
    const entry = createSwitchHistoryEntry({ id: createId(), label, changed, reversible, before });
    if (!entry) return;
    state.store = { ...state.store, switchHistory: prependSwitchHistory(state.store.switchHistory, entry) };
    persist(context);
}

function appendApiTestHistory(context, profile, result) {
    state.store = {
        ...state.store,
        apiTestHistory: prependApiTestHistory(state.store.apiTestHistory, {
            id: createId(),
            profileId: profile.id,
            profileName: profile.name,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            status: result.status,
        }),
    };
    persist(context);
}

async function restoreHistoryEntry(entry) {
    if (!entry?.reversible?.length) throw new Error('这次切换没有可安全恢复的项目。');
    if (entry.reversible.includes('managedApi')) {
        const profile = getManagedApiProfile(entry.before.managedApiProfileId);
        if (!profile) throw new Error('原 API 配置已删除，无法撤回。');
        await applyManagedApiProfile(profile.id);
        return 'API 配置';
    }
    const restoreScene = createRecoveryScene(entry.before, entry.reversible);
    const result = await applySceneWithRecovery(restoreScene, getAdapter(), getCurrentSnapshot());
    if (!result.applied) throw result.error instanceof Error ? result.error : new Error(result.errors?.join('；') || '撤回失败');
    return result.changed.join('、');
}

async function applyAndRecordHistory({ label, changed, task }) {
    const before = getCurrentSnapshot();
    const outcome = await runSafely(async () => {
        await task();
        return { applied: true };
    });
    if (!outcome?.applied) return false;
    const reversible = changed.includes('managedApi')
        ? (before.managedApiProfileId ? ['managedApi'] : [])
        : getRecoverableKeys(before, changed);
    appendSwitchHistory(runtime.context(), { label, changed, reversible, before });
    return true;
}

function chip(label, enabled) {
    return `<span class="srl-scene-switcher__chip${enabled ? ' srl-scene-switcher__chip--enabled' : ''}">${label}</span>`;
}

function getMissingSceneBindings(scene) {
    const adapter = getAdapter();
    const missing = [];
    if (scene.scope.connectionProfile && !adapter.hasConnectionProfile(scene.bindings.connectionProfileId)) missing.push('连接档案');
    if (scene.scope.api && !adapter.hasApi(scene.bindings.api)) missing.push('API');
    if (scene.scope.character && !adapter.hasCharacter(scene.bindings.characterAvatar)) missing.push('角色');
    if (scene.scope.preset && !adapter.hasPreset(scene.bindings.presetApi, scene.bindings.presetName)) missing.push('预设');
    if (scene.scope.theme && !adapter.hasTheme(scene.bindings.themeName)) missing.push('主题');
    return missing;
}

function sceneRows(scenes, emptyText = '还没有组合。先调整好酒馆设置，再点击“保存当前组合”。') {
    if (!scenes.length) return `<p class="srl-scene-switcher__empty">${escapeHtml(emptyText)}</p>`;
    return scenes.map(scene => {
        const missing = getMissingSceneBindings(scene);
        return `
        <article class="srl-scene-switcher__scene" data-scene-id="${escapeHtml(scene.id)}">
            <button class="srl-scene-switcher__scene-apply" data-action="apply-scene" data-scene-id="${escapeHtml(scene.id)}" type="button">
                <span class="srl-scene-switcher__scene-name">${escapeHtml(scene.name)}</span>
                <span class="srl-scene-switcher__chips">
                    ${chip('连接档案', scene.scope.connectionProfile)}
                    ${chip('API', scene.scope.api)}
                    ${chip('角色', scene.scope.character)}
                    ${chip('预设', scene.scope.preset)}
                    ${chip('主题', scene.scope.theme)}
                </span>
                ${missing.length ? `<small class="srl-scene-switcher__scene-missing">缺少：${escapeHtml(missing.join('、'))}；点右侧重绑</small>` : ''}
            </button>
            <button class="srl-scene-switcher__icon-button srl-scene-switcher__copy-button" data-action="duplicate-scene" data-scene-id="${escapeHtml(scene.id)}" aria-label="复制 ${escapeHtml(scene.name)}" type="button">复制</button>
            <button class="srl-scene-switcher__icon-button" data-action="edit-scene" data-scene-id="${escapeHtml(scene.id)}" aria-label="${missing.length ? '重新绑定' : '编辑与重命名'} ${escapeHtml(scene.name)}" type="button">${missing.length ? '重绑' : '编辑'}</button>
        </article>`;
    }).join('');
}

function groupedSceneRows(scenes) {
    const groups = new Map();
    for (const scene of scenes) {
        const key = scene.group || '未分组';
        const list = groups.get(key) ?? [];
        list.push(scene);
        groups.set(key, list);
    }
    return [...groups.entries()].map(([group, items]) => `
        <section class="srl-scene-switcher__scene-group">
            <h4>${escapeHtml(group)} <small>${items.length}</small></h4>
            ${sceneRows(items)}
        </section>`).join('');
}

function optionRows(items, selected) {
    return items.map(item => `<option value="${escapeHtml(item.value)}"${item.value === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
}

function editorMarkup() {
    if (!state.editor) return '';
    const scene = state.editor;
    const snapshot = getCurrentSnapshot();
    const profiles = getConnectionProfiles();
    const activeProfile = getConnectionProfile(runtime.context(), scene.bindings.connectionProfileId);
    const api = scene.scope.connectionProfile
        ? activeProfile?.api || snapshot.api
        : scene.bindings.api || snapshot.api;
    const presets = getPresetOptions(scene.bindings.presetApi || api);
    const themes = [...runtime.themeSelect.options].map(option => ({ value: option.value, label: option.textContent || option.value }));
    const apis = [...runtime.apiSelect.options].map(option => ({ value: option.value, label: option.textContent || option.value }));
    const character = getCharacter(runtime.context(), scene.bindings.characterAvatar);

    return `
        <section class="srl-scene-switcher__editor" aria-label="编辑组合">
            <div class="srl-scene-switcher__editor-heading">
                <div><small>组合编辑</small><h4>${scene.id ? '保存绑定项' : '新建组合'}</h4></div>
                <button class="srl-scene-switcher__icon-button" data-action="cancel-editor" aria-label="关闭编辑" type="button">×</button>
            </div>
            <label class="srl-scene-switcher__field">组合名称
                <input data-field="name" maxlength="80" value="${escapeHtml(scene.name)}" placeholder="例如：剧情主力">
            </label>
            <label class="srl-scene-switcher__field">分组（可选）
                <input data-field="group" maxlength="40" value="${escapeHtml(scene.group)}" placeholder="例如：日常、剧情、测试">
            </label>
            <label class="srl-scene-switcher__favorite">
                <input data-field="favorite" type="checkbox"${scene.favorite ? ' checked' : ''}>
                <span>设为常用组合（会显示在上方抽屉）</span>
            </label>
            <label class="srl-scene-switcher__binding">
                <input data-field="scope-connection-profile" type="checkbox"${scene.scope.connectionProfile ? ' checked' : ''}${profiles.length ? '' : ' disabled'}>
                <span>API 连接配置</span>
                <select data-field="connection-profile"${scene.scope.connectionProfile && profiles.length ? '' : ' disabled'}>${optionRows(profiles.map(profile => ({ value: profile.id, label: profile.name })), scene.bindings.connectionProfileId)}</select>
            </label>
            ${profiles.length ? '' : '<p class="srl-scene-switcher__hint">还没有可用的 API 连接配置。用下方按钮新建时会自动只保留 API、URL、模型与密钥引用。</p>'}
            <label class="srl-scene-switcher__binding">
                <input data-field="scope-api" type="checkbox"${scene.scope.api ? ' checked' : ''}>
                <span>API 类型（备用）</span>
                <select data-field="api"${scene.scope.api ? '' : ' disabled'}>${optionRows(apis, scene.bindings.api || snapshot.api)}</select>
            </label>
            <label class="srl-scene-switcher__binding">
                <input data-field="scope-character" type="checkbox"${scene.scope.character ? ' checked' : ''}>
                <span>角色卡</span>
                <button class="srl-scene-switcher__picker-button" data-action="open-character-picker" type="button"${scene.scope.character ? '' : ' disabled'}>${escapeHtml(character?.name || scene.bindings.characterName || '选择角色')}</button>
            </label>
            <label class="srl-scene-switcher__binding">
                <input data-field="scope-preset" type="checkbox"${scene.scope.preset ? ' checked' : ''}>
                <span>预设</span>
                <select data-field="preset"${scene.scope.preset ? '' : ' disabled'}>${optionRows(presets, encodePresetSelection(scene.bindings.presetApi, scene.bindings.presetName))}</select>
            </label>
            <label class="srl-scene-switcher__binding">
                <input data-field="scope-theme" type="checkbox"${scene.scope.theme ? ' checked' : ''}>
                <span>酒馆主题</span>
                <select data-field="theme"${scene.scope.theme ? '' : ' disabled'}>${optionRows(themes, scene.bindings.themeName)}</select>
            </label>
            <p class="srl-scene-switcher__hint">API 连接配置由酒馆原生接管，包含 API、URL、模型、代理和密钥引用；插件只保存名称和 ID，不保存密钥。预设不在此配置内。</p>
            <div class="srl-scene-switcher__editor-actions">
                ${scene.id ? '<button class="srl-scene-switcher__quiet-button" data-action="delete-scene" type="button">删除</button>' : ''}
                ${scene.id ? '<button class="srl-scene-switcher__secondary-button" data-action="save-scene-as" type="button">另存为</button>' : ''}
                <button class="srl-scene-switcher__primary-button" data-action="save-scene" type="button">保存组合</button>
            </div>
        </section>`;
}

function getChatScope(context) {
    if (context.groupId) {
        const group = context.groups?.find(item => item.id === context.groupId);
        return group ? { kind: 'group', id: group.id, name: group.name || '当前群聊' } : null;
    }
    const character = context.characters?.[context.characterId];
    return character ? { kind: 'character', id: character.avatar, name: character.name || '当前角色' } : null;
}

function chatSearchCacheKey(scope, query) {
    return `${scope.kind}:${scope.id}:${String(query ?? '').trim().toLocaleLowerCase()}`;
}

async function loadChatItems() {
    const scope = state.chatScope;
    if (!scope || state.openPicker !== 'chat') return;
    chatSearchAbortController?.abort();
    const controller = new AbortController();
    chatSearchAbortController = controller;
    state.chatLoading = true;
    state.chatError = '';
    renderChatPickerResults();
    try {
        const context = runtime.context();
        const cacheKey = chatSearchCacheKey(scope, state.chatQuery);
        const cached = chatSearchCache.get(cacheKey);
        if (cached) {
            state.chatItems = normalizeChatSearchResults(cached, context.chatId);
            return;
        }
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            signal: controller.signal,
            body: JSON.stringify({
                query: state.chatQuery,
                avatar_url: scope.kind === 'character' ? scope.id : null,
                group_id: scope.kind === 'group' ? scope.id : null,
            }),
        });
        if (!response.ok) throw new Error('酒馆未能读取聊天记录');
        if (controller.signal.aborted || state.openPicker !== 'chat') return;
        const payload = await response.json();
        chatSearchCache.set(cacheKey, payload);
        state.chatItems = normalizeChatSearchResults(payload, context.chatId);
    } catch (error) {
        if (controller.signal.aborted) return;
        state.chatItems = [];
        state.chatError = error instanceof Error ? error.message : '读取聊天记录失败';
    } finally {
        if (!controller.signal.aborted) {
            state.chatLoading = false;
            renderChatPickerResults();
        }
    }
}

function openChatPicker({ portal = false } = {}) {
    const scope = getChatScope(runtime.context());
    if (!scope) throw new Error('请先进入一个角色或群聊，再切换聊天记录');
    focusReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.openPicker = 'chat';
    state.pickerPortal = portal;
    state.chatScope = scope;
    state.chatQuery = '';
    state.chatItems = [];
    state.chatPage = 1;
    state.chatError = '';
    loadChatItems();
}

function closePicker() {
    chatSearchAbortController?.abort();
    clearTimeout(characterSearchTimer);
    state.openPicker = null;
    state.pickerPortal = false;
    state.chatLoading = false;
    state.chatScope = null;
    state.characterSearchIndex = null;
    state.personaSourceIds = [];
    state.personaItems = [];
    render();
    focusReturnTarget?.focus?.();
    focusReturnTarget = null;
}

function resetCharacterPicker() {
    state.characterQuery = '';
    state.characterFavoritesOnly = false;
    state.characterPage = 1;
    state.characterSearchIndex = null;
}

function getCharacterPage() {
    const context = runtime.context();
    const cached = state.characterSearchIndex;
    if (!cached || cached.characters !== context.characters || cached.tags !== context.tags || cached.tagMap !== context.tagMap) {
        state.characterSearchIndex = {
            characters: context.characters,
            tags: context.tags,
            tagMap: context.tagMap,
            index: createCharacterSearchIndex(context.characters, context.tags, context.tagMap),
        };
    }
    const matches = findCharactersInIndex(state.characterSearchIndex.index, state.characterQuery, {
        favoritesOnly: state.characterFavoritesOnly,
        recentAvatars: state.store.recentCharacters,
    });
    const page = paginateCharacters(matches, state.characterPage, CHARACTER_PAGE_SIZE);
    state.characterPage = page.page;
    return page;
}

function characterResultMarkup(page) {
    return page.items.map(character => {
        const thumbnail = runtime.context().getThumbnailUrl?.('avatar', character.avatar) || '';
        return `<button data-action="choose-character" data-avatar="${escapeHtml(character.avatar)}" type="button"><span class="srl-scene-switcher__avatar">${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" decoding="async">` : escapeHtml(character.name.slice(0, 1))}</span><span class="srl-scene-switcher__character-copy"><strong>${character.favorite ? '★ ' : ''}${character.recentRank !== Number.POSITIVE_INFINITY ? '最近 · ' : ''}${escapeHtml(character.name)}</strong>${character.tags.length ? `<small>${escapeHtml(character.tags.slice(0, 3).join(' · '))}</small>` : ''}</span><span>›</span></button>`;
    }).join('') || '<p class="srl-scene-switcher__empty">没有找到角色。</p>';
}

function characterPagerMarkup(page) {
    if (page.pageCount <= 1) return '';
    return `<nav class="srl-scene-switcher__pager" aria-label="角色分页"><button data-action="character-page" data-character-page="${page.page - 1}" type="button"${page.page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${page.page} / ${page.pageCount} 页</span><button data-action="character-page" data-character-page="${page.page + 1}" type="button"${page.page >= page.pageCount ? ' disabled' : ''}>下一页</button></nav>`;
}

function renderCharacterPickerResults() {
    const root = state.pickerPortal ? document.getElementById(PICKER_PORTAL_ID) : document.getElementById(APP_ID);
    const list = root?.querySelector('[data-character-results]');
    const count = root?.querySelector('[data-character-count]');
    const pager = root?.querySelector('[data-character-pager]');
    if (!list || !count || !pager) {
        render({ focusCharacterSearch: true });
        return;
    }
    const page = getCharacterPage();
    list.innerHTML = characterResultMarkup(page);
    count.textContent = `共 ${page.total} 项${page.total ? ` · 第 ${page.page} / ${page.pageCount} 页` : ''}`;
    pager.innerHTML = characterPagerMarkup(page);
}

function characterPickerMarkup() {
    if (state.openPicker !== 'character' && state.openPicker !== 'quick-character') return '';
    const page = getCharacterPage();
    return `
        <dialog class="srl-scene-switcher__sheet" aria-label="选择角色">
            <div class="srl-scene-switcher__sheet-handle"></div>
            <header><h3>选择角色</h3><button class="srl-scene-switcher__icon-button" data-action="close-picker" aria-label="关闭" type="button">×</button></header>
            <label class="srl-scene-switcher__search"><span>⌕</span><input data-field="character-search" value="${escapeHtml(state.characterQuery)}" placeholder="搜索角色名或标签"></label>
            <div class="srl-scene-switcher__picker-tools"><button class="srl-scene-switcher__filter-button${state.characterFavoritesOnly ? ' srl-scene-switcher__filter-button--active' : ''}" data-action="toggle-character-favorites" type="button">${state.characterFavoritesOnly ? '★ 仅看收藏' : '☆ 收藏优先'}</button><p class="srl-scene-switcher__sheet-count" data-character-count>共 ${page.total} 项${page.total ? ` · 第 ${page.page} / ${page.pageCount} 页` : ''}</p></div>
            <div class="srl-scene-switcher__character-list" data-character-results>${characterResultMarkup(page)}</div>
            <div data-character-pager>${characterPagerMarkup(page)}</div>
        </dialog>`;
}

function getChatPage() {
    const page = paginateCharacters(state.chatItems, state.chatPage, CHARACTER_PAGE_SIZE);
    state.chatPage = page.page;
    return page;
}

function chatResultMarkup(page) {
    if (state.chatError) return `<p class="srl-scene-switcher__empty">${escapeHtml(state.chatError)}</p>`;
    if (!page.items.length) return state.chatLoading ? '' : '<p class="srl-scene-switcher__empty">没有找到聊天记录。</p>';
    return page.items.map(chat => `<button data-action="choose-chat" data-chat-id="${escapeHtml(chat.id)}" type="button"><span class="srl-scene-switcher__chat-marker">${chat.current ? '当前' : '记录'}</span><span class="srl-scene-switcher__character-copy"><strong>${escapeHtml(chat.id)}</strong><small>${escapeHtml(chat.preview || '没有可显示的预览')} · ${chat.messageCount} 条消息</small></span><span>›</span></button>`).join('');
}

function chatPagerMarkup(page) {
    if (page.pageCount <= 1) return '';
    return `<nav class="srl-scene-switcher__pager" aria-label="聊天记录分页"><button data-action="chat-page" data-chat-page="${page.page - 1}" type="button"${page.page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${page.page} / ${page.pageCount} 页</span><button data-action="chat-page" data-chat-page="${page.page + 1}" type="button"${page.page >= page.pageCount ? ' disabled' : ''}>下一页</button></nav>`;
}

function renderChatPickerResults() {
    const root = state.pickerPortal ? document.getElementById(PICKER_PORTAL_ID) : document.getElementById(APP_ID);
    const list = root?.querySelector('[data-chat-results]');
    const count = root?.querySelector('[data-chat-count]');
    const pager = root?.querySelector('[data-chat-pager]');
    if (!list || !count || !pager) {
        render({ focusChatSearch: true });
        return;
    }
    const page = getChatPage();
    list.innerHTML = chatResultMarkup(page);
    count.textContent = state.chatLoading ? '正在读取酒馆原生聊天记录…' : `共 ${page.total} 项${page.total ? ` · 第 ${page.page} / ${page.pageCount} 页` : ''}`;
    pager.innerHTML = chatPagerMarkup(page);
}

function chatPickerMarkup() {
    if (state.openPicker !== 'chat' || !state.chatScope) return '';
    const scope = state.chatScope;
    const title = scope.kind === 'group' ? `切换群聊记录：${scope.name}` : `切换聊天记录：${scope.name}`;
    const page = getChatPage();
    return `
        <dialog class="srl-scene-switcher__sheet srl-scene-switcher__chat-sheet" aria-label="${escapeHtml(title)}">
            <div class="srl-scene-switcher__sheet-handle"></div>
            <header><h3>${escapeHtml(title)}</h3><button class="srl-scene-switcher__icon-button" data-action="close-picker" aria-label="关闭" type="button">×</button></header>
            <label class="srl-scene-switcher__search"><span>⌕</span><input data-field="chat-search" value="${escapeHtml(state.chatQuery)}" placeholder="搜索聊天记录"></label>
            <p class="srl-scene-switcher__sheet-count" data-chat-count>${state.chatLoading ? '正在读取酒馆原生聊天记录…' : `共 ${page.total} 项${page.total ? ` · 第 ${page.page} / ${page.pageCount} 页` : ''}`}</p>
            <div class="srl-scene-switcher__character-list srl-scene-switcher__chat-list" data-chat-results>${chatResultMarkup(page)}</div>
            <div data-chat-pager>${chatPagerMarkup(page)}</div>
        </dialog>`;
}

function resetPersonaPicker() {
    state.personaQuery = '';
    state.personaSourceIds = [];
    state.personaItems = [];
    state.personaPage = 1;
    state.personaLoading = false;
}

function refreshPersonaItems() {
    const context = runtime.context();
    const module = runtime.personaModule;
    const target = getPersonaTarget(context);
    const connected = typeof module?.getConnectedPersonas === 'function' && target
        ? module.getConnectedPersonas(target)
        : [];
    state.personaItems = findPersonas(state.personaSourceIds, context.powerUserSettings, {
        connectedIds: connected,
        currentAvatar: module?.user_avatar,
        query: state.personaQuery,
    });
}

function getPersonaTarget(context) {
    if (context.groupId) return String(context.groupId);
    return String(context.characters?.[context.characterId]?.avatar ?? '');
}

async function loadPersonaItems() {
    if (state.openPicker !== 'persona') return;
    const module = runtime.personaModule;
    if (typeof module?.getUserAvatars !== 'function') throw new Error('当前酒馆未提供用户人设列表入口');
    state.personaLoading = true;
    renderPersonaPickerResults();
    try {
        state.personaSourceIds = await module.getUserAvatars(false);
        refreshPersonaItems();
    } finally {
        state.personaLoading = false;
        renderPersonaPickerResults();
    }
}

function getPersonaPage() {
    const page = paginateCharacters(state.personaItems, state.personaPage, CHARACTER_PAGE_SIZE);
    state.personaPage = page.page;
    return page;
}

function personaResultMarkup(page) {
    if (!page.items.length) return state.personaLoading ? '' : '<p class="srl-scene-switcher__empty">没有可用的用户人设。</p>';
    return page.items.map(persona => {
        const thumbnail = runtime.context().getThumbnailUrl?.('persona', persona.avatar) || '';
        const labels = [persona.connected ? '已绑定当前对话' : '', persona.current ? '当前' : '', persona.default ? '默认' : ''].filter(Boolean);
        return `<article class="srl-scene-switcher__persona-item"><button class="srl-scene-switcher__persona-choice" data-action="choose-persona" data-persona-avatar="${escapeHtml(persona.avatar)}" type="button"><span class="srl-scene-switcher__avatar">${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" decoding="async">` : escapeHtml(persona.name.slice(0, 1))}</span><span class="srl-scene-switcher__character-copy"><strong>${escapeHtml(persona.name)}</strong><small>${escapeHtml([persona.title, labels.join(' · ')].filter(Boolean).join(' · ') || persona.avatar)}</small></span><span>›</span></button><details class="srl-scene-switcher__persona-content"><summary>查看内容</summary><p>${escapeHtml(persona.description || '此人设未填写描述。')}</p></details></article>`;
    }).join('');
}

function personaPagerMarkup(page) {
    if (page.pageCount <= 1) return '';
    return `<nav class="srl-scene-switcher__pager" aria-label="用户人设分页"><button data-action="persona-page" data-persona-page="${page.page - 1}" type="button"${page.page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${page.page} / ${page.pageCount} 页</span><button data-action="persona-page" data-persona-page="${page.page + 1}" type="button"${page.page >= page.pageCount ? ' disabled' : ''}>下一页</button></nav>`;
}

function renderPersonaPickerResults() {
    const root = state.pickerPortal ? document.getElementById(PICKER_PORTAL_ID) : document.getElementById(APP_ID);
    const list = root?.querySelector('[data-persona-results]');
    const count = root?.querySelector('[data-persona-count]');
    const pager = root?.querySelector('[data-persona-pager]');
    if (!list || !count || !pager) {
        render({ focusPersonaSearch: true });
        return;
    }
    const page = getPersonaPage();
    list.innerHTML = personaResultMarkup(page);
    count.textContent = state.personaLoading ? '正在读取酒馆原生用户人设…' : `共 ${page.total} 项${page.total ? ` · 第 ${page.page} / ${page.pageCount} 页` : ''}`;
    pager.innerHTML = personaPagerMarkup(page);
}

function personaPickerMarkup() {
    if (state.openPicker !== 'persona') return '';
    const page = getPersonaPage();
    return `
        <dialog class="srl-scene-switcher__sheet" aria-label="切换用户人设">
            <div class="srl-scene-switcher__sheet-handle"></div>
            <header><h3>切换用户人设</h3><button class="srl-scene-switcher__icon-button" data-action="close-picker" aria-label="关闭" type="button">×</button></header>
            <label class="srl-scene-switcher__search"><span>⌕</span><input data-field="persona-search" value="${escapeHtml(state.personaQuery)}" placeholder="搜索人设名称或称号"></label>
            <p class="srl-scene-switcher__sheet-count" data-persona-count>${state.personaLoading ? '正在读取酒馆原生用户人设…' : `共 ${page.total} 项${page.total ? ` · 第 ${page.page} / ${page.pageCount} 页` : ''}`}</p>
            <div class="srl-scene-switcher__character-list srl-scene-switcher__persona-list" data-persona-results>${personaResultMarkup(page)}</div>
            <div data-persona-pager>${personaPagerMarkup(page)}</div>
        </dialog>`;
}

function themeConfirmationMarkup() {
    const confirmation = state.themeConfirmation;
    if (!confirmation) return '';
    return `
        <div class="srl-scene-switcher__sheet-backdrop" data-action="cancel-theme-confirmation"></div>
        <section class="srl-scene-switcher__theme-dialog" role="dialog" aria-modal="true" aria-label="保留个人美化偏好">
            <div class="srl-scene-switcher__sheet-handle"></div>
            <h3>保留个人美化偏好？</h3>
            <p>切换到“${escapeHtml(confirmation.nextThemeName)}”时，酒馆会替换主题配色和默认外观。</p>
            <p>选择“保留个人偏好后切换”会在应用新主题后恢复你在“主题切换偏好”中勾选的 ${state.store.themePreferenceKeys.length} 项；主题配色仍会切换。</p>
            <div class="srl-scene-switcher__theme-dialog-actions">
                <button class="srl-scene-switcher__quiet-button" data-action="cancel-theme-confirmation" type="button">取消</button>
                <button class="srl-scene-switcher__quiet-button" data-action="switch-theme-completely" type="button">按新主题完整切换</button>
                <button class="srl-scene-switcher__primary-button" data-action="switch-theme-preserving-preferences" type="button">保留个人偏好后切换</button>
            </div>
        </section>`;
}

function sceneConfirmationMarkup() {
    const confirmation = state.sceneConfirmation;
    if (!confirmation) return '';
    return `
        <div class="srl-scene-switcher__sheet-backdrop" data-action="cancel-scene-switch"></div>
        <section class="srl-scene-switcher__theme-dialog srl-scene-switcher__scene-preview" role="dialog" aria-modal="true" aria-label="确认组合切换">
            <div class="srl-scene-switcher__sheet-handle"></div>
            <h3>确认切换“${escapeHtml(confirmation.sceneName)}”</h3>
            <p>只会替换下列项目，未列出的角色、聊天记录、正则及其他扩展设置均保持不变。</p>
            <ul class="srl-scene-switcher__change-list">${confirmation.changes.map(change => `<li><span>${escapeHtml(change.label)}</span><strong>${escapeHtml(change.from)} <i>→</i> ${escapeHtml(change.to)}</strong></li>`).join('') || '<li>这个组合没有启用任何绑定项。</li>'}</ul>
            <div class="srl-scene-switcher__theme-dialog-actions">
                <button class="srl-scene-switcher__quiet-button" data-action="cancel-scene-switch" type="button">取消</button>
                <button class="srl-scene-switcher__primary-button" data-action="confirm-scene-switch" type="button">确认切换</button>
            </div>
        </section>`;
}

function sceneResultMarkup() {
    const result = state.sceneResult;
    if (!result) return '';
    return `
        <section class="srl-scene-switcher__scene-result${result.applied ? ' srl-scene-switcher__scene-result--success' : ''}" aria-live="polite">
            <div><strong>${result.applied ? '组合已应用' : '组合未完整应用'}：${escapeHtml(result.sceneName)}</strong><button data-action="dismiss-scene-result" aria-label="关闭应用结果" type="button">×</button></div>
            <p><b>已替换：</b>${escapeHtml(result.changed.join('、') || '无')}</p>
            <p><b>保持不变：</b>${escapeHtml(result.kept.join('、') || '无')}</p>
            <p><b>未接管：</b>聊天记录、正则与其他扩展设置保持不变</p>
            ${result.missing.length ? `<p class="srl-scene-switcher__scene-missing"><b>失效且未执行：</b>${escapeHtml(result.missing.join('、'))}。为避免半套切换，本次没有写入任何组合设置；请点“重绑”修复。</p>` : ''}
            ${result.recovered.length ? `<p><b>已安全恢复：</b>${escapeHtml(result.recovered.join('、'))}</p>` : ''}
            ${result.errors.length ? `<p class="srl-scene-switcher__scene-missing"><b>原因：</b>${escapeHtml(result.errors.join('；'))}</p>` : ''}
        </section>`;
}

function switchHistoryMarkup() {
    const history = state.store.switchHistory.slice(0, 8);
    return `
        <details class="srl-scene-switcher__group"${panelAttributes('switch-history')}>
            <summary>切换记录（${state.store.switchHistory.length}）</summary>
            <div class="srl-scene-switcher__history">
                <p class="srl-scene-switcher__hint">只记录插件实际切过的名称和引用，不记录密钥、角色正文或聊天内容。主题切换不会自动撤回，避免覆盖个人美化偏好。</p>
                ${history.map(entry => `<article><div><strong>${escapeHtml(entry.label)}</strong><small>${new Date(entry.at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })} · ${escapeHtml(entry.changed.join('、'))}</small></div>${entry.reversible.length ? `<button class="srl-scene-switcher__quiet-button" data-action="undo-switch" data-history-id="${escapeHtml(entry.id)}" type="button">撤回</button>` : '<span class="srl-scene-switcher__history-state">不可安全撤回</span>'}</article>`).join('') || '<p class="srl-scene-switcher__empty">还没有通过本插件执行的切换。</p>'}
            </div>
        </details>`;
}

function compatibilityChecks() {
    const context = runtime.context();
    const has = (value, detail) => ({ ok: Boolean(value), detail });
    return [
        ['角色切换', has(typeof context.selectCharacterById === 'function', 'selectCharacterById')],
        ['用户人设切换', has(typeof runtime.personaModule?.getUserAvatars === 'function' && typeof runtime.personaModule?.setUserAvatar === 'function', 'personas.js / setUserAvatar')],
        ['预设切换', has(typeof runtime.presetModule?.getPresetManager === 'function', 'preset-manager')],
        ['主题切换', has(runtime.themeSelect instanceof HTMLSelectElement, '#themes')],
        ['聊天记录', has(typeof context.openCharacterChat === 'function' || typeof context.openGroupChat === 'function', '聊天原生入口')],
        ['API 连接档案', has(Boolean(getProfileSelect() && context.eventTypes?.CONNECTION_PROFILE_LOADED && typeof context.eventSource?.once === 'function'), '#connection_profiles / 事件')],
        ['API Custom 管理', has(document.getElementById('chat_completion_source') && document.getElementById('custom_api_url_text') && document.getElementById('custom_model_id') && typeof runtime.secrets?.rotateSecret === 'function', '原生字段与 Secrets')],
    ];
}

function compatibilityMarkup() {
    const checks = compatibilityChecks();
    return `
        <details class="srl-scene-switcher__group"${panelAttributes('compatibility')}>
            <summary>兼容性与诊断</summary>
            <div class="srl-scene-switcher__diagnostics">
                <p class="srl-scene-switcher__hint">检测当前酒馆已提供的原生入口。缺少入口时插件会停止该项操作，不会猜测字段或强行写入设置。</p>
                ${checks.map(([label, result]) => `<p><strong>${escapeHtml(label)}</strong><span class="srl-scene-switcher__diagnostic-state${result.ok ? ' srl-scene-switcher__diagnostic-state--ok' : ''}">${result.ok ? '可用' : '不可用'}</span><small>${escapeHtml(result.detail)}</small></p>`).join('')}
            </div>
        </details>`;
}

function themePreferenceMarkup() {
    const selected = new Set(state.store.themePreferenceKeys);
    const groups = [...new Set(THEME_PREFERENCE_OPTIONS.map(option => option.group))];
    return `
        <details class="srl-scene-switcher__group"${panelAttributes('theme-preferences')}>
            <summary>主题切换偏好（<span data-theme-preference-count>${selected.size}</span> 项）</summary>
            <div class="srl-scene-switcher__theme-preferences">
                <p class="srl-scene-switcher__hint">选择“保留个人偏好后切换”时，仅恢复已勾选的项目。主题配色、背景和气泡颜色始终按新主题切换。</p>
                <div class="srl-scene-switcher__preference-actions">
                    <button data-action="reset-theme-preferences" type="button">恢复常用 8 项</button>
                    <button data-action="select-all-theme-preferences" type="button">全选支持项</button>
                    <button data-action="clear-theme-preferences" type="button">全部不保留</button>
                </div>
                ${groups.map(group => `
                    <fieldset class="srl-scene-switcher__preference-group">
                        <legend>${escapeHtml(group)}</legend>
                        ${THEME_PREFERENCE_OPTIONS.filter(option => option.group === group).map(option => `
                            <label class="srl-scene-switcher__preference-option">
                                <input data-preference-key="${escapeHtml(option.key)}" type="checkbox"${selected.has(option.key) ? ' checked' : ''}>
                                <span>${escapeHtml(option.label)}</span>
                            </label>`).join('')}
                    </fieldset>`).join('')}
                <p class="srl-scene-switcher__hint">“高级”默认关闭；它会影响生成过程中的热切换行为。</p>
            </div>
        </details>`;
}

function apiProfileManagerMarkup() {
    const profiles = state.store.apiProfiles;
    const editor = state.apiProfileEditor;
    const importable = getImportableNativeApiProfiles();
    const editorSecretLabel = editor?.secretId ? getManagedSecretLabel(editor.secretId) : '';
    const tests = state.store.apiTestHistory.slice(0, 5);
    return `
        <details class="srl-scene-switcher__group"${panelAttributes('api-manager', Boolean(editor))}>
            <summary>API 管理器（${profiles.length}）</summary>
            <div class="srl-scene-switcher__api-manager">
                <p class="srl-scene-switcher__hint">仅管理 API Custom（OpenAI 兼容）的 URL、模型与密钥。切换时不会改动角色卡、预设、主题、正则、代理或其他扩展设置。</p>
                <button class="srl-scene-switcher__primary-button" data-action="new-managed-api" type="button">＋ 新建 API 配置</button>
                <div class="srl-scene-switcher__api-profile-list">
                    ${profiles.map(profile => `
                        <article class="srl-scene-switcher__api-profile">
                            <button data-action="apply-managed-api" data-api-profile-id="${escapeHtml(profile.id)}" type="button">
                                <strong>${escapeHtml(profile.name)}</strong>
                                <span>${escapeHtml(profile.url)} · ${escapeHtml(profile.model)}</span>
                                <small class="srl-scene-switcher__api-profile-secret">密钥：${escapeHtml(getManagedSecretLabel(profile.secretId))}</small>
                            </button>
                            <button class="srl-scene-switcher__icon-button srl-scene-switcher__test-button" data-action="test-managed-api" data-api-profile-id="${escapeHtml(profile.id)}" aria-label="测试 ${escapeHtml(profile.name)}" type="button">测</button>
                            <button class="srl-scene-switcher__icon-button" data-action="edit-managed-api" data-api-profile-id="${escapeHtml(profile.id)}" aria-label="编辑 ${escapeHtml(profile.name)}" type="button">✎</button>
                        </article>`).join('') || '<p class="srl-scene-switcher__empty">还没有 API 配置。新建后即可一键切换。</p>'}
                </div>
                <div class="srl-scene-switcher__api-test-history" aria-label="最近连接测试">
                    <strong>最近连接测试</strong>
                    ${tests.map(item => `<p><span class="srl-scene-switcher__api-test-status srl-scene-switcher__api-test-status--${escapeHtml(item.status)}">${item.status === 'success' ? '成功' : item.status === 'failed' ? '失败' : '未确认'}</span><span>${escapeHtml(item.profileName)}</span><small>${new Date(item.finishedAt || item.startedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}</small></p>`).join('') || '<p class="srl-scene-switcher__hint">尚未测试。测试仍完全由酒馆原生连接按钮执行。</p>'}
                </div>
                <details class="srl-scene-switcher__api-importer"${panelAttributes('api-importer')}>
                    <summary>从酒馆连接档案导入（${importable.length}）</summary>
                    <p class="srl-scene-switcher__hint">只读取档案中的 API、Server URL、模型和密钥引用；预设、正则、代理及其他字段都会忽略。</p>
                    <div class="srl-scene-switcher__api-import-list">
                        ${importable.map(profile => `<button data-action="import-native-api" data-native-api-profile-id="${escapeHtml(profile.sourceId)}" type="button"><strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(profile.url)} · ${escapeHtml(profile.model)}</span><span>导入</span></button>`).join('') || '<p class="srl-scene-switcher__empty">没有可导入的 API Custom 连接档案。</p>'}
                    </div>
                </details>
                ${editor ? `
                    <section class="srl-scene-switcher__api-editor" aria-label="编辑 API 配置">
                        <div class="srl-scene-switcher__editor-heading"><div><small>API 管理器</small><h4>${getManagedApiProfile(editor.id) ? '编辑 API 配置' : '新建 API 配置'}</h4></div><button class="srl-scene-switcher__icon-button" data-action="cancel-managed-api" aria-label="关闭" type="button">×</button></div>
                        <label class="srl-scene-switcher__field">名称<input data-api-profile-field="name" maxlength="80" value="${escapeHtml(editor.name)}" placeholder="例如：主力 Gemini"></label>
                        <label class="srl-scene-switcher__field">Server URL<input data-api-profile-field="url" maxlength="2048" value="${escapeHtml(editor.url)}" placeholder="https://example.com/v1"></label>
                        <label class="srl-scene-switcher__field">模型<input data-api-profile-field="model" maxlength="240" value="${escapeHtml(editor.model)}" placeholder="例如：gemini-2.5-pro"></label>
                        <label class="srl-scene-switcher__field">密钥${editor.secretId ? `<small>已关联酒馆密钥：${escapeHtml(editorSecretLabel)}。留空即保留；重新填写会新增一把酒馆原生密钥。</small>` : ''}<input data-api-profile-field="key" type="password" autocomplete="new-password" placeholder="${editor.secretId ? '留空不修改' : '请输入 API Key'}"></label>
                        <p class="srl-scene-switcher__hint">密钥不会写进扩展设置、导出文件或日志；它由酒馆的 Secrets 安全存储保存。保存后可在列表点击“测”，会调用酒馆原生“连接”检测。删除本条配置不会删除酒馆中的密钥。</p>
                        <div class="srl-scene-switcher__editor-actions">
                            ${getManagedApiProfile(editor.id) ? '<button class="srl-scene-switcher__quiet-button" data-action="delete-managed-api" type="button">删除配置</button>' : ''}
                            <button class="srl-scene-switcher__primary-button" data-action="save-managed-api" type="button">保存 API 配置</button>
                        </div>
                    </section>` : ''}
            </div>
        </details>`;
}

function floatingSwitcherMarkup() {
    const appearance = normalizeFloatingAppearance(state.store.floatingAppearance);
    return `
        <details class="srl-scene-switcher__group"${panelAttributes('floating-switcher')}>
            <summary>快速悬浮球</summary>
            <div class="srl-scene-switcher__floating-setting">
                <label class="srl-scene-switcher__preference-option"><input data-action="toggle-floating-switcher" type="checkbox"${state.store.showFloatingSwitcher ? ' checked' : ''}><span>在欢迎页和聊天界面显示快速切换悬浮球</span></label>
                <label class="srl-scene-switcher__field">打开方式<select data-action="floating-open-mode"><option value="tap"${state.store.floatingOpenMode === 'tap' ? ' selected' : ''}>单击展开</option><option value="longpress"${state.store.floatingOpenMode === 'longpress' ? ' selected' : ''}>长按展开</option></select></label>
                <label class="srl-scene-switcher__field">色系<select data-action="floating-accent">${optionRows(FLOATING_ACCENTS, appearance.accent)}</select></label>
                <label class="srl-scene-switcher__field">图案直链<input data-action="floating-image-url" type="url" inputmode="url" maxlength="2048" placeholder="https://example.com/icon.png" value="${escapeHtml(appearance.imageUrl)}"></label>
                <p class="srl-scene-switcher__hint">图案仅支持 HTTPS 图片直链；加载失败时会显示默认图标。欢迎页和聊天界面都可使用；可直接拖到屏幕任意位置，位置会记住；长按模式下轻点不会展开。</p>
                <p class="srl-scene-switcher__hint" data-floating-diagnostic>诊断：正在检查悬浮球状态。</p>
            </div>
        </details>`;
}

function floatingPanelMarkup() {
    const current = getCurrentSnapshot();
    const favorites = state.store.scenes.filter(scene => scene.favorite).slice(0, 3);
    if (state.floatingView === 'api') {
        const profiles = state.store.apiProfiles;
        const apiTypes = [...runtime.apiSelect.options].map(option => ({ value: option.value, label: option.textContent || option.value }));
        return `<section class="srl-scene-switcher__floating-panel" role="dialog" aria-label="快速替换 API"><header><button class="menu_button fa-solid fa-arrow-left" data-floating-action="back" aria-label="返回" type="button"></button><strong><i class="fa-solid fa-plug" aria-hidden="true"></i> API</strong><button class="menu_button fa-solid fa-xmark" data-floating-action="close" aria-label="关闭" type="button"></button></header><p class="srl-scene-switcher__floating-hint">已保存 API 只替换连接配置；备用 API 类型按酒馆原生行为切换。</p>${profiles.length ? `<div class="srl-scene-switcher__floating-option-list"><small>已保存 API</small>${profiles.map(profile => `<button class="menu_button" data-floating-action="api-profile" data-api-profile-id="${escapeHtml(profile.id)}" type="button">${escapeHtml(profile.name)}</button>`).join('')}</div>` : ''}<label>API 类型（备用）<select data-floating-select="api-type">${optionRows(apiTypes, current.api)}</select></label></section>`;
    }
    if (state.floatingView === 'preset') {
        const presets = getPresetOptions(current.api);
        const selected = encodePresetSelection(current.presetApi, current.presetName);
        return `<section class="srl-scene-switcher__floating-panel" role="dialog" aria-label="快速替换预设"><header><button class="menu_button fa-solid fa-arrow-left" data-floating-action="back" aria-label="返回" type="button"></button><strong><i class="fa-solid fa-sliders" aria-hidden="true"></i> 预设</strong><button class="menu_button fa-solid fa-xmark" data-floating-action="close" aria-label="关闭" type="button"></button></header><p class="srl-scene-switcher__floating-hint">仅显示当前对话模式的预设；切换预设不会更换 API。</p><label>当前对话模式的预设<select data-floating-select="preset">${optionRows(presets, selected)}</select></label></section>`;
    }
    if (state.floatingView === 'theme') {
        const themes = [...runtime.themeSelect.options].map(option => ({ value: option.value, label: option.textContent || option.value }));
        return `<section class="srl-scene-switcher__floating-panel" role="dialog" aria-label="快速替换美化"><header><button class="menu_button fa-solid fa-arrow-left" data-floating-action="back" aria-label="返回" type="button"></button><strong><i class="fa-solid fa-palette" aria-hidden="true"></i> 美化</strong><button class="menu_button fa-solid fa-xmark" data-floating-action="close" aria-label="关闭" type="button"></button></header><p class="srl-scene-switcher__floating-hint">切换前仍会询问是否保留你的个人美化偏好。</p><label>酒馆主题<select data-floating-select="theme">${optionRows(themes, current.themeName)}</select></label></section>`;
    }
    return `<section class="srl-scene-switcher__floating-panel" role="dialog" aria-label="快速切换"><header><strong><i class="fa-solid fa-layer-group" aria-hidden="true"></i> 快速切换</strong><button class="menu_button fa-solid fa-xmark" data-floating-action="close" aria-label="关闭" type="button"></button></header><div class="srl-scene-switcher__floating-actions"><button class="menu_button" data-floating-action="character" type="button"><i class="fa-solid fa-user" aria-hidden="true"></i>角色</button><button class="menu_button" data-floating-action="persona" type="button"><i class="fa-solid fa-id-card" aria-hidden="true"></i>用户人设</button><button class="menu_button" data-floating-action="chat" type="button"><i class="fa-solid fa-comments" aria-hidden="true"></i>聊天记录</button><button class="menu_button" data-floating-action="view" data-floating-view="api" type="button"><i class="fa-solid fa-plug" aria-hidden="true"></i>API</button><button class="menu_button" data-floating-action="view" data-floating-view="preset" type="button"><i class="fa-solid fa-sliders" aria-hidden="true"></i>预设</button><button class="menu_button srl-scene-switcher__floating-action--wide" data-floating-action="view" data-floating-view="theme" type="button"><i class="fa-solid fa-palette" aria-hidden="true"></i>美化</button></div>${favorites.length ? `<div class="srl-scene-switcher__floating-scenes"><small>常用组合</small>${favorites.map(scene => `<button class="menu_button" data-floating-action="scene" data-scene-id="${escapeHtml(scene.id)}" type="button">${escapeHtml(scene.name)}</button>`).join('')}</div>` : ''}</section>`;
}

function getFloatingViewport() {
    return { width: window.innerWidth, height: window.innerHeight };
}

function positionFloatingMount(mount) {
    const position = clampFloatingPosition(state.store?.floatingPosition, getFloatingViewport());
    if (!position) {
        mount.style.left = '';
        mount.style.top = '';
        mount.style.right = '';
        mount.style.bottom = '';
        mount.dataset.anchorHorizontal = 'right';
        mount.dataset.anchorVertical = 'bottom';
        return;
    }
    mount.style.left = `${position.x}px`;
    mount.style.top = `${position.y}px`;
    mount.style.right = 'auto';
    mount.style.bottom = 'auto';
    mount.dataset.anchorHorizontal = position.x > window.innerWidth / 2 ? 'right' : 'left';
    mount.dataset.anchorVertical = position.y > window.innerHeight / 2 ? 'bottom' : 'top';
}

function persistFloatingPosition(mount) {
    const rect = mount.getBoundingClientRect();
    const position = clampFloatingPosition({ x: rect.left, y: rect.top }, getFloatingViewport(), rect);
    if (!position) return;
    state.store = { ...state.store, floatingPosition: position };
    persist(runtime.context());
}

function clearFloatingLongPress() {
    if (!floatingLongPressTimer) return;
    clearTimeout(floatingLongPressTimer);
    floatingLongPressTimer = 0;
}

function clearFloatingDrag() {
    const drag = floatingDrag;
    clearFloatingLongPress();
    if (floatingDragFrame) {
        cancelFloatingFrame(floatingDragFrame);
        floatingDragFrame = 0;
    }
    if (!drag) return;
    drag.button.classList.remove('srl-scene-switcher__floating-button--dragging');
    if (drag.button.hasPointerCapture?.(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
    floatingDrag = null;
}

function flushFloatingDrag(mount) {
    const drag = floatingDrag;
    if (!drag?.pendingPosition) return;
    const position = drag.pendingPosition;
    drag.pendingPosition = null;
    mount.style.left = `${position.x}px`;
    mount.style.top = `${position.y}px`;
    mount.style.right = 'auto';
    mount.style.bottom = 'auto';
    mount.dataset.anchorHorizontal = position.x > window.innerWidth / 2 ? 'right' : 'left';
    mount.dataset.anchorVertical = position.y > window.innerHeight / 2 ? 'bottom' : 'top';
    updateFloatingPanelSpace(mount);
}

function installFloatingResizeListener() {
    if (floatingResizeInstalled) return;
    window.addEventListener('resize', handleFloatingResize);
    floatingResizeInstalled = true;
}

function handleFloatingResize() {
    const mount = document.getElementById(FLOATING_SWITCHER_ID);
    if (mount && state.store?.showFloatingSwitcher) {
        positionFloatingMount(mount);
        updateFloatingPanelSpace(mount);
    }
}

function updateFloatingPanelSpace(mount) {
    const button = mount.querySelector('.srl-scene-switcher__floating-button');
    if (!(button instanceof HTMLElement)) return;
    const rect = button.getBoundingClientRect();
    const space = mount.dataset.anchorVertical === 'top'
        ? window.innerHeight - rect.top - 62
        : rect.bottom - 62;
    mount.style.setProperty('--floating-panel-max-height', `${Math.max(120, Math.floor(space))}px`);
}

function ensureFloatingMount() {
    let mount = document.getElementById(FLOATING_SWITCHER_ID);
    if (mount) return mount;
    mount = document.createElement('div');
    mount.id = FLOATING_SWITCHER_ID;
    document.body.append(mount);
    installFloatingResizeListener();
    if (!mount.dataset.eventsInstalled) {
        mount.dataset.eventsInstalled = 'true';
        mount.addEventListener('error', event => {
            if (!(event.target instanceof HTMLImageElement) || !event.target.matches('.srl-scene-switcher__floating-image')) return;
            mount.dataset.imageError = 'true';
        }, true);
        mount.addEventListener('pointerdown', event => {
            const button = event.target.closest?.('.srl-scene-switcher__floating-button');
            if (!(button instanceof HTMLButtonElement) || event.button !== 0) return;
            const rect = mount.getBoundingClientRect();
            floatingDrag = {
                pointerId: event.pointerId,
                button,
                startX: event.clientX,
                startY: event.clientY,
                originX: rect.left,
                originY: rect.top,
                moved: false,
                pendingPosition: null,
            };
            button.setPointerCapture?.(event.pointerId);
            if (state.store.floatingOpenMode === 'longpress') {
                const pointerId = event.pointerId;
                floatingLongPressTimer = setTimeout(() => {
                    floatingLongPressTimer = 0;
                    if (!floatingDrag || floatingDrag.pointerId !== pointerId || floatingDrag.moved) return;
                    floatingClickSuppressed = true;
                    state.floatingOpen = !state.floatingOpen;
                    state.floatingView = 'main';
                    renderFloatingSwitcher();
                }, 450);
            }
        });
        mount.addEventListener('pointermove', event => {
            const drag = floatingDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - drag.startX;
            const deltaY = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(deltaX, deltaY) < 5) return;
            clearFloatingLongPress();
            drag.moved = true;
            drag.button.classList.add('srl-scene-switcher__floating-button--dragging');
            const position = clampFloatingPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY }, getFloatingViewport());
            if (!position) return;
            drag.pendingPosition = position;
            if (!floatingDragFrame) {
                floatingDragFrame = scheduleFloatingFrame(() => {
                    floatingDragFrame = 0;
                    flushFloatingDrag(mount);
                });
            }
            event.preventDefault();
        });
        const finishDrag = event => {
            if (!floatingDrag || floatingDrag.pointerId !== event.pointerId) return;
            if (event.type === 'pointercancel') floatingClickSuppressed = false;
            const moved = floatingDrag.moved;
            if (moved) {
                if (floatingDragFrame) {
                    cancelFloatingFrame(floatingDragFrame);
                    floatingDragFrame = 0;
                }
                flushFloatingDrag(mount);
                floatingClickSuppressed = event.type === 'pointerup';
                persistFloatingPosition(mount);
                positionFloatingMount(mount);
            }
            clearFloatingDrag();
        };
        mount.addEventListener('pointerup', finishDrag);
        mount.addEventListener('pointercancel', finishDrag);
        mount.addEventListener('change', async event => {
            const target = event.target;
            if (!(target instanceof HTMLSelectElement) || !target.value) return;
            const action = target.dataset.floatingSelect;
            if (action === 'api-type') await applyAndRecordHistory({
                label: `API 类型：${target.selectedOptions?.[0]?.textContent || target.value}`,
                changed: ['api'],
                task: async () => {
                    await getAdapter().applyApi(target.value);
                state.floatingOpen = false;
                state.floatingView = 'main';
                render();
                },
            });
            if (action === 'preset') await applyAndRecordHistory({
                label: `预设：${target.selectedOptions?.[0]?.textContent || ''}`,
                changed: ['preset'],
                task: async () => {
                const preset = decodePresetSelection(target.value);
                if (!preset) throw new Error('预设选择无效，请重新打开菜单。');
                await getAdapter().applyPreset(preset.name, preset.api);
                state.floatingOpen = false;
                state.floatingView = 'main';
                render();
                },
            });
            if (action === 'theme') {
                const themeDecision = await requestThemeSwitch(target.value);
                if (!themeDecision) return;
                await applyAndRecordHistory({
                    label: `美化主题：${target.selectedOptions?.[0]?.textContent || target.value}`,
                    changed: ['theme'],
                    task: async () => {
                    await getAdapter({ preserveThemePreferences: themeDecision.preservePreferences, themePreferenceKeys: state.store.themePreferenceKeys }).applyTheme(target.value);
                    state.floatingOpen = false;
                    state.floatingView = 'main';
                    render();
                    },
                });
            }
        });
        mount.addEventListener('click', async event => {
            if (floatingClickSuppressed) {
                floatingClickSuppressed = false;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const target = event.target.closest?.('[data-floating-action]');
            if (!target) return;
            const action = target.dataset.floatingAction;
            if (action === 'toggle') {
                if (state.store.floatingOpenMode === 'longpress') return;
                state.floatingOpen = !state.floatingOpen;
                state.floatingView = 'main';
                renderFloatingSwitcher();
            }
            if (action === 'close') {
                state.floatingOpen = false;
                state.floatingView = 'main';
                renderFloatingSwitcher();
            }
            if (action === 'view' && ['api', 'preset', 'theme'].includes(target.dataset.floatingView)) {
                state.floatingView = target.dataset.floatingView;
                renderFloatingSwitcher();
            }
            if (action === 'back') {
                state.floatingView = 'main';
                renderFloatingSwitcher();
            }
            if (action === 'api-profile') await applyAndRecordHistory({
                label: `API：${getManagedApiProfile(target.dataset.apiProfileId)?.name ?? ''}`,
                changed: ['managedApi'],
                task: async () => {
                    await applyManagedApiProfile(target.dataset.apiProfileId);
                const profile = getManagedApiProfile(target.dataset.apiProfileId);
                state.notice = `已切换 API“${profile?.name ?? ''}”，其余设置保持不变。`;
                showToast('success', state.notice);
                state.floatingOpen = false;
                state.floatingView = 'main';
                render();
                },
            });
            if (action === 'character') {
                focusReturnTarget = target;
                state.floatingOpen = false;
                state.floatingView = 'main';
                state.openPicker = 'quick-character';
                state.pickerPortal = true;
                resetCharacterPicker();
                render({ focusCharacterSearch: true });
            }
            if (action === 'persona') {
                focusReturnTarget = target;
                state.floatingOpen = false;
                state.floatingView = 'main';
                resetPersonaPicker();
                state.openPicker = 'persona';
                state.pickerPortal = true;
                try {
                    await loadPersonaItems();
                } catch (error) {
                    state.openPicker = null;
                    state.pickerPortal = false;
                    showToast('warning', error instanceof Error ? error.message : '无法读取用户人设。');
                    renderFloatingSwitcher();
                }
            }
            if (action === 'chat') {
                focusReturnTarget = target;
                state.floatingOpen = false;
                state.floatingView = 'main';
                try {
                    openChatPicker({ portal: true });
                } catch (error) {
                    showToast('warning', error instanceof Error ? error.message : '无法打开聊天记录。');
                }
                renderFloatingSwitcher();
            }
            if (action === 'scene') await applySceneById(target.dataset.sceneId);
        });
    }
    return mount;
}

function renderFloatingSwitcher() {
    const existing = document.getElementById(FLOATING_SWITCHER_ID);
    if (!state.store?.showFloatingSwitcher || !runtime) {
        clearFloatingDrag();
        existing?.remove();
        if (floatingResizeInstalled) {
            window.removeEventListener('resize', handleFloatingResize);
            floatingResizeInstalled = false;
        }
        state.floatingOpen = false;
        state.floatingView = 'main';
        updateFloatingDiagnostic();
        return;
    }
    const mount = ensureFloatingMount();
    positionFloatingMount(mount);
    const appearance = normalizeFloatingAppearance(state.store.floatingAppearance);
    mount.dataset.floatingAccent = appearance.accent;
    mount.dataset.imageError = 'false';
    mount.innerHTML = `
        <button class="srl-scene-switcher__floating-button menu_button" data-floating-action="toggle" aria-expanded="${state.floatingOpen}" aria-label="打开快速切换；可拖动移动" title="轻点打开，拖动移动" type="button">${appearance.imageUrl ? `<img class="srl-scene-switcher__floating-image" src="${escapeHtml(appearance.imageUrl)}" alt="">` : ''}<i class="srl-scene-switcher__floating-icon fa-solid fa-bolt" aria-hidden="true"></i></button>
        ${state.floatingOpen ? floatingPanelMarkup() : ''}`;
    updateFloatingPanelSpace(mount);
    updateFloatingDiagnostic();
}

function updateFloatingDiagnostic() {
    const status = document.querySelector('[data-floating-diagnostic]');
    if (!status) return;
    if (!state.store?.showFloatingSwitcher) {
        status.textContent = '诊断：悬浮球开关未开启。';
        return;
    }
    if (!runtime) {
        status.textContent = '诊断：酒馆运行环境尚未就绪，未创建悬浮球。';
        return;
    }
    const mount = document.getElementById(FLOATING_SWITCHER_ID);
    if (!mount) {
        status.textContent = '诊断：运行环境已就绪，但悬浮球节点未挂载。';
        return;
    }
    const style = getComputedStyle(mount);
    const rect = mount.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    const position = `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    status.textContent = visible
        ? `诊断：节点已挂载，显示状态正常；位置 ${position}，视口 ${window.innerWidth}×${window.innerHeight}。`
        : `诊断：节点已挂载但被运行时样式隐藏；display ${style.display}、visibility ${style.visibility}、opacity ${style.opacity}、位置 ${position}。`;
}

function renderPickerPortal() {
    const existing = document.getElementById(PICKER_PORTAL_ID);
    if (!state.pickerPortal || !state.openPicker) {
        existing?.remove();
        return;
    }
    const mount = existing ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: PICKER_PORTAL_ID }));
    mount.innerHTML = `${characterPickerMarkup()}${chatPickerMarkup()}${personaPickerMarkup()}`;
    showPickerDialogs(mount);
    if (mount.dataset.eventsInstalled) return;
    mount.dataset.eventsInstalled = 'true';
    mount.addEventListener('input', handlePickerInput);
    mount.addEventListener('click', async event => {
        if (event.target instanceof HTMLDialogElement && event.target.matches('.srl-scene-switcher__sheet')) {
            closePicker();
            return;
        }
        const target = event.target.closest?.('[data-action]');
        if (target) await handlePickerAction(target);
    });
}

function showPickerDialogs(mount) {
    mount.querySelectorAll('dialog.srl-scene-switcher__sheet').forEach(dialog => {
        if (dialog.open) return;
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            closePicker();
        }, { once: true });
        dialog.showModal();
    });
}

function handleDocumentKeydown(event) {
    if (event.key !== 'Escape') return;
    if (state.themeConfirmation) {
        event.preventDefault();
        cancelThemeConfirmation();
        return;
    }
    if (state.openPicker) {
        event.preventDefault();
        closePicker();
        return;
    }
    if (state.floatingOpen) {
        event.preventDefault();
        state.floatingOpen = false;
        renderFloatingSwitcher();
    }
}

function installKeyboardEvents() {
    if (keyboardEventsInstalled) return;
    document.addEventListener('keydown', handleDocumentKeydown);
    keyboardEventsInstalled = true;
}

function render({ focusCharacterSearch = false, focusChatSearch = false, focusPersonaSearch = false, focusSceneName = false } = {}) {
    const root = document.getElementById(APP_ID);
    if (!root || !state.store) return;
    captureOpenPanels(root);
    const current = getCurrentSnapshot();
    const favorites = state.store.scenes.filter(scene => scene.favorite).slice(0, 6);
    root.innerHTML = `
        <section class="srl-scene-switcher__app">
            <header class="srl-scene-switcher__current"><div><small>当前组合</small><strong>${escapeHtml(current.characterName || '未选择角色')}</strong><span>${escapeHtml(current.connectionProfileName || current.api || '未选择 API')} · ${escapeHtml(current.presetName || '未选择预设')}</span></div><button data-action="new-scene" type="button">保存当前组合</button></header>
            ${state.notice ? `<p class="srl-scene-switcher__notice">${escapeHtml(state.notice)}</p>` : ''}
            ${sceneResultMarkup()}
            <details class="srl-scene-switcher__group"${panelAttributes('quick-switch')}><summary>快速替换</summary><div class="srl-scene-switcher__quick">
                <button data-action="quick-character" type="button">角色：${escapeHtml(current.characterName || '选择角色')}</button>
                ${typeof runtime.personaModule?.setUserAvatar === 'function' ? '<button data-action="quick-persona" type="button">用户人设</button>' : ''}
                <button data-action="quick-chat" type="button">聊天记录：${escapeHtml(runtime.context().chatId || '选择记录')}</button>
                ${state.store.apiProfiles.length ? `<details class="srl-scene-switcher__quick-choice"${panelAttributes('quick-managed-api')}><summary>已保存 API</summary><div class="srl-scene-switcher__quick-option-list">${state.store.apiProfiles.map(profile => `<button data-action="quick-managed-api" data-api-profile-id="${escapeHtml(profile.id)}" type="button">${escapeHtml(profile.name)}</button>`).join('')}</div></details>` : ''}
                <details class="srl-scene-switcher__quick-choice"${panelAttributes('quick-api-type')}><summary>API 类型（备用）</summary><div class="srl-scene-switcher__quick-option-list">${[...runtime.apiSelect.options].map(option => `<button data-action="quick-api" data-api-type="${escapeHtml(option.value)}" type="button">${escapeHtml(option.textContent || option.value)}${option.value === current.api ? '（当前）' : ''}</button>`).join('')}</div></details>
                <label>当前对话模式的预设<select data-action="quick-preset">${optionRows(getPresetOptions(current.api), encodePresetSelection(current.presetApi, current.presetName))}</select></label>
                <label>主题<select data-action="quick-theme">${optionRows([...runtime.themeSelect.options].map(option => ({ value: option.value, label: option.textContent || option.value })), current.themeName)}</select></label>
            </div></details>
            <details class="srl-scene-switcher__group"${panelAttributes('favorite-scenes', true)}><summary>常用组合</summary>${sceneRows(favorites, '暂无常用组合。编辑任意组合后可将它设为常用。')}</details>
            <details class="srl-scene-switcher__group"${panelAttributes('all-scenes')}><summary>全部组合（${state.store.scenes.length}）</summary>${groupedSceneRows(state.store.scenes)}</details>
            ${switchHistoryMarkup()}
            ${apiProfileManagerMarkup()}
            ${floatingSwitcherMarkup()}
            ${themePreferenceMarkup()}
            ${compatibilityMarkup()}
            <details class="srl-scene-switcher__group"${panelAttributes('manage')}><summary>管理与新建</summary><div class="srl-scene-switcher__manage"><button data-action="new-scene" type="button">＋ 保存当前组合</button><label class="srl-scene-switcher__preference-option"><input data-action="toggle-scene-confirmation" type="checkbox"${state.store.confirmSceneSwitch ? ' checked' : ''}><span>切换组合前显示变更预览</span></label><p>组合只绑定你勾选的项目；不保存 API 密钥，也不触碰其他扩展设置。</p></div></details>
            ${editorMarkup()}
        </section>
        ${state.pickerPortal ? '' : characterPickerMarkup()}
        ${state.pickerPortal ? '' : chatPickerMarkup()}
        ${state.pickerPortal ? '' : personaPickerMarkup()}
        ${sceneConfirmationMarkup()}
        ${themeConfirmationMarkup()}`;
    renderFloatingSwitcher();
    showPickerDialogs(root);
    renderPickerPortal();
    const focusRoot = state.pickerPortal ? document.getElementById(PICKER_PORTAL_ID) : root;
    if (focusCharacterSearch) {
        focusRoot?.querySelector('[data-field="character-search"]')?.focus();
    }
    if (focusChatSearch) {
        focusRoot?.querySelector('[data-field="chat-search"]')?.focus();
    }
    if (focusPersonaSearch) {
        focusRoot?.querySelector('[data-field="persona-search"]')?.focus();
    }
    if (focusSceneName) {
        root.querySelector('[data-field="name"]')?.focus();
    }
}

function setThemePreferenceKeys(keys, context) {
    const root = document.getElementById(APP_ID);
    state.store = { ...state.store, themePreferenceKeys: normalizeThemePreferenceKeys(keys) };
    persist(context);
    syncThemePreferenceControls(root, state.store.themePreferenceKeys);
}

function updateEditorFromForm() {
    const root = document.getElementById(APP_ID);
    if (!root || !state.editor) return;
    const field = name => root.querySelector(`[data-field="${name}"]`);
    state.editor.name = field('name')?.value.trim() || '未命名组合';
    state.editor.group = field('group')?.value.trim() || '';
    state.editor.favorite = Boolean(field('favorite')?.checked);
    state.editor.scope.connectionProfile = Boolean(field('scope-connection-profile')?.checked);
    state.editor.scope.api = Boolean(field('scope-api')?.checked);
    state.editor.scope.character = Boolean(field('scope-character')?.checked);
    state.editor.scope.preset = Boolean(field('scope-preset')?.checked);
    state.editor.scope.theme = Boolean(field('scope-theme')?.checked);
    if (state.editor.scope.connectionProfile) state.editor.scope.api = false;
    state.editor.bindings.api = field('api')?.value || state.editor.bindings.api;
    state.editor.bindings.connectionProfileId = field('connection-profile')?.value || state.editor.bindings.connectionProfileId;
    state.editor.bindings.connectionProfileName = getConnectionProfile(runtime.context(), state.editor.bindings.connectionProfileId)?.name || state.editor.bindings.connectionProfileName;
    const preset = decodePresetSelection(field('preset')?.value || '');
    if (preset) {
        state.editor.bindings.presetApi = preset.api;
        state.editor.bindings.presetName = preset.name;
    }
    state.editor.bindings.themeName = field('theme')?.value || state.editor.bindings.themeName;
}

async function applySceneById(id) {
    const scene = state.store.scenes.find(item => item.id === id);
    if (!scene) return;
    if (!await requestSceneSwitch(scene)) return;
    let themeDecision = { preservePreferences: false };
    if (scene.scope.theme) {
        themeDecision = await requestThemeSwitch(scene.bindings.themeName);
        if (!themeDecision) return;
    }
    await runSafely(async () => {
        const before = getCurrentSnapshot();
        const result = await applySceneWithRecovery(scene, getAdapter({ preserveThemePreferences: themeDecision.preservePreferences, themePreferenceKeys: state.store.themePreferenceKeys }), before);
        state.sceneResult = createSceneResult(scene, result);
        if (!result.applied) {
            const reason = result.error instanceof Error ? result.error.message : result.errors?.join('；') || '切换失败';
            const restored = result.recovered?.length ? `；已恢复：${result.recovered.join('、')}` : '';
            const left = result.unrecovered?.length ? `；未自动恢复：${result.unrecovered.join('、')}（避免再次覆盖主题个人项）` : '';
            state.notice = `未完整应用：${reason}${restored}${left}`;
            showToast('warning', state.notice);
            return result;
        }
        state.store = markRecent(state.store, scene.id);
        if (result.changed.includes('character')) {
            state.store = {
                ...state.store,
                recentCharacters: markRecentCharacter(state.store.recentCharacters, scene.bindings.characterAvatar),
            };
        }
        persist(runtime.context());
        appendSwitchHistory(runtime.context(), {
            label: `组合：${scene.name}`,
            changed: result.changed,
            reversible: getRecoverableKeys(before, result.changed),
            before,
        });
        state.notice = `已应用“${scene.name}”：${getEnabledBindingKeys(scene).join('、') || '保持当前'}`;
        showToast('success', state.notice);
        return result;
    });
}

async function runSafely(task) {
    try {
        const outcome = await queue.run(task);
        if (outcome?.skipped) showToast('info', '正在切换，请等待当前操作完成。');
        return outcome;
    } catch (error) {
        console.error('Scene Switcher operation failed', error);
        showToast('error', error instanceof Error ? error.message : '操作失败，请检查酒馆连接设置。');
        return null;
    }
    finally {
        render();
    }
}

function handlePickerInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.field === 'character-search') {
        state.characterQuery = target.value;
        state.characterPage = 1;
        clearTimeout(characterSearchTimer);
        characterSearchTimer = setTimeout(renderCharacterPickerResults, 120);
    }
    if (target.dataset.field === 'chat-search') {
        state.chatQuery = target.value;
        state.chatPage = 1;
        clearTimeout(chatSearchTimer);
        chatSearchTimer = setTimeout(loadChatItems, 180);
    }
    if (target.dataset.field === 'persona-search') {
        state.personaQuery = target.value;
        state.personaPage = 1;
        refreshPersonaItems();
        renderPersonaPickerResults();
    }
}

async function handlePickerAction(target) {
    const action = target.dataset.action;
    if (action === 'close-picker') {
        closePicker();
        return true;
    }
    if (action === 'toggle-character-favorites') {
        state.characterFavoritesOnly = !state.characterFavoritesOnly;
        state.characterPage = 1;
        renderCharacterPickerResults();
        return true;
    }
    if (action === 'character-page') {
        state.characterPage = Number(target.dataset.characterPage) || 1;
        renderCharacterPickerResults();
        return true;
    }
    if (action === 'chat-page') {
        state.chatPage = Number(target.dataset.chatPage) || 1;
        renderChatPickerResults();
        return true;
    }
    if (action === 'persona-page') {
        state.personaPage = Number(target.dataset.personaPage) || 1;
        renderPersonaPickerResults();
        return true;
    }
    if (action === 'choose-character') {
        if (state.openPicker === 'quick-character') {
            const restoreDrawer = isSceneDrawerOpen();
            const before = getCurrentSnapshot();
            state.openPicker = null;
            state.pickerPortal = false;
            const outcome = await runSafely(async () => {
                await getAdapter().applyCharacter(target.dataset.avatar);
                return { applied: true };
            });
            if (outcome?.applied) {
                const character = getCharacter(runtime.context(), target.dataset.avatar);
                state.store = { ...state.store, recentCharacters: markRecentCharacter(state.store.recentCharacters, target.dataset.avatar) };
                appendSwitchHistory(runtime.context(), {
                    label: `角色：${character?.name ?? '未命名角色'}`,
                    changed: ['character'],
                    reversible: getRecoverableKeys(before, ['character']),
                    before,
                });
            }
            restoreSceneDrawer(restoreDrawer);
            focusReturnTarget?.focus?.();
            focusReturnTarget = null;
            return true;
        }
        if (state.editor) {
            const character = getCharacter(runtime.context(), target.dataset.avatar);
            state.editor.bindings.characterAvatar = target.dataset.avatar;
            state.editor.bindings.characterName = character?.name ?? '';
            state.openPicker = null;
            state.pickerPortal = false;
            render();
            focusReturnTarget?.focus?.();
            focusReturnTarget = null;
            return true;
        }
    }
    if (action === 'choose-chat') {
        const scope = state.chatScope;
        const chatId = target.dataset.chatId;
        if (!scope || !chatId) return true;
        const restoreDrawer = isSceneDrawerOpen();
        state.openPicker = null;
        state.pickerPortal = false;
        await runSafely(async () => {
            const current = runtime.context();
            if (scope.kind === 'group') {
                if (current.groupId !== scope.id) throw new Error('当前群聊已变化，请重新打开聊天记录。');
                await current.openGroupChat(scope.id, chatId);
            } else {
                if (current.characters?.[current.characterId]?.avatar !== scope.id) throw new Error('当前角色已变化，请重新打开聊天记录。');
                await current.openCharacterChat(chatId);
            }
            if (runtime.context().chatId !== chatId) throw new Error('酒馆未能切换到指定聊天记录');
            state.notice = `已切换到聊天记录“${chatId}”。`;
            showToast('success', state.notice);
        });
        restoreSceneDrawer(restoreDrawer);
        focusReturnTarget?.focus?.();
        focusReturnTarget = null;
        return true;
    }
    if (action === 'choose-persona') {
        const avatar = target.dataset.personaAvatar;
        const module = runtime.personaModule;
        if (!avatar || typeof module?.setUserAvatar !== 'function') return true;
        const restoreDrawer = isSceneDrawerOpen();
        state.openPicker = null;
        state.pickerPortal = false;
        await runSafely(async () => {
            await module.setUserAvatar(avatar);
            const persona = findPersonas([avatar], runtime.context().powerUserSettings, { currentAvatar: avatar })[0];
            state.notice = `已切换用户人设“${persona?.name || avatar}”；角色、预设、API 与聊天记录保持不变。`;
            showToast('success', state.notice);
        });
        restoreSceneDrawer(restoreDrawer);
        focusReturnTarget?.focus?.();
        focusReturnTarget = null;
        return true;
    }
    return false;
}

function installEvents(context) {
    const root = document.getElementById(APP_ID);
    appEventsAbortController?.abort();
    appEventsAbortController = new AbortController();
    const eventOptions = { signal: appEventsAbortController.signal };
    root.addEventListener('change', async event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
        if (target.dataset.field?.startsWith('scope-') || target.dataset.field === 'api' || target.dataset.field === 'connection-profile') {
            updateEditorFromForm();
            render();
            return;
        }
        if (target.dataset.action === 'quick-api') await applyAndRecordHistory({
            label: `API 类型：${target.selectedOptions?.[0]?.textContent || target.value}`,
            changed: ['api'],
            task: () => getAdapter().applyApi(target.value),
        });
        if (target.dataset.action === 'quick-managed-api' && target.value) await applyAndRecordHistory({
            label: `API：${getManagedApiProfile(target.value)?.name ?? ''}`,
            changed: ['managedApi'],
            task: async () => {
                await applyManagedApiProfile(target.value);
            const profile = getManagedApiProfile(target.value);
            state.notice = `已切换 API“${profile?.name ?? ''}”，其余设置保持不变。`;
            showToast('success', state.notice);
            },
        });
        if (target.dataset.action === 'quick-connection-profile') await applyAndRecordHistory({
            label: `API 连接配置：${target.selectedOptions?.[0]?.textContent || target.value}`,
            changed: ['connectionProfile'],
            task: () => getAdapter().applyConnectionProfile(target.value),
        });
        if (target.dataset.action === 'quick-preset') await applyAndRecordHistory({
            label: `预设：${target.selectedOptions?.[0]?.textContent || ''}`,
            changed: ['preset'],
            task: () => {
            const preset = decodePresetSelection(target.value);
            if (!preset) throw new Error('预设选择无效，请重新打开列表。');
            return getAdapter().applyPreset(preset.name, preset.api);
            },
        });
        if (target.dataset.action === 'quick-theme') {
            const themeDecision = await requestThemeSwitch(target.value);
            if (themeDecision) await applyAndRecordHistory({
                label: `美化主题：${target.selectedOptions?.[0]?.textContent || target.value}`,
                changed: ['theme'],
                task: () => getAdapter({ preserveThemePreferences: themeDecision.preservePreferences, themePreferenceKeys: state.store.themePreferenceKeys }).applyTheme(target.value),
            });
        }
        if (target.dataset.action === 'floating-accent') {
            state.store = {
                ...state.store,
                floatingAppearance: normalizeFloatingAppearance({ ...state.store.floatingAppearance, accent: target.value }),
            };
            persist(context);
            render();
        }
        if (target.dataset.action === 'floating-open-mode') {
            state.store = { ...state.store, floatingOpenMode: target.value === 'longpress' ? 'longpress' : 'tap' };
            persist(context);
            render();
        }
        if (target.dataset.action === 'floating-image-url') {
            const imageUrl = normalizeFloatingImageUrl(target.value);
            if (target.value.trim() && !imageUrl) {
                showToast('warning', '悬浮球图案只支持有效的 HTTPS 图片直链。');
            }
            state.store = {
                ...state.store,
                floatingAppearance: normalizeFloatingAppearance({ ...state.store.floatingAppearance, imageUrl }),
            };
            persist(context);
            render();
        }
        if (target instanceof HTMLInputElement && target.dataset.preferenceKey) {
            const keys = new Set(state.store.themePreferenceKeys);
            if (target.checked) keys.add(target.dataset.preferenceKey);
            else keys.delete(target.dataset.preferenceKey);
            setThemePreferenceKeys([...keys], context);
        }
        if (target instanceof HTMLInputElement && target.dataset.action === 'toggle-floating-switcher') {
            state.store = { ...state.store, showFloatingSwitcher: target.checked };
            persist(context);
            renderFloatingSwitcher();
        }
        if (target instanceof HTMLInputElement && target.dataset.action === 'toggle-scene-confirmation') {
            state.store = { ...state.store, confirmSceneSwitch: target.checked };
            persist(context);
        }
    }, eventOptions);
    root.addEventListener('input', event => {
        handlePickerInput(event);
    }, eventOptions);
    root.addEventListener('click', async event => {
        const target = event.target.closest?.('[data-action]');
        if (!target || !document.getElementById('srl-scene-switcher')) return;
        const action = target.dataset.action;
        if (await handlePickerAction(target)) return;
        if (action === 'new-scene') {
            state.editor = createSceneFromCurrent(getCurrentSnapshot(), createId());
            render();
        }
        if (action === 'cancel-editor') { state.editor = null; render(); }
        if (action === 'edit-scene') {
            const scene = state.store.scenes.find(item => item.id === target.dataset.sceneId);
            state.editor = scene ? JSON.parse(JSON.stringify(scene)) : null;
            render();
        }
        if (action === 'duplicate-scene') {
            const source = state.store.scenes.find(item => item.id === target.dataset.sceneId);
            if (!source) return;
            const duplicate = cloneScene(source);
            duplicate.id = createId();
            duplicate.name = `${source.name} 副本`;
            duplicate.favorite = false;
            duplicate.updatedAt = Date.now();
            state.store = saveScene(state.store, duplicate);
            persist(context);
            state.notice = `已复制“${source.name}”，可从右侧“⋯”重命名或调整绑定。`;
            render();
        }
        if (action === 'open-character-picker') {
            updateEditorFromForm();
            focusReturnTarget = target;
            state.openPicker = 'character';
            state.pickerPortal = false;
            resetCharacterPicker();
            render({ focusCharacterSearch: true });
        }
        if (action === 'quick-chat') {
            try {
                openChatPicker({ portal: true });
            } catch (error) {
                showToast('warning', error instanceof Error ? error.message : '无法打开聊天记录。');
            }
        }
        if (action === 'quick-api') await applyAndRecordHistory({
            label: `API 类型：${target.textContent?.trim() || target.dataset.apiType}`,
            changed: ['api'],
            task: () => getAdapter().applyApi(target.dataset.apiType),
        });
        if (action === 'quick-managed-api') await applyAndRecordHistory({
            label: `API：${getManagedApiProfile(target.dataset.apiProfileId)?.name ?? ''}`,
            changed: ['managedApi'],
            task: async () => {
                await applyManagedApiProfile(target.dataset.apiProfileId);
            const profile = getManagedApiProfile(target.dataset.apiProfileId);
            state.notice = `已切换 API“${profile?.name ?? ''}”，其他设置保持不变。`;
            showToast('success', state.notice);
            },
        });
        if (action === 'cancel-theme-confirmation') cancelThemeConfirmation();
        if (action === 'confirm-scene-switch') completeSceneConfirmation(true);
        if (action === 'cancel-scene-switch') completeSceneConfirmation(false);
        if (action === 'dismiss-scene-result') { state.sceneResult = null; render(); }
        if (action === 'open-native-api-profile') await runSafely(openNativeApiProfileCreate);
        if (action === 'new-managed-api') {
            state.apiProfileEditor = createApiProfileEditor();
            render();
        }
        if (action === 'cancel-managed-api') {
            state.apiProfileEditor = null;
            render();
        }
        if (action === 'edit-managed-api') {
            const profile = getManagedApiProfile(target.dataset.apiProfileId);
            if (!profile) return;
            state.apiProfileEditor = createApiProfileEditor(profile);
            render();
        }
        if (action === 'save-managed-api') await runSafely(() => saveManagedApiProfile(context));
        if (action === 'apply-managed-api') await applyAndRecordHistory({
            label: `API：${getManagedApiProfile(target.dataset.apiProfileId)?.name ?? ''}`,
            changed: ['managedApi'],
            task: async () => {
                await applyManagedApiProfile(target.dataset.apiProfileId);
            const profile = getManagedApiProfile(target.dataset.apiProfileId);
            state.notice = `已切换 API“${profile?.name ?? ''}”，其余设置保持不变。`;
            showToast('success', state.notice);
            },
        });
        if (action === 'test-managed-api') await runSafely(async () => {
            const profile = getManagedApiProfile(target.dataset.apiProfileId);
            if (!profile) throw new Error('该 API 配置不存在或已被删除');
            const before = getCurrentSnapshot();
            const result = await testManagedApiProfile(profile.id);
            appendApiTestHistory(context, profile, result);
            if (before.managedApiProfileId !== profile.id) {
                appendSwitchHistory(context, {
                    label: `连接测试：${profile.name}`,
                    changed: ['managedApi'],
                    reversible: before.managedApiProfileId ? ['managedApi'] : [],
                    before,
                });
            }
            const resultText = result.status === 'success' ? '酒馆已报告连接成功。' : result.status === 'failed' ? '酒馆报告连接失败。' : '未在 12 秒内观察到酒馆状态变更，请以酒馆顶部连接状态为准。';
            state.notice = `已用酒馆原生连接检测“${profile.name}”：${resultText}`;
            showToast(result.status === 'failed' ? 'warning' : 'info', state.notice);
        });
        if (action === 'import-native-api') {
            try {
                importNativeApiProfile(target.dataset.nativeApiProfileId, context);
                showToast('success', state.notice);
            } catch (error) {
                showToast('error', error instanceof Error ? error.message : '导入失败。');
            }
            render();
        }
        if (action === 'delete-managed-api' && state.apiProfileEditor) {
            state.store = { ...state.store, apiProfiles: removeApiProfile(state.store.apiProfiles, state.apiProfileEditor.id) };
            persist(context);
            state.apiProfileEditor = null;
            state.notice = '已删除 API 配置；酒馆中的密钥不会被删除。';
            render();
        }
        if (action === 'switch-theme-completely') completeThemeConfirmation({ preservePreferences: false });
        if (action === 'switch-theme-preserving-preferences') completeThemeConfirmation({ preservePreferences: true });
        if (action === 'reset-theme-preferences') setThemePreferenceKeys(DEFAULT_THEME_PREFERENCE_KEYS, context);
        if (action === 'select-all-theme-preferences') setThemePreferenceKeys(THEME_PREFERENCE_OPTIONS.map(option => option.key), context);
        if (action === 'clear-theme-preferences') setThemePreferenceKeys([], context);
        if (action === 'quick-character') {
            focusReturnTarget = target;
            state.openPicker = 'quick-character';
            state.pickerPortal = true;
            resetCharacterPicker();
            render({ focusCharacterSearch: true });
        }
        if (action === 'quick-persona') {
            focusReturnTarget = target;
            resetPersonaPicker();
            state.openPicker = 'persona';
            state.pickerPortal = true;
            try {
                await loadPersonaItems();
            } catch (error) {
                state.openPicker = null;
                state.pickerPortal = false;
                showToast('warning', error instanceof Error ? error.message : '无法读取用户人设。');
                render();
            }
        }
        if (action === 'save-scene') {
            updateEditorFromForm();
            state.editor.updatedAt = Date.now();
            state.store = saveScene(state.store, state.editor);
            persist(context);
            state.editor = null;
            state.notice = '组合已保存；只会应用已勾选的项目。';
            render();
        }
        if (action === 'save-scene-as' && state.editor?.id) {
            updateEditorFromForm();
            state.editor = cloneScene(state.editor);
            state.editor.id = createId();
            state.editor.name = `${state.editor.name} 副本`;
            state.editor.favorite = false;
            state.editor.updatedAt = Date.now();
            state.notice = '已创建副本草稿；改名后保存即可，原组合不会被修改。';
            render({ focusSceneName: true });
        }
        if (action === 'delete-scene' && state.editor?.id) {
            state.store = removeScene(state.store, state.editor.id);
            persist(context);
            state.editor = null;
            state.notice = '组合已删除。';
            render();
        }
        if (action === 'apply-scene') await applySceneById(target.dataset.sceneId);
        if (action === 'undo-switch') await runSafely(async () => {
            const entry = state.store.switchHistory.find(item => item.id === target.dataset.historyId);
            if (!entry) throw new Error('这条切换记录已不存在。');
            const restored = await restoreHistoryEntry(entry);
            state.store = { ...state.store, switchHistory: removeSwitchHistory(state.store.switchHistory, entry.id) };
            persist(context);
            state.notice = `已撤回“${entry.label}”：${restored} 已恢复。`;
            showToast('success', state.notice);
        });
    }, eventOptions);
}

export async function activate() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context || typeof context.selectCharacterById !== 'function') {
        showToast('error', '无法取得酒馆原生上下文，插件未启用。');
        return;
    }
    const [presetModule, powerUserModule, secrets, personaModule] = await Promise.all([
        import('/scripts/preset-manager.js'),
        import('/scripts/power-user.js'),
        import('/scripts/secrets.js'),
        import('/scripts/personas.js').catch(() => null),
    ]);
    const apiSelect = document.getElementById('main_api');
    const themeSelect = document.getElementById('themes');
    if (!(apiSelect instanceof HTMLSelectElement) || !(themeSelect instanceof HTMLSelectElement) || typeof presetModule.getPresetManager !== 'function') {
        showToast('warning', '当前酒馆的 API、预设或主题接口未识别；插件未接管任何设置。');
        return;
    }
    runtime = {
        context: () => globalThis.SillyTavern.getContext(),
        presetModule,
        powerUserModule,
        personaModule,
        secrets,
        apiSelect,
        themeSelect,
        profileSelect: getProfileSelect,
    };
    const container = document.getElementById('extensions_settings2');
    if (!container || document.getElementById('srl-scene-switcher')) return;
    const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
    container.insertAdjacentHTML('beforeend', html);
    state.store = getStore(context);
    installKeyboardEvents();
    installEvents(context);
    renderFloatingSwitcher();
    render();
}

export function disable() {
    chatSearchAbortController?.abort();
    chatSearchCache.clear();
    clearTimeout(characterSearchTimer);
    clearTimeout(chatSearchTimer);
    appEventsAbortController?.abort();
    appEventsAbortController = null;
    cancelThemeConfirmation();
    completeSceneConfirmation(false);
    clearFloatingDrag();
    floatingClickSuppressed = false;
    document.getElementById(FLOATING_SWITCHER_ID)?.remove();
    document.getElementById(PICKER_PORTAL_ID)?.remove();
    document.getElementById('srl-scene-switcher')?.remove();
    document.removeEventListener('keydown', handleDocumentKeydown);
    window.removeEventListener('resize', handleFloatingResize);
    floatingResizeInstalled = false;
    keyboardEventsInstalled = false;
    state.floatingOpen = false;
    state.floatingView = 'main';
    state.openPicker = null;
    state.pickerPortal = false;
    runtime = null;
}
