import { normalizeThemePreferenceKeys } from './ThemePreferenceBridge.js';
import { normalizeApiProfiles } from './ApiProfileModel.js';
import { normalizeFloatingPosition } from './FloatingPosition.js';
import { normalizeFloatingAppearance } from './FloatingAppearance.js';
import { normalizeApiTestHistory, normalizeRecentCharacters, normalizeSwitchHistory } from './SwitchHistory.js?v=0.3.14';

export const SCENE_STORE_VERSION = 7;

const BINDING_KEYS = ['connectionProfile', 'api', 'character', 'preset', 'theme'];

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeBindings(value) {
    const bindings = value && typeof value === 'object' ? value : {};
    return {
        api: text(bindings.api),
        connectionProfileId: text(bindings.connectionProfileId),
        connectionProfileName: text(bindings.connectionProfileName),
        characterAvatar: text(bindings.characterAvatar),
        characterName: text(bindings.characterName),
        presetApi: text(bindings.presetApi),
        presetName: text(bindings.presetName),
        themeName: text(bindings.themeName),
    };
}

function normalizeScope(value, bindings) {
    const scope = value && typeof value === 'object' ? value : {};
    const connectionProfile = Boolean(scope.connectionProfile && bindings.connectionProfileId);
    return {
        connectionProfile,
        api: Boolean(!connectionProfile && scope.api && bindings.api),
        character: Boolean(scope.character && bindings.characterAvatar),
        preset: Boolean(scope.preset && bindings.presetName),
        theme: Boolean(scope.theme && bindings.themeName),
    };
}

export function normalizeScene(value) {
    const bindings = normalizeBindings(value?.bindings);
    return {
        id: text(value?.id),
        name: text(value?.name, '未命名组合').slice(0, 80),
        group: text(value?.group).slice(0, 40),
        favorite: Boolean(value?.favorite),
        scope: normalizeScope(value?.scope, bindings),
        bindings,
        updatedAt: Number.isFinite(value?.updatedAt) ? value.updatedAt : 0,
    };
}

export function normalizeStore(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const seen = new Set();
    const scenes = Array.isArray(raw.scenes)
        ? raw.scenes.map(normalizeScene).filter(scene => {
            if (!scene.id || seen.has(scene.id)) return false;
            seen.add(scene.id);
            return true;
        })
        : [];
    const recents = Array.isArray(raw.recents)
        ? raw.recents.filter(id => typeof id === 'string' && seen.has(id)).slice(0, 8)
        : [];
    return {
        version: SCENE_STORE_VERSION,
        scenes,
        recents,
        showFloatingSwitcher: Boolean(raw.showFloatingSwitcher),
        floatingOpenMode: raw.floatingOpenMode === 'longpress' ? 'longpress' : 'tap',
        floatingPosition: normalizeFloatingPosition(raw.floatingPosition),
        floatingAppearance: normalizeFloatingAppearance(raw.floatingAppearance),
        themePreferenceKeys: normalizeThemePreferenceKeys(raw.themePreferenceKeys),
        apiProfiles: normalizeApiProfiles(raw.apiProfiles),
        recentCharacters: normalizeRecentCharacters(raw.recentCharacters),
        switchHistory: normalizeSwitchHistory(raw.switchHistory),
        apiTestHistory: normalizeApiTestHistory(raw.apiTestHistory),
        confirmSceneSwitch: raw.confirmSceneSwitch !== false,
    };
}

export function createSceneFromCurrent(current, id, now = Date.now()) {
    const bindings = normalizeBindings(current);
    return normalizeScene({
        id,
        name: '新组合',
        favorite: false,
        scope: {
            connectionProfile: Boolean(bindings.connectionProfileId),
            api: Boolean(!bindings.connectionProfileId && bindings.api),
            character: Boolean(bindings.characterAvatar),
            preset: Boolean(bindings.presetName),
            theme: Boolean(bindings.themeName),
        },
        bindings,
        updatedAt: now,
    });
}

export function getEnabledBindingKeys(scene) {
    const normalized = normalizeScene(scene);
    return BINDING_KEYS.filter(key => normalized.scope[key]);
}

export function saveScene(store, scene) {
    const normalizedStore = normalizeStore(store);
    const normalizedScene = normalizeScene(scene);
    if (!normalizedScene.id) throw new TypeError('Scene id is required');
    const scenes = normalizedStore.scenes.filter(item => item.id !== normalizedScene.id);
    scenes.unshift(normalizedScene);
    return { ...normalizedStore, scenes };
}

export function removeScene(store, id) {
    const normalizedStore = normalizeStore(store);
    return {
        ...normalizedStore,
        scenes: normalizedStore.scenes.filter(scene => scene.id !== id),
        recents: normalizedStore.recents.filter(recentId => recentId !== id),
    };
}

export function markRecent(store, id) {
    const normalizedStore = normalizeStore(store);
    if (!normalizedStore.scenes.some(scene => scene.id === id)) return normalizedStore;
    return { ...normalizedStore, recents: [id, ...normalizedStore.recents.filter(item => item !== id)].slice(0, 8) };
}

export function validateScene(scene, adapter) {
    const normalized = normalizeScene(scene);
    const errors = [];
    if (normalized.scope.connectionProfile && !adapter.hasConnectionProfile(normalized.bindings.connectionProfileId)) {
        errors.push('绑定的 API 连接档案不存在');
    }

    if (normalized.scope.api && !adapter.hasApi(normalized.bindings.api)) {
        errors.push('绑定的 API 不存在');
    }
    if (normalized.scope.character && !adapter.hasCharacter(normalized.bindings.characterAvatar)) {
        errors.push('绑定的角色卡不存在');
    }
    if (normalized.scope.preset) {
        if (!adapter.hasPreset(normalized.bindings.presetApi, normalized.bindings.presetName)) {
            errors.push('绑定的预设不存在');
        }
    }
    if (normalized.scope.theme && !adapter.hasTheme(normalized.bindings.themeName)) {
        errors.push('绑定的主题不存在');
    }
    return { valid: errors.length === 0, errors, scene: normalized };
}

export class SwitchQueue {
    #running = false;

    get running() {
        return this.#running;
    }

    async run(task) {
        if (this.#running) return { skipped: true, reason: 'busy' };
        this.#running = true;
        try {
            return await task();
        } finally {
            this.#running = false;
        }
    }
}

export async function applyScene(scene, adapter) {
    const check = validateScene(scene, adapter);
    if (!check.valid) return { applied: false, errors: check.errors };

    const { scope, bindings } = check.scene;
    if (scope.connectionProfile) await adapter.applyConnectionProfile(bindings.connectionProfileId);
    if (scope.api) await adapter.applyApi(bindings.api);
    if (scope.character) await adapter.applyCharacter(bindings.characterAvatar);
    if (scope.preset) await adapter.applyPreset(bindings.presetName, bindings.presetApi || adapter.getCurrent().api);
    if (scope.theme) await adapter.applyTheme(bindings.themeName);
    return { applied: true, changed: getEnabledBindingKeys(check.scene) };
}

export function cloneScene(scene) {
    return clone(normalizeScene(scene));
}
