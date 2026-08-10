export const FLOATING_ACCENTS = [
    { value: 'coral', label: '珊瑚橘' },
    { value: 'teal', label: '青绿' },
    { value: 'violet', label: '鸢尾紫' },
    { value: 'gold', label: '鎏金' },
];

const DEFAULT_ACCENT = FLOATING_ACCENTS[0].value;

export function normalizeFloatingImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' && url.hostname ? url.href : '';
    } catch {
        return '';
    }
}

export function normalizeFloatingAppearance(value) {
    const accent = FLOATING_ACCENTS.some(option => option.value === value?.accent)
        ? value.accent
        : DEFAULT_ACCENT;
    return { accent, imageUrl: normalizeFloatingImageUrl(value?.imageUrl) };
}
