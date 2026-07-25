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

import type { CopperViolationInfo } from './lib/drc';
import { beautifyRouting as beautifyTask } from './lib/beautify';
import { runDrcCheckAndParse } from './lib/drc';
import { rebuildAllCopperPoursIfEnabled } from './lib/eda_utils';
import { debugLog, debugWarn, logError, logPerformance } from './lib/logger';
import { getDefaultSettings, getSettings } from './lib/settings';
import { clearAllExtensionShortcuts, diagnoseShortcuts, initShortcuts } from './lib/shortcuts';
import { undoLastOperation as undoTask } from './lib/snapshot';
import * as Snapshot from './lib/snapshot';
import { addWidthTransitionsAll, addWidthTransitionsSelected } from './lib/widthTransition';

export async function finalizeRoutingOperation(
	cachedCopperViolation?: CopperViolationInfo,
	completionMessage?: string,
): Promise<number> {
	const rebuildResult = await rebuildAllCopperPoursIfEnabled(cachedCopperViolation);
	const settings = await getSettings();
	if (!settings.enableDRC) {
		if (completionMessage)
			eda.sys_Message?.showToastMessage(completionMessage, 'success' as any, 3);
		return rebuildResult;
	}

	eda.sys_Message?.showToastMessage('正在执行最终 DRC 检查...', 'info' as any, 2);
	const drcResult = await runDrcCheckAndParse();
	if (!drcResult.valid) {
		eda.sys_Message?.showToastMessage('操作已完成，但最终 DRC 检查失败，请手动检查', 'warn' as any, 4);
		return rebuildResult;
	}

	debugLog(
		`[FinalDRC] completed violations=${drcResult.violatedIds.size} copper-issues=${drcResult.copperViolation.issueCount}`,
	);
	if (completionMessage) {
		if (drcResult.violatedIds.size > 0) {
			eda.sys_Message?.showToastMessage(
				`${completionMessage}，最终 DRC 仍有 ${drcResult.violatedIds.size} 个违规对象`,
				'warn' as any,
				4,
			);
		}
		else {
			eda.sys_Message?.showToastMessage(completionMessage, 'success' as any, 3);
		}
	}
	return rebuildResult;
}

export async function activate(_status?: 'onStartupFinished', _arg?: string): Promise<void> {
	// 初始化设置（加载到缓存）
	await getSettings();

	let shortcutRefresh = Promise.resolve();
	const refreshShortcuts = async () => {
		shortcutRefresh = shortcutRefresh.catch(() => undefined).then(() => initShortcuts({
			beautifySelected,
			beautifyAll,
			widthTransitionSelected,
			widthTransitionAll,
			undoOperation,
			createManualSnapshot,
		}));
		await shortcutRefresh;
	};

	// 将功能挂载到 eda 全局对象，供 settings.html 调用
	(eda as any).jlc_eda_beautify_snapshot = Snapshot;
	(eda as any).jlc_eda_beautify_runAction = async (action: string) => {
		switch (action) {
			case 'beautifySelected':
				await beautifySelected();
				break;
			case 'beautifyAll':
				await beautifyAll();
				break;
			case 'widthTransitionSelected':
				await widthTransitionSelected();
				break;
			case 'widthTransitionAll':
				await widthTransitionAll();
				break;
			case 'undoOperation':
				await undoOperation();
				break;
			case 'createManualSnapshot':
				await createManualSnapshot();
				break;
			default:
				throw new Error(`Unknown action: ${action}`);
		}
	};
	(eda as any).jlc_eda_beautify_refreshSettings = async () => {
		await getSettings();
		await refreshShortcuts(); // 刷新快捷键
	};
	(eda as any).jlc_eda_beautify_getDefaultSettings = getDefaultSettings;
	(eda as any).jlc_eda_beautify_diagnoseShortcuts = diagnoseShortcuts;
	(eda as any).jlc_eda_beautify_clearShortcuts = clearAllExtensionShortcuts;

	// 注册快捷键
	try {
		await refreshShortcuts();
	}
	catch (e: any) {
		debugWarn(`Shortcut initialization failed: ${e.message || e}`, 'PCB');
	}
}

