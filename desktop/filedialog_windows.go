//go:build windows

// 系统文件选择框。
//
// 不用 PowerShell + WinForms 的原因：GUI 构建的进程没有控制台也没有主窗口，
// 通过 exec 拉起的 PowerShell 子进程在部分环境里对话框不可见或被阻塞，
// 表现为「点了打开没反应」。直接调 Win32 的通用文件对话框（IFileOpenDialog）
// 在同进程内弹窗，父子关系明确，可靠性高得多。
//
// 实现走 COM：
//   CoInitializeEx → CoCreateInstance(FileOpenDialog) → SetOptions/SetTitle
//   → Show(ownerHwnd) → GetResult → GetDisplayName
//
// 关键点：Show 必须传 owner 窗口句柄，否则对话框可能出现在其他窗口后面，
// 用户以为没反应。这里优先用托盘窗口作为 owner。

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var (
	procCoInitializeEx        = ole32.NewProc("CoInitializeEx")
	procCoCreateInstance      = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree         = ole32.NewProc("CoTaskMemFree")
	procCoUninitialize        = ole32.NewProc("CoUninitialize")
)

var ole32 = syscall.NewLazyDLL("ole32.dll")

/* ---------------- COM 接口定义 ---------------- */

// GUID 与 IID 常量。CLSID_FileOpenDialog 与 IID_IFileOpenDialog。
type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// {DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}
var clsidFileOpenDialog = guid{
	0xDC1C5A9C, 0xE88A, 0x4DDE,
	[8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7},
}

// {d57c7288-d4ad-4768-be02-9d969532d960}
var iidIFileOpenDialog = guid{
	0xD57C7288, 0xD4AD, 0x4768,
	[8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60},
}

const (
	COINIT_APARTMENTTHREADED = 0x2
	CLSCTX_INPROC_SERVER     = 0x1
	COINIT_DISABLE_OLE1DDE   = 0x4

	// FOS_* 选项
	FOS_PICKFOLDERS     = 0x00000020
	FOS_FORCEFILESYSTEM = 0x00000040
	FOS_FILEMUSTEXIST   = 0x00001000
	FOS_PATHMUSTEXIST   = 0x00000800
	FOS_NOCHANGEDIR     = 0x00000008

	SIGDN_FILESYSPATH = 0x80058000
)

// vtable 索引（IFileOpenDialog 继承自 IModalWindow → IFileDialog → IFileOpenDialog）
const (
	vtShow           = 3 // IModalWindow::Show
	vtSetFileTypes   = 4
	vtSetOptions     = 9  // IFileDialog::SetOptions
	vtGetOptions     = 10
	vtSetTitle       = 17
	vtGetResult      = 20 // IFileDialog::GetResult → IShellItem
	vtGetDisplayName = 5  // IShellItem::GetDisplayName
	vtRelease        = 2  // IUnknown::Release
)

// comCall 调用 COM 虚函数表第 index 个方法。
func comCall(punk unsafe.Pointer, index int, args ...uintptr) uintptr {
	// punk → *vtable → vtable[index]
	vtable := *(**[64]uintptr)(punk)
	proc := vtable[index]

	full := make([]uintptr, 0, len(args)+1)
	full = append(full, uintptr(punk))
	full = append(full, args...)

	r, _, _ := syscall.SyscallN(proc, full...)
	return r
}

/* ---------------- 对外入口 ---------------- */

