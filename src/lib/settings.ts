export interface BeautifySettings {
	syncWidthTransition: boolean; // 平滑时同步处理线宽过渡
	widthTransitionRatio: number; // 线宽过渡长度系数 (长度 = 线宽差值 * 比率)
	widthTransitionSegments: number; // 线宽过渡分段数
	widthTransitionBalance: number; // 过渡区位置平衡 0-100%: 0=全部向窄线, 100=全部向宽线
	cornerRadiusRatio: number; // 圆角半径与线宽的比率 (半径 = 线宽 * 比率)
	protectPadAndViaNodes: boolean; // 保护焊盘和过孔中心节点，避免圆滑后断连
	protectDifferentialAndEqualLength: boolean; // 保护差分对/等长组，使用同心圆弧或保守跳过
	debug: boolean; // 调试模式
	forceArc: boolean; // 强制生成圆弧 (即使线段太短导致被截断)
	enableDRC: boolean; // 启用 DRC 检查
	drcIgnoreCopperPour: boolean; // DRC 忽略覆铜相关规则
	rebuildCopperPourAfterBeautify: boolean; // 操作完成后智能重铺相关覆铜区域
	copperPourRebuildLimit: number; // 自动重铺覆铜区域数量上限
	drcRetryCount: number; // DRC 失败最大重试次数 (控制二分法的深度)
	cardOrder: string[]; // 设置界面的卡片排序顺序
	collapsedStates: Record<string, boolean>; // 卡片折叠状态
	shortcutKeys: {
		beautifySelected: string[];
		beautifyAll: string[];
		widthTransitionSelected: string[];
		widthTransitionAll: string[];
		undo: string[];
		createSnapshot: string[];
	};
}

const DEFAULT_SETTINGS: BeautifySettings = {
	syncWidthTransition: false,
	widthTransitionRatio: 5.0, // 过渡长度 = 线宽差 * 5
	widthTransitionSegments: 25,
	widthTransitionBalance: 50, // 中间位置= 50%
	cornerRadiusRatio: 5.0, // 默认半径是线宽的5倍
	protectPadAndViaNodes: true,
	protectDifferentialAndEqualLength: true,
	debug: false,
	forceArc: true,
	enableDRC: true,
	drcIgnoreCopperPour: true, // 默认忽略覆铜规则（覆铜重铺后通常会自动解决）
	rebuildCopperPourAfterBeautify: true, // 默认在操作完成后智能重铺相关覆铜区域
	copperPourRebuildLimit: 10,
	drcRetryCount: 4, // 4次二分法 (100% -> 50% -> 25% -> 12.5% -> 直角)
	cardOrder: ['card-transition', 'card-drc', 'card-shortcut', 'card-advanced', 'card-snapshot'],
	collapsedStates: {
		'card-drc': true, // 默认收起DRC设置
		'card-shortcut': true, // 默认收起快捷键设置
		'card-advanced': true, // 默认收起高级设置
	},
	shortcutKeys: {
		beautifySelected: ['F6'],
		beautifyAll: ['F9'],
		widthTransitionSelected: [],
		widthTransitionAll: [],
		undo: ['Ctrl', 'Shift', 'Z'],
		createSnapshot: [],
	},
};

const SETTINGS_CACHE_KEY = '_jlc_beautify_settings_cache';

/**
 * 获取默认设置
 */
export function getDefaultSettings(): BeautifySettings {
	return { ...DEFAULT_SETTINGS };
}

/**
 * 获取最新设置
 */
export async function getSettings(): Promise<BeautifySettings> {
	try {
		const configs = await eda.sys_Storage.getExtensionAllUserConfigs();
		const shortcutKeys = configs?.shortcutKeys;
		const keySignature = (keys: unknown) => Array.isArray(keys)
			? keys.map(key => String(key).trim().toUpperCase().replace('CONTROL', 'CTRL')).sort().join('+')
			: '';
		const usesLegacyQDefaults = shortcutKeys
			&& keySignature(shortcutKeys.beautifySelected) === 'Q+SHIFT'
			&& keySignature(shortcutKeys.beautifyAll) === 'CTRL+Q+SHIFT';
		const previousSelectedSignature = shortcutKeys && keySignature(shortcutKeys.beautifySelected);
		const usesPreviousFKeyDefaults = shortcutKeys
			&& (previousSelectedSignature === 'F9+SHIFT' || previousSelectedSignature === 'F6+SHIFT')
			&& keySignature(shortcutKeys.beautifyAll) === 'F9';
		if (usesLegacyQDefaults || usesPreviousFKeyDefaults) {
			configs.shortcutKeys = {
				...shortcutKeys,
				beautifySelected: ['F6'],
				beautifyAll: ['F9'],
			};
			await eda.sys_Storage.setExtensionAllUserConfigs(configs);
		}
		const newSettings = { ...DEFAULT_SETTINGS, ...configs };
		(eda as any)[SETTINGS_CACHE_KEY] = newSettings;
		return newSettings;
	}
	catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * 获取缓存的设置 (同步，仅供非异步场景使用)
 */
export function getCachedSettings(): BeautifySettings {
	return (eda as any)[SETTINGS_CACHE_KEY] || { ...DEFAULT_SETTINGS };
}
