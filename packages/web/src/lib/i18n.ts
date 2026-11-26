export type Locale = "zh" | "en";

export interface LocaleOption {
  code: Locale;
  /** Native endonym displayed in language menus (never translated) */
  nativeName: string;
  /** Short badge code displayed in compact desktop header trigger */
  shortLabel: string;
  /** BCP-47 lang tag for <html lang> and menu items */
  htmlLang: string;
}

export const SUPPORTED_LOCALES: readonly LocaleOption[] = [
  { code: "en", nativeName: "English", shortLabel: "EN", htmlLang: "en" },
  { code: "zh", nativeName: "简体中文", shortLabel: "中文", htmlLang: "zh-Hans" },
] as const;

export const LOCALE_STORAGE_KEY = "payoff.locale.v1";

export function isSupportedLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh";
}

export function getLocaleOption(locale: Locale): LocaleOption {
  return (
    SUPPORTED_LOCALES.find((item) => item.code === locale) ??
    SUPPORTED_LOCALES[0]
  );
}

/**
 * Resolves initial locale following i18n best practice:
 * 1. Saved user preference in localStorage
 * 2. Browser preferred language (navigator.languages / navigator.language)
 * 3. Default to "en"
 */
export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(saved)) return saved;
  } catch {
    // Ignore storage access errors in restricted environments
  }
  const preferred =
    (Array.isArray(window.navigator?.languages) &&
      window.navigator.languages[0]) ||
    window.navigator?.language ||
    "";
  if (preferred.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

export function persistLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage access errors in private browsing
  }
}

const fmtUsd = (v: string) => (v.startsWith("$") ? v : `$${v}`);
const fmtSignedUsd = (v: string) =>
  v.startsWith("+") || v.startsWith("-") ? v : `+$${v.replace(/^\$/, "")}`;
const fmtSignedMult = (v: string) => {
  const withX = v.endsWith("x") ? v : `${v}x`;
  return withX.startsWith("+") || withX.startsWith("-") ? withX : `+${withX}`;
};
const fmtUsdt = (v: string) =>
  /usdt/i.test(v) ? v : `${v.replace(/^\$/, "")} USDT`;
const fmtUtc = (v: string) => (/utc/i.test(v) ? v : `${v} UTC`);

