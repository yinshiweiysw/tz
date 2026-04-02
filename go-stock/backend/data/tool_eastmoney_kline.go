package data

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/duke-git/lancet/v2/convertor"
	"github.com/tidwall/gjson"
)

func init() {
	registerToolHandler("GetEastMoneyKLine", handleGetEastMoneyKLine)
	registerToolHandler("GetEastMoneyKLineWithMA", handleGetEastMoneyKLineWithMA)
}

// normalizeKLineType 将前端/自然语言 K 线类型转为东方财富 API 参数
func normalizeKLineType(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	switch s {
	case "day", "日", "101", "日k", "日k线":
		return "101"
	case "week", "周", "102", "周k", "周k线":
		return "102"
	case "month", "月", "103", "月k", "月k线":
		return "103"
	case "quarter", "季", "104", "季k", "季k线":
		return "104"
	case "halfyear", "半年", "105", "半年k", "半年k线", "半年k线图":
		return "105"
	case "year", "年", "106", "年k", "年k线":
		return "106"
	case "1", "1min", "1分钟":
		return "1"
	case "5", "5min", "5分钟":
		return "5"
	case "15", "15min", "15分钟":
		return "15"
	case "30", "30min", "30分钟":
		return "30"
	case "60", "60min", "60分钟":
		return "60"
	case "120", "120min", "120分钟", "2h", "两小时", "2小时":
		return "120"
	default:
		return s
	}
}

func handleGetEastMoneyKLine(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	stockCode := gjson.Get(funcArguments, "stockCode").String()
	kLineType := gjson.Get(funcArguments, "kLineType").String()
	adjustFlag := gjson.Get(funcArguments, "adjustFlag").String()
	limit := gjson.Get(funcArguments, "limit").Int()
	if limit <= 0 {
		limit = 60
	}

	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetEastMoneyKLine，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	api := NewEastMoneyKLineApi(GetSettingConfig())
	if !api.ValidateStockCode(stockCode) {
		appendToolMessages(ctx.Messages, ctx.CurrentAIContent.String(), ctx.ReasoningContentText.String(),
			ctx.CurrentCallID, ctx.FuncName, funcArguments, "股票代码无效，请使用正确格式（如 000001.SZ、600000.SH、00700.HK）。")
		return nil
	}

	kType := normalizeKLineType(kLineType)
	var list *[]KLineData
	if adjustFlag != "" && (kType == "101" || kType == "day") {
		adj := strings.TrimSpace(strings.ToLower(adjustFlag))
		if adj != "qfq" && adj != "hfq" {
			adj = "qfq"
		}
		list = api.GetAdjustedKLine(stockCode, adj, int(limit))
	} else {
		list = api.GetKLineData(stockCode, kType, strings.TrimSpace(adjustFlag), int(limit))
	}

	if list == nil || len(*list) == 0 {
		appendToolMessages(ctx.Messages, ctx.CurrentAIContent.String(), ctx.ReasoningContentText.String(),
			ctx.CurrentCallID, ctx.FuncName, funcArguments, "未获取到 K 线数据，请检查股票代码与类型。")
		return nil
	}

	rows := make([]map[string]any, 0, len(*list))
	for _, k := range *list {
		vol, _ := convertor.ToFloat(k.Volume)
		rows = append(rows, map[string]any{
			"日期":      k.Day,
			"开盘价":     k.Open,
			"收盘价":     k.Close,
			"最高价":     k.High,
			"最低价":     k.Low,
			"成交量(万手)": vol / 10000 / 100,
			"涨跌幅(%)":  k.ChangePercent,
			"涨跌额":     k.ChangeValue,
			"振幅(%)":   k.Amplitude,
			"换手率(%)":  k.TurnoverRate,
		})
	}
	jsonData, _ := json.Marshal(rows)
	markdownTable, err := JSONToMarkdownTable(jsonData)
	if err != nil {
		markdownTable = string(jsonData)
	}
	typeLabel := kLineType
	if typeLabel == "" {
		typeLabel = kType
	}
	res := "\r\n### " + stockCode + " " + typeLabel + " K线（共 " + convertor.ToString(len(*list)) + " 条）\r\n" + markdownTable + "\r\n"
	//logger.SugaredLogger.Infof("GetEastMoneyKLine: %s %s -> %d 条", stockCode, kType, len(*list))
	appendToolMessages(ctx.Messages, ctx.CurrentAIContent.String(), ctx.ReasoningContentText.String(),
		ctx.CurrentCallID, ctx.FuncName, funcArguments, res)
	return nil
}

