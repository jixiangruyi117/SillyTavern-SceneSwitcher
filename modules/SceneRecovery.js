import { applyScene, normalizeScene, validateScene } from './SceneModel.js?v=0.3.14';

const RECOVERABLE_KEYS = new Set(['connectionProfile', 'api', 'character', 'preset']);

export function createRecoveryScene(snapshot, keys) {
    const wanted = new Set(keys);
    const bindings = {
        api: snapshot.api,
        connectionProfileId: snapshot.connectionProfileId,
        connectionProfileName: snapshot.connectionProfileName,
        characterAvatar: snapshot.characterAvatar,
        characterName: snapshot.characterName,
        presetApi: snapshot.presetApi,
        presetName: snapshot.presetName,
        themeName: snapshot.themeName,
    };
    return normalizeScene({
        id: 'scene-switch-recovery',
        name: '恢复原状态',
        bindings,
        scope: {
            connectionProfile: wanted.has('connectionProfile') && Boolean(bindings.connectionProfileId),
            api: wanted.has('api') && !bindings.connectionProfileId && Boolean(bindings.api),
            character: wanted.has('character') && Boolean(bindings.characterAvatar),
            preset: wanted.has('preset') && Boolean(bindings.presetName),
            theme: false,
        },
    });
}

export function getRecoverableKeys(snapshot, changed) {
    const wanted = new Set(changed);
    const keys = [];
    if (wanted.has('connectionProfile') && snapshot.connectionProfileId) keys.push('connectionProfile');
    if (wanted.has('api') && !snapshot.connectionProfileId && snapshot.api) keys.push('api');
    if (wanted.has('character') && snapshot.characterAvatar) keys.push('character');
    if (wanted.has('preset') && snapshot.presetName) keys.push('preset');
    return keys.filter(key => RECOVERABLE_KEYS.has(key));
}

/**
 * Applies a prevalidated scene and restores only independently verifiable native bindings.
 * Themes are deliberately excluded: reapplying a theme may overwrite user theme preferences.
 */
export async function applySceneWithRecovery(scene, adapter, before) {
    const check = validateScene(scene, adapter);
    if (!check.valid) return { applied: false, errors: check.errors, recovered: [], recoveryErrors: [] };

    const applied = [];
    const { scope, bindings } = check.scene;
    const steps = [
        ['connectionProfile', scope.connectionProfile, () => adapter.applyConnectionProfile(bindings.connectionProfileId)],
        ['api', scope.api, () => adapter.applyApi(bindings.api)],
        ['character', scope.character, () => adapter.applyCharacter(bindings.characterAvatar)],
        ['preset', scope.preset, () => adapter.applyPreset(bindings.presetName, bindings.presetApi || adapter.getCurrent().api)],
        ['theme', scope.theme, () => adapter.applyTheme(bindings.themeName)],
    ];

    try {
        for (const [key, enabled, apply] of steps) {
            if (!enabled) continue;
            await apply();
            applied.push(key);
        }
        return { applied: true, changed: applied, recovered: [], recoveryErrors: [] };
    } catch (error) {
        const recoverable = getRecoverableKeys(before, applied);
        const recovery = createRecoveryScene(before, recoverable);
        const recoveryResult = await applyScene(recovery, adapter);
        return {
            applied: false,
            error,
            changed: applied,
            recovered: recoveryResult.applied ? recoveryResult.changed : [],
            recoveryErrors: recoveryResult.applied ? [] : recoveryResult.errors,
            unrecovered: applied.filter(key => !recoverable.includes(key)),
        };
    }
}
