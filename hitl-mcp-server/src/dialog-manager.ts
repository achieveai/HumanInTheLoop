import express, { Express, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DialogOption {
  label: string;
  value: string;
  description?: string;
}

export interface DialogRequest {
  id: string;
  question: string;
  options: DialogOption[];
  allowMultiple: boolean;
  allowOther: boolean;
  context?: string;
  timeout?: number;
}

export interface DialogResponse {
  id: string;
  selectedValues: string[];
  otherText?: string;
  timestamp: number;
}

export class DialogManager extends EventEmitter {
  private app: Express;
  private port: number;
  private pendingDialogs: Map<string, {
    request: DialogRequest;
    resolve: (response: DialogResponse) => void;
    reject: (error: Error) => void;
    timeout?: NodeJS.Timeout;
  }>;
  private server: any;
  private isInitialized: boolean = false;

  constructor(port: number = 0) {
    super();
    this.port = port;
    this.app = express();
    this.pendingDialogs = new Map();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());
    this.app.use(express.static('public'));

    this.app.get('/dialog/:id', (req: Request, res: Response) => {
      const dialogId = req.params.id;
      const dialog = this.pendingDialogs.get(dialogId);
      
      if (!dialog) {
        res.status(404).send('Dialog not found or expired');
        return;
      }

      const html = this.generateDialogHTML(dialog.request);
      res.send(html);
    });

    this.app.post('/dialog/:id/response', (req: Request, res: Response) => {
      const dialogId = req.params.id;
      const dialog = this.pendingDialogs.get(dialogId);
      
      if (!dialog) {
        res.status(404).json({ error: 'Dialog not found or expired' });
        return;
      }

      const response: DialogResponse = {
        id: dialogId,
        selectedValues: req.body.selectedValues || [],
        otherText: req.body.otherText,
        timestamp: Date.now()
      };

      if (dialog.timeout) {
        clearTimeout(dialog.timeout);
      }

      dialog.resolve(response);
      this.pendingDialogs.delete(dialogId);
      
      res.json({ success: true });
    });

    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'healthy', pendingDialogs: this.pendingDialogs.size });
    });
  }

  private generateDialogHTML(request: DialogRequest): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Human In The Loop - Response Required</title>
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/lib/marked.umd.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100vh;
            max-height: 100vh;
            overflow-y: auto;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        
        .dialog-container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 600px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            padding: 32px;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .header {
            margin-bottom: 24px;
        }
        
        .title {
            font-size: 24px;
            font-weight: 600;
            color: #1a202c;
            margin-bottom: 8px;
        }
        
        .subtitle {
            color: #718096;
            font-size: 14px;
        }
        
        .question {
            font-size: 18px;
            color: #2d3748;
            margin-bottom: 8px;
            font-weight: 500;
        }
        
        .context {
            background: #f7fafc;
            border-left: 4px solid #667eea;
            padding: 12px;
            margin-bottom: 24px;
            font-size: 14px;
            color: #4a5568;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            line-height: 1.6;
        }

        /* Markdown styling in context */
        .context strong {
            font-weight: 600;
            color: #2d3748;
        }

        .context code {
            background: #e2e8f0;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
        }

        .context pre {
            background: #2d3748;
            color: #f7fafc;
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 8px 0;
        }

        .context pre code {
            background: transparent;
            color: inherit;
            padding: 0;
        }

        .context ul, .context ol {
            margin-left: 20px;
            margin-top: 8px;
            margin-bottom: 8px;
        }

        .context li {
            margin: 4px 0;
        }

        .context p {
            margin: 8px 0;
        }

        .context h1, .context h2, .context h3 {
            margin-top: 12px;
            margin-bottom: 8px;
            color: #2d3748;
        }

        .context a {
            color: #667eea;
            text-decoration: underline;
        }

        .context blockquote {
            border-left: 3px solid #cbd5e0;
            padding-left: 12px;
            margin: 8px 0;
            color: #718096;
            font-style: italic;
        }

        /* Custom scrollbar for context */
        .context::-webkit-scrollbar {
            width: 8px;
        }

        .context::-webkit-scrollbar-track {
            background: #e2e8f0;
            border-radius: 4px;
        }

        .context::-webkit-scrollbar-thumb {
            background: #cbd5e0;
            border-radius: 4px;
        }

        .context::-webkit-scrollbar-thumb:hover {
            background: #a0aec0;
        }
        
        .options-container {
            margin-bottom: 24px;
        }
        
        .option {
            display: flex;
            align-items: flex-start;
            margin-bottom: 16px;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .option:hover {
            border-color: #667eea;
            background: #f7fafc;
        }
        
        .option.selected {
            border-color: #667eea;
            background: #edf2ff;
        }
        
        .option input {
            margin-right: 12px;
            margin-top: 2px;
            cursor: pointer;
        }
        
        .option-content {
            flex: 1;
        }
        
        .option-label {
            font-weight: 500;
            color: #2d3748;
            margin-bottom: 4px;
        }
        
        .option-description {
            font-size: 14px;
            color: #718096;
        }
        
        .other-section {
            margin-bottom: 24px;
        }
        
        .other-label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            color: #2d3748;
        }
        
        .other-input {
            width: 100%;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.2s;
        }
        
        .other-input:focus {
            outline: none;
            border-color: #667eea;
        }
        
        .button-container {
            display: flex;
            gap: 12px;
        }
        
        .button {
            flex: 1;
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .button-primary {
            background: #667eea;
            color: white;
        }
        
        .button-primary:hover {
            background: #5a67d8;
        }
        
        .button-secondary {
            background: #e2e8f0;
            color: #4a5568;
        }
        
        .button-secondary:hover {
            background: #cbd5e0;
        }
        
        .button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .error-message {
            color: #e53e3e;
            font-size: 14px;
            margin-top: 8px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="dialog-container">
        <div class="header">
            <h1 class="title">Human Input Required</h1>
            <p class="subtitle">An AI agent needs your guidance to continue</p>
        </div>
        
        <div class="question">${this.escapeHtml(request.question)}</div>
        
        ${request.context ? `
        <div class="context">
            <strong>Context:</strong>
            <div id="context-content"></div>
        </div>
        ` : ''}
        
        <div class="options-container">
            ${request.options.map((option, index) => `
                <div class="option" onclick="toggleOption(${index})">
                    <input type="${request.allowMultiple ? 'checkbox' : 'radio'}" 
                           name="options" 
                           id="option-${index}" 
                           value="${this.escapeHtml(option.value)}">
                    <div class="option-content">
                        <div class="option-label">${this.escapeHtml(option.label)}</div>
                        ${option.description ? `
                        <div class="option-description">${this.escapeHtml(option.description)}</div>
                        ` : ''}
                    </div>
                </div>
            `).join('')}
        </div>
        
        ${request.allowOther ? `
        <div class="other-section">
            <label class="other-label" for="other-input">Additional Context (optional):</label>
            <textarea class="other-input"
                      id="other-input"
                      rows="3"
                      placeholder="Provide any additional context, clarifications, or notes to help guide the AI..."></textarea>
        </div>
        ` : ''}
        
        <div class="error-message" id="error-message"></div>
        
        <div class="button-container">
            <button class="button button-secondary" onclick="skipDialog()">Skip</button>
            <button class="button button-primary" onclick="submitResponse()">Submit Response</button>
        </div>
    </div>
    
    <script>
        const dialogId = '${request.id}';
        const allowMultiple = ${request.allowMultiple};
        const allowOther = ${request.allowOther};
        const contextMarkdown = ${request.context ? JSON.stringify(request.context) : 'null'};
        
        function toggleOption(index) {
            const option = document.getElementById('option-' + index);
            const optionDiv = option.closest('.option');
            
            if (!allowMultiple) {
                document.querySelectorAll('.option').forEach(el => {
                    el.classList.remove('selected');
                });
                document.querySelectorAll('input[name="options"]').forEach(el => {
                    el.checked = false;
                });
            }
            
            option.checked = !option.checked;
            if (option.checked) {
                optionDiv.classList.add('selected');
            } else {
                optionDiv.classList.remove('selected');
            }
        }
        
        function getSelectedValues() {
            const selected = [];
            document.querySelectorAll('input[name="options"]:checked').forEach(el => {
                selected.push(el.value);
            });
            return selected;
        }
        
        async function submitResponse() {
            const selectedValues = getSelectedValues();
            const otherText = allowOther ? document.getElementById('other-input').value.trim() : '';

            if (selectedValues.length === 0 && !otherText) {
                showError('Please select at least one option and/or provide additional context');
                return;
            }
            
            try {
                const response = await fetch(\`/dialog/\${dialogId}/response\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selectedValues, otherText })
                });
                
                if (response.ok) {
                    showSuccess();
                } else {
                    showError('Failed to submit response. Please try again.');
                }
            } catch (error) {
                showError('Network error. Please check your connection.');
            }
        }
        
        async function skipDialog() {
            try {
                const response = await fetch(\`/dialog/\${dialogId}/response\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selectedValues: [], otherText: 'SKIPPED' })
                });
                
                if (response.ok) {
                    showSuccess('Response skipped');
                }
            } catch (error) {
                showError('Failed to skip. Please try again.');
            }
        }
        
        function showError(message) {
            const errorEl = document.getElementById('error-message');
            errorEl.textContent = message;
            errorEl.style.display = 'block';
            setTimeout(() => {
                errorEl.style.display = 'none';
            }, 5000);
        }
        
        function showSuccess(message = 'Response submitted successfully!') {
            document.querySelector('.dialog-container').innerHTML = \`
                <div style="text-align: center; padding: 48px;">
                    <div style="font-size: 48px; margin-bottom: 16px;">✓</div>
                    <h2 style="font-size: 24px; color: #2d3748; margin-bottom: 8px;">\${message}</h2>
                    <p style="color: #718096;">You can close this window now.</p>
                </div>
            \`;
            setTimeout(() => {
                window.close();
            }, 2000);
        }
        
        // Allow Enter key to submit when other input is focused
        if (allowOther) {
            document.getElementById('other-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                    submitResponse();
                }
            });
        }

        // Note: Sound notification is played from the server before opening the browser
        // No client-side sound needed

        // Render markdown in context
        if (contextMarkdown && typeof marked !== 'undefined') {
            const contextElement = document.getElementById('context-content');
            if (contextElement) {
                try {
                    // Configure marked for safe HTML rendering
                    marked.setOptions({
                        breaks: true,
                        gfm: true
                    });
                    contextElement.innerHTML = marked.parse(contextMarkdown);
                } catch (error) {
                    // Fallback to plain text if markdown parsing fails
                    contextElement.textContent = contextMarkdown;
                }
            }
        }
    </script>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  async initialize(): Promise<number> {
    if (this.isInitialized) {
      return this.port;
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr !== null ? addr.port : this.port;
        this.isInitialized = true;
        console.error(`Dialog server running on port ${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  async showDialog(request: DialogRequest): Promise<DialogResponse> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const dialogId = request.id || uuidv4();
      const fullRequest = { ...request, id: dialogId };

      let timeout: NodeJS.Timeout | undefined;
      if (request.timeout) {
        timeout = setTimeout(() => {
          this.pendingDialogs.delete(dialogId);
          reject(new Error('Dialog timeout'));
        }, request.timeout);
      }

      this.pendingDialogs.set(dialogId, {
        request: fullRequest,
        resolve,
        reject,
        timeout
      });

      const dialogUrl = `http://localhost:${this.port}/dialog/${dialogId}`;
      console.error(`Opening dialog: ${dialogUrl}`);

      // Play notification sound from server before opening browser
      this.playNotificationSound();

      open(dialogUrl).catch((err) => {
        console.error('Failed to open browser:', err);
        console.error(`Please manually open: ${dialogUrl}`);
      });
    });
  }

  private playNotificationSound(): void {
    try {
      // Path to bundled notification sound (relative to dist folder) - used as fallback
      const bundledSound = path.join(__dirname, '..', 'sounds', 'notification.wav');

      if (process.platform === 'win32') {
        // Windows: Try system sound first, then fall back to bundled sound
        const systemSound = 'C:\\Windows\\Media\\Windows Notify Messaging.wav';
        const script = `(New-Object Media.SoundPlayer '${systemSound}').PlaySync()`;
        exec(`powershell -c "${script}"`, (error) => {
          if (error) {
            // Fallback to bundled custom sound
            const fallbackScript = `(New-Object Media.SoundPlayer '${bundledSound}').PlaySync()`;
            exec(`powershell -c "${fallbackScript}"`, (err2) => {
              if (err2) {
                // Final fallback to beeps
                const beepScript = '[console]::beep(659,150); [console]::beep(880,200)';
                exec(`powershell -c "${beepScript}"`, () => {
                  process.stdout.write('\x07');
                });
              }
            });
          }
        });
      } else if (process.platform === 'darwin') {
        // macOS: Use system sound, fall back to bundled sound
        exec('afplay /System/Library/Sounds/Glass.aiff', (error) => {
          if (error) {
            exec(`afplay "${bundledSound}"`, () => {
              process.stdout.write('\x07');
            });
          }
        });
      } else {
        // Linux: Try system sound, fall back to bundled sound
        exec(`paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null || paplay "${bundledSound}" 2>/dev/null || beep || echo -en "\\a"`, (error) => {
          if (error) {
            process.stdout.write('\x07');
          }
        });
      }
    } catch (error) {
      // Ultimate fallback: ASCII bell character
      process.stdout.write('\x07');
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.isInitialized = false;
          resolve();
        });
      });
    }
  }
}