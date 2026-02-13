import { debugLog, logWarn } from './logger';
import { getCachedSettings } from './settings';

const SCOPE = 'Shortcuts';

type ShortcutCallback = () => Promise<void> | void;

interface ShortcutHandlers {
	beautifySelected: ShortcutCallback;
	beautifyAll: ShortcutCallback;
	widthTransitionSelected: ShortcutCallback;
	widthTransitionAll: ShortcutCallback;
	undoOperation: ShortcutCallback;
	createManualSnapshot: ShortcutCallback;
}

// 本扩展注册的所有快捷键标题（用于精确识别自身快捷键）
const OUR_SHORTCUT_TITLES = new Set([
	'圆滑布线（选中）',
	'圆滑布线（全部）',
	'过渡线宽（选中）',
	'过渡线宽（全部）',
	'撤销',
	'创建手动快照',
]);

/**
 * 规范化按键名称，使其与 EDA 运行时期望的格式一致。
 *
 * 重要发现（2026-02-13）：尽管 TSYS_ShortcutKeys 类型定义全部使用大写
 * （如 'SHIFT', 'CONTROL'），但 EDA 运行时实际要求：
 *   - 修饰键：Title Case（Shift, Ctrl, Alt, Cmd, Win）
 *   - 字母键：大写（Q, W, Z 等）
 *   - F 键 / 特殊键：大写（F9, SPACE, TAB 等）
 *
 * 全大写的修饰键（'SHIFT', 'CONTROL'）注册时返回 OK，但回调永远不会触发。
 * 此函数的输出必须与 settings.html 中 toFriendlyKey() 的输出保持一致。
 */
function normalizeKeyToken(key: string): string {
	const token = (key || '').trim();
	if (!token)
		return '';

	const upper = token.toUpperCase();
	switch (upper) {
		// 修饰键 → Title Case（EDA 运行时必须）
		case 'CTRL':
		case 'CONTROL':
			return 'Ctrl';
		case 'ALT':
			return 'Alt';
		case 'SHIFT':
			return 'Shift';
		case 'CMD':
		case 'COMMAND':
			return 'Cmd';
		case 'WIN':
		case 'META':
		case 'SUPER':
			return 'Win';
		// 方向键 → 大写
		case 'ARROWUP':
		case 'UP':
			return 'UP';
		case 'ARROWDOWN':
		case 'DOWN':
			return 'DOWN';
		case 'ARROWLEFT':
		case 'LEFT':
			return 'LEFT';
		case 'ARROWRIGHT':
		case 'RIGHT':
			return 'RIGHT';
		// 其它特殊键 → 大写
		case 'SPACEBAR':
		case 'SPACE':
			return 'SPACE';
		case 'TAB':
			return 'TAB';
		// 字母、数字、F 键等 → 大写
		default:
			return upper;
	}
}

function normalizeShortcutKeys(keys: string[]): string[] {
	return (keys || []).map((k: string) => normalizeKeyToken(k)).filter((k: string) => !!k);
}

function toKeySignature(keys: string[]): string {
	return normalizeShortcutKeys(keys).sort().join('+');
}

/**
 * 反注册本扩展注册的所有快捷键。
 * 使用 getShortcutKeys(false) 获取本扩展注册的全部快捷键（不含系统内置），然后全部反注册。
 * 这样可以清除测试残留、旧版本注册等任何本扩展留下的快捷键。
 */
async function unregisterOurShortcuts(): Promise<void> {
	try {
		const existingShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(false);
		if (existingShortcuts.length > 0) {
			debugLog(`Cleaning up ${existingShortcuts.length} extension shortcuts`, SCOPE);
		}
		for (const s of existingShortcuts) {
			try {
				await eda.sys_ShortcutKey.unregisterShortcutKey(s.shortcutKey as any);
			}
			catch { /* ignore */ }
		}
	}
	catch (e: any) {
		logWarn(`Failed to unregister shortcuts: ${e.message || e}`, SCOPE);
	}
}

/**
 * 手动清除本扩展注册的所有快捷键（供设置页面按钮调用）。
 * 返回清除的快捷键数量。
 */
export async function clearAllExtensionShortcuts(): Promise<number> {
	try {
		const existingShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(false);
		let count = 0;
		for (const s of existingShortcuts) {
			try {
				await eda.sys_ShortcutKey.unregisterShortcutKey(s.shortcutKey as any);
				count++;
			}
			catch { /* ignore */ }
		}
		debugLog(`Cleared ${count}/${existingShortcuts.length} extension shortcuts`, SCOPE);
		return count;
	}
	catch (e: any) {
		logWarn(`clearAllExtensionShortcuts failed: ${e?.message || e}`, SCOPE);
		return -1;
	}
}

