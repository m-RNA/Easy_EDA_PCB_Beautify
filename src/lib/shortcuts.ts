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

type ShortcutHandlerKey = keyof ShortcutHandlers;

interface ShortcutRuntimeState {
	signature: string;
	handlers: ShortcutHandlers;
	callbacks: Record<string, (shortcutKey: any) => Promise<void>>;
	blockedKeys: string[];
}

const SHORTCUT_RUNTIME_KEY = '_jlc_beautify_shortcut_runtime';

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
export function normalizeKeyToken(key: string): string {
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

export function normalizeShortcutKeys(keys: string[]): string[] {
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
	// 1. 读取快捷键配置
	const settings = getCachedSettings();
	const rawShortcutConfigs = (settings as any).shortcutKeys || {};
	const shortcutConfigs = {
		beautifySelected: rawShortcutConfigs.beautifySelected ?? ['F6'],
		beautifyAll: rawShortcutConfigs.beautifyAll ?? ['F9'],
		widthTransitionSelected: rawShortcutConfigs.widthTransitionSelected ?? [],
		widthTransitionAll: rawShortcutConfigs.widthTransitionAll ?? [],
		undo: rawShortcutConfigs.undo ?? ['Ctrl', 'Shift', 'Z'],
		createSnapshot: rawShortcutConfigs.createSnapshot ?? [],
	};
	const items: Array<{ key: string; title: string; handlerKey: ShortcutHandlerKey }> = [
		{ key: 'beautifySelected', title: '圆滑布线（选中）', handlerKey: 'beautifySelected' },
		{ key: 'beautifyAll', title: '圆滑布线（全部）', handlerKey: 'beautifyAll' },
		{ key: 'widthTransitionSelected', title: '过渡线宽（选中）', handlerKey: 'widthTransitionSelected' },
		{ key: 'widthTransitionAll', title: '过渡线宽（全部）', handlerKey: 'widthTransitionAll' },
		{ key: 'undo', title: '撤销', handlerKey: 'undoOperation' },
		{ key: 'createSnapshot', title: '创建手动快照', handlerKey: 'createManualSnapshot' },
	];
	const desiredBindings = items
		.map(item => ({ ...item, keys: normalizeShortcutKeys((shortcutConfigs as any)[item.key]) }))
		.filter(item => item.keys.length > 0);
	const desiredSignature = JSON.stringify(desiredBindings.map(item => [item.key, toKeySignature(item.keys)]));
	let runtimeState = (eda as any)[SHORTCUT_RUNTIME_KEY] as ShortcutRuntimeState | undefined;
	if (!runtimeState) {
		runtimeState = { signature: '', handlers, callbacks: {}, blockedKeys: [] };
		(eda as any)[SHORTCUT_RUNTIME_KEY] = runtimeState;
	}
	runtimeState.blockedKeys ||= [];
	runtimeState.handlers = handlers;

	// 配置未变化且宿主仍持有全部绑定时，保留原回调，避免设置保存导致回调失效。
	const currentExtensionShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(false);
	const currentSignatures = new Set(currentExtensionShortcuts.map(item => toKeySignature(item.shortcutKey as string[])));
	if (
		runtimeState.signature === desiredSignature
		&& desiredBindings
			.filter(item => !runtimeState.blockedKeys.includes(item.key))
			.every(item => currentSignatures.has(toKeySignature(item.keys)))
	) {
		debugLog(`Shortcut bindings unchanged; keeping ${currentExtensionShortcuts.length} active callbacks`, SCOPE);
		return;
	}

	// 配置变化或宿主丢失绑定时，清理后重新注册。
	await unregisterOurShortcuts();
	runtimeState.callbacks = {};

	// 2. 查询所有已注册快捷键（含系统），检测冲突
	const existingShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(true);

	const conflicts: string[] = [];
	const conflictItemKeys = new Set<string>();
	const modifierKeys = new Set(['Ctrl', 'Shift', 'Alt', 'Cmd', 'Win']);
	for (const binding of desiredBindings) {
		if (binding.keys.includes('Shift') && binding.keys.some(key => /^F(?:[1-9]|1\d|20)$/.test(key))) {
			conflicts.push(`“${binding.title}”使用 ${binding.keys.join('+')}，当前宿主不会向扩展分发 Shift+F键组合`);
			conflictItemKeys.add(binding.key);
		}
	}
	for (let index = 0; index < desiredBindings.length; index++) {
		for (let otherIndex = index + 1; otherIndex < desiredBindings.length; otherIndex++) {
			const first = desiredBindings[index];
			const second = desiredBindings[otherIndex];
			const firstBase = first.keys.filter(key => !modifierKeys.has(key));
			const secondBase = second.keys.filter(key => !modifierKeys.has(key));
			if (firstBase.join('+') !== secondBase.join('+'))
				continue;
			const firstSet = new Set(first.keys);
			const secondSet = new Set(second.keys);
			const overlaps = [...firstSet].every(key => secondSet.has(key)) || [...secondSet].every(key => firstSet.has(key));
			if (!overlaps)
				continue;
			conflicts.push(`“${first.title}”与“${second.title}”共享基础键 ${firstBase.join('+')}，宿主无法区分`);
			conflictItemKeys.add(first.keys.length > second.keys.length ? first.key : second.key);
		}
	}

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

	for (const item of items) {
		const keys = normalizeShortcutKeys((shortcutConfigs as any)[item.key]);
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			continue;

		(shortcutConfigs as any)[item.key] = keys;

		const conflict = checkConflict(keys);
		if (conflict) {
			const conflictName = conflict.title || '系统功能';
			conflicts.push(`「${item.title}」的 ${keys.join('+')} 已被“${conflictName}”占用`);
			conflictItemKeys.add(item.key);
		}
	}

	// 3. 冲突项不覆盖宿主绑定，保留配置并明确提示用户修改。
	if (conflicts.length > 0) {
		const message = `${conflicts.join('\n')}\n\n冲突项未注册，请在“美化PCB → 高级菜单 → 快捷键设置”中修改。`;
		logWarn(message, SCOPE);
		eda.sys_Dialog?.showInformationMessage?.(message, '快捷键冲突');
	}
	runtimeState.blockedKeys = [...conflictItemKeys];

	// 4. 注册快捷键
	let registered = 0;
	for (const item of items) {
		const keys = normalizeShortcutKeys((shortcutConfigs as any)[item.key]);
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			continue;

		if (conflictItemKeys.has(item.key))
			continue;

		const currentTitle = item.title;
		const currentKeys = [...keys];

		const callbackFn = async (_shortcutKey: any) => {
			debugLog(`Shortcut triggered: [${currentKeys.join('+')}] "${currentTitle}"`, SCOPE);
			try {
				await runtimeState.handlers[item.handlerKey]();
			}
			catch (err: any) {
				logWarn(`Callback error for "${currentTitle}": ${err?.message || err}`, SCOPE);
			}
		};
		runtimeState.callbacks[item.key] = callbackFn;

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

	runtimeState.signature = desiredSignature;
	const activeShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(false);
	debugLog(`${registered} shortcuts registered; host reports ${activeShortcuts.length} active: ${activeShortcuts.map(item => `[${(item.shortcutKey as string[]).join('+')}]`).join(', ')}`, SCOPE);
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
		beautifySelected: rawConfigs.beautifySelected ?? ['F6'],
		beautifyAll: rawConfigs.beautifyAll ?? ['F9'],
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
