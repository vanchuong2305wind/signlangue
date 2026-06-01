import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Race multiple video URLs: try loading all at once, return the first one that actually loads.
 * Falls back through the list if the current video fails to play.
 * 
 * @param {Array} videos - Array of video objects [{url, type, source, video_id}]
 * @returns {{ activeVideo, isLoading, tryNext, activeIndex }}
 */
export function useVideoRace(videos = []) {
    const [activeVideo, setActiveVideo] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const abortRef = useRef(null);
    const prevVideosRef = useRef(videos);

    // Filter to only http links (skip local, swf, etc.)
    const candidates = videos.filter(v =>
        v.url && v.url.startsWith('http') && v.type !== 'swf'
    );

    const raceVideos = useCallback(() => {
        if (candidates.length === 0) {
            setActiveVideo(null);
            setIsLoading(false);
            setActiveIndex(-1);
            return;
        }

        // Abort previous race
        if (abortRef.current) {
            abortRef.current.abort = true;
        }

        const raceState = { abort: false };
        abortRef.current = raceState;
        setIsLoading(true);
        setActiveVideo(null);
        setActiveIndex(-1);

        // Separate mp4/direct links and youtube links
        const mp4Links = [];
        const youtubeLinks = [];

        candidates.forEach((v, originalIdx) => {
            if (v.type === 'youtube') {
                youtubeLinks.push({ ...v, _idx: originalIdx });
            } else {
                mp4Links.push({ ...v, _idx: originalIdx });
            }
        });

        // For mp4 links: race them by trying to load in hidden video elements
        const mp4Promises = mp4Links.map((v) => {
            return new Promise((resolve) => {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.muted = true;

                const cleanup = () => {
                    video.removeAttribute('src');
                    video.load();
                };

                const timeout = setTimeout(() => {
                    cleanup();
                    resolve(null);
                }, 8000);

                video.onloadeddata = () => {
                    clearTimeout(timeout);
                    if (!raceState.abort) {
                        resolve({ ...v, racedType: 'mp4' });
                    } else {
                        cleanup();
                        resolve(null);
                    }
                };

                video.onerror = () => {
                    clearTimeout(timeout);
                    cleanup();
                    resolve(null);
                };

                video.src = v.url;
            });
        });

        // For youtube: check via img thumbnail (fast way to verify video exists)
        const ytPromises = youtubeLinks.map((v) => {
            return new Promise((resolve) => {
                const id = extractYouTubeId(v.url);
                if (!id) {
                    resolve(null);
                    return;
                }

                const img = new Image();
                const timeout = setTimeout(() => {
                    resolve(null);
                }, 5000);

                img.onload = () => {
                    clearTimeout(timeout);
                    // YouTube returns a small default image (120x90) even for missing videos
                    // but the actual thumbnail is larger. Width 0 or very small = missing
                    if (img.width > 1 && img.naturalWidth > 1) {
                        resolve({
                            ...v,
                            racedType: 'youtube',
                            embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
                        });
                    } else {
                        resolve(null);
                    }
                };

                img.onerror = () => {
                    clearTimeout(timeout);
                    resolve(null);
                };

                // Use mqdefault - returns 320x180 for valid videos, or 120x90 placeholder for missing
                img.src = `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
            });
        });

        // Race all promises - first non-null wins
        const allPromises = [...mp4Promises, ...ytPromises];

        // Use Promise.any-like behavior: resolve with the first successful one
        let resolved = false;

        allPromises.forEach((p) => {
            p.then((result) => {
                if (result && !resolved && !raceState.abort) {
                    resolved = true;
                    setActiveVideo(result);
                    setActiveIndex(result._idx);
                    setIsLoading(false);
                }
            });
        });

        // Fallback: if all fail, set null
        Promise.all(allPromises).then((results) => {
            if (!resolved && !raceState.abort) {
                // Try the first YouTube link as a last resort (they might still work via embed)
                const firstYt = youtubeLinks[0];
                if (firstYt) {
                    const id = extractYouTubeId(firstYt.url);
                    if (id) {
                        setActiveVideo({
                            ...firstYt,
                            racedType: 'youtube',
                            embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
                        });
                        setActiveIndex(firstYt._idx);
                        setIsLoading(false);
                        return;
                    }
                }
                setActiveVideo(null);
                setActiveIndex(-1);
                setIsLoading(false);
            }
        });
    }, [JSON.stringify(candidates.map(c => c.url))]);

    // Reset immediately when videos array reference changes
    useEffect(() => {
        if (prevVideosRef.current !== videos) {
            prevVideosRef.current = videos;
            // Abort any in-progress race
            if (abortRef.current) {
                abortRef.current.abort = true;
            }
            // Clear stale video immediately
            setActiveVideo(null);
            setActiveIndex(-1);
        }
    }, [videos]);

    useEffect(() => {
        raceVideos();

        return () => {
            if (abortRef.current) {
                abortRef.current.abort = true;
            }
        };
    }, [raceVideos, videos]);

    // Manual fallback: skip to next candidate
    const tryNext = useCallback(() => {
        if (activeIndex < 0 || candidates.length <= 1) return;

        const remaining = candidates.filter((_, i) => i !== activeIndex);
        if (remaining.length === 0) return;

        // Try the next one directly
        const next = remaining[0];
        if (next.type === 'youtube') {
            const id = extractYouTubeId(next.url);
            setActiveVideo({
                ...next,
                racedType: 'youtube',
                embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
            });
        } else {
            setActiveVideo({ ...next, racedType: 'mp4' });
        }
        setActiveIndex(candidates.indexOf(next));
    }, [activeIndex, candidates]);

    return {
        activeVideo,
        isLoading,
        tryNext,
        activeIndex,
        totalCandidates: candidates.length,
    };
}

function extractYouTubeId(url) {
    if (!url) return '';
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
    return match ? match[1] : '';
}
