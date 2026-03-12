#!/usr/bin/env node

import { loadConfig, saveConfig, generateDefaultConfig, getConfigPath } from './config.js';

const HELP = `
hitl — Human-in-the-Loop MCP CLI

Usage:
  hitl init                Create a new config at ~/.hitl/config.json
  hitl config show         Print the current config
  hitl config set-topic <id>  Update the topic ID
  hitl test                Send a test question through ntfy
  hitl help                Show this help message
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      return cmdInit();
    case 'config':
      return cmdConfig(args.slice(1));
    case 'test':
      return cmdTest();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

function cmdInit() {
  try {
    loadConfig();
    console.log(`Config already exists at ${getConfigPath()}`);
    console.log('Use "hitl config show" to view it, or delete the file to reinitialize.');
    return;
  } catch {
    // Config doesn't exist — this is expected
  }

  const config = generateDefaultConfig();
  saveConfig(config);
  console.log(`Created config at ${getConfigPath()}`);
  console.log(`\nYour topic ID: ${config.topicId}`);
  console.log(`\nCopy this topic ID to ~/.hitl/config.json on your other machines.`);
  console.log(`Or run: hitl config set-topic ${config.topicId}`);
}

function cmdConfig(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'show': {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      console.log(`\nConfig file: ${getConfigPath()}`);
      return;
    }
    case 'set-topic': {
      const topicId = args[1];
      if (!topicId) {
        console.error('Usage: hitl config set-topic <topic-id>');
        process.exit(1);
      }
      const config = loadConfig();
      config.topicId = topicId;
      saveConfig(config);
      console.log(`Topic ID updated to: ${topicId}`);
      return;
    }
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.log('Available: show, set-topic');
      process.exit(1);
  }
}

async function cmdTest() {
  const config = loadConfig();
  const { NtfyTransport } = await import('./ntfy-transport.js');
  const { v4: uuidv4 } = await import('uuid');

  const transport = new NtfyTransport(config);
  const messageId = uuidv4();

  console.log(`Sending test question to topic: ${config.topicId}`);
  console.log(`ntfy URL: ${config.ntfyUrl}`);
  console.log(`Message ID: ${messageId}`);
  console.log('');

  await transport.publishQuestion({
    type: 'question',
    messageId,
    timestamp: Date.now(),
    repo: null,
    context: 'This is a test question from the hitl CLI.',
    question: 'Is this test notification working?',
    options: [
      { label: 'Yes, it works!', value: 'yes' },
      { label: 'No, something is wrong', value: 'no' },
    ],
    allowMultiple: false,
    allowOther: true,
    timeout: 60000,
  });

  console.log('✓ Test question published successfully!');
  console.log('Check your HITL client apps — they should show a popup.');
  console.log('');
  console.log('Waiting for response (60s timeout)...');

  try {
    const answer = await transport.waitForAnswer(messageId, 60000);
    console.log('');
    console.log('✓ Response received!');
    console.log(`  From: ${answer.respondedFrom}`);
    console.log(`  Selected: ${answer.selectedValues.join(', ')}`);
    if (answer.otherText) {
      console.log(`  Additional: ${answer.otherText}`);
    }
  } catch (err) {
    console.log('');
    console.log('⏱ No response received within 60 seconds.');
    console.log('Make sure a HITL client app is running and connected to the same topic.');
  } finally {
    transport.close();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
