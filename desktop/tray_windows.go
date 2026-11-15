//go:build windows

// Windows 托盘图标。
//
// 无窗口构建（-H windowsgui）没有控制台，用户既看不到地址也无法关闭进程，
// 所以必须有托盘作为唯一交互入口：双击重开浏览器、右键菜单打开/退出。
//
// 实现走纯 syscall 调 Win32，不引入第三方依赖：
//   Shell_NotifyIconW  托盘图标增删改
//   CreatePopupMenu / TrackPopupMenu  右键菜单
//   RegisterClassExW / CreateWindowExW  隐藏的消息窗口（接收托盘回调）
//   GetMessageW / DispatchMessageW      消息循环
//
// 所有调用都在独立的 OS 线程上跑（main 里 LockOSThread），
// 因为窗口消息队列与线程绑定。

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

/* ---------------- Win32 常量 ---------------- */

const (
	WM_USER         = 0x0400
	WM_TRAYICON     = WM_USER + 1
	WM_COMMAND      = 0x0111
	WM_DESTROY      = 0x0002
	WM_LBUTTONDBLCLK = 0x0203
	WM_RBUTTONUP    = 0x0205

	NIM_ADD    = 0x00000000
	NIM_MODIFY = 0x00000001
	NIM_DELETE = 0x00000002

	NIF_MESSAGE = 0x00000001
	NIF_ICON    = 0x00000002
	NIF_TIP     = 0x00000004

	MF_STRING   = 0x00000000
	MF_SEPARATOR = 0x00000800

	TPM_RIGHTBUTTON = 0x0002
	TPM_NONOTIFY    = 0x0080
	TPM_RETURNCMD   = 0x0100

	IDM_OPEN  = 1001
	IDM_QUIT  = 1002
	IDM_COPY  = 1003

	IMAGE_ICON    = 1
	LR_LOADFROMFILE = 0x0010
	LR_DEFAULTSIZE  = 0x0040

	IDI_APPLICATION = 32512
)

/* ---------------- DLL ---------------- */

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")

	procRegisterClassExW  = user32.NewProc("RegisterClassExW")
	procCreateWindowExW   = user32.NewProc("CreateWindowExW")
	procDefWindowProcW    = user32.NewProc("DefWindowProcW")
	procDestroyWindow     = user32.NewProc("DestroyWindow")
	procGetMessageW       = user32.NewProc("GetMessageW")
	procTranslateMessage  = user32.NewProc("TranslateMessage")
	procDispatchMessageW  = user32.NewProc("DispatchMessageW")
	procPostQuitMessage   = user32.NewProc("PostQuitMessage")
	procCreatePopupMenu   = user32.NewProc("CreatePopupMenu")
	procAppendMenuW       = user32.NewProc("AppendMenuW")
	procTrackPopupMenu    = user32.NewProc("TrackPopupMenu")
	procDestroyMenu       = user32.NewProc("DestroyMenu")
	procGetCursorPos      = user32.NewProc("GetCursorPos")
	procSetForegroundWnd  = user32.NewProc("SetForegroundWindow")
	procLoadIconW         = user32.NewProc("LoadIconW")
	procPostMessageW      = user32.NewProc("PostMessageW")

	procShellNotifyIconW  = shell32.NewProc("Shell_NotifyIconW")

	procGetModuleHandleW  = kernel32.NewProc("GetModuleHandleW")
	procMessageBoxW       = user32.NewProc("MessageBoxW")
)

/* ---------------- 结构体 ---------------- */

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         syscall.Handle
	hCursor       syscall.Handle
	hbrBackground syscall.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       syscall.Handle
}

type point struct {
	X, Y int32
}

type msg struct {
	Hwnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type notifyIconData struct {
	CbSize           uint32
	HWnd             syscall.Handle
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            syscall.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         [16]byte
	HBalloonIcon     syscall.Handle
}

/* ---------------- 托盘 ---------------- */

// tray 持有托盘运行所需状态。
type tray struct {
	hwnd     syscall.Handle
	url      string // 双击时重新打开的地址
	onQuit   func()
	iconData notifyIconData
	ready    bool
}

func utf16Ptr(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		return nil
	}
	return p
}

func copyUTF16(dst []uint16, s string) {
	src := utf16FromString(s)
	n := len(src)
	if n > len(dst) {
		n = len(dst)
	}
	copy(dst[:n], src[:n])
	// 保证结尾为 0
	if n == len(dst) {
		dst[len(dst)-1] = 0
	}
}

func utf16FromString(s string) []uint16 {
	out := make([]uint16, 0, len(s)+1)
	for _, r := range s {
		if r < 0x10000 {
			out = append(out, uint16(r))
		} else {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		}
	}
	out = append(out, 0)
	return out
}

var (
	activeTray *tray
	trayWndProc = syscall.NewCallback(func(hwnd syscall.Handle, m uint32, wp, lp uintptr) uintptr {
		t := activeTray
		if t == nil {
			r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(m), wp, lp)
			return r
		}

		switch m {
		case WM_TRAYICON:
			switch lp {
			case WM_LBUTTONDBLCLK:
				openBrowser(t.url)
			case WM_RBUTTONUP:
				t.showMenu()
			}
			return 0
		case WM_COMMAND:
			switch wp & 0xFFFF {
			case IDM_OPEN:
				openBrowser(t.url)
			case IDM_COPY:
				copyToClipboard(t.url)
			case IDM_QUIT:
				if t.onQuit != nil {
					t.onQuit()
				}
			}
			return 0
		case WM_DESTROY:
			procPostQuitMessage.Call(0)
			return 0
		}

		r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(m), wp, lp)
		return r
	})
)

