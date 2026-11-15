//go:build !(windows && gui)

// 非 GUI 构建（控制台）不提供原生窗口：直接走系统浏览器。
// 这里保留同名函数，让 main.go 无需区分构建标签。

package main

import "fmt"

// runWindow 在控制台构建里恒失败，调用方会回退到浏览器。
func runWindow(url, title string, width, height int) error {
	return fmt.Errorf("控制台构建不提供原生窗口")
}

// openBrowserFallback 控制台构建直接用系统浏览器。
func openBrowserFallback(url string) {
	openBrowser(url)
}
