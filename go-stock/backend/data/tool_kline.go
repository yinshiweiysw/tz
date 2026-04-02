package data

import (
	"encoding/json"
	"time"

	"github.com/duke-git/lancet/v2/convertor"
	"github.com/duke-git/lancet/v2/strutil"
	"github.com/tidwall/gjson"
)

func init() {
	registerToolHandler("GetStockKLine", handleGetStockKLine)
}

// handleGetStockKLine 处理 GetStockKLine 工具调用
func handleGetStockKLine(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	stockCode := gjson.Get(funcArguments, "stockCode").String()
	days := gjson.Get(funcArguments, "days").String()

	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetStockKLine，\n参数：" + stockCode + "," + days + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	toIntDay, convErr := convertor.ToInt(days)
	if convErr != nil {
		toIntDay = 90
	}

	if strutil.HasPrefixAny(stockCode, []string{"sz", "sh", "hk", "us", "gb_"}) {
		K := &[]KLineData{}
		if strutil.HasPrefixAny(stockCode, []string{"sz", "sh"}) {
			K = NewStockDataApi().GetKLineData(stockCode, "240", o.KDays)
		}
		if strutil.HasPrefixAny(stockCode, []string{"hk", "us", "gb_"}) {
			K = NewStockDataApi().GetHK_KLineData(stockCode, "day", o.KDays)
		}
		Kmap := &[]map[string]any{}
		for _, kline := range *K {
			mapk := make(map[string]any, 6)
			mapk["日期"] = kline.Day
			mapk["开盘价"] = kline.Open
			mapk["最高价"] = kline.High
			mapk["最低价"] = kline.Low
			mapk["收盘价"] = kline.Close
			Volume, _ := convertor.ToFloat(kline.Volume)
			mapk["成交量(万手)"] = Volume / 10000.00 / 100.00
			*Kmap = append(*Kmap, mapk)
		}
		jsonData, _ := json.Marshal(Kmap)
		markdownTable, _ := JSONToMarkdownTable(jsonData)
		//logger.SugaredLogger.Infof("getKLineData=\n%s", markdownTable)

		res := "\r\n ### " + stockCode + convertor.ToString(toIntDay) + "日K线数据：\r\n" + markdownTable + "\r\n"
		appendToolMessages(
			ctx.Messages,
			ctx.CurrentAIContent.String(),
			ctx.ReasoningContentText.String(),
			ctx.CurrentCallID,
			ctx.FuncName,
			funcArguments,
			res,
		)
		//logger.SugaredLogger.Infof("GetStockKLine:stockCode:%s days:%s --> \n%s", stockCode, days, res)
		return nil
	}

	appendToolMessages(
		ctx.Messages,
		ctx.CurrentAIContent.String(),
		ctx.ReasoningContentText.String(),
		ctx.CurrentCallID,
		ctx.FuncName,
		funcArguments,
		"无数据，可能股票代码错误。（A股：sh,sz开头;港股hk开头,美股：us开头）",
	)

	return nil
}
