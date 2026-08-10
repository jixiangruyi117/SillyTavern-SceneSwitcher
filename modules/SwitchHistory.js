const HISTORY_LIMIT = 20;
const RECENT_CHARACTER_LIMIT = 12;

function text(value, max = 0) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return max ? normalized.slice(0, max) : normalized;
}

function normalizeSnapshot(value) {
    const snapshot = value && typeof value === 'object' ? value : {};
    return {
        api: text(snapshot.api, 80),
        connectionProfileId: text(snapshot.connectionProfileId, 120),
        connectionProfileName: text(snapshot.connectionProfileName, 80),
        characterAvatar: text(snapshot.characterAvatar, 240),
        characterName: text(snapshot.characterName, 120),
        presetApi: text(snapshot.presetApi, 80),
        presetName: text(snapshot.presetName, 160),
        themeName: text(snapshot.themeName, 160),
        managedApiProfileId: text(snapshot.managedApiProfileId, 120),
    };
}

export function normalizeRecentCharacters(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : [])
        .map(avatar => text(avatar, 240))
        .filter(avatar => avatar && !seen.has(avatar) && Boolean(seen.add(avatar)))
        .slice(0, RECENT_CHARACTER_LIMIT);
}

export function markRecentCharacter(value, avatar) {
    const normalized = text(avatar, 240);
    if (!normalized) return normalizeRecentCharacters(value);
    return normalizeRecentCharacters([normalized, ...normalizeRecentCharacters(value)]);
}

export function normalizeSwitchHistory(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map(entry => ({
        id: text(entry?.id, 120),
        at: Number.isFinite(entry?.at) ? entry.at : 0,
        label: text(entry?.label, 160),
        changed: [...new Set((Array.isArray(entry?.changed) ? entry.changed : []).filter(key => ['connectionProfile', 'api', 'character', 'preset', 'theme', 'managedApi'].includes(key)))],
        reversible: [...new Set((Array.isArray(entry?.reversible) ? entry.reversible : []).filter(key => ['connectionProfile', 'api', 'character', 'preset', 'managedApi'].includes(key)))],
        before: normalizeSnapshot(entry?.before),
    })).filter(entry => entry.id && entry.at && entry.label && !seen.has(entry.id) && Boolean(seen.add(entry.id)))
        .sort((left, right) => right.at - left.at)
        .slice(0, HISTORY_LIMIT);
}

export function prependSwitchHistory(value, entry) {
    return normalizeSwitchHistory([entry, ...normalizeSwitchHistory(value)]);
}

export function removeSwitchHistory(value, id) {
    return normalizeSwitchHistory(value).filter(entry => entry.id !== id);
}

export function normalizeApiTestHistory(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map(entry => ({
        id: text(entry?.id, 120),
        profileId: text(entry?.profileId, 120),
        profileName: text(entry?.profileName, 80),
        startedAt: Number.isFinite(entry?.startedAt) ? entry.startedAt : 0,
        finishedAt: Number.isFinite(entry?.finishedAt) ? entry.finishedAt : 0,
        status: ['success', 'failed', 'unconfirmed'].includes(entry?.status) ? entry.status : 'unconfirmed',
    })).filter(entry => entry.id && entry.profileId && entry.profileName && entry.startedAt && !seen.has(entry.id) && Boolean(seen.add(entry.id)))
        .sort((left, right) => right.startedAt - left.startedAt)
        .slice(0, HISTORY_LIMIT);
}

export function prependApiTestHistory(value, entry) {
    return normalizeApiTestHistory([entry, ...normalizeApiTestHistory(value)]);
}

export function createSwitchHistoryEntry({ id, label, changed, reversible, before, at = Date.now() }) {
    return normalizeSwitchHistory([{ id, label, changed, reversible, before, at }])[0] ?? null;
}
