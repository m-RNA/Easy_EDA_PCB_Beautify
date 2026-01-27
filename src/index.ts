/**
 * 入口文件
 *
 * 本文件为默认扩展入口文件，如果你想要配置其它文件作为入口文件，
 * 请修改 `extension.json` 中的 `entry` 字段；
 *
 * 请在此处使用 `export`  导出所有你希望在 `headerMenus` 中引用的方法，
 * 方法通过方法名与 `headerMenus` 关联。
 *
 * 如需了解更多开发细节，请阅读：
 * https://prodocs.lceda.cn/cn/api/guide/
 */

import { smoothRouting as smoothTask, undoLastOperation as undoTask } from './lib/smooth';
import { addTeardrops as teardropTask } from './lib/teardrop';

export function activate(_status?: 'onStartupFinished', _arg?: string): void { }

/**
 * 圆滑布线
 */
export async function smoothRouting() {
	try {
		await smoothTask();
	}
	catch (e: any) {
		console.error('Smooth Routing Error:', e);
		if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
			eda.sys_Log.add(
				e.message || 'Unknown error in smoothRouting',
				'error' as any,
			);
		}
		if (
			eda.sys_Dialog
			&& typeof eda.sys_Dialog.showInformationMessage === 'function'
		) {
			eda.sys_Dialog.showInformationMessage(
				e.message || 'Error',
				'Smooth Error',
			);
		}
	}
}

/**
 * 撤销操作
 */
export async function undoSmooth() {
	try {
		await undoTask();
	}
	catch (e: any) {
		console.error('Undo Error:', e);
		if (eda.sys_Log)
			eda.sys_Log.add(e.message, 'error' as any);
	}
}

/**
 * 生成泪滴
 */
export async function addTeardrops() {
	try {
		await teardropTask();
	}
	catch (e: any) {
		console.error('Add Teardrops Error:', e);
		if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
			eda.sys_Log.add(
				e.message || 'Unknown error in addTeardrops',
				'error' as any,
			);
		}
		if (
			eda.sys_Dialog
			&& typeof eda.sys_Dialog.showInformationMessage === 'function'
		) {
			eda.sys_Dialog.showInformationMessage(
				e.message || 'Error',
				'Teardrop Error',
			);
		}
	}
}

/**
 * 打开设置
 */
export async function openSettings() {
	// 使用内联框架打开设置窗口
	// 窗口尺寸：宽度 540px，高度 600px
	eda.sys_IFrame.openIFrame('/iframe/settings.html', 540, 600, 'settings');
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('圆滑布线 & 泪滴工具'),
		eda.sys_I18n.text('About'),
	);
}
