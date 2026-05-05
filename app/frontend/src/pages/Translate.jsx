import GlassCard from '../components/ui/GlassCard';

export default function Translate() {
    return (
        <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
            <GlassCard variant="strong" padding="xl">
                <div style={{ textAlign: 'center', padding: 'var(--space-2xl) 0' }}>
                    <span style={{ fontSize: '64px', display: 'block', marginBottom: 'var(--space-lg)' }} className="animate-float">🎤</span>
                    <h2 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>
                        Giọng nói → Ký hiệu
                    </h2>
                    <p style={{ fontSize: '15px', color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto', lineHeight: 1.6 }}>
                        Module dịch giọng nói thành ngôn ngữ ký hiệu sẽ có trong Phase 2.
                        Tính năng này sử dụng Web Speech API và avatar 3D.
                    </p>
                    <div style={{
                        marginTop: 'var(--space-xl)',
                        padding: '12px 24px',
                        borderRadius: 'var(--radius-full)',
                        background: 'rgba(45, 212, 191, 0.1)',
                        display: 'inline-block',
                        color: 'var(--color-teal-dark)',
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
