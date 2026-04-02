package data

import "time"

func init() {
	registerToolHandler("GetCurrentTime", handleGetCurrentTime)
}

// handleGetCurrentTime 处理 GetCurrentTime 工具调用
func handleGetCurrentTime(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	now := time.Now().Format("2006-01-02 15:04:05")
	content := "当前本地时间是：" + now

	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetCurrentTime\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	appendToolMessages(
		ctx.Messages,
		ctx.CurrentAIContent.String(),
		ctx.ReasoningContentText.String(),
		ctx.CurrentCallID,
		ctx.FuncName,
		funcArguments,
		content,
	)

	return nil
}
