const API_CONNECTION_PROFILE_KEYS = new Set([
    'id',
    'mode',
    'name',
    'api',
    'api-url',
    'model',
    'proxy',
    'secret-id',
    'exclude',
]);

export const NATIVE_API_PROFILE_FIELD_NAMES = Object.freeze([
    'API',
    'Server URL',
    'Model',
    'Secret',
]);

export function isApiOnlyProfile(profile) {
    if (!profile?.id || !profile?.name || !profile.api) return false;
    return Object.keys(profile).every(key => API_CONNECTION_PROFILE_KEYS.has(key));
}

export function getApiOnlyProfiles(profiles) {
    return Array.isArray(profiles) ? profiles.filter(isApiOnlyProfile) : [];
}

export function getImportableApiProfiles(profiles) {
    if (!Array.isArray(profiles)) return [];
    return profiles.filter(profile => profile?.api === 'custom').map(profile => ({
        sourceId: typeof profile?.id === 'string' ? profile.id : '',
        name: typeof profile?.name === 'string' ? profile.name.trim() : '',
        url: typeof profile?.['api-url'] === 'string' ? profile['api-url'].trim() : '',
        model: typeof profile?.model === 'string' ? profile.model.trim() : '',
        secretId: typeof profile?.['secret-id'] === 'string' ? profile['secret-id'].trim() : '',
    })).filter(profile => profile.sourceId && profile.name && profile.url && profile.model && profile.secretId);
}

export function configureNativeApiProfileFields(inputs) {
    const selected = new Set(NATIVE_API_PROFILE_FIELD_NAMES);
    let changed = 0;
    for (const input of inputs) {
        const shouldInclude = selected.has(input.value);
        if (input.checked === shouldInclude) continue;
        input.checked = shouldInclude;
        input.dispatchEvent?.(new Event('input', { bubbles: true }));
        changed += 1;
    }
    return changed;
}
