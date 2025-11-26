@echo off
echo ========================================
echo    TiagoX Finder - Avvio Automatico
echo ========================================
echo.

echo [1/3] Installazione dipendenze frontend...
call npm install
if %errorlevel% neq 0 (
    echo ERRORE: Installazione frontend fallita!
    pause
    exit /b 1
)

echo.
echo [2/3] Installazione dipendenze backend...
cd server
call npm install
if %errorlevel% neq 0 (
    echo ERRORE: Installazione backend fallita!
    pause
    exit /b 1
)

echo.
echo [3/3] Avvio servizi...
echo.
echo Avviando backend server su http://localhost:3000...
start "Backend Server" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul

cd ..
echo Avviando frontend su http://localhost:5173...
start "Frontend Dev Server" cmd /k "npm run dev"

echo.
echo ========================================
echo   Servizi avviati con successo!
echo ========================================
echo   Frontend: http://localhost:5173/
echo   Backend:  http://localhost:3000/
echo ========================================
echo.
echo Premi un tasto per aprire il browser...
pause >nul

start http://localhost:5173/

echo.
echo Script completato. I server sono in esecuzione in finestre separate.
echo Chiudi questo terminale quando hai finito.
pause