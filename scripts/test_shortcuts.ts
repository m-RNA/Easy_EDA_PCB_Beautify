import assert from 'node:assert/strict';
import process from 'node:process';
import { getDefaultSettings, getSettings } from '../src/lib/settings';
import { initShortcuts, normalizeShortcutKeys } from '../src/lib/shortcuts';

async function main() {
	const defaults = getDefaultSettings();

	assert.deepEqual(defaults.shortcutKeys.beautifySelected, ['F6']);
	assert.deepEqual(defaults.shortcutKeys.beautifyAll, ['F9']);
	assert.deepEqual(defaults.shortcutKeys.undo, ['Ctrl', 'Shift', 'Z']);

	assert.deepEqual(normalizeShortcutKeys(['SHIFT', 'q']), ['Shift', 'Q']);
	assert.deepEqual(normalizeShortcutKeys(['CONTROL', 'SHIFT', 'q']), ['Ctrl', 'Shift', 'Q']);
	assert.deepEqual(normalizeShortcutKeys(['Control', 'shift', 'z']), ['Ctrl', 'Shift', 'Z']);

	const active: any[] = [];
	const systemShortcuts: any[] = [];
	let registerCalls = 0;
	let unregisterCalls = 0;
	let conflictMessages = 0;
	let storedConfig: Record<string, any> = {
		shortcutKeys: {
			beautifySelected: ['Shift', 'Q'],
			beautifyAll: ['Ctrl', 'Shift', 'Q'],
			undo: ['Ctrl', 'Shift', 'Z'],
		},
	};
	(globalThis as any).eda = {
		sys_Log: { add: () => undefined },
		sys_ShortcutKey: {
			getShortcutKeys: async (includeSystem: boolean) => includeSystem ? [...active, ...systemShortcuts] : [...active],
			unregisterShortcutKey: async (keys: string[]) => {
				unregisterCalls++;
				const signature = [...keys].sort().join('+');
				const index = active.findIndex(item => [...item.shortcutKey].sort().join('+') === signature);
				if (index >= 0)
					active.splice(index, 1);
				return true;
			},
			registerShortcutKey: async (shortcutKey: string[], title: string, callbackFn: () => Promise<void>) => {
				registerCalls++;
				active.push({ shortcutKey, title, callbackFn });
				return true;
			},
		},
		sys_Dialog: {
			showInformationMessage: () => {
				conflictMessages++;
			},
		},
		sys_Storage: {
			getExtensionAllUserConfigs: async () => storedConfig,
			setExtensionAllUserConfigs: async (config: Record<string, any>) => {
				storedConfig = structuredClone(config);
				return true;
			},
		},
	};
	await getSettings();
	assert.deepEqual(storedConfig.shortcutKeys.beautifySelected, ['F6'], '应迁移旧版选中圆滑默认键');
	assert.deepEqual(storedConfig.shortcutKeys.beautifyAll, ['F9'], '应迁移旧版全部圆滑默认键');
	assert.deepEqual(storedConfig.shortcutKeys.undo, ['Ctrl', 'Shift', 'Z'], '迁移不应改动撤销键');
	storedConfig.shortcutKeys.beautifySelected = ['Shift', 'F9'];
	await getSettings();
	assert.deepEqual(storedConfig.shortcutKeys.beautifySelected, ['F6'], '应迁移宿主无法区分的 Shift+F键默认键');
	storedConfig.shortcutKeys.beautifySelected = ['Shift', 'F6'];
	await getSettings();
	assert.deepEqual(storedConfig.shortcutKeys.beautifySelected, ['F6'], '应迁移上一调试版的 Shift+F6 默认键');
	let beautifyAllCalls = 0;
	const handlers = {
		beautifySelected: async () => undefined,
		beautifyAll: async () => { beautifyAllCalls++; },
		widthTransitionSelected: async () => undefined,
		widthTransitionAll: async () => undefined,
		undoOperation: async () => undefined,
		createManualSnapshot: async () => undefined,
	};
	await initShortcuts(handlers);
	assert.equal(registerCalls, 3, '默认应注册三个快捷键');
	assert.equal(unregisterCalls, 0, '首次注册不应执行无意义注销');
	assert.deepEqual(active.map(item => item.shortcutKey), [
		['F6'],
		['F9'],
		['Ctrl', 'Shift', 'Z'],
	]);
	await active[1].callbackFn();
	assert.equal(beautifyAllCalls, 1, '宿主保存的快捷键回调应调用最新处理器');

	await initShortcuts({
		...handlers,
		beautifyAll: async () => {
			beautifyAllCalls += 10;
		},
	});
	assert.equal(registerCalls, 3, '设置未变化时不应重复注册快捷键');
	assert.equal(unregisterCalls, 0, '设置未变化时不应注销仍有效的快捷键');
	await active[1].callbackFn();
	assert.equal(beautifyAllCalls, 11, '保留的全局回调应转发到最新处理器');

	storedConfig.shortcutKeys.beautifyAll = ['F8'];
	systemShortcuts.push({ shortcutKey: ['F8'], title: '宿主功能' });
	await getSettings();
	await initShortcuts(handlers);
	assert.equal(conflictMessages, 1, '快捷键冲突时应明确提醒用户');
	assert.equal(active.some(item => item.shortcutKey.join('+') === 'F8'), false, '不得覆盖宿主快捷键');
	assert.equal(storedConfig.shortcutKeys.beautifyAll.join('+'), 'F8', '冲突时应保留用户配置以便修改');
	const registerCallsAfterConflict = registerCalls;
	await initShortcuts(handlers);
	assert.equal(conflictMessages, 1, '未修改配置时不应重复弹出冲突提醒');
	assert.equal(registerCalls, registerCallsAfterConflict, '未修改配置时不应重复注册非冲突快捷键');

	systemShortcuts.length = 0;
	storedConfig.shortcutKeys.beautifySelected = ['Shift', 'F7'];
	storedConfig.shortcutKeys.beautifyAll = ['F7'];
	await getSettings();
	await initShortcuts(handlers);
	assert.equal(conflictMessages, 2, '基础键与修饰组合重叠时应提醒用户');
	assert.equal(active.some(item => item.shortcutKey.join('+') === 'Shift+F7'), false, '不得注册宿主无法区分的修饰组合');
	assert.equal(active.some(item => item.shortcutKey.join('+') === 'F7'), true, '基础键功能仍应正常注册');

	console.log('shortcut runtime format and lifecycle tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