// pickFileWithDialog 弹出系统打开文件对话框。
//
// @param title 对话框标题
// @param initialDir 初始目录
// @param filters 形如 []string{"Markdown|*.md;*.markdown", "所有文件|*.*"}
// @param ownerHwnd 父窗口句柄（可为 0）
// @returns 选中的完整路径；用户取消时返回空串
func pickFileWithDialog(title, initialDir string, filters []string, ownerHwnd uintptr) (string, error) {
	// Shell 文件对话框是 STA 模态窗口：必须锁定 OS 线程再初始化 COM，
	// 否则 Show() 的消息循环跑在与窗口创建不同的线程上，表现为
	// 「对话框能弹出来，但点确定/取消都没反应」——本项实际踩过这个坑。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// 每次调用独立初始化 COM。STA 是 Shell 对话框的要求。
	hr, _, _ := procCoInitializeEx.Call(0, COINIT_APARTMENTTHREADED|COINIT_DISABLE_OLE1DDE)
	// S_OK(0) 与 S_FALSE(1) 都可继续；RPC_E_CHANGED_MODE 说明线程已是别的套间
	if int32(hr) < 0 && uint32(hr) != 0x80010106 {
		return "", fmt.Errorf("COM 初始化失败: 0x%X", hr)
	}
	defer procCoUninitialize.Call()

	var dialog unsafe.Pointer
	r, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		CLSCTX_INPROC_SERVER,
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)),
		uintptr(unsafe.Pointer(&dialog)),
	)
	if r != 0 || dialog == nil {
		return "", fmt.Errorf("创建文件对话框失败: 0x%X", r)
	}
	defer comCall(dialog, vtRelease)

	// 选项：只能选文件、必须存在、不改当前目录
	opts := uintptr(FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR)
	comCall(dialog, vtSetOptions, opts)

	// 标题
	if title != "" {
		p := utf16Ptr(title)
		comCall(dialog, vtSetTitle, uintptr(unsafe.Pointer(p)))
	}

	// 初始目录：必须用 SetFolder + IShellItem。
	// 早期版本用 SetFileName 传 "目录\" 来引导，结果文件名输入框被填成路径，
	// 用户既不能直接选文件、目录也没切过去 —— 这是错误用法。
	if initialDir != "" {
		if item := shellItemFromPath(initialDir); item != nil {
			// IFileDialog::SetFolder 是第 12 号方法
			comCall(dialog, 12, uintptr(item))
			comCall(item, vtRelease)
		}
	}

	// 文件类型过滤器
	if len(filters) > 0 {
		setFileTypes(dialog, filters)
	}

	// 先起一个前台推手：vtShow 阻塞期间把窗口捞到最前。
	// 没有它，owner 为 0 时对话框常被浏览器盖住，看起来像没弹。
	focusDone := make(chan struct{})
	go focusDialog(title, focusDone)
	defer close(focusDone)

	// Show：必须传 owner，否则可能被其他窗口挡住
	hr = comCall(dialog, vtShow, ownerHwnd)
	if int32(hr) != 0 {
		// 用户取消时返回 HRESULT_FROM_WIN32(ERROR_CANCELLED) = 0x800704C7
		if uint32(hr) == 0x800704C7 {
			return "", nil
		}
		return "", fmt.Errorf("对话框返回错误: 0x%X", hr)
	}

	// 取结果
	var item unsafe.Pointer
	hr = comCall(dialog, vtGetResult, uintptr(unsafe.Pointer(&item)))
	if int32(hr) < 0 || item == nil {
		return "", fmt.Errorf("获取选择结果失败: 0x%X", hr)
	}
	defer comCall(item, vtRelease)

	var pathPtr *uint16
	hr = comCall(item, vtGetDisplayName, SIGDN_FILESYSPATH, uintptr(unsafe.Pointer(&pathPtr)))
	if int32(hr) < 0 || pathPtr == nil {
		return "", fmt.Errorf("获取文件路径失败: 0x%X", hr)
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(pathPtr)))

	return utf16ToString(pathPtr), nil
}

/* ---------------- IShellItem ---------------- */

var (
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
	procGetForegroundWindow         = dlgUser32.NewProc("GetForegroundWindow")
	procSetForegroundWindow         = dlgUser32.NewProc("SetForegroundWindow")
	procFindWindowW                 = dlgUser32.NewProc("FindWindowW")
	procGetWindowThreadProcessId    = dlgUser32.NewProc("GetWindowThreadProcessId")
)

// dlgUser32 单独持有一个 user32 句柄，避免和 tray_windows.go 里的同名变量冲突。
var dlgUser32 = syscall.NewLazyDLL("user32.dll")

// foregroundOwner 给对话框找一个可靠的 owner 句柄。
//
// 没有托盘时 trayHwnd() 返回 0，vtShow(0) 的对话框不归属任何窗口，
// 常被浏览器盖在下面，用户看到的是「点了没反应」。
// 优先返回托盘窗口；否则找刚才的前台窗口，但它必须属于本进程——
// 拿别的进程窗口当 owner 会把对话框绑到别人身上，更糟。
func foregroundOwner() uintptr {
	if h := trayHwnd(); h != 0 {
		return h
	}
	fg, _, _ := procGetForegroundWindow.Call()
	if fg == 0 {
		return 0
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(fg, uintptr(unsafe.Pointer(&pid)))
	if pid == uint32(os.Getpid()) {
		return fg
	}
	return 0
}

// focusDialog 尽力把对话框拉到前台并激活。
//
// vtShow 是阻塞调用，等它返回时对话框已经关掉了，所以这里另起协程轮询：
// 按标题找顶层窗口，找到就 SetForegroundWindow。找不到就算了，不做无限重试。
func focusDialog(title string, done <-chan struct{}) {
	if title == "" {
		return
	}
	p := utf16Ptr(title)
	for i := 0; i < 40; i++ {
		select {
		case <-done:
			return
		case <-time.After(50 * time.Millisecond):
		}
		hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(p)))
		if hwnd != 0 {
			procSetForegroundWindow.Call(hwnd)
			return
		}
	}
}

// {43826d1e-e718-42ee-bc55-a1e261c37bfe}
var iidIShellItem = guid{
	0x43826D1E, 0xE718, 0x42EE,
	[8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE},
}

// shellItemFromPath 由路径创建 IShellItem。失败返回 nil。
func shellItemFromPath(path string) unsafe.Pointer {
	p := utf16Ptr(path)
	if p == nil {
		return nil
	}

	var item unsafe.Pointer
	hr, _, _ := procSHCreateItemFromParsingName.Call(
		uintptr(unsafe.Pointer(p)),
		0,
		uintptr(unsafe.Pointer(&iidIShellItem)),
		uintptr(unsafe.Pointer(&item)),
	)
	if int32(hr) < 0 || item == nil {
		return nil
	}
	return item
}

