import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import './Layout.css';

export default function Layout() {
    return (
        <div className="layout">
            <Sidebar />
            <main className="layout__main">
                <Header />
                <div className="layout__content">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
