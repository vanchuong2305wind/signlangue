import { useState, useEffect, useMemo } from 'react';

let _dataCache = null;

function searchKey(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replaceAll('đ', 'd').replaceAll('_', ' ').trim();
}

async function loadData() {
    if (_dataCache) return _dataCache;
    const resp = await fetch('/api/dictionary/videos');
    if (!resp.ok) throw new Error(`Không tải được từ điển ký hiệu Việt Nam (${resp.status})`);
    _dataCache = await resp.json();
    return _dataCache;
}

export function useSignVideos(category = 'all', searchQuery = '') {
    const [data, setData] = useState({ glosses: {}, list: [], stats: { total: 0, with_vi: 0, categories: {} } });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        loadData()
            .then(d => {
                setData(d);
                setLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setLoading(false);
            });
    }, []);

    const filtered = useMemo(() => {
        let result = data.list;

        if (category && category !== 'all') {
            result = result.filter(v => v.categories.includes(category));
        }

        if (searchQuery) {
            const q = searchKey(searchQuery);
            result = result.filter(v =>
                v.vi && searchKey(v.vi).includes(q)
            );
        }

        return result;
    }, [data.list, category, searchQuery]);

    // Fast lookup by gloss
    const getByGloss = (gloss) => data.glosses[gloss.toLowerCase()] || null;

    return {
        videos: filtered,
        allVideos: data.list,
        glosses: data.glosses,
        loading,
        error,
        stats: data.stats,
        getByGloss,
    };
}
