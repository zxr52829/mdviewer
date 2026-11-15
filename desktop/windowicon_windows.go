//go:build windows && gui

// 窗口与任务栏图标的运行时设置。
//
// 为什么不在 exe 里嵌资源节：Windows 资源目录里的数据项存的是
// 「相对 .rsrc 节起点的 RVA」，链接器合并 .syso 时会移动这个节，
// 但不会重写手写在资源目录里的 RVA，结果就是资源结构合法、
// 图标却指向错误位置，系统静默回退到默认图标。
// 正规做法要用 windres 生成带重定位信息的 .syso，本机没有该工具链。
//
// 这条运行时路线不依赖资源节：图标字节直接编进二进制，
// 启动时解析 ICO → 转 HICON → WM_SETICON，效果等价。

package main

import (
	"encoding/binary"
	"unsafe"
)

// dlgUser32 在 filedialog_windows.go 里声明，这里复用以避免重复加载 DLL。

var (
	procCreateIconFromResourceEx = dlgUser32.NewProc("CreateIconFromResourceEx")
	procSendMessageW             = dlgUser32.NewProc("SendMessageW")
)

const (
	wmSetIcon      = 0x0080
	iconSmall      = 0 // 标题栏 / 任务栏小视图
	iconBig        = 1 // Alt+Tab 大视图
	lrDefaultColor = 0x00000000
)

type icoEntry struct {
	size   int
	offset int
	length int
}

// parseICODir 解析 ICO 目录项。
func parseICODir(data []byte) []icoEntry {
	if len(data) < 6 {
		return nil
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	if count <= 0 || len(data) < 6+count*16 {
		return nil
	}
	out := make([]icoEntry, 0, count)
	for i := 0; i < count; i++ {
		b := data[6+i*16:]
		w := int(b[0])
		if w == 0 {
			w = 256
		}
		length := int(binary.LittleEndian.Uint32(b[8:12]))
		offset := int(binary.LittleEndian.Uint32(b[12:16]))
		if length <= 0 || offset <= 0 || offset+length > len(data) {
			continue
		}
		out = append(out, icoEntry{size: w, offset: offset, length: length})
	}
	return out
}

// hicFromICO 从 ICO 字节里按尺寸创建 HICON。
//
// 帧必须是 DIB（mkicon 已按 DIB 生成）；PNG 帧 CreateIconFromResourceEx
// 不接受，遇到就跳过。want=0 表示取最后一帧（通常是最大的）。
func hicFromICO(data []byte, want int) uintptr {
	entries := parseICODir(data)
	if len(entries) == 0 {
		return 0
	}

	pick := entries[len(entries)-1]
	if want > 0 {
		for _, e := range entries {
			if e.size == want {
				pick = e
				break
			}
		}
	}

	frame := data[pick.offset : pick.offset+pick.length]
	if frame[0] == 0x89 && len(frame) > 2 && frame[1] == 'P' {
		return 0 // PNG 帧，放弃
	}

	h, _, _ := procCreateIconFromResourceEx.Call(
		uintptr(unsafe.Pointer(&frame[0])),
		uintptr(len(frame)),
		1,          // fIcon = TRUE
		0x00030000, // dwVer，固定值
		0,          // cxDesired=0 表示用资源自带尺寸
		0,          // cyDesired
		lrDefaultColor,
	)
	return h
}

// applyWindowIcon 给窗口设置大小图标。
//
// 失败静默：图标缺失不该影响程序可用性。
func applyWindowIcon(hwnd uintptr) {
	if hwnd == 0 || len(iconICO) == 0 {
		return
	}
	// 小图标取 32（16 在高 DPI 下偏小），大图标取最大帧
	if h := hicFromICO(iconICO, 32); h != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, h)
	}
	if h := hicFromICO(iconICO, 0); h != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, h)
	}
}