// sortMALabels 按 MA 周期数字排序，如 MA5,MA10,MA20,MA60
func sortMALabels(labels []string) []string {
	if len(labels) <= 1 {
		return labels
	}
	nums := make([]int, len(labels))
	for i, l := range labels {
		n, _ := strconv.Atoi(strings.TrimPrefix(l, "MA"))
		nums[i] = n
	}
	for i := 0; i < len(nums); i++ {
		for j := i + 1; j < len(nums); j++ {
			if nums[i] > nums[j] {
				nums[i], nums[j] = nums[j], nums[i]
				labels[i], labels[j] = labels[j], labels[i]
			}
		}
	}
	return labels
}

// parseMaPeriods 解析 "5,10,20,60" 为 []int
func parseMaPeriods(s string) []int {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 {
			continue
		}
		out = append(out, n)
	}
	return out
}

func handleGetEastMoneyKLineWithMA(o *OpenAi, funcArguments string, ctx *ToolContext) error {
	stockCode := gjson.Get(funcArguments, "stockCode").String()
	kLineType := gjson.Get(funcArguments, "kLineType").String()
	limit := gjson.Get(funcArguments, "limit").Int()
	maPeriodsStr := gjson.Get(funcArguments, "maPeriods").String()
	if limit <= 0 {
		limit = 60
	}

	ctx.Ch <- map[string]any{
		"code":     1,
		"question": ctx.Question,
		"chatId":   ctx.StreamResponseID,
		"model":    ctx.Model,
		"content":  "\r\n```\r\n开始调用工具：GetEastMoneyKLineWithMA，\n参数：" + funcArguments + "\r\n```\r\n",
		"time":     time.Now().Format(time.DateTime),
	}

	api := NewEastMoneyKLineApi(GetSettingConfig())
	if !api.ValidateStockCode(stockCode) {
		appendToolMessages(ctx.Messages, ctx.CurrentAIContent.String(), ctx.ReasoningContentText.String(),
			ctx.CurrentCallID, ctx.FuncName, funcArguments, "股票代码无效，请使用正确格式（如 000001.SZ、600000.SH、00700.HK）。")
		return nil
	}

	kType := normalizeKLineType(kLineType)
	maPeriods := parseMaPeriods(maPeriodsStr)
	list, err := api.GetKLineWithMA(stockCode, kType, int(limit), maPeriods...)
	if err != nil || list == nil || len(*list) == 0 {
		appendToolMessages(ctx.Messages, ctx.CurrentAIContent.String(), ctx.ReasoningContentText.String(),
			ctx.CurrentCallID, ctx.FuncName, funcArguments, "未获取到带均线的 K 线数据，请检查股票代码与参数。")
		return nil
	}

	// 均线列名：若调用时传了 maPeriods 用其顺序，否则从第一条数据的 MA 中取（API 默认 5,10,20,60）
	maLabels := make([]string, 0, len(maPeriods))
	if len(maPeriods) > 0 {
		for _, p := range maPeriods {
			maLabels = append(maLabels, "MA"+strconv.Itoa(p))
		}
	} else if len(*list) > 0 && (*list)[0].MA != nil {
		for p := range (*list)[0].MA {
			maLabels = append(maLabels, "MA"+p)
		}
		// 按周期数字排序，保证列顺序稳定
		maLabels = sortMALabels(maLabels)
	}
	rows := make([]map[string]any, 0, len(*list))
	for _, k := range *list {
		vol, _ := convertor.ToFloat(k.Volume)
		row := map[string]any{
			"日期":      k.Day,
			"开盘价":     k.Open,
			"收盘价":     k.Close,
			"最高价":     k.High,
			"最低价":     k.Low,
			"成交量(万手)": vol / 10000 / 100,
			"涨跌幅(%)":  k.ChangePercent,
			"涨跌额":     k.ChangeValue,
			"振幅(%)":   k.Amplitude,
			"换手率(%)":  k.TurnoverRate,
		}
		for _, label := range maLabels {
			p := strings.TrimPrefix(label, "MA")
			if v, ok := k.MA[p]; ok && v != "" {
				row[label] = v
			}
		}
		rows = append(rows, row)
	}
	jsonData, _ := json.Marshal(rows)
	markdownTable, err := JSONToMarkdownTable(jsonData)
	if err != nil {
		markdownTable = string(jsonData)
	}
	typeLabel := kLineType
	if typeLabel == "" {
		typeLabel = kType
	}
	res := "\r\n### 东方财富 " + stockCode + " " + typeLabel + " K线+均线（共 " + convertor.ToString(len(*list)) + " 条）\r\n" + markdownTable + "\r\n"
	//logger.SugaredLogger.Infof("GetEastMoneyKLineWithMA: %s %s limit=%d maPeriods=%v -> %d 条", stockCode, kType, limit, maPeriods, len(*list))
	appendToolMessages(ctx.Messages, ctx.CurrentAIContent.String(), ctx.ReasoningContentText.String(),
		ctx.CurrentCallID, ctx.FuncName, funcArguments, res)
	return nil
}