// pickFolderWithDialog 弹出系统目录选择框（同一 COM 接口，加 FOS_PICKFOLDERS）。
func pickFolderWithDialog(title, initialDir string, ownerHwnd uintptr) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hr, _, _ := procCoInitializeEx.Call(0, COINIT_APARTMENTTHREADED|COINIT_DISABLE_OLE1DDE)
	if int32(hr) < 0 && uint32(hr) != 0x80010106 {
		return "", fmt.Errorf("COM 初始化失败: 0x%X", hr)
	}
	defer procCoUninitialize.Call()

	var dialog unsafe.Pointer
	r, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		CLSCTX_INPROC_SERVER,
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)),
		uintptr(unsafe.Pointer(&dialog)),
	)
	if r != 0 || dialog == nil {
		return "", fmt.Errorf("创建目录对话框失败: 0x%X", r)
	}
	defer comCall(dialog, vtRelease)

	// FOS_PICKFOLDERS 让对话框变成"选目录"模式
	opts := uintptr(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR)
	comCall(dialog, vtSetOptions, opts)

	if title != "" {
		comCall(dialog, vtSetTitle, uintptr(unsafe.Pointer(utf16Ptr(title))))
	}

	if initialDir != "" {
		if item := shellItemFromPath(initialDir); item != nil {
			comCall(dialog, 12, uintptr(item))
			comCall(item, vtRelease)
		}
	}

	// 没有托盘窗口时找一个本进程的前台窗口当 owner，
	// 否则 owner=0 的对话框容易被浏览器压在下面。
	if ownerHwnd == 0 {
		ownerHwnd = foregroundOwner()
	}

	// 没有托盘窗口时找一个本进程的前台窗口当 owner，
	// 否则 owner=0 的对话框容易被浏览器压在下面。
	if ownerHwnd == 0 {
		ownerHwnd = foregroundOwner()
	}

	focusDone := make(chan struct{})
	go focusDialog(title, focusDone)
	defer close(focusDone)

	hr = comCall(dialog, vtShow, ownerHwnd)
	if int32(hr) != 0 {
		if uint32(hr) == 0x800704C7 {
			return "", nil
		}
		return "", fmt.Errorf("对话框返回错误: 0x%X", hr)
	}

	var item unsafe.Pointer
	hr = comCall(dialog, vtGetResult, uintptr(unsafe.Pointer(&item)))
	if int32(hr) < 0 || item == nil {
		return "", fmt.Errorf("获取选择结果失败: 0x%X", hr)
	}
	defer comCall(item, vtRelease)

	var pathPtr *uint16
	hr = comCall(item, vtGetDisplayName, SIGDN_FILESYSPATH, uintptr(unsafe.Pointer(&pathPtr)))
	if int32(hr) < 0 || pathPtr == nil {
		return "", fmt.Errorf("获取目录路径失败: 0x%X", hr)
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(pathPtr)))

	return utf16ToString(pathPtr), nil
}

// setFileTypes 设置过滤器列表。
// filters 每项形如 "显示名|*.md;*.txt"，内部转成 COMDLG_FILTERSPEC 数组。
func setFileTypes(dialog unsafe.Pointer, filters []string) {
	type filterSpec struct {
		Name *uint16
		Spec *uint16
	}

	specs := make([]filterSpec, 0, len(filters))
	keep := make([]*uint16, 0, len(filters)*2)

	for _, f := range filters {
		parts := splitOnce(f, '|')
		if len(parts) != 2 {
			continue
		}
		np := utf16Ptr(parts[0])
		sp := utf16Ptr(parts[1])
		keep = append(keep, np, sp)
		specs = append(specs, filterSpec{Name: np, Spec: sp})
	}
	if len(specs) == 0 {
		return
	}

	// IFileDialog::SetFileTypes(cFileTypes, rgFilterSpec)
	comCall(dialog, vtSetFileTypes,
		uintptr(len(specs)),
		uintptr(unsafe.Pointer(&specs[0])),
	)
}

// splitOnce 按第一个分隔符切分
func splitOnce(s string, sep byte) []string {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return []string{s[:i], s[i+1:]}
		}
	}
	return []string{s}
}

// utf16ToString 把以 0 结尾的 UTF-16 串转成 Go 字符串
func utf16ToString(p *uint16) string {
	if p == nil {
		return ""
	}
	var buf []uint16
	for i := 0; ; i++ {
		v := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(p)) + uintptr(i*2)))
		if v == 0 {
			break
		}
		buf = append(buf, v)
		// 防御：异常长路径直接截断
		if i > 32768 {
			break
		}
	}
	return syscall.UTF16ToString(buf)
}

// trayHwnd 返回托盘窗口句柄，用作对话框 owner。
// 没有托盘（控制台构建且未启用）时返回 0。
func trayHwnd() uintptr {
	if activeTray != nil && activeTray.hwnd != 0 {
		return uintptr(activeTray.hwnd)
	}
	return 0
}
