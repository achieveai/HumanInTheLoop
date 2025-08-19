#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

async function main() {
  console.log('🚀 Starting HITL MCP Test Client\n');
  
  // Spawn the HITL MCP server process
  const serverPath = 'D:\\Source\\repos\\Hitl_MCP\\hitl-mcp-server\\dist\\index.js';
  console.log(`Starting server from: ${serverPath}`);
  
  const serverProcess = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' }
  });

  // Create transport connected to the server's stdio
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { NODE_ENV: 'production' }
  });

  // Create MCP client
  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  try {
    // Connect to the server
    await client.connect(transport);
    console.log('✅ Connected to HITL MCP Server\n');

    // List available tools
    const tools = await client.listTools();
    console.log('Available tools:', tools.tools.map(t => t.name).join(', '));
    console.log('\n---\n');

    // Test 1: Simple Yes/No question
    console.log('Test 1: Simple Yes/No Question');
    console.log('Asking: "Should we proceed with the test?"');
    
    const result1 = await client.callTool('ask_human', {
      question: "Should we proceed with the test?",
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" }
      ],
      allowMultiple: false,
      allowOther: false,
      context: "This is a test of the HITL MCP server"
    });
    
    console.log('Response:', JSON.stringify(result1, null, 2));
    console.log('\n---\n');

    // Test 2: Multiple choice with descriptions
    console.log('Test 2: Multiple Choice with Descriptions');
    console.log('Asking about database selection...');
    
    const result2 = await client.callTool('ask_human', {
      question: "Which database should we use?",
      options: [
        {
          label: "PostgreSQL",
          value: "postgres",
          description: "Robust relational database with advanced features"
        },
        {
          label: "MongoDB",
          value: "mongo",
          description: "Flexible document database for unstructured data"
        },
        {
          label: "SQLite",
          value: "sqlite",
          description: "Lightweight embedded database"
        }
      ],
      allowMultiple: false,
      allowOther: true,
      context: "Choosing a database for a new web application"
    });
    
    console.log('Response:', JSON.stringify(result2, null, 2));
    console.log('\n---\n');

    // Test 3: Multiple selection
    console.log('Test 3: Multiple Selection');
    console.log('Asking about files to include...');
    
    const result3 = await client.callTool('ask_human', {
      question: "Which files should be included in the commit?",
      options: [
        { label: "index.js", value: "index" },
        { label: "utils.js", value: "utils" },
        { label: "README.md", value: "readme" },
        { label: "package.json", value: "package" }
      ],
      allowMultiple: true,
      allowOther: false,
      context: "Selecting files for a git commit"
    });
    
    console.log('Response:', JSON.stringify(result3, null, 2));
    console.log('\n---\n');

    // Test 4: With timeout
    console.log('Test 4: Question with Timeout (10 seconds)');
    console.log('You have 10 seconds to respond...');
    
    try {
      const result4 = await client.callTool('ask_human', {
        question: "Quick! Should we deploy to production?",
        options: [
          { label: "Deploy Now", value: "deploy" },
          { label: "Wait", value: "wait" },
          { label: "Cancel", value: "cancel" }
        ],
        allowMultiple: false,
        allowOther: false,
        timeout: 10000,
        context: "Time-sensitive deployment decision"
      });
      
      console.log('Response:', JSON.stringify(result4, null, 2));
    } catch (error) {
      console.log('Timeout or error:', error.message);
    }
    
    console.log('\n✅ All tests completed!');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    // Clean up
    await client.close();
    serverProcess.kill();
    process.exit(0);
  }
}

// Run the test
main().catch(console.error);