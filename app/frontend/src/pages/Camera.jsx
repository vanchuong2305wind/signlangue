import { useState, useRef, useCallback, useEffect } from 'react';
import GlassCard from '../components/ui/GlassCard';
import './Camera.css';
import useStudyTimer from '../hooks/useStudyTimer';

export default function CameraPage() {
    useStudyTimer('Nhận diện camera');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const [cameraOn, setCameraOn] = useState(false);
    const [cameraError, setCameraError] = useState(null);
    const [facingMode, setFacingMode] = useState('user');

    const startCamera = useCallback(async (facing) => {
        const useFacing = facing || facingMode;
        setCameraError(null);

        // Check secure context
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setCameraError(
                window.isSecureContext === false
                    ? 'Camera yêu cầu kết nối HTTPS. Hãy truy cập bằng https:// thay vì http://'
                    : 'Trình duyệt không hỗ trợ camera. Hãy dùng Chrome hoặc Safari mới nhất.'
            );
            setCameraOn(false);
            return;
        }

        try {
            // Stop existing stream first
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
                streamRef.current = null;
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: useFacing,
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                },
                audio: false,
            });

            streamRef.current = stream;
            setCameraOn(true);

            // Wait for next render so videoRef is mounted, then attach stream
            requestAnimationFrame(() => {
                if (videoRef.current && streamRef.current) {
                    videoRef.current.srcObject = streamRef.current;
                    videoRef.current.play().catch(() => { });
                }
            });
        } catch (err) {
            console.error('Camera error:', err);
            setCameraError(
                err.name === 'NotAllowedError'
                    ? 'Bạn cần cấp quyền truy cập camera trong trình duyệt.'
                    : err.name === 'NotFoundError'
                        ? 'Không tìm thấy camera trên thiết bị này.'
                        : err.name === 'NotReadableError'
                            ? 'Camera đang được sử dụng bởi ứng dụng khác.'
                            : `Lỗi camera: ${err.message}`
            );
            setCameraOn(false);
        }
    }, [facingMode]);

    const stopCamera = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        setCameraOn(false);
    }, []);

    const toggleFacing = useCallback(() => {
        const newFacing = facingMode === 'user' ? 'environment' : 'user';
        setFacingMode(newFacing);
        if (cameraOn) {
            startCamera(newFacing);
        }
    }, [facingMode, cameraOn, startCamera]);

    // Attach stream to video element whenever cameraOn changes
    useEffect(() => {
        if (cameraOn && videoRef.current && streamRef.current) {
            videoRef.current.srcObject = streamRef.current;
            videoRef.current.play().catch(() => { });
        }
    }, [cameraOn]);

    // Auto-start camera on mount
    useEffect(() => {
        startCamera();
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="camera animate-fade-in">
            {/* Camera Feed */}
            <div className="camera__feed-wrapper">
                {/* Status Badge */}
                <div className={`camera__status-badge ${cameraOn ? 'camera__status-badge--live' : 'camera__status-badge--off'}`}>
                    <span className="camera__status-dot" />
                    {cameraOn ? 'LIVE' : 'TẮT'}
                </div>

                {cameraOn ? (
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="camera__video"
                    />
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
                        <span className="camera__placeholder-text">Đang khởi tạo camera...</span>
                    </div>
                )}
            </div>

            {/* Controls */}
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

            {/* Detection Result */}
            <GlassCard padding="none">
                <div className="camera__result">
                    <div className="camera__result-icon" style={{ background: 'var(--wash-teal)', color: 'var(--wc-teal-dark)' }}>
                        <i className="fa-solid fa-hand" />
                    </div>
                    <div className="camera__result-info">
                        <div className="camera__result-label">Ký hiệu nhận diện</div>
                        <div className="camera__result-word">
                            {cameraOn ? 'Đang chờ ký hiệu...' : 'Bật camera để bắt đầu'}
                        </div>
                        {cameraOn && (
                            <div className="camera__result-confidence">
                                <i className="fa-solid fa-circle-info" style={{ marginRight: '4px', fontSize: '10px' }} />
                                MediaPipe AI sẽ nhận diện tự động (Phase 4)
                            </div>
                        )}
                    </div>
                </div>
            </GlassCard>

            {/* Tips */}
            <GlassCard variant="light" padding="none">
                <div className="camera__tips">
                    <div className="camera__tips-title">
                        <i className="fa-solid fa-lightbulb" style={{ color: 'var(--wc-gold)' }} />
                        Xin Chào
                    </div>
                    {/* <ul className="camera__tips-list">
                        <li className="camera__tip">
                            <i className="fa-solid fa-check camera__tip-icon" />
                            Đảm bảo ánh sáng đủ, tránh ngược sáng
                        </li>
                        <li className="camera__tip">
                            <i className="fa-solid fa-check camera__tip-icon" />
                            Giữ tay trong khung hình, cách camera 30-50cm
                        </li>
                        <li className="camera__tip">
                            <i className="fa-solid fa-check camera__tip-icon" />
                            Nền phía sau nên đơn giản, không quá rối
                        </li>
                        <li className="camera__tip">
                            <i className="fa-solid fa-check camera__tip-icon" />
                            Thực hiện ký hiệu rõ ràng, chậm rãi
                        </li>
                    </ul> */}
                </div>
            </GlassCard>
        </div>
    );
}
