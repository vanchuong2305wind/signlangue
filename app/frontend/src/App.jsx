import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import Dashboard from './pages/Dashboard';
import Learn from './pages/Learn';
import Translate from './pages/Translate';
import Camera from './pages/Camera';
import VideoTranslate from './pages/VideoTranslate';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/learn" element={<Learn />} />
          <Route path="/translate" element={<Translate />} />
          <Route path="/camera" element={<Camera />} />
          <Route path="/video-translate" element={<VideoTranslate />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
