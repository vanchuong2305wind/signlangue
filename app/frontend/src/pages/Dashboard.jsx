import { useNavigate } from 'react-router-dom';
import { BookOpen, Mic, Camera, TrendingUp, Clock, Award } from 'lucide-react';
import GlassCard from '../components/ui/GlassCard';
import { useSignVideos } from '../hooks/useSignVideos';
import { CATEGORIES } from '../data/categories';
import './Dashboard.css';

const QUICK_ACTIONS = [
    {
        title: 'Học ký hiệu',
        subtitle: '2000+ từ vựng video',
        icon: '📚',
        path: '/learn',
        gradient: 'linear-gradient(135deg, #2dd4bf, #14b8a6)',
        glow: 'rgba(45, 212, 191, 0.3)',
    },
    {
        title: 'Dịch giọng nói',
        subtitle: 'Giọng nói → Ký hiệu',
        icon: '🎤',
        path: '/translate',
        gradient: 'linear-gradient(135deg, #fb923c, #f97066)',
        glow: 'rgba(249, 112, 102, 0.3)',
    },
    {
        title: 'Nhận diện',
        subtitle: 'Camera → Văn bản',
        icon: '📷',
        path: '/camera',
        gradient: 'linear-gradient(135deg, #38bdf8, #0ea5e9)',
        glow: 'rgba(56, 189, 248, 0.3)',
    },
];

export default function Dashboard() {
    const navigate = useNavigate();
    const { stats, loading } = useSignVideos();

    return (
        <div className="dashboard animate-fade-in">
            {/* Welcome Banner */}
            <GlassCard variant="strong" padding="xl" className="dashboard__welcome">
                <div className="dashboard__welcome-content">
                    <div className="dashboard__welcome-text">
                        <h2 className="dashboard__welcome-title">
                            Xin chào! <span className="dashboard__wave">👋</span>
                        </h2>
                        <p className="dashboard__welcome-desc">
                            Hãy bắt đầu học ngôn ngữ ký hiệu ngay hôm nay. Hệ thống có hơn{' '}
                            <strong>{stats.total.toLocaleString()}</strong> video bài học.
                        </p>
                    </div>
                    <div className="dashboard__welcome-illustration">
                        <span className="dashboard__big-emoji animate-float">🤟</span>
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
                            style={{ background: action.gradient, boxShadow: `0 8px 24px ${action.glow}` }}
                        >
                            <span>{action.icon}</span>
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
                        <BookOpen size={18} color="white" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{stats.total.toLocaleString()}</div>
                        <div className="dashboard__stat-label">Tổng từ vựng</div>
                    </div>
                </GlassCard>

                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-coral)' }}>
                        <TrendingUp size={18} color="white" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{(stats.with_vi || 0).toLocaleString()}</div>
                        <div className="dashboard__stat-label">Có bản dịch Việt</div>
                    </div>
                </GlassCard>

                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-sky)' }}>
                        <Clock size={18} color="white" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">{Object.keys(stats.categories).length}</div>
                        <div className="dashboard__stat-label">Chủ đề</div>
                    </div>
                </GlassCard>

                <GlassCard padding="lg" hover={false} className="dashboard__stat">
                    <div className="dashboard__stat-icon" style={{ background: 'var(--gradient-warm)' }}>
                        <Award size={18} color="white" />
                    </div>
                    <div>
                        <div className="dashboard__stat-value">0</div>
                        <div className="dashboard__stat-label">Đã học</div>
                    </div>
                </GlassCard>
            </div>

            {/* Categories Preview */}
            <div className="dashboard__section">
                <h3 className="dashboard__section-title">Chủ đề phổ biến</h3>
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
                                    <span>{cat.icon}</span>
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
