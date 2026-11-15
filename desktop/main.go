// mdviewer 桌面壳：把纯前端编辑器打成单个可执行文件。
//
// 设计要点（与 Trae 的 Electron 外壳做同样的事，但去掉整个 Chromium）：
//   - 前端资源用 embed 打进二进制，双击即用，不需要外部文件
//   - 起一个回环 HTTP 服务，把资源暴露给系统浏览器（复用用户已装的浏览器）
//   - 只监听 127.0.0.1，且随机端口，避免与其它程序冲突或被局域网访问
//   - 本地文件读写走 /api/*，路径限制在「工作根目录」之内
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed web
var webFS embed.FS

const (
	appName    = "mdviewer"
	maxReadSize = 32 << 20 // 单文件上限 32MB，避免误开巨型文件把内存打满
)

// openTargets 是允许通过「打开文件」接口访问的扩展名。
// 与前端 registry.js 的映射保持一致：这里只是白名单，真正的语言判定在前端。
var openTargets = map[string]bool{
	".md": true, ".markdown": true, ".mdown": true, ".mkd": true,
	".json": true, ".jsonc": true, ".json5": true, ".jsonl": true,
	".txt": true, ".log": true, ".csv": true,
	".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".jsx": true, ".tsx": true,
	".py": true, ".rs": true, ".go": true, ".java": true, ".c": true, ".h": true,
	".cpp": true, ".hpp": true, ".cs": true, ".php": true, ".rb": true,
	".sh": true, ".bash": true, ".ps1": true,
	".yml": true, ".yaml": true, ".toml": true, ".ini": true,
	".css": true, ".scss": true, ".less": true, ".html": true, ".htm": true,
	".xml": true, ".svg": true, ".sql": true,
}

// server 持有运行时状态。根目录可在启动时指定，也可在运行时切换，
// 所有文件访问都以此为界。root 会被多个 handler 并发访问，用 mutex 保护。
type server struct {
	mu   sync.RWMutex
	root string
}

func (s *server) getRoot() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.root
}

func (s *server) setRoot(p string) {
	s.mu.Lock()
	s.root = p
	s.mu.Unlock()
}

// exeDir 返回可执行文件所在目录。
//
// 默认工作区用它而不是 os.Getwd()：从快捷方式、从资源管理器、
// 从别的目录用命令行启动时，cwd 各不相同，工作区会乱跳。
// exe 旁边的目录才是用户心里的「这个程序的地方」。
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return ""
	}
	return dir
}

