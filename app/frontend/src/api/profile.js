export async function getProfile() {
    const response = await fetch('/api/profile');
    if (!response.ok) throw new Error('Không tải được hồ sơ');
    return response.json();
}

export async function updateProfile(payload) {
    const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Không lưu được hồ sơ');
    }
    return response.json();
}

export async function recordActivity(type, label, metadata = {}, value = 1) {
    const response = await fetch('/api/profile/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, label, metadata, value }),
    });
    if (!response.ok) throw new Error('Không ghi được hoạt động');
    window.dispatchEvent(new CustomEvent('profile:updated'));
    return response.json();
}

export async function getPrivacyStatus() {
    const response = await fetch('/api/privacy/status');
    if (!response.ok) throw new Error('Không tải được trạng thái quyền riêng tư');
    return response.json();
}

export async function resetActivities(activityType = null) {
    const query = activityType
        ? `?activity_type=${encodeURIComponent(activityType)}`
        : '';
    const response = await fetch(`/api/profile/activities${query}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Không xóa được lịch sử');
    window.dispatchEvent(new CustomEvent('profile:updated'));
    return response.json();
}

export async function deleteProfileAll() {
    const response = await fetch('/api/profile', { method: 'DELETE' });
    if (!response.ok) throw new Error('Không xóa được hồ sơ');
    window.dispatchEvent(new CustomEvent('profile:updated'));
    return response.json();
}
