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

export async function resetActivities() {
    const response = await fetch('/api/profile/activities', { method: 'DELETE' });
    if (!response.ok) throw new Error('Không xóa được tiến độ');
    window.dispatchEvent(new CustomEvent('profile:updated'));
    return response.json();
}
