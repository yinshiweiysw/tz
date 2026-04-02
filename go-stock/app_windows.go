//go:build windows
// +build windows

package main

import (
	"context"
	"fmt"
	"go-stock/backend/data"
	"go-stock/backend/db"
	"go-stock/backend/logger"
	"syscall"
	"time"
	"unsafe"

	"github.com/duke-git/lancet/v2/convertor"
	"github.com/duke-git/lancet/v2/strutil"
	"github.com/energye/systray"
	"github.com/go-toast/toast"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	monitorDefaultToPrimary = 1
	mdtEffectiveDpi         = 0
	logicalDpi              = 96
)

// startup is called at application startup
func (a *App) startup(ctx context.Context) {
	defer PanicHandler()
	runtime.EventsOn(ctx, "frontendError", func(optionalData ...interface{}) {
		logger.SugaredLogger.Errorf("Frontend error: %v\n", optionalData)
	})
	//logger.SugaredLogger.Infof("Version:%s", Version)
	// Perform your setup here
	a.ctx = ctx

	// 应用启动时自动创建已启用的定时任务
	a.InitCronTasks()

	// 创建系统托盘
	//systray.RunWithExternalLoop(func() {
	//	onReady(a)
	//}, func() {
	//	onExit(a)
	//})
	runtime.EventsOn(ctx, "updateSettings", func(optionalData ...interface{}) {
		//logger.SugaredLogger.Infof("updateSettings : %v\n", optionalData)
		config := data.GetSettingConfig()
		//setMap := optionalData[0].(map[string]interface{})
		//
		//// 将 map 转换为 JSON 字节切片
		//jsonData, err := json.Marshal(setMap)
		//if err != nil {
		//	logger.SugaredLogger.Errorf("Marshal error:%s", err.Error())
		//	return
		//}
		//// 将 JSON 字节切片解析到结构体中
		//err = json.Unmarshal(jsonData, config)
		//if err != nil {
		//	logger.SugaredLogger.Errorf("Unmarshal error:%s", err.Error())
		//	return
		//}

		//logger.SugaredLogger.Infof("updateSettings config:%+v", config)
		if config.DarkTheme {
			runtime.WindowSetBackgroundColour(ctx, 27, 38, 54, 1)
			runtime.WindowSetDarkTheme(ctx)
		} else {
			runtime.WindowSetBackgroundColour(ctx, 255, 255, 255, 1)
			runtime.WindowSetLightTheme(ctx)
		}
		runtime.WindowReloadApp(ctx)

	})
	go systray.Run(func() {
		onReady(a)
	}, func() {
		onExit(a)
	})

	//logger.SugaredLogger.Infof(" application startup Version:%s", Version)
}

func OnSecondInstanceLaunch(secondInstanceData options.SecondInstanceData) {
	notification := toast.Notification{
		AppID:    "go-stock",
		Title:    "go-stock",
		Message:  "程序已经在运行了",
		Icon:     "",
		Duration: "short",
		Audio:    toast.Default,
	}
	err := notification.Push()
	if err != nil {
		logger.SugaredLogger.Error(err)
	}
	time.Sleep(time.Second * 3)
}

