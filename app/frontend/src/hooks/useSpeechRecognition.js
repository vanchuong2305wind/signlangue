/**
 * useSpeechRecognition.js
 * React hook wrapping Web Speech API.
 * Ported from app/js/speech-engine.js + noise-filter.js
 *
 * Mobile browsers need a few concessions that shape this file:
 *  - They report `confidence === 0` on final results, so the confidence
 *    threshold is only applied when the engine returns a real score.
 *  - Android Chrome ends the session after every utterance no matter what
 *    `continuous` says, so a short session gets restarted from `onend`.
 *  - A recognition object whose `start()` once failed stays unusable, so each
 *    session builds a fresh instance instead of reusing one for the page's life.
 *  - iOS Safari requires a user gesture per session, so it is never restarted
 *    automatically; the hook returns to idle and waits for the next tap.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const CONFIDENCE_THRESHOLD = 0.6;
const MIN_TEXT_LENGTH = 2;
const DEDUP_WINDOW_MS = 500;
const RESTART_DELAY_MS = 250;
// Generous, because it also covers the time the permission prompt is on screen.
const START_TIMEOUT_MS = 10000;
// Stops a restart loop when the engine accepts sessions but never yields speech.
const MAX_SILENT_RESTARTS = 40;

const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
const IS_IOS = /iP(hone|ad|od)/i.test(UA)
    || (/Macintosh/.test(UA) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobile|IEMobile|Opera Mini/i.test(UA);

const ERROR_MESSAGES = {
    'not-allowed': 'Chưa cấp quyền microphone. Hãy kiểm tra cài đặt trình duyệt.',
    'service-not-allowed': 'Trình duyệt đang chặn nhận dạng giọng nói. Hãy cấp quyền microphone.',
    'network': 'Lỗi kết nối mạng. Web Speech API cần internet.',
    'audio-capture': 'Không tìm thấy microphone.',
    'start-timeout': 'Không khởi động được microphone. Kiểm tra quyền micro rồi thử lại.',
    'insecure-context': 'Trang đang chạy qua HTTP nên trình duyệt chặn microphone. Hãy mở bằng HTTPS (hoặc localhost).',
};
const FATAL_ERRORS = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network'];

function getSpeechRecognition() {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Phones reach the dev server by LAN IP, where the constructor still exists but
// the microphone is blocked — the case that looks like "recording but silent".
function isSecureContextAvailable() {
    if (typeof window === 'undefined') return false;
    return window.isSecureContext !== false;
}

export default function useSpeechRecognition({ lang = 'vi-VN', onFinal, onInterim, onError } = {}) {
    const [state, setState] = useState('idle'); // idle | starting | listening | error
    const [isSupported] = useState(() => !!getSpeechRecognition());

    const recognitionRef = useRef(null);
    // What the user asked for, which is not the same as what the engine is doing.
    const wantListeningRef = useRef(false);
    const stateRef = useRef('idle');
    const sessionRef = useRef(0);
    const startTimerRef = useRef(null);
    const restartTimerRef = useRef(null);
    const silentRestartsRef = useRef(0);
    const lastFinalRef = useRef({ text: '', time: 0 });
    const callbacksRef = useRef({ onFinal, onInterim, onError });
    const langRef = useRef(lang);
    const beginSessionRef = useRef(null);

    // Keep callbacks fresh
    useEffect(() => {
        callbacksRef.current = { onFinal, onInterim, onError };
    }, [onFinal, onInterim, onError]);

    useEffect(() => {
        langRef.current = lang;
    }, [lang]);

    const applyState = useCallback((next) => {
        stateRef.current = next;
        setState(next);
    }, []);

    const clearTimers = useCallback(() => {
        clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
    }, []);

    /** Drops the current instance and makes every callback still in flight stale. */
    const teardown = useCallback(() => {
        const rec = recognitionRef.current;
        recognitionRef.current = null;
        sessionRef.current += 1;
        if (!rec) return;
        rec.onstart = null;
        rec.onresult = null;
        rec.onend = null;
        rec.onerror = null;
        rec.onspeechend = null;
        try {
            rec.abort();
        } catch {
            try { rec.stop(); } catch { /* already dead */ }
        }
    }, []);

    const scheduleRestart = useCallback((delay = RESTART_DELAY_MS) => {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
            restartTimerRef.current = null;
            if (wantListeningRef.current) beginSessionRef.current?.();
        }, delay);
    }, []);

    const failFatally = useCallback((code) => {
        wantListeningRef.current = false;
        clearTimers();
        teardown();
        applyState('error');
        callbacksRef.current.onError?.({
            error: code,
            message: ERROR_MESSAGES[code] || `Lỗi: ${code}`,
        });
    }, [applyState, clearTimers, teardown]);

    const beginSession = useCallback(() => {
        const SpeechRecognition = getSpeechRecognition();
        if (!SpeechRecognition) return;

        teardown();
        clearTimers();

        const session = sessionRef.current;
        const rec = new SpeechRecognition();
        recognitionRef.current = rec;
        // Callbacks from an instance we already replaced must not touch state.
        const isStale = () => sessionRef.current !== session || recognitionRef.current !== rec;

        rec.lang = langRef.current;
        // Mobile engines end each utterance regardless of this flag, and asking
        // for continuous there is what leaves the first stop unrecoverable.
        rec.continuous = !IS_MOBILE;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onstart = () => {
            if (isStale()) return;
            clearTimeout(startTimerRef.current);
            startTimerRef.current = null;
            applyState('listening');
        };

        rec.onresult = (event) => {
            if (isStale()) return;

            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const result = event.results[i];
                const alternative = result?.[0];
                if (!alternative) continue;

                const transcript = (alternative.transcript || '').trim();
                if (transcript.length < MIN_TEXT_LENGTH) continue;

                if (!result.isFinal) {
                    silentRestartsRef.current = 0;
                    callbacksRef.current.onInterim?.({ text: transcript });
                    continue;
                }

                // Mobile reports 0 here instead of omitting the score, so a
                // plain threshold check would throw away every phone result.
                const confidence = typeof alternative.confidence === 'number'
                    ? alternative.confidence
                    : 0;
                if (confidence > 0 && confidence < CONFIDENCE_THRESHOLD) continue;

                const now = Date.now();
                if (
                    transcript === lastFinalRef.current.text
                    && now - lastFinalRef.current.time < DEDUP_WINDOW_MS
                ) continue;

                lastFinalRef.current = { text: transcript, time: now };
                silentRestartsRef.current = 0;
                callbacksRef.current.onFinal?.({ text: transcript, confidence, lang: langRef.current });
            }
        };

        rec.onerror = (event) => {
            if (isStale()) return;
            const code = event.error;
            // Both are routine on mobile: onend decides whether to resume.
            if (code === 'no-speech' || code === 'aborted') return;
            if (FATAL_ERRORS.includes(code)) failFatally(code);
        };

        rec.onend = () => {
            if (isStale()) return;
            recognitionRef.current = null;
            clearTimeout(startTimerRef.current);
            startTimerRef.current = null;

            if (!wantListeningRef.current) {
                applyState('idle');
                return;
            }

            // iOS only starts recognition from a real user gesture.
            if (IS_IOS) {
                wantListeningRef.current = false;
                applyState('idle');
                return;
            }

            silentRestartsRef.current += 1;
            if (silentRestartsRef.current > MAX_SILENT_RESTARTS) {
                wantListeningRef.current = false;
                applyState('idle');
                return;
            }

            scheduleRestart();
        };

        try {
            rec.start();
        } catch {
            // The instance is dead now; a fresh one is the only way back.
            teardown();
            if (!wantListeningRef.current) {
                applyState('idle');
                return;
            }
            silentRestartsRef.current += 1;
            if (silentRestartsRef.current > MAX_SILENT_RESTARTS) {
                wantListeningRef.current = false;
                applyState('error');
                callbacksRef.current.onError?.({
                    error: 'start-failed',
                    message: ERROR_MESSAGES['start-timeout'],
                });
                return;
            }
            scheduleRestart(RESTART_DELAY_MS * 2);
            return;
        }

        // Without this the UI could sit on "listening" forever while the engine
        // never actually opened the mic — the state the old code got stuck in.
        startTimerRef.current = setTimeout(() => {
            startTimerRef.current = null;
            if (isStale() || stateRef.current === 'listening') return;
            teardown();
            if (wantListeningRef.current) failFatally('start-timeout');
            else applyState('idle');
        }, START_TIMEOUT_MS);
    }, [applyState, clearTimers, failFatally, scheduleRestart, teardown]);

    useEffect(() => {
        beginSessionRef.current = beginSession;
    }, [beginSession]);

    const start = useCallback(() => {
        if (!getSpeechRecognition()) return;
        if (!isSecureContextAvailable()) {
            failFatally('insecure-context');
            return;
        }
        wantListeningRef.current = true;
        silentRestartsRef.current = 0;
        lastFinalRef.current = { text: '', time: 0 };
        applyState('starting');
        beginSession();
    }, [applyState, beginSession, failFatally]);

    const stop = useCallback(() => {
        wantListeningRef.current = false;
        clearTimers();
        teardown();
        applyState('idle');
    }, [applyState, clearTimers, teardown]);

    // Reads intent from refs so a tap is never judged against a stale render.
    const toggle = useCallback(() => {
        if (wantListeningRef.current || stateRef.current === 'listening' || stateRef.current === 'starting') {
            stop();
        } else {
            start();
        }
    }, [start, stop]);

    useEffect(() => () => {
        wantListeningRef.current = false;
        clearTimers();
        teardown();
    }, [clearTimers, teardown]);

    return { state, isSupported, isMobile: IS_MOBILE, start, stop, toggle };
}
