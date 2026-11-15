//go:build windows && gui

// 原生窗口外壳。
//
// 为什么不用"打开系统浏览器"：默认浏览器带地址栏、书签栏、标签页，
// 用户一眼就知道自己在浏览器里，不像桌面应用；而且会污染他原有的
// 浏览器会话与窗口。这里用 WebView2 起一个自己的窗口，界面只有页面本身。
//
// 依赖：WebView2 运行时（Win10/11 通常随 Edge 预装，本机已确认存在）。
// 注意 WebView2 只能在主线程创建并跑消息循环，所以 Run 会阻塞调用方。

package main

import (
	"fmt"
	"runtime"

	webview "github.com/jchv/go-webview2"
)

// 窗口图标由 applyWindowIcon 在窗口创建后设置（见 windowicon_windows.go）。
// 不走 exe 资源节：手写 .syso 的 RVA 不会被链接器重定位，图标会失效。

// runWindow 打开原生窗口并加载 url，直到用户关闭窗口为止。
// 返回 nil 表示用户正常关窗；返回错误表示无法创建窗口（调用方应回退到浏览器）。
func runWindow(url, title string, width, height int) error {
	// WebView2 的 COM 与窗口消息循环必须在同一个 OS 线程上。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	w := webview.NewWithOptions(webview.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview.WindowOptions{
			Title:  title,
			Width:  uint(width),
			Height: uint(height),
			Center: true,
		},
	})
	if w == nil {
		return fmt.Errorf("创建 WebView2 窗口失败（可能未安装 WebView2 运行时）")
	}
	defer w.Destroy()

	// 必须在 Run 之前设置：Run 会进入阻塞的消息循环。
	if hwnd := w.Window(); hwnd != nil {
		applyWindowIcon(uintptr(hwnd))
	}

	w.Navigate(url)
	w.Run()
	return nil
}

// openBrowserFallback 是窗口不可用时的退路：交给系统默认浏览器。
func openBrowserFallback(url string) {
	openBrowser(url)
}