func MonitorStockPrices(a *App) {
	// 检查是否至少有一个市场开市
	isAStockOpen := isTradingTime(time.Now())
	isHKStockOpen := IsHKTradingTime(time.Now())
	isUSStockOpen := IsUSTradingTime(time.Now())

	// 如果所有市场都不在交易时间，则提前返回
	if !isAStockOpen && !isHKStockOpen && !isUSStockOpen {
		//logger.SugaredLogger.Debugf("当前所有市场均未开市，跳过价格监控")
		return
	}

	//logger.SugaredLogger.Debugf("市场状态 - A股: %v, 港股: %v, 美股: %v", isAStockOpen, isHKStockOpen, isUSStockOpen)

	dest := &[]data.FollowedStock{}
	db.Dao.Model(&data.FollowedStock{}).Find(dest)
	total := float64(0)
	//for _, follow := range *dest {
	//	stockData := getStockInfo(follow)
	//	total += stockData.ProfitAmountToday
	//	price, _ := convertor.ToFloat(stockData.Price)
	//	if stockData.PrePrice != price {
	//		go runtime.EventsEmit(a.ctx, "stock_price", stockData)
	//	}
	//}

	stockInfos := GetStockInfos(*dest...)
	for _, stockInfo := range *stockInfos {
		if strutil.HasPrefixAny(stockInfo.Code, []string{"SZ", "SH", "sh", "sz"}) && (!isTradingTime(time.Now())) {
			continue
		}
		if strutil.HasPrefixAny(stockInfo.Code, []string{"hk", "HK"}) && (!IsHKTradingTime(time.Now())) {
			continue
		}
		if strutil.HasPrefixAny(stockInfo.Code, []string{"us", "US", "gb_"}) && (!IsUSTradingTime(time.Now())) {
			continue
		}

		total += stockInfo.ProfitAmountToday
		price, _ := convertor.ToFloat(stockInfo.Price)

		if stockInfo.PrePrice != price {
			//logger.SugaredLogger.Infof("-----------sz------------股票代码: %s, 股票名称: %s, 股票价格: %s,盘前盘后:%s", stockInfo.Code, stockInfo.Name, stockInfo.Price, stockInfo.BA)
			go runtime.EventsEmit(a.ctx, "stock_price", stockInfo)
		}

	}
	if total != 0 {
		title := "go-stock " + time.Now().Format(time.DateTime) + fmt.Sprintf("  %.2f¥", total)
		systray.SetTooltip(title)
	}

	go runtime.EventsEmit(a.ctx, "realtime_profit", fmt.Sprintf("  %.2f", total))
	//runtime.WindowSetTitle(a.ctx, title)

}

func onReady(a *App) {

	// 初始化操作
	//logger.SugaredLogger.Infof("systray onReady")
	systray.SetIcon(icon2)
	systray.SetTitle("go-stock")
	systray.SetTooltip("go-stock 股票行情实时获取")
	// 创建菜单项
	show := systray.AddMenuItem("显示", "显示应用程序")
	show.Click(func() {
		//logger.SugaredLogger.Infof("显示应用程序")
		runtime.WindowShow(a.ctx)
	})
	hide := systray.AddMenuItem("隐藏", "隐藏应用程序")
	hide.Click(func() {
		//logger.SugaredLogger.Infof("隐藏应用程序")
		runtime.WindowHide(a.ctx)
	})
	systray.AddSeparator()
	mQuitOrig := systray.AddMenuItem("退出", "退出应用程序")
	mQuitOrig.Click(func() {
		//logger.SugaredLogger.Infof("退出应用程序")
		runtime.Quit(a.ctx)
	})
	systray.SetOnRClick(func(menu systray.IMenu) {
		menu.ShowMenu()
		//logger.SugaredLogger.Infof("SetOnRClick")
	})
	systray.SetOnClick(func(menu systray.IMenu) {
		//logger.SugaredLogger.Infof("SetOnClick")
		menu.ShowMenu()
	})
	systray.SetOnDClick(func(menu systray.IMenu) {
		menu.ShowMenu()
		//logger.SugaredLogger.Infof("SetOnDClick")
	})
}

// beforeClose is called when the application is about to quit,
// either by clicking the window close button or calling runtime.Quit.
// Returning true will cause the application to continue, false will continue shutdown as normal.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	defer PanicHandler()

	// 记录当前窗口大小，供下次启动时还原
	if a.ctx != nil {
		w, h := runtime.WindowGetSize(ctx)
		//logger.SugaredLogger.Infof(" window size: %dx%d", w, h)
		if w > 0 && h > 0 {
			cfg := data.GetSettingConfig()
			cfg.WindowWidth = w
			cfg.WindowHeight = h
			data.UpdateConfig(cfg)
			//logger.SugaredLogger.Infof("save window size: %dx%d", w, h)
		}
	}

	dialog, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:         runtime.QuestionDialog,
		Title:        "go-stock",
		Message:      "确定关闭吗？",
		Buttons:      []string{"确定"},
		Icon:         icon2,
		CancelButton: "取消",
	})

	if err != nil {
		logger.SugaredLogger.Errorf("dialog error:%s", err.Error())
		return false
	}
	logger.SugaredLogger.Debugf("dialog:%s", dialog)
	if dialog == "No" {
		return true
	} else {
		systray.Quit()
		a.cron.Stop()
		return false
	}
}

