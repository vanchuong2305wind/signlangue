import GlassCard from '../components/ui/GlassCard';

export default function CameraPage() {
    return (
        <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
            <GlassCard variant="strong" padding="xl">
                <div style={{ textAlign: 'center', padding: 'var(--space-2xl) 0' }}>
                    <span style={{ fontSize: '64px', display: 'block', marginBottom: 'var(--space-lg)' }} className="animate-float">📷</span>
                    <h2 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>
                        Nhận diện ký hiệu
                    </h2>
                    <p style={{ fontSize: '15px', color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto', lineHeight: 1.6 }}>
                        Module nhận diện ký hiệu bằng camera sẽ có trong Phase 4.
                        Sử dụng MediaPipe và AI để nhận diện gesture realtime.
                    </p>
                    <div style={{
                        marginTop: 'var(--space-xl)',
                        padding: '12px 24px',
                        borderRadius: 'var(--radius-full)',
                        background: 'rgba(56, 189, 248, 0.1)',
                        display: 'inline-block',
                        color: '#0ea5e9',
                        fontSize: '13px',
                        fontWeight: 600,
                    }}>
                        🚧 Đang phát triển
                    </div>
                </div>
            </GlassCard>
        </div>
    );
}
