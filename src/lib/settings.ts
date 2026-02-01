export interface BeautifySettings {
	syncWidthTransition: boolean; // 平滑时同步处理线宽过渡
	widthTransitionRatio: number; // 线宽过渡长度系数
	widthTransitionSegments: number; // 线宽过渡分段数
	cornerRadius: number; // 圆角半径
	mergeShortSegments: boolean; // 是否合并短线段
	unit: 'mm' | 'mil'; // 单位设置
	debug: boolean; // 调试模式
	forceArc: boolean; // 强制生成圆弧 (即使线段太短导致被截断)
}

const DEFAULT_SETTINGS: BeautifySettings = {
	syncWidthTransition: false,
	widthTransitionRatio: 3, // 过渡长度 = 线宽差 * 3
	widthTransitionSegments: 25,
	cornerRadius: 20, // 默认 20mil
	mergeShortSegments: false,
	unit: 'mil',
	debug: false,
	forceArc: true,
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
		return getCachedSettings();
	}
}

/**
 * 同步获取缓存的设置 (不需要 await)
 */
export function getCachedSettings(): BeautifySettings {
	return (eda as any)[SETTINGS_CACHE_KEY] || { ...DEFAULT_SETTINGS };
}

/**
 * 保存设置并更新缓存
 */
export async function saveSettings(settings: BeautifySettings): Promise<void> {
	await eda.sys_Storage.setExtensionAllUserConfigs(settings as any);
	(eda as any)[SETTINGS_CACHE_KEY] = { ...settings };
}
