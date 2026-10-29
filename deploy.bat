@echo off
echo Deploying NextFounder WITH functions...
netlify deploy --prod --dir=. --functions=netlify/functions
pause
