import { useCallback, useEffect, useRef, useState } from 'react';
import GlassCard from '../components/ui/GlassCard';
import useStudyTimer from '../hooks/useStudyTimer';
import './Camera.css';

const CAPTURE_INTERVAL_MS = 125;
const PRE_ROLL_FRAMES = 4;
const MIN_SEGMENT_FRAMES = 12;
const MAX_SEGMENT_FRAMES = 44;
const QUIET_TICKS_TO_CLOSE = 3;
const MOTION_SAMPLE_WIDTH = 64;
const MOTION_SAMPLE_HEIGHT = 48;
const MOTION_GRID_COLS = 8;
const MOTION_GRID_ROWS = 6;
const MOTION_BLOCK_WIDTH = MOTION_SAMPLE_WIDTH / MOTION_GRID_COLS;
const MOTION_BLOCK_HEIGHT = MOTION_SAMPLE_HEIGHT / MOTION_GRID_ROWS;
// Motion score = mean abs RGB diff (0-255) inside the most-changed grid block, not the
// whole frame — a small localized gesture (hand near the face) moves few pixels overall,
// so averaging over the full frame drowns it out against the static background/body.
// Tuned for typical webcam noise/lighting; may need retuning per deployment.
const MOTION_START_THRESHOLD = 14;
const MOTION_STOP_THRESHOLD = 7;
// A short guard after a segment closes naturally (hand went quiet): the hand settling/
// dropping can wobble past MOTION_START_THRESHOLD again and either bleed into the next
// word's pre-roll or falsely start a new segment. Skip capture for a couple of ticks.
const COOLDOWN_TICKS_AFTER_SEGMENT = 2;
// A raw top-1 confidence bar alone still lets ambiguous/merged-gesture guesses through
// (0.2 was too permissive). Also require a clear gap over the runner-up so a prediction
// the model itself is unsure about doesn't get written into the sentence.
const WORD_CONFIDENCE_THRESHOLD = 0.45;
const WORD_MARGIN_THRESHOLD = 0.12;

function apiError(data, fallback) {
    return typeof data?.detail === 'string' ? data.detail : fallback;
}