export async function initShortcuts(handlers: ShortcutHandlers): Promise<void> {
	// 1. 反注册本扩展此前注册的所有快捷键
	await unregisterOurShortcuts();

	// 2. 读取快捷键配置
	const settings = getCachedSettings();
	const rawShortcutConfigs = (settings as any).shortcutKeys || {};
	const shortcutConfigs = {
		beautifySelected: rawShortcutConfigs.beautifySelected ?? ['Shift', 'Q'],
		beautifyAll: rawShortcutConfigs.beautifyAll ?? ['Ctrl', 'Shift', 'Q'],
		widthTransitionSelected: rawShortcutConfigs.widthTransitionSelected ?? [],
		widthTransitionAll: rawShortcutConfigs.widthTransitionAll ?? [],
		undo: rawShortcutConfigs.undo ?? ['Ctrl', 'Shift', 'Z'],
		createSnapshot: rawShortcutConfigs.createSnapshot ?? [],
	};

	// 3. 查询所有已注册快捷键（含系统），检测冲突
	const existingShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(true);

	const conflicts: string[] = [];
	const conflictItemKeys = new Set<string>();
	const conflictShortcutKeys = new Map<string, any[]>();
	let hasConflict = false;

	const checkConflict = (keys: string[]) => {
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			return null;
		const keyStr = toKeySignature(keys);
		if (!keyStr)
			return null;
		return existingShortcuts.find((s) => {
			const sKeyStr = toKeySignature(s.shortcutKey as string[]);
			if (sKeyStr === keyStr) {
				return true;
			}
			return false;
		});
	};

	const items = [
		{ key: 'beautifySelected', title: '圆滑布线（选中）', callback: handlers.beautifySelected },
		{ key: 'beautifyAll', title: '圆滑布线（全部）', callback: handlers.beautifyAll },
		{ key: 'widthTransitionSelected', title: '过渡线宽（选中）', callback: handlers.widthTransitionSelected },
		{ key: 'widthTransitionAll', title: '过渡线宽（全部）', callback: handlers.widthTransitionAll },
		{ key: 'undo', title: '撤销', callback: handlers.undoOperation },
		{ key: 'createSnapshot', title: '创建手动快照', callback: handlers.createManualSnapshot },
	];

	for (const item of items) {
		const keys = normalizeShortcutKeys((shortcutConfigs as any)[item.key]);
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			continue;

		(shortcutConfigs as any)[item.key] = keys;

		const conflict = checkConflict(keys);
		if (conflict) {
			const conflictName = conflict.title || '系统功能';
			conflicts.push(`「${keys.join('+')}」与 "${conflictName}" 冲突`);
			conflictItemKeys.add(item.key);
			conflictShortcutKeys.set(item.key, conflict.shortcutKey as any);
			hasConflict = true;
		}
	}

	// 4. 如果有冲突，询问用户是否继续绑定
	let bindConflicts = true;
	if (hasConflict) {
		if (eda.sys_Dialog && typeof eda.sys_Dialog.showConfirmationMessage === 'function') {
			const msg = `${conflicts.join('\n')}\n\n是否继续绑定？`;
			bindConflicts = await new Promise<boolean>((resolve) => {
				eda.sys_Dialog.showConfirmationMessage(
					msg,
					'检测到快捷键冲突',
					undefined,
					undefined,
					(ok: boolean) => resolve(ok),
				);
			});
		}
		else {
			bindConflicts = false;
		}

		if (!bindConflicts) {
			// 用户选择取消：清空冲突项配置
			for (const item of items) {
				if (conflictItemKeys.has(item.key))
					(shortcutConfigs as any)[item.key] = [];
			}
			try {
				const existingConfigs = await eda.sys_Storage.getExtensionAllUserConfigs() || {};
				await eda.sys_Storage.setExtensionAllUserConfigs({
					...existingConfigs,
					shortcutKeys: shortcutConfigs,
				});
			}
			catch { /* ignore */ }
			debugLog('Conflicting shortcuts cleared by user choice', SCOPE);
		}
		else {
			// 用户选择继续绑定：先反注册冲突方的快捷键
			for (const [, conflictKeys] of conflictShortcutKeys) {
				try {
					await eda.sys_ShortcutKey.unregisterShortcutKey(conflictKeys as any);
				}
				catch { /* ignore */ }
			}
		}
	}

	// 5. 注册快捷键
	let registered = 0;
	for (const item of items) {
		const keys = normalizeShortcutKeys((shortcutConfigs as any)[item.key]);
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			continue;

		if (!bindConflicts && conflictItemKeys.has(item.key))
			continue;

		const currentCallback = item.callback;
		const currentTitle = item.title;
		const currentKeys = [...keys];

		const callbackFn = async (_shortcutKey: any) => {
			debugLog(`Shortcut triggered: [${currentKeys.join('+')}] "${currentTitle}"`, SCOPE);
			try {
				await currentCallback();
			}
			catch (err: any) {
				logWarn(`Callback error for "${currentTitle}": ${err?.message || err}`, SCOPE);
			}
		};

		const success = await eda.sys_ShortcutKey.registerShortcutKey(
			keys as any,
			item.title,
			callbackFn,
			[4],
			[1, 2, 3, 4, 5, 6],
		);

		if (success) {
			registered++;
		}
		else {
			logWarn(`Failed to register [${keys.join('+')}] "${item.title}"`, SCOPE);
		}
	}

	debugLog(`${registered} shortcuts registered`, SCOPE);
}

