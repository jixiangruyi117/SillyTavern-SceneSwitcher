const DEFAULT_PADDING = 8;

export function normalizeFloatingPosition(value) {
    if (!value || typeof value !== 'object') return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    return { x: Math.max(0, Math.round(value.x)), y: Math.max(0, Math.round(value.y)) };
}

export function clampFloatingPosition(position, viewport, element = { width: 44, height: 44 }, padding = DEFAULT_PADDING) {
    const normalized = normalizeFloatingPosition(position);
    if (!normalized) return null;
    const width = Math.max(0, Number(viewport?.width) || 0);
    const height = Math.max(0, Number(viewport?.height) || 0);
    const elementWidth = Math.max(0, Number(element?.width) || 0);
    const elementHeight = Math.max(0, Number(element?.height) || 0);
    return {
        x: Math.min(Math.max(padding, normalized.x), Math.max(padding, width - elementWidth - padding)),
        y: Math.min(Math.max(padding, normalized.y), Math.max(padding, height - elementHeight - padding)),
    };
}
