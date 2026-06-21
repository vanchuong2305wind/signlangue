import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getProfile, resetActivities, updateProfile } from '../../api/profile';
import './ProfilePanel.css';

const ACTIVITY_META = {
    learned_word: { icon: 'fa-graduation-cap', text: 'Đã học' },
    video_view: { icon: 'fa-play', text: 'Đã xem video' },
    translation: { icon: 'fa-language', text: 'Đã dịch' },
    recognition: { icon: 'fa-camera', text: 'Đã nhận diện' },
    study_time: { icon: 'fa-clock', text: 'Thời gian học' },
};

function formatDuration(minutes = 0) {
    if (minutes < 60) return `${minutes} phút`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTime(value) {
    const date = new Date(value);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
        return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

export default function ProfilePanel({ isOpen, onClose }) {
    const [data, setData] = useState(null);
    const [view, setView] = useState('summary');
    const [form, setForm] = useState({});
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    const loadProfile = useCallback(async () => {
        setLoading(true);
        setMessage('');
        try {
            const result = await getProfile();
            setData(result);
            setForm({
                ...result.profile,
                ...result.settings,
            });
        } catch (error) {
            setMessage(error.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return undefined;
        const timer = window.setTimeout(loadProfile, 0);
        return () => window.clearTimeout(timer);
    }, [isOpen, loadProfile]);

    useEffect(() => {
        const refresh = () => isOpen && loadProfile();
        window.addEventListener('profile:updated', refresh);
        return () => window.removeEventListener('profile:updated', refresh);
    }, [isOpen, loadProfile]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const handleKey = event => event.key === 'Escape' && onClose();
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [isOpen, onClose]);

    async function handleSave(event) {
        event.preventDefault();
        setLoading(true);
        setMessage('');
        try {
            const result = await updateProfile({
                profile: {
                    name: form.name,
                    role: form.role,
                    daily_goal: Number(form.daily_goal),
                },
                settings: {
                    autoplay: Boolean(form.autoplay),
                    notifications: Boolean(form.notifications),
                },
            });
            setData(result);
            setView('summary');
            setMessage('Đã lưu thay đổi.');
        } catch (error) {
            setMessage(error.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleReset() {
        if (!window.confirm('Xóa toàn bộ tiến độ và lịch sử hoạt động?')) return;
        setLoading(true);
        try {
            const result = await resetActivities();
            setData(result);
            setMessage('Đã đặt lại tiến độ.');
        } catch (error) {
            setMessage(error.message);
        } finally {
            setLoading(false);
        }
    }

    const profile = data?.profile || {};
    const stats = data?.stats || {};
    const today = data?.today || {};
    const progress = stats.total_words
        ? Math.round((stats.learned_words / stats.total_words) * 100)
        : 0;

    return createPortal(
        <>
            <div
                className={`profile-panel__backdrop ${isOpen ? 'profile-panel__backdrop--visible' : ''}`}
                onClick={onClose}
            />
            <aside
                className={`profile-panel ${isOpen ? 'profile-panel--open' : ''}`}
                aria-hidden={!isOpen}
            >
                <div className="profile-panel__header">
                    <span className="profile-panel__title">Hồ sơ của tôi</span>
                    <button className="profile-panel__close" onClick={onClose} aria-label="Đóng">
                        <i className="fa-solid fa-xmark" />
                    </button>
                </div>

                {loading && !data ? (
                    <div className="profile-panel__state">Đang tải hồ sơ...</div>
                ) : !data ? (
                    <div className="profile-panel__state">
                        <p>{message || 'Không có dữ liệu hồ sơ.'}</p>
                        <button className="profile-panel__primary-btn" onClick={loadProfile}>Thử lại</button>
                    </div>
                ) : view === 'edit' ? (
                    <form className="profile-panel__form" onSubmit={handleSave}>
                        <label>
                            Tên hiển thị
                            <input
                                value={form.name || ''}
                                maxLength={80}
                                required
                                onChange={event => setForm(current => ({
                                    ...current,
                                    name: event.target.value,
                                }))}
                            />
                        </label>
                        <label>
                            Vai trò
                            <input
                                value={form.role || ''}
                                maxLength={120}
                                onChange={event => setForm(current => ({
                                    ...current,
                                    role: event.target.value,
                                }))}
                            />
                        </label>
                        <label>
                            Mục tiêu từ mới mỗi ngày
                            <input
                                type="number"
                                min="1"
                                max="200"
                                value={form.daily_goal || 10}
                                onChange={event => setForm(current => ({
                                    ...current,
                                    daily_goal: event.target.value,
                                }))}
                            />
                        </label>
                        <label className="profile-panel__switch-row">
                            <span>Tự động phát video</span>
                            <input
                                type="checkbox"
                                checked={Boolean(form.autoplay)}
                                onChange={event => setForm(current => ({
                                    ...current,
                                    autoplay: event.target.checked,
                                }))}
                            />
                        </label>
                        <label className="profile-panel__switch-row">
                            <span>Nhận thông báo</span>
                            <input
                                type="checkbox"
                                checked={Boolean(form.notifications)}
                                onChange={event => setForm(current => ({
                                    ...current,
                                    notifications: event.target.checked,
                                }))}
                            />
                        </label>
                        <div className="profile-panel__form-actions">
                            <button type="button" onClick={() => setView('summary')}>Hủy</button>
                            <button type="submit" className="profile-panel__primary-btn" disabled={loading}>
                                {loading ? 'Đang lưu...' : 'Lưu'}
                            </button>
                        </div>
                    </form>
                ) : view === 'help' ? (
                    <div className="profile-panel__help">
                        <h3>Cách tính tiến độ</h3>
                        <p>Một từ được tính là đã học khi bạn mở từ đó trong trang Học ký hiệu.</p>
                        <p>Lịch sử dịch được ghi khi API dịch câu thành công. Tiến độ được lưu trên máy chủ local.</p>
                        <button className="profile-panel__primary-btn" onClick={() => setView('summary')}>
                            Quay lại
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="profile-panel__user">
                            <div className="profile-panel__avatar-large">
                                <i className="fa-solid fa-user-graduate" />
                            </div>
                            <div className="profile-panel__user-info">
                                <div className="profile-panel__user-name">{profile.name}</div>
                                <div className="profile-panel__user-role">{profile.role}</div>
                            </div>
                            <button
                                className="profile-panel__edit"
                                onClick={() => setView('edit')}
                                aria-label="Chỉnh sửa hồ sơ"
                            >
                                <i className="fa-solid fa-pen" />
                            </button>
                        </div>

                        <div className="profile-panel__stats">
                            <Stat value={stats.learned_words} label="Từ đã học" color="var(--wc-teal-dark)" />
                            <Stat value={stats.streak} label="Ngày liên tiếp" color="var(--wc-gold)" />
                            <Stat value={stats.total_words} label="Tổng từ vựng" color="var(--wc-sky)" />
                            <Stat value={formatDuration(stats.total_minutes)} label="Tổng thời gian" color="var(--wc-sage)" />
                        </div>

                        <div className="profile-panel__section">
                            <div className="profile-panel__section-title">
                                <i className="fa-solid fa-chart-line" />
                                Tiến độ học tập
                            </div>
                            <div className="profile-panel__progress-bar">
                                <div className="profile-panel__progress-fill" style={{ width: `${progress}%` }} />
                            </div>
                            <div className="profile-panel__progress-text">
                                {stats.learned_words}/{stats.total_words} từ ({progress}%)
                            </div>
                            <div className="profile-panel__daily-goal">
                                Mục tiêu hôm nay: {today.learned_words}/{profile.daily_goal} từ
                            </div>
                        </div>

                        <div className="profile-panel__section">
                            <div className="profile-panel__section-title">
                                <i className="fa-solid fa-calendar-day" />
                                Hoạt động hôm nay
                            </div>
                            <div className="profile-panel__today-list">
                                <Today icon="fa-book-open" label="Từ đã học" value={today.learned_words} />
                                <Today icon="fa-video" label="Video đã xem" value={today.videos} />
                                <Today icon="fa-language" label="Lần dịch" value={today.translations} />
                                <Today icon="fa-camera" label="Lần nhận diện" value={today.recognitions} />
                            </div>
                        </div>

                        <div className="profile-panel__section">
                            <div className="profile-panel__section-title">
                                <i className="fa-solid fa-clock-rotate-left" />
                                Lịch sử hoạt động
                            </div>
                            <div className="profile-panel__history-list">
                                {data.history.length === 0 ? (
                                    <div className="profile-panel__empty">Chưa có hoạt động.</div>
                                ) : data.history.map(item => {
                                    const meta = ACTIVITY_META[item.type] || ACTIVITY_META.study_time;
                                    return (
                                        <div key={item.id} className="profile-panel__history-item">
                                            <span className="profile-panel__history-time">{formatTime(item.created_at)}</span>
                                            <i className={`fa-solid ${meta.icon} profile-panel__history-icon`} />
                                            <span className="profile-panel__history-text">
                                                {meta.text}{item.label ? ` “${item.label}”` : ''}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {message && <div className="profile-panel__message">{message}</div>}
                        <div className="profile-panel__actions">
                            <button className="profile-panel__action-btn" onClick={() => setView('edit')}>
                                <i className="fa-solid fa-gear profile-panel__action-icon" /> Cài đặt
                            </button>
                            <button className="profile-panel__action-btn" onClick={() => setView('help')}>
                                <i className="fa-solid fa-circle-question profile-panel__action-icon" /> Trợ giúp
                            </button>
                            <button
                                className="profile-panel__action-btn profile-panel__action-btn--danger"
                                onClick={handleReset}
                            >
                                <i className="fa-solid fa-trash-can profile-panel__action-icon" /> Đặt lại tiến độ
                            </button>
                        </div>
                    </>
                )}
            </aside>
        </>,
        document.body,
    );
}

function Stat({ value, label, color }) {
    return (
        <div className="profile-panel__stat">
            <span className="profile-panel__stat-value" style={{ color }}>{value}</span>
            <span className="profile-panel__stat-label">{label}</span>
        </div>
    );
}

function Today({ icon, label, value }) {
    return (
        <div className="profile-panel__today-item">
            <div className="profile-panel__today-icon"><i className={`fa-solid ${icon}`} /></div>
            <div className="profile-panel__today-info">
                <div className="profile-panel__today-label">{label}</div>
            </div>
            <div className="profile-panel__today-value">{value || 0}</div>
        </div>
    );
}
