/**
 * useYouTubePlayer.js
 * Wrap the YouTube IFrame Player API.
 *
 * A plain <iframe> embed plays fine but tells the page nothing, and the whole
 * point here is knowing *where* the video is: the avatar can only sign the
 * right subtitle line if it knows the playhead. The IFrame API is the only way
 * to read that out of a YouTube embed, so the embed is built through it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const API_SRC = 'https://www.youtube.com/iframe_api';

// The API script is global and may only be loaded once per page; every hook
// instance waits on this same promise.
let apiPromise = null;

function loadYouTubeApi() {
    if (typeof window === 'undefined') {
        return Promise.reject(new Error('Không có window'));
    }
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;

    apiPromise = new Promise((resolve, reject) => {
        // Another script may already own this callback — chain rather than
        // clobber, or whoever registered first never gets told.
        const previous = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            try { previous?.(); } catch { /* not our problem */ }
            resolve(window.YT);
        };

        if (document.querySelector(`script[src="${API_SRC}"]`)) return;

        const script = document.createElement('script');
        script.src = API_SRC;
        script.async = true;
        script.onerror = () => {
            apiPromise = null;
            reject(new Error('Không tải được YouTube Player API. Kiểm tra kết nối mạng.'));
        };
        document.head.appendChild(script);
    });
    return apiPromise;
}

// Every field the hook reports lives in one object tagged with the video it
// describes, so switching videos clears the old status by derivation instead of
// by a second render pass that resets each flag.
const BLANK = { id: null, ready: false, error: '', isPlaying: false, duration: 0 };

/**
 * @param {string|null} videoId  YouTube id, or null to tear the player down.
 * @param {import('react').RefObject<HTMLElement>} hostRef  Element to mount into.
 */
export default function useYouTubePlayer(videoId, hostRef) {
    const playerRef = useRef(null);
    const [status, setStatus] = useState(BLANK);

    useEffect(() => {
        const host = hostRef.current;
        if (!videoId || !host) return undefined;

        let cancelled = false;
        // Only ever updated from a callback, never from the effect body, so a
        // mount costs one render rather than a cascade.
        const update = (patch) => {
            if (cancelled) return;
            setStatus(prev => ({ ...(prev.id === videoId ? prev : BLANK), ...patch, id: videoId }));
        };

        // YT.Player *replaces* the element it is given, so it gets a throwaway
        // child instead of the div React rendered — otherwise React would later
        // try to clean up a node that no longer exists.
        const mount = document.createElement('div');
        host.appendChild(mount);

        loadYouTubeApi()
            .then((YT) => {
                if (cancelled) return;
                const player = new YT.Player(mount, {
                    videoId,
                    playerVars: {
                        autoplay: 1,
                        rel: 0,
                        modestbranding: 1,
                        playsinline: 1,
                        enablejsapi: 1,
                        origin: window.location.origin,
                    },
                    events: {
                        onReady: (event) => {
                            playerRef.current = event.target;
                            update({ ready: true, duration: event.target.getDuration?.() || 0 });
                            try { event.target.playVideo?.(); } catch { /* autoplay may be blocked */ }
                        },
                        onStateChange: (event) => {
                            const playing = event.data === YT.PlayerState.PLAYING;
                            update({
                                isPlaying: playing,
                                ...(playing ? { duration: event.target.getDuration?.() || 0 } : {}),
                            });
                        },
                        onError: () => update({
                            error: 'Không phát được video này — chủ video có thể đã tắt tính năng nhúng.',
                        }),
                    },
                });
                playerRef.current = player;
            })
            .catch((err) => update({ error: err.message || 'Không tải được trình phát YouTube' }));

        return () => {
            cancelled = true;
            const player = playerRef.current;
            playerRef.current = null;
            try { player?.destroy?.(); } catch { /* already gone */ }
            // destroy() usually removes the iframe, but not on every error path.
            host.innerHTML = '';
        };
    }, [videoId, hostRef]);

    const getCurrentTime = useCallback(() => {
        try {
            return playerRef.current?.getCurrentTime?.() ?? 0;
        } catch {
            return 0;
        }
    }, []);

    const seekTo = useCallback((seconds) => {
        try { playerRef.current?.seekTo?.(seconds, true); } catch { /* not ready */ }
    }, []);

    const play = useCallback(() => {
        try { playerRef.current?.playVideo?.(); } catch { /* not ready */ }
    }, []);

    const pause = useCallback(() => {
        try { playerRef.current?.pauseVideo?.(); } catch { /* not ready */ }
    }, []);

    // Status from a video that has since been swapped out is not reported at all.
    const current = status.id === videoId ? status : BLANK;

    return {
        ready: current.ready,
        error: current.error,
        isPlaying: current.isPlaying,
        duration: current.duration,
        getCurrentTime,
        seekTo,
        play,
        pause,
    };
}
