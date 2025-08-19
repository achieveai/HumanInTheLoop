#!/usr/bin/env node

// Simple direct test of the dialog manager
// This bypasses the MCP protocol and tests the dialog UI directly

import { DialogManager } from './hitl-mcp-server/dist/dialog-manager.js';

async function testDialogManager() {
  console.log('🧪 Direct Dialog Manager Test\n');
  
  const dialogManager = new DialogManager();
  
  try {
    // Start the dialog server
    await dialogManager.start();
    console.log('✅ Dialog server started\n');
    
    // Test 1: Simple Yes/No
    console.log('Test 1: Opening Yes/No dialog...');
    console.log('Please respond in the browser window that opens.\n');
    
    const result1 = await dialogManager.showDialog({
      question: "Do you see this dialog?",
      options: [
        { label: "Yes, I see it!", value: "yes" },
        { label: "No", value: "no" }
      ],
      allowMultiple: false,
      allowOther: false,
      context: "Testing if the dialog UI works correctly"
    });
    
    console.log('You selected:', result1);
    console.log('---\n');
    
    // Test 2: Multiple choice with "Other" option
    console.log('Test 2: Multiple choice with custom input...');
    
    const result2 = await dialogManager.showDialog({
      question: "What's your favorite programming language?",
      options: [
        { label: "JavaScript", value: "js" },
        { label: "Python", value: "python" },
        { label: "TypeScript", value: "ts" },
        { label: "Rust", value: "rust" }
      ],
      allowMultiple: false,
      allowOther: true,
      context: "Testing custom input option"
    });
    
    console.log('You selected:', result2);
    console.log('---\n');
    
    // Test 3: Multiple selection
    console.log('Test 3: Multiple selection test...');
    
    const result3 = await dialogManager.showDialog({
      question: "Select all that apply:",
      options: [
        { label: "The dialog opened correctly", value: "opened" },
        { label: "I can see all options", value: "visible" },
        { label: "The UI looks good", value: "ui_good" },
        { label: "I can select multiple items", value: "multi_select" }
      ],
      allowMultiple: true,
      allowOther: false,
      context: "Testing multiple selection functionality"
    });
    
    console.log('You selected:', result3);
    console.log('---\n');
    
    // Test 4: Timeout test
    console.log('Test 4: Timeout test (5 seconds)...');
    console.log('⏱️  You have 5 seconds to respond!\n');
    
    try {
      const result4 = await dialogManager.showDialog({
        question: "Quick! Pick a number!",
        options: [
          { label: "One", value: "1" },
          { label: "Two", value: "2" },
          { label: "Three", value: "3" }
        ],
        allowMultiple: false,
        allowOther: false,
        timeout: 5000
      });
      
      console.log('You selected:', result4);
    } catch (error) {
      console.log('Timed out or error:', error.message);
    }
    
    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during testing:', error);
  } finally {
    // Stop the server
    await dialogManager.stop();
    console.log('\n🛑 Dialog server stopped');
    process.exit(0);
  }
}

// Run the test
testDialogManager().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});