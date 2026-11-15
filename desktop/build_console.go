//go:build !(windows && gui)

// 控制台构建（默认）：保留黑窗口，便于查看地址与报错。
// 适合调试与排查启动问题。

package main

// isGUIBuild 表示当前是 GUI 构建（无控制台）。
const isGUIBuild = false
