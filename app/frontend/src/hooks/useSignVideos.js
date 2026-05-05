import { useState, useEffect, useMemo } from 'react';

let _dataCache = null;

async function loadData() {
    if (_dataCache) return _dataCache;
    const resp = await fetch('/data/sign_videos.json');
    _dataCache = await resp.json();
    return _dataCache;
}

export function useSignVideos(category = 'all', searchQuery = '') {
    const [data, setData] = useState({ glosses: {}, list: [], stats: { total: 0, with_vi: 0, categories: {} } });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        setLoading(true);
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
            const q = searchQuery.toLowerCase().trim();
            result = result.filter(v =>
                v.gloss.includes(q) ||
                (v.vi && v.vi.includes(q))
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