/**
 * 圆滑所选布线
 */
export async function beautifySelected() {
	debugLog('[Smooth] beautifySelected triggered');
	try {
		const result = await beautifyTask('selected');

		// 重铺覆铜，并在整个美化流程完成后执行最终 DRC
		if (result.completed)
			await finalizeRoutingOperation(result.copperViolation, '圆滑布线（选中）已完成');
	}
	catch (e: any) {
		handleError(e);
	}
}

/**
 * 圆滑所有布线
 */
export async function beautifyAll() {
	debugLog('[Smooth] beautifyAll triggered');
	const perfStartedAt = Date.now();
	try {
		const result = await beautifyTask('all');
		const coreFinishedAt = Date.now();
		let copperDrcSource = 'skipped';

		// 重铺覆铜，并在整个美化流程完成后执行最终 DRC
		if (result.completed) {
			const rebuildResult = await finalizeRoutingOperation(
				result.copperViolation,
				'圆滑布线（全部）已完成',
			);
			copperDrcSource = rebuildResult === -2
				? 'disabled'
				: result.copperViolation !== undefined ? 'reused' : 'fresh';
		}
		logPerformance(
			`[Perf][BeautifyAll] core=${coreFinishedAt - perfStartedAt}ms copper=${Date.now() - coreFinishedAt}ms total=${Date.now() - perfStartedAt}ms copper-drc=${copperDrcSource}`,
		);
	}
	catch (e: any) {
		handleError(e);
	}
}

function handleError(e: any) {
	logError(`Beautify Routing Error: ${e.message || e}`);
	if (
		eda.sys_Dialog
		&& typeof eda.sys_Dialog.showInformationMessage === 'function'
	) {
		eda.sys_Dialog.showInformationMessage(
			e.message || 'Error',
			'Beautify Error',
		);
	}
}

/**
 * 撤销操作
 */
export async function undoOperation() {
	debugLog('[Smooth] undoOperation triggered');
	const perfStartedAt = Date.now();
	try {
		await undoTask();
		logPerformance(`[Perf][Undo] total=${Date.now() - perfStartedAt}ms`);
	}
	catch (e: any) {
		logError(`Undo Error: ${e.message || e}`);
	}
}

/**
 * 线宽过渡 - 所选
 */
export async function widthTransitionSelected() {
	debugLog('[Smooth] widthTransitionSelected triggered');
	try {
		const transitionCount = await addWidthTransitionsSelected();
		if (transitionCount === null)
			return;

		// 重铺覆铜，并在整个操作完成后执行最终 DRC
		await finalizeRoutingOperation(
			undefined,
			`过渡线宽（选中）已完成，处理了 ${transitionCount} 个连接点`,
		);
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
	debugLog('[Smooth] widthTransitionAll triggered');
	try {
		const transitionCount = await addWidthTransitionsAll();
		if (transitionCount === null)
			return;

		// 重铺覆铜，并在整个操作完成后执行最终 DRC
		await finalizeRoutingOperation(
			undefined,
			`过渡线宽（全部）已完成，处理了 ${transitionCount} 个连接点`,
		);
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
 * 创建手动快照
 */
export async function createManualSnapshot() {
	debugLog('[Smooth] createManualSnapshot triggered');
	try {
		const name = '手动快照';
		await Snapshot.createSnapshot(name, true);
		eda.sys_Message?.showToastMessage('快照已创建', 'success' as any, 2);
	}
	catch (e: any) {
		logError(`Create Snapshot Error: ${e.message || e}`);
	}
}

/**
 * 打开设置
 */
export async function openSettings() {
	// 使用内联框架打开设置窗口
	// 窗口尺寸：宽度 540px，高度 700px
	eda.sys_IFrame.openIFrame('/iframe/settings.html', 540, 700, 'settings', {
		minimizeButton: true, // 显示最小化按钮
	});
}
