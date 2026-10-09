import { describe, it, expect } from '@jest/globals';
import { merge3, mergeMemoryFile } from '../memory/merge3.js';
import { repoKeyFromOrigin } from '../memory/repo-key.js';

describe('repoKeyFromOrigin', () => {
  it('gives every spelling of one GitHub remote the same key', () => {
    const key = 'github.com/achieveai/humanintheloop';
    for (const url of [
      'https://github.com/achieveai/HumanInTheLoop.git',
      'https://github.com/achieveai/HumanInTheLoop',
      'git@github.com:achieveai/HumanInTheLoop.git',
      'ssh://git@github.com:22/achieveai/HumanInTheLoop.git',
      'https://someone@github.com/achieveai/HumanInTheLoop/',
    ]) {
      expect(repoKeyFromOrigin(url)).toBe(key);
    }
  });

  it('folds the three Azure DevOps spellings into one key', () => {
    const key = 'dev.azure.com/org/proj/repo';
    expect(repoKeyFromOrigin('https://org@dev.azure.com/org/proj/_git/repo')).toBe(key);
    expect(repoKeyFromOrigin('https://org.visualstudio.com/proj/_git/repo')).toBe(key);
    expect(repoKeyFromOrigin('https://org.visualstudio.com/DefaultCollection/proj/_git/repo')).toBe(key);
    expect(repoKeyFromOrigin('git@ssh.dev.azure.com:v3/org/proj/repo')).toBe(key);
  });

  it('refuses local-path origins, which are not shared identities', () => {
    for (const url of ['C:\\repos\\x', '/srv/git/x.git', '../x', 'file:///srv/x', '']) {
      expect(repoKeyFromOrigin(url)).toBeNull();
    }
  });
});

describe('merge3', () => {
  const base = 'a\nb\nc\nd\n';

  it('takes the only side that changed', () => {
    expect(merge3(base, base, 'a\nB\nc\nd\n')).toEqual({ text: 'a\nB\nc\nd\n', clashed: false });
    expect(merge3(base, 'a\nb\nc\nD\n', base)).toEqual({ text: 'a\nb\nc\nD\n', clashed: false });
  });

  it('applies changes to different lines from both sides', () => {
    expect(merge3(base, 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')).toEqual({ text: 'A\nb\nc\nD\n', clashed: false });
  });

  it('keeps both versions when both sides change the same line', () => {
    expect(merge3(base, 'a\nX\nc\nd\n', 'a\nY\nc\nd\n')).toEqual({ text: 'a\nX\nY\nc\nd\n', clashed: true });
  });

  it('keeps both lines appended at the same point, and one copy of a line both added', () => {
    expect(merge3(base, `${base}one\nsame line\n`, `${base}same line\ntwo\n`).text)
      .toBe(`${base}one\nsame line\ntwo\n`);
  });

  it('puts an insertion before the other side’s edit at the same spot, with no clash', () => {
    expect(merge3(base, 'a\nnew\nb\nc\nd\n', 'a\nB\nc\nd\n')).toEqual({ text: 'a\nnew\nB\nc\nd\n', clashed: false });
  });

  it('adds the missing newline when keeping both after a last line without one', () => {
    expect(merge3('x', 'x one', 'x two').text).toBe('x one\nx two');
  });

  it('merges two new files (no base) into one with both', () => {
    expect(merge3('', 'first fact\n', 'second fact\n')).toEqual({ text: 'first fact\nsecond fact\n', clashed: true });
  });

  it('is deterministic: the same inputs always give the same bytes', () => {
    const run = () => merge3(base, 'a\nX\nc\nd\nzz\n', 'a\nY\nc\nq\n').text;
    expect(run()).toBe(run());
  });
});

describe('mergeMemoryFile', () => {
  const file = (description: string, body: string) =>
    `---\nname: build\ndescription: ${description}\nmetadata:\n  type: project\n---\n${body}`;

  it('takes the second side’s frontmatter whole on a clash, so YAML keys never repeat, and keeps both bodies', () => {
    const merged = mergeMemoryFile(file('old', 'run x\n'), file('mine', 'run y\n'), file('theirs', 'run z\n'));
    expect(merged.clashed).toBe(true);
    expect(merged.text).toBe(file('theirs', 'run y\nrun z\n'));
    expect(merged.text.match(/^description:/gm)).toHaveLength(1);
  });

  it('merges a frontmatter change from one side with a body change from the other', () => {
    const merged = mergeMemoryFile(file('old', 'run x\n'), file('new', 'run x\n'), file('old', 'run x\nthen y\n'));
    expect(merged).toEqual({ text: file('new', 'run x\nthen y\n'), clashed: false });
  });
});
