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
  permissions?: Record<string, string>;
  steps: Step[];
};

type Workflow = {
  on: {
    push: { tags: string[] };
    workflow_dispatch: { inputs: Record<string, { required: boolean; default?: string }> };
  };
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
  it('routes full releases and isolated Inbox tags through the release context', () => {
    expect(workflow.on.push.tags).toEqual(['v*', 'inbox-v*']);

    const tray = workflow.jobs['build-client'];
    expect(tray.needs).toBe('prepare-release');
    expect(tray.if).toBe("needs.prepare-release.outputs.full_release == 'true'");

    const inbox = workflow.jobs['build-inbox'];
    expect(inbox.needs).toBe('prepare-release');
    expect(inbox['runs-on']).toBe('windows-latest');
    expect(inbox.if).toContain("full_release == 'true'");
    expect(inbox.if).toContain('refs/tags/inbox-v');

    expect(workflow.jobs['publish-release'].if).toBe("needs.prepare-release.outputs.full_release == 'true'");
    expect(workflow.jobs['publish-inbox-release'].if).toContain('refs/tags/inbox-v');
    expect(workflow.jobs['publish-npm'].if).toBe("needs.prepare-release.outputs.full_release == 'true'");
  });

  it('bumps minor automatically, accepts an exact baseline, and publishes in the same run', () => {
    const version = workflow.on.workflow_dispatch.inputs.version;
    expect(version.required).toBe(false);
    expect(version.default).toBe('');

    const automatic = namedStep('prepare-release', 'Bump, commit, and tag an automatic minor release');
    expect(automatic.run).toContain('github.event.repository.default_branch');
    expect(automatic.run).toContain('scripts/release-version.mjs "$REQUESTED_VERSION"');
    expect(automatic.run).toContain('scripts/release-version.mjs)');
    expect(automatic.run).toContain('git commit -m "Release $tag"');
    expect(automatic.run).toContain('git push origin "HEAD:$GITHUB_REF"');
    expect(automatic.run).toContain('git push origin "refs/tags/$tag"');
    expect(automatic.run).toContain('already exists');

    for (const jobName of ['build-client', 'build-inbox', 'publish-release', 'publish-inbox-release', 'publish-npm']) {
      const checkout = workflow.jobs[jobName].steps.find((step) => step.uses === 'actions/checkout@v4');
      expect(checkout?.with?.ref).toBe('${{ needs.prepare-release.outputs.tag }}');
    }
    expect(namedStep('publish-release', 'Create GitHub Release').with?.tag_name)
      .toBe('${{ needs.prepare-release.outputs.tag }}');
  });

  it('publishes from GitHub Actions using npm trusted publishing', () => {
    const publish = workflow.jobs['publish-npm'];
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });

    const checkout = publish.steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(checkout?.with).toEqual({
      ref: '${{ needs.prepare-release.outputs.tag }}',
      'persist-credentials': false,
    });
    const node = namedStep('publish-npm', 'Install Node.js');
    expect(node.uses).toBe('actions/setup-node@v7');
    expect(node.with).toMatchObject({
      'node-version': 24,
      'check-latest': true,
      'registry-url': 'https://registry.npmjs.org',
      'package-manager-cache': false,
    });
    expect(namedStep('publish-npm', 'Install npm for trusted publishing').run).toBe('npm install -g npm@latest');

    const step = namedStep('publish-npm', 'Publish to npm');
    expect(step['working-directory']).toBe('hitl-mcp-server/server');
    expect(step.run).toBe('npm publish --access public');
    expect(step.if).toBeUndefined();
    expect(JSON.stringify(publish)).not.toMatch(/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/);
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
    expect(workflow.jobs['publish-release'].needs).toEqual(['prepare-release', 'build-client', 'build-inbox']);
    expect(workflow.jobs['publish-npm'].needs).toEqual(['prepare-release', 'build-client']);

    const publishInbox = workflow.jobs['publish-inbox-release'];
    expect(publishInbox.needs).toEqual(['prepare-release', 'build-inbox']);

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
