@echo off
rem R15 sterile-profile launch of the INSTALLED production-channel CodeForge 0.4.0.
rem Fresh user-data dir + scrubbed provider/dev env = what a stranger's machine looks like:
rem no prior session, no API keys, no developer variables, no local dev server.
set CODEFORGE_SMOKE_OUT=G:\CodeForge\docs\evidence\r15-native-first-run-free-closure\smoke\launch.markers.log
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set NODE_PATH=
set OPENROUTER_API_KEY=
set GROQ_API_KEY=
set GEMINI_API_KEY=
set GOOGLE_API_KEY=
set ANTHROPIC_API_KEY=
set OPENAI_API_KEY=
set MISTRAL_API_KEY=
set CLOUDFLARE_API_KEY=
set CLOUDFLARE_ACCOUNT_ID=
set CEREBRAS_API_KEY=
set OLLAMA_API_KEY=
set OLLAMA_BASE_URL=
set ZAI_API_KEY=
set OPEN_CODE_API_KEY=
set OPENCODE_API_KEY=
set CODEFORGE_CLOUD_URL=
set FORGEREMS_ANTHROPIC_MODEL=
set FORGEREMS_GEMINI_MODEL=
set FORGEREMS_GEMINI_API_KEY=
set FORGEREMS_OPENAI_API_KEY=
set FORGEREMS_OPENAI_BASE_URL=
set FORGEREMS_OPENAI_MODEL=
set FORGEREMS_OLLAMA_MODEL=
set FORGEREMS_OLLAMA_BASE_URL=
set FORGEREMS_KYRA_PROVIDER_PRIORITY=
set KYRABLOX_OPENAI_API_KEY=
"C:\Users\Daddy_FDS\AppData\Local\Programs\codeforge-desktop\CodeForge.exe" --user-data-dir=G:\CodeForge\docs\evidence\r15-native-first-run-free-closure\sterile-profile > "G:\CodeForge\docs\evidence\r15-native-first-run-free-closure\smoke\launch.stdout.log" 2>&1
echo EXIT=%ERRORLEVEL% > "G:\CodeForge\docs\evidence\r15-native-first-run-free-closure\smoke\launch.exit"
