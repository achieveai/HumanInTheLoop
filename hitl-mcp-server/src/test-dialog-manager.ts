// Simple test to verify the dialog manager works
import { DialogManager } from './dialog-manager.js';

async function runTests() {
  console.log('Starting DialogManager tests...\n');
  
  const manager = new DialogManager();
  let testsPassed = 0;
  let testsFailed = 0;

  // Test 1: Initialization
  try {
    const port = await manager.initialize();
    console.log('✓ Test 1 - Initialization: Server started on port', port);
    testsPassed++;
  } catch (error) {
    console.error('✗ Test 1 - Initialization failed:', error);
    testsFailed++;
  }

  // Test 2: HTML generation with XSS protection
  try {
    const html = (manager as any).generateDialogHTML({
      id: 'test',
      question: '<script>alert("XSS")</script>',
      options: [
        {
          label: '<b>Bold</b>',
          value: 'test',
          description: '"Quotes" & \'apostrophes\''
        }
      ],
      allowMultiple: false,
      allowOther: true
    });

    if (html.includes('<script>alert') || html.includes('<b>Bold</b>')) {
      throw new Error('XSS protection failed');
    }
    if (!html.includes('&lt;script&gt;') || !html.includes('&lt;b&gt;')) {
      throw new Error('HTML should be escaped');
    }
    console.log('✓ Test 2 - XSS Protection: HTML properly escaped');
    testsPassed++;
  } catch (error) {
    console.error('✗ Test 2 - XSS Protection failed:', error);
    testsFailed++;
  }

  // Test 3: Radio vs Checkbox rendering
  try {
    const radioHtml = (manager as any).generateDialogHTML({
      id: 'test',
      question: 'Choose one',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' }
      ],
      allowMultiple: false,
      allowOther: false
    });

    const checkboxHtml = (manager as any).generateDialogHTML({
      id: 'test',
      question: 'Choose many',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' }
      ],
      allowMultiple: true,
      allowOther: false
    });

    if (!radioHtml.includes('type="radio"') || radioHtml.includes('type="checkbox"')) {
      throw new Error('Single choice should use radio buttons');
    }
    if (!checkboxHtml.includes('type="checkbox"') || checkboxHtml.includes('type="radio"')) {
      throw new Error('Multiple choice should use checkboxes');
    }
    console.log('✓ Test 3 - Input Types: Correct radio/checkbox rendering');
    testsPassed++;
  } catch (error) {
    console.error('✗ Test 3 - Input Types failed:', error);
    testsFailed++;
  }

  // Test 4: Other field inclusion
  try {
    const withOther = (manager as any).generateDialogHTML({
      id: 'test',
      question: 'Choose',
      options: [{ label: 'A', value: 'a' }],
      allowMultiple: false,
      allowOther: true
    });

    const withoutOther = (manager as any).generateDialogHTML({
      id: 'test',
      question: 'Choose',
      options: [{ label: 'A', value: 'a' }],
      allowMultiple: false,
      allowOther: false
    });

    if (!withOther.includes('other-input')) {
      throw new Error('Should include other field when allowed');
    }
    if (withoutOther.includes('Other (please specify)')) {
      throw new Error('Should not include other field when not allowed');
    }
    console.log('✓ Test 4 - Other Field: Correctly included/excluded');
    testsPassed++;
  } catch (error) {
    console.error('✗ Test 4 - Other Field failed:', error);
    testsFailed++;
  }

  // Test 5: Context inclusion
  try {
    const withContext = (manager as any).generateDialogHTML({
      id: 'test',
      question: 'Test question',
      options: [{ label: 'Option 1', value: 'opt1' }],
      allowMultiple: false,
      allowOther: false,
      context: 'Important context information'
    });

    const withoutContext = (manager as any).generateDialogHTML({
      id: 'test',
      question: 'Test question',
      options: [{ label: 'Option 1', value: 'opt1' }],
      allowMultiple: false,
      allowOther: false
    });

    if (!withContext.includes('Important context information')) {
      throw new Error('Should include context when provided');
    }
    if (withoutContext.includes('Context:')) {
      throw new Error('Should not include context section when not provided');
    }
    console.log('✓ Test 5 - Context: Correctly included/excluded');
    testsPassed++;
  } catch (error) {
    console.error('✗ Test 5 - Context failed:', error);
    testsFailed++;
  }

  // Cleanup
  await manager.close();

  // Summary
  console.log(`\n========== Test Summary ==========`);
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log(`Total:  ${testsPassed + testsFailed}`);
  
  if (testsFailed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});