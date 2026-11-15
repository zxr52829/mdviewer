//go:build windows && gui

// 内嵌图标字节。
//
// 单独成文件的原因：go:embed 要求被嵌文件在同一包目录下，
// 把 embed 声明放在这里，windowicon_windows.go 只管解析与设置。

package main

import _ "embed"

//go:embed icon.ico
var iconICO []byte
