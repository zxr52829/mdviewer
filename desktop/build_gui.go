//go:build windows && gui

// GUI 构建标签版：无控制台窗口，靠托盘交互。
// 构建方式：go build -tags gui -ldflags "-H windowsgui"

package main

// isGUIBuild 表示当前是 GUI 构建（无控制台）。
const isGUIBuild = true
