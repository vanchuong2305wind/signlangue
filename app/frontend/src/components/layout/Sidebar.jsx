import { NavLink, useLocation } from 'react-router-dom';
import { BookOpen, Mic, Camera, BarChart3, Settings, Hand, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import './Sidebar.css';

const NAV_ITEMS = [
    { path: '/', icon: BarChart3, label: 'Tổng quan', emoji: '📊' },
    { path: '/learn', icon: BookOpen, label: 'Học ký hiệu', emoji: '📚' },
    { path: '/translate', icon: Mic, label: 'Dịch giọng nói', emoji: '🎤' },
    { path: '/camera', icon: Camera, label: 'Nhận diện', emoji: '📷' },
];

export default function Sidebar() {
    const [collapsed, setCollapsed] = useState(false);
    const location = useLocation();

    return (
        <aside className={`sidebar glass-heavy ${collapsed ? 'sidebar--collapsed' : ''}`}>
            {/* Logo */}
            <div className="sidebar__logo">
                <div className="sidebar__logo-icon">
                    <Hand size={24} strokeWidth={2.5} />
                </div>
                {!collapsed && (
                    <div className="sidebar__logo-text">
                        <span className="sidebar__logo-title">SignLang</span>
                        <span className="sidebar__logo-subtitle">Học ngôn ngữ ký hiệu</span>
                    </div>
                )}
            </div>

            {/* Navigation */}
            <nav className="sidebar__nav">
                {NAV_ITEMS.map((item) => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        className={({ isActive }) =>
                            `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
                        }
                        title={collapsed ? item.label : undefined}
                    >
                        <span className="sidebar__link-icon">{item.emoji}</span>
                        {!collapsed && <span className="sidebar__link-label">{item.label}</span>}
                        {!collapsed && location.pathname === item.path && (
                            <span className="sidebar__link-indicator" />
                        )}
                    </NavLink>
                ))}
            </nav>

            {/* Collapse toggle */}
            <button
                className="sidebar__toggle"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? 'Mở rộng sidebar' : 'Thu gọn sidebar'}
            >
                {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>

            {/* Bottom section */}
            {!collapsed && (
                <div className="sidebar__footer">
                    <div className="sidebar__progress-card">
                        <div className="sidebar__progress-label">Tiến độ hôm nay</div>
                        <div className="sidebar__progress-bar">
                            <div className="sidebar__progress-fill" style={{ width: '35%' }} />
                        </div>
                        <div className="sidebar__progress-text">7 / 20 từ</div>
                    </div>
                </div>
            )}
        </aside>
    );
}
