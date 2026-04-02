package agent

import (
	"context"
	"errors"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"
	"github.com/samber/lo"
	"go-stock/backend/agent/tool_logger"
	"go-stock/backend/data"
	"go-stock/backend/logger"
	"io"
)

// @Author spark
// @Date 2025/8/7 9:07
// @Desc
// -----------------------------------------------------------------------------------
type StockAiAgent struct {
	*react.Agent
}

func NewStockAiAgentApi() *StockAiAgent {
	return &StockAiAgent{}
}

func (receiver StockAiAgent) newStockAiAgent(ctx *context.Context, aiConfigId int) *StockAiAgent {
	settingConfig := data.GetSettingConfig()
	aiConfig, ok := lo.Find(settingConfig.AiConfigs, func(item *data.AIConfig) bool {
		return uint(aiConfigId) == item.ID
	})
	if !ok {
		return nil
	}
	return &StockAiAgent{
		Agent: GetStockAiAgent(ctx, *aiConfig),
	}
}

func (receiver StockAiAgent) Chat(question string, aiConfigId int, sysPromptId *int) chan *schema.Message {
	ch := make(chan *schema.Message, 512)
	ctx := context.Background()
	stockAiAgent := receiver.newStockAiAgent(&ctx, aiConfigId)

	sysPrompt := ""
	if sysPromptId == nil || *sysPromptId == 0 {
		sysPrompt = "你现在扮演一位拥有20年实战经验的顶级股票投资大师，精通价值投资、趋势交易、量化分析等多种策略。你擅长结合宏观经济、行业周期和企业基本面进行全方位、精准的多维分析，尤其对A股、港股、美股市场有深刻理解，始终秉持“风险控制第一”的原则，善于用通俗易懂的方式传授投资智慧。"
	} else {
		sysPrompt = data.NewPromptTemplateApi().GetPromptTemplateByID(*sysPromptId)
	}
	agentOption := []agent.AgentOption{
		agent.WithComposeOptions(compose.WithCallbacks(&tool_logger.LoggerCallback{MessageChanel: ch})),
		//react.WithChatModelOptions(ark.WithCache(cacheOption)),
	}

	go func() {
		defer close(ch)
		sr, err := stockAiAgent.Stream(ctx, []*schema.Message{
			{
				Role:    schema.System,
				Content: sysPrompt,
			},
			{
				Role:    schema.User,
				Content: question,
			},
		}, agentOption...)
		if err != nil {
			logger.SugaredLogger.Errorf("stream error: %v", err)
			return
		}
		defer sr.Close()
		for {
			msg, err := sr.Recv()
			if err != nil {
				if errors.Is(err, io.EOF) {
					// finish
					break
				}
				// error
				logger.SugaredLogger.Errorf("failed to recv: %v", err)
				break
			}
			//logger.SugaredLogger.Infof("stream: %s", msg.String())
			ch <- msg
		}
	}()
	return ch
}
