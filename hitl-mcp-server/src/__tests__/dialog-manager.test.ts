import { DialogManager } from '../dialog-manager.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('DialogManager', () => {
  let manager: DialogManager;

  beforeEach(() => {
    manager = new DialogManager();
  });

  afterEach(async () => {
    await manager.close();
  });

  describe('initialization', () => {
    it('should initialize the server on a random port', async () => {
      const port = await manager.initialize();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    });

    it('should not reinitialize if already initialized', async () => {
      const port1 = await manager.initialize();
      const port2 = await manager.initialize();
      expect(port1).toBe(port2);
    });
  });

  describe('HTML generation', () => {
    it('should escape HTML in user input', () => {
      const manager = new DialogManager();
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

      expect(html).not.toContain('<script>alert("XSS")</script>');
      expect(html).toContain('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
      expect(html).not.toContain('<b>Bold</b>');
      expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
    });

    it('should include context when provided', () => {
      const manager = new DialogManager();
      const html = (manager as any).generateDialogHTML({
        id: 'test',
        question: 'Test question',
        options: [{ label: 'Option 1', value: 'opt1' }],
        allowMultiple: false,
        allowOther: false,
        context: 'Important context information'
      });

      expect(html).toContain('Important context information');
      expect(html).toContain('Context:');
    });

    it('should not include context section when not provided', () => {
      const manager = new DialogManager();
      const html = (manager as any).generateDialogHTML({
        id: 'test',
        question: 'Test question',
        options: [{ label: 'Option 1', value: 'opt1' }],
        allowMultiple: false,
        allowOther: false
      });

      expect(html).not.toContain('Context:');
    });
  });

  describe('dialog options', () => {
    it('should render radio buttons for single choice', () => {
      const manager = new DialogManager();
      const html = (manager as any).generateDialogHTML({
        id: 'test',
        question: 'Choose one',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' }
        ],
        allowMultiple: false,
        allowOther: false
      });

      expect(html).toContain('type="radio"');
      expect(html).not.toContain('type="checkbox"');
    });

    it('should render checkboxes for multiple choice', () => {
      const manager = new DialogManager();
      const html = (manager as any).generateDialogHTML({
        id: 'test',
        question: 'Choose many',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' }
        ],
        allowMultiple: true,
        allowOther: false
      });

      expect(html).toContain('type="checkbox"');
      expect(html).not.toContain('type="radio"');
    });

    it('should include other field when allowed', () => {
      const manager = new DialogManager();
      const html = (manager as any).generateDialogHTML({
        id: 'test',
        question: 'Choose',
        options: [{ label: 'A', value: 'a' }],
        allowMultiple: false,
        allowOther: true
      });

      expect(html).toContain('id="other-input"');
      expect(html).toContain('Additional Context (optional)');
    });

    it('should not include other field when not allowed', () => {
      const manager = new DialogManager();
      const html = (manager as any).generateDialogHTML({
        id: 'test',
        question: 'Choose',
        options: [{ label: 'A', value: 'a' }],
        allowMultiple: false,
        allowOther: false
      });

      expect(html).not.toContain('id="other-input"');
      expect(html).not.toContain('Additional Context (optional)');
    });
  });

  describe('timeout handling', () => {
    it('should reject with timeout error after specified duration', async () => {
      await manager.initialize();
      
      const dialogPromise = manager.showDialog({
        id: 'timeout-test',
        question: 'This will timeout',
        options: [{ label: 'Option', value: 'opt' }],
        allowMultiple: false,
        allowOther: false,
        timeout: 100
      });

      await expect(dialogPromise).rejects.toThrow('Dialog timeout');
    }, 10000);
  });
});