/**
 * 诊断快捷键状态（不受 debug 开关限制，直接弹窗显示结果）
 */
export async function diagnoseShortcuts(): Promise<string> {
	const lines: string[] = [];
	lines.push('=== 快捷键诊断报告 ===');
	lines.push('');

	// 1. 读取存储中的原始配置
	try {
		const allConfigs = await eda.sys_Storage.getExtensionAllUserConfigs() || {};
		const raw = allConfigs.shortcutKeys || '(无)';
		lines.push('【存储中的 shortcutKeys】');
		lines.push(JSON.stringify(raw, null, 2));
	}
	catch (e: any) {
		lines.push(`读取存储失败: ${e.message || e}`);
	}

	lines.push('');

	// 2. 缓存中的快捷键配置
	const settings = getCachedSettings();
	const cachedKeys = (settings as any).shortcutKeys || '(无)';
	lines.push('【缓存中的 shortcutKeys】');
	lines.push(JSON.stringify(cachedKeys, null, 2));
	lines.push('');

	// 3. 规范化后的键
	const rawConfigs = (settings as any).shortcutKeys || {};
	const configMap: Record<string, string[]> = {
		beautifySelected: rawConfigs.beautifySelected ?? ['Shift', 'Q'],
		beautifyAll: rawConfigs.beautifyAll ?? ['Ctrl', 'Shift', 'Q'],
		widthTransitionSelected: rawConfigs.widthTransitionSelected ?? [],
		widthTransitionAll: rawConfigs.widthTransitionAll ?? [],
		undo: rawConfigs.undo ?? ['Ctrl', 'Shift', 'Z'],
		createSnapshot: rawConfigs.createSnapshot ?? [],
	};

	lines.push('【规范化后（发送给 API 的键）】');
	for (const [name, keys] of Object.entries(configMap)) {
		const normalized = normalizeShortcutKeys(keys);
		lines.push(`  ${name}: [${keys.join(', ')}] → [${normalized.join(', ')}]`);
	}
	lines.push('');

	// 4. 查询系统中已注册的快捷键
	try {
		// 分别获取：扩展快捷键(false) 和 全部快捷键(true)
		const extensionShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(false);
		const allShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(true);

		// 从扩展快捷键中筛出本扩展的（通过标题匹配）
		const ours = extensionShortcuts.filter(s => OUR_SHORTCUT_TITLES.has(s.title));
		const otherExtensions = extensionShortcuts.filter(s => !OUR_SHORTCUT_TITLES.has(s.title));

		// 系统内置快捷键 = 全部 - 扩展
		const extKeySet = new Set(extensionShortcuts.map(s => (s.shortcutKey as string[]).sort().join('+')));
		const systemShortcuts = allShortcuts.filter(s => !extKeySet.has((s.shortcutKey as string[]).sort().join('+')));

		lines.push(`【快捷键统计】全部 ${allShortcuts.length} 个 = 系统 ${systemShortcuts.length} + 扩展 ${extensionShortcuts.length}(本扩展 ${ours.length} + 其它扩展 ${otherExtensions.length})`);
		lines.push('');
		lines.push(`  本扩展 (${ours.length} 个):`);
		if (ours.length === 0) {
			lines.push('    (无 — 未注册成功!)');
		}
		for (const s of ours) {
			lines.push(`    [${(s.shortcutKey as string[]).join('+')}] "${s.title}"`);
		}
		lines.push('');
		lines.push(`  其它扩展 (${otherExtensions.length} 个):`);
		for (const s of otherExtensions) {
			lines.push(`    [${(s.shortcutKey as string[]).join('+')}] "${s.title}"`);
		}
		lines.push('');
		lines.push(`  系统内置 (${systemShortcuts.length} 个):`);
		for (const s of systemShortcuts) {
			lines.push(`    [${(s.shortcutKey as string[]).join('+')}] "${s.title}"`);
		}
	}
	catch (e: any) {
		lines.push(`查询快捷键失败: ${e.message || e}`);
	}

	const report = lines.join('\n');
	debugLog(report, SCOPE);
	return report;
}
