import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

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
    const failedIndexesRef = useRef(new Set());

    // Filter to only http links (skip local, swf, etc.)
    const candidates = useMemo(
        () => videos.filter(v =>
            v.url && v.url.startsWith('http') && v.type !== 'swf'
        ),
        [videos]
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

        const raceState = { abort: false, failedIndexes: new Set() };
        abortRef.current = raceState;
        failedIndexesRef.current = raceState.failedIndexes;
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
                    video.onloadeddata = null;
                    video.onerror = null;
                    video.removeAttribute('src');
                    video.load();
                };

                const timeout = setTimeout(() => {
                    raceState.failedIndexes.add(v._idx);
                    cleanup();
                    resolve(null);
                }, 8000);

                video.onloadeddata = () => {
                    clearTimeout(timeout);
                    if (!raceState.abort) {
                        cleanup();
                        resolve({ ...v, racedType: 'mp4' });
                    } else {
                        cleanup();
                        resolve(null);
                    }
                };

                video.onerror = () => {
                    clearTimeout(timeout);
                    raceState.failedIndexes.add(v._idx);
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
                    raceState.failedIndexes.add(v._idx);
                    resolve(null);
                    return;
                }

                const img = new Image();
                const timeout = setTimeout(() => {
                    raceState.failedIndexes.add(v._idx);
                    resolve(null);
                }, 5000);

                img.onload = () => {
                    clearTimeout(timeout);
                    // YouTube returns a small default image (120x90) even for missing videos
                    // but the actual thumbnail is larger. Width 0 or very small = missing
                    if (img.naturalWidth > 120) {
                        resolve({
                            ...v,
                            racedType: 'youtube',
                            embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
                        });
                    } else {
                        raceState.failedIndexes.add(v._idx);
                        resolve(null);
                    }
                };

                img.onerror = () => {
                    clearTimeout(timeout);
                    raceState.failedIndexes.add(v._idx);
                    resolve(null);
                };

                // Use mqdefault - returns 320x180 for valid videos, or 120x90 placeholder for missing
                img.src = `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
            });
        });

        // Prefer direct videos. A valid YouTube thumbnail does not guarantee
        // that the video allows embedding, and iframe failures cannot be
        // observed reliably through the native onError event.
        let resolved = false;

        mp4Promises.forEach((p) => {
            p.then((result) => {
                if (result && !resolved && !raceState.abort) {
                    resolved = true;
                    raceState.failedIndexes.delete(result._idx);
                    setActiveVideo(result);
                    setActiveIndex(result._idx);
                    setIsLoading(false);
                }
            });
        });

        // Only consider YouTube after every direct video has failed.
        Promise.all(mp4Promises).then(() => {
            if (resolved || raceState.abort) return;

            ytPromises.forEach((p) => {
                p.then((result) => {
                    if (result && !resolved && !raceState.abort) {
                        resolved = true;
                        raceState.failedIndexes.delete(result._idx);
                        setActiveVideo(result);
                        setActiveIndex(result._idx);
                        setIsLoading(false);
                    }
                });
            });
        });

        // Fallback: if every candidate fails, set null.
        Promise.all([...mp4Promises, ...ytPromises]).then(() => {
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
                        raceState.failedIndexes.delete(firstYt._idx);
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
    }, [candidates]);

    // Reset immediately when videos array reference changes
    useEffect(() => {
        if (prevVideosRef.current !== videos) {
            prevVideosRef.current = videos;
            // Abort any in-progress race
            if (abortRef.current) {
                abortRef.current.abort = true;
            }
            // Clear stale video immediately
            failedIndexesRef.current = new Set();
            setActiveVideo(null);
            setActiveIndex(-1);
        }
    }, [videos]);

    useEffect(() => {
        const startTimer = setTimeout(raceVideos, 0);

        return () => {
            clearTimeout(startTimer);
            if (abortRef.current) {
                abortRef.current.abort = true;
            }
        };
    }, [raceVideos, videos]);

    // Manual fallback: skip to next candidate
    const tryNext = useCallback(() => {
        if (activeIndex < 0) return;

        failedIndexesRef.current.add(activeIndex);
        if (candidates.length <= 1) {
            setActiveVideo(null);
            setActiveIndex(-1);
            return;
        }

        let nextIndex = -1;
        for (let offset = 1; offset < candidates.length; offset += 1) {
            const candidateIndex = (activeIndex + offset) % candidates.length;
            if (!failedIndexesRef.current.has(candidateIndex)) {
                nextIndex = candidateIndex;
                break;
            }
        }

        if (nextIndex < 0) {
            setActiveVideo(null);
            setActiveIndex(-1);
            return;
        }

        const next = candidates[nextIndex];
        if (next.type === 'youtube') {
            const id = extractYouTubeId(next.url);
            if (!id) {
                failedIndexesRef.current.add(nextIndex);
                setActiveVideo(null);
                setActiveIndex(-1);
                return;
            }
            setActiveVideo({
                ...next,
                racedType: 'youtube',
                embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
            });
        } else {
            setActiveVideo({ ...next, racedType: 'mp4' });
        }
        setActiveIndex(nextIndex);
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
