package data

// @Author spark
// @Date 2026/3/7 18:48
// @Desc
//-----------------------------------------------------------------------------------

func Tools(tools []Tool) []Tool {
	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name: "SearchStockByIndicators",
			Description: "根据自然语言筛选股票。可以使用K线形态描述来选股，输入股票名称可以获取当前股票最新的股价交易数据和基础财务指标信息，多个股票名称使用,分隔。" +
				"例如：K线形态选股：倒转锤头或射击之星或身怀六甲" +
				"例如:分析强势方向：10点半之前涨停，非一字板，行业概念，按成交量从高到低排序。" +
				"例如:查看涨停板：涨停板，按涨幅从高到低排序。" +
				"例如:查看跌停板：跌停板，按跌幅从高到低排序。" +
				"例如:查看龙虎榜：龙虎榜，按涨幅从高到低排序。" +
				"例如:查看昨日龙虎榜：昨日龙虎榜。" +
				"例如:查看板块龙头行情：板块/概念龙头，按涨幅从高到低排序。" +
				"例如:查看板块龙头行情：龙头股，按成交量从高到低排序。" +
				"例如:查看技术指标：上海贝岭,macd,rsi,kdj,boll,5日均线,14日均线,30日均线,60日均线,成交量,OBV,EMA。" +
				"例如:查看近期趋势：量比连续2天>1，主力连续2日净流入且递增，主力净额>3000万元，行业，股价在20日线上。按成交量从高到低排序。" +
				"例如:当日成交量 ≥ 近 5 日平均成交量 ×1.5，收盘价 ≥ 20 日均线，20 日均线 ≥ 60 日均线，当日涨幅 3%-7%， 3日主力资金净流入累计≥5000 万元，当日换手率 5%-15%，筹码集中度（90% 筹码峰）≤15%，非创业板非科创板非ST非北交所，行业。按成交量从高到低排序。" +
				"例如:查看有潜力的成交量爆发股：最近7日成交量量比大于3，出现过一次，非ST。按成交量从高到低排序。" +
				"例如:超短线策略：当日成交量大于前一日成交量的1.8倍;当日最高价创60日新高当日收盘价大于5日均线;当日为阳线;股价小于200;" +
				"例1：创新药,半导体;PE<30;净利润增长率>50%。 按成交量从高到低排序。" +
				"例2：上证指数,科创50。 " +
				"例3：长电科技,上海贝岭。" +
				"例4：长电科技,上海贝岭;KDJ,MACD,RSI,BOLL,主力资金。" +
				"例5：换手率大于3%小于25%.量比1以上. 10日内有过涨停.股价处于峰值的二分之一以下.流通股本<100亿.当日和连续四日净流入;股价在20日均线以上.分时图股价在均线之上.热门板块下涨幅领先的A股. 当日量能20000手以上.沪深个股.近一年市盈率波动小于150%.MACD金叉;不要ST股及不要退市股，非北交所，每股收益>0。按成交量从高到低排序。" +
				"例6：沪深主板.流通市值小于100亿.市值大于10亿.60分钟dif大于dea.60分钟skdj指标k值大于d值.skdj指标k值小于90.换手率大于3%.成交额大于1亿元.量比大于2.涨幅大于2%小于7%.股价大于5小于50.创业板.10日均线大于20日均线;不要ST股及不要退市股;不要北交所;不要科创板;不要创业板。按成交量从高到低排序。" +
				"例7：股价在20日线上，一月之内涨停次数>=1，量比大于1，换手率大于3%。按成交量从高到低排序。" +
				"例8：基本条件：前期有爆量，回调到 10 日线，当日是缩量阴线，均线趋势向上。;优选条件：一月之内涨停次数>=1。按成交量从高到低排序。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"words": map[string]any{
						"type": "string",
						"description": "选股自然语言。可以使用K线形态描述来选股。" +
							"例如：K线形态选股：倒转锤头或射击之星或身怀六甲" +
							"例如:分析强势方向：10点半之前涨停，非一字板，行业概念，按成交量从高到低排序。" +
							"例如:查看涨停板：涨停板，按涨幅从高到低排序。" +
							"例如:查看跌停板：跌停板，按跌幅从高到低排序。" +
							"例如:查看龙虎榜：龙虎榜，按涨幅从高到低排序。" +
							"例如:查看昨日龙虎榜：昨日龙虎榜。" +
							"例如:查看板块龙头行情：板块/概念龙头，按涨幅从高到低排序。" +
							"例如:查看板块龙头行情：龙头股，按成交量从高到低排序。" +
							"例如:查看技术指标：上海贝岭,macd,rsi,kdj,boll,5日均线,14日均线,30日均线,60日均线,成交量,OBV,EMA。" +
							"例如:查看近期趋势：量比连续2天>1，主力连续2日净流入且递增，主力净额>3000万元，行业，股价在20日线上。按成交量从高到低排序。" +
							"例如:当日成交量 ≥ 近 5 日平均成交量 ×1.5，收盘价 ≥ 20 日均线，20 日均线 ≥ 60 日均线，当日涨幅 3%-7%， 3日主力资金净流入累计≥5000 万元，当日换手率 5%-15%，筹码集中度（90% 筹码峰）≤15%，非创业板非科创板非ST非北交所，行业。按成交量从高到低排序。" +
							"例如:查看有潜力的成交量爆发股：最近7日成交量量比大于3，出现过一次，非ST。按成交量从高到低排序。" +
							"例如:超短线策略：当日成交量大于前一日成交量的1.8倍;当日最高价创60日新高当日收盘价大于5日均线;当日为阳线;股价小于200;" +
							"例1：创新药,半导体;PE<30;净利润增长率>50%。 按成交量从高到低排序。" +
							"例2：上证指数,科创50。 " +
							"例3：长电科技,上海贝岭。" +
							"例4：长电科技,上海贝岭;KDJ,MACD,RSI,BOLL,主力资金。" +
							"例5：换手率大于3%小于25%.量比1以上. 10日内有过涨停.股价处于峰值的二分之一以下.流通股本<100亿.当日和连续四日净流入;股价在20日均线以上.分时图股价在均线之上.热门板块下涨幅领先的A股. 当日量能20000手以上.沪深个股.近一年市盈率波动小于150%.MACD金叉;不要ST股及不要退市股，非北交所，每股收益>0。按成交量从高到低排序。" +
							"例6：沪深主板.流通市值小于100亿.市值大于10亿.60分钟dif大于dea.60分钟skdj指标k值大于d值.skdj指标k值小于90.换手率大于3%.成交额大于1亿元.量比大于2.涨幅大于2%小于7%.股价大于5小于50.创业板.10日均线大于20日均线;不要ST股及不要退市股;不要北交所;不要科创板;不要创业板。按成交量从高到低排序。" +
							"例7：股价在20日线上，一月之内涨停次数>=1，量比大于1，换手率大于3%。按成交量从高到低排序。" +
							"例8：基本条件：前期有爆量，回调到 10 日线，当日是缩量阴线，均线趋势向上。;优选条件：一月之内涨停次数>=1。按成交量从高到低排序。",
					},
				},
				Required: []string{"words"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name: "SearchBk",
			Description: "根据自然语言查询板块/概念/指数整体数据。" +
				"例如:近3日涨停家数>5的概念板块。" +
				"例如:WR买入信号板块" +
				"例如:WR卖出信号板块" +
				"例如:存储芯片，成分股" +
				"例如:查看指数：上证指数，深证成指，创业板指，科创50。" +
				"例如:查看指数：上证50，沪深300，中证 500，中证1000。" +
				"例如:查看存储芯片板块：存储芯片。" +
				"例如:查看概念板块排名：今日涨幅前15的概念板块。" +
				"例如:查看概念板块排名：今日净流入前15的概念板块。" +
				"例如:查看行业排名：今日涨幅前15的行业板块。" +
				"例如:查看行业排名：今日净流入前15的行业板块。" +
				"例如:查看板块/概念排名数据：今日主力净流出前15的概念板块。" +
				"例如:查看板块板块/概念：今日成交量前15的概念板块。" +
				"例如:查看板块/概念排名数据：今日主力净流出前15的行业板块。" +
				"例如:查看板块板块/概念：今日成交量前15的行业板块。" +
				"例如:通过市盈率查询板块：当前市盈率介于30-50的板块/概念。",

			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"words": map[string]any{
						"type": "string",
						"description": "板块/概念数据查询自然语言。" +
							"例如:近3日涨停家数>5的概念板块。" +
							"例如:WR买入信号板块" +
							"例如:WR卖出信号板块" +
							"例如:存储芯片，成分股" +
							"例如:查看指数：上证指数，深证成指，创业板指，科创50。" +
							"例如:查看指数：上证50，沪深300，中证 500，中证1000。" +
							"例如:查看存储芯片板块：存储芯片。" +
							"例如:查看概念排名：今日涨幅前15的概念板块。" +
							"例如:查看概念排名：今日净流入前15的概念板块。" +
							"例如:查看行业排名：今日涨幅前15的行业板块。" +
							"例如:查看行业排名：今日净流入前15的行业板块。" +
							"例如:查看板块/概念排名数据：今日主力净流出前15的概念板块。" +
							"例如:查看板块板块/概念：今日成交量前15的概念板块。" +
							"例如:查看板块/概念排名数据：今日主力净流出前15的行业板块。" +
							"例如:查看板块板块/概念：今日成交量前15的行业板块。" +
							"例如:通过市盈率查询板块：当前市盈率介于30-50的板块/概念。",
					},
				},
				Required: []string{"words"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name: "SearchETF",
			Description: "根据自然语言查询etf数据。" +
				"例如:创新药或者机器人，按涨幅排序，前50。" +
				"例如:溢价率介于0%~10%之间，前50。" +
				"例如:3日涨幅前50的ETF。" +
				"例如:3日跌幅前50的ETF。" +
				"例如:今日涨幅前50的ETF。",

			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"words": map[string]any{
						"type": "string",
						"description": "板块/概念数据查询ETF。" +
							"例如:创新药或者机器人，按涨幅排序，前50。" +
							"例如:溢价率介于0%~10%之间，前50。" +
							"例如:3日涨幅前50的ETF。" +
							"例如:3日跌幅前50的ETF。" +
							"例如:今日涨幅前50的ETF。",
					},
				},
				Required: []string{"words"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockKLine",
			Description: "获取股票日K线数据。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"days": map[string]any{
						"type":        "string",
						"description": "日K数据条数",
					},
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码（A股：sh,sz开头;港股hk开头,美股：us开头）",
					},
				},
				Required: []string{"days", "stockCode"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetEastMoneyKLine",
			Description: "获取股票 K 线数据。支持日/周/月/季/年 K 线及 1/5/15/30/60 分钟线，可选前复权(qfq)或后复权(hfq)。股票代码格式：A股 000001.SZ、600000.SH，港股 00700.HK 等。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码。A股如 000001.SZ、600000.SH；港股如 00700.HK。",
					},
					"kLineType": map[string]any{
						"type":        "string",
						"description": "K 线类型：day/日/101=日K，week/周/102=周K，month/月/103=月K，quarter/季/104=季K，halfYear/半年/105=半年K，year/年/106=年K；分钟线：1/5/15/30/60/120。",
					},
					"adjustFlag": map[string]any{
						"type":        "string",
						"description": "复权类型，仅日K有效：空=不复权，qfq=前复权，hfq=后复权。",
					},
					"limit": map[string]any{
						"type":        "number",
						"description": "获取 K 线根数（日K为天数，周K为周数，月K为月数，分钟为天数内分钟数等）。",
					},
				},
				Required: []string{"stockCode", "kLineType", "limit"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetEastMoneyKLineWithMA",
			Description: "获取股票 K 线数据并带多条均线（SMA，按收盘价计算）。用于技术分析时同时查看 K 线与均线。股票代码格式同 GetEastMoneyKLine。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码。A股如 000001.SZ、600000.SH；港股如 00700.HK。",
					},
					"kLineType": map[string]any{
						"type":        "string",
						"description": "K 线类型：day/日/101=日K，week/周/102=周K，month/月/103=月K；分钟线：1/5/15/30/60/120。",
					},
					"limit": map[string]any{
						"type":        "number",
						"description": "获取 K 线根数（如 60 表示最近 60 根）。",
					},
					"maPeriods": map[string]any{
						"type":        "string",
						"description": "均线周期，逗号分隔，如 \"5,10,20,60\"。不传则默认 5,10,20,60,120。",
					},
				},
				Required: []string{"stockCode", "kLineType", "limit"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "InteractiveAnswer",
			Description: "获取投资者与上市公司互动问答的数据,反映当前投资者关注的热点问题",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"page": map[string]any{
						"type":        "string",
						"description": "分页号",
					},
					"pageSize": map[string]any{
						"type":        "string",
						"description": "分页大小",
					},
					"keyWord": map[string]any{
						"type":        "string",
						"description": "搜索关键词（可输入股票名称或者当前热门板块/行业/概念/标的/事件等）",
					},
				},
				Required: []string{"page", "pageSize"},
			},
		},
	})

	//tools = append(tools, Tool{
	//	Type: "function",
	//	Function: ToolFunction{
	//		Name:        "QueryBKDictInfo",
	//		Description: "获取所有板块/行业名称或者代码(bkCode,bkName)",
	//	},
	//})

	//tools = append(tools, Tool{
	//	Type: "function",
	//	Function: ToolFunction{
	//		Name:        "GetIndustryResearchReport",
	//		Description: "获取行业/板块研究报告,请先使用QueryBKDictInfo工具获取行业代码，然后输入行业代码调用",
	//		Parameters: FunctionParameters{
	//			Type: "object",
	//			Properties: map[string]any{
	//				"bkCode": map[string]any{
	//					"type":        "string",
	//					"description": "板块/行业代码",
	//				},
	//			},
	//			Required: []string{"bkCode"},
	//		},
	//	},
	//})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockResearchReport",
			Description: "获取市场分析师的股票研究报告",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码",
					},
				},
				Required: []string{"stockCode"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "HotStrategyTable",
			Description: "获取当前热门选股策略",
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "HotStockTable",
			Description: "当前热门股票排名",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"pageSize": map[string]any{
						"type":        "string",
						"description": "分页大小",
					},
				},
				Required: []string{"pageSize"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockMoneyData",
			Description: "今日股票资金流入排名",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"pageSize": map[string]any{
						"type":        "string",
						"description": "分页大小",
					},
				},
				Required: []string{"pageSize"},
			},
		},
	})
	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name: "GetMutualTop10Deal",
			Description: "获取互联互通渠道即:北向资金（沪股通、深股通）南向资金（港股通）当日十大成交股数据。" +
				"MUTUAL_TYPE=001 表示沪股通十大成交股；" +
				"002 表示港股通(沪)十大成交股；" +
				"003 表示深股通十大成交股；" +
				"004 表示港股通(深)十大成交股。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"mutualType": map[string]any{
						"type": "string",
						"description": "互联互通通道类型：" +
							"001=沪股通十大成交股，" +
							"002=港股通(沪)十大成交股，" +
							"003=深股通十大成交股，" +
							"004=港股通(深)十大成交股",
					},
					"tradeDate": map[string]any{
						"type":        "string",
						"description": "交易日期，格式：YYYY-MM-DD，例如 2026-03-16",
					},
					"page": map[string]any{
						"type":        "number",
						"description": "页码，从 1 开始，默认 1",
					},
					"pageSize": map[string]any{
						"type":        "number",
						"description": "每页条数，默认 10",
					},
				},
				Required: []string{"mutualType", "tradeDate"},
			},
		},
	})
	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockConceptInfo",
			Description: "获取股票所属概念详细信息",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"code": map[string]any{
						"type":        "string",
						"description": "股票代码,如：601138.SH。注意 上海证券交易所股票以.SH结尾，深圳证券交易所股票以.SZ结尾，港股股票以.HK结尾，北交所股票以.BJ结尾，",
					},
				},
				Required: []string{"code"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockFinancialInfo",
			Description: "获取股票财务报表信息",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码,如：601138.SH。注意 上海证券交易所股票以.SH结尾，深圳证券交易所股票以.SZ结尾，港股股票以.HK结尾，北交所股票以.BJ结尾，",
					},
				},
				Required: []string{"stockCode"},
			},
		},
	})
	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockHolderNum",
			Description: "获取股票股东人数信息(股东人数与股价比( 注:股票价格通常与股东人数成反比，股东人数越少代表筹码越集中，股价越有可能上涨))",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码,如：601138.SH。注意 上海证券交易所股票以.SH结尾，深圳证券交易所股票以.SZ结尾，港股股票以.HK结尾，北交所股票以.BJ结尾，",
					},
				},
				Required: []string{"stockCode"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockHistoryMoneyData",
			Description: "获取股票历史资金流向数据",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码,如：601138.SH。注意 上海证券交易所股票以.SH结尾，深圳证券交易所股票以.SZ结尾，港股股票以.HK结尾，北交所股票以.BJ结尾，",
					},
				},
				Required: []string{"stockCode"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetStockRZRQInfo",
			Description: "获取股票融资融券信息，包括融资余额、融券余额、两融余额、融资净买入等。适用于 A 股两融标的。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码。如：601138.SH、000001.SZ 或 sh601138、sz000001",
					},
				},
				Required: []string{"stockCode"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetIndustryValuation",
			Description: "获取行业/板块平均估值和中值（PE,PEG等）",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"bkName": map[string]any{
						"type":        "string",
						"description": "行业/板块名称,如：半导体",
					},
				},
				Required: []string{"bkName"},
			},
		},
	})

	//tools = append(tools, Tool{
	//	Type: "function",
	//	Function: ToolFunction{
	//		Name:        "CailianpressWeb",
	//		Description: "财经新闻资讯搜索",
	//		Parameters: &FunctionParameters{
	//			Type: "object",
	//			Properties: map[string]any{
	//				"searchWords": map[string]any{
	//					"type": "string",
	//					"description": "搜索关键词（不要使用分隔符如空格逗号），为空时返回最新10条新闻资讯" +
	//						"板块/概念名称：半导体\n" +
	//						"股票名称：中科曙光\n" +
	//						"政策：十五五规划\n",
	//				},
	//			},
	//			Required: []string{},
	//		},
	//	},
	//})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetNewsListData",
			Description: "获取新闻资讯",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"keyWord": map[string]any{
						"type":        "string",
						"description": "搜索时的关键词，可为空",
					},
					"startTime": map[string]any{
						"type":        "string",
						"description": "开始时间（如：2026-02-23 00:00:00）",
					},
					"limit": map[string]any{
						"type":        "number",
						"description": "每页条数（未传 page/pageSize 时生效，默认 20）",
					},
					"page": map[string]any{
						"type":        "number",
						"description": "页码，从 1 开始",
					},
					"pageSize": map[string]any{
						"type":        "number",
						"description": "每页条数，与 page 配合使用",
					},
				},
				Required: []string{"startTime"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GlobalStockIndexesReadable",
			Description: "获取全球主要指数概览，并输出为 AI 易读的 Markdown 结构化文本。",
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "SendToDingDing",
			Description: "将指定标题和内容以 Markdown 形式发送到钉钉机器人。用于把分析结果、摘要或通知推送到钉钉群。需在设置中开启钉钉推送并配置机器人 Webhook。通知内容需尽可能精简。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"title": map[string]any{
						"type":        "string",
						"description": "消息标题，会显示为「go-stock {title}」",
					},
					"message": map[string]any{
						"type":        "string",
						"description": "消息正文，支持 Markdown 格式，通知内容需尽可能精简",
					},
				},
				Required: []string{"title", "message"},
			},
		},
	})

	//CreateAiRecommendStocks
	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "CreateAiRecommendStocks",
			Description: "创建/保存AI推荐股票记录",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"modelName": map[string]any{
						"type":        "string",
						"description": "模型名称",
					},
					"rating": map[string]any{
						"type":        "string",
						"description": "评级(买入:强烈看好，预期显著跑赢行业 / 大盘，涨幅空间大。 增持:依然看好，预期跑赢行业 / 大盘，但强度弱于买入。中性:不看多也不看空，预期基本持平市场 / 行业。减持:不看好，预期跑输行业 / 大盘，建议减仓。卖出:强烈看空，预期大幅跑输，建议回避。)",
					},
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码,如：601138.SH。注意 上海证券交易所股票以.SH结尾，深圳证券交易所股票以.SZ结尾，港股股票以.HK结尾，北交所股票以.BJ结尾，",
					},
					"stockName": map[string]any{
						"type":        "string",
						"description": "股票名称",
					},
					"bkCode": map[string]any{
						"type":        "string",
						"description": "板块/行业代码",
					},
					"bkName": map[string]any{
						"type":        "string",
						"description": "板块/概念/行业名称",
					},
					"stockPrice": map[string]any{
						"type":        "string",
						"description": "推荐时股票价格",
					},
					"stockPrePrice": map[string]any{
						"type":        "string",
						"description": "前一交易日股票价格",
					},
					"stockClosePrice": map[string]any{
						"type":        "string",
						"description": "推荐时股票收盘价格",
					},
					"recommendReason": map[string]any{
						"type":        "string",
						"description": "推荐理由/驱动因素/逻辑",
					},
					"recommendBuyPrice": map[string]any{
						"type":        "string",
						"description": "ai建议买入价区间最低价和最高价之间用`-`分隔",
					},
					"recommendBuyPriceMax": map[string]any{
						"type":        "number",
						"description": "ai建议最高买入价",
					},
					"recommendBuyPriceMin": map[string]any{
						"type":        "number",
						"description": "ai建议最低买入价",
					},
					"recommendStopProfitPrice": map[string]any{
						"type":        "string",
						"description": "ai建议止盈价区间最低价和最高价之间用`-`分隔",
					},
					"recommendStopProfitPriceMax": map[string]any{
						"type":        "number",
						"description": "ai建议最高止盈价",
					},
					"recommendStopProfitPriceMin": map[string]any{
						"type":        "number",
						"description": "ai建议最低止盈价",
					},

					"recommendStopLossPrice": map[string]any{
						"type":        "string",
						"description": "ai建议止损价",
					},
					"riskRemarks": map[string]any{
						"type":        "string",
						"description": "风险提示",
					},
					"remarks": map[string]any{
						"type":        "string",
						"description": "操作总结/备注",
					},
				},
				Required: []string{"rating", "stockCode", "stockName", "bkName", "modelName", "recommendReason", "stockPrice"},
			},
		},
	})

	//BatchCreateAiRecommendStocks
	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "BatchCreateAiRecommendStocks",
			Description: "批量创建/保存AI推荐股票记录，建议每次批量保存5条记录",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stocks": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"modelName": map[string]any{
									"type":        "string",
									"description": "模型名称",
								},
								"rating": map[string]any{
									"type":        "string",
									"description": "评级(买入:强烈看好，预期显著跑赢行业 / 大盘，涨幅空间大。 增持:依然看好，预期跑赢行业 / 大盘，但强度弱于买入。中性:不看多也不看空，预期基本持平市场 / 行业。减持:不看好，预期跑输行业 / 大盘，建议减仓。卖出:强烈看空，预期大幅跑输，建议回避。)",
								},
								"stockCode": map[string]any{
									"type":        "string",
									"description": "股票代码,如：601138.SH。注意 上海证券交易所股票以.SH结尾，深圳证券交易所股票以.SZ结尾，港股股票以.HK结尾，北交所股票以.BJ结尾，",
								},
								"stockName": map[string]any{
									"type":        "string",
									"description": "股票名称",
								},
								"bkCode": map[string]any{
									"type":        "string",
									"description": "板块/行业代码",
								},
								"bkName": map[string]any{
									"type":        "string",
									"description": "板块/概念/行业名称",
								},
								"stockPrice": map[string]any{
									"type":        "string",
									"description": "推荐时股票价格",
								},
								"stockPrePrice": map[string]any{
									"type":        "string",
									"description": "前一交易日股票价格",
								},
								"stockClosePrice": map[string]any{
									"type":        "string",
									"description": "推荐时股票收盘价格",
								},
								"recommendReason": map[string]any{
									"type":        "string",
									"description": "推荐理由/驱动因素/逻辑",
								},
								"recommendBuyPrice": map[string]any{
									"type":        "string",
									"description": "ai建议买入价区间最低价和最高价之间用`-`分隔",
								},
								"recommendBuyPriceMin": map[string]any{
									"type":        "number",
									"description": "ai建议最低买入价",
								},
								"recommendBuyPriceMax": map[string]any{
									"type":        "number",
									"description": "ai建议最高买入价",
								},
								"recommendStopProfitPrice": map[string]any{
									"type":        "string",
									"description": "ai建议止盈价区间最低价和最高价之间用`-`分隔",
								},
								"recommendStopProfitPriceMin": map[string]any{
									"type":        "number",
									"description": "ai建议最低止盈价",
								},
								"recommendStopProfitPriceMax": map[string]any{
									"type":        "number",
									"description": "ai建议最高止盈价",
								},
								"recommendStopLossPrice": map[string]any{
									"type":        "string",
									"description": "ai建议止损价",
								},
								"riskRemarks": map[string]any{
									"type":        "string",
									"description": "风险提示",
								},
								"remarks": map[string]any{
									"type":        "string",
									"description": "操作总结/备注",
								},
							},
						},
					},
				},

				Required: []string{"rating", "stockCode", "stockName", "bkName", "modelName", "recommendReason", "stockPrice"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "AiRecommendStocks",
			Description: "获取近期AI分析/推荐股票明细列表",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"startDate": map[string]any{
						"type":        "string",
						"description": "开始时间（如：2026-02-23 00:00:00）",
					},
					"endDate": map[string]any{
						"type":        "string",
						"description": "结束时间（如：2026-02-26 23:59:59）",
					},
					"page": map[string]any{
						"type":        "string",
						"description": "分页号（如：1）",
					},
					"pageSize": map[string]any{
						"type":        "string",
						"description": "分页大小(如： 1500)",
					},
					"keyWord": map[string]any{
						"type":        "string",
						"description": "搜索关键词",
					},
				},
				Required: []string{"startDate", "endDate", "page", "pageSize"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "StockNotice",
			Description: "获取上市公司公告列表。可查询一只或多只股票的最新公告（如业绩预告、重大事项、募集资金、减持、增持、监管问题、财务异常等），多只股票用英文逗号分隔。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stock_list": map[string]any{
						"type":        "string",
						"description": "股票代码，多只用英文逗号分隔。例如：600584,600900 或 002046,601138",
					},
				},
				Required: []string{"stock_list"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetSecuritiesCompanyOpinion",
			Description: "获取券商/机构的市场分析观点/要点",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"startDate": map[string]any{
						"type":        "string",
						"description": "开始时间（如：2026-02-23）",
					},
					"endDate": map[string]any{
						"type":        "string",
						"description": "结束时间（如：2026-02-26）",
					},
				},
				Required: []string{"startDate", "endDate"},
			},
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        "GetCurrentTime",
			Description: "获取当前本地时间（格式：YYYY-MM-DD HH:mm:ss）",
		},
	})

	tools = append(tools, Tool{
		Type: "function",
		Function: ToolFunction{
			Name: "SetTradingPrice",
			Description: "设置股票的预警价位线（开仓价、止盈价、止损价），用于设置股票的买入价格和风险控制参数。设置后会同步到行情界面显示。" +
				"开仓价：买入的目标价格；止盈价：预期卖出获利价格；止损价：亏损到该价格时必须卖出止损。" +
				"注意：所有价格参数必须为正数，0 表示不设置该价格。",
			Parameters: &FunctionParameters{
				Type: "object",
				Properties: map[string]any{
					"stockCode": map[string]any{
						"type":        "string",
						"description": "股票代码，如 000001.SZ、600000.SH（沪市）、00700.HK（港股）。注意：上海以.SH结尾，深圳以.SZ结尾，港股以.HK结尾，北交所以.BJ结尾。",
					},
					"entryPrice": map[string]any{
						"type":        "number",
						"description": "开仓价/买入价（目标买入价格），0 表示不设置",
					},
					"takeProfitPrice": map[string]any{
						"type":        "number",
						"description": "止盈价（预期卖出价格），0 表示不设置",
					},
					"stopLossPrice": map[string]any{
						"type":        "number",
						"description": "止损价（亏损止损价格），0 表示不设置",
					},
					"costPrice": map[string]any{
						"type":        "number",
						"description": "成本价（持仓成本价格），0 表示不设置",
					},
				},
				Required: []string{"stockCode", "entryPrice", "takeProfitPrice", "stopLossPrice", "costPrice"},
			},
		},
	})

	return tools
}
