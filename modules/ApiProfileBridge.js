export async function applyApiCustomProfile(profile, adapter) {
    if (!profile?.id || !profile.url || !profile.model || !profile.secretId) {
        throw new TypeError('API configuration is incomplete');
    }
    if (!adapter.hasSecret(profile.secretId)) {
        throw new Error('该 API 配置引用的密钥已在酒馆中删除，请编辑配置并重新填写密钥');
    }
    await adapter.ensureApiCustom();
    await adapter.setCustomUrl(profile.url);
    await adapter.setCustomModel(profile.model);
    await adapter.setCustomSecret(profile.secretId);
}
