import { useState, useCallback, useEffect } from 'react';
import GlassCard from '../components/ui/GlassCard';
import './Camera.css';
import useStudyTimer from '../hooks/useStudyTimer';

const DEFAULT_RECOGNITION_TEXT = 'xin chào tôi yêu bạn';

export default function CameraPage() {
    useStudyTimer('Nhận diện camera');
    const [cameraOn, setCameraOn] = useState(true);
    const [cameraIndex, setCameraIndex] = useState(0);
    const [streamKey, setStreamKey] = useState(Date.now());
    const [cameraError, setCameraError] = useState(null);
    const [state, setState] = useState({
        running: false,
        has_hands: false,
        result_ready: false,
        error: null,
    });

    const startCamera = useCallback((index = cameraIndex) => {
        setCameraError(null);
        setCameraOn(true);
        setStreamKey(Date.now());
        setCameraIndex(index);
    }, [cameraIndex]);

    const stopCamera = useCallback(() => {
        setCameraOn(false);
        setState(prev => ({
            ...prev,
            running: false,
            has_hands: false,
        }));
    }, []);

    const toggleFacing = useCallback(() => {
        const nextIndex = cameraIndex === 0 ? 1 : 0;
        startCamera(nextIndex);
    }, [cameraIndex, startCamera]);

    useEffect(() => {
        if (!cameraOn) return undefined;
        let cancelled = false;
        const timer = setInterval(async () => {
            try {
                const response = await fetch('/api/camera/python-state');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const nextState = await response.json();
                if (!cancelled) {
                    setState(nextState);
                    setCameraError(nextState.error || null);
                }
            } catch (error) {
                if (!cancelled) {
                    setCameraError(error.message || 'Không đọc được trạng thái camera Python');
                }
            }
        }, 250);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [cameraOn, streamKey]);

    const resultText = state.result_ready
        ? DEFAULT_RECOGNITION_TEXT
        : state.has_hands
            ? 'Đang phân tích ký hiệu...'
            : 'Đưa tay vào khung hình';

    const statusText = cameraError
        ? cameraError
        : state.result_ready
            ? 'Kết quả hiện sau khi Python mất các điểm tay'
            : state.has_hands
                ? 'Python đang xử lý video và vẽ điểm MediaPipe'
                : 'Python sẽ hiện kết quả khi đã thấy tay rồi mất điểm';

    return (
        <div className="camera animate-fade-in">
            <div className="camera__feed-wrapper">
                <div className={`camera__status-badge ${cameraOn ? 'camera__status-badge--live' : 'camera__status-badge--off'}`}>
                    <span className="camera__status-dot" />
                    {cameraOn ? 'LIVE' : 'TẮT'}
                </div>

                {cameraOn ? (
                    <>
                        <img
                            key={streamKey}
                            src={`/api/camera/python-stream?camera=${cameraIndex}&t=${streamKey}`}
                            alt="Python camera recognition stream"
                            className="camera__video"
                            onError={() => setCameraError('Không mở được stream camera từ Python')}
                        />
                        <div className={`camera__analysis-badge ${state.has_hands ? 'camera__analysis-badge--active' : ''}`}>
                            <i className="fa-solid fa-wave-square" />
                            {state.has_hands ? 'Python đang phân tích điểm' : 'Chưa thấy điểm tay'}
                        </div>
                    </>
                ) : cameraError ? (
                    <div className="camera__placeholder">
                        <div className="camera__error">
                            <i className="fa-solid fa-triangle-exclamation camera__error-icon" />
                            <p className="camera__error-text">{cameraError}</p>
                            <button className="camera__btn camera__btn--primary" onClick={() => startCamera()}>
                                <i className="fa-solid fa-rotate-right" /> Thử lại
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="camera__placeholder">
                        <i className="fa-solid fa-video camera__placeholder-icon" />
                        <span className="camera__placeholder-text">Camera Python đang tắt</span>
                    </div>
                )}
            </div>

            <div className="camera__controls">
                {cameraOn ? (
                    <>
                        <button className="camera__btn camera__btn--danger" onClick={stopCamera}>
                            <i className="fa-solid fa-stop" /> Dừng
                        </button>
                        <button className="camera__btn camera__btn--icon" onClick={toggleFacing} title="Đổi camera">
                            <i className="fa-solid fa-camera-rotate" />
                        </button>
                    </>
                ) : (
                    <button className="camera__btn camera__btn--primary" onClick={() => startCamera()}>
                        <i className="fa-solid fa-video" /> Bật Camera
                    </button>
                )}
            </div>

            <GlassCard padding="none">
                <div className="camera__result">
                    <div className="camera__result-icon" style={{ background: 'var(--wash-teal)', color: 'var(--wc-teal-dark)' }}>
                        <i className="fa-solid fa-hand" />
                    </div>
                    <div className="camera__result-info">
                        <div className="camera__result-label">Ký hiệu nhận diện</div>
                        <div className="camera__result-word">
                            {resultText}
                        </div>
                        <div className={`camera__result-confidence ${cameraError ? 'camera__result-confidence--error' : ''}`}>
                            <i className="fa-solid fa-circle-info" style={{ marginRight: '4px', fontSize: '10px' }} />
                            {statusText}
                        </div>
                    </div>
                </div>
            </GlassCard>

            <GlassCard variant="light" padding="none">
                <div className="camera__tips">
                    <div className="camera__tips-title">
                        <i className="fa-solid fa-lightbulb" style={{ color: 'var(--wc-gold)' }} />
                        Xử lý video bằng Python
                    </div>
                </div>
            </GlassCard>
        </div>
    );
}
