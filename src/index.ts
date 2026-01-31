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

import { logError, logInfo, logWarn } from './lib/logger';
import { getDefaultSettings, getSettings } from './lib/settings';
import { smoothRouting as smoothTask } from './lib/smooth';
import { undoLastOperation as undoTask } from './lib/snapshot';
import * as Snapshot from './lib/snapshot';
import { addWidthTransitionsAll, addWidthTransitionsSelected } from './lib/widthTransition';

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	// 初始化设置（加载到缓存）
	getSettings();

	// 将功能挂载到 eda 全局对象，供 settings.html 调用
	(eda as any).jlc_eda_smooth_snapshot = Snapshot;
	(eda as any).jlc_eda_smooth_refreshSettings = getSettings;
	(eda as any).jlc_eda_smooth_getDefaultSettings = getDefaultSettings;

	// 动态刷新顶部菜单，确保菜单正确显示
	try {
		if (eda.sys_HeaderMenu && typeof eda.sys_HeaderMenu.replaceHeaderMenus === 'function') {
			eda.sys_HeaderMenu.replaceHeaderMenus({
				pcb: [
					{
						id: 'MeltPCB',
						title: eda.sys_I18n ? eda.sys_I18n.text('美化PCB') : '美化PCB',
						menuItems: [
							{
								id: 'SmoothSelected',
								title: eda.sys_I18n ? eda.sys_I18n.text('圆滑布线（选中）') : '圆滑布线（选中）',
								registerFn: 'smoothSelected',
							},
							{
								id: 'SmoothAll',
								title: eda.sys_I18n ? eda.sys_I18n.text('圆滑布线（全部）') : '圆滑布线（全部）',
								registerFn: 'smoothAll',
							},
							{
								id: 'WidthSelected',
								title: eda.sys_I18n ? eda.sys_I18n.text('过渡线宽（选中）') : '过渡线宽（选中）',
								registerFn: 'widthTransitionSelected',
							},
							{
								id: 'WidthAll',
								title: eda.sys_I18n ? eda.sys_I18n.text('过渡线宽（全部）') : '过渡线宽（全部）',
								registerFn: 'widthTransitionAll',
							},
							{
								id: 'Undo',
								title: eda.sys_I18n ? eda.sys_I18n.text('撤销') : '撤销',
								registerFn: 'undoOperation',
							},
							{
								id: 'Settings',
								title: eda.sys_I18n ? eda.sys_I18n.text('设置') : '设置',
								registerFn: 'openSettings',
							},
						],
					},
				],
			});
			logInfo('[EASY-EDA-Smooth] Header menus registered successfully');
		}
		else {
			logWarn('[EASY-EDA-Smooth] sys_HeaderMenu not available');
		}
	}
	catch (e: any) {
		logWarn(`[EASY-EDA-Smooth] Failed to register header menus dynamically: ${e.message || e}`);
	}
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
	logError(`Smooth Routing Error: ${e.message || e}`);
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
export async function undoOperation() {
	try {
		await undoTask();
	}
	catch (e: any) {
		logError(`Undo Error: ${e.message || e}`);
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
		logError(`Width Transition Error: ${e.message || e}`);
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
		logError(`Width Transition Error: ${e.message || e}`);
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
	eda.sys_IFrame.openIFrame('/iframe/settings.html', 540, 600, 'settings');
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('圆滑布线 & 线宽过渡工具'),
		eda.sys_I18n.text('About'),
	);
}
