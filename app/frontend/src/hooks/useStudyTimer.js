import { useEffect } from 'react';
import { recordActivity } from '../api/profile';

export default function useStudyTimer(section) {
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                recordActivity('study_time', section, { section }, 1).catch(() => {});
            }
        }, 60_000);
        return () => window.clearInterval(timer);
    }, [section]);
}
