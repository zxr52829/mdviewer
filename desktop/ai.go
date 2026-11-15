package main

// AI 代码改写代理。
//
// 设计约束：
//  1. API key 只存在于 Go 进程与本机配置文件，绝不通过任何 /api/* 返回给前端。
//     前端只能查到「是否已配置」，拿不到内容。
//  2. 前端不直连 DeepSeek —— 一是 key 会进前端代码（仓库有公开镜像），
//     二是浏览器跨域调 api.deepseek.com 会被 CORS 挡掉。
//  3. 只做「选区改写」这一件事：输入原文 + 指令 + 上下文，输出完整替换文本。
//     不做多轮对话、不做工具调用，保持行为可预测、可 diff、可撤销。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	deepseekEndpoint = "https://api.deepseek.com/chat/completions"
	deepseekModel    = "deepseek-chat"
	// 单次请求的正文上限。编辑器是文本工具，超过这个量级的选区
	// 既超出模型有效上下文，也说明用户误选（比如全选整个大文件）。
	maxSelectionBytes = 200 * 1024
	maxOutputTokens   = 4096
)

// aiConfig 是落盘配置。Key 字段带 json tag，但永远不会被序列化进任何响应。
type aiConfig struct {
	APIKey string `json:"apiKey"`
	Model  string `json:"model,omitempty"`
}

// aiConfigPath 返回配置文件位置：%APPDATA%/mdviewer/ai.json。
// 与工作根目录无关 —— 换工作区不该丢 key。
func aiConfigPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "mdviewer", "ai.json"), nil
}

func loadAIConfig() (aiConfig, error) {
	cfg := aiConfig{}
	path, err := aiConfigPath()
	if err != nil {
		// 连配置目录都拿不到时，仍然允许环境变量兜底
		cfg.APIKey = strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY"))
		return cfg, err
	}
	raw, readErr := os.ReadFile(path)
	if readErr == nil {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return aiConfig{}, fmt.Errorf("配置文件损坏: %w", err)
		}
	} else if !os.IsNotExist(readErr) {
		return cfg, readErr
	}
	// 环境变量优先：便于临时覆盖而不写盘。
	// 注意这一步必须在「文件不存在」分支之后，不能提前 return。
	if env := strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")); env != "" {
		cfg.APIKey = env
	}
	return cfg, nil
}

func saveAIConfig(cfg aiConfig) error {
	path, err := aiConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// 0600：仅当前用户可读。这层权限在 Windows 上语义较弱，
	// 但配合「永不回传」已经足够；不要把它当成加密。
	return os.WriteFile(path, raw, 0o600)
}

/* ---------------- HTTP 处理器 ---------------- */

// handleAIStatus 报告 AI 能力状态。只回布尔与模型名，绝不回 key。
func (s *server) handleAIStatus(w http.ResponseWriter, r *http.Request) {
	cfg, err := loadAIConfig()
	configured := err == nil && strings.TrimSpace(cfg.APIKey) != ""
	model := deepseekModel
	if cfg.Model != "" {
		model = cfg.Model
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": configured,
		"model":      model,
		"source":     aiKeySource(),
	})
}

// aiKeySource 说明 key 从哪来，便于用户排查"设了却不生效"。
func aiKeySource() string {
	if strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")) != "" {
		return "env"
	}
	if path, err := aiConfigPath(); err == nil {
		if _, statErr := os.Stat(path); statErr == nil {
			return "file"
		}
	}
	return "none"
}

