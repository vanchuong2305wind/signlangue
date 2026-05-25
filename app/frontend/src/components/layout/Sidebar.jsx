import { NavLink, useLocation } from 'react-router-dom';
import { useState } from 'react';
import './Sidebar.css';

const NAV_ITEMS = [
    { path: '/', icon: 'fa-chart-pie', label: 'Tổng quan' },
    { path: '/learn', icon: 'fa-book-open', label: 'Học' },
    { path: '/translate', icon: 'fa-microphone', label: 'Dịch' },
    { path: '/camera', icon: 'fa-camera', label: 'Camera' },
];

export default function Sidebar() {
    const [collapsed, setCollapsed] = useState(false);
    const location = useLocation();

    return (
        <>
            {/* Desktop Sidebar */}
            <aside className={`sidebar sidebar--desktop ${collapsed ? 'sidebar--collapsed' : ''}`}>
                {/* Logo */}
                <div className="sidebar__logo">
                    <div className="sidebar__logo-icon">
                        <i className="fa-solid fa-hands" />
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
                            <span className="sidebar__link-icon">
                                <i className={`fa-solid ${item.icon}`} />
                            </span>
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
                    <i className={`fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-left'}`} style={{ fontSize: '11px' }} />
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

            {/* Mobile Bottom Navigation */}
            <nav className="mobile-nav" aria-label="Mobile navigation">
                {NAV_ITEMS.map((item) => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        className={({ isActive }) =>
                            `mobile-nav__link ${isActive ? 'mobile-nav__link--active' : ''}`
                        }
                    >
                        <i className={`fa-solid ${item.icon}`} />
                        <span className="mobile-nav__label">{item.label}</span>
                    </NavLink>
                ))}
            </nav>
        </>
    );
}
