@echo off
chcp 65001 >nul
if not defined CS_UTF8 (
  set "CS_UTF8=1"
  call "%~f0" %*
  exit /b %errorlevel%
)
setlocal

rem CodeSwitch 一键打包脚本（Windows NSIS 安装包）
rem 前置 Node v24，执行 build + electron-builder

set "PATH=D:\Program\nodejs;%PATH%"
cd /d "%~dp0"

echo ========================================
echo   CodeSwitch 一键打包
echo ========================================
echo.

echo [1/2] 类型检查 + 构建...
call npm run build
if errorlevel 1 (
  echo.
  echo [失败] 构建未通过，请检查上方错误。
  pause
  exit /b 1
)

echo.
echo [2/2] 调用 electron-builder 打包 NSIS 安装包...
call npx electron-builder --win
if errorlevel 1 (
  echo.
  echo [失败] 打包未通过，请检查上方错误。
  pause
  exit /b 1
)

echo.
echo ========================================
echo   打包完成！安装包位于 release\ 目录
echo ========================================
pause
