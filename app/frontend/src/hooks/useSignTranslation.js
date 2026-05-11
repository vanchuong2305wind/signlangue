/**
 * useSignTranslation.js
 * Hook to convert text → sign sequence via backend API
 * and map results to sign videos from sign_videos.json
 */

import { useState, useCallback, useRef } from 'react';

export default function useSignTranslation() {
    const [isLoading, setIsLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const queueRef = useRef([]);
    const processingRef = useRef(false);

    const translate = useCallback(async (text) => {
        if (!text?.trim()) return null;

        setIsLoading(true);
        setError(null);

        try {
            const response = await fetch('/api/text-to-signs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text.trim(), use_llm: true }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || `API error: ${response.status}`);
            }

            const data = await response.json();
            setResult(data);
            return data;
        } catch (err) {
            const msg = err.message || 'Lỗi kết nối server';
            setError(msg);
            return null;
        } finally {
            setIsLoading(false);
        }
    }, []);

    const enqueue = useCallback(async (text) => {
        queueRef.current.push(text);
        if (processingRef.current) return;

        processingRef.current = true;
        while (queueRef.current.length > 0) {
            const t = queueRef.current.shift();
            await translate(t);
        }
        processingRef.current = false;
    }, [translate]);

    const clear = useCallback(() => {
        setResult(null);
        setError(null);
        queueRef.current = [];
    }, []);

    return { isLoading, result, error, translate, enqueue, clear };
}
