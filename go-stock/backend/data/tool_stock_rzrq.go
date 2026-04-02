package data

import (
	"strings"
	"time"

	"go-stock/backend/util"

	"github.com/tidwall/gjson"
)

func init() {
	registerToolHandler("GetStockRZRQInfo", handleGetStockRZRQInfo)
}

// handleGetStockRZRQInfo 处理 GetStockRZRQInfo 工具调用：获取融资融券信息
func handleGetStockRZRQInfo(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	stockCode := strings.TrimSpace(gjson.Get(funcArguments, "stockCode").String())
	if stockCode == "" {
		appendToolMessages(
			ctx.Messages,
			ctx.CurrentAIContent.String(),
			ctx.ReasoningContentText.String(),
			ctx.CurrentCallID,
			ctx.FuncName,
			funcArguments,
			"参数 stockCode 不能为空，请传入股票代码。",
		)
		return nil
	}

	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockRZRQInfo，参数：" + stockCode + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	res := NewStockDataApi().GetStockRZRQInfo(stockCode)
	if len(res.Result.Data) == 0 {
		appendToolMessages(
			ctx.Messages,
			ctx.CurrentAIContent.String(),
			ctx.ReasoningContentText.String(),
			ctx.CurrentCallID,
			ctx.FuncName,
			funcArguments,
			"未查询到该股票的融资融券数据（可能非两融标的或代码有误）。",
		)
		return nil
	}

	md := util.MarkdownTableWithTitle(stockCode+" 融资融券信息", res.Result.Data)
	//logger.SugaredLogger.Infof("GetStockRZRQInfo stockCode:%s count:%d", stockCode, len(res.Result.Data))

	appendToolMessages(
		ctx.Messages,
		ctx.CurrentAIContent.String(),
		ctx.ReasoningContentText.String(),
		ctx.CurrentCallID,
		ctx.FuncName,
		funcArguments,
		md,
	)
	return nil
}
