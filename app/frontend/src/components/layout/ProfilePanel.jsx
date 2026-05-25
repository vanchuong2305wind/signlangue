import { createPortal } from 'react-dom';
import './ProfilePanel.css';

const MOCK_USER = {
    name: 'Người học',
    role: 'Học viên ngôn ngữ ký hiệu',
    totalWords: 156,
    learnedWords: 42,
    streak: 7,
    totalTime: '12h 30m',
};

const TODAY_ACTIVITY = [
    { icon: 'fa-book-open', label: 'Từ đã học', value: '8 từ', bg: 'var(--wash-teal)', color: 'var(--wc-teal-dark)' },
    { icon: 'fa-video', label: 'Video đã xem', value: '15 video', bg: 'var(--wash-sky)', color: 'var(--wc-sky)' },
    { icon: 'fa-clock', label: 'Thời gian học', value: '25 phút', bg: 'var(--wash-gold)', color: 'var(--wc-gold)' },
    { icon: 'fa-camera', label: 'Lần nhận diện', value: '3 lần', bg: 'var(--wash-sage)', color: 'var(--wc-sage)' },
];

const HISTORY = [
    { time: '3:15', text: 'Xem video "Xin chào"', icon: 'fa-play' },
    { time: '3:10', text: 'Học từ "Cảm ơn"', icon: 'fa-graduation-cap' },
    { time: '2:55', text: 'Dịch giọng nói → ký hiệu', icon: 'fa-language' },
    { time: '2:40', text: 'Xem video "Tạm biệt"', icon: 'fa-play' },
    { time: '2:30', text: 'Nhận diện ký hiệu qua camera', icon: 'fa-camera' },
    { time: '2:15', text: 'Học từ "Xin lỗi"', icon: 'fa-graduation-cap' },
    { time: '1:50', text: 'Xem danh mục Chào hỏi', icon: 'fa-folder-open' },
];

export default function ProfilePanel({ isOpen, onClose }) {
    const progress = Math.round((MOCK_USER.learnedWords / MOCK_USER.totalWords) * 100);

    return createPortal(
        <>
            {/* Backdrop */}
            <div
                className={`profile-panel__backdrop ${isOpen ? 'profile-panel__backdrop--visible' : ''}`}
                onClick={onClose}
            />

            {/* Panel */}
            <aside className={`profile-panel ${isOpen ? 'profile-panel--open' : ''}`}>
                {/* Header */}
                <div className="profile-panel__header">
                    <span className="profile-panel__title">Hồ sơ của tôi</span>
                    <button className="profile-panel__close" onClick={onClose}>
                        <i className="fa-solid fa-xmark" />
                    </button>
                </div>

                {/* User Card */}
                <div className="profile-panel__user">
                    <div className="profile-panel__avatar-large">
                        <i className="fa-solid fa-user-graduate" />
                    </div>
                    <div className="profile-panel__user-info">
                        <div className="profile-panel__user-name">{MOCK_USER.name}</div>
                        <div className="profile-panel__user-role">{MOCK_USER.role}</div>
                    </div>
                </div>

                {/* Stats */}
                <div className="profile-panel__stats">
                    <div className="profile-panel__stat">
                        <span className="profile-panel__stat-value" style={{ color: 'var(--wc-teal-dark)' }}>
                            {MOCK_USER.learnedWords}
                        </span>
                        <span className="profile-panel__stat-label">Từ đã học</span>
                    </div>
                    <div className="profile-panel__stat">
                        <span className="profile-panel__stat-value" style={{ color: 'var(--wc-gold)' }}>
                            {MOCK_USER.streak}
                        </span>
                        <span className="profile-panel__stat-label">Ngày liên tiếp</span>
                    </div>
                    <div className="profile-panel__stat">
                        <span className="profile-panel__stat-value" style={{ color: 'var(--wc-sky)' }}>
                            {MOCK_USER.totalWords}
                        </span>
                        <span className="profile-panel__stat-label">Tổng từ vựng</span>
                    </div>
                    <div className="profile-panel__stat">
                        <span className="profile-panel__stat-value" style={{ color: 'var(--wc-sage)' }}>
                            {MOCK_USER.totalTime}
                        </span>
                        <span className="profile-panel__stat-label">Tổng thời gian</span>
                    </div>
                </div>

                {/* Progress */}
                <div className="profile-panel__section">
                    <div className="profile-panel__section-title">
                        <i className="fa-solid fa-chart-line" style={{ color: 'var(--wc-teal)' }} />
                        Tiến độ học tập
                    </div>
                    <div className="profile-panel__progress-bar">
                        <div
                            className="profile-panel__progress-fill"
                            style={{
                                width: `${progress}%`,
                                background: 'var(--gradient-teal)',
                            }}
                        />
                    </div>
                    <div className="profile-panel__progress-text">
                        {MOCK_USER.learnedWords}/{MOCK_USER.totalWords} từ ({progress}% hoàn thành)
                    </div>
                </div>

                {/* Today */}
                <div className="profile-panel__section">
                    <div className="profile-panel__section-title">
                        <i className="fa-solid fa-calendar-day" style={{ color: 'var(--wc-gold)' }} />
                        Hoạt động hôm nay
                    </div>
                    <div className="profile-panel__today-list">
                        {TODAY_ACTIVITY.map((item, i) => (
                            <div key={i} className="profile-panel__today-item">
                                <div
                                    className="profile-panel__today-icon"
                                    style={{ background: item.bg, color: item.color }}
                                >
                                    <i className={`fa-solid ${item.icon}`} />
                                </div>
                                <div className="profile-panel__today-info">
                                    <div className="profile-panel__today-label">{item.label}</div>
                                </div>
                                <div className="profile-panel__today-value">{item.value}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* History */}
                <div className="profile-panel__section">
                    <div className="profile-panel__section-title">
                        <i className="fa-solid fa-clock-rotate-left" style={{ color: 'var(--wc-sky)' }} />
                        Lịch sử hoạt động
                    </div>
                    <div className="profile-panel__history-list">
                        {HISTORY.map((item, i) => (
                            <div key={i} className="profile-panel__history-item">
                                <span className="profile-panel__history-time">{item.time}</span>
                                <i className={`fa-solid ${item.icon} profile-panel__history-icon`} />
                                <span className="profile-panel__history-text">{item.text}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Actions */}
                <div className="profile-panel__actions">
                    <button className="profile-panel__action-btn">
                        <i className="fa-solid fa-gear profile-panel__action-icon" />
                        Cài đặt
                    </button>
                    <button className="profile-panel__action-btn">
                        <i className="fa-solid fa-circle-question profile-panel__action-icon" />
                        Trợ giúp
                    </button>
                    <button className="profile-panel__action-btn profile-panel__action-btn--danger">
                        <i className="fa-solid fa-right-from-bracket profile-panel__action-icon" />
                        Đăng xuất
                    </button>
                </div>
            </aside>
        </>,
        document.body
    );
}
