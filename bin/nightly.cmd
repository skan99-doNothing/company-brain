@echo off
REM Nightly refresh of the brain.
REM
REM Register as a scheduled task if you want the index kept current without
REM thinking about it. Everything here is safe to re-run: the indexer skips
REM unchanged files on content hash, the Codex ingester skips sessions it has
REM already stored, and the map is generated from scratch each time.
REM
REM Order matters. Documents first, so links resolve against a complete map and
REM the correlation rebuild averages the chunks that exist at the end. Codex
REM sessions next, because they are independent of the document index. The eval
REM after both, so its score describes the corpus as it now stands. The map last,
REM since it reads every number the steps above produced.
REM
REM Preflight comes first and is the whole reason this file is not just a list of
REM npm calls. A task that fires at 3am runs on a machine that may have just
REM woken, resumed, or not finished bringing an interface up, and every step
REM below needs the database while the indexer also needs Ollama. Without the
REM wait, one missing network leaves a stack trace per step, which reads as
REM several unrelated bugs rather than one cause, and a real failure in a later
REM step hides underneath them. Preflight waits, then gives up without running
REM anything, so a failed night leaves yesterday's index and map in place.
REM
REM Each step's failure is collected and reprinted as one line at the end,
REM because a marker buried in a log that grows every night is a marker nobody
REM reads.

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
