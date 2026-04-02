package main

import (
	"go-stock/backend/agent"
	"go-stock/backend/data"
	"go-stock/backend/logger"
	"go-stock/backend/models"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// @Author spark
// @Date 2025/6/8 20:45
// @Desc
//-----------------------------------------------------------------------------------

func (a *App) LongTigerRank(date string) *[]models.LongTigerRankData {
	return data.NewMarketNewsApi().LongTiger(date)
}

func (a *App) StockResearchReport(stockCode string) []any {
	return data.NewMarketNewsApi().StockResearchReport(stockCode, 7)
}
func (a *App) StockNotice(stockCode string) []any {
	return data.NewMarketNewsApi().StockNotice(stockCode)
}

func (a *App) IndustryResearchReport(industryCode string) []any {
	return data.NewMarketNewsApi().IndustryResearchReport(industryCode, 7)
}
func (a *App) EMDictCode(code string) []any {
	return data.NewMarketNewsApi().EMDictCode(code, a.cache)
}

func (a *App) AnalyzeSentiment(text string) models.SentimentResult {
	return data.AnalyzeSentiment(text)
}

func (a *App) HotStock(marketType string) *[]models.HotItem {
	return data.NewMarketNewsApi().XUEQIUHotStock(100, marketType)
}

func (a *App) HotEvent(size int) *[]models.HotEvent {
	if size <= 0 {
		size = 10
	}
	return data.NewMarketNewsApi().HotEvent(size)
}
func (a *App) HotTopic(size int) []any {
	if size <= 0 {
		size = 10
	}
	return data.NewMarketNewsApi().HotTopic(size)
}

func (a *App) InvestCalendarTimeLine(yearMonth string) []any {
	return data.NewMarketNewsApi().InvestCalendar(yearMonth)
}
func (a *App) ClsCalendar() []any {
	return data.NewMarketNewsApi().ClsCalendar()
}

func (a *App) SearchStock(words string) map[string]any {
	return data.NewSearchStockApi(words).SearchStock(5000)
}
func (a *App) GetHotStrategy() map[string]any {
	return data.NewSearchStockApi("").HotStrategy()
}

func (a *App) GetAllStocks(page int, pageSize int, name string, technicalIndicators models.TechnicalIndicators) *models.AllStocksResp {
	return data.NewStockDataApi().GetAllStocks(page, pageSize, name, technicalIndicators)
}

func (a *App) ChatWithAgent(question string, aiConfigId int, sysPromptId *int) {
	defer func() {
		if r := recover(); r != nil {
			logger.SugaredLogger.Errorf("ChatWithAgent panic: %v", r)
		}
	}()
	ch := agent.NewStockAiAgentApi().Chat(question, aiConfigId, sysPromptId)
	for msg := range ch {
		runtime.EventsEmit(a.ctx, "agent-message", msg)
	}
}

func (a *App) AnalyzeSentimentWithFreqWeight(text string) map[string]any {
	result, cleanFrequencies := data.NewsAnalyze(text, false)
	return map[string]any{
		"result":      result,
		"frequencies": cleanFrequencies,
	}
}

func (a *App) GetAIResponseResultList(query models.AIResponseResultQuery) *models.AIResponseResultPageData {
	page, err := data.NewAIResponseResultService().GetAIResponseResultList(query)
	if err != nil {
		return &models.AIResponseResultPageData{}
	}
	return page
}
func (a *App) DeleteAIResponseResult(id uint) string {
	err := data.NewAIResponseResultService().DeleteAIResponseResult(id)
	if err != nil {
		return "删除失败"
	}
	return "删除成功"
}
func (a *App) BatchDeleteAIResponseResult(ids []uint) string {
	err := data.NewAIResponseResultService().BatchDeleteAIResponseResult(ids)
	if err != nil {
		return "删除失败"
	}
	return "删除成功"
}

func (a *App) GetAiRecommendStocksList(query models.AiRecommendStocksQuery) *models.AiRecommendStocksPageData {
	page, err := data.NewAiRecommendStocksService().GetAiRecommendStocksList(&query)
	if err != nil {
		return &models.AiRecommendStocksPageData{}
	}
	return page
}
func (a *App) DeleteAiRecommendStocks(id uint) string {
	err := data.NewAiRecommendStocksService().DeleteAiRecommendStocks(id)
	if err != nil {
		return "删除失败"
	}
	return "删除成功"
}

func (a *App) UpdateAiRecommendStocksAlert(id uint, enableAlert bool) string {
	err := data.NewAiRecommendStocksService().UpdateAiRecommendStocksAlert(id, enableAlert)
	if err != nil {
		return "更新预警状态失败"
	}
	return "更新预警状态成功"
}

func (a *App) GetPromptTemplateList(query models.PromptTemplateQuery) *models.PromptTemplatePageData {
	page, err := data.NewPromptTemplateApi().GetPromptTemplateList(&query)
	if err != nil {
		return &models.PromptTemplatePageData{}
	}
	return page
}

func (a *App) AddPromptTemplate(template models.PromptTemplate) string {
	return data.NewPromptTemplateApi().AddPrompt(template)
}

func (a *App) UpdatePromptTemplate(template models.PromptTemplate) string {
	return data.NewPromptTemplateApi().AddPrompt(template)
}

func (a *App) DeletePromptTemplate(id uint) string {
	return data.NewPromptTemplateApi().DelPrompt(id)
}

func (a *App) GetAllStockInfoList(query data.AllStockInfoQuery) *data.AllStockInfoPageData {
	page, err := data.NewStockDataApi().GetAllStockInfoList(&query)
	if err != nil {
		return &data.AllStockInfoPageData{}
	}
	return page
}

func (a *App) GetAllStockInfoById(id uint) *models.AllStockInfo {
	stock, err := data.NewStockDataApi().GetAllStockInfoById(id)
	if err != nil {
		return &models.AllStockInfo{}
	}
	return stock
}

func (a *App) AddAllStockInfo(stock models.AllStockInfo) string {
	err := data.NewStockDataApi().AddAllStockInfo(stock)
	if err != nil {
		return "操作失败: " + err.Error()
	}
	return "操作成功"
}

func (a *App) DeleteAllStockInfo(id uint) string {
	err := data.NewStockDataApi().DeleteAllStockInfo(id)
	if err != nil {
		return "删除失败: " + err.Error()
	}
	return "删除成功"
}

func (a *App) BatchDeleteAllStockInfo(ids []uint) string {
	err := data.NewStockDataApi().BatchDeleteAllStockInfo(ids)
	if err != nil {
		return "批量删除失败: " + err.Error()
	}
	return "批量删除成功"
}

func (a *App) GetAllMarkets() []string {
	markets, err := data.NewStockDataApi().GetAllMarkets()
	if err != nil {
		return []string{}
	}
	return markets
}

func (a *App) GetAllIndustries() []string {
	industries, err := data.NewStockDataApi().GetAllIndustries()
	if err != nil {
		return []string{}
	}
	return industries
}

func (a *App) GetAllConcepts() []string {
	concepts, err := data.NewStockDataApi().GetAllConcepts()
	if err != nil {
		return []string{}
	}
	return concepts
}
