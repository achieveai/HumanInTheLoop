#!/usr/bin/env node

import { DialogManager } from './dialog-manager.js';

async function testDialogManager() {
  console.log('Starting Dialog Manager Test...\n');
  
  const manager = new DialogManager();
  await manager.initialize();
  
  const testCases = [
    {
      name: 'Single Choice Question',
      request: {
        id: 'test-1',
        question: 'Which approach should I use for implementing the authentication system?',
        options: [
          {
            label: 'JWT Tokens',
            value: 'jwt',
            description: 'Stateless authentication using JSON Web Tokens'
          },
          {
            label: 'Session-based',
            value: 'session',
            description: 'Traditional server-side session management'
          },
          {
            label: 'OAuth 2.0',
            value: 'oauth',
            description: 'Delegated authentication using OAuth providers'
          }
        ],
        allowMultiple: false,
        allowOther: true,
        context: `This is for a new web application with expected **10k daily active users**.

**Requirements:**
- Must support \`refresh tokens\`
- Should integrate with existing \`Redis\` cache
- Need to handle \`multi-device\` sessions

> **Note:** Security is critical - use industry standard practices.

\`\`\`javascript
// Example usage
const token = generateToken(user);
\`\`\`

See [OAuth 2.0 Spec](https://oauth.net/2/) for details.`
      }
    },
    {
      name: 'Multiple Choice Question',
      request: {
        id: 'test-2',
        question: 'Which files should I include in the commit?',
        options: [
          {
            label: 'src/auth.ts',
            value: 'auth.ts',
            description: 'Main authentication module'
          },
          {
            label: 'src/middleware.ts',
            value: 'middleware.ts',
            description: 'Authentication middleware'
          },
          {
            label: 'tests/auth.test.ts',
            value: 'auth.test.ts',
            description: 'Unit tests for authentication'
          },
          {
            label: 'README.md',
            value: 'readme',
            description: 'Updated documentation'
          }
        ],
        allowMultiple: true,
        allowOther: false,
        context: 'Several files have been modified in the working directory'
      }
    },
    {
      name: 'Timeout Test',
      request: {
        id: 'test-3',
        question: 'This dialog will timeout in 10 seconds. Do you want to proceed?',
        options: [
          {
            label: 'Yes',
            value: 'yes'
          },
          {
            label: 'No',
            value: 'no'
          }
        ],
        allowMultiple: false,
        allowOther: false,
        timeout: 10000
      }
    }
  ];

  for (const testCase of testCases) {
    console.log(`\\n=== ${testCase.name} ===`);
    console.log(`Question: ${testCase.request.question}`);
    console.log('Waiting for user response...');
    
    try {
      const response = await manager.showDialog(testCase.request);
      console.log('Response received:', JSON.stringify(response, null, 2));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
    }
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\\nAll tests completed. Closing dialog manager...');
  await manager.close();
  process.exit(0);
}

// Run the test
testDialogManager().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});