func main() {
	var (
		flagRoot = flag.String("root", "", "工作根目录（默认：当前目录）")
		flagPort = flag.Int("port", 0, "监听端口（默认：随机空闲端口）")
		flagNoUI = flag.Bool("no-open", false, "不创建窗口（脚本/调试用）")
		flagFile = flag.String("file", "", "启动后直接打开的文件")
		flagTray = flag.Bool("tray", false, "启用托盘图标（GUI 构建默认启用）")
		flagConsole = flag.Bool("console", false, "强制显示控制台窗口")
	)
	flag.Parse()

	// root 优先级：命令行 > exe 所在目录 > cwd
	root := *flagRoot
	if root == "" {
		root = exeDir()
	}
	if root == "" {
		wd, err := os.Getwd()
		if err != nil {
			log.Fatalf("取当前目录失败: %v", err)
		}
		root = wd
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		log.Fatalf("解析根目录失败: %v", err)
	}
	if st, err := os.Stat(absRoot); err != nil || !st.IsDir() {
		log.Fatalf("根目录不可用: %s", absRoot)
	}

	srv := &server{root: absRoot}

	// 静态资源：从 embed 里取 web/ 子树
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("装载内嵌资源失败: %v", err)
	}
	static := http.FileServer(http.FS(sub))

	mux := http.NewServeMux()
	mux.HandleFunc("/api/info", srv.handleInfo)
	mux.HandleFunc("/api/list", srv.handleList)
	mux.HandleFunc("/api/read", srv.handleRead)
	mux.HandleFunc("/api/save", srv.handleSave)
	mux.HandleFunc("/api/create", srv.handleCreate)
	mux.HandleFunc("/api/pick", srv.handlePick)
	mux.HandleFunc("/api/pickdir", srv.handlePickDir)
	mux.HandleFunc("/api/root", srv.handleRoot)
	// 其余路径交给静态资源；找不到时回退到 index.html，支持 ?file= 直达
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if _, err := fs.Stat(sub, strings.TrimPrefix(r.URL.Path, "/")); err != nil {
			if r.URL.Path != "/" {
				// 让前端路由接管
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/"
				static.ServeHTTP(w, r2)
				return
			}
		}
		static.ServeHTTP(w, r)
	})

	addr := fmt.Sprintf("127.0.0.1:%d", *flagPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatalWithUI(fmt.Sprintf("监听失败 %s: %v", addr, err), *flagConsole || *flagTray)
		return
	}
	actual := ln.Addr().(*net.TCPAddr).Port

	base := fmt.Sprintf("http://127.0.0.1:%d", actual)
	target := base + "/"
	if *flagFile != "" {
		if rel, err := srv.toRel(*flagFile); err == nil {
			target = base + "/?file=" + urlEscape(rel)
		}
	}

	// 控制台信息：GUI 构建里不可见，但 -console 启动时仍会打印
	fmt.Printf("%s 已启动\n", appName)
	fmt.Printf("  访问地址: %s\n", base)
	fmt.Printf("  工作目录: %s\n", absRoot)
	fmt.Printf("  退出方式: 右键托盘图标 → 退出（或关闭本窗口）\n")

	httpServer := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// 托盘：无窗口构建下的唯一交互入口
	useTray := *flagTray || (!*flagConsole && isGUIBuild)

	// GUI 构建：先尝试原生窗口。用户关窗即退出，不再留一个后台服务。
	// 窗口创建失败（缺 WebView2 运行时等）才退回系统浏览器。
	if isGUIBuild && !*flagNoUI {
		// 让服务先跑起来，窗口里的页面才有东西可加载
		go func() {
			if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				fatalWithUI(fmt.Sprintf("服务异常退出: %v", err), useTray)
			}
		}()

		time.Sleep(120 * time.Millisecond)
		if err := runWindow(target, "mdviewer — 文本编辑架构", 1280, 820); err != nil {
			// 窗口起不来：退回浏览器，至少还能用。
			// 这里不能用 fatalWithUI——它会 os.Exit，退路就走不到了。
			fmt.Fprintf(os.Stderr, "%v，改用系统浏览器\n", err)
			openBrowserFallback(target)
		}
		_ = httpServer.Close()
		return
	}

	if !*flagNoUI {
		go func() {
			// 稍等一拍，确保端口已开始 accept
			time.Sleep(120 * time.Millisecond)
			openBrowser(target)
		}()
	}

	if useTray {
		go func() {
			if err := startTray(target, func() {
				// 用户点退出：先关服务再退出进程
				_ = httpServer.Close()
				os.Exit(0)
			}); err != nil {
				fatalWithUI(fmt.Sprintf("托盘启动失败: %v", err), false)
			}
		}()
	}

	if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatalWithUI(fmt.Sprintf("服务异常退出: %v", err), useTray)
	}
}

// fatalWithUI 在无控制台的环境下也要让用户看到错误。
func fatalWithUI(msg string, hasTray bool) {
	fmt.Fprintf(os.Stderr, "%s\n", msg)
	if hasTray {
		messageBox("mdviewer 启动失败", msg)
	}
	os.Exit(1)
}

/* ---------------- 路径安全 ---------------- */

// toRel 把任意路径规整成相对根目录的 posix 路径，并拒绝越界。
func (s *server) toRel(p string) (string, error) {
	if p == "" {
		return "", errors.New("路径为空")
	}
	var abs string
	if filepath.IsAbs(p) {
		abs = filepath.Clean(p)
	} else {
		abs = filepath.Clean(filepath.Join(s.getRoot(), filepath.FromSlash(p)))
	}

	rel, err := filepath.Rel(s.getRoot(), abs)
	if err != nil {
		return "", errors.New("路径无法解析")
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("路径越界，只允许访问工作目录内的文件")
	}
	return filepath.ToSlash(rel), nil
}

// toAbs 把相对路径还原成绝对路径，并做最后一次越界校验。
func (s *server) toAbs(rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", errors.New("只接受相对路径")
	}
	abs := filepath.Clean(filepath.Join(s.getRoot(), filepath.FromSlash(rel)))
	root := s.getRoot()
	if abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", errors.New("路径越界")
	}
	return abs, nil
}

func urlEscape(s string) string {
	// 只处理会破坏查询串的字符，保留斜杠以便前端拼 ?file=
	repl := strings.NewReplacer(
		"%", "%25", " ", "%20", "#", "%23", "?", "%3F", "&", "%26", "+", "%2B",
	)
	return repl.Replace(s)
}