// startTray 创建托盘图标并进入消息循环。
// 该函数会阻塞，应在独立 goroutine 中调用，且该 goroutine 需锁定线程。
func startTray(url string, onQuit func()) error {
	runtime.LockOSThread()

	t := &tray{url: url, onQuit: onQuit}
	activeTray = t

	hInst, _, _ := procGetModuleHandleW.Call(0)
	className := utf16Ptr("mdviewerTrayWnd")

	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   trayWndProc,
		hInstance:     syscall.Handle(hInst),
		lpszClassName: className,
	}
	if r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		return fmt.Errorf("RegisterClassEx 失败: %v", err)
	}

	// 隐藏窗口：只用于接收托盘回调，不显示
	hwnd, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		0,
		0, 0, 0, 0, 0, 0,
		0, hInst, 0,
	)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowEx 失败: %v", err)
	}
	t.hwnd = syscall.Handle(hwnd)

	// 图标：用系统默认应用图标，避免额外资源文件
	hIcon, _, _ := procLoadIconW.Call(0, IDI_APPLICATION)

	nid := notifyIconData{
		HWnd:             t.hwnd,
		UID:              1,
		UFlags:           NIF_MESSAGE | NIF_ICON | NIF_TIP,
		UCallbackMessage: WM_TRAYICON,
		HIcon:            syscall.Handle(hIcon),
	}
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	copyUTF16(nid.SzTip[:], "mdviewer — 双击打开，右键菜单")

	if r, _, e := procShellNotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid))); r == 0 {
		return fmt.Errorf("Shell_NotifyIcon 添加失败: %v", e)
	}
	t.iconData = nid
	t.ready = true

	// 消息循环
	var m msg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}

	t.remove()
	return nil
}

func (t *tray) showMenu() {
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)

	appendMenu(hMenu, MF_STRING, IDM_OPEN, "打开 mdviewer")
	appendMenu(hMenu, MF_STRING, IDM_COPY, "复制访问地址")
	appendMenu(hMenu, MF_SEPARATOR, 0, "")
	appendMenu(hMenu, MF_STRING, IDM_QUIT, "退出")

	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))

	// 必须前置窗口，否则菜单点击外部不会消失
	procSetForegroundWnd.Call(uintptr(t.hwnd))

	cmd, _, _ := procTrackPopupMenu.Call(
		hMenu,
		TPM_RIGHTBUTTON|TPM_NONOTIFY|TPM_RETURNCMD,
		uintptr(pt.X), uintptr(pt.Y),
		0, uintptr(t.hwnd), 0,
	)

	if cmd != 0 {
		procPostMessageW.Call(uintptr(t.hwnd), WM_COMMAND, cmd, 0)
	}
}

func appendMenu(hMenu uintptr, flags uintptr, id uintptr, text string) {
	var p *uint16
	if text != "" {
		p = utf16Ptr(text)
	}
	procAppendMenuW.Call(hMenu, flags, id, uintptr(unsafe.Pointer(p)))
}

func (t *tray) remove() {
	if !t.ready {
		return
	}
	procShellNotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&t.iconData)))
	t.ready = false
}

// quit 从外部触发退出：销毁窗口让消息循环结束。
func (t *tray) quit() {
	if t.hwnd != 0 {
		procDestroyWindow.Call(uintptr(t.hwnd))
	}
}

/* ---------------- 消息框 ---------------- */

// messageBox 在无控制台时也能把错误显示给用户。
func messageBox(title, text string) {
	const MB_OK = 0x00000000
	const MB_ICONERROR = 0x00000010
	procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr(text))),
		uintptr(unsafe.Pointer(utf16Ptr(title))),
		MB_OK|MB_ICONERROR,
	)
}

/* ---------------- 剪贴板 ---------------- */

// copyToClipboard 把文本写入剪贴板。
// 用最简实现：打开剪贴板 → 清空 → 分配全局内存写文本 → 设置。
func copyToClipboard(text string) {
	if err := clipboardWrite(text); err != nil {
		// 托盘场景没有控制台，失败只能忽略
		_ = err
	}
}

var (
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procSetClipboardData = user32.NewProc("SetClipboardData")
	procGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
)

func clipboardWrite(text string) error {
	const CF_UNICODETEXT = 13
	const GMEM_MOVEABLE = 0x0002

	u := utf16FromString(text)
	size := uintptr(len(u) * 2)

	h, _, _ := procGlobalAlloc.Call(GMEM_MOVEABLE, size)
	if h == 0 {
		return fmt.Errorf("GlobalAlloc 失败")
	}

	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		return fmt.Errorf("GlobalLock 失败")
	}
	// GlobalLock 返回的是 Win32 堆内存，不归 Go GC 管理，
	// 因此这里把它当原生缓冲区直接写入是安全的。
	dst := (*[1 << 20]uint16)(unsafe.Pointer(ptr))[:len(u):len(u)]
	copy(dst, u)
	procGlobalUnlock.Call(h)

	if r, _, _ := procOpenClipboard.Call(0); r == 0 {
		return fmt.Errorf("OpenClipboard 失败")
	}
	defer procCloseClipboard.Call()

	procEmptyClipboard.Call()
	procSetClipboardData.Call(CF_UNICODETEXT, h)
	return nil
}

// notifyProcessed 让本进程以独立方式运行（无控制台时避免被父 shell 回收）
func detachIfNeeded() {
	// GUI 构建下没有附带控制台，无需额外操作；
	// 控制台构建下保留窗口以便查看日志。
	_ = os.Getpid()
}
