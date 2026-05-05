import './GlassCard.css';

export default function GlassCard({
    children,
    className = '',
    variant = 'default',
    hover = true,
    padding = 'md',
    onClick,
    style,
}) {
    const paddingMap = {
        none: '0',
        sm: 'var(--space-sm)',
        md: 'var(--space-md)',
        lg: 'var(--space-lg)',
        xl: 'var(--space-xl)',
    };

    return (
        <div
            className={`glass-card glass-card--${variant} ${hover ? 'glass-card--hover' : ''} ${className}`}
            onClick={onClick}
            style={{ padding: paddingMap[padding], cursor: onClick ? 'pointer' : 'default', ...style }}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
        >
            {children}
        </div>
    );
}
