@echo off
REM EKAP Data Hub - Windows tek tik baslatici
REM Bu dosyaya cift tiklayin. Ilk acilista bagimliliklari kurar, sonra paneli acar.

setlocal
cd /d "%~dp0"

echo === EKAP Data Hub baslatiliyor ===

REM Node kontrolu
where node >nul 2>&1
if errorlevel 1 (
  echo HATA: Node.js bulunamadi. Kurun: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

REM .env yoksa ornekten olustur
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo .env dosyasi .env.example'dan olusturuldu. Gerekirse MONGODB_URI degerini duzenleyin.
  )
)

REM Kok bagimliliklar
if not exist "node_modules" (
  echo Bagimliliklar kuruluyor ^(npm install^)...
  call npm install
)

REM ekap-v3 bagimliliklari + Playwright
if exist "ekap-v3" (
  if not exist "ekap-v3\node_modules" (
    echo ekap-v3 bagimliliklari kuruluyor...
    pushd ekap-v3
    call npm install
    call npx playwright install chromium
    popd
  )
)

REM Docker varsa ve mongo konteyneri yoksa baslat
where docker >nul 2>&1
if not errorlevel 1 (
  docker ps --format "{{.Names}}" | findstr /x "ekap-mongo" >nul 2>&1
  if errorlevel 1 (
    docker ps -a --format "{{.Names}}" | findstr /x "ekap-mongo" >nul 2>&1
    if errorlevel 1 (
      docker run -d --name ekap-mongo -p 27017:27017 mongo:7 >nul 2>&1
    ) else (
      docker start ekap-mongo >nul 2>&1
    )
  )
)

REM Panel acildiktan sonra tarayiciyi ac
start "" /min cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8787"

echo Web panel baslatiliyor -^> http://127.0.0.1:8787
echo (Durdurmak icin bu pencerede Ctrl+C)
call npm run web

pause
