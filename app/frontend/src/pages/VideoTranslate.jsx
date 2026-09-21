import { lazy, Suspense, useState, useRef, useCallback, useEffect } from 'react';
import GlassCard from '../components/ui/GlassCard';
import useSpeechRecognition from '../hooks/useSpeechRecognition';
import useSignTranslation from '../hooks/useSignTranslation';
import './VideoTranslate.css';

const AvatarScene3D = lazy(() => import('../components/avatar/AvatarScene3D'));

/* ── Helpers ── */

/** Detect video platform from a URL string. */
function detectPlatform(url) {
    if (!url) return null;
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) return 'direct';
    // Treat anything else as a generic embed attempt
    return 'direct';
}

/** Convert a YouTube URL to an embeddable src. */
function toYouTubeEmbed(url) {
    try {
        const u = new URL(url);
        let videoId = '';
        if (u.hostname === 'youtu.be') {
            videoId = u.pathname.slice(1);
        } else {
            videoId = u.searchParams.get('v') || '';
        }
        if (!videoId) return null;
        return `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
    } catch {
        return null;
    }
}

/** Convert a TikTok URL to an oEmbed-friendly embed URL. */
function toTikTokEmbed(url) {
    // TikTok embed via their iframe
    try {
        const match = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
        if (match) {
            return `https://www.tiktok.com/embed/v2/${match[1]}`;
        }
    } catch { /* ignore */ }
    return null;
}

