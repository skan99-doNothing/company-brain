@echo off
REM Nightly refresh of the company brain.
REM
REM Registered as the scheduled task "Org brain nightly". Everything here is
REM already safe to re-run: the indexer skips unchanged files on content hash,
REM the Codex ingester skips sessions it has already stored, and the map is
REM generated from scratch each time.
REM
REM Order matters. Documents first so links resolve against a complete map and
REM the correlation rebuild averages the chunks that exist at the end. Codex
REM sessions next, because they are independent of the document index. The eval
REM after both, so its score describes the corpus as it now stands. The map last,
REM since it reads every number the three steps above produced.
REM
REM Preflight comes before all of it. On 9 September the run started while the
REM machine had no DNS and every Supabase step failed in turn, so one cause left
REM four stack traces in this log and a real bug in the Codex step hid underneath
REM them for two days. Preflight waits for Supabase and Ollama and gives up
REM without running anything, which leaves yesterday's index and map in place.
REM
REM Every step's failure is collected and reprinted as one line at the end. The
REM per-step [FAILED] markers were already here and nothing ever read them,
REM because finding them meant scrolling a log that grows every night.

setlocal
REM Point this at your own checkout, or set ORG in the environment first.
if not defined ORG set ORG=%~dp0..
set LOG=%ORG%\state\nightly.log
set FAILED=

cd /d "%ORG%" || exit /b 1

echo. >> "%LOG%"
echo ======== %DATE% %TIME% ======== >> "%LOG%"

call npm run preflight >> "%LOG%" 2>&1
REM exit /b pops the setlocal scope on its own, so no endlocal before it.
if errorlevel 1 (
  echo [SKIPPED] dependencies were not reachable, nothing was run >> "%LOG%"
  echo ======== abandoned %TIME% ======== >> "%LOG%"
  exit /b 1
)

call npm run index >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% index

call npm run codex >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% codex

call npm run entities >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% entities

call npm run eval >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% eval

call npm run map >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% map

REM Last, so it sees the state everything above just produced.
call npm run supervise >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% supervise

if not "%FAILED%"=="" echo [FAILED]%FAILED% >> "%LOG%"
if "%FAILED%"=="" echo [OK] every step completed >> "%LOG%"

echo ======== finished %TIME% ======== >> "%LOG%"

REM The exit code is checked before endlocal, because endlocal would discard
REM FAILED and every run would then report success.
if not "%FAILED%"=="" exit /b 1
exit /b 0
