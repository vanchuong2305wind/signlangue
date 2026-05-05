import { useState, useEffect, useMemo } from 'react';

let _videosCache = null;

async function loadVideos() {
    if (_videosCache) return _videosCache;
    const resp = await fetch('/data/sign_videos.json');
    _videosCache = await resp.json();
    return _videosCache;
}

export function useSignVideos(category = 'all', searchQuery = '') {
    const [videos, setVideos] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        setLoading(true);
        loadVideos()
            .then(data => {
                setVideos(data);
                setLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setLoading(false);
            });
    }, []);

    const filtered = useMemo(() => {
        let result = videos;

        if (category && category !== 'all') {
            result = result.filter(v => v.categories.includes(category));
        }

        if (searchQuery) {
            const q = searchQuery.toLowerCase().trim();
            result = result.filter(v =>
                v.gloss.includes(q) ||
                v.vi.includes(q)
            );
        }

        return result;
    }, [videos, category, searchQuery]);

    const stats = useMemo(() => {
        const catCounts = {};
        for (const v of videos) {
            for (const c of v.categories) {
                catCounts[c] = (catCounts[c] || 0) + 1;
            }
        }
        return {
            total: videos.length,
            withVietnamese: videos.filter(v => v.vi).length,
            categories: catCounts,
        };
    }, [videos]);

    return { videos: filtered, allVideos: videos, loading, error, stats };
}
