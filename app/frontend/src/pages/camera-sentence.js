// An event survives a forced clip cutoff and ends after a genuine motion pause.
// Its identity, rather than its label or elapsed time, controls deduplication.
export function createSignEventTracker(quietTicksToClose) {
    let nextId = 0;
    let activeId = null;
    let quietTicks = 0;
    return {
        begin() {
            if (activeId === null) activeId = ++nextId;
            return activeId;
        },
        observeMotion(isQuiet) {
            quietTicks = isQuiet ? quietTicks + 1 : 0;
            if (quietTicks >= quietTicksToClose) activeId = null;
        },
        finish() {
            activeId = null;
            quietTicks = 0;
        },
    };
}

export const initialCameraSentence = {
    tokens: [],
    draft: '',
    approvedText: '',
    method: null,
    revision: 0,
    pendingRequest: null,
    error: '',
    history: [],
    seenEventIds: [],
};

function snapshot(state) {
    return {
        tokens: state.tokens,
        draft: state.draft,
        approvedText: state.approvedText,
        method: state.method,
    };
}

function commit(state, changes) {
    return {
        ...state,
        approvedText: '',
        ...changes,
        revision: state.revision + 1,
        pendingRequest: null,
        error: '',
        history: [...state.history.slice(-49), snapshot(state)],
    };
}

export function cameraSentenceReducer(state, action) {
    switch (action.type) {
        case 'append':
            if (state.seenEventIds.includes(action.token.eventId)) return state;
            return commit(state, {
                tokens: [...state.tokens, action.token],
                seenEventIds: [...state.seenEventIds, action.token.eventId],
                draft: '',
                method: null,
            });
        case 'remove_last':
            if (!state.tokens.length) return state;
            return commit(state, { tokens: state.tokens.slice(0, -1), draft: '', method: null });
        case 'clear':
            if (!state.tokens.length) return state;
            return commit(state, { tokens: [], draft: '', method: null });
        case 'use_original':
            if (!state.tokens.length) return state;
            return commit(state, { draft: state.tokens.map(t => t.word).join(' '), method: 'original' });
        case 'edit':
            if (!state.tokens.length || state.draft === action.text) return state;
            return commit(state, { draft: action.text });
        case 'confirm':
            if (!state.tokens.length || !state.draft.trim() || state.pendingRequest) return state;
            return commit(state, { approvedText: state.draft.trim() });
        case 'undo': {
            if (!state.history.length) return state;
            const previous = state.history[state.history.length - 1];
            return {
                ...state,
                ...previous,
                revision: state.revision + 1,
                pendingRequest: null,
                error: '',
                history: state.history.slice(0, -1),
            };
        }
        case 'proposal_requested':
            if (!state.tokens.length) return state;
            return {
                ...state,
                approvedText: '',
                pendingRequest: { id: action.id, revision: state.revision },
                error: '',
            };
        case 'proposal_received':
            if (state.pendingRequest?.id !== action.id
                || state.pendingRequest.revision !== state.revision) return state;
            if (!action.text?.trim()) return { ...state, pendingRequest: null, error: 'Câu đề xuất đang trống.' };
            return commit(state, { draft: action.text, method: action.method });
        case 'proposal_failed':
            if (state.pendingRequest?.id !== action.id) return state;
            return { ...state, pendingRequest: null, error: action.error };
        default:
            return state;
    }
}

export function confirmedCameraSentence(state) {
    return !state.pendingRequest && state.approvedText === state.draft.trim()
        ? state.approvedText : '';
}
