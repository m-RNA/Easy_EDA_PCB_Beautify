export interface BeautifySettings {
	syncWidthTransition: boolean; // 平滑时同步处理线宽过渡
	widthTransitionRatio: number; // 线宽过渡长度系数 (长度 = 线宽差值 * 比率)
	widthTransitionSegments: number; // 线宽过渡分段数
	widthTransitionBalance: number; // 过渡区位置平衡 0-100%: 0=全部向窄线, 100=全部向宽线
	cornerRadiusRatio: number; // 圆角半径与线宽的比率 (半径 = 线宽 * 比率)
	mergeTransitionSegments: boolean; // 是否合并过渡线段
	debug: boolean; // 调试模式
	forceArc: boolean; // 强制生成圆弧 (即使线段太短导致被截断)
	enableDRC: boolean; // 启用 DRC 检查
	drcRetryCount: number; // DRC 失败最大重试次数 (控制二分法的深度)
	cardOrder: string[]; // 设置界面的卡片排序顺序
	collapsedStates: Record<string, boolean>; // 卡片折叠状态
}

const DEFAULT_SETTINGS: BeautifySettings = {
	syncWidthTransition: false,
	widthTransitionRatio: 3.0, // 过渡长度 = 线宽差 * 3
	widthTransitionSegments: 25,
	widthTransitionBalance: 50, // 中间位置= 50%
	cornerRadiusRatio: 3.0, // 默认半径是线宽的3倍
	mergeTransitionSegments: false,
	debug: false,
	forceArc: true,
	enableDRC: true,
	drcRetryCount: 4, // 4次二分法 (100% -> 50% -> 25% -> 12.5% -> 直角)
	cardOrder: ['card-transition', 'card-drc', 'card-advanced', 'card-snapshot'],
	collapsedStates: {
		'card-advanced': true, // 默认收起高级设置
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
