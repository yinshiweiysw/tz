package data

import (
	"context"
	"encoding/json"
	"fmt"
	"go-stock/backend/db"
	"go-stock/backend/logger"
	"go-stock/backend/models"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/samber/lo"
	"gorm.io/gorm"
)

type CronTaskApi struct{}

func NewCronTaskApi() *CronTaskApi {
	return &CronTaskApi{}
}

func (a *CronTaskApi) Create(task *models.CronTask) error {
	return db.Dao.Create(task).Error
}

func (a *CronTaskApi) Update(task *models.CronTask) error {
	if task == nil || task.ID == 0 {
		return fmt.Errorf("无效的任务ID")
	}

	// 只更新基础配置字段，不更新 last_run_at / next_run_at / run_count
	updates := map[string]any{
		"name":        task.Name,
		"cron_expr":   task.CronExpr,
		"task_type":   task.TaskType,
		"target":      task.Target,
		"params":      task.Params,
		"enable":      task.Enable,
		"status":      task.Status,
		"description": task.Description,
	}

	return db.Dao.Model(&models.CronTask{}).
		Where("id = ?", task.ID).
		Updates(updates).Error
}

func (a *CronTaskApi) Delete(id uint) error {
	return db.Dao.Delete(&models.CronTask{}, id).Error
}

func (a *CronTaskApi) GetByID(id uint) (*models.CronTask, error) {
	var task models.CronTask
	err := db.Dao.First(&task, id).Error
	if err != nil {
		return nil, err
	}
	return &task, nil
}

func (a *CronTaskApi) List(query *models.CronTaskQuery) *models.CronTaskPageResp {
	var tasks []models.CronTask
	var total int64

	dbQuery := db.Dao.Model(&models.CronTask{})

	if query.Name != "" {
		dbQuery = dbQuery.Where("name LIKE ?", "%"+query.Name+"%")
	}
	if query.TaskType != "" {
		dbQuery = dbQuery.Where("task_type = ?", query.TaskType)
	}
	if query.Status != "" {
		dbQuery = dbQuery.Where("status = ?", query.Status)
	}
	if query.Enable != nil {
		dbQuery = dbQuery.Where("enable = ?", *query.Enable)
	}

	dbQuery.Count(&total)

	page := query.Page
	pageSize := query.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 10
	}

	err := dbQuery.Offset((page - 1) * pageSize).Limit(pageSize).Order("created_at DESC").Find(&tasks).Error
	if err != nil {
		logger.SugaredLogger.Errorf("查询定时任务列表失败:%s", err.Error())
		return nil
	}

	return &models.CronTaskPageResp{
		Total: int(total),
		Data:  tasks,
	}
}

func (a *CronTaskApi) GetAll() []models.CronTask {
	var tasks []models.CronTask
	db.Dao.Where("enable = ?", true).Order("created_at DESC").Find(&tasks)
	return tasks
}

func (a *CronTaskApi) EnableTask(id uint, enable bool) error {
	return db.Dao.Model(&models.CronTask{}).Where("id = ?", id).Updates(map[string]any{
		"enable": enable,
	}).Error
}

func (a *CronTaskApi) UpdateRunInfo(id uint, lastRunAt time.Time, nextRunAt *time.Time) error {
	return db.Dao.Model(&models.CronTask{}).Where("id = ?", id).Updates(map[string]any{
		"last_run_at": lastRunAt,
		"next_run_at": nextRunAt,
		"run_count":   gorm.Expr("run_count + 1"),
	}).Error
}

func (a *CronTaskApi) GetTaskTypes() []lo.Tuple2[string, string] {
	return []lo.Tuple2[string, string]{
		{A: "stock_analysis", B: "股票分析"},
		{A: "market_analysis", B: "市场分析"},
		{A: "global_stock_index_cache", B: "全球指数缓存"},
		//{A: "fund_analysis", B: "基金分析"},
		//{A: "stock_monitor", B: "股票监控"},
		//{A: "news_fetch", B: "新闻抓取"},
		//{A: "custom", B: "自定义任务"},
	}
}

func (a *CronTaskApi) ValidateCronExpr(expr string) error {
	_, err := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(expr)
	return err
}

