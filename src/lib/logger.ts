/**
 * 调试日志工具
 * 使用 eda.sys_Log 来输出日志信息
 */

/**
 * 日志类型
 */
type LogType = 'info' | 'warning' | 'error';

/**
 * 添加日志
 * @param message - 日志消息
 * @param type - 日志类型
 */
export function log(message: string, type: LogType = 'info'): void {
	if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
		eda.sys_Log.add(message, type as any);
	}
}

/**
 * 输出信息日志
 */
export function logInfo(message: string): void {
	log(message, 'info');
}

/**
 * 输出警告日志
 */
export function logWarn(message: string): void {
	log(message, 'warning');
}

/**
 * 输出错误日志
 */
export function logError(message: string): void {
	log(message, 'error');
}

/**
 * 输出调试日志 (用于开发调试)
 * @param messages - 要输出的消息
 */
export function debugLog(...messages: any[]): void {
	const msg = messages.map(m => typeof m === 'object' ? JSON.stringify(m) : String(m)).join(' ');
	log(`[Debug] ${msg}`, 'info');
}
