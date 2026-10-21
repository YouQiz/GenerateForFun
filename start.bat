@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   nailong_play - 奶龙换脸
echo   ------------------------------------
echo   地址: http://127.0.0.1:8080
echo   关闭本窗口即停止本地服务
echo.

start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:8080/"

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8080 --bind 127.0.0.1
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8080 --bind 127.0.0.1
  goto :eof
)

echo 未找到 Python，尝试使用 Node.js ...
where npx >nul 2>nul
if %errorlevel%==0 (
  npx --yes http-server . -p 8080 -a 127.0.0.1
  goto :eof
)

echo.
echo 没有找到可用的本地静态服务器。
echo 请安装 Python 3（https://www.python.org/）后重试，
echo 或手动执行:  python -m http.server 8080 --bind 127.0.0.1
echo.
pause