// CalculateNextRunTimes 计算未来多次运行时间
func (a *CronTaskApi) CalculateNextRunTimes(cronExpr string, count int) []time.Time {
	if count <= 0 {
		return []time.Time{}
	}

	schedule, err := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(cronExpr)
	if err != nil {
		logger.SugaredLogger.Errorf("解析 Cron 表达式失败：%v", err)
		return []time.Time{}
	}

	times := make([]time.Time, 0, count)
	next := time.Now()
	for i := 0; i < count; i++ {
		next = schedule.Next(next)
		times = append(times, next)
	}
	return times
}

func (a *CronTaskApi) SearchTasks(keyword string) []models.CronTask {
	var tasks []models.CronTask
	query := db.Dao.Model(&models.CronTask{})
	if keyword != "" {
		keyword = strings.TrimSpace(keyword)
		query = query.Where("name LIKE ? OR target LIKE ? OR description LIKE ?",
			"%"+keyword+"%", "%"+keyword+"%", "%"+keyword+"%")
	}
	query.Order("created_at DESC").Limit(20).Find(&tasks)
	return tasks
}

// ExecuteTask 执行单个任务
func (a *CronTaskApi) ExecuteTask(ctx context.Context, task *models.CronTask) error {
	logger.SugaredLogger.Infof("开始执行定时任务：%s (ID: %d)", task.Name, task.ID)

	now := time.Now()
	nextRunAt := a.CalculateNextRunTime(task.CronExpr)

	// 更新运行信息
	err := a.UpdateRunInfo(task.ID, now, &nextRunAt)
	if err != nil {
		logger.SugaredLogger.Errorf("更新任务运行信息失败：%v", err)
		return err
	}

	// 根据任务类型执行不同逻辑
	switch task.TaskType {
	case "stock_analysis":
		return a.executeStockAnalysis(ctx, task)
	case "market_analysis":
		return a.executeMarketAnalysis(ctx, task)
	case "global_stock_index_cache":
		return a.executeGlobalStockIndexCache(ctx, task)
	case "fund_analysis":
		return a.executeFundAnalysis(ctx, task)
	case "news_fetch":
		return a.executeNewsFetch(ctx, task)
	case "stock_monitor":
		return a.executeStockMonitor(ctx, task)
	case "custom":
		return a.executeCustomTask(ctx, task)
	default:
		logger.SugaredLogger.Warnf("未知任务类型：%s", task.TaskType)
		return fmt.Errorf("未知任务类型：%s", task.TaskType)
	}
}

// CalculateNextRunTime 计算下次运行时间
func (a *CronTaskApi) CalculateNextRunTime(cronExpr string) time.Time {
	schedule, err := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(cronExpr)
	if err != nil {
		return time.Now().Add(time.Hour) // 默认 1 小时后
	}
	return schedule.Next(time.Now())
}

// executeStockAnalysis 执行股票分析任务
func (a *CronTaskApi) executeStockAnalysis(ctx context.Context, task *models.CronTask) error {
	logger.SugaredLogger.Infof("执行股票分析任务：%s", task.Name)
	var params struct {
		PromptId    int    `json:"promptId"`
		AiConfigId  int    `json:"aiConfigId"`
		SysPromptId int    `json:"sysPromptId"`
		Thinking    bool   `json:"thinking"`
		StockCode   string `json:"stockCode"`
		StockName   string `json:"stockName"`
	}
	if task.Params != "" {
		err := json.Unmarshal([]byte(task.Params), &params)
		if err != nil {
			logger.SugaredLogger.Errorf("解析任务参数失败：%v", err)
			return err
		}
	}

	prompt := fmt.Sprintf("分析总结市场资讯，针对%s[%s]，找出潜在投资机会", params.StockName, params.StockCode)
	prompt = NewPromptTemplateApi().GetPromptTemplateByID(params.PromptId)
	var tools []Tool
	tools = Tools(tools)
	msgs := NewDeepSeekOpenAi(ctx, params.AiConfigId).NewChatStream(params.StockName, ConvertTushareCodeToStockCode(params.StockCode), prompt, &params.SysPromptId, tools, params.Thinking)
	content := &strings.Builder{}
	for msg := range msgs {
		content.WriteString(msg["content"].(string))
	}
	logger.SugaredLogger.Infof("content:%s", content.String())
	NewDeepSeekOpenAi(ctx, params.AiConfigId).SaveAIResponseResult(params.StockCode, params.StockName, content.String(), "", prompt)
	return nil
}

