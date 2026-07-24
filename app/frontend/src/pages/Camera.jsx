import { useCallback, useEffect, useRef, useState } from 'react';
import GlassCard from '../components/ui/GlassCard';
import useStudyTimer from '../hooks/useStudyTimer';
import './Camera.css';

const CAPTURE_FRAMES = 24;
const CAPTURE_INTERVAL_MS = 125;

function apiError(data, fallback) {
    return typeof data?.detail === 'string' ? data.detail : fallback;
}

export default function CameraPage() {
    useStudyTimer('Nhận diện camera');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const captureAbortRef = useRef(false);
    const [cameraOn, setCameraOn] = useState(false);
    const [facingMode, setFacingMode] = useState('user');
    const [phase, setPhase] = useState('idle');
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [sentence, setSentence] = useState([]);
    const [modelReady, setModelReady] = useState(true);

    const stopStream = useCallback(() => {
        captureAbortRef.current = true;
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraOn(false);
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

    const recognize = async () => {
        if (!videoRef.current || !cameraOn || phase !== 'idle') return;
        captureAbortRef.current = false;
        setError('');
        setPhase('capturing');
        setProgress(0);

        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext('2d', { alpha: false });
        const frames = [];

        for (let index = 0; index < CAPTURE_FRAMES; index += 1) {
            if (captureAbortRef.current) return;
            context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
            frames.push(canvas.toDataURL('image/jpeg', 0.68));
            setProgress(Math.round(((index + 1) / CAPTURE_FRAMES) * 100));
            await new Promise(resolve => window.setTimeout(resolve, CAPTURE_INTERVAL_MS));
        }

        setPhase('processing');
        try {
            const response = await fetch('/api/camera/recognize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frames, top_k: 3 }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(apiError(data, 'Model không thể nhận diện clip này.'));
            setResult(data);
            const rawWord = data.prediction.vietnamese || data.prediction.label;
            const word = rawWord.split('/')[0].trim();
            setSentence(current => [...current, {
                word,
                label: data.prediction.label,
                confidence: data.prediction.confidence,
            }]);
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
            setError(recognitionError.message || 'Không kết nối được với model nhận diện.');
        } finally {
            setPhase('idle');
            setProgress(0);
        }
    };

    const prediction = result?.prediction;
    const confidence = prediction ? Math.round(prediction.confidence * 100) : 0;
    const sentenceText = sentence.map(item => item.word).join(' ');

    const speakSentence = () => {
        if (!sentenceText || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(sentenceText);
        utterance.lang = 'vi-VN';
        window.speechSynthesis.speak(utterance);
    };

    const copySentence = async () => {
        if (!sentenceText) return;
        await navigator.clipboard.writeText(sentenceText);
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
                {phase === 'capturing' && (
                    <div className="camera__countdown">
                        <strong>Đang ghi cử chỉ</strong>
                        <span>Giữ toàn bộ tay và thân trên trong khung hình</span>
                        <div className="camera__progress"><i style={{ width: `${progress}%` }} /></div>
                    </div>
                )}
                {phase === 'processing' && (
                    <div className="camera__processing">
                        <i className="fa-solid fa-spinner fa-spin" />
                        <strong>Model đang phân tích...</strong>
                        <span>Lần đầu có thể lâu hơn do cần nạp model</span>
                    </div>
                )}
            </section>

            <div className="camera__controls">
                {cameraOn ? (
                    <>
                        <button className="camera__btn camera__btn--primary" onClick={recognize} disabled={phase !== 'idle' || !modelReady}>
                            <i className="fa-solid fa-hand" />
                            {phase === 'idle' ? (sentence.length ? 'Thêm từ tiếp theo' : 'Bắt đầu dịch câu') : 'Đang xử lý'}
                        </button>
                        <button className="camera__btn camera__btn--icon" onClick={switchCamera} disabled={phase !== 'idle'} title="Đổi camera">
                            <i className="fa-solid fa-camera-rotate" />
                        </button>
                        <button className="camera__btn camera__btn--quiet" onClick={stopStream} disabled={phase !== 'idle'}>
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
                                onClick={() => setSentence(current => current.slice(0, -1))}
                                disabled={!sentence.length || phase !== 'idle'}
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
                            <button type="button" onClick={() => setSentence([])} disabled={!sentence.length || phase !== 'idle'} title="Xóa câu">
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
                Thực hiện lần lượt từng ký hiệu trong câu. Mỗi lần nhận diện thành công, từ mới sẽ tự động được nối vào câu.
            </p>
        </div>
    );
}
