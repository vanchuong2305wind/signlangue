import { useLocation } from 'react-router-dom';
import './Header.css';

const PAGE_TITLES = {
    '/': { title: 'Tổng quan', subtitle: 'Chào mừng bạn trở lại!' },
    '/learn': { title: 'Học ký hiệu', subtitle: 'Khám phá ngôn ngữ ký hiệu qua video' },
    '/translate': { title: 'Dịch giọng nói', subtitle: 'Chuyển đổi giọng nói thành ký hiệu' },
    '/camera': { title: 'Nhận diện ký hiệu', subtitle: 'Dùng camera để nhận diện ký hiệu' },
};

export default function Header({ onSearch }) {
    const location = useLocation();
    const page = PAGE_TITLES[location.pathname] || PAGE_TITLES['/'];

    return (
        <header className="header">
            <div className="header__left">
                <h1 className="header__title">{page.title}</h1>
                <p className="header__subtitle">{page.subtitle}</p>
            </div>

            <div className="header__right">
                {/* Search */}
                <div className="header__search">
                    <i className="fa-solid fa-magnifying-glass header__search-icon" />
                    <input
                        type="text"
                        placeholder="Tìm kiếm từ vựng..."
                        className="header__search-input"
                        onChange={(e) => onSearch?.(e.target.value)}
                    />
                </div>

                {/* Notifications */}
                <button className="header__notification" aria-label="Thông báo">
                    <i className="fa-solid fa-bell" />
                    <span className="header__notification-dot" />
                </button>

                {/* Avatar */}
                <div className="header__avatar">
                    <i className="fa-solid fa-user-graduate" />
                </div>
            </div>
        </header>
    );
}