// handleAISaveKey 保存 key。请求体 {apiKey}。
func (s *server) handleAISaveKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "需要 POST", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		APIKey string `json:"apiKey"`
		Model  string `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8*1024)).Decode(&body); err != nil {
		http.Error(w, "请求体不是 JSON", http.StatusBadRequest)
		return
	}
	key := strings.TrimSpace(body.APIKey)
	// 允许清空（用户想删掉 key），但不允许写入明显不是 key 的东西
	if key != "" && len(key) < 16 {
		http.Error(w, "key 长度不合理", http.StatusBadRequest)
		return
	}
	cfg, _ := loadAIConfig()
	cfg.APIKey = key
	if m := strings.TrimSpace(body.Model); m != "" {
		cfg.Model = m
	}
	if err := saveAIConfig(cfg); err != nil {
		http.Error(w, "保存失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "configured": key != ""})
}

// aiRewriteRequest 是前端发来的改写请求。
type aiRewriteRequest struct {
	// Selected 是用户选中的原文，将被整体替换。
	Selected string `json:"selected"`
	// Instruction 是自然语言指令，如"改成 async/await"。
	Instruction string `json:"instruction"`
	// Language 用于让模型按对应语法作答。
	Language string `json:"language"`
	// Context 是选区前后各若干行，仅供模型理解，不参与替换。
	ContextBefore string `json:"contextBefore"`
	ContextAfter  string `json:"contextAfter"`
}

// handleAIRewrite 执行一次选区改写，返回完整替换文本。
//
// 非流式：改写结果需要整体 diff 后再应用，流式对这里没有收益。
func (s *server) handleAIRewrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "需要 POST", http.StatusMethodNotAllowed)
		return
	}

	cfg, err := loadAIConfig()
	if err != nil {
		http.Error(w, "读取配置失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		http.Error(w, "未配置 DeepSeek API key", http.StatusPreconditionFailed)
		return
	}

	var req aiRewriteRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxSelectionBytes+64*1024)).Decode(&req); err != nil {
		http.Error(w, "请求体不是 JSON 或过大", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Selected) == "" {
		http.Error(w, "选区为空", http.StatusBadRequest)
		return
	}
	if len(req.Selected) > maxSelectionBytes {
		http.Error(w, fmt.Sprintf("选区过大（%d 字节，上限 %d）", len(req.Selected), maxSelectionBytes), http.StatusRequestEntityTooLarge)
		return
	}
	if strings.TrimSpace(req.Instruction) == "" {
		http.Error(w, "指令为空", http.StatusBadRequest)
		return
	}

	text, usage, err := callDeepSeek(cfg, &req)
	if err != nil {
		var apiErr *deepseekError
		if errors.As(err, &apiErr) {
			// 上游错误码原样带回，前端据此区分"key 错了"和"限流了"
			writeJSON(w, apiErr.Status, map[string]any{"error": apiErr.Message, "upstreamStatus": apiErr.Upstream})
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"text":  text,
		"usage": usage,
	})
}

type usageInfo struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
}

// deepseekError 带上 HTTP 状态码，供上层决定回给前端的响应码。
type deepseekError struct {
	Status   int
	Upstream int
	Message  string
}

func (e *deepseekError) Error() string { return e.Message }

// callDeepSeek 调一次 chat/completions。
func callDeepSeek(cfg aiConfig, req *aiRewriteRequest) (string, *usageInfo, error) {
	model := cfg.Model
	if model == "" {
		model = deepseekModel
	}

	lang := req.Language
	if lang == "" {
		lang = "text"
	}

	systemPrompt := "你是代码编辑器里的改写引擎。" +
		"只输出替换后的完整代码，不要解释，不要 markdown 代码围栏，不要任何前后缀说明。" +
		"保持与原文相同的缩进风格与缩进宽度。" +
		"必须真正执行改写要求；只有当指令在语法上完全无法套用于这段代码时，才原样输出。" +
		"像「改成箭头函数」「加错误处理」「用 forEach 重写」这类要求都要实际改出来，不要以「已经足够好」为由跳过。" +
		"当前语言：" + lang + "。"

	userPrompt := buildUserPrompt(req)

	payload := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"temperature": 0.2, // 改写要稳定，不要发挥
		"max_tokens":  maxOutputTokens,
		"stream":      false,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", nil, err
	}

	httpReq, err := http.NewRequest(http.MethodPost, deepseekEndpoint, bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", nil, fmt.Errorf("连接 DeepSeek 失败: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return "", nil, fmt.Errorf("读取响应失败: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", nil, mapUpstreamError(resp.StatusCode, raw)
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", nil, fmt.Errorf("解析响应失败: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", nil, fmt.Errorf("响应没有 choices")
	}

	text := stripCodeFence(parsed.Choices[0].Message.Content)
	usage := &usageInfo{
		PromptTokens:     parsed.Usage.PromptTokens,
		CompletionTokens: parsed.Usage.CompletionTokens,
	}
	return text, usage, nil
}

func buildUserPrompt(req *aiRewriteRequest) string {
	var b strings.Builder
	// 用明确分隔符包住上下文，避免模型把它当成要改写的内容
	if req.ContextBefore != "" {
		b.WriteString("/* 上文（仅供理解，不要出现在输出里） */\n")
		b.WriteString(req.ContextBefore)
		b.WriteString("\n/* 上文结束 */\n\n")
	}
	b.WriteString("/* 待改写（这段是要被整体替换的） */\n")
	b.WriteString(req.Selected)
	b.WriteString("\n/* 待改写结束 */\n\n")
	if req.ContextAfter != "" {
		b.WriteString("/* 下文（仅供理解，不要出现在输出里） */\n")
		b.WriteString(req.ContextAfter)
		b.WriteString("\n/* 下文结束 */\n\n")
	}
	b.WriteString("改写要求：")
	b.WriteString(req.Instruction)
	return b.String()
}

// stripCodeFence 去掉模型偶尔仍然吐出的 ```lang ... ``` 包裹。
// 提示词里已经禁止，但小模型不一定听话，兜一层。
func stripCodeFence(s string) string {
	t := strings.TrimSpace(s)
	if !strings.HasPrefix(t, "```") {
		return t
	}
	// 去掉首行围栏
	if i := strings.IndexByte(t, '\n'); i >= 0 {
		t = t[i+1:]
	} else {
		return t
	}
	// 去掉结尾围栏
	if idx := strings.LastIndex(t, "```"); idx >= 0 {
		t = t[:idx]
	}
	return strings.TrimRight(t, "\n")
}

// mapUpstreamError 把 DeepSeek 的错误响应翻成带状态码的错误。
func mapUpstreamError(status int, raw []byte) error {
	msg := strings.TrimSpace(string(raw))
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) == nil && parsed.Error.Message != "" {
		msg = parsed.Error.Message
	}
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}

	var front int
	switch status {
	case http.StatusUnauthorized:
		front = http.StatusPreconditionFailed
		msg = "API key 无效或已过期：" + msg
	case http.StatusTooManyRequests:
		front = http.StatusTooManyRequests
		msg = "请求过于频繁或额度不足：" + msg
	case http.StatusPaymentRequired:
		front = http.StatusPaymentRequired
		msg = "账户余额不足：" + msg
	default:
		front = http.StatusBadGateway
	}
	return &deepseekError{Status: front, Upstream: status, Message: msg}
}
