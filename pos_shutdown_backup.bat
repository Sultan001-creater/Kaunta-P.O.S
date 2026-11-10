@echo off
:: ============================================================
::  POS SQLite Shutdown Backup Script
::  - Runs automatically when Windows shuts down
::  - Saves timestamped backup to local/external drive
::  - Keeps last 7 days of backups
::  - Logs every backup attempt to a log file
:: ============================================================

:: ---- CONFIGURATION (edit these) ----------------------------
set DB_PATH=C:\Users\Elvis\OneDrive\Elvis - Personal\Tosscoin POS\sultan_pos\database.sqlite
set BACKUP_DIR=C:\POS_Backups
set LOG_FILE=C:\POS_Backups\backup_log.txt
set KEEP_DAYS=365
:: ------------------------------------------------------------

:: Create backup directory if it doesn't exist
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Build timestamp
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set YEAR=%DT:~0,4%
set MONTH=%DT:~4,2%
set DAY=%DT:~6,2%
set HOUR=%DT:~8,2%
set MIN=%DT:~10,2%
set TIMESTAMP=%YEAR%-%MONTH%-%DAY%_%HOUR%-%MIN%

set BACKUP_FILE=%BACKUP_DIR%\pos_backup_%TIMESTAMP%.sqlite

:: Log start
echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] Shutdown backup started... >> "%LOG_FILE%"

:: Check if DB file exists
if not exist "%DB_PATH%" (
    echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] ERROR: Database not found at %DB_PATH% >> "%LOG_FILE%"
    exit /b 1
)

:: Check if backup drive is available
if not exist "%BACKUP_DIR%" (
    echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] ERROR: Backup drive not found. Is it plugged in? >> "%LOG_FILE%"
    exit /b 1
)

:: Copy the SQLite database
copy /Y "%DB_PATH%" "%BACKUP_FILE%"

if %ERRORLEVEL% EQU 0 (
    echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] SUCCESS: Backup saved to %BACKUP_FILE% >> "%LOG_FILE%"
) else (
    echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] ERROR: Backup FAILED during copy. >> "%LOG_FILE%"
    exit /b 1
)

:: Delete backups older than KEEP_DAYS
forfiles /P "%BACKUP_DIR%" /M "pos_backup_*.sqlite" /D -%KEEP_DAYS% /C "cmd /c del @path" 2>nul
echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] Old backups cleaned (kept last %KEEP_DAYS% days). >> "%LOG_FILE%"
echo [%YEAR%-%MONTH%-%DAY% %HOUR%:%MIN%] ---------------------------------------- >> "%LOG_FILE%"

exit /b 0