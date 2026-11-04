import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual refresh closure with its UI collaborators replaced by
// receipts. No browser or DOM is needed to observe which rows it reconciles.
const source = await readFile(new URL('../src/pane-thread.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function refreshThread() {');
const end = source.indexOf('\n    /**', start);
const refreshSource = source.slice(start, end);
function harness(state, invoke) {
    const reconciled = [];
    const errors = [];
    const scope = vm.createContext({
        painted: state, generation: 1, refreshInFlight: false, invoke,
        reconcile: rows => reconciled.push(Array.from(rows)),
        onError: error => errors.push(error),
    });
    vm.runInContext(`${refreshSource}\nglobalThis.refresh = refreshThread;`, scope);
    return { scope, reconciled, errors, refresh: scope.refresh };
}
const row = key => ({ messageId: `${key}-1`, sessionKey: key });
const state = (...keys) => ({ sessionBacked: true, anchorId: `${keys[0]}-1`, rows: keys.map(row), sessionKeys: keys });

test('refresh retains every member of a merged conversation', async () => {
    const queried = [];
    const h = harness(state('a', 'b'), async (_command, args) => {
        queried.push(args.sessionKey);
        return { messages: [row(args.sessionKey.slice(8))] };
    });
    await h.refresh();
    assert.deepEqual(queried.sort(), ['session:a', 'session:b']);
    assert.deepEqual(h.reconciled[0].map(x => x.messageId).sort(), ['a-1', 'b-1']);
});

test('a delayed refresh cannot replace a newly selected conversation', async () => {
    let resolve;
    const h = harness(state('a'), () => new Promise(done => { resolve = done; }));
    const pending = h.refresh();
    h.scope.painted = state('b');
    h.scope.generation++;
    resolve({ messages: [row('a')] });
    await pending;
    assert.equal(h.reconciled.length, 0);
});

test('partial member failure preserves the existing complete thread', async () => {
    const h = harness(state('a', 'b'), async (_command, args) => {
        if (args.sessionKey === 'session:b') throw new Error('offline');
        return { messages: [row('a')] };
    });
    await h.refresh();
    assert.equal(h.reconciled.length, 0);
    assert.equal(h.errors.length, 1);
});

test('a missing member snapshot does not remove existing cards', async () => {
    const h = harness(state('a', 'b'), async (_command, args) =>
        args.sessionKey === 'session:b' ? undefined : { messages: [row('a')] });
    await h.refresh();
    assert.equal(h.reconciled.length, 0);
});

test('shared message ids across member snapshots reconcile once', async () => {
    const h = harness(state('a', 'b'), async () => ({ messages: [row('shared')] }));
    await h.refresh();
    assert.deepEqual(h.reconciled[0].map(x => x.messageId), ['shared-1']);
});

test('clearing the pane invalidates an outstanding refresh', async () => {
    let resolve;
    const h = harness(state('a'), () => new Promise(done => { resolve = done; }));
    const pending = h.refresh();
    h.scope.painted = null;
    h.scope.generation++;
    resolve({ messages: [row('a')] });
    await pending;
    assert.equal(h.reconciled.length, 0);
});
