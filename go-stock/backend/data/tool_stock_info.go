package data

import (
	"fmt"
	"time"

	"go-stock/backend/util"

	"github.com/tidwall/gjson"
)

func init() {
	registerToolHandler("GetIndustryValuation", handleGetIndustryValuation)
	registerToolHandler("GetStockConceptInfo", handleGetStockConceptInfo)
	registerToolHandler("GetStockFinancialInfo", handleGetStockFinancialInfo)
	registerToolHandler("GetStockHolderNum", handleGetStockHolderNum)
	registerToolHandler("GetStockHistoryMoneyData", handleGetStockHistoryMoneyData)
	registerToolHandler("SetTradingPrice", handleSetTradingPrice)
}

// handleGetIndustryValuation 处理 GetIndustryValuation 工具调用
func handleGetIndustryValuation(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetIndustryValuation，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	bkName := gjson.Get(funcArguments, "bkName").String()
	res := NewStockDataApi().GetIndustryValuation(bkName)
	md := util.MarkdownTableWithTitle(bkName+"行业估值", res.Result.Data)
	//logger.SugaredLogger.Infof("%s", md)

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

func handleSetTradingPrice(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：SetTradingPrice，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	stockCode := gjson.Get(funcArguments, "stockCode").String()
	entryPrice := gjson.Get(funcArguments, "entryPrice").Float()
	takeProfitPrice := gjson.Get(funcArguments, "takeProfitPrice").Float()
	stopLossPrice := gjson.Get(funcArguments, "stopLossPrice").Float()
	costPrice := gjson.Get(funcArguments, "costPrice").Float()

	result := NewStockDataApi().SetTradingPrice(entryPrice, takeProfitPrice, stopLossPrice, costPrice, stockCode)

	var content string
	if result == "设置成功" {
		content = fmt.Sprintf("✅ 价位线设置成功！\n\n📈 %s\n💰 开仓价：%.2f\n🎯 止盈价：%.2f\n🛑 止损价：%.2f\n💵 成本价：%.2f", stockCode, entryPrice, takeProfitPrice, stopLossPrice, costPrice)
	} else {
		content = fmt.Sprintf("❌ 价位线设置失败：%s", result)
	}

	//logger.SugaredLogger.Infof("%s", content)

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

// handleGetStockConceptInfo 处理 GetStockConceptInfo 工具调用
func handleGetStockConceptInfo(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockConceptInfo，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	code := gjson.Get(funcArguments, "code").String()
	res := NewStockDataApi().GetStockConceptInfo(code)
	md := util.MarkdownTableWithTitle(code+" 股票所属概念详细信息", res.Result.Data)
	//logger.SugaredLogger.Infof("%s", md)

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

// handleGetStockFinancialInfo 处理 GetStockFinancialInfo 工具调用
func handleGetStockFinancialInfo(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockFinancialInfo，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	stockCode := gjson.Get(funcArguments, "stockCode").String()
	res := NewStockDataApi().GetStockFinancialInfo(stockCode)
	md := util.MarkdownTableWithTitle("股票"+stockCode+"财务报表信息", res.Result.Data)
	//logger.SugaredLogger.Infof("%s", md)

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

// handleGetStockHolderNum 处理 GetStockHolderNum 工具调用
func handleGetStockHolderNum(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockHolderNum，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	stockCode := gjson.Get(funcArguments, "stockCode").String()
	res := NewStockDataApi().GetStockHolderNum(stockCode)
	md := util.MarkdownTableWithTitle("股票"+stockCode+"股东人数信息", res.Result.Data)
	//logger.SugaredLogger.Infof("%s", md)

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

// handleGetStockHistoryMoneyData 处理 GetStockHistoryMoneyData 工具调用
func handleGetStockHistoryMoneyData(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockHistoryMoneyData，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	stockCode := gjson.Get(funcArguments, "stockCode").String()
	res := NewStockDataApi().GetStockHistoryMoneyData(stockCode)
	md := util.MarkdownTableWithTitle("股票"+stockCode+"历史资金流向数据", res)
	//logger.SugaredLogger.Infof("%s", md)

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