export default function VideoTranslate() {
    // Layout: 'side-by-side' or 'overlay'
    const [layout, setLayout] = useState('side-by-side');
    // Video state
    const [videoUrl, setVideoUrl] = useState('');
    const [loadedVideo, setLoadedVideo] = useState(null); // { url, platform, embedSrc }
    // Translation state
    const [textInput, setTextInput] = useState('');
    const [interimText, setInterimText] = useState('');
    const [playToken, setPlayToken] = useState(0);
    const [activeSignIdx, setActiveSignIdx] = useState(0);

    const avatarRef = useRef(null);
    const { isLoading, result, translate, clear } = useSignTranslation();

    const resultRef = useRef(null);
    useEffect(() => { resultRef.current = result; }, [result]);

    /* ── Speech Recognition ── */
    const handleFinal = useCallback(({ text }) => {
        setInterimText('');
        setTextInput(text);
        // Auto-translate
        runTranslation(text);
    }, []);

    const handleInterim = useCallback(({ text }) => {
        setInterimText(text);
    }, []);

    const handleSpeechError = useCallback(() => {}, []);

    const { state: speechState, isSupported, toggle: toggleSpeech } = useSpeechRecognition({
        lang: 'vi-VN',
        onFinal: handleFinal,
        onInterim: handleInterim,
        onError: handleSpeechError,
    });

    /* ── Video Loading ── */
    function handleLoadVideo(e) {
        e?.preventDefault();
        const url = videoUrl.trim();
        if (!url) return;

        const platform = detectPlatform(url);
        let embedSrc = url;

        if (platform === 'youtube') {
            embedSrc = toYouTubeEmbed(url) || url;
        } else if (platform === 'tiktok') {
            embedSrc = toTikTokEmbed(url) || url;
        }

        setLoadedVideo({ url, platform, embedSrc });
    }

    function handleCloseVideo() {
        setLoadedVideo(null);
        setVideoUrl('');
    }

    /* ── Translation ── */
    const runTranslation = useCallback(async (text) => {
        setActiveSignIdx(0);
        const data = await translate(text);
        if (data?.signs?.length) setPlayToken(t => t + 1);
    }, [translate]);

    // Play on 3D avatar when translation completes
    useEffect(() => {
        const signs = resultRef.current?.signs;
        if (!signs?.length) return;

        if (avatarRef.current?.isModelLoaded) {
            avatarRef.current.playSignSequence(signs);
            return;
        }

        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            if (avatarRef.current?.isModelLoaded) {
                avatarRef.current.playSignSequence(signs);
                clearInterval(timer);
            } else if (attempts >= 100) {
                clearInterval(timer);
            }
        }, 100);
        return () => clearInterval(timer);
    }, [playToken]);

    function handleTextSubmit(e) {
        e.preventDefault();
        const text = textInput.trim();
        if (!text) return;
        runTranslation(text);
    }

    function handleClear() {
        clear();
        setActiveSignIdx(0);
        setTextInput('');
        setInterimText('');
        if (avatarRef.current) avatarRef.current.stopAnimation();
    }

    function handleSignChipClick(idx) {
        setActiveSignIdx(idx);
        const sign = result?.signs?.[idx];
        if (sign?.found && avatarRef.current?.isModelLoaded) {
            avatarRef.current.playSignSequence([sign]);
        }
    }

    function handleReplay() {
        if (!result?.signs?.length) return;
        setActiveSignIdx(0);
        setPlayToken(t => t + 1);
    }

    const isTranslating = isLoading;
    const hasResult = result?.signs?.length > 0;

    return (
        <div className="vt-page">
            {/* Decorative blobs */}
            <div className="wc-blob vt-page wc-blob-1" />
            <div className="wc-blob vt-page wc-blob-2" />

            {/* ── Top Bar ── */}
            <div className="vt-top-bar">
                <div className="vt-title-group">
                    <div className="vt-icon">
                        <i className="fa-solid fa-film" />
                    </div>
                    <div>
                        <h1 className="vt-title">Video & Dịch ký hiệu</h1>
                        <p className="vt-subtitle">Xem video từ YouTube, TikTok và dịch ngôn ngữ ký hiệu cùng lúc</p>
                    </div>
                </div>
                <div className="vt-layout-toggle">
                    <button
                        className={`vt-layout-btn ${layout === 'overlay' ? 'active' : ''}`}
                        onClick={() => setLayout('overlay')}
                        id="vt-layout-overlay-btn"
                    >
                        <i className="fa-solid fa-layer-group" style={{ fontSize: '11px' }} /> Overlay
                    </button>
                    <button
                        className={`vt-layout-btn ${layout === 'side-by-side' ? 'active' : ''}`}
                        onClick={() => setLayout('side-by-side')}
                        id="vt-layout-sidebyside-btn"
                    >
                        <i className="fa-solid fa-columns" style={{ fontSize: '11px' }} /> Song song
                    </button>
                </div>
            </div>

            {/* ── URL Input ── */}
            <GlassCard variant="default" padding="md" hover={false}>
                <form className="vt-url-bar" onSubmit={handleLoadVideo}>
                    <div className="vt-url-input-wrapper">
                        <i className="fa-solid fa-link vt-url-input-icon" />
                        <input
                            type="text"
                            className="vt-url-input"
                            placeholder="Dán link video YouTube, TikTok hoặc URL video trực tiếp..."
                            value={videoUrl}
                            onChange={e => setVideoUrl(e.target.value)}
                            id="vt-url-input"
                        />
                    </div>
                    <button
                        type="submit"
                        className="vt-url-load-btn"
                        disabled={!videoUrl.trim()}
                        id="vt-url-load-btn"
                    >
                        <i className="fa-solid fa-play" style={{ fontSize: '11px' }} /> Tải video
                    </button>
                </form>
                <div className="vt-platform-hints" style={{ marginTop: '8px' }}>
                    <span className="vt-platform-pill youtube">
                        <i className="fa-brands fa-youtube pill-icon" /> YouTube
                    </span>
                    <span className="vt-platform-pill tiktok">
                        <i className="fa-brands fa-tiktok pill-icon" /> TikTok
                    </span>
                    <span className="vt-platform-pill direct">
                        <i className="fa-solid fa-file-video pill-icon" /> Video trực tiếp
                    </span>
                </div>
            </GlassCard>

            {/* ── Main Content: Video + Sign Language ── */}
            <div className={`vt-main ${layout}`}>
                {/* Video Section */}
                <div className="vt-video-section">
                    <GlassCard variant="strong" padding="none" hover={false} className="vt-video-card">
                        <div className="vt-video-player-container">
                            {loadedVideo ? (
                                <>
                                    {loadedVideo.platform === 'youtube' ? (
                                        <iframe
                                            src={loadedVideo.embedSrc}
                                            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                                            allowFullScreen
                                            title="YouTube Video"
                                        />
                                    ) : loadedVideo.platform === 'tiktok' ? (
                                        <iframe
                                            src={loadedVideo.embedSrc}
                                            allow="autoplay; encrypted-media"
                                            allowFullScreen
                                            title="TikTok Video"
                                            style={{ background: '#000' }}
                                        />
                                    ) : (
                                        <video
                                            src={loadedVideo.url}
                                            autoPlay
                                            controls
                                            playsInline
                                        />
                                    )}
                                </>
                            ) : (
                                <div className="vt-video-empty">
                                    <div className="vt-video-empty-icon">
                                        <i className="fa-solid fa-clapperboard" />
                                    </div>
                                    <h3>Chưa có video</h3>
                                    <p>Dán link YouTube, TikTok hoặc link video trực tiếp vào ô phía trên để bắt đầu xem</p>
                                </div>
                            )}
                        </div>

                        {loadedVideo && (
                            <div className="vt-video-controls">
                                <span className={`vt-video-source-badge ${loadedVideo.platform}`}>
                                    <i className={
                                        loadedVideo.platform === 'youtube' ? 'fa-brands fa-youtube' :
                                        loadedVideo.platform === 'tiktok' ? 'fa-brands fa-tiktok' :
                                        'fa-solid fa-file-video'
                                    } />
                                    {loadedVideo.platform === 'youtube' ? 'YouTube' :
                                     loadedVideo.platform === 'tiktok' ? 'TikTok' : 'Video'}
                                </span>
                                <span className="vt-video-url-display" title={loadedVideo.url}>
                                    {loadedVideo.url}
                                </span>
                                <button
                                    className="vt-video-close-btn"
                                    onClick={handleCloseVideo}
                                    title="Đóng video"
                                    id="vt-video-close-btn"
                                >
                                    <i className="fa-solid fa-xmark" />
                                </button>
                            </div>
                        )}
                    </GlassCard>
                </div>

                {/* Sign Language Section */}
                <div className="vt-sign-section">
                    <GlassCard variant="strong" padding="none" hover={false} className="vt-sign-card">
                        {layout === 'overlay' && (
                            <span className="vt-overlay-badge">Ký hiệu</span>
                        )}
                        <div className="vt-sign-header">
                            <span className="vt-sign-header-title">
                                <span className={`sign-dot ${hasResult ? '' : 'idle'}`} />
                                Mô hình 3D dịch ký hiệu
                            </span>
                            {layout === 'side-by-side' && (
                                <button
                                    className="vt-sign-resize-btn"
                                    onClick={() => setLayout('overlay')}
                                    title="Chuyển sang chế độ overlay"
                                >
                                    <i className="fa-solid fa-compress" />
                                </button>
                            )}
                            {layout === 'overlay' && (
                                <button
                                    className="vt-sign-resize-btn"
                                    onClick={() => setLayout('side-by-side')}
                                    title="Chuyển sang chế độ song song"
                                >
                                    <i className="fa-solid fa-expand" />
                                </button>
                            )}
                        </div>
                        <div className="vt-avatar-area">
                            <Suspense fallback={
                                <div className="vt-avatar-placeholder">
                                    <div className="loading-spinner" />
                                    <p>Đang tải mô hình 3D...</p>
                                </div>
                            }>
                                <AvatarScene3D
                                    ref={avatarRef}
                                    className="avatar-container"
                                    onPlayingSign={(sign) => {
                                        if (result?.signs) {
                                            const idx = result.signs.findIndex(s => s.gloss === sign.gloss);
                                            if (idx >= 0) setActiveSignIdx(idx);
                                        }
                                    }}
                                />
                            </Suspense>
                        </div>
                    </GlassCard>
                </div>
            </div>

            {/* ── Bottom Translation Panel ── */}
            <div className="vt-input-panel">
                <GlassCard variant="strong" padding="md" hover={false} style={{ flex: 1 }}>
                    <div className="vt-text-translate-section">
                        <span className="vt-text-translate-label">
                            <i className="fa-solid fa-language" style={{ fontSize: '12px' }} />
                            Dịch sang ký hiệu trong khi xem video
                        </span>
                        <form className="vt-text-translate-form" onSubmit={handleTextSubmit}>
                            <div className="vt-mic-section">
                                {isSupported && (
                                    <button
                                        type="button"
                                        className={`vt-mic-btn ${speechState === 'listening' ? 'recording' : ''}`}
                                        onClick={toggleSpeech}
                                        title={speechState === 'listening' ? 'Dừng nghe' : 'Nói để dịch'}
                                        id="vt-mic-btn"
                                    >
                                        {speechState === 'listening'
                                            ? <i className="fa-solid fa-microphone-slash" />
                                            : <i className="fa-solid fa-microphone" />
                                        }
                                    </button>
                                )}
                                {speechState === 'listening' && (
                                    <span className="vt-mic-status listening">Đang nghe...</span>
                                )}
                            </div>
                            <input
                                type="text"
                                className="vt-text-input"
                                placeholder={interimText || 'Nhập câu tiếng Việt để dịch sang ký hiệu...'}
                                value={textInput}
                                onChange={e => setTextInput(e.target.value)}
                                id="vt-text-input"
                            />
                            <button
                                type="submit"
                                className="vt-translate-btn"
                                disabled={!textInput.trim() || isTranslating}
                                id="vt-translate-btn"
                            >
                                {isTranslating ? (
                                    <><div className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Đang dịch...</>
                                ) : (
                                    <><i className="fa-solid fa-hands" style={{ fontSize: '12px' }} /> Dịch</>
                                )}
                            </button>
                        </form>

                        {/* Sign chips */}
                        {hasResult && (
                            <div className="vt-sign-sequence-bar">
                                <span className="vt-sign-sequence-label">Ký hiệu:</span>
                                <div className="vt-sign-chips-scroll">
                                    {result.signs.map((sign, idx) => (
                                        <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                                            <button
                                                type="button"
                                                className={`vt-sign-chip ${sign.found ? 'found' : 'not-found'} ${idx === activeSignIdx ? 'active' : ''}`}
                                                onClick={() => handleSignChipClick(idx)}
                                            >
                                                {sign.vi}
                                                {sign.found && sign.gloss && (
                                                    <span style={{ fontSize: '9px', opacity: 0.7, marginLeft: '3px' }}>
                                                        {sign.gloss.toUpperCase()}
                                                    </span>
                                                )}
                                            </button>
                                            {idx < result.signs.length - 1 && <span className="vt-sign-arrow">→</span>}
                                        </span>
                                    ))}
                                </div>
                                <div className="vt-quick-actions">
                                    <button type="button" className="vt-quick-action-btn" onClick={handleReplay}>
                                        <i className="fa-solid fa-rotate-right" style={{ fontSize: '9px' }} /> Chạy lại
                                    </button>
                                    <button type="button" className="vt-quick-action-btn" onClick={handleClear}>
                                        <i className="fa-solid fa-trash" style={{ fontSize: '9px' }} /> Xóa
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </GlassCard>
            </div>
        </div>
    );
}
