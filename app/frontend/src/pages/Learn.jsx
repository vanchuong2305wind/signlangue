import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Filter, Grid, List, Play, Volume2, ChevronLeft, ChevronRight, X } from 'lucide-react';
import GlassCard from '../components/ui/GlassCard';
import { useSignVideos } from '../hooks/useSignVideos';
import { CATEGORIES } from '../data/categories';
import './Learn.css';

const ITEMS_PER_PAGE = 24;

export default function Learn() {
    const [searchParams, setSearchParams] = useSearchParams();
    const initialCategory = searchParams.get('category') || 'all';

    const [category, setCategory] = useState(initialCategory);
    const [search, setSearch] = useState('');
    const [selectedWord, setSelectedWord] = useState(null);
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
                            onClick={() => setSelectedWord(selectedWord?.gloss === word.gloss ? null : word)}
                        >
                            {viewMode === 'grid' ? (
                                <>
                                    <div className="learn__word-preview">
                                        <div className="learn__word-play-icon">
                                            <Play size={20} fill="white" />
                                        </div>
                                        <div className="learn__word-source">{word.source}</div>
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
                                    <div className="learn__word-list-source">{word.source}</div>
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

            {/* Video Player Modal */}
            {selectedWord && (
                <div className="learn__modal-overlay" onClick={() => setSelectedWord(null)}>
                    <div className="learn__modal glass-heavy animate-fade-in-scale" onClick={e => e.stopPropagation()}>
                        <button className="learn__modal-close" onClick={() => setSelectedWord(null)}>
                            <X size={20} />
                        </button>

                        <div className="learn__modal-video">
                            <video
                                key={selectedWord.url}
                                controls
                                autoPlay
                                loop
                                playsInline
                                className="learn__video-player"
                            >
                                <source src={selectedWord.url} type="video/mp4" />
                                Video không hỗ trợ
                            </video>
                        </div>

                        <div className="learn__modal-info">
                            <h2 className="learn__modal-word">{selectedWord.vi || selectedWord.gloss}</h2>
                            <div className="learn__modal-gloss">{selectedWord.gloss.toUpperCase()}</div>
                            <div className="learn__modal-meta">
                                <span className="learn__modal-source">📹 {selectedWord.source}</span>
                                <span className="learn__modal-categories">
                                    {selectedWord.categories.map(c => CATEGORIES[c]?.icon || '📦').join(' ')}
                                </span>
                            </div>
                            {selectedWord.vi && (
                                <div className="learn__modal-translation">
                                    <Volume2 size={14} />
                                    <span>Tiếng Việt: <strong>{selectedWord.vi}</strong></span>
                                </div>
                            )}
                        </div>

                        {/* Navigation buttons */}
                        <div className="learn__modal-nav">
                            <button
                                className="learn__modal-nav-btn glass"
                                onClick={() => {
                                    const idx = videos.findIndex(v => v.gloss === selectedWord.gloss);
                                    if (idx > 0) setSelectedWord(videos[idx - 1]);
                                }}
                            >
                                <ChevronLeft size={16} /> Trước
                            </button>
                            <button
                                className="learn__modal-nav-btn glass"
                                onClick={() => {
                                    const idx = videos.findIndex(v => v.gloss === selectedWord.gloss);
                                    if (idx < videos.length - 1) setSelectedWord(videos[idx + 1]);
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
