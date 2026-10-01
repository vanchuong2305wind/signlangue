/**
 * whisperRecorder.js
 * Offline microphone path: records utterances and sends each one to the
 * backend's Whisper model (/api/speech/transcribe).
 *
 * Used by useSpeechRecognition only when the browser's speech engine cannot
 * run — it needs an internet connection to its vendor's servers, and some
 * browsers do not ship one at all. Whisper has no streaming results, so an
 * utterance is cut at a pause and transcribed as a whole.
 */

const LEVEL_POLL_MS = 100;
// A pause this long ends an utterance.
const END_SILENCE_MS = 900;
// Long monologues are cut so the first words do not wait for the last.
const MAX_UTTERANCE_MS = 15000;
// Utterances shorter than this are coughs and clicks, not speech.
const MIN_SPEECH_MS = 300;
// Silence is recorded too, so the recorder is recycled while nobody speaks
// instead of growing an ever-longer blob of nothing.
const IDLE_RECYCLE_MS = 8000;
const MIN_LEVEL = 0.015;

function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return types.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}

export function isWhisperRecordingSupported() {
    return typeof window !== 'undefined'
        && typeof MediaRecorder !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Starts listening. Returns a controller whose stop() flushes the utterance in
 * progress, then releases the microphone.
 */
export async function startWhisperSession({ lang = 'vi-VN', onListening, onFinal, onError }) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const mimeType = pickMimeType();
    let recorder = null;
    let recorderStartedAt = 0;
    let speechStartedAt = 0;
    let lastVoiceAt = 0;
    let noiseFloor = MIN_LEVEL / 3;
    let stopped = false;
    let pollTimer = null;

    const send = async (blob) => {
        try {
            const response = await fetch(`/api/speech/transcribe?lang=${encodeURIComponent(lang)}`, {
                method: 'POST',
                headers: { 'Content-Type': blob.type || 'application/octet-stream' },
                body: blob,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
            const text = (data.text || '').trim();
            if (text.length >= 2) onFinal?.({ text, confidence: 1, lang });
        } catch (error) {
            console.warn('[speech] offline transcription failed:', error);
            onError?.(error);
        }
    };

    const startRecorder = () => {
        // Each recorder owns its chunk list: the last chunk of a stopped one
        // arrives after its successor has already started.
        const ownChunks = [];
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorder.chunks = ownChunks;
        recorder.ondataavailable = (event) => {
            if (event.data?.size) ownChunks.push(event.data);
        };
        recorder.start();
        recorderStartedAt = performance.now();
        speechStartedAt = 0;
    };

    /** Ends the current recording; sends it when it held speech. */
    const cutRecorder = (keepGoing) => {
        const current = recorder;
        if (!current || current.state === 'inactive') return;
        const hadSpeech = speechStartedAt > 0 && lastVoiceAt - speechStartedAt >= MIN_SPEECH_MS;
        const ownChunks = current.chunks;
        current.onstop = () => {
            if (hadSpeech && ownChunks.length) {
                send(new Blob(ownChunks, { type: current.mimeType || mimeType || 'audio/webm' }));
            }
        };
        current.stop();
        recorder = null;
        if (keepGoing && !stopped) startRecorder();
    };

    const poll = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
        const level = Math.sqrt(sum / samples.length);
        const now = performance.now();

        const threshold = Math.max(MIN_LEVEL, noiseFloor * 3);
        if (level > threshold) {
            if (!speechStartedAt) speechStartedAt = now;
            lastVoiceAt = now;
        } else if (!speechStartedAt) {
            // Tracks the room's background level only while nobody speaks.
            noiseFloor = noiseFloor * 0.95 + level * 0.05;
        }

        if (speechStartedAt) {
            if (now - lastVoiceAt > END_SILENCE_MS || now - speechStartedAt > MAX_UTTERANCE_MS) {
                cutRecorder(true);
            }
        } else if (now - recorderStartedAt > IDLE_RECYCLE_MS) {
            cutRecorder(true);
        }
    };

    startRecorder();
    pollTimer = setInterval(poll, LEVEL_POLL_MS);
    onListening?.();

    return {
        stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(pollTimer);
            cutRecorder(false);
            stream.getTracks().forEach(track => track.stop());
            audioContext.close().catch(() => {});
        },
    };
}
