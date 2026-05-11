/**
 * useSpeechRecognition.js
 * React hook wrapping Web Speech API.
 * Ported from app/js/speech-engine.js + noise-filter.js
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const CONFIDENCE_THRESHOLD = 0.6;
const MIN_TEXT_LENGTH = 2;
const SILENCE_TIMEOUT_MS = 3000;
const DEDUP_WINDOW_MS = 500;

export default function useSpeechRecognition({ lang = 'vi-VN', onFinal, onInterim, onError } = {}) {
    const [state, setState] = useState('idle'); // idle | listening | error
    const [isSupported, setIsSupported] = useState(false);

    const recognitionRef = useRef(null);
    const intentionallyStoppedRef = useRef(true);
    const silenceTimerRef = useRef(null);
    const lastFinalRef = useRef({ text: '', time: 0 });
    const callbacksRef = useRef({ onFinal, onInterim, onError });

    // Keep callbacks fresh
    useEffect(() => {
        callbacksRef.current = { onFinal, onInterim, onError };
    }, [onFinal, onInterim, onError]);

    // Initialize recognition
    useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setIsSupported(false);
            return;
        }

        setIsSupported(true);
        const rec = new SpeechRecognition();
        rec.lang = lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onstart = () => {
            setState('listening');
            resetSilenceTimer();
        };

        rec.onresult = (event) => {
            const idx = event.resultIndex;
            const result = event.results[idx];
            const transcript = result[0].transcript.trim();
            const confidence = result[0].confidence ?? 1.0;
            const isFinal = result.isFinal;

            resetSilenceTimer();

            // Filter: too short
            if (transcript.length < MIN_TEXT_LENGTH) return;

            // Filter: low confidence final
            if (isFinal && confidence < CONFIDENCE_THRESHOLD) return;

            // Filter: duplicate
            if (isFinal) {
                const now = Date.now();
                if (
                    transcript === lastFinalRef.current.text &&
                    now - lastFinalRef.current.time < DEDUP_WINDOW_MS
                ) return;
                lastFinalRef.current = { text: transcript, time: now };
                callbacksRef.current.onFinal?.({ text: transcript, confidence, lang });
            } else {
                callbacksRef.current.onInterim?.({ text: transcript });
            }

            startSilenceTimer();
        };

        rec.onend = () => {
            if (!intentionallyStoppedRef.current) {
                setTimeout(() => {
                    if (!intentionallyStoppedRef.current && recognitionRef.current) {
                        try { recognitionRef.current.start(); } catch (e) { /* ignore */ }
                    }
                }, 200);
            } else {
                setState('idle');
            }
        };

        rec.onerror = (event) => {
            const errorMap = {
                'not-allowed': 'Chưa cấp quyền microphone. Hãy kiểm tra cài đặt trình duyệt.',
                'network': 'Lỗi kết nối mạng. Web Speech API cần internet.',
                'audio-capture': 'Không tìm thấy microphone.',
            };

            if (['not-allowed', 'audio-capture', 'network'].includes(event.error)) {
                intentionallyStoppedRef.current = true;
                setState('error');
                callbacksRef.current.onError?.({
                    error: event.error,
                    message: errorMap[event.error] || `Lỗi: ${event.error}`,
                });
                try { rec.stop(); } catch (e) { /* ignore */ }
            }
        };

        rec.onspeechend = () => {
            startSilenceTimer();
        };

        recognitionRef.current = rec;

        return () => {
            intentionallyStoppedRef.current = true;
            clearTimeout(silenceTimerRef.current);
            try { rec.stop(); } catch (e) { /* ignore */ }
        };
    }, [lang]);

    function resetSilenceTimer() {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
    }

    function startSilenceTimer() {
        resetSilenceTimer();
        silenceTimerRef.current = setTimeout(() => {
            // Silence detected - could auto stop or just notify
        }, SILENCE_TIMEOUT_MS);
    }

    const start = useCallback(() => {
        if (!recognitionRef.current) return;
        intentionallyStoppedRef.current = false;
        lastFinalRef.current = { text: '', time: 0 };
        try {
            recognitionRef.current.start();
        } catch (err) {
            try { recognitionRef.current.stop(); } catch (e) { /* ignore */ }
            setTimeout(() => {
                if (!intentionallyStoppedRef.current) {
                    try { recognitionRef.current.start(); } catch (e) { /* ignore */ }
                }
            }, 200);
        }
    }, []);

    const stop = useCallback(() => {
        if (!recognitionRef.current) return;
        intentionallyStoppedRef.current = true;
        resetSilenceTimer();
        setState('idle');
        try { recognitionRef.current.stop(); } catch (e) { /* ignore */ }
    }, []);

    const toggle = useCallback(() => {
        if (state === 'listening') stop();
        else start();
    }, [state, start, stop]);

    return { state, isSupported, start, stop, toggle };
}
