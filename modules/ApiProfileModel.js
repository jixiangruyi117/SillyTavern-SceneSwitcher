export const API_PROFILE_LIMIT = 60;

function text(value, max = 0) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return max ? normalized.slice(0, max) : normalized;
}

export function normalizeApiProfile(value) {
    return {
        id: text(value?.id, 120),
        name: text(value?.name, 80),
        url: text(value?.url, 2048),
        model: text(value?.model, 240),
        secretId: text(value?.secretId, 120),
        updatedAt: Number.isFinite(value?.updatedAt) ? value.updatedAt : 0,
    };
}

export function normalizeApiProfiles(value) {
    const seen = new Set();
    if (!Array.isArray(value)) return [];
    return value.map(normalizeApiProfile).filter(profile => {
        if (!profile.id || !profile.name || !profile.url || !profile.model || !profile.secretId || seen.has(profile.id)) return false;
        seen.add(profile.id);
        return true;
    }).slice(0, API_PROFILE_LIMIT);
}

export function saveApiProfile(profiles, profile) {
    const normalized = normalizeApiProfile(profile);
    if (!normalized.id || !normalized.name || !normalized.url || !normalized.model || !normalized.secretId) {
        throw new TypeError('API configuration is incomplete');
    }
    return [normalized, ...normalizeApiProfiles(profiles).filter(item => item.id !== normalized.id)].slice(0, API_PROFILE_LIMIT);
}

export function removeApiProfile(profiles, id) {
    return normalizeApiProfiles(profiles).filter(profile => profile.id !== id);
}
