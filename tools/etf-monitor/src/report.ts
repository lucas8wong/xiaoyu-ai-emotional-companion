import { defaultThresholds } from './signals.js';
import type { Analysis, Direction } from './types.js';

const priceNames: Record<Direction, string> = { low: '回撤低位观察', neutral: '中性', hot: '价格偏热' };
const valuationNames = { unknown: '待确认', cheap: '相对便宜', fair: '中间区间', expensive: '相对昂贵' };
const pct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

export function renderReport(analyses: Analysis[], options: {
  kind: 'daily' | 'signal'; beijingDate: string; latestSession: string; holiday: boolean; issues?: string[];
}): { title: string; body: string } {
  const title = `QQQM / SPYM ${options.kind === 'daily' ? '每日监测' : '信号提醒'} · ${options.beijingDate}`;
  const lines = [`北京时间 ${options.beijingDate}；最近完整美股交易日 ${options.latestSession}。`];
  if (options.holiday) lines.push('美股休市，沿用最近完整交易日；休市不累计信号确认。');
  for (const analysis of analyses) {
    const { symbol, metrics, price, confirmed, valuation, valuationConfirmed } = analysis;
    const thresholds = defaultThresholds[symbol];
    lines.push('', symbol);
    if (metrics) {
      lines.push(`收盘 $${metrics.close.toFixed(2)}；涨跌幅（复权）${pct(metrics.changePct)}。`);
      lines.push(`复权口径：252 日回撤 ${pct(metrics.drawdownPct)}；距 200 日均线 ${pct(metrics.gapPct)}。`);
    } else lines.push('价格数据异常，暂停新信号。');
    if (price === null) lines.push(`价格信号暂停；上次已确认：${priceNames[confirmed]}。`);
    else if (price !== confirmed) lines.push(`当前：${priceNames[price]}，待连续两个交易日确认；已确认：${priceNames[confirmed]}。`);
    else lines.push(`已确认：${priceNames[confirmed]}。`);
    const met = (value: boolean | undefined) => value === undefined ? '暂无数据' : value ? '满足' : '未满足';
    lines.push(`低位条件：回撤≤${thresholds.drawdownPct}%（${met(metrics ? metrics.drawdownPct <= thresholds.drawdownPct : undefined)}）且距均线≤${thresholds.belowMaPct}%（${met(metrics ? metrics.gapPct <= thresholds.belowMaPct : undefined)}）；偏热条件：距均线≥${thresholds.aboveMaPct}%（${met(metrics ? metrics.gapPct >= thresholds.aboveMaPct : undefined)}）。`);
    let valuationLine = `估值：${valuationNames[valuation.status]}`;
    if (valuation.status !== 'unknown' && valuation.status !== valuationConfirmed) valuationLine += '（待连续两个交易日确认）';
    if (valuation.pe !== null) valuationLine += `；FY1 P/E ${valuation.pe.toFixed(2)}`;
    if (valuation.percentile !== null) valuationLine += `；五年历史分位 ${valuation.percentile.toFixed(1)}%`;
    if (valuation.date) valuationLine += `（${valuation.date}）`;
    lines.push(`${valuationLine}。`);
    lines.push(symbol === 'QQQM' ? '估值口径：Nasdaq-100 指数代理，来自 QNDX 官方指数栏。' : '估值口径：S&P 500 指数 FY1 市盈率。');
    if (valuation.status === 'unknown') lines.push(`估值待确认原因：${valuation.reason}。`);
    if (valuation.source) lines.push(`估值来源：${valuation.source}`);
    if (price !== null && price === confirmed && confirmed === 'low') {
      lines.push(valuation.status === 'cheap' && valuationConfirmed === 'cheap' ? '组合信号：低位且估值相对便宜。' :
        valuation.status === 'cheap' ? '组合信号：价格低位；估值相对便宜尚待连续两个交易日确认。' :
          `组合信号：价格低位，估值${valuation.status === 'unknown' ? '待确认，不能称为便宜' : '尚未进入便宜区间'}。`);
    } else if (price !== null && price === confirmed && confirmed === 'hot') {
      lines.push(valuation.status === 'expensive' && valuationConfirmed === 'expensive' ? '组合信号：价格偏热且估值相对昂贵。' :
        valuation.status === 'expensive' ? '组合信号：价格偏热；估值相对昂贵尚待连续两个交易日确认。' :
          `组合信号：价格偏热，估值${valuation.status === 'unknown' ? '待确认，不能称为昂贵' : '尚未进入昂贵区间'}。`);
    }
    for (const error of analysis.errors) lines.push(`数据提示：${error}`);
  }
  for (const issue of options.issues ?? []) lines.push(`运行提示：${issue}`);
  lines.push('', '以上为待验证的固定规则观察信号，不能预测底部或顶部；价格低位不等于估值便宜。');
  return { title, body: lines.join('\n') };
}
