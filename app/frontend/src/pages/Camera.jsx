import GlassCard from '../components/ui/GlassCard';

export default function CameraPage() {
    return (
        <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
            <GlassCard variant="strong" padding="xl">
                <div style={{ textAlign: 'center', padding: 'var(--space-2xl) 0' }}>
                    <i
                        className="fa-solid fa-camera animate-float"
                        style={{
                            fontSize: '56px',
                            display: 'block',
                            marginBottom: 'var(--space-lg)',
                            color: 'var(--wc-sky)',
                            opacity: 0.5,
                        }}
                    />
                    <h2 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--ink-dark)', marginBottom: '8px' }}>
                        Nhận diện ký hiệu
                    </h2>
                    <p style={{ fontSize: '15px', color: 'var(--ink-faint)', maxWidth: '400px', margin: '0 auto', lineHeight: 1.6 }}>
                        Module nhận diện ký hiệu bằng camera sẽ có trong Phase 4.
                        Sử dụng MediaPipe và AI để nhận diện gesture realtime.
                    </p>
                    <div style={{
                        marginTop: 'var(--space-xl)',
                        padding: '10px 22px',
                        borderRadius: '14px 18px 16px 12px',
                        background: 'var(--wash-sky)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        color: 'var(--wc-sky)',
                        fontSize: '13px',
                        fontWeight: 600,
                        border: '1px solid rgba(125, 170, 200, 0.2)',
                    }}>
                        <i className="fa-solid fa-wrench" /> Đang phát triển
                    </div>
                </div>
            </GlassCard>
        </div>
    );
}