/* ---------------- API ---------------- */

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeBodyUTF8 读取并解析请求体，同时拒绝非法 UTF-8。
//
// 为什么必须校验：encoding/json 遇到非法 UTF-8 字节不会报错，
// 而是把每个坏字节静默替换成 U+FFFD，然后原样写盘。
// 结果是用户在非 UTF-8 工具链里调用本 API 时，中文内容被永久毁掉，
// 而且接口返回 200，看不出任何异常。
//
// 宁可返回 400 让调用方重发，也不能写坏用户的文件。
func decodeBodyUTF8(r *http.Request, dst any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxReadSize))
	if err != nil {
		return errors.New("请求体读取失败")
	}
	if !utf8.Valid(body) {
		return errors.New("请求体不是合法 UTF-8，请检查发送端的文本编码")
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return errors.New("请求格式错误")
	}
	return nil
}

func (s *server) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app":     appName,
		"root":    s.getRoot(),
		"version": "1.0.0",
	})
}

type fileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	IsDir bool   `json:"isDir"`
}

func (s *server) handleList(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("dir")
	if rel == "" {
		rel = "."
	}
	dirRel, err := s.toRel(rel)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.toAbs(dirRel)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "目录不可读"})
		return
	}

	out := make([]fileEntry, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue // 跳过隐藏项，减少噪音
		}
		childRel := name
		if dirRel != "." {
			childRel = dirRel + "/" + name
		}
		info, statErr := e.Info()
		var size int64
		if statErr == nil {
			size = info.Size()
		}
		if e.IsDir() {
			out = append(out, fileEntry{Name: name, Path: childRel, IsDir: true})
			continue
		}
		if !openTargets[strings.ToLower(filepath.Ext(name))] {
			continue
		}
		out = append(out, fileEntry{Name: name, Path: childRel, Size: size})
	}

	// 目录在前，同类按名称排序
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})

	writeJSON(w, http.StatusOK, map[string]any{"dir": dirRel, "entries": out})
}

func (s *server) handleRead(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	pathRel, err := s.toRel(rel)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.toAbs(pathRel)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	st, err := os.Stat(abs)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "文件不存在"})
		return
	}
	if st.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "目标是目录"})
		return
	}
	if st.Size() > maxReadSize {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "文件超过 32MB"})
		return
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取失败"})
		return
	}

	// 非 UTF-8 文件必须拒绝，不能"尽力而为"地返回。
	// 转成 string 交给 json 编码时，坏字节会被静默替换成 U+FFFD，
	// 编辑器里显示的是被篡改的内容；用户一旦保存，原文件就真的毁了。
	// 明确报错，比让他以为一切正常安全得多。
	if !utf8.Valid(data) {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{
			"error": "文件不是 UTF-8 编码，为免损坏内容已拒绝打开（可用其他工具转码后重试）",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    pathRel,
		"name":    filepath.Base(abs),
		"content": string(data),
		"size":    len(data),
	})
}

type saveReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// handlePickDir 弹出目录选择框，用于切换工作区。
func (s *server) handlePickDir(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "windows" {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "仅 Windows 支持系统目录框"})
		return
	}

	type res struct {
		path string
		err  error
	}
	ch := make(chan res, 1)

	go func() {
		path, err := pickFolderWithDialog("选择工作区目录", s.getRoot(), trayHwnd())
		ch <- res{path: path, err: err}
	}()

	var got res
	select {
	case got = <-ch:
	case <-r.Context().Done():
		return
	}

	if got.err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": got.err.Error()})
		return
	}
	if got.path == "" {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": got.path})
}

// handleRoot 切换工作区根目录。
//
// 为什么允许改：用户可能想编辑任意位置的文档，而不是只能编辑
// 启动目录下的文件。Security 边界仍在——所有路径都相对新根校验。
func (s *server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"root": s.getRoot()})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "需要 POST"})
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := decodeBodyUTF8(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	abs, err := filepath.Abs(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "路径无法解析"})
		return
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "目标不是有效目录"})
		return
	}

	s.setRoot(abs)

	// 回传可编辑文件数量：前端据此判断"这个目录能不能用"。
	// 只看一层，不做递归——用户需要的是快速反馈，不是统计。
	editable := 0
	subdirs := 0
	if entries, err := os.ReadDir(abs); err == nil {
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			if e.IsDir() {
				subdirs++
				continue
			}
			if openTargets[strings.ToLower(filepath.Ext(name))] {
				editable++
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"root":     abs,
		"editable": editable,
		"subdirs":  subdirs,
	})
}

