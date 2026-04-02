package data

import (
	"strings"
	"time"

	"github.com/tidwall/gjson"
)

func init() {
	registerToolHandler("GetStockResearchReport", handleGetStockResearchReport)
}

// handleGetStockResearchReport 处理 GetStockResearchReport 工具调用
func handleGetStockResearchReport(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	stockCode := gjson.Get(funcArguments, "stockCode").String()

	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockResearchReport，\n参数：" + stockCode + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	res := NewMarketNewsApi().StockResearchReport(stockCode, 30)
	md := strings.Builder{}
	for _, a := range res {
		//logger.SugaredLogger.Debugf("value: %+v", a)
		d := a.(map[string]any)
		//logger.SugaredLogger.Debugf("value: %s  infoCode:%s", d["title"], d["infoCode"])
		md.WriteString(NewMarketNewsApi().GetIndustryReportInfo(d["infoCode"].(string)))
	}
	//logger.SugaredLogger.Infof("stockCode:%s StockResearchReport:\n %s", stockCode, md.String())

	appendToolMessages(
		ctx.Messages,
		ctx.CurrentAIContent.String(),
		ctx.ReasoningContentText.String(),
		ctx.CurrentCallID,
		ctx.FuncName,
		funcArguments,
		md.String(),
	)

	return nil
}
