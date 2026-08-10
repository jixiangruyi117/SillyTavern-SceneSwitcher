export const THEME_PREFERENCE_OPTIONS = Object.freeze([
    { key: 'fast_ui_mode', group: '外观与排版', label: '禁用模糊（快速 UI）', defaultEnabled: true },
    { key: 'blur_strength', group: '外观与排版', label: '模糊强度', defaultEnabled: true },
    { key: 'shadow_width', group: '外观与排版', label: '阴影宽度', defaultEnabled: true },
    { key: 'noShadows', group: '外观与排版', label: '禁用阴影', defaultEnabled: true },
    { key: 'font_scale', group: '外观与排版', label: '字体大小', defaultEnabled: true },
    { key: 'chat_width', group: '外观与排版', label: '聊天宽度', defaultEnabled: true },
    { key: 'avatar_style', group: '外观与排版', label: '头像样式', defaultEnabled: true },
    { key: 'custom_css', group: '外观与排版', label: '自定义 CSS', defaultEnabled: true },
    { key: 'hideChatAvatars_enabled', group: '聊天显示', label: '隐藏聊天头像', defaultEnabled: false },
    { key: 'expand_message_actions', group: '聊天显示', label: '展开消息操作栏', defaultEnabled: false },
    { key: 'timer_enabled', group: '聊天显示', label: '消息生成计时', defaultEnabled: false },
    { key: 'timestamps_enabled', group: '聊天显示', label: '消息时间戳', defaultEnabled: false },
    { key: 'timestamp_model_icon', group: '聊天显示', label: '消息模型图标', defaultEnabled: false },
    { key: 'message_token_count_enabled', group: '聊天显示', label: '消息 Token 计数', defaultEnabled: false },
    { key: 'mesIDDisplay_enabled', group: '聊天显示', label: '消息楼层编号', defaultEnabled: false },
    { key: 'show_swipe_num_all_messages', group: '聊天显示', label: '显示全部消息分支编号', defaultEnabled: false },
    { key: 'hotswap_enabled', group: '高级', label: '生成时热切换预设', defaultEnabled: false },
]);

export const PERSONAL_THEME_PREFERENCE_KEYS = Object.freeze(THEME_PREFERENCE_OPTIONS.map(option => option.key));
export const DEFAULT_THEME_PREFERENCE_KEYS = Object.freeze(THEME_PREFERENCE_OPTIONS.filter(option => option.defaultEnabled).map(option => option.key));

export function normalizeThemePreferenceKeys(value) {
    if (!Array.isArray(value)) return [...DEFAULT_THEME_PREFERENCE_KEYS];
    const allowed = new Set(PERSONAL_THEME_PREFERENCE_KEYS);
    return [...new Set(value.filter(key => typeof key === 'string' && allowed.has(key)))];
}

function assertPowerUserModule(powerUserModule) {
    if (!powerUserModule?.power_user || typeof powerUserModule.applyPowerUserSettings !== 'function') {
        throw new Error('当前酒馆版本没有个人美化偏好恢复入口');
    }
}

export function capturePersonalThemePreferences(powerUserModule, preferenceKeys = DEFAULT_THEME_PREFERENCE_KEYS) {
    assertPowerUserModule(powerUserModule);
    return Object.fromEntries(normalizeThemePreferenceKeys(preferenceKeys).map(key => [key, powerUserModule.power_user[key]]));
}

export function restorePersonalThemePreferences(powerUserModule, preferences, saveSettingsDebounced) {
    assertPowerUserModule(powerUserModule);
    Object.assign(powerUserModule.power_user, preferences);
    powerUserModule.applyPowerUserSettings();
    saveSettingsDebounced?.();
}

export async function applyThemeWithOptionalPreferences({
    name,
    getCurrentThemeName,
    applyNativeTheme,
    preservePreferences,
    preferenceKeys,
    powerUserModule,
    saveSettingsDebounced,
}) {
    if (getCurrentThemeName() === name) return false;
    const selectedKeys = normalizeThemePreferenceKeys(preferenceKeys);
    const preferences = preservePreferences && selectedKeys.length ? capturePersonalThemePreferences(powerUserModule, selectedKeys) : null;
    await applyNativeTheme(name);
    if (!preferences) return false;
    restorePersonalThemePreferences(powerUserModule, preferences, saveSettingsDebounced);
    return true;
}
