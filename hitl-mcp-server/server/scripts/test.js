import jest from 'jest';

// Pass the VM-module flag to Node itself. Electron-based Node runtimes can
// ignore NODE_OPTIONS, which otherwise makes Jest load these ESM tests as CJS.
await jest.run(['--config', 'jest.config.js', ...process.argv.slice(2)]);
