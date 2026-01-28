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
import * as Snapshot from './lib/snapshot';
import { addWidthTransitionsAll, addWidthTransitionsSelected } from './lib/widthTransition';

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	// 将快照功能挂载到 eda 全局对象，供 settings.html 调用
	(eda as any).jlc_eda_smooth_snapshot = Snapshot;
}

/**
 * 圆滑所选布线
 */
export async function smoothSelected() {
	try {
		await smoothTask('selected');
	}
	catch (e: any) {
		handleError(e);
	}
}

/**
 * 圆滑所有布线
 */
export async function smoothAll() {
	try {
		await smoothTask('all');
	}
	catch (e: any) {
		handleError(e);
	}
}

function handleError(e: any) {
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
 * 线宽过渡 - 所选
 */
export async function widthTransitionSelected() {
	try {
		await addWidthTransitionsSelected();
	}
	catch (e: any) {
		console.error('Width Transition Error:', e);
		if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
			eda.sys_Log.add(
				e.message || 'Unknown error in widthTransition',
				'error' as any,
			);
		}
		if (
			eda.sys_Dialog
			&& typeof eda.sys_Dialog.showInformationMessage === 'function'
		) {
			eda.sys_Dialog.showInformationMessage(
				e.message || 'Error',
				'Width Transition Error',
			);
		}
	}
}

/**
 * 线宽过渡 - 所有
 */
export async function widthTransitionAll() {
	try {
		await addWidthTransitionsAll();
		eda.sys_Message?.showToastMessage(eda.sys_I18n ? eda.sys_I18n.text('线宽过渡完成') : '线宽过渡完成');
	}
	catch (e: any) {
		console.error('Width Transition Error:', e);
		if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
			eda.sys_Log.add(
				e.message || 'Unknown error in widthTransition',
				'error' as any,
			);
		}
		if (
			eda.sys_Dialog
			&& typeof eda.sys_Dialog.showInformationMessage === 'function'
		) {
			eda.sys_Dialog.showInformationMessage(
				e.message || 'Error',
				'Width Transition Error',
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
	eda.sys_IFrame.openIFrame('/iframe/settings.html', 420, 480, 'settings');
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('圆滑布线 & 线宽过渡工具'),
		eda.sys_I18n.text('About'),
	);
}
