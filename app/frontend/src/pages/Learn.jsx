import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Grid, List, Play, Volume2, ChevronLeft, ChevronRight, X, ExternalLink, MonitorPlay, Globe, HardDrive } from 'lucide-react';
import GlassCard from '../components/ui/GlassCard';
import { useSignVideos } from '../hooks/useSignVideos';
import { CATEGORIES } from '../data/categories';
import './Learn.css';

const ITEMS_PER_PAGE = 24;

const TYPE_LABELS = {
    mp4: { label: 'MP4', icon: '🎬', color: '#10b981' },
    youtube: { label: 'YouTube', icon: '▶️', color: '#ef4444' },
    local: { label: 'Local', icon: '💾', color: '#3b82f6' },
    other: { label: 'Link', icon: '🔗', color: '#8b5cf6' },
};

export default function Learn() {
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
    };

    const closeModal = () => {
        setSelectedWord(null);
        setActiveVideoIdx(0);
    };

    // Get playable videos (exclude swf)
    const playableVideos = selectedWord
        ? selectedWord.videos.filter(v => v.type !== 'swf')
        : [];

    const activeVideo = playableVideos[activeVideoIdx] || null;

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
                            <span className="learn__category-tab-icon">{cat.icon}</span>
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
                <div className="learn__search glass">
                    <Search size={16} className="learn__search-icon" />
                    <input
                        type="text"
                        placeholder="Tìm từ vựng (VD: xin chào, hello)..."
                        value={search}
                        onChange={(e) => handleSearch(e.target.value)}
                        className="learn__search-input"
                    />
                    {search && (
                        <button className="learn__search-clear" onClick={() => handleSearch('')}>
                            <X size={14} />
                        </button>
                    )}
                </div>

                <div className="learn__controls">
                    <span className="learn__results-count">
                        {videos.length} kết quả
                    </span>
                    <div className="learn__view-toggle glass">
                        <button
                            className={`learn__view-btn ${viewMode === 'grid' ? 'learn__view-btn--active' : ''}`}
                            onClick={() => setViewMode('grid')}
                        >
                            <Grid size={14} />
                        </button>
                        <button
                            className={`learn__view-btn ${viewMode === 'list' ? 'learn__view-btn--active' : ''}`}
                            onClick={() => setViewMode('list')}
                        >
                            <List size={14} />
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
                    <span className="learn__empty-icon">🔍</span>
                    <p className="learn__empty-text">Không tìm thấy từ vựng phù hợp</p>
                    <button className="learn__empty-reset" onClick={() => { handleSearch(''); handleCategoryChange('all'); }}>
                        Xóa bộ lọc
                    </button>
                </GlassCard>
            ) : (
                <div className={`learn__grid ${viewMode === 'list' ? 'learn__grid--list' : ''} stagger-children`}>
                    {paginatedVideos.map((word) => (
                        <GlassCard
                            key={word.gloss}
                            padding="none"
                            className={`learn__word-card ${selectedWord?.gloss === word.gloss ? 'learn__word-card--selected' : ''}`}
                            onClick={() => openWord(word)}
                        >
                            {viewMode === 'grid' ? (
                                <>
                                    <div className="learn__word-preview">
                                        <div className="learn__word-play-icon">
                                            <Play size={20} fill="white" />
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
                                    <div className="learn__word-list-play">
                                        <Play size={14} fill="currentColor" />
                                    </div>
                                    <div className="learn__word-list-vi">{word.vi || word.gloss}</div>
                                    <div className="learn__word-list-gloss">{word.gloss.toUpperCase()}</div>
                                    <div className="learn__word-list-count">{word.video_count} video</div>
                                </div>
                            )}
                        </GlassCard>
                    ))}
                </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="learn__pagination">
                    <button
                        className="learn__page-btn glass"
                        disabled={page <= 1}
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <div className="learn__page-info">
                        <span className="learn__page-current">{page}</span>
                        <span className="learn__page-sep">/</span>
                        <span className="learn__page-total">{totalPages}</span>
                    </div>
                    <button
                        className="learn__page-btn glass"
                        disabled={page >= totalPages}
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
            )}

            {/* === VIDEO PLAYER MODAL === */}
            {selectedWord && (
                <div className="learn__modal-overlay" onClick={closeModal}>
                    <div className="learn__modal glass-heavy animate-fade-in-scale" onClick={e => e.stopPropagation()}>
                        <button className="learn__modal-close" onClick={closeModal}>
                            <X size={20} />
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
                                >
                                    <source src={activeVideo.url} type="video/mp4" />
                                    Video không hỗ trợ
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
                                    <Volume2 size={14} />
                                    <span>Tiếng Việt: <strong>{selectedWord.vi}</strong></span>
                                </div>
                            )}
                        </div>

                        {/* Video List - ALL available videos */}
                        <div className="learn__modal-videos">
                            <div className="learn__modal-videos-header">
                                <span className="learn__modal-videos-title">📹 Danh sách video ({playableVideos.length})</span>
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
                                            <span className="learn__video-item-icon">{typeInfo.icon}</span>
                                            <div className="learn__video-item-info">
                                                <span className="learn__video-item-source">{v.source}</span>
                                                <span className="learn__video-item-type" style={{ color: typeInfo.color }}>
                                                    {typeInfo.label}
                                                </span>
                                            </div>
                                            {idx === activeVideoIdx && (
                                                <span className="learn__video-item-playing">▶ Đang phát</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Word navigation */}
                        <div className="learn__modal-nav">
                            <button
                                className="learn__modal-nav-btn glass"
                                onClick={() => {
                                    const idx = videos.findIndex(v => v.gloss === selectedWord.gloss);
                                    if (idx > 0) openWord(videos[idx - 1]);
                                }}
                            >
                                <ChevronLeft size={16} /> Trước
                            </button>
                            <button
                                className="learn__modal-nav-btn glass"
                                onClick={() => {
                                    const idx = videos.findIndex(v => v.gloss === selectedWord.gloss);
                                    if (idx < videos.length - 1) openWord(videos[idx + 1]);
                                }}
                            >
                                Tiếp <ChevronRight size={16} />
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function extractYouTubeId(url) {
    if (!url) return '';
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
    return match ? match[1] : '';
}
