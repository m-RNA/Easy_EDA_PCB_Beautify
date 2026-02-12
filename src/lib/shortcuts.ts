import { debugLog, debugWarn } from './logger';
import { getCachedSettings } from './settings';

type ShortcutCallback = () => Promise<void> | void;

interface ShortcutHandlers {
	beautifySelected: ShortcutCallback;
	beautifyAll: ShortcutCallback;
	widthTransitionSelected: ShortcutCallback;
	widthTransitionAll: ShortcutCallback;
	undoOperation: ShortcutCallback;
	createManualSnapshot: ShortcutCallback;
}

let lastRegisteredShortcuts: string[][] = [];

export async function initShortcuts(handlers: ShortcutHandlers): Promise<void> {
	const normalizeKeyToken = (key: string): string => {
		const token = (key || '').trim().toUpperCase();
		if (!token)
			return '';

		switch (token) {
			case 'CTRL':
			case 'CONTROL':
				return 'CONTROL';
			case 'ALT':
				return 'ALT';
			case 'SHIFT':
				return 'SHIFT';
			case 'CMD':
			case 'COMMAND':
				return 'COMMAND';
			case 'WIN':
			case 'META':
			case 'SUPER':
				return 'WIN';
			case 'SPACEBAR':
			case 'SPACE':
				return 'SPACE';
			case 'TAB':
				return 'TAB';
			default:
				// 其他如 A-Z, 0-9, F1-F12 以及符号等直接返回
				return token;
		}
	};

	const normalizeShortcutKeys = (keys: string[]): string[] =>
		(keys || []).map((k: string) => normalizeKeyToken(k)).filter((k: string) => !!k);

	const toKeySignature = (keys: string[]): string =>
		normalizeShortcutKeys(keys).sort().join('+');

	if (lastRegisteredShortcuts.length > 0) {
		for (const keys of lastRegisteredShortcuts) {
			try {
				await (eda.sys_ShortcutKey as any).unregisterShortcutKey(normalizeShortcutKeys(keys));
			}
			catch {
				// ignore
			}
		}
		lastRegisteredShortcuts = [];
	}

	const settings = getCachedSettings();
	const rawShortcutConfigs = (settings as any).shortcutKeys || {};
	const shortcutConfigs = {
		beautifySelected: rawShortcutConfigs.beautifySelected ?? ['SHIFT', 'Q'],
		beautifyAll: rawShortcutConfigs.beautifyAll ?? ['CONTROL', 'SHIFT', 'Q'],
		widthTransitionSelected: rawShortcutConfigs.widthTransitionSelected ?? [],
		widthTransitionAll: rawShortcutConfigs.widthTransitionAll ?? [],
		undo: rawShortcutConfigs.undo ?? ['CONTROL', 'SHIFT', 'Z'],
		createSnapshot: rawShortcutConfigs.createSnapshot ?? [],
	};

	const existingShortcuts = await eda.sys_ShortcutKey.getShortcutKeys(true);
	const conflicts: string[] = [];
	const conflictItemKeys = new Set<string>();
	let hasConflict = false;

	const checkConflict = (keys: string[], currentTitle: string) => {
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			return null;
		const keyStr = toKeySignature(keys);
		if (!keyStr)
			return null;
		return existingShortcuts.find((s) => {
			const sKeyStr = toKeySignature(s.shortcutKey as string[]);
			if (sKeyStr === keyStr) {
				if (s.title !== currentTitle) {
					const isSelf = s.title.includes('圆滑')
						|| s.title.includes('过渡')
						|| s.title.includes('撤销')
						|| s.title.includes('快照');
					if (!isSelf)
						return s;
				}
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

		const conflict = checkConflict(keys, item.title);
		if (conflict) {
			const conflictName = conflict.title || '系统功能';
			conflicts.push(`与 "${conflictName}" 冲突`);
			conflictItemKeys.add(item.key);
			hasConflict = true;
		}
	}

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
			debugWarn('Conflict detected but no confirmation dialog API, skip binding conflicting shortcuts');
		}

		if (!bindConflicts) {
			for (const item of items) {
				if (conflictItemKeys.has(item.key))
					(shortcutConfigs as any)[item.key] = [];
			}
			settings.shortcutKeys = shortcutConfigs;
			await eda.sys_Storage.setExtensionAllUserConfigs(settings);
			debugWarn('Conflicting shortcuts cleared by user choice');
		}
	}

	for (const item of items) {
		const keys = normalizeShortcutKeys((shortcutConfigs as any)[item.key]);
		if (!keys || keys.length === 0 || (keys.length === 1 && !keys[0]))
			continue;

		if (!bindConflicts && conflictItemKeys.has(item.key)) {
			debugWarn(`Skip conflicted shortcut by user choice: [${keys.join('+')}] -> ${item.title}`);
			continue;
		}

		const success = await eda.sys_ShortcutKey.registerShortcutKey(
			keys as any,
			item.title,
			async () => {
				debugLog(`[Smooth] shortcut callback triggered: ${item.title}`);
				await item.callback();
			},
			[4],
			[1, 2, 3, 4, 5, 6],
		);

		if (success) {
			lastRegisteredShortcuts.push(keys);
			debugLog(`Shortcut bound: [${keys.join('+')}] -> ${item.title}`);
		}
	}
}
