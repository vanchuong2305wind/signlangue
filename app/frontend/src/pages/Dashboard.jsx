import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import GlassCard from '../components/ui/GlassCard';
import { useSignVideos } from '../hooks/useSignVideos';
import { CATEGORIES } from '../data/categories';
import { getProfile } from '../api/profile';
import './Dashboard.css';

const QUICK_ACTIONS = [
    {
        title: 'Học ký hiệu',
        subtitle: '2000+ từ vựng video',
        icon: 'fa-book-open',
        path: '/learn',
        gradient: 'linear-gradient(135deg, #78c4b6, #5faa9e)',
        glow: 'rgba(96, 180, 168, 0.2)',
    },
    {
        title: 'Dịch giọng nói',
        subtitle: 'Giọng nói → Ký hiệu',
        icon: 'fa-microphone',
        path: '/translate',
        gradient: 'linear-gradient(135deg, #d89890, #c87a72)',
        glow: 'rgba(204, 120, 110, 0.2)',
    },
    {
        title: 'Nhận diện',
        subtitle: 'Camera → Văn bản',
        icon: 'fa-camera',
        path: '/camera',
        gradient: 'linear-gradient(135deg, #8ab4cc, #6a9bba)',
        glow: 'rgba(125, 170, 200, 0.2)',
    },
];

export default function Dashboard() {
    const navigate = useNavigate();
    const { stats } = useSignVideos();
    const [learnedWords, setLearnedWords] = useState(0);

    const refreshProfile = useCallback(() => {
        getProfile()
            .then(data => setLearnedWords(data.stats.learned_words))
            .catch(() => {});
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(refreshProfile, 0);
        window.addEventListener('profile:updated', refreshProfile);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('profile:updated', refreshProfile);
        };
    }, [refreshProfile]);

    return (
        <div className="dashboard animate-fade-in">
            {/* Welcome Banner */}
            <GlassCard variant="strong" padding="xl" className="dashboard__welcome">
                <div className="dashboard__welcome-content">
                    <div className="dashboard__welcome-text">
                        <h2 className="dashboard__welcome-title">
                            Xin chào! <i className="fa-solid fa-feather-pointed dashboard__wave" />
                        </h2>
                        <p className="dashboard__welcome-desc">
                            Hãy bắt đầu học ngôn ngữ ký hiệu ngay hôm nay. Hệ thống có hơn{' '}
                            <strong>{stats.total.toLocaleString()}</strong> video bài học.
                        </p>
                    </div>
                    <div className="dashboard__welcome-illustration">
                        <i className="fa-solid fa-hands animate-float dashboard__big-icon" />
                    </div>
                </div>
            </GlassCard>

            {/* Quick Actions */}
            <div className="dashboard__actions stagger-children">
                {QUICK_ACTIONS.map((action) => (
                    <GlassCard
                        key={action.path}
                        padding="lg"
                        onClick={() => navigate(action.path)}
                        className="dashboard__action-card"
                    >
                        <div
                            className="dashboard__action-icon"
                            style={{ background: action.gradient, boxShadow: `0 6px 20px ${action.glow}` }}
                        >
                            <i className={`fa-solid ${action.icon}`} />
                        </div>
                        <h3 className="dashboard__action-title">{action.title}</h3>
                        <p className="dashboard__action-subtitle">{action.subtitle}</p>
                    </GlassCard>
                ))}
            </div>

            {/* Stats Row */}
            <div className="dashboard__stats stagger-children">
                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-teal)' }}>
                        <i className="fa-solid fa-book-open" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{stats.total.toLocaleString()}</div>
                        <div className="dashboard__stat-label">Tổng từ vựng</div>
                    </div>
                </GlassCard>

                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-rose)' }}>
                        <i className="fa-solid fa-chart-line" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{(stats.with_vi || 0).toLocaleString()}</div>
                        <div className="dashboard__stat-label">Có bản dịch Việt</div>
                    </div>
                </GlassCard>

                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-sky)' }}>
                        <i className="fa-solid fa-folder-open" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{Object.keys(stats.categories).length}</div>
                        <div className="dashboard__stat-label">Chủ đề</div>
                    </div>
                </GlassCard>

                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-gold)' }}>
                        <i className="fa-solid fa-award" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{learnedWords}</div>
                        <div className="dashboard__stat-label">Đã học</div>
                    </div>
                </GlassCard>
            </div>

            {/* Categories Preview */}
            <div className="dashboard__section">
                <h3 className="dashboard__section-title">
                    <i className="fa-solid fa-palette" style={{ marginRight: '8px', opacity: 0.6 }} />
                    Chủ đề phổ biến
                </h3>
                <div className="dashboard__categories stagger-children">
                    {Object.entries(CATEGORIES)
                        .filter(([key]) => key !== 'all' && key !== 'other')
                        .slice(0, 8)
                        .map(([key, cat]) => (
                            <GlassCard
                                key={key}
                                padding="md"
                                onClick={() => navigate(`/learn?category=${key}`)}
                                className="dashboard__category-card"
                            >
                                <div
                                    className="dashboard__category-badge"
                                    style={{ background: cat.gradient }}
                                >
                                    <i className={`fa-solid ${cat.icon}`} />
                                </div>
                                <span className="dashboard__category-name">{cat.label}</span>
                                <span className="dashboard__category-count">
                                    {stats.categories[key] || 0} từ
                                </span>
                            </GlassCard>
                        ))}
                </div>
            </div>
        </div>
    );
}
