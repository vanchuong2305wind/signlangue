import assert from 'node:assert/strict';
import test from 'node:test';
import {
    cameraSentenceReducer as reduce, confirmedCameraSentence,
    createSignEventTracker, initialCameraSentence,
} from '../src/pages/camera-sentence.js';

const add = (state, word, eventId) => reduce(state, {
    type: 'append', token: { word, label: word, eventId, confidence: 0.9 },
});
const demoWords = ['tôi', 'không', 'muốn', 'đi', 'đi', 'lại', 'lại'];
const demoSentence = 'Tôi không muốn đi đi lại lại.';
const demoState = () => demoWords.reduce((state, word, i) => add(state, word, i + 1), initialCameraSentence);

test('forced clips share an event; a pause starts a new event even for the same word', () => {
    const events = createSignEventTracker(3);
    const first = events.begin();
    events.observeMotion(false);
    assert.equal(events.begin(), first); // Forced clip cutoff during one gesture.
    events.observeMotion(true);
    events.observeMotion(true);
    assert.equal(events.begin(), first); // Brief settling is still the same event.
    events.observeMotion(true);
    const second = events.begin();
    assert.notEqual(second, first);
    events.finish();
    assert.notEqual(events.begin(), second); // Restart never reuses an event ID.
});

test('one event contributes at most one token; separate events retain adjacent repetitions', () => {
    let state = add(initialCameraSentence, 'đi', 1);
    state = add(state, 'đi', 1);
    state = add(state, 'lại', 1); // Conflicting prediction from another clip of this gesture.
    state = add(state, 'đi', 2);
    assert.deepEqual(state.tokens.map(t => t.word), ['đi', 'đi']);
    state = reduce(state, { type: 'remove_last' });
    state = add(state, 'đi', 2); // A delayed duplicate cannot resurrect a removed token.
    assert.equal(state.tokens.length, 1);
});

test('demo keeps repetitions and negation, requires confirmation, and can undo confirmation', () => {
    let state = demoState();
    state = reduce(state, { type: 'proposal_requested', id: 1 });
    state = reduce(state, { type: 'proposal_received', id: 1, text: demoSentence, method: 'gemini' });
    assert.deepEqual(state.tokens.map(t => t.word), demoWords);
    assert.equal(confirmedCameraSentence(state), '');
    state = reduce(state, { type: 'confirm' });
    assert.equal(confirmedCameraSentence(state), demoSentence);
    state = reduce(state, { type: 'undo' });
    assert.equal(state.draft, demoSentence);
    assert.equal(confirmedCameraSentence(state), '');
});

test('editing revokes approval; undo restores the exact previous approved content', () => {
    let state = reduce(demoState(), { type: 'use_original' });
    state = reduce(state, { type: 'confirm' });
    const approved = state.approvedText;
    state = reduce(state, { type: 'edit', text: demoSentence });
    assert.equal(confirmedCameraSentence(state), '');
    state = reduce(state, { type: 'undo' });
    assert.equal(confirmedCameraSentence(state), approved);
    assert.deepEqual(state.tokens.map(t => t.word), demoWords);
});

test('a bad AI proposal cannot silently replace the original or be used before user review', () => {
    let state = reduce(demoState(), { type: 'proposal_requested', id: 1 });
    // Simulate all three risks: changed subject, lost negation and lost repetitions.
    state = reduce(state, { type: 'proposal_received', id: 1, text: 'Bạn muốn đi lại.', method: 'gemini' });
    assert.deepEqual(state.tokens.map(t => t.word), demoWords);
    assert.equal(confirmedCameraSentence(state), '');
    state = reduce(state, { type: 'edit', text: demoSentence });
    assert.equal(confirmedCameraSentence(state), '');
    state = reduce(state, { type: 'confirm' });
    assert.equal(confirmedCameraSentence(state), demoSentence);
});

test('recognition changes revoke approval and undo restores removed or cleared words', () => {
    let state = reduce(reduce(demoState(), { type: 'use_original' }), { type: 'confirm' });
    state = add(state, 'không', 8);
    assert.equal(confirmedCameraSentence(state), '');
    state = reduce(state, { type: 'clear' });
    assert.deepEqual(state.tokens, []);
    state = reduce(state, { type: 'undo' });
    assert.equal(state.tokens.length, 8);
    state = reduce(state, { type: 'remove_last' });
    state = reduce(state, { type: 'undo' });
    assert.equal(state.tokens.at(-1).word, 'không');
});

test('late AI responses cannot replace an edit, new recognition, clear, or undo', () => {
    for (const change of [
        { type: 'edit', text: 'Câu do người dùng sửa.' },
        { type: 'append', token: { word: 'không', eventId: 8 } },
        { type: 'clear' },
        { type: 'undo' },
    ]) {
        let state = reduce(demoState(), { type: 'proposal_requested', id: 1 });
        state = reduce(state, change);
        const expected = state;
        state = reduce(state, { type: 'proposal_received', id: 1, text: 'Câu cũ.' });
        state = reduce(state, { type: 'proposal_failed', id: 1, error: 'Lỗi cũ.' });
        assert.equal(state, expected);
    }
});

test('a new request invalidates approval and ignores previous responses', () => {
    let state = reduce(reduce(demoState(), { type: 'use_original' }), { type: 'confirm' });
    state = reduce(state, { type: 'proposal_requested', id: 1 });
    assert.equal(confirmedCameraSentence(state), '');
    state = reduce(state, { type: 'proposal_requested', id: 2 });
    const pending = state;
    assert.equal(reduce(state, { type: 'confirm' }), pending);
    assert.equal(reduce(state, { type: 'proposal_received', id: 1, text: 'Cũ' }), pending);
    state = reduce(state, { type: 'proposal_received', id: 2, text: demoSentence, method: 'local' });
    assert.equal(state.method, 'local');
    assert.equal(confirmedCameraSentence(state), '');
});

test('blank proposals and blank edits cannot be confirmed', () => {
    let state = reduce(demoState(), { type: 'proposal_requested', id: 1 });
    state = reduce(state, { type: 'proposal_received', id: 1, text: '  ' });
    assert(state.error);
    state = reduce(state, { type: 'edit', text: '   ' });
    state = reduce(state, { type: 'confirm' });
    assert.equal(confirmedCameraSentence(state), '');
});
