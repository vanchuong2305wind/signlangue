export function buildCueTimeline(signs) {
    let duration = 0;
    const clips = signs.map(sign => {
        const fps = sign.data.fps > 0 ? sign.data.fps : 25;
        const start = duration;
        duration += sign.data.frames.length / fps;
        return { sign, start, end: duration, fps };
    });
    return { clips, duration };
}

export function sampleCue(timeline, elapsed, windowSeconds) {
    if (elapsed < 0 || elapsed >= windowSeconds || !timeline.clips.length) return null;
    // Keep the recorded pace when it fits. Compress longer sequences to the cue.
    const time = elapsed * Math.max(1, timeline.duration / windowSeconds);
    const clip = timeline.clips.find(item => time < item.end);
    if (!clip) return null;
    const frame = Math.min((time - clip.start) * clip.fps, clip.sign.data.frames.length - 1);
    return { sign: clip.sign, index: Math.floor(frame), fraction: frame % 1 };
}