// executeFundAnalysis 执行基金分析任务
func (a *CronTaskApi) executeFundAnalysis(ctx context.Context, task *models.CronTask) error {
	var params struct {
		FundCodes  []string `json:"fund_codes"`
		AiConfigId int      `json:"ai_config_id"`
	}

	if task.Params != "" {
		err := json.Unmarshal([]byte(task.Params), &params)
		if err != nil {
			logger.SugaredLogger.Errorf("解析任务参数失败：%v", err)
			return err
		}
	}

	for _, fundCode := range params.FundCodes {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			// TODO: 调用基金分析逻辑
			logger.SugaredLogger.Infof("分析基金：%s", fundCode)
		}
	}

	return nil
}

// executeNewsFetch 执行新闻抓取任务
func (a *CronTaskApi) executeNewsFetch(ctx context.Context, task *models.CronTask) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		// 获取财联社电报
		NewMarketNewsApi().TelegraphList(30)
		logger.SugaredLogger.Info("新闻抓取完成")
		return nil
	}
}

// executeStockMonitor 执行股票监控任务
func (a *CronTaskApi) executeStockMonitor(ctx context.Context, task *models.CronTask) error {
	var params struct {
		StockCodes      []string `json:"stock_codes"`
		PriceThreshold  float64  `json:"price_threshold"`
		ChangeThreshold float64  `json:"change_threshold"`
	}

	if task.Params != "" {
		err := json.Unmarshal([]byte(task.Params), &params)
		if err != nil {
			logger.SugaredLogger.Errorf("解析任务参数失败：%v", err)
			return err
		}
	}

	for _, stockCode := range params.StockCodes {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			// TODO: 调用股票监控逻辑
			logger.SugaredLogger.Infof("监控股票：%s", stockCode)
		}
	}

	return nil
}

// executeCustomTask 执行自定义任务
func (a *CronTaskApi) executeCustomTask(ctx context.Context, task *models.CronTask) error {
	logger.SugaredLogger.Infof("执行自定义任务：%s", task.Name)
	// TODO: 自定义任务逻辑
	return nil
}

func (a *CronTaskApi) executeMarketAnalysis(ctx context.Context, task *models.CronTask) error {
	logger.SugaredLogger.Infof("执行市场分析任务：%s", task.Name)
	var params struct {
		PromptId    int  `json:"promptId"`
		AiConfigId  int  `json:"aiConfigId"`
		SysPromptId int  `json:"sysPromptId"`
		Thinking    bool `json:"thinking"`
	}
	if task.Params != "" {
		err := json.Unmarshal([]byte(task.Params), &params)
		if err != nil {
			logger.SugaredLogger.Errorf("解析任务参数失败：%v", err)
			return err
		}
	}

	prompt := "分析总结市场资讯，找出潜在投资机会"
	prompt = NewPromptTemplateApi().GetPromptTemplateByID(params.PromptId)
	var tools []Tool
	tools = Tools(tools)
	msgs := NewDeepSeekOpenAi(ctx, params.AiConfigId).NewSummaryStockNewsStreamWithTools(prompt, &params.SysPromptId, tools, params.Thinking, nil)
	content := &strings.Builder{}
	for msg := range msgs {
		content.WriteString(msg["content"].(string))
	}
	logger.SugaredLogger.Infof("content:%s", content.String())
	NewDeepSeekOpenAi(ctx, params.AiConfigId).SaveAIResponseResult("市场分析", "市场分析", content.String(), "", prompt)
	return nil
}

// executeGlobalStockIndexCache 执行全球指数缓存任务
func (a *CronTaskApi) executeGlobalStockIndexCache(ctx context.Context, task *models.CronTask) error {
	logger.SugaredLogger.Infof("执行全球指数缓存任务：%s", task.Name)
	var params struct {
		CrawlTimeOut uint `json:"crawlTimeOut"`
	}
	if task.Params != "" {
		err := json.Unmarshal([]byte(task.Params), &params)
		if err != nil {
			logger.SugaredLogger.Errorf("解析任务参数失败：%v", err)
			return err
		}
	}
	if params.CrawlTimeOut == 0 {
		params.CrawlTimeOut = 30
	}
	return NewMarketNewsApi().CacheGlobalStockIndexes(params.CrawlTimeOut)
}
