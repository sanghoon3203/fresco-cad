@echo off
goto FRESCO_CAPTURE
REM #jww
REM #cd
REM #hf
REM #h1
REM #hc 【Fresco Capture】診断用に選択データを保存します（図面は変更しません）
REM #g1
REM #e
:FRESCO_CAPTURE
if not defined LOCALAPPDATA exit /b 2
set "FRESCO_CAPTURE_ROOT=%LOCALAPPDATA%\FrescoCAD\jw-captures"
set "FRESCO_JW_EXE=C:\jww\JW_WIN.EXE"
if defined FRESCO_JW_EXE_PATH set "FRESCO_JW_EXE=%FRESCO_JW_EXE_PATH%"
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0Capture-JwTemp.ps1" -SourcePath "%~dp0JWC_TEMP.TXT" -CaptureRoot "%FRESCO_CAPTURE_ROOT%" -JwExePath "%FRESCO_JW_EXE%" -WrapperPath "%~f0"
exit /b %ERRORLEVEL%
