import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const treeSource = readFileSync(new URL('../src/pane-agents.js', import.meta.url), 'utf8').replace(/^import .*;$/m, '').replaceAll('export function ', 'function ');
let renderAgentTree;

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.value = ''; }
    set className(value) { this.classes = new Set(value.split(' ')); }
    get className() { return [...(this.classes ?? [])].join(' '); }
    classList = { add: (...names) => { for (const name of names) this.classes.add(name); } };
    set textContent(value) { this.text = value; this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelector(selector) { return this.children.find(child => child.classes?.has(selector.split('.').at(-1))) ?? null; }
}
const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, formatAge: () => '', formatAbsolute: () => '' });
vm.runInContext(treeSource + '\nglobalThis.render = renderAgentTree;', context);
renderAgentTree = context.render;
const now = 1000000;
const project = name => ({ name, scopeKey: `project:${name}`, sessions: [{ machine: 'machine', lastEventAt: now, scopeKey: `session:${name}` }] });

test('merged worktree repository is selectable by click and keyboard', () => {
    const container = new Element('aside');
    const selected = [];
    renderAgentTree(container, { scopeKey: 'all', now, projects: [project('repo/branchA'), project('repo/branchB')] }, { onSelect: key => selected.push(key) });
    const body = container.children[1];
    const [heading, repo] = body.children[1].children;
    assert.equal(repo.dataset.scopeKey, 'repository:repo');
    assert.equal(repo.attributes.role, 'button');
    assert.equal(repo.tabIndex, 0);
    repo.listeners.click();
    repo.listeners.keydown({ key: 'Enter', preventDefault() {} });
    repo.listeners.keydown({ key: ' ', preventDefault() {} });
    assert.deepEqual(selected, ['repository:repo', 'repository:repo', 'repository:repo']);
    heading.listeners.click?.();
    assert.equal(selected.length, 3, 'machine heading must not select null scope');
});
