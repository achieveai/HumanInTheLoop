@echo off
echo ========================================
echo  HITL MCP Server - Simple Test
echo ========================================
echo.

cd hitl-mcp-server

echo Running the built-in test client...
echo This will open dialogs in your browser.
echo.

npm run test:dialog

pause