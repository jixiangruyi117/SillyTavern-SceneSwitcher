function normalizedText(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

function characterTags(character, tagNames, tagMap) {
    const mapped = Array.isArray(tagMap?.[character?.avatar]) ? tagMap[character.avatar] : [];
    const embedded = Array.isArray(character?.data?.tags) ? character.data.tags : [];
    return [...new Set([...mapped.map(id => tagNames.get(id)), ...embedded]
        .map(value => String(value ?? '').trim())
        .filter(Boolean))].slice(0, 8);
}

function matchRank(item, query) {
    if (!query) return 3;
    if (item.name === query) return 0;
    if (item.name.startsWith(query)) return 1;
    if (item.tags.some(tag => tag.startsWith(query))) return 2;
    return 3;
}

/**
 * Reads only the names and tag metadata already exposed by SillyTavern.
 * It deliberately does not scan character-card content.
 */
export function createCharacterSearchIndex(characters, tags, tagMap) {
    const tagNames = new Map((Array.isArray(tags) ? tags : []).map(tag => [tag?.id, String(tag?.name ?? '').trim()]));
    return (Array.isArray(characters) ? characters : []).map(character => {
        const name = String(character?.name ?? '未命名角色').trim() || '未命名角色';
        const avatar = String(character?.avatar ?? '').trim();
        const labels = characterTags(character, tagNames, tagMap);
        return {
            avatar,
            name,
            normalizedName: normalizedText(name),
            tags: labels,
            normalizedTags: labels.map(normalizedText),
            favorite: character?.fav === true || character?.fav === 'true',
        };
    }).filter(character => character.avatar);
}

export function findCharactersInIndex(index, query = '', { favoritesOnly = false, recentAvatars = [] } = {}) {
    const normalizedQuery = normalizedText(query);
    const recentRank = new Map((Array.isArray(recentAvatars) ? recentAvatars : []).map((avatar, index) => [String(avatar ?? ''), index]));
    return (Array.isArray(index) ? index : [])
        .filter(character => !favoritesOnly || character.favorite)
        .filter(character => !normalizedQuery || character.normalizedName.includes(normalizedQuery)
            || character.normalizedTags.some(tag => tag.includes(normalizedQuery)))
        .map(character => ({ ...character, recentRank: recentRank.get(character.avatar) ?? Number.POSITIVE_INFINITY }))
        .sort((left, right) => {
            const rankDifference = matchRank({ ...left, name: left.normalizedName, tags: left.normalizedTags }, normalizedQuery)
                - matchRank({ ...right, name: right.normalizedName, tags: right.normalizedTags }, normalizedQuery);
            if (rankDifference) return rankDifference;
            if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
            if (left.recentRank !== right.recentRank) return left.recentRank - right.recentRank;
            return left.name.localeCompare(right.name, 'zh-Hans-CN');
        });
}

export function paginateCharacters(characters, page = 1, pageSize = 12) {
    const items = Array.isArray(characters) ? characters : [];
    const size = Math.max(1, Math.floor(pageSize) || 12);
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
    const start = (currentPage - 1) * size;
    return { items: items.slice(start, start + size), page: currentPage, pageCount, total: items.length };
}

export function findCharacters(characters, tags, tagMap, query = '', options = {}) {
    const matches = findCharactersInIndex(createCharacterSearchIndex(characters, tags, tagMap), query, options);
    const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : matches.length;
    return matches.slice(0, limit);
}

export function normalizeChatSearchResults(value, currentChatId = '') {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.map(chat => ({
        id: String(chat?.file_name ?? '').trim(),
        preview: String(chat?.preview_message ?? '').trim(),
        lastMessage: String(chat?.last_mes ?? '').trim(),
        messageCount: Number.isFinite(chat?.message_count) ? chat.message_count : 0,
        current: String(chat?.file_name ?? '') === String(currentChatId ?? ''),
    })).filter(chat => chat.id && !seen.has(chat.id) && Boolean(seen.add(chat.id)));
}

/** Keeps repeated native chat searches from issuing the same request during a short picker session. */
export function createTimedQueryCache({ limit = 20, ttlMs = 30_000 } = {}) {
    const entries = new Map();
    const maxEntries = Math.max(1, Math.floor(limit) || 20);
    const maxAge = Math.max(0, Math.floor(ttlMs) || 30_000);
    return {
        get(key, now = Date.now()) {
            const entry = entries.get(key);
            if (!entry || now - entry.at > maxAge) {
                entries.delete(key);
                return null;
            }
            entries.delete(key);
            entries.set(key, entry);
            return entry.value;
        },
        set(key, value, now = Date.now()) {
            entries.delete(key);
            entries.set(key, { value, at: now });
            while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        },
        clear() {
            entries.clear();
        },
    };
}

/** Builds a compact persona index from SillyTavern's native avatar ids and Power User metadata. */
export function findPersonas(personaIds, powerUserSettings, {
    connectedIds = [],
    currentAvatar = '',
    query = '',
} = {}) {
    const personas = powerUserSettings?.personas && typeof powerUserSettings.personas === 'object' ? powerUserSettings.personas : {};
    const descriptions = powerUserSettings?.persona_descriptions && typeof powerUserSettings.persona_descriptions === 'object'
        ? powerUserSettings.persona_descriptions
        : {};
    const connected = new Set((Array.isArray(connectedIds) ? connectedIds : []).map(value => String(value ?? '')));
    const normalizedQuery = normalizedText(query);
    return [...new Set(Array.isArray(personaIds) ? personaIds : [])]
        .map(avatar => {
            const id = String(avatar ?? '').trim();
            const descriptor = descriptions[id] ?? {};
            return {
                avatar: id,
                name: String(personas[id] ?? id).trim() || id,
                title: String(descriptor.title ?? '').trim(),
                description: String(descriptor.description ?? '').trim(),
                connected: connected.has(id),
                current: id === String(currentAvatar ?? ''),
                default: id === String(powerUserSettings?.default_persona ?? ''),
            };
        })
        .filter(persona => persona.avatar)
        .filter(persona => !normalizedQuery || [persona.name, persona.title, persona.avatar]
            .some(value => normalizedText(value).includes(normalizedQuery)))
        .sort((left, right) => {
            if (left.connected !== right.connected) return left.connected ? -1 : 1;
            if (left.current !== right.current) return left.current ? -1 : 1;
            if (left.default !== right.default) return left.default ? -1 : 1;
            return left.name.localeCompare(right.name, 'zh-Hans-CN');
        });
}
