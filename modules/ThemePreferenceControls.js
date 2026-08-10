export function syncThemePreferenceControls(root, keys) {
    const selected = new Set(keys);
    const count = root?.querySelector?.('[data-theme-preference-count]');
    if (count) count.textContent = String(selected.size);
    root?.querySelectorAll?.('[data-preference-key]')?.forEach(input => {
        input.checked = selected.has(input.dataset.preferenceKey);
    });
}
