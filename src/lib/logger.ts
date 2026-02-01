import { getCachedSettings } from './settings';

/**
 * 调试日志工具
 * 使用 eda.sys_Log 来输出日志信息
 */

/**
 * 日志类型
 */
type LogType = 'info' | 'warn' | 'error';

const BASE_PREFIX = 'Beautify';

/**
 * 格式化日志前缀
 * @param scope 可选的作用域 (如 Snapshot, PCB)
 * @param level 可选的级别 (如 Error, Warning)
 */
function getPrefix(scope?: string, level?: string): string {
	let prefix = `[${BASE_PREFIX}`;
	if (scope)
		prefix += `-${scope}`;
	if (level)
		prefix += ` ${level}`;
	prefix += ']';
	return prefix;
}

/**
 * 添加日志
 * @param message - 日志消息
 * @param type - 日志类型 (用于 eda.sys_Log 控制)
 * @param scope - 作用域
 * @param level - 显示在消息中的级别字符串
 */
export function log(message: string, type: LogType = 'info', scope?: string, level?: string): void {
	if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
		const prefix = getPrefix(scope, level);
		eda.sys_Log.add(`${prefix} ${message}`, type as any);
	}
}

/**
 * 输出信息日志
 */
export function logInfo(message: string, scope?: string): void {
	log(message, 'info', scope);
}

/**
 * 输出警告日志
 */
export function logWarn(message: string, scope?: string): void {
	log(message, 'warn', scope, 'Warning');
}

/**
 * 输出错误日志
 */
export function logError(message: string, scope?: string): void {
	log(message, 'error', scope, 'Error');
}

/**
 * 输出调试日志 (用于开发调试)
 * @param messages - 要输出的消息
 */
export function debugLog(messageOrFirst: any, ...messages: any[]): void {
	if (!getCachedSettings().debug)
		return;

	// 处理多参数情况
	let fullMsg = '';
	if (messages.length > 0) {
		const all = [messageOrFirst, ...messages];
		fullMsg = all.map(m => (typeof m === 'object' ? JSON.stringify(m) : String(m))).join(' ');
	}
	else {
		fullMsg = typeof messageOrFirst === 'object' ? JSON.stringify(messageOrFirst) : String(messageOrFirst);
	}

	log(fullMsg, 'info', undefined, 'Debug');
}

/**
 * 输出调试警告 (仅在调试模式下输出警告)
 */
export function debugWarn(message: string, scope?: string): void {
	if (!getCachedSettings().debug)
		return;
	log(message, 'warn', scope, 'Warning');
}
