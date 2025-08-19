# Example Usage Scenarios

## 1. Ambiguous File Selection

```json
{
  "tool": "ask_human",
  "arguments": {
    "question": "I found multiple index files. Which one should I modify?",
    "options": [
      {
        "label": "src/index.ts",
        "value": "src/index.ts",
        "description": "Main TypeScript entry point"
      },
      {
        "label": "public/index.html",
        "value": "public/index.html",
        "description": "HTML template file"
      },
      {
        "label": "dist/index.js",
        "value": "dist/index.js",
        "description": "Compiled JavaScript (build output)"
      }
    ],
    "allowMultiple": false,
    "allowOther": true,
    "context": "User asked to 'update the index file' but didn't specify which one"
  }
}
```

## 2. Deployment Confirmation

```json
{
  "tool": "ask_human",
  "arguments": {
    "question": "Ready to deploy to production. Should I proceed?",
    "options": [
      {
        "label": "Yes, deploy now",
        "value": "deploy",
        "description": "Deploy immediately to production"
      },
      {
        "label": "Run tests first",
        "value": "test-first",
        "description": "Run the test suite before deploying"
      },
      {
        "label": "Deploy to staging",
        "value": "staging",
        "description": "Deploy to staging environment instead"
      },
      {
        "label": "Cancel deployment",
        "value": "cancel",
        "description": "Do not deploy at this time"
      }
    ],
    "allowMultiple": false,
    "allowOther": false,
    "context": "All tests passed, build successful, last deployment was 3 days ago",
    "timeout": 60000
  }
}
```

## 3. Code Style Preference

```json
{
  "tool": "ask_human",
  "arguments": {
    "question": "Which naming convention should I use for the new API endpoints?",
    "options": [
      {
        "label": "camelCase",
        "value": "camelCase",
        "description": "getUserData, createNewPost"
      },
      {
        "label": "kebab-case",
        "value": "kebab-case",
        "description": "get-user-data, create-new-post"
      },
      {
        "label": "snake_case",
        "value": "snake_case",
        "description": "get_user_data, create_new_post"
      }
    ],
    "allowMultiple": false,
    "allowOther": true,
    "context": "Creating REST API endpoints for the user service"
  }
}
```

## 4. Multiple File Selection

```json
{
  "tool": "ask_human",
  "arguments": {
    "question": "Which test files should I run?",
    "options": [
      {
        "label": "Unit tests",
        "value": "unit",
        "description": "src/__tests__/*.test.ts"
      },
      {
        "label": "Integration tests",
        "value": "integration",
        "description": "tests/integration/*.spec.ts"
      },
      {
        "label": "E2E tests",
        "value": "e2e",
        "description": "tests/e2e/*.test.ts"
      },
      {
        "label": "Performance tests",
        "value": "performance",
        "description": "tests/performance/*.bench.ts"
      }
    ],
    "allowMultiple": true,
    "allowOther": false,
    "context": "Preparing for release, multiple test suites available"
  }
}
```

## 5. Error Resolution Strategy

```json
{
  "tool": "ask_human",
  "arguments": {
    "question": "TypeScript compilation failed with 15 errors. How should I proceed?",
    "options": [
      {
        "label": "Fix all errors now",
        "value": "fix-all",
        "description": "Attempt to fix all TypeScript errors"
      },
      {
        "label": "Fix critical errors only",
        "value": "fix-critical",
        "description": "Fix only errors that prevent compilation"
      },
      {
        "label": "Add @ts-ignore comments",
        "value": "ignore",
        "description": "Suppress errors with ignore comments"
      },
      {
        "label": "Show me the errors",
        "value": "show",
        "description": "Display all errors for review"
      }
    ],
    "allowMultiple": false,
    "allowOther": true,
    "context": "Errors are mostly related to type mismatches and missing type definitions"
  }
}
```

## Response Examples

### Successful Selection Response
```json
{
  "success": true,
  "timestamp": 1703001234567,
  "response": "src/index.ts",
  "responseType": "selection"
}
```

### Multiple Selection Response
```json
{
  "success": true,
  "timestamp": 1703001234567,
  "response": ["unit", "integration"],
  "responseType": "selection"
}
```

### Custom Input Response
```json
{
  "success": true,
  "timestamp": 1703001234567,
  "response": "Use PascalCase for classes and camelCase for methods",
  "responseType": "custom"
}
```

### Skipped Response
```json
{
  "success": true,
  "timestamp": 1703001234567,
  "skipped": true,
  "response": "User skipped this question"
}
```

### Timeout Response
```json
{
  "success": false,
  "error": "timeout",
  "message": "The user did not respond within the timeout period"
}
```