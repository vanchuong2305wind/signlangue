import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCueTimeline, sampleCue } from '../src/components/avatar/cue-timeline.js';
import { findCueIndex } from '../src/hooks/useVideoSubtitles.js';

const sign = (gloss, count) => ({ gloss, data: { fps: 10, frames: Array(count) } });
const first = sign('a', 10);
const second = sign('b', 30);
const timeline = buildCueTimeline([first, second]);

test('a short cue fits both signs and seeks directly to the right source frame', () => {
    assert.deepEqual(sampleCue(timeline, 1.25, 2), { sign: second, index: 15, fraction: 0 });
    assert.deepEqual(sampleCue(timeline, 0.25, 2), { sign: first, index: 5, fraction: 0 });
    assert.equal(sampleCue(timeline, 2, 2), null);
});

test('long cues keep the recorded pace and pauses give a stable frame', () => {
    const sample = sampleCue(timeline, 1.5, 8);
    assert.deepEqual(sample, { sign: second, index: 5, fraction: 0 });
    assert.deepEqual(sampleCue(timeline, 1.5, 8), sample);
    assert.equal(sampleCue(timeline, 5, 8), null);
    assert.equal(sampleCue(timeline, -1, 8), null);
});

test('silence between subtitles does not keep the previous cue active', () => {
    const cues = [{ start: 1, end: 2 }, { start: 4, end: 6 }];
    assert.deepEqual([0, 1, 2, 3, 4, 6].map(t => findCueIndex(cues, t)), [-1, 0, -1, -1, 1, -1]);
});