// handleCreate 新建空文件。
//
// 为什么需要独立接口：新建时文件还不存在，save 的原子替换流程
// 会先写临时文件再 rename，对不存在的目标同样可行，但语义上
// 「新建」要能拒绝覆盖已有文件，避免用户误把原文件清空。
func (s *server) handleCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "需要 POST"})
		return
	}

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeBodyUTF8(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	pathRel, err := s.toRel(req.Path)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.toAbs(pathRel)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	if !openTargets[strings.ToLower(filepath.Ext(abs))] {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "该扩展名不在白名单"})
		return
	}

	// 拒绝覆盖：新建的语义是"创建新文件"，不是"清空已有文件"
	if _, statErr := os.Stat(abs); statErr == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "文件已存在，请换个名字"})
		return
	}

	// 父目录不存在时自动创建，省掉用户手动建目录
	if dir := filepath.Dir(abs); dir != s.getRoot() {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "创建目录失败"})
			return
		}
	}

	if err := os.WriteFile(abs, []byte(req.Content), 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "创建失败"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": pathRel})
}

func (s *server) handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "需要 POST"})
		return
	}
	var req saveReq
	if err := decodeBodyUTF8(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	pathRel, err := s.toRel(req.Path)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	abs, err := s.toAbs(pathRel)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	if !openTargets[strings.ToLower(filepath.Ext(abs))] {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "该扩展名不在白名单"})
		return
	}

	// 先写临时文件再原子替换，避免写到一半崩溃把原文件毁掉
	tmp := abs + ".tmp-mdviewer"
	if err := os.WriteFile(tmp, []byte(req.Content), 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "写入失败"})
		return
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "替换失败"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": pathRel})
}

// handlePick 打开系统文件选择框。
//
// 直接调 Win32 通用文件对话框（同进程 COM），不经 PowerShell 子进程：
// GUI 构建下没有控制台与主窗口，exec 拉起的子进程对话框可能不可见，
// 表现为「点了打开没反应」。
//
// 对话框跑在独立 goroutine 里（内部 LockOSThread + STA），
// 通过 channel 回传结果：Show() 会阻塞到用户操作结束，
// 放在 handler 所在 goroutine 上会让 net/http 的连接管理变得难以预测。
func (s *server) handlePick(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "windows" {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "仅 Windows 支持系统文件框"})
		return
	}

	type pickResult struct {
		path string
		err  error
	}
	ch := make(chan pickResult, 1)

	go func() {
		path, err := pickFileWithDialog(
			"打开文件",
			s.getRoot(),
			[]string{
				"可编辑文本|*.md;*.markdown;*.mdown;*.json;*.jsonc;*.json5;*.jsonl;*.txt;*.log",
				"代码文件|*.js;*.mjs;*.ts;*.py;*.go;*.rs;*.c;*.h;*.cpp;*.hpp;*.java;*.cs;*.php;*.rb;*.sh;*.ps1",
				"配置与样式|*.yml;*.yaml;*.toml;*.ini;*.css;*.scss;*.html;*.xml;*.sql;*.csv",
				"所有文件|*.*",
			},
			trayHwnd(),
		)
		ch <- pickResult{path: path, err: err}
	}()

	// 等用户操作；请求被客户端取消时也能及时退出
	var res pickResult
	select {
	case res = <-ch:
	case <-r.Context().Done():
		// 对话框还在前台，用户仍可继续操作；
		// 这里只是不再等它，避免连接泄漏
		return
	}

	if res.err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": res.err.Error()})
		return
	}

	if res.path == "" {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}

	rel, err := s.toRel(res.path)
	if err != nil {
		// 用户选了工作区外的文件。这里不该报错——用户就是想打开它。
		// 直接把工作区切到该文件所在目录，然后按相对路径返回。
		// 这样"打开任意位置的文件"和"路径安全"两个需求同时成立。
		newRoot := filepath.Dir(res.path)
		s.setRoot(newRoot)
		rel2, err2 := s.toRel(res.path)
		if err2 != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": "无法定位所选文件：" + err2.Error(),
			})
			return
		}
		rel = rel2
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path": rel,
		"name": filepath.Base(res.path),
		"root": s.getRoot(),
	})
}

/* ---------------- 打开浏览器 ---------------- */

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Printf("自动打开浏览器失败，请手动访问: %s\n", url)
	}
}
