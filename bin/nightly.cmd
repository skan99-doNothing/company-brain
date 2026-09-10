@echo off
REM Nightly refresh of the index.
REM
REM Register as a scheduled task if you want the index kept current without
REM thinking about it. Everything here is safe to re-run: the indexer skips
REM unchanged files on content hash, so a second run in the same minute costs one
REM directory walk and nothing else.
REM
REM Preflight comes first and is the whole reason this file is not just two npm
REM calls. A task that fires at 3am runs on a machine that may have just woken,
REM resumed, or not finished bringing an interface up, and every step below needs
REM Supabase while the indexer also needs Ollama. Without the wait, one missing
REM network leaves a stack trace per step, which reads as several unrelated bugs
REM rather than one cause. Preflight waits, then gives up without running
REM anything, so a failed night leaves yesterday's index in place.
REM
REM Each step's failure is collected and reprinted as one line at the end,
REM because a marker buried in a log that grows every night is a marker nobody
REM reads.

setlocal

REM %~dp0 is this file's own directory, so the task works wherever the repo lives.
for %%I in ("%~dp0..") do set ORG=%%~fI
set LOG=%ORG%\state\nightly.log
set FAILED=

cd /d "%ORG%" || exit /b 1

echo. >> "%LOG%"
echo ======== %DATE% %TIME% ======== >> "%LOG%"

REM exit /b pops the setlocal scope on its own, so no endlocal before it.
call npm run preflight >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [SKIPPED] dependencies were not reachable, nothing was run >> "%LOG%"
  echo ======== abandoned %TIME% ======== >> "%LOG%"
  exit /b 1
)

call npm run index >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% index

REM After the index, so the score describes the corpus as it now stands.
call npm run eval >> "%LOG%" 2>&1
if errorlevel 1 set FAILED=%FAILED% eval

if not "%FAILED%"=="" echo [FAILED]%FAILED% >> "%LOG%"
if "%FAILED%"=="" echo [OK] every step completed >> "%LOG%"

echo ======== finished %TIME% ======== >> "%LOG%"

REM Checked before endlocal, which would discard FAILED and report success always.
if not "%FAILED%"=="" exit /b 1
exit /b 0