func getFrameless() bool {
	return true
}

// getScreenResolution 返回主屏逻辑尺寸（考虑 Windows DPI 缩放），用于自适应窗口大小。
// 返回：width, height, minWidth, minHeight。
func getScreenResolution() (int, int, int, int, error) {
	user32 := syscall.NewLazyDLL("user32.dll")
	monitorFromPoint := user32.NewProc("MonitorFromPoint")
	getMonitorInfo := user32.NewProc("GetMonitorInfoW")

	// 主屏原点
	pt := struct{ x, y int32 }{0, 0}
	hm, _, _ := monitorFromPoint.Call(uintptr(unsafe.Pointer(&pt)), monitorDefaultToPrimary)
	if hm == 0 {
		return getScreenResolutionFallback()
	}

	// MONITORINFO: cbSize, rcMonitor(RECT), rcWork(RECT), dwFlags
	// RECT: left, top, right, bottom (4 * int32)
	const miSize = 40
	mi := make([]byte, miSize)
	*(*uint32)(unsafe.Pointer(&mi[0])) = miSize
	ret, _, _ := getMonitorInfo.Call(hm, uintptr(unsafe.Pointer(&mi[0])))
	if ret == 0 {
		return getScreenResolutionFallback()
	}
	// rcMonitor: left, top, right, bottom (offset 4)
	left := *(*int32)(unsafe.Pointer(&mi[4]))
	top := *(*int32)(unsafe.Pointer(&mi[8]))
	right := *(*int32)(unsafe.Pointer(&mi[12]))
	bottom := *(*int32)(unsafe.Pointer(&mi[16]))
	physW := int(right - left)
	physH := int(bottom - top)
	if physW <= 0 || physH <= 0 {
		return getScreenResolutionFallback()
	}

	// 主屏 DPI（考虑缩放）
	shcore := syscall.NewLazyDLL("Shcore.dll")
	getDpiForMonitor := shcore.NewProc("GetDpiForMonitor")
	var dpiX, dpiY uintptr
	hr, _, _ := getDpiForMonitor.Call(hm, mdtEffectiveDpi, uintptr(unsafe.Pointer(&dpiX)), uintptr(unsafe.Pointer(&dpiY)))
	if hr != 0 || dpiX == 0 || dpiY == 0 {
		return getScreenResolutionFallback()
	}
	// 逻辑尺寸 = 物理尺寸 * 96 / DPI
	w := physW * logicalDpi / int(dpiX)
	h := physH * logicalDpi / int(dpiY)
	if w <= 0 || h <= 0 {
		return getScreenResolutionFallback()
	}
	minW := w * 2 / 5
	minH := h * 2 / 5
	return w, h, minW, minH, nil
}

// getScreenResolutionFallback 在 DPI 查询失败时使用 GetSystemMetrics 的回退逻辑（可能与缩放不一致）
func getScreenResolutionFallback() (int, int, int, int, error) {
	user32 := syscall.NewLazyDLL("user32.dll")
	getSystemMetrics := user32.NewProc("GetSystemMetrics")
	screenWidth, _, _ := getSystemMetrics.Call(0)  // SM_CXSCREEN
	screenHeight, _, _ := getSystemMetrics.Call(1) // SM_CYSCREEN
	if screenWidth == 0 || screenHeight == 0 {
		return 1000, 800, 900, 600, fmt.Errorf("getSystemMetrics failed")
	}
	w := int(screenWidth)
	h := int(screenHeight)
	minW := w * 2 / 5
	minH := h * 2 / 5
	return w, h, minW, minH, nil
}
