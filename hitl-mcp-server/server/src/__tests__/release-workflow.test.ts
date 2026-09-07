import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { safeLoad(source: string): unknown };

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  'working-directory'?: string;
  with?: Record<string, unknown>;
};

type Job = {
  if?: string;
  needs?: string | string[];
  'runs-on'?: string;
  steps: Step[];
};

type Workflow = {
  on: { push: { tags: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '../../..');
const WORKFLOW_PATH = path.resolve(PACKAGE_ROOT, '../.github/workflows/release.yml');
const workflow = yaml.safeLoad(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;

function namedStep(jobName: string, stepName: string): Step {
  const step = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName);
  expect(step).toBeDefined();
  return step!;
}

describe('Inbox release workflow', () => {
  it('routes Inbox tags to an isolated Windows build while preserving manual build-only dispatch', () => {
    expect(workflow.on.push.tags).toEqual(['v*', 'inbox-v*']);

    const tray = workflow.jobs['build-client'];
    expect(tray.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(tray.if).toContain("refs/tags/v");
    expect(tray.if).not.toContain('refs/tags/inbox-v');

    const inbox = workflow.jobs['build-inbox'];
    expect(inbox['runs-on']).toBe('windows-latest');
    expect(inbox.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(inbox.if).toContain("refs/tags/v");
    expect(inbox.if).toContain("refs/tags/inbox-v");

    expect(workflow.jobs['publish-release'].if).toContain("refs/tags/v");
    expect(workflow.jobs['publish-inbox-release'].if).toContain("refs/tags/inbox-v");
    expect(workflow.jobs['publish-npm'].if).toContain("refs/tags/v");
  });

  it('builds the existing Inbox configuration for Windows x64 with Node 24 and the shared UI hook', () => {
    const node = namedStep('build-inbox', 'Install Node.js');
    expect(node.uses).toBe('actions/setup-node@v4');
    expect(node.with?.['node-version']).toBe(24);

    const rust = namedStep('build-inbox', 'Install Rust stable');
    expect(rust.with?.targets).toBe('x86_64-pc-windows-msvc');

    const install = namedStep('build-inbox', 'Install frontend dependencies');
    expect(install['working-directory']).toBe('hitl-mcp-server');
    expect(install.run).toBe('npm ci');

    const build = namedStep('build-inbox', 'Build Inbox MSI');
    expect(build['working-directory']).toBe('hitl-mcp-server/inbox');
    expect(build.run).toContain('npm run tauri -- build');
    expect(build.run).toContain('--target x86_64-pc-windows-msvc');
    expect(build.run).toContain('--bundles msi');

    const config = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'inbox/src-tauri/tauri.conf.json'), 'utf8')
    ) as { build: { beforeBuildCommand: string } };
    expect(config.build.beforeBuildCommand).toBe('npm run sync');
  });

  it('fails closed unless the MSI, raw executable, ZIP, and checksum are all prepared', () => {
    const tagGuard = namedStep('build-inbox', 'Validate Inbox tag version').run ?? '';
    expect(tagGuard).toContain('inbox-v');
    expect(tagGuard).toContain('hitl-mcp-server/inbox/package.json');
    expect(tagGuard).toContain('throw');

    const collect = namedStep('build-inbox', 'Prepare Inbox release assets').run ?? '';
    const targetRoot = 'hitl-mcp-server/target/x86_64-pc-windows-msvc/release';
    expect(collect).toContain(`$sourceRoot = "${targetRoot}"`);
    expect(collect).toContain('$sourceRoot/bundle/msi');
    expect(collect).toContain('$sourceRoot/hitl-inbox.exe');
    expect(collect).toContain('$msiFiles.Count -ne 1');
    expect(collect).toContain('Compress-Archive');
    expect(collect).toContain('Get-FileHash');

    for (const asset of [
      'hitl-inbox-windows-x64.msi',
      'hitl-inbox-windows-x64.exe',
      'hitl-inbox-windows-x64.zip',
      'hitl-inbox-windows-x64.sha256',
    ]) {
      expect(collect).toContain(asset);
    }
    expect(collect).toContain('missing or empty');

    const upload = namedStep('build-inbox', 'Upload Inbox artifacts');
    expect(upload.with?.name).toBe('hitl-inbox-windows-x64');
    expect(upload.with?.path).toBe('artifacts/hitl-inbox-windows-x64.*');
    expect(upload.with?.['if-no-files-found']).toBe('error');
  });

  it('publishes Inbox-only tags without coupling them to tray builds or npm', () => {
    expect(workflow.jobs['publish-release'].needs).toEqual(['build-client', 'build-inbox']);
    expect(workflow.jobs['publish-npm'].needs).toBe('build-client');

    const publishInbox = workflow.jobs['publish-inbox-release'];
    expect(publishInbox.needs).toBe('build-inbox');

    const download = namedStep('publish-inbox-release', 'Download Inbox artifacts');
    expect(download.with?.name).toBe('hitl-inbox-windows-x64');
    expect(download.with?.path).toBe('release-assets');

    const release = namedStep('publish-inbox-release', 'Create Inbox GitHub Release');
    expect(release.uses).toBe('softprops/action-gh-release@v3');
    expect(release.with?.files).toBe('release-assets/*');
    expect(release.with?.['make_latest']).toBe(false);
    expect(release.with?.body).toContain('unsigned');
    expect(release.with?.body).toContain('WebView2');
    expect(release.with?.body).toContain('.hitl');
    expect(release.with?.body).toContain('Android is not included');
  });
});
