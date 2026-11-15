@echo off
REM 构建 mdviewer.exe
REM 依赖仓内自带的 Go 工具链（..\.toolchain\go），无需系统安装。
REM
REM 默认产出无窗口 GUI 版，靠托盘交互。
REM 加参数 console 则产出带黑窗口的控制台版（便于排错）。

setlocal
cd /d "%~dp0"

set GOEXE=%~dp0..\.toolchain\go\bin\go.exe
set GOCACHE=%~dp0..\.toolchain\gocache
set GOPATH=%~dp0..\.toolchain\gopath

if not exist "%GOEXE%" (
  echo [错误] 未找到 Go 工具链: %GOEXE%
  echo        请把 go1.x 解压到 .toolchain\go 目录
  exit /b 1
)

set MODE=%1
if /i "%MODE%"=="console" goto console

REM ---------- GUI 版（默认）----------
echo [1/4] 生成图标与资源...
if not exist icon.ico (
  echo       生成 icon.ico...
  pushd "..\tools"
  "%GOEXE%" run ./mkicon/
  popd
)
REM go-winres 只认 PNG，而 mkicon 产出的是 DIB 帧 ICO。
REM 所以先把每帧导出成 PNG 放进 winres\。
if exist "..\tools\pngexport\main.go" (
  pushd "..\tools"
  "%GOEXE%" run ./pngexport/
  popd
)
if exist winres\winres.json (
  if exist "%~dp0..\.toolchain\gopath\bin\go-winres.exe" (
    "%~dp0..\.toolchain\gopath\bin\go-winres.exe" make
    REM 只保留 amd64；386 那份对当前构建无用
    if exist rsrc_windows_386.syso del /q rsrc_windows_386.syso
  ) else (
    echo       未找到 go-winres，跳过资源编译（exe 将没有文件图标）
  )
) else (
  echo       缺少 winres\winres.json，跳过资源编译
)

echo [2/4] 同步前端资源到 embed 目录...
if exist web rmdir /s /q web
mkdir web
xcopy /e /i /q /y "..\index.html" "web\index.html" >nul
xcopy /e /i /q /y "..\styles.css" "web\styles.css" >nul
xcopy /e /i /q /y "..\src" "web\src" >nul
xcopy /e /i /q /y "..\samples" "web\samples" >nul

echo [3/4] 静态检查...
"%GOEXE%" vet -tags gui ./...
if errorlevel 1 (
  echo [错误] vet 未通过
  exit /b 1
)

echo [4/4] 编译 GUI 版（无窗口，托盘交互）...
"%GOEXE%" build -tags gui -trimpath -ldflags "-s -w -H windowsgui" -o mdviewer.exe .
if errorlevel 1 (
  echo [错误] 编译失败
  exit /b 1
)
echo.
echo 构建完成: %~dp0mdviewer.exe  ^(GUI，原生窗口^)
for %%A in (mdviewer.exe) do echo 大小: %%~zA 字节
echo.
echo 交互方式:
echo   双击 exe          打开独立原生窗口（WebView2，无地址栏）
echo   关闭窗口          直接退出进程
echo   托盘图标          窗口关闭后仍有服务在跑时可用
echo.
echo 提示: 排错时用 build.bat console 产出带控制台的版本
goto usage

:console
echo [1/3] 同步前端资源到 embed 目录...
if exist web rmdir /s /q web
mkdir web
xcopy /e /i /q /y "..\index.html" "web\index.html" >nul
xcopy /e /i /q /y "..\styles.css" "web\styles.css" >nul
xcopy /e /i /q /y "..\src" "web\src" >nul
xcopy /e /i /q /y "..\samples" "web\samples" >nul

echo [2/3] 静态检查...
"%GOEXE%" vet ./...
if errorlevel 1 (
  echo [错误] vet 未通过
  exit /b 1
)

echo [3/3] 编译控制台版（保留窗口，可看地址与报错）...
"%GOEXE%" build -trimpath -ldflags "-s -w" -o mdviewer.exe .
if errorlevel 1 (
  echo [错误] 编译失败
  exit /b 1
)
echo.
echo 构建完成: %~dp0mdviewer.exe  ^(控制台^)
for %%A in (mdviewer.exe) do echo 大小: %%~zA 字节

:usage
echo.
echo 命令行参数:
echo   -root D:\docs   指定工作根目录（默认当前目录）
echo   -file a.md      启动后直接打开文件
echo   -port 8080      固定端口（默认随机）
echo   -no-open        不创建窗口（脚本/调试用）
echo   -console        强制启用控制台输出
echo   -tray           强制启用托盘

endlocal
