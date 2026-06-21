import { useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import GlassCard from '../components/ui/GlassCard';
import { useSignVideos } from '../hooks/useSignVideos';
import { CATEGORIES } from '../data/categories';
import { recordActivity } from '../api/profile';
import useStudyTimer from '../hooks/useStudyTimer';
import './Learn.css';

const ITEMS_PER_PAGE = 24;

const TYPE_LABELS = {
    mp4: { label: 'MP4', icon: 'fa-film', color: '#6aaa7a' },
    youtube: { label: 'YouTube', icon: 'fa-play', color: '#c87a72' },
    local: { label: 'Local', icon: 'fa-hard-drive', color: '#6a9bba' },
    other: { label: 'Link', icon: 'fa-link', color: '#9a7aa5' },
};

const WORD_ICONS = {
    hello: 'fa-hand',
    goodbye: 'fa-hand',
    love: 'fa-heart',
    like: 'fa-thumbs-up',
    book: 'fa-book-open',
    read: 'fa-book-reader',
    write: 'fa-pen',
    school: 'fa-school',
    teacher: 'fa-chalkboard-user',
    student: 'fa-user-graduate',
    home: 'fa-house',
    house: 'fa-house',
    family: 'fa-people-roof',
    mother: 'fa-person-dress',
    father: 'fa-person',
    friend: 'fa-user-group',
    eat: 'fa-utensils',
    drink: 'fa-glass-water',
    water: 'fa-droplet',
    coffee: 'fa-mug-hot',
    apple: 'fa-apple-whole',
    dog: 'fa-dog',
    cat: 'fa-cat',
    bird: 'fa-dove',
    fish: 'fa-fish',
    happy: 'fa-face-smile',
    sad: 'fa-face-sad-tear',
    angry: 'fa-face-angry',
    doctor: 'fa-user-doctor',
    hospital: 'fa-hospital',
    time: 'fa-clock',
    rain: 'fa-cloud-rain',
    sun: 'fa-sun',
    moon: 'fa-moon',
    car: 'fa-car',
    computer: 'fa-computer',
    phone: 'fa-mobile-screen',
    music: 'fa-music',
    help: 'fa-handshake-angle',
    run: 'fa-person-running',
    walk: 'fa-person-walking',
    sleep: 'fa-bed',
};

function getWordVisual(word) {
    const categoryKey = word.categories?.find(key => CATEGORIES[key]) || 'other';
    const category = CATEGORIES[categoryKey] || CATEGORIES.other;
    return {
        icon: WORD_ICONS[word.gloss?.toLowerCase()] || category.icon,
        gradient: category.gradient,
    };
}

export default function Learn() {
    useStudyTimer('Học ký hiệu');
    const [searchParams, setSearchParams] = useSearchParams();
    const initialCategory = searchParams.get('category') || 'all';

    const [category, setCategory] = useState(initialCategory);
    const [search, setSearch] = useState('');
    const [selectedWord, setSelectedWord] = useState(null);
    const [activeVideoIdx, setActiveVideoIdx] = useState(0);
    const [page, setPage] = useState(1);
    const [viewMode, setViewMode] = useState('grid');

    const { videos, loading, stats } = useSignVideos(category, search);

    const totalPages = Math.ceil(videos.length / ITEMS_PER_PAGE);
    const paginatedVideos = useMemo(() => {
        const start = (page - 1) * ITEMS_PER_PAGE;
        return videos.slice(start, start + ITEMS_PER_PAGE);
    }, [videos, page]);

    const handleCategoryChange = useCallback((cat) => {
        setCategory(cat);
        setPage(1);
        setSearchParams(cat === 'all' ? {} : { category: cat });
    }, [setSearchParams]);

    const handleSearch = useCallback((value) => {
        setSearch(value);
        setPage(1);
    }, []);

    const openWord = (word) => {
        setSelectedWord(word);
        setActiveVideoIdx(0);
        recordActivity(
            'learned_word',
            word.vi || word.gloss,
            { gloss: word.gloss },
        ).catch(() => {});
        recordActivity(
            'video_view',
            word.vi || word.gloss,
            { gloss: word.gloss },
        ).catch(() => {});
    };

    const closeModal = () => {
        setSelectedWord(null);
        setActiveVideoIdx(0);
    };

    const playableVideos = selectedWord
        ? selectedWord.videos.filter(v => v.type !== 'swf' && v.type !== 'local' && v.url?.startsWith('http'))
        : [];

    const activeVideo = playableVideos[activeVideoIdx] || null;

    // Auto-skip to next video when current one fails to load
    const handleVideoError = () => {
        if (activeVideoIdx < playableVideos.length - 1) {
            setActiveVideoIdx(prev => prev + 1);
        }
    };

    return (
        <div className="learn animate-fade-in">
            {/* Category Tabs */}
            <div className="learn__categories">
                <div className="learn__categories-scroll">
                    {Object.entries(CATEGORIES).map(([key, cat]) => (
                        <button
                            key={key}
                            className={`learn__category-tab ${category === key ? 'learn__category-tab--active' : ''}`}
                            onClick={() => handleCategoryChange(key)}
                            style={category === key ? { background: cat.gradient, color: 'white' } : {}}
                        >
                            <span className="learn__category-tab-icon">
                                <i className={`fa-solid ${cat.icon}`} />
                            </span>
                            <span className="learn__category-tab-label">{cat.label}</span>
                            {stats.categories[key] && (
                                <span className="learn__category-tab-count">
                                    {key === 'all' ? stats.total : stats.categories[key]}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Search and controls */}
            <div className="learn__toolbar">
                <div className="learn__search">
                    <i className="fa-solid fa-magnifying-glass learn__search-icon" />
                    <input
                        type="text"
                        placeholder="Tìm từ vựng (VD: xin chào, hello)..."
                        value={search}
                        onChange={(e) => handleSearch(e.target.value)}
                        className="learn__search-input"
                    />
                    {search && (
                        <button className="learn__search-clear" onClick={() => handleSearch('')}>
                            <i className="fa-solid fa-xmark" style={{ fontSize: '11px' }} />
                        </button>
                    )}
                </div>

                <div className="learn__controls">
                    <span className="learn__results-count">
                        {videos.length} kết quả
                    </span>
                    <div className="learn__view-toggle">
                        <button
                            className={`learn__view-btn ${viewMode === 'grid' ? 'learn__view-btn--active' : ''}`}
                            onClick={() => setViewMode('grid')}
                        >
                            <i className="fa-solid fa-table-cells-large" style={{ fontSize: '12px' }} />
                        </button>
                        <button
                            className={`learn__view-btn ${viewMode === 'list' ? 'learn__view-btn--active' : ''}`}
                            onClick={() => setViewMode('list')}
                        >
                            <i className="fa-solid fa-list" style={{ fontSize: '12px' }} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Word Grid / List */}
            {loading ? (
                <div className="learn__loading">
                    <div className="learn__loading-spinner" />
                    <p>Đang tải từ vựng...</p>
                </div>
            ) : paginatedVideos.length === 0 ? (
                <GlassCard padding="xl" hover={false} className="learn__empty">
                    <i className="fa-solid fa-magnifying-glass learn__empty-icon" />
                    <p className="learn__empty-text">Không tìm thấy từ vựng phù hợp</p>
                    <button className="learn__empty-reset" onClick={() => { handleSearch(''); handleCategoryChange('all'); }}>
                        Xóa bộ lọc
                    </button>
                </GlassCard>
            ) : (
                <div className={`learn__grid ${viewMode === 'list' ? 'learn__grid--list' : ''} stagger-children`}>
                    {paginatedVideos.map((word) => {
                        const visual = getWordVisual(word);
                        return (
                            <GlassCard
                                key={word.gloss}
                                padding="none"
                                className={`learn__word-card ${selectedWord?.gloss === word.gloss ? 'learn__word-card--selected' : ''}`}
                                onClick={() => openWord(word)}
                            >
                                {viewMode === 'grid' ? (
                                    <>
                                    <div
                                        className="learn__word-preview"
                                        style={{ '--word-gradient': visual.gradient }}
                                    >
                                        <div className="learn__word-decoration" aria-hidden="true">
                                            <i className={`fa-solid ${visual.icon}`} />
                                        </div>
                                        <div className="learn__word-symbol">
                                            <i className={`fa-solid ${visual.icon}`} />
                                        </div>
                                        <div className="learn__word-play-icon">
                                            <i className="fa-solid fa-play" />
                                        </div>
                                        <div className="learn__word-badge-row">
                                            <span className="learn__word-video-count">{word.video_count} video</span>
                                        </div>
                                    </div>
                                    <div className="learn__word-info">
                                        <div className="learn__word-vi">{word.vi || word.gloss}</div>
                                        <div className="learn__word-gloss">{word.gloss.toUpperCase()}</div>
                                    </div>
                                    </>
                                ) : (
                                    <div className="learn__word-list-item">
                                    <div className="learn__word-list-play" style={{ background: visual.gradient, color: 'white' }}>
                                        <i className={`fa-solid ${visual.icon}`} style={{ fontSize: '11px' }} />
                                    </div>
                                    <div className="learn__word-list-vi">{word.vi || word.gloss}</div>
                                    <div className="learn__word-list-gloss">{word.gloss.toUpperCase()}</div>
                                    <div className="learn__word-list-count">{word.video_count} video</div>
                                </div>
                                )}
                            </GlassCard>
                        );
                    })}
                </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="learn__pagination">
                    <button
                        className="learn__page-btn"
                        disabled={page <= 1}
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                        <i className="fa-solid fa-chevron-left" style={{ fontSize: '12px' }} />
                    </button>
                    <div className="learn__page-info">
                        <span className="learn__page-current">{page}</span>
                        <span className="learn__page-sep">/</span>
                        <span className="learn__page-total">{totalPages}</span>
                    </div>
                    <button
                        className="learn__page-btn"
                        disabled={page >= totalPages}
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    >
                        <i className="fa-solid fa-chevron-right" style={{ fontSize: '12px' }} />
                    </button>
                </div>
            )}

            {/* === VIDEO PLAYER MODAL === */}
            {/* === VIDEO PLAYER MODAL (Portal to body) === */}
            {selectedWord && createPortal(
                <div className="learn__modal-overlay" onClick={closeModal}>
                    <div className="learn__modal animate-fade-in-scale" onClick={e => e.stopPropagation()}>
                        <button className="learn__modal-close" onClick={closeModal}>
                            <i className="fa-solid fa-xmark" />
                        </button>

                        {/* Video Player */}
                        <div className="learn__modal-video">
                            {activeVideo?.type === 'youtube' ? (
                                <iframe
                                    key={activeVideo.url}
                                    src={`https://www.youtube.com/embed/${extractYouTubeId(activeVideo.url)}?autoplay=1`}
                                    className="learn__video-iframe"
                                    allow="autoplay; encrypted-media"
                                    allowFullScreen
                                    title={selectedWord.gloss}
                                />
                            ) : activeVideo ? (
                                <video
                                    key={activeVideo.url}
                                    controls
                                    autoPlay
                                    loop
                                    playsInline
                                    className="learn__video-player"
                                    onError={handleVideoError}
                                >
                                    <source src={activeVideo.url} type="video/mp4" />
                                    Video khong ho tro
                                </video>
                            ) : (
                                <div className="learn__video-empty">Không có video</div>
                            )}
                        </div>

                        {/* Word Info */}
                        <div className="learn__modal-info">
                            <h2 className="learn__modal-word">{selectedWord.vi || selectedWord.gloss}</h2>
                            <div className="learn__modal-gloss">{selectedWord.gloss.toUpperCase()}</div>

                            {selectedWord.vi && (
                                <div className="learn__modal-translation">
                                    <i className="fa-solid fa-language" style={{ fontSize: '13px' }} />
                                    <span>Tiếng Việt: <strong>{selectedWord.vi}</strong></span>
                                </div>
                            )}
                        </div>

                        {/* Video List */}
                        <div className="learn__modal-videos">
                            <div className="learn__modal-videos-header">
                                <span className="learn__modal-videos-title">
                                    <i className="fa-solid fa-video" style={{ marginRight: '6px', opacity: 0.6 }} />
                                    Danh sách video ({playableVideos.length})
                                </span>
                            </div>
                            <div className="learn__modal-videos-list">
                                {playableVideos.map((v, idx) => {
                                    const typeInfo = TYPE_LABELS[v.type] || TYPE_LABELS.other;
                                    return (
                                        <button
                                            key={`${v.url}-${idx}`}
                                            className={`learn__video-item ${idx === activeVideoIdx ? 'learn__video-item--active' : ''}`}
                                            onClick={() => setActiveVideoIdx(idx)}
                                        >
                                            <span className="learn__video-item-icon">
                                                <i className={`fa-solid ${typeInfo.icon}`} />
                                            </span>
                                            <div className="learn__video-item-info">
                                                <span className="learn__video-item-source">{v.source}</span>
                                                <span className="learn__video-item-type" style={{ color: typeInfo.color }}>
                                                    {typeInfo.label}
                                                </span>
                                            </div>
                                            {idx === activeVideoIdx && (
                                                <span className="learn__video-item-playing">
                                                    <i className="fa-solid fa-play" style={{ fontSize: '8px', marginRight: '4px' }} />
                                                    Đang phát
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Word navigation */}
                        <div className="learn__modal-nav">
                            <button
                                className="learn__modal-nav-btn"
                                onClick={() => {
                                    const idx = videos.findIndex(v => v.gloss === selectedWord.gloss);
                                    if (idx > 0) openWord(videos[idx - 1]);
                                }}
                            >
                                <i className="fa-solid fa-chevron-left" style={{ fontSize: '11px', marginRight: '4px' }} /> Trước
                            </button>
                            <button
                                className="learn__modal-nav-btn"
                                onClick={() => {
                                    const idx = videos.findIndex(v => v.gloss === selectedWord.gloss);
                                    if (idx < videos.length - 1) openWord(videos[idx + 1]);
                                }}
                            >
                                Tiếp <i className="fa-solid fa-chevron-right" style={{ fontSize: '11px', marginLeft: '4px' }} />
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}

function extractYouTubeId(url) {
    if (!url) return '';
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
    return match ? match[1] : '';
}