export default function CameraPage() {
    useStudyTimer('Nhận diện camera');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const captureAbortRef = useRef(false);
    const segmentFramesRef = useRef([]);
    const preRollRef = useRef([]);
    const segmentActiveRef = useRef(false);
    const quietStreakRef = useRef(0);
    const cooldownTicksRef = useRef(0);
    const prevMotionFrameRef = useRef(null);
    const recognitionQueueRef = useRef([]);
    const recognitionSessionRef = useRef(0);
    const processRecognitionQueueRef = useRef(null);
    const inferenceBusyRef = useRef(false);
    const lastPredictionRef = useRef({ label: '', time: 0 });
    const [cameraOn, setCameraOn] = useState(false);
    const [facingMode, setFacingMode] = useState('user');
    const [phase, setPhase] = useState('idle');
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [sentence, setSentence] = useState([]);
    const [aiSentence, setAiSentence] = useState('');
    const [buildingSentence, setBuildingSentence] = useState(false);
    const [liveTranslation, setLiveTranslation] = useState(false);
    const [modelReady, setModelReady] = useState(true);

    const stopStream = useCallback(() => {
        captureAbortRef.current = true;
        recognitionSessionRef.current += 1;
        recognitionQueueRef.current = [];
        segmentFramesRef.current = [];
        preRollRef.current = [];
        segmentActiveRef.current = false;
        quietStreakRef.current = 0;
        cooldownTicksRef.current = 0;
        prevMotionFrameRef.current = null;
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraOn(false);
        setLiveTranslation(false);
        setPhase('idle');
        setProgress(0);
    }, []);

    const startCamera = useCallback(async (mode = facingMode) => {
        stopStream();
        setError('');
        captureAbortRef.current = false;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: mode },
                    width: { ideal: 960 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 24, max: 30 },
                },
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setFacingMode(mode);
            setCameraOn(true);
        } catch (cameraError) {
            setError(cameraError.name === 'NotAllowedError'
                ? 'Bạn cần cho phép trình duyệt sử dụng camera.'
                : 'Không mở được camera. Hãy kiểm tra thiết bị và thử lại.');
        }
    }, [facingMode, stopStream]);

    useEffect(() => {
        fetch('/api/camera/model-status')
            .then(response => response.json())
            .then(data => setModelReady(Boolean(data.available)))
            .catch(() => setModelReady(false));
        const startTimer = window.setTimeout(() => startCamera(), 0);
        return () => {
            window.clearTimeout(startTimer);
            stopStream();
        };
        // Camera chỉ khởi tạo và giải phóng một lần khi vào/rời trang.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const switchCamera = async () => {
        if (phase !== 'idle') return;
        await startCamera(facingMode === 'user' ? 'environment' : 'user');
    };

    const processRecognitionQueue = useCallback(async () => {
        if (inferenceBusyRef.current) return;
        const job = recognitionQueueRef.current.shift();
        if (!job) {
            setPhase('idle');
            return;
        }

        inferenceBusyRef.current = true;
        setPhase('processing');
        try {
            const response = await fetch('/api/camera/recognize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frames: job.frames, top_k: 3 }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(apiError(data, 'Model không thể nhận diện clip này.'));
            if (job.session !== recognitionSessionRef.current) return;
            setResult(data);
            const now = Date.now();
            const isDuplicate = (
                lastPredictionRef.current.label === data.prediction.label
                && now - lastPredictionRef.current.time < 6500
            );
            const runnerUpConfidence = data.alternatives?.[0]?.confidence ?? 0;
            const isConfident = (
                data.prediction.confidence >= WORD_CONFIDENCE_THRESHOLD
                && data.prediction.confidence - runnerUpConfidence >= WORD_MARGIN_THRESHOLD
            );
            if (!isDuplicate && isConfident) {
                const rawWord = data.prediction.vietnamese || data.prediction.label;
                const word = rawWord.split('/')[0].trim();
                setSentence(current => [...current, {
                    word,
                    label: data.prediction.label,
                    confidence: data.prediction.confidence,
                }]);
                setAiSentence('');
                lastPredictionRef.current = { label: data.prediction.label, time: now };
            }
            fetch('/api/profile/activities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'recognition',
                    label: data.prediction.vietnamese || data.prediction.label,
                    metadata: { confidence: data.prediction.confidence },
                }),
            }).catch(() => {});
        } catch (recognitionError) {
            if (job.session === recognitionSessionRef.current) {
                setError(recognitionError.message || 'Không kết nối được với model nhận diện.');
            }
        } finally {
            inferenceBusyRef.current = false;
            if (recognitionQueueRef.current.length > 0) {
                queueMicrotask(() => processRecognitionQueueRef.current?.());
            } else {
                setPhase('idle');
            }
        }
    }, []);

    useEffect(() => {
        processRecognitionQueueRef.current = processRecognitionQueue;
        return () => {
            processRecognitionQueueRef.current = null;
        };
    }, [processRecognitionQueue]);

    const enqueueRecognition = useCallback((frames) => {
        if (frames.length < MIN_SEGMENT_FRAMES) return;

        // Thu hình và nhận diện chạy độc lập. Giữ FIFO để mọi clip đã thu
        // đều tiếp tục được xử lý, kể cả sau khi người dùng bấm Dừng dịch.
        recognitionQueueRef.current.push({
            frames,
            session: recognitionSessionRef.current,
        });
        processRecognitionQueueRef.current?.();
    }, []);

    useEffect(() => {
        if (!liveTranslation || !cameraOn) return undefined;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext('2d', { alpha: false });

        const motionCanvas = document.createElement('canvas');
        motionCanvas.width = MOTION_SAMPLE_WIDTH;
        motionCanvas.height = MOTION_SAMPLE_HEIGHT;
        const motionContext = motionCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

        segmentFramesRef.current = [];
        preRollRef.current = [];
        segmentActiveRef.current = false;
        quietStreakRef.current = 0;
        cooldownTicksRef.current = 0;
        prevMotionFrameRef.current = null;

        const closeSegment = (naturalPause) => {
            const frames = segmentFramesRef.current;
            segmentFramesRef.current = [];
            segmentActiveRef.current = false;
            quietStreakRef.current = 0;
            // Only cooldown after a natural pause (hand settling to rest) — a forced
            // cutoff means the hand is still actively moving, so resume capture right away.
            cooldownTicksRef.current = naturalPause ? COOLDOWN_TICKS_AFTER_SEGMENT : 0;
            setProgress(0);
            enqueueRecognition(frames);
        };

        const captureTimer = window.setInterval(() => {
            const video = videoRef.current;
            if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = canvas.toDataURL('image/jpeg', 0.68);

            motionContext.drawImage(video, 0, 0, motionCanvas.width, motionCanvas.height);
            const pixels = motionContext.getImageData(0, 0, motionCanvas.width, motionCanvas.height).data;
            const previous = prevMotionFrameRef.current;
            let motionScore = 0;
            if (previous) {
                const blockSums = new Float64Array(MOTION_GRID_COLS * MOTION_GRID_ROWS);
                for (let i = 0; i < pixels.length; i += 4) {
                    const pixelIndex = i / 4;
                    const x = pixelIndex % motionCanvas.width;
                    const y = (pixelIndex / motionCanvas.width) | 0;
                    const blockIndex = ((y / MOTION_BLOCK_HEIGHT) | 0) * MOTION_GRID_COLS + ((x / MOTION_BLOCK_WIDTH) | 0);
                    blockSums[blockIndex] += Math.abs(pixels[i] - previous[i])
                        + Math.abs(pixels[i + 1] - previous[i + 1])
                        + Math.abs(pixels[i + 2] - previous[i + 2]);
                }
                const pixelsPerBlock = MOTION_BLOCK_WIDTH * MOTION_BLOCK_HEIGHT * 3;
                for (let b = 0; b < blockSums.length; b++) {
                    const blockScore = blockSums[b] / pixelsPerBlock;
                    if (blockScore > motionScore) motionScore = blockScore;
                }
            }
            prevMotionFrameRef.current = pixels;

            if (!segmentActiveRef.current) {
                if (cooldownTicksRef.current > 0) {
                    cooldownTicksRef.current -= 1;
                    setProgress(0);
                    return;
                }
                preRollRef.current.push(frame);
                if (preRollRef.current.length > PRE_ROLL_FRAMES) {
                    preRollRef.current.shift();
                }
                if (motionScore > MOTION_START_THRESHOLD) {
                    segmentActiveRef.current = true;
                    quietStreakRef.current = 0;
                    segmentFramesRef.current = [...preRollRef.current];
                    preRollRef.current = [];
                }
                setProgress(0);
                return;
            }

            segmentFramesRef.current.push(frame);
            quietStreakRef.current = motionScore < MOTION_STOP_THRESHOLD ? quietStreakRef.current + 1 : 0;
            setProgress(Math.round((segmentFramesRef.current.length / MAX_SEGMENT_FRAMES) * 100));

            if (quietStreakRef.current >= QUIET_TICKS_TO_CLOSE) {
                closeSegment(true);
            } else if (segmentFramesRef.current.length >= MAX_SEGMENT_FRAMES) {
                closeSegment(false);
            }
        }, CAPTURE_INTERVAL_MS);

        return () => {
            window.clearInterval(captureTimer);
            segmentFramesRef.current = [];
            preRollRef.current = [];
            segmentActiveRef.current = false;
            quietStreakRef.current = 0;
            cooldownTicksRef.current = 0;
            prevMotionFrameRef.current = null;
            setProgress(0);
        };
    }, [cameraOn, enqueueRecognition, liveTranslation]);

    const toggleLiveTranslation = () => {
        if (!liveTranslation) {
            setError('');
            lastPredictionRef.current = { label: '', time: 0 };
            segmentFramesRef.current = [];
            preRollRef.current = [];
            segmentActiveRef.current = false;
            quietStreakRef.current = 0;
            cooldownTicksRef.current = 0;
            prevMotionFrameRef.current = null;
        }
        setLiveTranslation(current => !current);
    };

    const prediction = result?.prediction;
    const confidence = prediction ? Math.round(prediction.confidence * 100) : 0;
    const sentenceText = sentence.map(item => item.word).join(' ');

    const speakSentence = () => {
        const text = aiSentence || sentenceText;
        if (!text || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'vi-VN';
        window.speechSynthesis.speak(utterance);
    };

    const copySentence = async () => {
        const text = aiSentence || sentenceText;
        if (!text) return;
        await navigator.clipboard.writeText(text);
    };

    const buildMeaningfulSentence = async () => {
        if (!sentence.length || buildingSentence) return;
        setBuildingSentence(true);
        setError('');
        try {
            const response = await fetch('/api/camera/build-sentence', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ words: sentence.map(item => item.word) }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(apiError(data, 'Không thể tạo câu bằng Gemini.'));
            setAiSentence(data.sentence);
        } catch (buildError) {
            setError(buildError.message || 'Không kết nối được với Gemini.');
        } finally {
            setBuildingSentence(false);
        }
    };

    return (
        <div className="camera animate-fade-in">
            <section className="camera__stage" aria-label="Khung camera nhận diện">
                <video
                    ref={videoRef}
                    className="camera__video"
                    autoPlay
                    muted
                    playsInline
                />
                {!cameraOn && (
                    <div className="camera__placeholder">
                        <i className="fa-solid fa-video-slash" />
                        <span>Camera đang tắt</span>
                    </div>
                )}
                <div className={`camera__live ${cameraOn ? '' : 'camera__live--off'}`}>
                    <span /> {cameraOn ? 'Sẵn sàng' : 'Đã tắt'}
                </div>
                {liveTranslation && (
                    <div className="camera__countdown">
                        <strong>
                            {phase === 'processing' ? (
                                <><i className="fa-solid fa-spinner fa-spin" /> Đang nhận diện ký hiệu...</>
                            ) : (
                                <><i className="fa-solid fa-circle camera__record-dot" /> Đang dịch liên tục</>
                            )}
                        </strong>
                        <span>Camera luôn hoạt động — hãy tiếp tục với ký hiệu tiếp theo</span>
                        <div className="camera__progress"><i style={{ width: `${progress}%` }} /></div>
                    </div>
                )}
            </section>

            <div className="camera__controls">
                {cameraOn ? (
                    <>
                        <button className={`camera__btn ${liveTranslation ? 'camera__btn--stop' : 'camera__btn--primary'}`} onClick={toggleLiveTranslation} disabled={!modelReady}>
                            <i className={`fa-solid ${liveTranslation ? 'fa-stop' : 'fa-play'}`} />
                            {liveTranslation ? 'Dừng dịch' : 'Bắt đầu dịch liên tục'}
                        </button>
                        <button className="camera__btn camera__btn--icon" onClick={switchCamera} disabled={liveTranslation || phase !== 'idle'} title="Đổi camera">
                            <i className="fa-solid fa-camera-rotate" />
                        </button>
                        <button className="camera__btn camera__btn--quiet" onClick={stopStream} disabled={liveTranslation || phase !== 'idle'}>
                            <i className="fa-solid fa-power-off" /> Tắt
                        </button>
                    </>
                ) : (
                    <button className="camera__btn camera__btn--primary" onClick={() => startCamera()}>
                        <i className="fa-solid fa-video" /> Bật camera
                    </button>
                )}
            </div>

            {(error || !modelReady) && (
                <div className="camera__message camera__message--error" role="alert">
                    <i className="fa-solid fa-triangle-exclamation" />
                    {error || 'Không tìm thấy model WLASL100. Kiểm tra lại thư mục train.'}
                </div>
            )}

            <GlassCard padding="none">
                <div className="camera__sentence">
                    <div className="camera__sentence-heading">
                        <div>
                            <span>Câu đang dịch</span>
                            <strong>{sentenceText || 'Thực hiện ký hiệu đầu tiên để bắt đầu câu'}</strong>
                        </div>
                        <div className="camera__sentence-actions">
                            <button
                                type="button"
                                onClick={() => {
                                    setSentence(current => current.slice(0, -1));
                                    setAiSentence('');
                                }}
                                disabled={!sentence.length || liveTranslation}
                                title="Bỏ từ cuối"
                            >
                                <i className="fa-solid fa-rotate-left" />
                            </button>
                            <button type="button" onClick={copySentence} disabled={!sentence.length} title="Sao chép câu">
                                <i className="fa-solid fa-copy" />
                            </button>
                            <button type="button" onClick={speakSentence} disabled={!sentence.length} title="Đọc câu">
                                <i className="fa-solid fa-volume-high" />
                            </button>
                            <button type="button" onClick={() => {
                                setSentence([]);
                                setAiSentence('');
                            }} disabled={!sentence.length || liveTranslation} title="Xóa câu">
                                <i className="fa-solid fa-trash" />
                            </button>
                        </div>
                    </div>
                    {sentence.length > 0 && (
                        <div className="camera__tokens">
                            {sentence.map((item, index) => (
                                <span className="camera__token" key={`${item.label}-${index}`}>
                                    {item.word}
                                    <small>{Math.round(item.confidence * 100)}%</small>
                                </span>
                            ))}
                        </div>
                    )}
                    {sentence.length > 0 && (
                        <div className="camera__gemini">
                            <button
                                type="button"
                                className="camera__gemini-btn"
                                onClick={buildMeaningfulSentence}
                                disabled={buildingSentence || liveTranslation}
                            >
                                <i className={`fa-solid ${buildingSentence ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`} />
                                {buildingSentence ? 'Gemini đang viết câu...' : 'Tạo câu có nghĩa bằng Gemini'}
                            </button>
                            {aiSentence && (
                                <div className="camera__gemini-result">
                                    <span><i className="fa-solid fa-wand-magic-sparkles" /> Câu đề xuất</span>
                                    <strong>{aiSentence}</strong>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div className="camera__result">
                    <div className="camera__result-icon"><i className="fa-solid fa-hands-asl-interpreting" /></div>
                    <div className="camera__result-main">
                        <span>Kết quả nhận diện</span>
                        <strong>{prediction?.vietnamese || prediction?.label || 'Chưa có kết quả'}</strong>
                        {prediction?.vietnamese && <small>Nhãn ASL: {prediction.label}</small>}
                    </div>
                    {prediction && (
                        <div className="camera__confidence">
                            <strong>{confidence}%</strong>
                            <span>độ tin cậy</span>
                        </div>
                    )}
                </div>
                {result?.alternatives?.length > 0 && (
                    <div className="camera__alternatives">
                        <span>Có thể là:</span>
                        {result.alternatives.map(item => (
                            <span key={item.label} className="camera__alternative">
                                {item.vietnamese || item.label} · {Math.round(item.confidence * 100)}%
                            </span>
                        ))}
                    </div>
                )}
            </GlassCard>

            <p className="camera__hint">
                <i className="fa-solid fa-circle-info" />
                Camera tự tách từng ký hiệu theo chuyển động của tay. Hãy nghỉ tay ngắn giữa hai ký hiệu để model tách từ chính xác hơn.
            </p>
        </div>
    );
}
