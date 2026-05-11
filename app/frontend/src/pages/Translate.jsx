import { useState, useRef, useCallback, useEffect } from 'react';
import GlassCard from '../components/ui/GlassCard';
import AvatarScene3D from '../components/avatar/AvatarScene3D';
import useSpeechRecognition from '../hooks/useSpeechRecognition';
import useSignTranslation from '../hooks/useSignTranslation';
import './Translate.css';

function getVideoUrl(sign, signVideosData) {
    if (!sign?.found || !sign?.gloss || !signVideosData?.glosses) return null;
    const entry = signVideosData.glosses[sign.gloss.toLowerCase()];
    if (!entry?.videos?.length) return null;

    const mp4 = entry.videos.find(v => v.type === 'mp4');
    if (mp4) return { url: mp4.url, type: 'mp4' };

    const local = entry.videos.find(v => v.type === 'local');
    if (local) return { url: local.url, type: 'local' };

    const yt = entry.videos.find(v => v.type === 'youtube');
    if (yt) {
        const id = yt.url.match(/[?&]v=([^&]+)/)?.[1] || yt.url.split('/').pop();
        return { url: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`, type: 'youtube' };
    }
    return null;
}

export default function Translate() {
    const [mode, setMode] = useState('video');
    const [transcripts, setTranscripts] = useState([]);
    const [interimText, setInterimText] = useState('');
    const [textInput, setTextInput] = useState('');
    const [activeSignIdx, setActiveSignIdx] = useState(0);
    const [signVideosData, setSignVideosData] = useState(null);
    const [isAutoPlaying, setIsAutoPlaying] = useState(false);
    const autoPlayTimerRef = useRef(null);
    const videoRef = useRef(null);
    const avatarRef = useRef(null);

    const { isLoading, result, error, translate, clear } = useSignTranslation();

    const handleFinal = useCallback(({ text }) => {
        setTranscripts(prev => [...prev, text]);
        setInterimText('');
        translate(text);
    }, [translate]);

    const handleInterim = useCallback(({ text }) => {
        setInterimText(text);
    }, []);

    const handleError = useCallback(({ message }) => {
        setTranscripts(prev => [...prev, `⚠️ ${message}`]);
    }, []);

    const { state: speechState, isSupported, toggle: toggleSpeech } = useSpeechRecognition({
        lang: 'vi-VN',
        onFinal: handleFinal,
        onInterim: handleInterim,
        onError: handleError,
    });

    useEffect(() => {
        fetch('/data/sign_videos.json')
            .then(r => r.json())
            .then(setSignVideosData)
            .catch(err => console.warn('Could not load sign_videos.json:', err));
    }, []);

    useEffect(() => {
        if (mode === '3d' && result?.signs) {
            const timer = setTimeout(() => {
                if (avatarRef.current?.isModelLoaded) {
                    avatarRef.current.playSignSequence(result.signs);
                }
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [result, mode]);

    useEffect(() => {
        if (!isAutoPlaying || !result?.signs?.length || mode !== 'video') return;

        const currentSign = result.signs[activeSignIdx];
        if (!currentSign?.found) {
            const nextFoundIdx = result.signs.findIndex((s, i) => i > activeSignIdx && s.found);
            if (nextFoundIdx >= 0) {
                setActiveSignIdx(nextFoundIdx);
            } else {
                setIsAutoPlaying(false);
            }
            return;
        }

        if (videoRef.current) {
            videoRef.current.onended = () => {
                const nextFoundIdx = result.signs.findIndex((s, i) => i > activeSignIdx && s.found);
                if (nextFoundIdx >= 0) setActiveSignIdx(nextFoundIdx);
                else setIsAutoPlaying(false);
            };
        } else {
            autoPlayTimerRef.current = setTimeout(() => {
                const nextFoundIdx = result.signs.findIndex((s, i) => i > activeSignIdx && s.found);
                if (nextFoundIdx >= 0) setActiveSignIdx(nextFoundIdx);
                else setIsAutoPlaying(false);
            }, 3000);
        }

        return () => {
            clearTimeout(autoPlayTimerRef.current);
            if (videoRef.current) videoRef.current.onended = null;
        };
    }, [isAutoPlaying, activeSignIdx, result, mode]);

    function handleTextSubmit(e) {
        e.preventDefault();
        if (!textInput.trim()) return;
        setTranscripts(prev => [...prev, textInput.trim()]);
        translate(textInput.trim());
        setTextInput('');
        setActiveSignIdx(0);
        setIsAutoPlaying(false);
    }

    function handleClear() {
        setTranscripts([]);
        setInterimText('');
        clear();
        setActiveSignIdx(0);
        setIsAutoPlaying(false);
        if (avatarRef.current) avatarRef.current.stopAnimation();
    }

    function handleAutoPlay() {
        if (isAutoPlaying) {
            setIsAutoPlaying(false);
        } else {
            setActiveSignIdx(0);
            setIsAutoPlaying(true);
        }
    }

    const activeSign = result?.signs?.[activeSignIdx];
    const activeVideo = activeSign ? getVideoUrl(activeSign, signVideosData) : null;
    const foundCount = result?.found_count || 0;
    const totalCount = result?.total_count || 0;
    const matchPct = totalCount > 0 ? Math.round((foundCount / totalCount) * 100) : 0;

    return (
        <div className="translate-page">
            {/* Top bar */}
            <div className="translate-top-bar">
                <div className="translate-title-group">
                    <div className="translate-icon">
                        <i className="fa-solid fa-microphone" />
                    </div>
                    <div>
                        <h1 className="translate-title">Giọng nói → Ký hiệu</h1>
                        <p className="translate-subtitle">Nói hoặc nhập text, xem ngôn ngữ ký hiệu</p>
                    </div>
                </div>
                <div className="translate-mode-toggle">
                    <button className={`mode-btn ${mode === 'video' ? 'active' : ''}`} onClick={() => setMode('video')}>
                        <i className="fa-solid fa-video" style={{ fontSize: '12px' }} /> Video
                    </button>
                    <button className={`mode-btn ${mode === '3d' ? 'active' : ''}`} onClick={() => setMode('3d')}>
                        <i className="fa-solid fa-hand" style={{ fontSize: '12px' }} /> 3D Avatar
                    </button>
                </div>
            </div>

            {/* Left panel */}
            <GlassCard variant="strong" className="translate-speech-panel">
                <div className="mic-section">
                    {isSupported ? (
                        <>
                            <div className="mic-button-wrapper">
                                {speechState === 'listening' && (
                                    <>
                                        <div className="mic-pulse-ring" />
                                        <div className="mic-pulse-ring" />
                                        <div className="mic-pulse-ring" />
                                    </>
                                )}
                                <button
                                    className={`mic-button ${speechState === 'listening' ? 'recording' : ''} ${speechState === 'error' ? 'error' : ''}`}
                                    onClick={toggleSpeech}
                                    id="mic-toggle-btn"
                                >
                                    {speechState === 'listening'
                                        ? <i className="fa-solid fa-microphone-slash" style={{ fontSize: '28px' }} />
                                        : <i className="fa-solid fa-microphone" style={{ fontSize: '28px' }} />
                                    }
                                </button>
                            </div>
                            <div className="mic-status">
                                <p className={`mic-status-text ${speechState}`}>
                                    {speechState === 'listening' ? 'Đang nghe...' :
                                        speechState === 'error' ? 'Lỗi microphone' :
                                            'Nhấn để bắt đầu nói'}
                                </p>
                                <p className="mic-status-sub">
                                    {speechState === 'listening' ? 'Nói tiếng Việt rõ ràng' : 'Web Speech API • Tiếng Việt'}
                                </p>
                            </div>
                        </>
                    ) : (
                        <div className="mic-not-supported">
                            <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: '6px' }} />
                            Trình duyệt không hỗ trợ Web Speech API. Dùng Chrome hoặc Edge.
                        </div>
                    )}
                </div>

                <div className="text-input-section">
                    <div className="text-input-divider">hoặc nhập văn bản</div>
                    <form className="text-input-form" onSubmit={handleTextSubmit}>
                        <input
                            type="text"
                            className="text-input"
                            placeholder="Nhập câu tiếng Việt..."
                            value={textInput}
                            onChange={e => setTextInput(e.target.value)}
                            id="text-input-field"
                        />
                        <button type="submit" className="text-send-btn" disabled={!textInput.trim() || isLoading} id="text-submit-btn">
                            <i className="fa-solid fa-paper-plane" style={{ fontSize: '12px' }} /> Dịch
                        </button>
                    </form>
                </div>

                <div className="transcript-section">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
                        <span className="transcript-label">Lịch sử nhận dạng</span>
                        {transcripts.length > 0 && (
                            <button onClick={handleClear} className="transcript-clear-btn">
                                <i className="fa-solid fa-rotate-left" style={{ fontSize: '10px' }} /> Xóa
                            </button>
                        )}
                    </div>
                    <div className="transcript-list">
                        {interimText && <div className="transcript-item interim">{interimText}</div>}
                        {transcripts.length > 0 ? (
                            [...transcripts].reverse().map((t, i) => (
                                <div key={i} className="transcript-item">{t}</div>
                            ))
                        ) : (
                            <div className="transcript-empty">
                                Chưa có dữ liệu. Nói hoặc nhập văn bản để bắt đầu.
                            </div>
                        )}
                    </div>
                </div>
            </GlassCard>

            {/* Right panel — Output */}
            <GlassCard variant="strong" className="translate-output-panel">
                {/* 3D Avatar */}
                <div style={{ display: mode === '3d' ? 'block' : 'none' }}>
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
                </div>

                {/* Video mode */}
                {mode === 'video' && (
                    <div className="video-output-section">
                        {isLoading ? (
                            <div className="translate-loading">
                                <div className="loading-spinner" />
                                <span className="loading-text">Đang dịch...</span>
                            </div>
                        ) : error ? (
                            <div className="translate-error">
                                <i className="fa-solid fa-circle-exclamation" style={{ marginRight: '6px' }} /> {error}
                            </div>
                        ) : activeVideo ? (
                            <div className="sign-video-player">
                                {activeVideo.type === 'youtube' ? (
                                    <iframe
                                        src={activeVideo.url}
                                        allow="autoplay; encrypted-media"
                                        allowFullScreen
                                        title={activeSign?.gloss || ''}
                                    />
                                ) : (
                                    <video
                                        ref={videoRef}
                                        src={activeVideo.url}
                                        autoPlay
                                        controls
                                        key={activeVideo.url}
                                    />
                                )}
                                <div className="sign-video-info">
                                    <div>
                                        <span className="sign-video-label">{activeSign?.vi}</span>
                                        <span className="sign-video-gloss" style={{ marginLeft: '8px' }}>{activeSign?.gloss?.toUpperCase()}</span>
                                    </div>
                                    <div className="sign-video-nav">
                                        <button className="sign-video-nav-btn" onClick={() => setActiveSignIdx(Math.max(0, activeSignIdx - 1))} disabled={activeSignIdx === 0}>
                                            <i className="fa-solid fa-chevron-left" style={{ fontSize: '11px' }} />
                                        </button>
                                        <span className="sign-video-counter">{activeSignIdx + 1}/{result?.signs?.length || 0}</span>
                                        <button className="sign-video-nav-btn" onClick={() => setActiveSignIdx(Math.min((result?.signs?.length || 1) - 1, activeSignIdx + 1))} disabled={activeSignIdx >= (result?.signs?.length || 1) - 1}>
                                            <i className="fa-solid fa-chevron-right" style={{ fontSize: '11px' }} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="sign-video-empty">
                                {result?.signs?.length ? (
                                    <span>Không có video cho từ này. Chọn từ khác.</span>
                                ) : (
                                    <>
                                        <i className="fa-solid fa-hands animate-float" style={{ fontSize: '48px', display: 'block', marginBottom: '12px', color: 'var(--wc-teal)', opacity: 0.4 }} />
                                        <span>Nói hoặc nhập văn bản để xem ký hiệu</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Sign chips */}
                {result?.signs?.length > 0 && (
                    <div>
                        <div className="video-output-header">
                            <span className="video-output-title">Chuỗi ký hiệu</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {mode === 'video' && result.signs.filter(s => s.found).length > 1 && (
                                    <button onClick={handleAutoPlay} className={`auto-play-btn ${isAutoPlaying ? 'playing' : ''}`}>
                                        {isAutoPlaying
                                            ? <><i className="fa-solid fa-pause" style={{ fontSize: '10px' }} /> Dừng</>
                                            : <><i className="fa-solid fa-play" style={{ fontSize: '10px' }} /> Phát tự động</>
                                        }
                                    </button>
                                )}
                                <span className="video-output-stats">{foundCount}/{totalCount} từ</span>
                            </div>
                        </div>
                        <div className="sign-sequence">
                            {result.signs.map((sign, idx) => (
                                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <div
                                        className={`sign-chip ${sign.found ? 'found' : 'not-found'} ${idx === activeSignIdx ? 'active' : ''}`}
                                        onClick={() => { setActiveSignIdx(idx); setIsAutoPlaying(false); }}
                                    >
                                        <span className="sign-chip-vi">{sign.vi}</span>
                                        {sign.found && sign.gloss ? (
                                            <span className="sign-chip-gloss">{sign.gloss}</span>
                                        ) : (
                                            <span className="sign-chip-miss">
                                                <i className="fa-solid fa-xmark" style={{ fontSize: '9px', marginRight: '2px' }} /> không có
                                            </span>
                                        )}
                                    </div>
                                    {idx < result.signs.length - 1 && <span className="sign-arrow">→</span>}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Fingerspell */}
                {result?.fingerspell_fallback?.length > 0 && (
                    <div className="fingerspell-section">
                        <p className="fingerspell-label">
                            <i className="fa-solid fa-hand-point-up" style={{ marginRight: '6px' }} />
                            Đánh vần cho từ không tìm thấy:
                        </p>
                        <div className="fingerspell-chips">
                            {result.fingerspell_fallback.map((letter, i) => (
                                <span key={i} className={`fingerspell-chip ${letter.found ? 'found' : 'not-found'}`}>
                                    {letter.gloss?.toUpperCase() || letter.vi}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </GlassCard>

            {/* Bottom stats */}
            {result && (
                <div className="translate-bottom-bar" style={{ borderRadius: 'var(--radius-md)' }}>
                    <span className={`method-badge ${result.method === 'gemini' ? 'gemini' : 'rule-based'}`}>
                        {result.method === 'gemini'
                            ? <><i className="fa-solid fa-robot" style={{ marginRight: '4px' }} /> Gemini AI</>
                            : <><i className="fa-solid fa-book" style={{ marginRight: '4px' }} /> Rule-based</>
                        }
                    </span>
                    <div className="result-stats">
                        <div className="stat-item">
                            <span>Tìm thấy:</span>
                            <span className={`stat-value ${matchPct >= 70 ? 'high' : matchPct >= 40 ? 'medium' : 'low'}`}>
                                {foundCount}/{totalCount} ({matchPct}%)
                            </span>
                        </div>
                        <div className="stat-item">
                            <span>Câu gốc:</span>
                            <span style={{ color: 'var(--ink-light)', fontWeight: 600 }}>"{result.input_text}"</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
