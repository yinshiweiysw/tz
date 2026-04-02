export namespace data {
	
	export class AIConfig {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    name: string;
	    baseUrl: string;
	    apiKey: string;
	    modelName: string;
	    maxTokens: number;
	    temperature: number;
	    timeOut: number;
	    httpProxy: string;
	    httpProxyEnabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AIConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.name = source["name"];
	        this.baseUrl = source["baseUrl"];
	        this.apiKey = source["apiKey"];
	        this.modelName = source["modelName"];
	        this.maxTokens = source["maxTokens"];
	        this.temperature = source["temperature"];
	        this.timeOut = source["timeOut"];
	        this.httpProxy = source["httpProxy"];
	        this.httpProxyEnabled = source["httpProxyEnabled"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AllStockInfoPageData {
	    list: models.AllStockInfo[];
	    total: number;
	    page: number;
	    pageSize: number;
	    totalPages: number;
	
	    static createFrom(source: any = {}) {
	        return new AllStockInfoPageData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.list = this.convertValues(source["list"], models.AllStockInfo);
	        this.total = source["total"];
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.totalPages = source["totalPages"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AllStockInfoQuery {
	    page: number;
	    pageSize: number;
	    securityCode: string;
	    securityName: string;
	    market: string;
	    industry: string;
	    concept: string;
	    minPrice: string;
	    maxPrice: string;
	    minChange: string;
	    maxChange: string;
	    searchKeyWord: string;
	
	    static createFrom(source: any = {}) {
	        return new AllStockInfoQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.securityCode = source["securityCode"];
	        this.securityName = source["securityName"];
	        this.market = source["market"];
	        this.industry = source["industry"];
	        this.concept = source["concept"];
	        this.minPrice = source["minPrice"];
	        this.maxPrice = source["maxPrice"];
	        this.minChange = source["minChange"];
	        this.maxChange = source["maxChange"];
	        this.searchKeyWord = source["searchKeyWord"];
	    }
	}
	export class FundBasic {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    code: string;
	    name: string;
	    fullName: string;
	    type: string;
	    establishment: string;
	    scale: string;
	    company: string;
	    manager: string;
	    rating: string;
	    trackingTarget: string;
	    netUnitValue?: number;
	    netUnitValueDate: string;
	    netEstimatedUnit?: number;
	    netEstimatedUnitTime: string;
	    netAccumulated?: number;
	    netGrowth1?: number;
	    netGrowth3?: number;
	    netGrowth6?: number;
	    netGrowth12?: number;
	    netGrowth36?: number;
	    netGrowth60?: number;
	    netGrowthYTD?: number;
	    netGrowthAll?: number;
	
	    static createFrom(source: any = {}) {
	        return new FundBasic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.code = source["code"];
	        this.name = source["name"];
	        this.fullName = source["fullName"];
	        this.type = source["type"];
	        this.establishment = source["establishment"];
	        this.scale = source["scale"];
	        this.company = source["company"];
	        this.manager = source["manager"];
	        this.rating = source["rating"];
	        this.trackingTarget = source["trackingTarget"];
	        this.netUnitValue = source["netUnitValue"];
	        this.netUnitValueDate = source["netUnitValueDate"];
	        this.netEstimatedUnit = source["netEstimatedUnit"];
	        this.netEstimatedUnitTime = source["netEstimatedUnitTime"];
	        this.netAccumulated = source["netAccumulated"];
	        this.netGrowth1 = source["netGrowth1"];
	        this.netGrowth3 = source["netGrowth3"];
	        this.netGrowth6 = source["netGrowth6"];
	        this.netGrowth12 = source["netGrowth12"];
	        this.netGrowth36 = source["netGrowth36"];
	        this.netGrowth60 = source["netGrowth60"];
	        this.netGrowthYTD = source["netGrowthYTD"];
	        this.netGrowthAll = source["netGrowthAll"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FollowedFund {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    code: string;
	    name: string;
	    netUnitValue?: number;
	    netUnitValueDate: string;
	    netEstimatedUnit?: number;
	    netEstimatedUnitTime: string;
	    netAccumulated?: number;
	    netEstimatedRate?: number;
	    fundBasic: FundBasic;
	
	    static createFrom(source: any = {}) {
	        return new FollowedFund(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.code = source["code"];
	        this.name = source["name"];
	        this.netUnitValue = source["netUnitValue"];
	        this.netUnitValueDate = source["netUnitValueDate"];
	        this.netEstimatedUnit = source["netEstimatedUnit"];
	        this.netEstimatedUnitTime = source["netEstimatedUnitTime"];
	        this.netAccumulated = source["netAccumulated"];
	        this.netEstimatedRate = source["netEstimatedRate"];
	        this.fundBasic = this.convertValues(source["fundBasic"], FundBasic);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Group {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    name: string;
	    sort: number;
	
	    static createFrom(source: any = {}) {
	        return new Group(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.name = source["name"];
	        this.sort = source["sort"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GroupStock {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    stockCode: string;
	    groupId: number;
	    groupInfo: Group;
	
	    static createFrom(source: any = {}) {
	        return new GroupStock(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.stockCode = source["stockCode"];
	        this.groupId = source["groupId"];
	        this.groupInfo = this.convertValues(source["groupInfo"], Group);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FollowedStock {
	    StockCode: string;
	    Name: string;
	    Volume: number;
	    CostPrice: number;
	    Price: number;
	    PriceChange: number;
	    ChangePercent: number;
	    AlarmChangePercent: number;
	    AlarmPrice: number;
	    // Go type: time
	    Time: any;
	    Sort: number;
	    Cron?: string;
	    IsDel: number;
	    Groups: GroupStock[];
	    AiConfigId: number;
	    EntryPrice: number;
	    TakeProfitPrice: number;
	    StopLossPrice: number;
	
	    static createFrom(source: any = {}) {
	        return new FollowedStock(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.StockCode = source["StockCode"];
	        this.Name = source["Name"];
	        this.Volume = source["Volume"];
	        this.CostPrice = source["CostPrice"];
	        this.Price = source["Price"];
	        this.PriceChange = source["PriceChange"];
	        this.ChangePercent = source["ChangePercent"];
	        this.AlarmChangePercent = source["AlarmChangePercent"];
	        this.AlarmPrice = source["AlarmPrice"];
	        this.Time = this.convertValues(source["Time"], null);
	        this.Sort = source["Sort"];
	        this.Cron = source["Cron"];
	        this.IsDel = source["IsDel"];
	        this.Groups = this.convertValues(source["Groups"], GroupStock);
	        this.AiConfigId = source["AiConfigId"];
	        this.EntryPrice = source["EntryPrice"];
	        this.TakeProfitPrice = source["TakeProfitPrice"];
	        this.StopLossPrice = source["StopLossPrice"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class SettingConfig {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    tushareToken: string;
	    localPushEnable: boolean;
	    dingPushEnable: boolean;
	    dingRobot: string;
	    updateBasicInfoOnStart: boolean;
	    refreshInterval: number;
	    openAiEnable: boolean;
	    prompt: string;
	    checkUpdate: boolean;
	    questionTemplate: string;
	    crawlTimeOut: number;
	    kDays: number;
	    enableDanmu: boolean;
	    browserPath: string;
	    enableNews: boolean;
	    darkTheme: boolean;
	    browserPoolSize: number;
	    enableFund: boolean;
	    enablePushNews: boolean;
	    enableOnlyPushRedNews: boolean;
	    sponsorCode: string;
	    httpProxy: string;
	    httpProxyEnabled: boolean;
	    enableAgent: boolean;
	    qgqpBId: string;
	    windowWidth: number;
	    windowHeight: number;
	    aiConfigs: AIConfig[];
	
	    static createFrom(source: any = {}) {
	        return new SettingConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.tushareToken = source["tushareToken"];
	        this.localPushEnable = source["localPushEnable"];
	        this.dingPushEnable = source["dingPushEnable"];
	        this.dingRobot = source["dingRobot"];
	        this.updateBasicInfoOnStart = source["updateBasicInfoOnStart"];
	        this.refreshInterval = source["refreshInterval"];
	        this.openAiEnable = source["openAiEnable"];
	        this.prompt = source["prompt"];
	        this.checkUpdate = source["checkUpdate"];
	        this.questionTemplate = source["questionTemplate"];
	        this.crawlTimeOut = source["crawlTimeOut"];
	        this.kDays = source["kDays"];
	        this.enableDanmu = source["enableDanmu"];
	        this.browserPath = source["browserPath"];
	        this.enableNews = source["enableNews"];
	        this.darkTheme = source["darkTheme"];
	        this.browserPoolSize = source["browserPoolSize"];
	        this.enableFund = source["enableFund"];
	        this.enablePushNews = source["enablePushNews"];
	        this.enableOnlyPushRedNews = source["enableOnlyPushRedNews"];
	        this.sponsorCode = source["sponsorCode"];
	        this.httpProxy = source["httpProxy"];
	        this.httpProxyEnabled = source["httpProxyEnabled"];
	        this.enableAgent = source["enableAgent"];
	        this.qgqpBId = source["qgqpBId"];
	        this.windowWidth = source["windowWidth"];
	        this.windowHeight = source["windowHeight"];
	        this.aiConfigs = this.convertValues(source["aiConfigs"], AIConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class StockBasic {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    ts_code: string;
	    symbol: string;
	    name: string;
	    area: string;
	    industry: string;
	    fullname: string;
	    enname: string;
	    cnspell: string;
	    market: string;
	    exchange: string;
	    curr_type: string;
	    list_status: string;
	    list_date: string;
	    delist_date: string;
	    is_hs: string;
	    act_name: string;
	    act_ent_type: string;
	    bk_name: string;
	    bk_code: string;
	
	    static createFrom(source: any = {}) {
	        return new StockBasic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.ts_code = source["ts_code"];
	        this.symbol = source["symbol"];
	        this.name = source["name"];
	        this.area = source["area"];
	        this.industry = source["industry"];
	        this.fullname = source["fullname"];
	        this.enname = source["enname"];
	        this.cnspell = source["cnspell"];
	        this.market = source["market"];
	        this.exchange = source["exchange"];
	        this.curr_type = source["curr_type"];
	        this.list_status = source["list_status"];
	        this.list_date = source["list_date"];
	        this.delist_date = source["delist_date"];
	        this.is_hs = source["is_hs"];
	        this.act_name = source["act_name"];
	        this.act_ent_type = source["act_ent_type"];
	        this.bk_name = source["bk_name"];
	        this.bk_code = source["bk_code"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class StockInfo {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    "日期": string;
	    "时间": string;
	    "股票代码": string;
	    "股票名称": string;
	    "上次当前价格": number;
	    "当前价格": string;
	    "成交的股票数": string;
	    "成交金额": string;
	    "今日开盘价": string;
	    "昨日收盘价": string;
	    "今日最高价": string;
	    "今日最低价": string;
	    "竞买价": string;
	    "竞卖价": string;
	    "买一报价": string;
	    "买一申报": string;
	    "买二报价": string;
	    "买二申报": string;
	    "买三报价": string;
	    "买三申报": string;
	    "买四报价": string;
	    "买四申报": string;
	    "买五报价": string;
	    "买五申报": string;
	    "卖一报价": string;
	    "卖一申报": string;
	    "卖二报价": string;
	    "卖二申报": string;
	    "卖三报价": string;
	    "卖三申报": string;
	    "卖四报价": string;
	    "卖四申报": string;
	    "卖五报价": string;
	    "卖五申报": string;
	    "市场": string;
	    "盘前盘后": string;
	    "盘前盘后涨跌幅": string;
	    changePercent: number;
	    changePrice: number;
	    highRate: number;
	    lowRate: number;
	    costPrice: number;
	    costVolume: number;
	    profit: number;
	    profitAmount: number;
	    profitAmountToday: number;
	    sort: number;
	    alarmChangePercent: number;
	    alarmPrice: number;
	    Groups: GroupStock[];
	
	    static createFrom(source: any = {}) {
	        return new StockInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this["日期"] = source["日期"];
	        this["时间"] = source["时间"];
	        this["股票代码"] = source["股票代码"];
	        this["股票名称"] = source["股票名称"];
	        this["上次当前价格"] = source["上次当前价格"];
	        this["当前价格"] = source["当前价格"];
	        this["成交的股票数"] = source["成交的股票数"];
	        this["成交金额"] = source["成交金额"];
	        this["今日开盘价"] = source["今日开盘价"];
	        this["昨日收盘价"] = source["昨日收盘价"];
	        this["今日最高价"] = source["今日最高价"];
	        this["今日最低价"] = source["今日最低价"];
	        this["竞买价"] = source["竞买价"];
	        this["竞卖价"] = source["竞卖价"];
	        this["买一报价"] = source["买一报价"];
	        this["买一申报"] = source["买一申报"];
	        this["买二报价"] = source["买二报价"];
	        this["买二申报"] = source["买二申报"];
	        this["买三报价"] = source["买三报价"];
	        this["买三申报"] = source["买三申报"];
	        this["买四报价"] = source["买四报价"];
	        this["买四申报"] = source["买四申报"];
	        this["买五报价"] = source["买五报价"];
	        this["买五申报"] = source["买五申报"];
	        this["卖一报价"] = source["卖一报价"];
	        this["卖一申报"] = source["卖一申报"];
	        this["卖二报价"] = source["卖二报价"];
	        this["卖二申报"] = source["卖二申报"];
	        this["卖三报价"] = source["卖三报价"];
	        this["卖三申报"] = source["卖三申报"];
	        this["卖四报价"] = source["卖四报价"];
	        this["卖四申报"] = source["卖四申报"];
	        this["卖五报价"] = source["卖五报价"];
	        this["卖五申报"] = source["卖五申报"];
	        this["市场"] = source["市场"];
	        this["盘前盘后"] = source["盘前盘后"];
	        this["盘前盘后涨跌幅"] = source["盘前盘后涨跌幅"];
	        this.changePercent = source["changePercent"];
	        this.changePrice = source["changePrice"];
	        this.highRate = source["highRate"];
	        this.lowRate = source["lowRate"];
	        this.costPrice = source["costPrice"];
	        this.costVolume = source["costVolume"];
	        this.profit = source["profit"];
	        this.profitAmount = source["profitAmount"];
	        this.profitAmountToday = source["profitAmountToday"];
	        this.sort = source["sort"];
	        this.alarmChangePercent = source["alarmChangePercent"];
	        this.alarmPrice = source["alarmPrice"];
	        this.Groups = this.convertValues(source["Groups"], GroupStock);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace lo {
	
	export class Tuple2_string_string_ {
	    A: string;
	    B: string;
	
	    static createFrom(source: any = {}) {
	        return new Tuple2_string_string_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.A = source["A"];
	        this.B = source["B"];
	    }
	}

}

export namespace models {
	
	export class AIResponseResult {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    chatId: string;
	    modelName: string;
	    stockCode: string;
	    stockName: string;
	    question: string;
	    content: string;
	    IsDel: number;
	
	    static createFrom(source: any = {}) {
	        return new AIResponseResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.chatId = source["chatId"];
	        this.modelName = source["modelName"];
	        this.stockCode = source["stockCode"];
	        this.stockName = source["stockName"];
	        this.question = source["question"];
	        this.content = source["content"];
	        this.IsDel = source["IsDel"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AIResponseResultPageData {
	    list: AIResponseResult[];
	    total: number;
	    page: number;
	    pageSize: number;
	    totalPages: number;
	
	    static createFrom(source: any = {}) {
	        return new AIResponseResultPageData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.list = this.convertValues(source["list"], AIResponseResult);
	        this.total = source["total"];
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.totalPages = source["totalPages"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AIResponseResultQuery {
	    page: number;
	    pageSize: number;
	    chatId: string;
	    modelName: string;
	    stockCode: string;
	    stockName: string;
	    question: string;
	    startDate: string;
	    endDate: string;
	
	    static createFrom(source: any = {}) {
	        return new AIResponseResultQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.chatId = source["chatId"];
	        this.modelName = source["modelName"];
	        this.stockCode = source["stockCode"];
	        this.stockName = source["stockName"];
	        this.question = source["question"];
	        this.startDate = source["startDate"];
	        this.endDate = source["endDate"];
	    }
	}
	export class AiAssistantMessage {
	    role: string;
	    content: string;
	    reasoning: string;
	    time: string;
	    modelName?: string;
	
	    static createFrom(source: any = {}) {
	        return new AiAssistantMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.content = source["content"];
	        this.reasoning = source["reasoning"];
	        this.time = source["time"];
	        this.modelName = source["modelName"];
	    }
	}
	export class AiRecommendStocks {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    // Go type: time
	    dataTime?: any;
	    modelName: string;
	    rating: string;
	    stockCode: string;
	    stockName: string;
	    bkCode: string;
	    bkName: string;
	    stockPrice: string;
	    stockCurrentPrice: string;
	    stockCurrentPriceTime: string;
	    stockClosePrice: string;
	    stockPrePrice: string;
	    recommendReason: string;
	    recommendBuyPrice: string;
	    recommendBuyPriceMin: number;
	    recommendBuyPriceMax: number;
	    recommendStopProfitPrice: string;
	    recommendStopProfitPriceMin: number;
	    recommendStopProfitPriceMax: number;
	    recommendStopLossPrice: string;
	    riskRemarks: string;
	    remarks: string;
	    enableAlert: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AiRecommendStocks(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.dataTime = this.convertValues(source["dataTime"], null);
	        this.modelName = source["modelName"];
	        this.rating = source["rating"];
	        this.stockCode = source["stockCode"];
	        this.stockName = source["stockName"];
	        this.bkCode = source["bkCode"];
	        this.bkName = source["bkName"];
	        this.stockPrice = source["stockPrice"];
	        this.stockCurrentPrice = source["stockCurrentPrice"];
	        this.stockCurrentPriceTime = source["stockCurrentPriceTime"];
	        this.stockClosePrice = source["stockClosePrice"];
	        this.stockPrePrice = source["stockPrePrice"];
	        this.recommendReason = source["recommendReason"];
	        this.recommendBuyPrice = source["recommendBuyPrice"];
	        this.recommendBuyPriceMin = source["recommendBuyPriceMin"];
	        this.recommendBuyPriceMax = source["recommendBuyPriceMax"];
	        this.recommendStopProfitPrice = source["recommendStopProfitPrice"];
	        this.recommendStopProfitPriceMin = source["recommendStopProfitPriceMin"];
	        this.recommendStopProfitPriceMax = source["recommendStopProfitPriceMax"];
	        this.recommendStopLossPrice = source["recommendStopLossPrice"];
	        this.riskRemarks = source["riskRemarks"];
	        this.remarks = source["remarks"];
	        this.enableAlert = source["enableAlert"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiRecommendStocksPageData {
	    list: AiRecommendStocks[];
	    total: number;
	    page: number;
	    pageSize: number;
	    totalPages: number;
	
	    static createFrom(source: any = {}) {
	        return new AiRecommendStocksPageData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.list = this.convertValues(source["list"], AiRecommendStocks);
	        this.total = source["total"];
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.totalPages = source["totalPages"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiRecommendStocksQuery {
	    page: number;
	    pageSize: number;
	    modelName: string;
	    stockCode: string;
	    stockName: string;
	    bkCode: string;
	    bkName: string;
	    startDate: string;
	    endDate: string;
	    enableAlert?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AiRecommendStocksQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.modelName = source["modelName"];
	        this.stockCode = source["stockCode"];
	        this.stockName = source["stockName"];
	        this.bkCode = source["bkCode"];
	        this.bkName = source["bkName"];
	        this.startDate = source["startDate"];
	        this.endDate = source["endDate"];
	        this.enableAlert = source["enableAlert"];
	    }
	}
	export class AllStockInfo {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    SECUCODE: string;
	    SECURITY_CODE: string;
	    SECURITY_NAME_ABBR: string;
	    NEW_PRICE: string;
	    CHANGE_RATE: string;
	    VOLUME_RATIO: string;
	    HIGH_PRICE: string;
	    LOW_PRICE: string;
	    PRE_CLOSE_PRICE: string;
	    VOLUME: string;
	    DEAL_AMOUNT: string;
	    TURNOVERRATE: string;
	    MARKET: string;
	    CONCEPT: string;
	    INDUSTRY: string;
	    MAX_TRADE_DATE: string;
	
	    static createFrom(source: any = {}) {
	        return new AllStockInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.SECUCODE = source["SECUCODE"];
	        this.SECURITY_CODE = source["SECURITY_CODE"];
	        this.SECURITY_NAME_ABBR = source["SECURITY_NAME_ABBR"];
	        this.NEW_PRICE = source["NEW_PRICE"];
	        this.CHANGE_RATE = source["CHANGE_RATE"];
	        this.VOLUME_RATIO = source["VOLUME_RATIO"];
	        this.HIGH_PRICE = source["HIGH_PRICE"];
	        this.LOW_PRICE = source["LOW_PRICE"];
	        this.PRE_CLOSE_PRICE = source["PRE_CLOSE_PRICE"];
	        this.VOLUME = source["VOLUME"];
	        this.DEAL_AMOUNT = source["DEAL_AMOUNT"];
	        this.TURNOVERRATE = source["TURNOVERRATE"];
	        this.MARKET = source["MARKET"];
	        this.CONCEPT = source["CONCEPT"];
	        this.INDUSTRY = source["INDUSTRY"];
	        this.MAX_TRADE_DATE = source["MAX_TRADE_DATE"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AllStocksResp {
	    version: any;
	    // Go type: struct { Nextpage bool "json:\"nextpage\""; Currentpage int "json:\"currentpage\""; Data []models
	    result: any;
	    success: boolean;
	    message: string;
	    code: number;
	    url: string;
	
	    static createFrom(source: any = {}) {
	        return new AllStocksResp(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.result = this.convertValues(source["result"], Object);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.code = source["code"];
	        this.url = source["url"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CronTask {
	    id: number;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	    name: string;
	    cronExpr: string;
	    taskType: string;
	    target: string;
	    params: string;
	    enable: boolean;
	    // Go type: time
	    lastRunAt?: any;
	    // Go type: time
	    nextRunAt?: any;
	    runCount: number;
	    status: string;
	    description: string;
	
	    static createFrom(source: any = {}) {
	        return new CronTask(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	        this.name = source["name"];
	        this.cronExpr = source["cronExpr"];
	        this.taskType = source["taskType"];
	        this.target = source["target"];
	        this.params = source["params"];
	        this.enable = source["enable"];
	        this.lastRunAt = this.convertValues(source["lastRunAt"], null);
	        this.nextRunAt = this.convertValues(source["nextRunAt"], null);
	        this.runCount = source["runCount"];
	        this.status = source["status"];
	        this.description = source["description"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CronTaskPageResp {
	    total: number;
	    data: CronTask[];
	
	    static createFrom(source: any = {}) {
	        return new CronTaskPageResp(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.data = this.convertValues(source["data"], CronTask);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CronTaskQuery {
	    page: number;
	    pageSize: number;
	    name: string;
	    taskType: string;
	    status: string;
	    enable?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CronTaskQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.name = source["name"];
	        this.taskType = source["taskType"];
	        this.status = source["status"];
	        this.enable = source["enable"];
	    }
	}
	export class Prompt {
	    ID: number;
	    name: string;
	    content: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new Prompt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.name = source["name"];
	        this.content = source["content"];
	        this.type = source["type"];
	    }
	}
	export class PromptTemplate {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    name: string;
	    content: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new PromptTemplate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.name = source["name"];
	        this.content = source["content"];
	        this.type = source["type"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PromptTemplatePageData {
	    list: PromptTemplate[];
	    total: number;
	    page: number;
	    pageSize: number;
	    totalPages: number;
	
	    static createFrom(source: any = {}) {
	        return new PromptTemplatePageData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.list = this.convertValues(source["list"], PromptTemplate);
	        this.total = source["total"];
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.totalPages = source["totalPages"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PromptTemplateQuery {
	    page: number;
	    pageSize: number;
	    name: string;
	    type: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new PromptTemplateQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.page = source["page"];
	        this.pageSize = source["pageSize"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.content = source["content"];
	    }
	}
	export class SentimentResult {
	    Score: number;
	    Category: number;
	    PositiveCount: number;
	    NegativeCount: number;
	    Description: string;
	
	    static createFrom(source: any = {}) {
	        return new SentimentResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Score = source["Score"];
	        this.Category = source["Category"];
	        this.PositiveCount = source["PositiveCount"];
	        this.NegativeCount = source["NegativeCount"];
	        this.Description = source["Description"];
	    }
	}
	export class StockInfo {
	    SECUCODE: string;
	    SECURITY_CODE: string;
	    SECURITY_NAME_ABBR: string;
	    NEW_PRICE: any;
	    CHANGE_RATE: any;
	    VOLUME_RATIO: any;
	    HIGH_PRICE: any;
	    LOW_PRICE: any;
	    PRE_CLOSE_PRICE: any;
	    VOLUME: any;
	    DEAL_AMOUNT: any;
	    TURNOVERRATE: any;
	    MARKET: string;
	    CONCEPT: any;
	    INDUSTRY: string;
	    MAX_TRADE_DATE: string;
	
	    static createFrom(source: any = {}) {
	        return new StockInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.SECUCODE = source["SECUCODE"];
	        this.SECURITY_CODE = source["SECURITY_CODE"];
	        this.SECURITY_NAME_ABBR = source["SECURITY_NAME_ABBR"];
	        this.NEW_PRICE = source["NEW_PRICE"];
	        this.CHANGE_RATE = source["CHANGE_RATE"];
	        this.VOLUME_RATIO = source["VOLUME_RATIO"];
	        this.HIGH_PRICE = source["HIGH_PRICE"];
	        this.LOW_PRICE = source["LOW_PRICE"];
	        this.PRE_CLOSE_PRICE = source["PRE_CLOSE_PRICE"];
	        this.VOLUME = source["VOLUME"];
	        this.DEAL_AMOUNT = source["DEAL_AMOUNT"];
	        this.TURNOVERRATE = source["TURNOVERRATE"];
	        this.MARKET = source["MARKET"];
	        this.CONCEPT = source["CONCEPT"];
	        this.INDUSTRY = source["INDUSTRY"];
	        this.MAX_TRADE_DATE = source["MAX_TRADE_DATE"];
	    }
	}
	export class TechnicalIndicators {
	    MACD_GOLDEN_FORK: boolean;
	    KDJ_GOLDEN_FORK: boolean;
	    BREAK_THROUGH: boolean;
	    LOW_FUNDS_INFLOW: boolean;
	    HIGH_FUNDS_OUTFLOW: boolean;
	    BREAKUP_MA_5DAYS: boolean;
	    LONG_AVG_ARRAY: boolean;
	    SHORT_AVG_ARRAY: boolean;
	    UPPER_LARGE_VOLUME: boolean;
	    DOWN_NARROW_VOLUME: boolean;
	    ONE_DAYANG_LINE: boolean;
	    TWO_DAYANG_LINES: boolean;
	    RISE_SUN: boolean;
	    POWER_FULGUN: boolean;
	    RESTORE_JUSTICE: boolean;
	    DOWN_7DAYS: boolean;
	    UPPER_8DAYS: boolean;
	    UPPER_9DAYS: boolean;
	    UPPER_4DAYS: boolean;
	    HEAVEN_RULE: boolean;
	    UPSIDE_VOLUME: boolean;
	    BEARISH_ENGULFING: boolean;
	    REVERSING_HAMMER: boolean;
	    SHOOTING_STAR: boolean;
	    EVENING_STAR: boolean;
	    FIRST_DAWN: boolean;
	    PREGNANT: boolean;
	    BLACK_CLOUD_TOPS: boolean;
	    MORNING_STAR: boolean;
	    NARROW_FINISH: boolean;
	    UPP_DAYS: number;
	    CONCERN_RANK_7DAYS: number;
	    UPNDAY: number;
	    DOWNNDAY: number;
	
	    static createFrom(source: any = {}) {
	        return new TechnicalIndicators(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.MACD_GOLDEN_FORK = source["MACD_GOLDEN_FORK"];
	        this.KDJ_GOLDEN_FORK = source["KDJ_GOLDEN_FORK"];
	        this.BREAK_THROUGH = source["BREAK_THROUGH"];
	        this.LOW_FUNDS_INFLOW = source["LOW_FUNDS_INFLOW"];
	        this.HIGH_FUNDS_OUTFLOW = source["HIGH_FUNDS_OUTFLOW"];
	        this.BREAKUP_MA_5DAYS = source["BREAKUP_MA_5DAYS"];
	        this.LONG_AVG_ARRAY = source["LONG_AVG_ARRAY"];
	        this.SHORT_AVG_ARRAY = source["SHORT_AVG_ARRAY"];
	        this.UPPER_LARGE_VOLUME = source["UPPER_LARGE_VOLUME"];
	        this.DOWN_NARROW_VOLUME = source["DOWN_NARROW_VOLUME"];
	        this.ONE_DAYANG_LINE = source["ONE_DAYANG_LINE"];
	        this.TWO_DAYANG_LINES = source["TWO_DAYANG_LINES"];
	        this.RISE_SUN = source["RISE_SUN"];
	        this.POWER_FULGUN = source["POWER_FULGUN"];
	        this.RESTORE_JUSTICE = source["RESTORE_JUSTICE"];
	        this.DOWN_7DAYS = source["DOWN_7DAYS"];
	        this.UPPER_8DAYS = source["UPPER_8DAYS"];
	        this.UPPER_9DAYS = source["UPPER_9DAYS"];
	        this.UPPER_4DAYS = source["UPPER_4DAYS"];
	        this.HEAVEN_RULE = source["HEAVEN_RULE"];
	        this.UPSIDE_VOLUME = source["UPSIDE_VOLUME"];
	        this.BEARISH_ENGULFING = source["BEARISH_ENGULFING"];
	        this.REVERSING_HAMMER = source["REVERSING_HAMMER"];
	        this.SHOOTING_STAR = source["SHOOTING_STAR"];
	        this.EVENING_STAR = source["EVENING_STAR"];
	        this.FIRST_DAWN = source["FIRST_DAWN"];
	        this.PREGNANT = source["PREGNANT"];
	        this.BLACK_CLOUD_TOPS = source["BLACK_CLOUD_TOPS"];
	        this.MORNING_STAR = source["MORNING_STAR"];
	        this.NARROW_FINISH = source["NARROW_FINISH"];
	        this.UPP_DAYS = source["UPP_DAYS"];
	        this.CONCERN_RANK_7DAYS = source["CONCERN_RANK_7DAYS"];
	        this.UPNDAY = source["UPNDAY"];
	        this.DOWNNDAY = source["DOWNNDAY"];
	    }
	}
	export class VersionInfo {
	    ID: number;
	    // Go type: time
	    CreatedAt: any;
	    // Go type: time
	    UpdatedAt: any;
	    // Go type: gorm
	    DeletedAt: any;
	    version: string;
	    content: string;
	    icon: string;
	    alipay: string;
	    wxpay: string;
	    wxgzh: string;
	    buildTimeStamp: number;
	    officialStatement: string;
	    IsDel: number;
	
	    static createFrom(source: any = {}) {
	        return new VersionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.CreatedAt = this.convertValues(source["CreatedAt"], null);
	        this.UpdatedAt = this.convertValues(source["UpdatedAt"], null);
	        this.DeletedAt = this.convertValues(source["DeletedAt"], null);
	        this.version = source["version"];
	        this.content = source["content"];
	        this.icon = source["icon"];
	        this.alipay = source["alipay"];
	        this.wxpay = source["wxpay"];
	        this.wxgzh = source["wxgzh"];
	        this.buildTimeStamp = source["buildTimeStamp"];
	        this.officialStatement = source["officialStatement"];
	        this.IsDel = source["IsDel"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

