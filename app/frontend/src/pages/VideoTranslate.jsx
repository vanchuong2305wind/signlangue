import { lazy, Suspense, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import GlassCard from '../components/ui/GlassCard';
import useSpeechRecognition from '../hooks/useSpeechRecognition';
import useSignTranslation from '../hooks/useSignTranslation';
import useStudyTimer from '../hooks/useStudyTimer';
import useYouTubePlayer from '../hooks/useYouTubePlayer';
import useVideoSubtitles, { findCueIndex } from '../hooks/useVideoSubtitles';
import './VideoTranslate.css';

const AvatarScene3D = lazy(() => import('../components/avatar/AvatarScene3D'));

/* ── Helpers ── */

/** Detect video platform from a URL string. */
function detectPlatform(url) {
    if (!url) return null;
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    return 'direct';
}

/** Pull the video id out of any YouTube URL shape. */
function toYouTubeId(url) {
    try {
        const u = new URL(url);
        if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
        if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
        if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
        return u.searchParams.get('v');
    } catch {
        return null;
    }
}

function toTikTokEmbed(url) {
    const match = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
    return match ? `https://www.tiktok.com/embed/v2/${match[1]}` : null;
}

function isValidUrl(str) {
    try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

const LANG_NAMES = {
    vi: 'Tiếng Việt', en: 'English', ja: '日本語', ko: '한국어',
    zh: '中文', fr: 'Français', de: 'Deutsch', es: 'Español', th: 'ไทย',
};

function describeLang(code) {
    if (!code) return '';
    if (code === 'local') return 'File tải lên';
    const base = code.split('-')[0];
    return LANG_NAMES[base] || code;
}

/* ── Draggable Hook ── */
function useDraggable(enabled) {
    const ref = useRef(null);
    const dragState = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

    useEffect(() => {
        if (!enabled || !ref.current) return undefined;
        const el = ref.current;

        function onPointerDown(e) {
            if (e.target.closest('button, input, a, select, .vt-sign-resize-btn')) return;
            dragState.current = {
                dragging: true,
                startX: e.clientX,
                startY: e.clientY,
                origX: el.offsetLeft,
                origY: el.offsetTop,
            };
            el.style.cursor = 'grabbing';
            el.style.transition = 'none';
            el.setPointerCapture(e.pointerId);
            e.preventDefault();
        }

        function onPointerMove(e) {
            if (!dragState.current.dragging) return;
            const dx = e.clientX - dragState.current.startX;
            const dy = e.clientY - dragState.current.startY;
            const newX = dragState.current.origX + dx;
            const newY = dragState.current.origY + dy;

            const parent = el.parentElement;
            if (parent) {
                const maxX = parent.clientWidth - el.offsetWidth;
                const maxY = parent.clientHeight - el.offsetHeight;
                el.style.left = `${Math.max(0, Math.min(newX, maxX))}px`;
                el.style.top = `${Math.max(0, Math.min(newY, maxY))}px`;
            } else {
                el.style.left = `${newX}px`;
                el.style.top = `${newY}px`;
            }
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }

        function onPointerUp() {
            dragState.current.dragging = false;
            el.style.cursor = 'grab';
            el.style.transition = '';
        }

        el.addEventListener('pointerdown', onPointerDown);
        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', onPointerUp);

        return () => {
            el.removeEventListener('pointerdown', onPointerDown);
            el.removeEventListener('pointermove', onPointerMove);
            el.removeEventListener('pointerup', onPointerUp);
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled && ref.current) {
            ref.current.style.left = '';
            ref.current.style.top = '';
            ref.current.style.right = '';
            ref.current.style.bottom = '';
        }
    }, [enabled]);

    return ref;
}

/* ── Page ── */

// How often the playhead is sampled. Captions do not need frame accuracy, and
// a tighter loop would just burn battery polling an iframe across origins.
const TICK_MS = 120;
// The avatar has to fetch landmark data before it moves, so signing starts a
// beat before the line is spoken rather than a beat after.
const DEFAULT_LEAD = 0.35;

export default function VideoTranslate() {
    useStudyTimer('Video dịch ký hiệu');

    const [layout, setLayout] = useState('side-by-side');

    // Video
    const [videoUrl, setVideoUrl] = useState('');
    const [loadedVideo, setLoadedVideo] = useState(null); // { url, platform, videoId, embedSrc }
    const [urlError, setUrlError] = useState('');

    // Subtitle-driven signing
    const [autoSign, setAutoSign] = useState(true);
    const [lead, setLead] = useState(DEFAULT_LEAD);
    const [currentTime, setCurrentTime] = useState(0);
    const [activeCueIdx, setActiveCueIdx] = useState(-1);
    const [showTranscript, setShowTranscript] = useState(true);

    // Manual / microphone signing. A manual result records which cue was on
    // screen when it was made, which is what lets the display source be derived
    // rather than tracked: the next subtitle line takes over on its own.
    const [showManual, setShowManual] = useState(false);
    const [textInput, setTextInput] = useState('');
    const [interimText, setInterimText] = useState('');
    const [manualResult, setManualResult] = useState(null);
    const manualSeqRef = useRef(0);

    // Which gloss is lit up, tagged with the sentence it belongs to — so a new
    // line starts at its first sign without an effect having to reset anything.
    const [highlight, setHighlight] = useState({ key: '', idx: 0 });

    const avatarRef = useRef(null);
    const videoElRef = useRef(null);
    const ytHostRef = useRef(null);
    const fileInputRef = useRef(null);
    const transcriptListRef = useRef(null);
    const activeCueElRef = useRef(null);
    const overlayRef = useDraggable(layout === 'overlay');

    const youtube = useYouTubePlayer(
        loadedVideo?.platform === 'youtube' ? loadedVideo.videoId : null,
        ytHostRef,
    );
    const subtitles = useVideoSubtitles();
    const { isLoading: manualLoading, translate } = useSignTranslation();

    const platform = loadedVideo?.platform;
    // TikTok's embed exposes no playhead, so nothing can be synced to it.
    const canSyncTime = platform === 'youtube' || platform === 'direct';
    const hasCues = subtitles.cues.length > 0;

    /* ── Avatar playback ── */
    const pendingSignsRef = useRef(null);
    const modelPollRef = useRef(null);

    const playOnAvatar = useCallback((signList) => {
        if (!signList?.length) return;
        const avatar = avatarRef.current;
        if (avatar?.isModelLoaded) {
            avatar.playSignSequence(signList);
            return;
        }
        // The model is still streaming in; hold the newest request and start it
        // the moment it is ready, so the first line of a video is not lost.
        pendingSignsRef.current = signList;
        if (modelPollRef.current) return;
        let attempts = 0;
        modelPollRef.current = setInterval(() => {
            attempts += 1;
            const ready = avatarRef.current;
            if (ready?.isModelLoaded) {
                clearInterval(modelPollRef.current);
                modelPollRef.current = null;
                const queued = pendingSignsRef.current;
                pendingSignsRef.current = null;
                if (queued) ready.playSignSequence(queued);
            } else if (attempts >= 150) {
                clearInterval(modelPollRef.current);
                modelPollRef.current = null;
            }
        }, 100);
    }, []);

    useEffect(() => () => {
        if (modelPollRef.current) clearInterval(modelPollRef.current);
    }, []);

    /* ── Playhead clock ── */
    // Pulled out of the hook result, which is a fresh object every render:
    // depending on it would rebuild the clock below on every tick it causes.
    const { getCurrentTime: ytTime, seekTo: ytSeek, play: ytPlay } = youtube;

    const getCurrentTime = useCallback(() => {
        if (platform === 'youtube') return ytTime();
        if (platform === 'direct') return videoElRef.current?.currentTime ?? 0;
        return 0;
    }, [platform, ytTime]);

    const seekTo = useCallback((seconds) => {
        if (platform === 'youtube') {
            ytSeek(seconds);
            ytPlay();
        } else if (platform === 'direct' && videoElRef.current) {
            videoElRef.current.currentTime = seconds;
            videoElRef.current.play?.().catch(() => {});
        }
    }, [platform, ytSeek, ytPlay]);

    const cuesRef = useRef([]);
    useEffect(() => { cuesRef.current = subtitles.cues; }, [subtitles.cues]);

    useEffect(() => {
        if (!canSyncTime || !hasCues) return undefined;
        const timer = setInterval(() => {
            const time = getCurrentTime();
            // The clock is only ever shown as mm:ss, so it is stored at whole
            // seconds — at full tick rate this would re-render the transcript
            // eight times a second to say the same thing.
            setCurrentTime(prev => (Math.floor(prev) === Math.floor(time) ? prev : time));
            const idx = findCueIndex(cuesRef.current, time + lead);
            setActiveCueIdx(prev => (prev === idx ? prev : idx));
        }, TICK_MS);
        return () => clearInterval(timer);
    }, [canSyncTime, hasCues, getCurrentTime, lead]);

    /* ── Sign the active subtitle line ── */
    // Remembers which line has already been handed to the avatar, so a
    // background translation landing mid-line does not restart the animation.
    const lastPlayedCueRef = useRef(-1);

    useEffect(() => {
        lastPlayedCueRef.current = -1;
    }, [loadedVideo, autoSign]);

    // Depends on the two fields it reads, not the whole hook result — that
    // object is rebuilt every render, which would re-run this on every tick.
    const { signs: cueSigns, ensureTranslated } = subtitles;

    useEffect(() => {
        if (!autoSign || activeCueIdx < 0) return;
        if (lastPlayedCueRef.current === activeCueIdx) return;

        const data = cueSigns[activeCueIdx];
        if (!data) {
            // Seeked past what the prefetch has reached — parse just this line.
            ensureTranslated(activeCueIdx);
            return;
        }

        lastPlayedCueRef.current = activeCueIdx;
        playOnAvatar(data.signs);
    }, [activeCueIdx, autoSign, cueSigns, ensureTranslated, playOnAvatar]);

    /* ── Speech recognition (for sources with no caption track) ── */
    const activeCueIdxRef = useRef(-1);
    useEffect(() => { activeCueIdxRef.current = activeCueIdx; }, [activeCueIdx]);

    const runManualTranslation = useCallback(async (text) => {
        const data = await translate(text);
        if (data) {
            manualSeqRef.current += 1;
            // Read at completion, not at submit: a line that scrolled by while
            // the parse was in flight should hand the avatar straight back.
            setManualResult({ ...data, atCue: activeCueIdxRef.current, seq: manualSeqRef.current });
            if (data.signs?.length) playOnAvatar(data.signs);
        }
        return data;
    }, [translate, playOnAvatar]);

    const handleFinal = useCallback(({ text }) => {
        setInterimText('');
        setTextInput(text);
        runManualTranslation(text);
    }, [runManualTranslation]);

    const handleInterim = useCallback(({ text }) => setInterimText(text), []);

    const handleSpeechError = useCallback(({ message }) => {
        setInterimText(`⚠️ ${message}`);
        setTimeout(() => setInterimText(''), 3000);
    }, []);

    const { state: speechState, isSupported, toggle: toggleSpeech } = useSpeechRecognition({
        lang: 'vi-VN',
        onFinal: handleFinal,
        onInterim: handleInterim,
        onError: handleSpeechError,
    });

    /* ── Video loading ── */
    const resetPlayback = useCallback(() => {
        setActiveCueIdx(-1);
        setCurrentTime(0);
        setManualResult(null);
        setHighlight({ key: '', idx: 0 });
        lastPlayedCueRef.current = -1;
        avatarRef.current?.stopAnimation?.();
    }, []);

    function handleLoadVideo(e) {
        e?.preventDefault();
        const url = videoUrl.trim();
        if (!url) return;

        setUrlError('');
        if (!isValidUrl(url)) {
            setUrlError('URL không hợp lệ. Vui lòng nhập đúng link video.');
            return;
        }

        const detected = detectPlatform(url);
        let videoId = null;
        let embedSrc = url;

        if (detected === 'youtube') {
            videoId = toYouTubeId(url);
            if (!videoId) {
                setUrlError('Không nhận dạng được video YouTube. Kiểm tra lại link.');
                return;
            }
        } else if (detected === 'tiktok') {
            const embed = toTikTokEmbed(url);
            if (!embed) {
                setUrlError('Không nhận dạng được video TikTok. Dùng link dạng tiktok.com/@user/video/...');
                return;
            }
            embedSrc = embed;
        }

        resetPlayback();
        subtitles.reset();
        setLoadedVideo({ url, platform: detected, videoId, embedSrc });
        subtitles.loadFromUrl(url);
    }

    function handleCloseVideo() {
        resetPlayback();
        subtitles.reset();
        setLoadedVideo(null);
        setVideoUrl('');
        setUrlError('');
    }

    function handleRetrySubtitles() {
        if (!loadedVideo) return;
        resetPlayback();
        subtitles.loadFromUrl(loadedVideo.url);
    }

    function handleSubtitleLangChange(e) {
        const lang = e.target.value;
        if (!loadedVideo) return;
        resetPlayback();
        subtitles.loadFromUrl(loadedVideo.url, lang);
    }

    async function handleSubtitleFile(e) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        resetPlayback();
        await subtitles.loadFromFile(file);
    }

    /* ── Manual controls ── */
    function handleTextSubmit(e) {
        e.preventDefault();
        const text = textInput.trim();
        if (!text) return;
        runManualTranslation(text);
    }

    function handleReplayCurrent() {
        const signList = displayResult?.signs;
        if (!signList?.length) return;
        setHighlight({ key: displayKey, idx: 0 });
        playOnAvatar(signList);
    }

    function handleCueClick(idx) {
        const cue = subtitles.cues[idx];
        if (!cue) return;
        if (canSyncTime) {
            lastPlayedCueRef.current = -1;
            seekTo(cue.start);
            return;
        }
        // No playhead to seek (TikTok): sign the line on demand instead.
        setTextInput(cue.text);
        runManualTranslation(cue.text);
    }

    /* ── Derived ── */
    const activeCue = activeCueIdx >= 0 ? subtitles.cues[activeCueIdx] : null;
    const prevCue = activeCueIdx > 0 ? subtitles.cues[activeCueIdx - 1] : null;
    const nextCue = activeCueIdx >= 0 ? subtitles.cues[activeCueIdx + 1] : subtitles.cues[0];

    // A typed or spoken sentence owns the avatar until the video moves on to
    // the next subtitle line — or forever, if auto-signing is off.
    const cueResult = activeCueIdx >= 0 ? subtitles.signs[activeCueIdx] : null;
    const manualIsCurrent = !!manualResult && (!autoSign || manualResult.atCue === activeCueIdx);
    const displayResult = manualIsCurrent ? manualResult : (cueResult || manualResult);

    const displayKey = manualIsCurrent || !cueResult
        ? `manual:${manualResult?.seq ?? 0}`
        : `cue:${activeCueIdx}`;
    const activeSignIdx = highlight.key === displayKey ? highlight.idx : 0;

    const hasResult = displayResult?.signs?.length > 0;
    const foundCount = displayResult?.found_count || 0;
    const totalCount = displayResult?.total_count || 0;

    const detectedPlatform = videoUrl.trim() ? detectPlatform(videoUrl.trim()) : null;
    const translateProgress = subtitles.cues.length
        ? Math.round((subtitles.translatedCount / subtitles.cues.length) * 100)
        : 0;

    // Languages the platform offers, trimmed to ones worth showing: YouTube
    // lists well over a hundred auto-translations, one per language it knows.
    const langOptions = useMemo(() => {
        const current = subtitles.meta?.lang;
        const list = subtitles.meta?.available || [];
        const seen = new Set();
        const options = [];

        for (const item of list) {
            const base = item.lang.split('-')[0];
            const isCurrent = item.lang === current;
            if (seen.has(base) && !isCurrent) continue;
            if (!LANG_NAMES[base] && !isCurrent) continue;
            seen.add(base);
            options.push(item);
        }
        // The <select> needs an option matching its value or it renders blank,
        // and the chosen track can be a variant the filter above skipped.
        if (current && !options.some(item => item.lang === current)) {
            options.unshift({ lang: current, origin: subtitles.meta?.origin || 'auto' });
        }
        return options.slice(0, 12);
    }, [subtitles.meta]);

    // The avatar reports each gloss as it starts. Reading the sentence it
    // belongs to from a ref keeps this callback stable, so handing it to the
    // scene does not rebuild the scene's playback closure every render.
    const displayRef = useRef({ key: '', signs: null });
    useEffect(() => {
        displayRef.current = { key: displayKey, signs: displayResult?.signs || null };
    }, [displayKey, displayResult]);

    const handlePlayingSign = useCallback((sign) => {
        const { key, signs } = displayRef.current;
        if (!signs) return;
        const idx = signs.findIndex(s => s.gloss === sign.gloss);
        if (idx >= 0) setHighlight({ key, idx });
    }, []);

    // Keep the playing line in view without yanking the page around.
    useEffect(() => {
        if (!showTranscript) return;
        activeCueElRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [activeCueIdx, showTranscript]);

    return (
        <div className="vt-page">
            <div className="wc-blob wc-blob-1" />
            <div className="wc-blob wc-blob-2" />

            {/* ── Top Bar ── */}
            <div className="vt-top-bar">
                <div className="vt-title-group">
                    <div className="vt-icon"><i className="fa-solid fa-film" /></div>
                    <div>
                        <h1 className="vt-title">Video & Dịch ký hiệu</h1>
                        <p className="vt-subtitle">
                            Mô hình 3D dịch trực tiếp lời nói trong video sang ngôn ngữ ký hiệu
                        </p>
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
                        <i
                            className={`vt-url-input-icon ${
                                detectedPlatform === 'youtube' ? 'fa-brands fa-youtube'
                                    : detectedPlatform === 'tiktok' ? 'fa-brands fa-tiktok'
                                        : 'fa-solid fa-link'}`}
                            style={
                                detectedPlatform === 'youtube' ? { color: '#ff0000' }
                                    : detectedPlatform === 'tiktok' ? { color: '#010101' }
                                        : undefined
                            }
                        />
                        <input
                            type="text"
                            className={`vt-url-input ${urlError ? 'vt-url-input--error' : ''} ${detectedPlatform ? 'vt-url-input--detected' : ''}`}
                            placeholder="Dán link video YouTube, TikTok hoặc URL video trực tiếp..."
                            value={videoUrl}
                            onChange={e => { setVideoUrl(e.target.value); setUrlError(''); }}
                            id="vt-url-input"
                        />
                        {detectedPlatform && videoUrl.trim() && (
                            <span className={`vt-url-detect-badge ${detectedPlatform}`}>
                                {detectedPlatform === 'youtube' ? 'YouTube'
                                    : detectedPlatform === 'tiktok' ? 'TikTok' : 'Video'}
                            </span>
                        )}
                    </div>
                    <button type="submit" className="vt-url-load-btn" disabled={!videoUrl.trim()} id="vt-url-load-btn">
                        <i className="fa-solid fa-play" style={{ fontSize: '11px' }} /> Tải video
                    </button>
                </form>

                {urlError && (
                    <div className="vt-url-error animate-fade-in">
                        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: '6px' }} />
                        {urlError}
                    </div>
                )}

                <div className="vt-platform-hints" style={{ marginTop: '8px' }}>
                    <span className="vt-platform-pill youtube" onClick={() => setVideoUrl('https://www.youtube.com/watch?v=')}>
                        <i className="fa-brands fa-youtube pill-icon" /> YouTube
                    </span>
                    <span className="vt-platform-pill tiktok" onClick={() => setVideoUrl('https://www.tiktok.com/@')}>
                        <i className="fa-brands fa-tiktok pill-icon" /> TikTok
                    </span>
                    <span className="vt-platform-pill direct">
                        <i className="fa-solid fa-file-video pill-icon" /> Video trực tiếp
                    </span>
                    <span className="vt-platform-pill upload" onClick={() => fileInputRef.current?.click()}>
                        <i className="fa-solid fa-file-arrow-up pill-icon" /> Tải phụ đề .srt/.vtt
                    </span>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".srt,.vtt,text/vtt,application/x-subrip"
                        onChange={handleSubtitleFile}
                        style={{ display: 'none' }}
                    />
                </div>

            </GlassCard>

            {/* ── Main: Video + Avatar ── */}
            <div className={`vt-main ${layout}`}>
                <div className="vt-video-section">
                    <GlassCard variant="strong" padding="none" hover={false} className="vt-video-card">
                        <div className="vt-video-player-container">
                            {loadedVideo ? (
                                <>
                                    {platform === 'youtube' && (
                                        <div ref={ytHostRef} className="vt-yt-host" />
                                    )}
                                    {platform === 'tiktok' && (
                                        <iframe
                                            src={loadedVideo.embedSrc}
                                            allow="autoplay; encrypted-media"
                                            allowFullScreen
                                            title="TikTok Video"
                                            style={{ background: '#000' }}
                                        />
                                    )}
                                    {platform === 'direct' && (
                                        <video ref={videoElRef} src={loadedVideo.url} autoPlay controls playsInline />
                                    )}

                                    {/* Burned-in caption over the picture, like a real subtitle track */}
                                    {activeCue && (
                                        <div className="vt-video-caption">{activeCue.text}</div>
                                    )}

                                    {youtube.error && platform === 'youtube' && (
                                        <div className="vt-player-error">
                                            <i className="fa-solid fa-triangle-exclamation" /> {youtube.error}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="vt-video-empty">
                                    <div className="vt-video-empty-icon"><i className="fa-solid fa-clapperboard" /></div>
                                    <h3>Chưa có video</h3>
                                    <p>Dán link YouTube, TikTok hoặc link video trực tiếp vào ô phía trên để bắt đầu</p>
                                    <div className="vt-empty-steps">
                                        <div className="vt-empty-step">
                                            <span className="vt-step-num">1</span><span>Dán link video</span>
                                        </div>
                                        <div className="vt-empty-step">
                                            <span className="vt-step-num">2</span><span>Phụ đề tự động tải về</span>
                                        </div>
                                        <div className="vt-empty-step">
                                            <span className="vt-step-num">3</span><span>Mô hình 3D dịch theo lời nói</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {loadedVideo && (
                            <div className="vt-video-controls">
                                <span className={`vt-video-source-badge ${platform}`}>
                                    <i className={
                                        platform === 'youtube' ? 'fa-brands fa-youtube'
                                            : platform === 'tiktok' ? 'fa-brands fa-tiktok'
                                                : 'fa-solid fa-file-video'
                                    } />
                                    {platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Video'}
                                </span>
                                {canSyncTime && hasCues && (
                                    <span className="vt-video-time">{formatTime(currentTime)}</span>
                                )}
                                <span className="vt-video-url-display" title={subtitles.meta?.title || loadedVideo.url}>
                                    {subtitles.meta?.title || loadedVideo.url}
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

                <div className="vt-sign-section" ref={overlayRef}>
                    <GlassCard variant="strong" padding="none" hover={false} className="vt-sign-card">
                        {layout === 'overlay' && (
                            <span className="vt-overlay-badge">
                                <i className="fa-solid fa-hand" style={{ marginRight: '3px', fontSize: '8px' }} /> Ký hiệu
                            </span>
                        )}
                        <div className="vt-sign-header">
                            <span className="vt-sign-header-title">
                                <span className={`sign-dot ${hasResult ? '' : 'idle'}`} />
                                {layout === 'overlay' ? '3D' : 'Mô hình 3D dịch ký hiệu'}
                            </span>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {hasResult && (
                                    <button className="vt-sign-resize-btn" onClick={handleReplayCurrent} title="Phát lại">
                                        <i className="fa-solid fa-rotate-right" />
                                    </button>
                                )}
                                <button
                                    className="vt-sign-resize-btn"
                                    onClick={() => setLayout(layout === 'overlay' ? 'side-by-side' : 'overlay')}
                                    title={layout === 'overlay' ? 'Chuyển sang chế độ song song' : 'Chuyển sang chế độ overlay'}
                                >
                                    <i className={`fa-solid ${layout === 'overlay' ? 'fa-expand' : 'fa-compress'}`} />
                                </button>
                            </div>
                        </div>

                        <div className="vt-avatar-area">
                            <Suspense fallback={(
                                <div className="vt-avatar-placeholder">
                                    <div className="loading-spinner" />
                                    <p>Đang tải mô hình 3D...</p>
                                </div>
                            )}
                            >
                                <AvatarScene3D
                                    ref={avatarRef}
                                    className="avatar-container"
                                    onPlayingSign={handlePlayingSign}
                                />
                            </Suspense>
                        </div>

                        {layout === 'side-by-side' && hasResult && (
                            <div className="vt-sign-current-word">
                                <span className="vt-sign-current-label">Đang dịch:</span>
                                <span className="vt-sign-current-text">
                                    {displayResult.signs[activeSignIdx]?.vi || '—'}
                                </span>
                                {displayResult.signs[activeSignIdx]?.gloss && (
                                    <span className="vt-sign-current-gloss">
                                        {displayResult.signs[activeSignIdx].gloss.toUpperCase()}
                                    </span>
                                )}
                                <span className="vt-sign-current-counter">
                                    {activeSignIdx + 1}/{displayResult.signs.length}
                                </span>
                            </div>
                        )}
                    </GlassCard>
                </div>
            </div>

            {/* ── Subtitle panel + transcript ── */}
            <div className="vt-input-panel">
                <GlassCard variant="strong" padding="md" hover={false} style={{ flex: 1, minWidth: 0 }}>
                    <div className="vt-subtitle-head">
                        <span className="vt-text-translate-label">
                            <i className="fa-solid fa-closed-captioning" style={{ fontSize: '12px' }} />
                            Phụ đề
                            {subtitles.meta?.lang && (
                                <span className="vt-sub-lang-chip">
                                    {describeLang(subtitles.meta.lang)}
                                    {subtitles.meta.origin === 'auto' && ' · tự động'}
                                </span>
                            )}
                        </span>

                        <div className="vt-subtitle-controls">
                            {hasCues && (
                                <button
                                    type="button"
                                    className={`vt-toggle-btn ${autoSign ? 'on' : ''}`}
                                    onClick={() => setAutoSign(v => !v)}
                                    title="Tự động cho mô hình 3D dịch theo phụ đề"
                                >
                                    <i className={`fa-solid ${autoSign ? 'fa-toggle-on' : 'fa-toggle-off'}`} />
                                    Tự động dịch
                                </button>
                            )}
                            {hasCues && canSyncTime && (
                                <div className="vt-lead-control" title="Dịch sớm hơn/muộn hơn lời nói">
                                    <button type="button" onClick={() => setLead(v => Math.round((v - 0.25) * 100) / 100)}>−</button>
                                    <span>{lead > 0 ? `+${lead.toFixed(2)}` : lead.toFixed(2)}s</span>
                                    <button type="button" onClick={() => setLead(v => Math.round((v + 0.25) * 100) / 100)}>+</button>
                                </div>
                            )}
                            {langOptions.length > 1 && (
                                <select
                                    className="vt-lang-select"
                                    value={subtitles.meta?.lang || ''}
                                    onChange={handleSubtitleLangChange}
                                    title="Đổi ngôn ngữ phụ đề"
                                >
                                    {langOptions.map(item => (
                                        <option key={item.lang} value={item.lang}>
                                            {describeLang(item.lang)}{item.origin === 'auto' ? ' (tự động)' : ''}
                                        </option>
                                    ))}
                                </select>
                            )}
                            {hasCues && (
                                <button
                                    type="button"
                                    className={`vt-toggle-btn ${showTranscript ? 'on' : ''}`}
                                    onClick={() => setShowTranscript(v => !v)}
                                >
                                    <i className="fa-solid fa-list" /> Lời thoại
                                </button>
                            )}
                            <button
                                type="button"
                                className={`vt-toggle-btn ${showManual ? 'on' : ''}`}
                                onClick={() => setShowManual(v => !v)}
                            >
                                <i className="fa-solid fa-keyboard" /> Nhập tay
                            </button>
                        </div>
                    </div>

                    {/* Subtitle states */}
                    {subtitles.status === 'loading' && (
                        <div className="vt-sub-status">
                            <div className="loading-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                            Đang lấy phụ đề của video...
                        </div>
                    )}

                    {subtitles.status === 'error' && (
                        <div className="vt-sub-status vt-sub-status--error">
                            <i className="fa-solid fa-circle-exclamation" />
                            <span>{subtitles.error}</span>
                            <button type="button" className="vt-quick-action-btn" onClick={handleRetrySubtitles}>
                                <i className="fa-solid fa-rotate-right" style={{ fontSize: '9px' }} /> Thử lại
                            </button>
                            <button type="button" className="vt-quick-action-btn" onClick={() => fileInputRef.current?.click()}>
                                <i className="fa-solid fa-file-arrow-up" style={{ fontSize: '9px' }} /> Tải file phụ đề
                            </button>
                            {isSupported && (
                                <button type="button" className="vt-quick-action-btn" onClick={() => { setShowManual(true); toggleSpeech(); }}>
                                    <i className="fa-solid fa-microphone" style={{ fontSize: '9px' }} /> Dùng micro
                                </button>
                            )}
                        </div>
                    )}

                    {subtitles.status === 'idle' && !loadedVideo && (
                        <div className="vt-sub-status vt-sub-status--muted">
                            <i className="fa-solid fa-circle-info" />
                            Tải một video lên để phụ đề và bản dịch ký hiệu chạy theo lời nói.
                        </div>
                    )}

                    {hasCues && !canSyncTime && (
                        <div className="vt-sub-status vt-sub-status--warn">
                            <i className="fa-solid fa-triangle-exclamation" />
                            TikTok không cho đọc thời gian phát, nên phụ đề không tự chạy theo video.
                            Bấm vào từng dòng lời thoại để mô hình 3D dịch dòng đó.
                        </div>
                    )}

                    {/* The live subtitle itself */}
                    {hasCues && (
                        <div className="vt-caption-stage">
                            <div className="vt-caption-line vt-caption-line--side">
                                {prevCue?.text || ''}
                            </div>
                            <div className={`vt-caption-line vt-caption-line--current ${activeCue ? '' : 'empty'}`}>
                                {activeCue?.text || (canSyncTime ? '♪ ...' : 'Chọn một dòng lời thoại bên cạnh')}
                            </div>
                            <div className="vt-caption-line vt-caption-line--side">
                                {nextCue?.text || ''}
                            </div>
                        </div>
                    )}

                    {/* Translation progress for the transcript */}
                    {hasCues && subtitles.translatedCount < subtitles.cues.length && (
                        <div className="vt-sub-progress">
                            <div className="vt-sub-progress-bar">
                                <span style={{ width: `${translateProgress}%` }} />
                            </div>
                            <span className="vt-sub-progress-text">
                                Đang chuẩn bị ký hiệu {subtitles.translatedCount}/{subtitles.cues.length}
                            </span>
                        </div>
                    )}

                    {/* Manual / microphone input */}
                    {showManual && (
                        <form className="vt-text-translate-form animate-fade-in" onSubmit={handleTextSubmit}>
                            <div className="vt-mic-section">
                                {isSupported && (
                                    <button
                                        type="button"
                                        className={`vt-mic-btn ${speechState === 'listening' ? 'recording' : ''}`}
                                        onClick={toggleSpeech}
                                        title={speechState === 'listening' ? 'Dừng nghe' : 'Nói để dịch'}
                                        id="vt-mic-btn"
                                    >
                                        <i className={`fa-solid ${speechState === 'listening' ? 'fa-microphone-slash' : 'fa-microphone'}`} />
                                    </button>
                                )}
                            </div>
                            <div className="vt-text-input-wrapper">
                                <input
                                    type="text"
                                    className="vt-text-input"
                                    placeholder="Nhập câu tiếng Việt để dịch sang ký hiệu..."
                                    value={textInput}
                                    onChange={e => setTextInput(e.target.value)}
                                    id="vt-text-input"
                                />
                                {interimText && (
                                    <div className="vt-interim-text">
                                        <i className="fa-solid fa-waveform" style={{ fontSize: '10px', marginRight: '4px' }} />
                                        {interimText}
                                    </div>
                                )}
                                {speechState === 'listening' && (
                                    <span className="vt-listening-indicator">
                                        <span className="vt-listening-dot" />
                                        <span className="vt-listening-dot" />
                                        <span className="vt-listening-dot" />
                                    </span>
                                )}
                            </div>
                            <button
                                type="submit"
                                className="vt-translate-btn"
                                disabled={!textInput.trim() || manualLoading}
                                id="vt-translate-btn"
                            >
                                {manualLoading ? (
                                    <><div className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Đang dịch...</>
                                ) : (
                                    <><i className="fa-solid fa-hands" style={{ fontSize: '12px' }} /> Dịch</>
                                )}
                            </button>
                        </form>
                    )}
                </GlassCard>

                {/* Transcript */}
                {hasCues && showTranscript && (
                    <GlassCard variant="default" padding="sm" hover={false} className="vt-history-card">
                        <div className="vt-history-header">
                            <span className="vt-history-title">
                                <i className="fa-solid fa-align-left" style={{ fontSize: '10px' }} /> Lời thoại
                                <span className="vt-history-count">{subtitles.cues.length}</span>
                            </span>
                            <button
                                className="vt-history-clear-btn"
                                onClick={() => setShowTranscript(false)}
                                title="Ẩn lời thoại"
                            >
                                <i className="fa-solid fa-xmark" style={{ fontSize: '9px' }} />
                            </button>
                        </div>
                        <div className="vt-history-list" ref={transcriptListRef}>
                            {subtitles.cues.map((cue, idx) => (
                                <button
                                    key={`${cue.start}-${idx}`}
                                    ref={idx === activeCueIdx ? activeCueElRef : null}
                                    className={`vt-history-item ${idx === activeCueIdx ? 'active' : ''}`}
                                    onClick={() => handleCueClick(idx)}
                                    title={canSyncTime ? 'Nhấn để tua đến đây' : 'Nhấn để dịch dòng này'}
                                >
                                    <span className="vt-cue-time">{formatTime(cue.start)}</span>
                                    <span className="vt-history-item-text">{cue.text}</span>
                                    {subtitles.signs[idx] && (
                                        <span className="vt-history-item-badge">
                                            {subtitles.signs[idx].found_count}/{subtitles.signs[idx].total_count}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </GlassCard>
                )}
            </div>

            {/* ── Bottom Stats ── */}
            {displayResult && (
                <div className="vt-bottom-bar glass animate-fade-in">
                    <span className={`method-badge ${displayResult.method === 'gemini' ? 'gemini' : 'rule-based'}`}>
                        {displayResult.method === 'gemini'
                            ? <><i className="fa-solid fa-robot" style={{ marginRight: '4px' }} /> Gemini AI</>
                            : <><i className="fa-solid fa-book" style={{ marginRight: '4px' }} /> Rule-based</>}
                    </span>
                    <div className="vt-bottom-stats">
                        <span className="vt-bottom-stat">
                            Tìm thấy: <strong className={foundCount / totalCount >= 0.7 ? 'high' : foundCount / totalCount >= 0.4 ? 'medium' : 'low'}>
                                {foundCount}/{totalCount} ({totalCount > 0 ? Math.round((foundCount / totalCount) * 100) : 0}%)
                            </strong>
                        </span>
                        <span className="vt-bottom-stat">
                            Câu gốc: <strong style={{ color: 'var(--ink-light)' }}>"{displayResult.input_text}"</strong>
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
