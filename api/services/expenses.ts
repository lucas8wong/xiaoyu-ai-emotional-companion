/**
 * 其他支出存储模块（运营手动记录的固定/杂项成本：域名、服务器、营销、人工等）
 * 持久化到 data/expenses.json
 * 用途：商业审查看板计算真实利润时，成本 = API 成本 + 其他支出
 */
import crypto from 'crypto';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const EXPENSES_FILE = dataFile('expenses.json');

export interface Expense {
  id: string;
  category: string; // 分类：域名 / 服务器 / 营销 / 人工 / 其他
  note: string;     // 说明
  amount: number;   // 金额（人民币元）
  date: string;     // 发生日期 YYYY-MM-DD
  createdAt: number;
}

class ExpenseStore {
  private expenses: Expense[] = [];

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed: unknown = readJson<unknown>(EXPENSES_FILE, []);
    if (Array.isArray(parsed)) {
      this.expenses = (parsed as Array<Partial<Expense>>).filter(
        (e): e is Expense => !!e && typeof e.id === 'string' && typeof e.amount === 'number' && e.amount > 0
      );
    }
    console.log(`💾 [Expense] 已从磁盘加载 ${this.expenses.length} 条其他支出`);
  }

  private saveToDisk(): void {
    try {
      writeJson(EXPENSES_FILE, this.expenses);
    } catch (error) {
      console.warn('⚠️ [Expense] 保存其他支出失败:', (error as Error)?.message);
    }
  }

  /** 按日期倒序返回全部支出（新的在前） */
  list(): Expense[] {
    return this.expenses.slice().sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
  }

  /** 其他支出合计（元） */
  total(): number {
    return Math.round(this.expenses.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  }

  add(category: string, note: string, amount: number, date: string): Expense {
    const exp: Expense = {
      id: crypto.randomUUID(),
      category: (category || '其他').trim().slice(0, 30) || '其他',
      note: (note || '').trim().slice(0, 200),
      amount: Math.round(amount * 100) / 100,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10),
      createdAt: Date.now(),
    };
    this.expenses.push(exp);
    this.saveToDisk();
    return exp;
  }

  remove(id: string): boolean {
    const before = this.expenses.length;
    this.expenses = this.expenses.filter(e => e.id !== id);
    if (this.expenses.length === before) return false;
    this.saveToDisk();
    return true;
  }
}

export const expenseStore = new ExpenseStore();
