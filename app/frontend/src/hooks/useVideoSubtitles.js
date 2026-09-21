/**
 * useVideoSubtitles.js
 * Get a video's spoken text as timed cues, and turn every cue into a sign
 * sequence ahead of the playhead.
 *
 * Translating a cue at the moment it appears would always be late — the parse
 * is a network round trip and often a Gemini call. So the whole transcript is
 * converted in the background, in order, starting from the first line: by the
 * time the viewer has watched the opening seconds the avatar is already several
 * lines ahead. Seeking past the translated region falls back to a single
 * on-demand parse for the line that is actually needed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// Small enough that the opening lines land quickly, large enough that a long
// transcript does not turn into a hundred round trips.
const CHUNK_SIZE = 25;

/* ── Local subtitle file parsing ───────────────────────────────────────────── */

function timeToSeconds(stamp) {
    // Accepts 00:01:02,500 / 00:01:02.500 / 01:02.500
    const clean = stamp.trim().replace(',', '.');
    const parts = clean.split(':').map(Number);
    if (parts.some(Number.isNaN)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Parse an .srt or .vtt file body into cues. */
export function parseSubtitleFile(text) {
    const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
    const cues = [];
    const timing = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

    for (let i = 0; i < lines.length; i += 1) {
        if (!timing.test(lines[i])) continue;
        const [rawStart, rawEnd] = lines[i].split('-->');
        const start = timeToSeconds(rawStart);
        // A cue line can carry positioning settings after the end stamp.
        const end = timeToSeconds(rawEnd.trim().split(/\s+/)[0]);
        if (start === null || end === null) continue;

        const body = [];
        i += 1;
        while (i < lines.length && lines[i].trim()) {
            body.push(lines[i].replace(/<[^>]+>/g, ''));
            i += 1;
        }
        const content = body.join(' ').replace(/\s+/g, ' ').trim();
        if (content) cues.push({ start, end, text: content });
    }
    return cues;
}

/* ── Hook ──────────────────────────────────────────────────────────────────── */

export default function useVideoSubtitles() {
    const [status, setStatus] = useState('idle'); // idle | loading | ready | error
    const [error, setError] = useState('');
    const [meta, setMeta] = useState(null);
    const [cues, setCues] = useState([]);
    const [signs, setSigns] = useState([]);       // aligned with cues, null until parsed
    const [translatedCount, setTranslatedCount] = useState(0);

    // Bumped on every new load so results from an abandoned video are dropped.
    const runRef = useRef(0);
    const signsRef = useRef([]);
    const pendingRef = useRef(new Set());

    useEffect(() => () => { runRef.current += 1; }, []);

    const commitSigns = useCallback((next) => {
        signsRef.current = next;
        setSigns(next.slice());
        setTranslatedCount(next.reduce((n, item) => n + (item ? 1 : 0), 0));
    }, []);

    /** Convert every cue to signs, in order, without blocking the caller. */
    const translateAll = useCallback(async (cueList, runId) => {
        for (let i = 0; i < cueList.length; i += CHUNK_SIZE) {
            if (runRef.current !== runId) return;
            const chunk = cueList.slice(i, i + CHUNK_SIZE);

            try {
                const response = await fetch('/api/text-to-signs/batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ texts: chunk.map(c => c.text), use_llm: true }),
                });
                if (runRef.current !== runId) return;
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (runRef.current !== runId) return;

                // Merged into whatever is current rather than into a private
                // copy: a line the viewer seeked to was parsed on demand while
                // this chunk was in flight, and writing a stale array back
                // would silently drop it.
                const next = signsRef.current.slice();
                (data.results || []).forEach((result, j) => {
                    if (!next[i + j]) next[i + j] = result;
                });
                commitSigns(next);
            } catch (err) {
                console.warn('[subtitles] batch translate failed:', err);
                // One bad chunk should not stop the rest of the transcript;
                // those lines stay null and get an on-demand parse if reached.
            }
        }
    }, [commitSigns]);

    /** Parse a single cue now, for a viewer who seeked past the prefetch. */
    const ensureTranslated = useCallback(async (index) => {
        const runId = runRef.current;
        const list = signsRef.current;
        if (!list || index < 0 || index >= list.length) return null;
        if (list[index]) return list[index];
        if (pendingRef.current.has(index)) return null;

        const cue = cues[index];
        if (!cue?.text) return null;

        pendingRef.current.add(index);
        try {
            const response = await fetch('/api/text-to-signs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cue.text, use_llm: true }),
            });
            if (!response.ok || runRef.current !== runId) return null;
            const data = await response.json();
            if (runRef.current !== runId) return null;
            const next = signsRef.current.slice();
            next[index] = data;
            commitSigns(next);
            return data;
        } catch (err) {
            console.warn('[subtitles] on-demand translate failed:', err);
            return null;
        } finally {
            pendingRef.current.delete(index);
        }
    }, [cues, commitSigns]);

    const startRun = useCallback(() => {
        runRef.current += 1;
        pendingRef.current.clear();
        signsRef.current = [];
        setSigns([]);
        setTranslatedCount(0);
        setError('');
        return runRef.current;
    }, []);

    const applyCues = useCallback((cueList, metaData, runId) => {
        setCues(cueList);
        setMeta(metaData);
        setStatus('ready');
        commitSigns(new Array(cueList.length).fill(null));
        translateAll(cueList, runId);
    }, [commitSigns, translateAll]);

    /** Ask the backend for the platform's own caption track. */
    const loadFromUrl = useCallback(async (url, lang) => {
        const runId = startRun();
        setStatus('loading');
        setCues([]);
        setMeta(null);

        try {
            const response = await fetch('/api/video/subtitles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, lang: lang || null }),
            });
            const data = await response.json().catch(() => ({}));
            if (runRef.current !== runId) return null;

            if (!response.ok) {
                setStatus('error');
                setError(data.detail || `Không lấy được phụ đề (HTTP ${response.status})`);
                return null;
            }
            if (!data.cues?.length) {
                setStatus('error');
                setError('Video này không có phụ đề đọc được.');
                return null;
            }

            applyCues(data.cues, data, runId);
            return data;
        } catch (err) {
            if (runRef.current !== runId) return null;
            setStatus('error');
            setError(err.message || 'Lỗi kết nối server');
            return null;
        }
    }, [applyCues, startRun]);

    /** Use a subtitle file the viewer supplied instead. */
    const loadFromFile = useCallback(async (file) => {
        const runId = startRun();
        setStatus('loading');
        setCues([]);
        setMeta(null);

        try {
            const text = await file.text();
            if (runRef.current !== runId) return null;
            const parsed = parseSubtitleFile(text);
            if (!parsed.length) {
                setStatus('error');
                setError('Không đọc được file phụ đề. Cần file .srt hoặc .vtt hợp lệ.');
                return null;
            }
            const metaData = { title: file.name, lang: 'local', origin: 'file', available: [] };
            applyCues(parsed, metaData, runId);
            return metaData;
        } catch (err) {
            if (runRef.current !== runId) return null;
            setStatus('error');
            setError(err.message || 'Không đọc được file');
            return null;
        }
    }, [applyCues, startRun]);

    const reset = useCallback(() => {
        runRef.current += 1;
        pendingRef.current.clear();
        signsRef.current = [];
        setStatus('idle');
        setError('');
        setMeta(null);
        setCues([]);
        setSigns([]);
        setTranslatedCount(0);
    }, []);

    return {
        status, error, meta, cues, signs, translatedCount,
        loadFromUrl, loadFromFile, ensureTranslated, reset,
    };
}

/**
 * Index of the cue covering `time`, or -1 in a gap between cues.
 * Cues are sorted, so a binary search keeps this free to call every tick.
 */
export function findCueIndex(cues, time) {
    let low = 0;
    let high = cues.length - 1;
    let candidate = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        if (cues[mid].start <= time) {
            candidate = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    if (candidate < 0) return -1;
    // A caption stays on screen until the next one starts, so a viewer pausing
    // mid-gap still sees the line that was being spoken.
    const next = cues[candidate + 1];
    const until = next ? Math.max(cues[candidate].end, next.start) : cues[candidate].end + 2;
    return time <= until ? candidate : -1;
}