const dict = {
  zh: {
    // Navigation & Account
    navTrade: "交易",
    navPositions: "资产",
    navWallet: "资产",
    connectWallet: "邮箱登录",
    myWallet: "我的账户",
    walletSubtitleConnected: "Privy 嵌入式账户 · BNB Chain 链上托管",
    walletSubtitleDisconnected:
      "使用邮箱一键登录，自动生成链上钱包并赠送 1,000 tUSDT",
    availableBalance: "可用余额",
    disconnectWallet: "退出登录",
    exportPrivateKey: "导出钱包私钥",
    gasFreeBadge: "0 手续费",
    gasFreeAccountNote: "Privy 非托管嵌入式钱包 · BNB Testnet 一键静默签名",
    privyEmailAccountLabel: "邮箱账户",
    welcomeAirdropMinting: "正在为新账户免费空投 1,000 tUSDT...",
    welcomeAirdropSuccess: (amt: number) =>
      `欢迎加入 Payoff！已自动空投 ${amt.toLocaleString()} tUSDT 到您的账户，可直接一键下注。`,
    welcomeAirdropShortSuccess: (amt: number) =>
      `已自动空投 ${amt.toLocaleString()} tUSDT`,
    welcomeAirdropRetry: "重试领取",
    welcomeAirdropRetryFull: "重新领取 1,000 tUSDT",
    initializingWallet: "正在初始化账户...",
    viewOnBscScan: "在 BscScan 查看",
    nonCustodialNote: "仅用于链上签名与结算，Payoff 不托管您的私钥",
    cappedLossTag: "亏损封顶 · 永不爆仓",

    // Market & Direction
    past24h: "过去 24 小时",
    bull: "看涨",
    bear: "看跌",
    daily: "24小时",
    weekly: "周度 3-7天",
    settlesInHours: (h: string) => `${h}h 后结算`,
    chooseRange: "选择目标区间",
    autoRollingHint: "随市价自动对齐",
    customRangeTitle: "自选价格区间",
    customRangeBadge: "对齐标准刻度 · 图表实时联动",
    lowerBound: "区间下沿",
    upperBound: "区间上沿",
    stepDown: "− 下一档",
    stepUp: "+ 上一档",
    alignedNotice: "已锁定标准行权价刻度",
    widthInfo: (w: string, max: string) => `区间宽度 ${w}%（上限 ${max}%）`,
    tierConservative: "稳健防归零档",
    tierStandard: "标准短线档",
    tierBreakout: "突破翻倍档",
    tierCustom: "自选区间",
    tagConservative: "安全垫",
    tagStandard: "默认",
    tagBreakout: "高倍",
    hintConservative: "横盘不归零",
    hintStandard: "替代高倍永续 · 抗插针",
    hintBreakout: "小本金博突破",
    flatReturnShort: (pct: string) => `横盘返 ${pct}%`,
    breakevenShort: (pct: string) => `回本 ${pct}%`,
    maxMultiplier: "最高赔率",
    buyAmount: "投入金额",
    available: "可用",
    numStake: "投入本金（最大亏损）",
    numBreakeven: "到期回本价格",
    numFlatReturn: "横盘不动到期拿回",
    numCapPayout: "拿满价格与封顶回报",
    numExpiry: "到期结算时间",
    numEarlyExit: "中途随时止盈参考",
    earlyExitMove: (amt: string) => `顺行 1.5% 约可退 ${amt} USDT`,
    noLiqNote: "盘中插针不爆仓 · 满额赔付链上锁仓",
    savePct: (p: string) => `省 ${p}%`,

    // Option A Target Cap Slider + Quick/Custom Mode + Editable Amount Bar + Math Line + CTAs
    rangeModeGroupLabel: "区间模式",
    modeQuick: "快捷",
    modeCustom: "自定义",
    capPriceLabel: "涨到拿满",
    capPriceLabelBull: "涨到拿满",
    capPriceLabelBear: "跌到拿满",
    startPriceLabel: "起赚线",
    startPriceLabelBull: "超过即赚",
    startPriceLabelBear: "跌破即赚",
    stepPrevLabel: (price: string) => `向左微调至 ${fmtUsd(price)}`,
    stepNextLabel: (price: string) => `向右微调至 ${fmtUsd(price)}`,
    customWidthSummary: (widthPct: string, maxWidthPct: string) =>
      `宽度 ${widthPct}% / 上限 ${maxWidthPct}%`,
    customFairRangeSummary: (minMult: string, maxMult: string) =>
      `公允范围 ${minMult}x–${maxMult}x`,
    customClampWidthCap: (maxWidthPct: string) =>
      `封顶价已按宽度上限（≤ ${maxWidthPct}%）自动限位`,
    customClampOtmFair: (maxMult: string) =>
      `封顶价已按虚值公允边界（最高约 ${maxMult}x）自动限位`,
    customClampItmFair: (minMult: string) =>
      `封顶价已按实值公允下限（≥ ${minMult}x）自动限位`,
    customClampStartOtmFair: (maxMult: string) =>
      `起赚线已按虚值公允边界（最高约 ${maxMult}x）自动限位`,
    customClampStartItmFair: (minMult: string) =>
      `起赚线已按实值公允下限（≥ ${minMult}x）自动限位`,
    customClampOrdering: "封顶价已随起赚线自动顺移至有效档位",
    customClampStrikeAlign: "区间已自动对齐至标准行权价刻度",
    customSingleCapHint: "边界唯一有效档",
    sliderTargetHint: (op: "≥" | "≤", price: string, pct: string) =>
      `封顶价 ${op} ${fmtUsd(price)} (${pct})`,
    stakeInputLabel: "投入金额",
    amountQuickAdd100: "+$100",
    amountMax: "最大",
    mathStartShort: (price: string) => `起赚线 ${fmtUsd(price)}`,
    mathBreakevenShort: (price: string) => `回本 ${fmtUsd(price)}`,
    mathMaxWin: (amt: string) => `最多赢 ${fmtUsd(amt)}`,
    buyCtaBull: (stake: string, _maxWin: string) =>
      `买涨 · ${fmtUsd(stake)}`,
    buyCtaBear: (stake: string, _maxWin: string) =>
      `买跌 · ${fmtUsd(stake)}`,
    buyCtaSignIn: "邮箱登录买入 · 送 1,000 测试 USDT",
    executingGasless: "正在成交…",
    approvingGasless: "授权中…",
    chartScrubHint: "拖动模拟结算价",
    chartScrubReadout: (price: string, payout: string) =>
      `结算在 ${fmtUsd(price)} → 拿回 ${fmtUsd(payout)}`,
    chartScrubTotalReadout: (price: string, totalPayout: string) =>
      `结算在 ${fmtUsd(price)} → 合计拿回 ${fmtUsd(totalPayout)}`,
    chartCapPill: (win: string, op: "≥" | "≤", cap: string) =>
      `赢 ${fmtUsd(win)} · ${op} ${fmtUsd(cap)}`,

    // Order States
    buySuccess: "买入成功，赔付已锁定（同区间仓位自动合并）",
    viewPositions: "查看我的持仓",
    continueTrading: "继续下单",
    lockedQuoteTitle: "已为您锁定最优一口价",
    payToWin: (s: number) => `支付 ${s} USDT 最高拿回`,
    approvingUsdt: "授权 USDT 中...",
    confirmingTx: "链上确认中...",
    confirmPay: (s: string) => `确认支付 ${s} USDT`,
    cancel: "取消",
    connectToBuy: "邮箱登录买入 · 送 1,000 测试 USDT",
    fetchingQuote: "正在获取实时报价...",
    insufficientUsdt: "USDT 余额不足",
    adjustRangeFirst: "请先调整价格区间",
    quotingPausedCta: "预言机熔断保护中 · 暂停新开仓",
    quotingPausedNotice:
      "Atlas ConsensusScore 检测到异常市场分歧，已自动触发风控熔断暂停新开仓（现有持仓仍可安全平仓或到期结算）。",
    buyNowCta: (dir: string, s: number) => `买入${dir} · $${s}`,

    // Chart
    chartCandle: "K线",
    chartLine: "分时",
    bar5m: "5分",
    bar15m: "15分",
    bar1H: "1时",
    bar4H: "4时",
    bar1D: "日线",
    chartCapLabel: (m: string) => `拿满 ${m}x`,
    chartBreakevenLabel: "回本",
    chartStartLabel: "起赚线",
    profitZone: "盈利区间",
    perpCompare: (px: string) => `对比 50x 永续强平点 $${px} · 本票不爆仓`,

    // A1 Onboarding Sheet (uses "普通预测市场")
    onboardingTitle: "30 秒看懂 Payoff",
    onboardingSubtitle: "防插针、线性赔付的方向预测市场",
    onboardingRule1Title: "1. 选方向和封顶价",
    onboardingRule1Body:
      "滑动刻度选封顶价与赔率，最多只亏投入本金，盘中插针绝不爆仓。",
    onboardingRule2Title: "2. 涨到一半也赚钱，不会归零",
    onboardingRule2Body:
      "不像全赢或归零的二元盘，价格只要过了起赚线就按比例线性赔付。",
    onboardingRule3Title: "3. 邮箱一键登录 · 随时可卖",
    onboardingRule3Body:
      "登录即送 1,000 测试 USDT，一键静默成交，到期前 30 分钟外随时可止盈卖出。",
    onboardingCompareTitle: "同样投入 $20，到期只涨到目标一半时",
    onboardingCompareStandardLabel: "普通预测市场",
    onboardingCompareStandardValue: "$0（直接归零）",
    onboardingComparePayoffLabel: "Payoff",
    onboardingComparePayoffValue: "~$36（线性照付）",
    onboardingStartCta: "开始体验",
    onboardingReplayBtn: "重看 30 秒新手引导",

    // Market Picker Sheet
    marketPickerTitle: "选择市场",
    marketPickerSubtitle: "全额链上抵押 · Atlas 30m TWAP 自动结算",
    marketBtcName: "比特币",
    marketEthName: "以太坊",
    marketNvdaName: "英伟达",
    marketCadenceCrypto: "每日 16:00 / 周五结算",
    marketCadenceRwa: "一/三/五 美股收盘结算",
    marketActivePositionsBadge: (n: number) => `${n} 笔持仓`,
    infoRulesTooltip: "规则与预言机",

    // B1-B6 In-Page Positions, Merge Sheet (B3), Sell Sheet (B4), Account Drawer (B6)
    currentExpiryPositionsTitle: "本期持仓",
    positionsTotalStake: "合计投入",
    positionsTotalValue: "当前估值",
    positionsSimulatedTotal: "模拟合计拿回",
    actionSell: "卖出",
    actionAddMore: "加仓",
    priorExpiryViewOnly: "该期已停止开仓，可提前卖出或等待自动结算",
    jumpToNextExpiry: "前往下一期下单",
    addMoreSheetTitle: "再买一笔",
    mergeNoticeSameSeries: (
      existingStake: string,
      combinedStake: string,
      combinedMaxPayout: string
    ) =>
      `将与现有同区间持仓（投入 ${fmtUsd(existingStake)}）自动合并 → 合计投入 ${fmtUsd(combinedStake)}，最高可赢 ${fmtUsd(combinedMaxPayout)}`,
    mergeNoticeNewSeries: "将新开一笔独立区间持仓，同页实时追踪",
    sellSheetEstPayout: "预估立即到手",
    sellSheetCompareSellTitle: "现在卖出",
    sellSheetCompareHoldTitle: "持有到结算",
    sellSheetRemainingNote: (pct: number, remMax: string) =>
      `剩余 ${pct}% 最高仍可赢 ${fmtUsd(remMax)}`,
    sellSheetFullyClosed: "全部落袋，不再承担到期波动",
    sellSheetHoldRange: (min: string, max: string) =>
      `${fmtUsd(min)} ~ ${fmtUsd(max)}`,
    sellRatio25: "25%",
    sellRatio50: "50%",
    sellRatio100: "全部",
    drawerTitle: "账户与持仓",
    drawerGasFreePill: "免 Gas",
    drawerTotalPositionValue: "全部持仓现值",
    drawerAvailableUsdt: "可用余额",
    drawerQuickFaucet: "免 Gas 领水",
    drawerClaimableSection: "待领取结算",
    drawerActiveSection: "进行中持仓",
    drawerNoActivePositions: "暂无进行中持仓",
    drawerGroupCount: (n: number) => `${n} 笔`,
    drawerHistoryStats: "历史与战绩",
    drawerRulesSecurity: "规则与安全",
    drawerLanguage: "语言",
    drawerOnchainAddress: "链上地址与导出私钥",
    drawerCopyAddress: "复制地址",
    drawerCopied: "已复制",

    // C1-C6 TWAP Lock, Settlement, 3 Outcomes, Batch Claim, History Stats, Errors
    twapLockBannerTitle: "最后 30 分钟均价锁定期",
    twapLockBannerDesc:
      "早平已锁定，系统正采集 30 个整分钟 Atlas 签名价计算结算均价",
    twapLiveAvgLabel: "实时 30m 均价",
    autoSettleTitle: "正在自动确认结算价",
    autoSettleStep1: "30 分钟均价采样完成",
    autoSettleStep2: "验证 Atlas 链上签名",
    autoSettleStep3: "开放领奖",
    manualSettleHint: "已过缓冲期，您也可以手动触发链上结算",
    manualSettleCta: "手动结算",
    manualSettling: "提交结算中…",
    outcomeWinBadge: "猜中盈利",
    outcomePartialBadge: "没有归零",
    outcomePartialTitle: "拿回一部分",
    outcomeMissBadge: "本期未中",
    outcomeMissTitle: "未达起赚线",
    outcomeSettlementPriceLabel: "Atlas 30m 结算价",
    outcomeTotalClaimable: "本期合计可领",
    outcomeBatchClaimCta: (amt: string, count: number) =>
      count > 1
        ? `一键领完 ${fmtUsd(amt)}（${count} 笔）`
        : `领取 ${fmtUsd(amt)}`,
    outcomeClaiming: "领取中…",
    outcomeClaimedSuccess: (amt: string) => `已到账 ${fmtUsd(amt)}`,
    outcomePlayAgain: "再来一局",
    outcomeZeroClaimClose: "确认归档",
    historyTitle: "历史与战绩",
    historyNetPnl: "累计盈亏",
    historyTotalTrades: "已结笔数",
    historyDirectionHits: "方向猜对",
    historyPartialSaved: "未到封顶也拿回",
    historyEmpty: "暂无已平仓或已结算记录",
    historyTxOpen: "买入交易",
    historyTxClose: "卖出交易",
    historyTxRedeem: "领取交易",
    rulesSettlementHistoryTitle: "近期 Atlas 链上结算记录",
    rulesSettlementHistoryEmpty: "暂无近期链上结算记录",
    errorGenericTitle: "交易未能完成",
    errorRetry: "重试",

    // Positions & Early Close (preserved for PositionsPage & EarlyCloseModal)
    positionsConnectTitle: "邮箱登录查看持仓",
    positionsConnectDesc:
      "使用邮箱一键登录自动创建链上账户（新用户免费赠送 1,000 tUSDT），实时追踪持仓与自动结算。",
    portfolioValue: "持仓实时估值（可随时卖出）",
    liveUpdating: "实时刷新平仓报价",
    noPositions: "暂无持仓票据",
    noPositionsDesc:
      "用 10~20 USDT 体验防插针、永不爆仓的高赔率价差票，支持测试网一键领水。",
    goTrade: "去交易",
    statusActive: "持仓中",
    statusTwapWindow: "30m 均价锁定",
    statusAwaitingSettle: "待链上结算",
    statusDisputed: "争议冻结中",
    statusClosed: "已提前卖出",
    statusClaimable: "待领取",
    statusSettled: "已结算",
    twapWindowCloseLocked: "30m TWAP 锁定期 · 已锁定早平",
    settleWithAtlasTwapCta: "手动结算 (Atlas TWAP)",
    settleWaitingDelayShort: "等待 60s 结算缓冲期...",
    settleWaitingDelay: "距离开放无许可结算不足 60 秒，请稍后重试。",
    settleAlreadyDone: "该期已在链上完成结算，已刷新可领奖状态。",
    settleTwapSuccess: (sym: string, px: string) =>
      `已完成 ${sym} 30m Atlas TWAP 链上结算（结算价 ${px}）`,
    disputedExpiryNotice: "预言机健康度异常 (<40%) · 争议冻结等待管理员裁决",
    disputedShortLabel: "等待管理员透明裁决",
    awaitingTwapShortLabel: "已到期 · 待提交 30 点 TWAP",
    canExitNow: "当前可提前卖出",
    indicativeCloseLockedLabel: "参考估值 · 早平已锁定",
    claimable: "可领取收益",
    realized: "已落袋",
    earlyCloseCta: "提前卖出",
    claimCta: (amt: string) => `领取 ${amt} USDT`,
    earlyCloseTitle: "提前卖出",
    chooseSellRatio: "选择卖出比例",
    sellAll: "全部",
    sellPct: (p: number) => `${p}%`,
    fetchingExitQuote: "正在获取最优即时卖出价...",
    indicativeExitTitle: "预估提前卖出到手",
    indicativeExitSub: "点击下方按钮锁定 45 秒一口价并成交",
    requestExitQuote: "获取实时卖出报价",
    quoteExpiredRefresh: "报价已过期，重新获取报价",
    quoteExpiredError: "当前报价已超过 45 秒有效期，请重新获取最新报价。",
    instantReceive: "本次卖出立即到账",
    noSlippageNote: "一口价成交 · 1.5% 滑点熔断保护",
    fallbackGuarantee: (exp: string) =>
      `如果您对当前卖出价不满意，可随时取消并继续持有至到期（${exp} UTC），系统将按 Atlas 30m 均价自动结算。`,
    confirmSell: (amt: string) => `确认卖出 · 到手 $${amt}`,
    keepHolding: "继续持有",
    holdNotice: "盘中不爆仓 · 可随时卖出或持有到期自动结算",

    // Faucet & Self-trade
    faucetTitle: "免费领取测试 USDT (tUSDT)",
    faucetDesc:
      "新用户首次登录自动空投 1,000 tUSDT；如需更多测试资金可随时领取（单次最高 100,000 tUSDT）。",
    faucetBnbLink: "获取测试 BNB ↗",
    faucetBalance: "当前 tUSDT 余额",
    faucetAmountLabel: "领取数量",
    faucetClaimBtn: (amt: number) => `领取 ${amt.toLocaleString()} tUSDT`,
    faucetClaiming: "链上领取中...",
    faucetSuccess: (amt: number) => `已成功领取 ${amt.toLocaleString()} tUSDT！`,
    selfTradeError:
      "当前账户与做市商地址相同（合约禁止自成交），请更换其他邮箱账户后再下单。",

    // Linear Payoff Chart & Market Rules
    payoffChartTitle: "到期赔付阶梯图",
    payoffSlopeCall: (step: string, deltaUsd: string, deltaMult: string) =>
      `每涨 ${fmtUsd(step)} 多赚 ${fmtSignedUsd(deltaUsd)} (${fmtSignedMult(deltaMult)})`,
    payoffSlopePut: (step: string, deltaUsd: string, deltaMult: string) =>
      `每跌 ${fmtUsd(step)} 多赚 ${fmtSignedUsd(deltaUsd)} (${fmtSignedMult(deltaMult)})`,
    payoffZoneProfit: "盈利区 (>1x)",
    payoffZoneBuffer: "防归零缓冲 (0~1x)",
    payoffMilestoneSpot: "现价",
    payoffMilestoneBreakeven: "1x 回本",
    payoffMilestoneCap: "满额封顶",
    payoffMilestoneStart: "起赚底线",
    payoffHoverExpiryPrice: "到期结算价",
    payoffHoverPayout: "到期可拿回",
    rulesTitle: "规则与预言机保障",
    rulesBadge:
      "Atlas 30m 链上 TWAP 验签结算 + 健康分争议保护 · BNB Chain 100% 全额托管",
    rulesItem1Title: "1. Atlas 30 分钟确定性 TWAP 无许可链上结算（对齐 OKX/Deribit）",
    rulesItem1TitleRwa: "1. Atlas 30 分钟确定性 TWAP 无许可链上结算（对齐美股收盘）",
    rulesItem1Body: (
      underlying: string,
      feedId: string,
      expiryUtc: string,
      windowLabel = "07:31–08:00 UTC"
    ) =>
      `本合约严格以 Atlas Oracle Feed #${feedId} (${underlying}/USD) 在 ${fmtUtc(expiryUtc)} 前 30 分钟（每分钟 1 点，共 30 个整分钟签名，${windowLabel}）的等权算术均值作为结算价。AtlasPullSettlementOracle 在链上逐点验证官方 ECDSA 签名（到期后前 15 分钟内 0 秒精确锚定，之后放宽 ±10 秒兜底），全市场只计算 1 次即可开放所有人领奖；到期前 30 分钟锁定早平。`,
    rulesItem2Title: "2. 线性赔付边界与公式",
    rulesItem2Body: (
      start: string,
      cap: string,
      maxPayout: string,
      isBull: boolean
    ) =>
      isBull
        ? `到期价 ≤ ${fmtUsd(start)} 时赔付为 0；处于 ${fmtUsd(start)} ~ ${fmtUsd(cap)} 之间按涨幅线性赔付：((结算价 − ${fmtUsd(start)}) / (${fmtUsd(cap)} − ${fmtUsd(start)})) × ${fmtUsdt(maxPayout)}；到期价 ≥ ${fmtUsd(cap)} 时封顶拿满 ${fmtUsdt(maxPayout)}。`
        : `到期价 ≥ ${fmtUsd(start)} 时赔付为 0；处于 ${fmtUsd(cap)} ~ ${fmtUsd(start)} 之间按跌幅线性赔付：((${fmtUsd(start)} − 结算价) / (${fmtUsd(start)} − ${fmtUsd(cap)})) × ${fmtUsdt(maxPayout)}；到期价 ≤ ${fmtUsd(cap)} 时封顶拿满 ${fmtUsdt(maxPayout)}。`,
    rulesItem3Title: "3. ConsensusScore 健康度争议冻结与 100% 链上全额抵押",
    rulesItem3Body:
      "成交瞬间买方本金与做市商封顶赔付金 100% 锁入 BNB Chain 智能合约金库，盘中剧烈插针绝不强平。系统实时监控 Atlas ConsensusScore：交易期间极端分歧触发报价熔断；若结算窗口 30 分钟平均健康分低于 40%，系统将自动放弃脏数据并在链上冻结该期，交由管理员附公开审计理由透明裁决。",
    rulesItem4Title: "4. RWA bStock 乘数与公司行动保护机制",
    rulesItem4Body: (shareMultiplier: string, feedId: string) =>
      `本市场锚定币安 bStocks BEP-677 资产 NVDAB/USD（Atlas Feed #${feedId}）。当前链上份额乘数为 1 NVDAB = ${shareMultiplier} NVDA，自动计入股息再投资并保持拆股前后价格连续。拆股切换哨兵实时监控份额乘数漂移与公司行动窗口：若单期乘数漂移超过 1.0% 或处于公司行动保护期，系统将自动触发新开仓熔断并冻结受影响的到期窗口，待校验通过后再安全结算。`,

    // Atlas Oracle Badge copy
    atlasBadgeTitle: "Atlas Oracle 实时共识护盾",
    atlasFeedLabel: "数据源 Feed",
    atlasConsensusLabel: "共识健康度",
    atlasTwapLabel: "TWAP 均价",
    atlasMedianLabel: "中位价 Median",
    atlasVolatilityLabel: "价格波动率",
    atlasVerifierLabel: "链上结算合约 / 验签者",
    atlasOracleContractLabel: "Oracle 合约",
    atlasBreakerActive: "熔断保护触发",
    atlasBreakerNormal: "结算与报价守护正常",
    atlasBscTestnet: "BSC 测试网",
    atlasToggleDetails: "详情",

    // TradePage & RWA & Slippage
    zeroLiqBadge: "0 爆仓",
    tenorDailyPill: "24H 日度",
    tenorWeeklyPill: "7D 周度",
    tenorRwaDailyPill: "近期收盘 (一/三/五)",
    tenorRwaWeeklyPill: "周五周度",
    rwaSessionRth: "美股盘中",
    rwaSessionExtended: "美股盘前/盘后",
    rwaSessionWeekend: "周末 24/7",
    rwaShareRatioLabel: (mult: string) => `1 NVDAB = ${mult} NVDA`,
    rwaSettlementClockLabel: (utc: string, utc8: string) =>
      `美股收盘 ${utc} · ${utc8}`,
    rwaQuotingPausedCta: "RWA 保护熔断中 · 暂停新开仓",
    rwaBlackoutPausedNotice: (reason?: string | null) =>
      reason
        ? `RWA 公司行动或拆股切换保护已触发（${reason}），已自动暂停新开仓（现有持仓仍可安全平仓或到期结算）。`
        : "检测到 RWA 拆股切换或公司行动保护窗口，已自动暂停新开仓（现有持仓仍可安全平仓或到期结算）。",
    eventTitle: (underlying: string, isDaily: boolean) =>
      underlying === "NVDAB"
        ? "NVDA (NVDAB · RWA) · 美股收盘连续赔付预测市场"
        : `${underlying} ${isDaily ? "24h" : "7D"} 涨跌 · 连续赔付预测市场`,
    startLineLabel: "起赚线",
    settlesCountdownLabel: "距结算",
    settledNow: "结算中",
    fixedGridNote: "固定网格锚定 · 抗插针不漂移",
    upButtonLabel: "看涨",
    downButtonLabel: "看跌",
    selectTargetTitle: "选择目标封顶价",
    sharedPoolTag: "多空同池",
    fixedStartLineHint: (price: string, isBull: boolean) =>
      `固定起赚底线 ${fmtUsd(price)}（${isBull ? "超过即线性赔付，自带防归零缓冲" : "跌破即线性赔付，自带防归零缓冲"}）`,
    toWinLabel: "最多赢",
    flatReturnCompactLabel: "现价横盘拿回",
    breakevenCompactLabel: "回本价",
    buyOneClickCta: (dir: string, stake: number) => `买${dir} $${stake}`,
    lockingBestPrice: "正在锁定最优成交价...",
    openingWallet: "正在成交…",
    slippageTitle: "价格瞬时波动，已锁定最新一口价",
    slippageBuyDesc: (prevUsd: string, nextUsd: string, dropPct: string) =>
      `最高可赢由 ${prevUsd} USDT 调整为 ${nextUsd} USDT（-${dropPct}%），确认按新价成交？`,
    slippageConfirmBuyCta: (payout: string) =>
      `确认成交（最多赢 $${payout}）`,
    indicativeExitSubSeamless:
      "点击下方按钮锁定 45 秒最新一口价并一键静默成交",
    confirmSellApprox: (amt: string) => `确认卖出 · 约 $${amt}`,
    slippageSellDesc: (estUsd: string, firmUsd: string, dropPct: string) =>
      `最新锁定回购价为 ${firmUsd} USDT，较参考估值 ${estUsd} USDT 变动 -${dropPct}%，确认卖出？`,
    slippageConfirmSellCta: (amt: string) => `确认按新价卖出（$${amt}）`,
    fetchingAndSelling: "正在锁价并卖出…",
  },
  en: {
    // Navigation & Account
    navTrade: "Trade",
    navPositions: "Portfolio",
    navWallet: "Portfolio",
    connectWallet: "Sign in",
    myWallet: "Account",
    walletSubtitleConnected: "Privy embedded wallet · 100% on-chain on BNB Chain",
    walletSubtitleDisconnected:
      "Sign in with email for an instant BNB account + 1,000 free welcome tUSDT",
    availableBalance: "Available balance",
    disconnectWallet: "Sign out",
    exportPrivateKey: "Export wallet key",
    gasFreeBadge: "0 Fees",
    gasFreeAccountNote:
      "Non-custodial Privy embedded wallet · Silent execution on BNB Testnet",
    privyEmailAccountLabel: "Email account",
    welcomeAirdropMinting: "Sending 1,000 free welcome tUSDT to your new account...",
    welcomeAirdropSuccess: (amt: number) =>
      `Welcome to Payoff! ${amt.toLocaleString()} tUSDT has been airdropped to your account — ready to trade.`,
    welcomeAirdropShortSuccess: (amt: number) =>
      `${amt.toLocaleString()} tUSDT airdropped`,
    welcomeAirdropRetry: "Retry",
    welcomeAirdropRetryFull: "Retry 1,000 tUSDT",
    initializingWallet: "Setting up account...",
    viewOnBscScan: "View on BscScan",
    nonCustodialNote:
      "Used for on-chain signing only. Payoff never custodies your keys.",
    cappedLossTag: "Capped loss · Zero liquidation",

    // Market & Direction
    past24h: "Past 24h",
    bull: "Up",
    bear: "Down",
    daily: "24h Daily",
    weekly: "Weekly (3-7d)",
    settlesInHours: (h: string) => `Settles in ${h}h`,
    chooseRange: "Choose target range",
    autoRollingHint: "Auto-aligned to live price",
    customRangeTitle: "Custom price range",
    customRangeBadge: "Standard strike grid · Synced to chart",
    lowerBound: "Lower strike",
    upperBound: "Upper strike",
    stepDown: "− Step down",
    stepUp: "+ Step up",
    alignedNotice: "Locked to standard strike increments",
    widthInfo: (w: string, max: string) => `Range width ${w}% (max ${max}%)`,
    tierConservative: "Cushioned",
    tierStandard: "Standard",
    tierBreakout: "Breakout",
    tierCustom: "Custom",
    tagConservative: "Safe",
    tagStandard: "Default",
    tagBreakout: "High odds",
    hintConservative: "Retains value if flat",
    hintStandard: "Perp alternative · Wick-proof",
    hintBreakout: "Small stake, high upside",
    flatReturnShort: (pct: string) => `${pct}% back if flat`,
    breakevenShort: (pct: string) => `BE ${pct}%`,
    maxMultiplier: "Max payout",
    buyAmount: "Amount",
    available: "Available",
    numStake: "Cost (Max loss)",
    numBreakeven: "Breakeven at expiry",
    numFlatReturn: "Payout if price stays flat",
    numCapPayout: "Full payout target",
    numExpiry: "Settlement time",
    numEarlyExit: "Early exit reference",
    earlyExitMove: (amt: string) => `~${amt} USDT on 1.5% move`,
    noLiqNote: "Wick-proof · Full payout locked on-chain",
    savePct: (p: string) => `Save ${p}%`,

    // Option A Target Cap Slider + Quick/Custom Mode + Editable Amount Bar + Math Line + CTAs
    rangeModeGroupLabel: "Range mode",
    modeQuick: "Quick",
    modeCustom: "Custom",
    capPriceLabel: "Full win at",
    capPriceLabelBull: "Full win at",
    capPriceLabelBear: "Full win at",
    startPriceLabel: "Start",
    startPriceLabelBull: "Pays above",
    startPriceLabelBear: "Pays below",
    stepPrevLabel: (price: string) => `Step left to ${fmtUsd(price)}`,
    stepNextLabel: (price: string) => `Step right to ${fmtUsd(price)}`,
    customWidthSummary: (widthPct: string, maxWidthPct: string) =>
      `Width ${widthPct}% / ${maxWidthPct}% max`,
    customFairRangeSummary: (minMult: string, maxMult: string) =>
      `Fair ${minMult}x–${maxMult}x`,
    customClampWidthCap: (maxWidthPct: string) =>
      `Target cap auto-clamped to width limit (≤ ${maxWidthPct}%)`,
    customClampOtmFair: (maxMult: string) =>
      `Target cap auto-clamped to OTM fair limit (~${maxMult}x max)`,
    customClampItmFair: (minMult: string) =>
      `Target cap auto-clamped to ITM fair floor (≥ ${minMult}x)`,
    customClampStartOtmFair: (maxMult: string) =>
      `Start auto-clamped to OTM fair limit (~${maxMult}x max)`,
    customClampStartItmFair: (minMult: string) =>
      `Start auto-clamped to ITM fair floor (≥ ${minMult}x)`,
    customClampOrdering: "Target cap shifted to stay past Start",
    customClampStrikeAlign: "Range auto-aligned to standard strike ticks",
    customSingleCapHint: "Only valid cap here",
    sliderTargetHint: (op: "≥" | "≤", price: string, pct: string) =>
      `Cap ${op} ${fmtUsd(price)} (${pct})`,
    stakeInputLabel: "Amount",
    amountQuickAdd100: "+$100",
    amountMax: "Max",
    mathStartShort: (price: string) => `Start ${fmtUsd(price)}`,
    mathBreakevenShort: (price: string) => `Breakeven ${fmtUsd(price)}`,
    mathMaxWin: (amt: string) => `Win up to ${fmtUsd(amt)}`,
    buyCtaBull: (stake: string, _maxWin: string) =>
      `Buy Up · ${fmtUsd(stake)}`,
    buyCtaBear: (stake: string, _maxWin: string) =>
      `Buy Down · ${fmtUsd(stake)}`,
    buyCtaSignIn: "Sign in to trade · Free 1,000 tUSDT",
    executingGasless: "Filling order…",
    approvingGasless: "Authorizing…",
    chartScrubHint: "Drag to simulate payout",
    chartScrubReadout: (price: string, payout: string) =>
      `At ${fmtUsd(price)} → Payout ${fmtUsd(payout)}`,
    chartScrubTotalReadout: (price: string, totalPayout: string) =>
      `At ${fmtUsd(price)} → Total ${fmtUsd(totalPayout)}`,
    chartCapPill: (win: string, op: "≥" | "≤", cap: string) =>
      `Win ${fmtUsd(win)} · ${op} ${fmtUsd(cap)}`,

    // Order States
    buySuccess:
      "Ticket filled & payout locked (same-range positions merge automatically)",
    viewPositions: "View portfolio",
    continueTrading: "Buy another",
    lockedQuoteTitle: "Best firm quote locked",
    payToWin: (s: number) => `Pay ${s} USDT to win up to`,
    approvingUsdt: "Authorizing USDT...",
    confirmingTx: "Confirming transaction...",
    confirmPay: (s: string) => `Confirm & pay ${s} USDT`,
    cancel: "Cancel",
    connectToBuy: "Sign in to trade · Free 1,000 tUSDT",
    fetchingQuote: "Fetching firm quote...",
    insufficientUsdt: "Insufficient USDT balance",
    adjustRangeFirst: "Adjust range within guardrails",
    quotingPausedCta: "Oracle circuit breaker active · New opens paused",
    quotingPausedNotice:
      "Atlas ConsensusScore detected severe market divergence and automatically paused new open quotes. Existing tickets remain safe for early exit or expiry settlement.",
    buyNowCta: (dir: string, s: number) => `Buy ${dir} · $${s}`,

    // Chart
    chartCandle: "Candles",
    chartLine: "Line",
    bar5m: "5m",
    bar15m: "15m",
    bar1H: "1H",
    bar4H: "4H",
    bar1D: "1D",
    chartCapLabel: (m: string) => `Max ${m}x`,
    chartBreakevenLabel: "Breakeven",
    chartStartLabel: "Start",
    profitZone: "Target zone",
    perpCompare: (px: string) => `50x perp liq at $${px} · Ticket stays safe`,

    // A1 Onboarding Sheet (uses "Standard prediction markets")
    onboardingTitle: "Understand Payoff in 30s",
    onboardingSubtitle: "Wick-proof, continuous-payout directional markets",
    onboardingRule1Title: "1. Pick a direction & target cap",
    onboardingRule1Body:
      "Slide to pick your cap price and payout multiplier. Loss is strictly capped—intraday wicks never liquidate you.",
    onboardingRule2Title: "2. Move halfway, still get paid",
    onboardingRule2Body:
      "Unlike all-or-nothing binary markets, any finish past your start line pays linearly.",
    onboardingRule3Title: "3. Email sign-in · Exit anytime",
    onboardingRule3Body:
      "Get 1,000 free test USDT on sign-in, execute with 1 click, or sell early anytime before the 30m lock.",
    onboardingCompareTitle:
      "With a $20 trade when price finishes halfway to target",
    onboardingCompareStandardLabel: "Standard prediction markets",
    onboardingCompareStandardValue: "$0 (zeroed out)",
    onboardingComparePayoffLabel: "Payoff",
    onboardingComparePayoffValue: "~$36 (paid linearly)",
    onboardingStartCta: "Get started",
    onboardingReplayBtn: "Replay 30s intro",

    // Market Picker Sheet
    marketPickerTitle: "Select market",
    marketPickerSubtitle: "100% on-chain collateral · Atlas 30m TWAP settlement",
    marketBtcName: "Bitcoin",
    marketEthName: "Ethereum",
    marketNvdaName: "NVIDIA",
    marketCadenceCrypto: "Daily 08:00 UTC / Fri",
    marketCadenceRwa: "Mon/Wed/Fri US Close",
    marketActivePositionsBadge: (n: number) => `${n} open`,
    infoRulesTooltip: "Rules & Oracle",

    // B1-B6 In-Page Positions, Merge Sheet (B3), Sell Sheet (B4), Account Drawer (B6)
    currentExpiryPositionsTitle: "Positions this expiry",
    positionsTotalStake: "Total stake",
    positionsTotalValue: "Current value",
    positionsSimulatedTotal: "Simulated total",
    actionSell: "Sell",
    actionAddMore: "Buy more",
    priorExpiryViewOnly:
      "New opens closed for this expiry. Sell early or hold to settlement.",
    jumpToNextExpiry: "Trade next expiry",
    addMoreSheetTitle: "Buy more",
    mergeNoticeSameSeries: (
      existingStake: string,
      combinedStake: string,
      combinedMaxPayout: string
    ) =>
      `Merges with your existing same-range position (${fmtUsd(existingStake)}) → Combined ${fmtUsd(combinedStake)}, max win ${fmtUsd(combinedMaxPayout)}`,
    mergeNoticeNewSeries:
      "Opens a separate strike-range position tracked on this page",
    sellSheetEstPayout: "Estimated instant payout",
    sellSheetCompareSellTitle: "Sell now",
    sellSheetCompareHoldTitle: "Hold to expiry",
    sellSheetRemainingNote: (pct: number, remMax: string) =>
      `${pct}% kept · up to ${fmtUsd(remMax)}`,
    sellSheetFullyClosed: "100% locked in, no expiry risk",
    sellSheetHoldRange: (min: string, max: string) =>
      `${fmtUsd(min)} – ${fmtUsd(max)}`,
    sellRatio25: "25%",
    sellRatio50: "50%",
    sellRatio100: "All",
    drawerTitle: "Account & Portfolio",
    drawerGasFreePill: "Gas Free",
    drawerTotalPositionValue: "Active positions value",
    drawerAvailableUsdt: "Available",
    drawerQuickFaucet: "Gas-free faucet",
    drawerClaimableSection: "Ready to claim",
    drawerActiveSection: "Active positions",
    drawerNoActivePositions: "No active positions yet",
    drawerGroupCount: (n: number) => `${n} ${n === 1 ? "ticket" : "tickets"}`,
    drawerHistoryStats: "History & Stats",
    drawerRulesSecurity: "Rules & Security",
    drawerLanguage: "Language",
    drawerOnchainAddress: "On-chain address & export key",
    drawerCopyAddress: "Copy address",
    drawerCopied: "Copied",

    // C1-C6 TWAP Lock, Settlement, 3 Outcomes, Batch Claim, History Stats, Errors
    twapLockBannerTitle: "Final 30m TWAP lock window",
    twapLockBannerDesc:
      "Early sell locked while Atlas samples 30 one-minute signed prices",
    twapLiveAvgLabel: "Live 30m avg",
    autoSettleTitle: "Confirming settlement price",
    autoSettleStep1: "30-minute TWAP sampled",
    autoSettleStep2: "Verifying Atlas on-chain proofs",
    autoSettleStep3: "Unlocking claim",
    manualSettleHint:
      "Buffer elapsed — you can also trigger on-chain settlement",
    manualSettleCta: "Settle now",
    manualSettling: "Settling…",
    outcomeWinBadge: "Won",
    outcomePartialBadge: "Not zeroed out",
    outcomePartialTitle: "Partial refund",
    outcomeMissBadge: "Missed",
    outcomeMissTitle: "Below start line",
    outcomeSettlementPriceLabel: "Atlas 30m settlement",
    outcomeTotalClaimable: "Total claimable",
    outcomeBatchClaimCta: (amt: string, count: number) =>
      count > 1
        ? `Claim all ${fmtUsd(amt)} (${count} tickets)`
        : `Claim ${fmtUsd(amt)}`,
    outcomeClaiming: "Claiming…",
    outcomeClaimedSuccess: (amt: string) => `Claimed ${fmtUsd(amt)}`,
    outcomePlayAgain: "Play next round",
    outcomeZeroClaimClose: "Dismiss",
    historyTitle: "History & Stats",
    historyNetPnl: "Cumulative PnL",
    historyTotalTrades: "Completed",
    historyDirectionHits: "Direction right",
    historyPartialSaved: "Partial refunds",
    historyEmpty: "No settled or closed trades yet",
    historyTxOpen: "Open tx",
    historyTxClose: "Sell tx",
    historyTxRedeem: "Claim tx",
    rulesSettlementHistoryTitle: "Recent Atlas settlements",
    rulesSettlementHistoryEmpty: "No recent settlements yet",
    errorGenericTitle: "Action could not complete",
    errorRetry: "Try again",

    // Positions & Early Close (preserved for PositionsPage & EarlyCloseModal)
    positionsConnectTitle: "Sign in to view portfolio",
    positionsConnectDesc:
      "Sign in with email for an instant BNB account (with 1,000 free welcome tUSDT) and track live exits or Atlas settlements.",
    portfolioValue: "Live portfolio exit value",
    liveUpdating: "Live exit quotes",
    noPositions: "No active tickets",
    noPositionsDesc:
      "Start with 10–20 USDT for wick-proof, capped-loss directional trades on BNB Smart Chain Testnet.",
    goTrade: "Explore markets",
    statusActive: "Active",
    statusTwapWindow: "30m TWAP lock",
    statusAwaitingSettle: "Awaiting settlement",
    statusDisputed: "Disputed · Paused",
    statusClosed: "Sold early",
    statusClaimable: "Claimable",
    statusSettled: "Settled",
    twapWindowCloseLocked: "30m TWAP lock · Early sell locked",
    settleWithAtlasTwapCta: "Settle with Atlas 30m TWAP",
    settleWaitingDelayShort: "60s settlement buffer...",
    settleWaitingDelay:
      "Permissionless settlement opens 60s after expiry; please retry shortly.",
    settleAlreadyDone: "This expiry is already settled on-chain.",
    settleTwapSuccess: (sym: string, px: string) =>
      `Settled ${sym} via 30m Atlas TWAP (${px})`,
    disputedExpiryNotice:
      "Oracle health alert (<40%) · Disputed expiry paused awaiting admin settlement",
    disputedShortLabel: "Awaiting admin resolution",
    awaitingTwapShortLabel: "Expired · Ready for 30-pt TWAP",
    canExitNow: "Exit value now",
    indicativeCloseLockedLabel: "Indicative value · Close locked",
    claimable: "Claimable payout",
    realized: "Realized",
    earlyCloseCta: "Sell early",
    claimCta: (amt: string) => `Claim ${amt} USDT`,
    earlyCloseTitle: "Sell early",
    chooseSellRatio: "Select portion to sell",
    sellAll: "All",
    sellPct: (p: number) => `${p}%`,
    fetchingExitQuote: "Getting best instant buyback quote...",
    indicativeExitTitle: "Estimated instant payout",
    indicativeExitSub: "Click below to lock a 45s firm buyback quote",
    requestExitQuote: "Get firm exit quote",
    quoteExpiredRefresh: "Quote expired · Refresh quote",
    quoteExpiredError:
      "This 45s firm quote has expired. Please request a fresh quote.",
    instantReceive: "Instant payout to account",
    noSlippageNote: "Firm quote · 1.5% slippage guard",
    fallbackGuarantee: (exp: string) =>
      `Not happy with the exit quote? Cancel anytime and hold to expiry (${exp} UTC) for permissionless on-chain Atlas 30m TWAP settlement.`,
    confirmSell: (amt: string) => `Confirm sell · $${amt}`,
    keepHolding: "Keep holding",
    holdNotice:
      "Zero liquidation · Sell early anytime or hold to Atlas settlement",

    // Faucet & Self-trade
    faucetTitle: "Claim Extra Test USDT (tUSDT)",
    faucetDesc:
      "New accounts automatically receive 1,000 tUSDT on first sign-in. Mint additional testnet collateral anytime (up to 100,000 tUSDT).",
    faucetBnbLink: "Get test BNB ↗",
    faucetBalance: "Current tUSDT balance",
    faucetAmountLabel: "Amount to mint",
    faucetClaimBtn: (amt: number) =>
      `Claim ${amt.toLocaleString()} tUSDT`,
    faucetClaiming: "Minting...",
    faucetSuccess: (amt: number) =>
      `Minted ${amt.toLocaleString()} tUSDT to your account!`,
    selfTradeError:
      "Signed-in account matches the market maker address (self-trade is blocked on-chain). Please sign in with another email.",

    // Linear Payoff Chart & Market Rules
    payoffChartTitle: "Linear Payoff at Expiry",
    payoffSlopeCall: (step: string, deltaUsd: string, deltaMult: string) =>
      `${fmtSignedUsd(deltaUsd)} (${fmtSignedMult(deltaMult)}) per +${fmtUsd(step)}`,
    payoffSlopePut: (step: string, deltaUsd: string, deltaMult: string) =>
      `${fmtSignedUsd(deltaUsd)} (${fmtSignedMult(deltaMult)}) per -${fmtUsd(step)}`,
    payoffZoneProfit: "Profit Zone (>1x)",
    payoffZoneBuffer: "Buffer Zone (0–1x)",
    payoffMilestoneSpot: "Spot",
    payoffMilestoneBreakeven: "1x Breakeven",
    payoffMilestoneCap: "Max Cap",
    payoffMilestoneStart: "Start Line",
    payoffHoverExpiryPrice: "Expiry Price",
    payoffHoverPayout: "Expiry Payout",
    rulesTitle: "Rules & Oracle Security",
    rulesBadge:
      "Atlas 30m On-Chain TWAP Settlement + Health Dispute Guard · 100% On-Chain Collateral on BNB Chain",
    rulesItem1Title:
      "1. Permissionless 30-Minute Atlas TWAP Settlement (OKX / Deribit Standard)",
    rulesItem1TitleRwa:
      "1. Permissionless 30-Minute Atlas TWAP Settlement (US Market Close)",
    rulesItem1Body: (
      underlying: string,
      feedId: string,
      expiryUtc: string,
      windowLabel = "07:31–08:00 UTC"
    ) =>
      `Settles against the equal-weighted arithmetic mean of 30 deterministic 1-minute signed Atlas Oracle Feed #${feedId} (${underlying}/USD) prices over the final 30 minutes before ${fmtUtc(expiryUtc)} (${windowLabel}). AtlasPullSettlementOracle verifies all 30 official ECDSA signatures on-chain (0s exact match within 15m after expiry, ±10s fallback thereafter), computed once and reused for all redemptions. Early close locks 30m prior to expiry.`,
    rulesItem2Title: "2. Linear Payoff Bounds & Formula",
    rulesItem2Body: (
      start: string,
      cap: string,
      maxPayout: string,
      isBull: boolean
    ) =>
      isBull
        ? `Pays 0 if expiry ≤ ${fmtUsd(start)}. Between ${fmtUsd(start)} and ${fmtUsd(cap)}, pays linearly: ((Expiry − ${fmtUsd(start)}) / (${fmtUsd(cap)} − ${fmtUsd(start)})) × ${fmtUsdt(maxPayout)}. Pays the full ${fmtUsdt(maxPayout)} cap at or above ${fmtUsd(cap)}.`
        : `Pays 0 if expiry ≥ ${fmtUsd(start)}. Between ${fmtUsd(cap)} and ${fmtUsd(start)}, pays linearly: ((${fmtUsd(start)} − Expiry) / (${fmtUsd(start)} − ${fmtUsd(cap)})) × ${fmtUsdt(maxPayout)}. Pays the full ${fmtUsdt(maxPayout)} cap at or below ${fmtUsd(cap)}.`,
    rulesItem3Title:
      "3. ConsensusScore Health Dispute Freeze & 100% On-Chain Collateral",
    rulesItem3Body:
      "Full max payout is 100% locked in the BNB Chain vault at fill—intraday wicks never liquidate your ticket. Live Atlas Enterprise ConsensusScore halts quoting during extreme divergence or stale feeds; if the 30-minute settlement window averages below 40% health score, the expiry is automatically frozen on-chain for transparent admin resolution with a public audit reason.",
    rulesItem4Title: "4. RWA bStock & Corporate Action Protection",
    rulesItem4Body: (shareMultiplier: string, feedId: string) =>
      `Tracks Binance bStocks BEP-677 NVDAB/USD via Atlas Feed #${feedId}. Each NVDAB token currently represents ${shareMultiplier} NVDA shares (live shareMultiplier), automatically compounding dividends and keeping Atlas pricing continuous across stock splits. A live Split-Cutover Sentinel monitors multiplier drift and corporate action blackouts: if multiplier drift exceeds 1.0% or a blackout window is active, new opens halt automatically and affected expiries pause for verified settlement.`,

    // Atlas Oracle Badge copy
    atlasBadgeTitle: "Atlas Oracle Live Shield",
    atlasFeedLabel: "Oracle Feed",
    atlasConsensusLabel: "ConsensusScore",
    atlasTwapLabel: "TWAP",
    atlasMedianLabel: "Median",
    atlasVolatilityLabel: "Volatility",
    atlasVerifierLabel: "Oracle Contract / Signer",
    atlasOracleContractLabel: "Oracle Contract",
    atlasBreakerActive: "Circuit Breaker Active",
    atlasBreakerNormal: "Settlement & Quoting Guard Active",
    atlasBscTestnet: "BSC Testnet",
    atlasToggleDetails: "Details",

    // TradePage & RWA & Slippage
    zeroLiqBadge: "Zero Liquidation",
    tenorDailyPill: "24H Daily",
    tenorWeeklyPill: "7D Weekly",
    tenorRwaDailyPill: "Next Close (M/W/F)",
    tenorRwaWeeklyPill: "Weekly Fri",
    rwaSessionRth: "US Market Open",
    rwaSessionExtended: "Extended Hours",
    rwaSessionWeekend: "Weekend 24/7",
    rwaShareRatioLabel: (mult: string) => `1 NVDAB = ${mult} NVDA`,
    rwaSettlementClockLabel: (utc: string, utc8: string) =>
      `US Close ${utc} · ${utc8}`,
    rwaQuotingPausedCta: "RWA protection pause · New opens paused",
    rwaBlackoutPausedNotice: (reason?: string | null) =>
      reason
        ? `RWA split-cutover or corporate action protection active (${reason}). New opens are paused while existing tickets remain safe for early exit or settlement.`
        : "RWA split-cutover or corporate action protection active. New opens are paused while existing tickets remain safe for early exit or settlement.",
    eventTitle: (underlying: string, isDaily: boolean) =>
      underlying === "NVDAB"
        ? "NVDA (NVDAB · RWA) · US Close Continuous-Payout Prediction Market"
        : `${underlying} ${isDaily ? "24h" : "7D"} Direction · Continuous-Payout Prediction Market`,
    startLineLabel: "Start Line",
    settlesCountdownLabel: "Settles in",
    settledNow: "Settling",
    fixedGridNote: "Fixed grid anchor · Hysteresis locked",
    upButtonLabel: "Up",
    downButtonLabel: "Down",
    selectTargetTitle: "Select target cap",
    sharedPoolTag: "Shared Pool",
    fixedStartLineHint: (price: string, isBull: boolean) =>
      `Fixed Start Line ${fmtUsd(price)} (${isBull ? "linear payout starts above with built-in buffer" : "linear payout starts below with built-in buffer"})`,
    toWinLabel: "Max win",
    flatReturnCompactLabel: "If flat at expiry",
    breakevenCompactLabel: "Breakeven",
    buyOneClickCta: (dir: string, stake: number) => `Buy ${dir} · $${stake}`,
    lockingBestPrice: "Locking best firm price...",
    openingWallet: "Filling order…",
    slippageTitle: "Market moved — updated firm quote",
    slippageBuyDesc: (prevUsd: string, nextUsd: string, dropPct: string) =>
      `Max payout moved from ${prevUsd} to ${nextUsd} USDT (-${dropPct}%). Confirm to proceed?`,
    slippageConfirmBuyCta: (payout: string) =>
      `Confirm quote (Win $${payout})`,
    indicativeExitSubSeamless:
      "Locks a fresh 45s firm buyback quote and executes with 1 click",
    confirmSellApprox: (amt: string) => `Confirm sell · ~$${amt}`,
    slippageSellDesc: (estUsd: string, firmUsd: string, dropPct: string) =>
      `Firm buyback quote is ${firmUsd} USDT vs estimated ${estUsd} USDT (-${dropPct}%). Confirm exit?`,
    slippageConfirmSellCta: (amt: string) => `Confirm sell ($${amt})`,
    fetchingAndSelling: "Locking quote & selling…",
  },
} as const;

export type I18nCopy = (typeof dict)[Locale];

export function getCopy(locale: Locale): I18nCopy {
  return dict[locale];
}
