export interface SmoothSettings {
	replaceOriginal: boolean;
	syncWidthTransition: boolean; // 平滑时同步处理线宽过渡
	smoothRatio: number;
	widthTransitionRatio: number; // 线宽过渡长度系数
	widthTransitionSegments: number; // 线宽过渡分段数
	iterations: number;
	cornerRadius: number;
	mergeShortSegments: boolean; // 是否合并短线段
	unit: 'mm' | 'mil'; // 单位设置
	debug: boolean; // 调试模式
}

const DEFAULT_SETTINGS: SmoothSettings = {
	replaceOriginal: true,
	syncWidthTransition: false,
	smoothRatio: 0.2,
	widthTransitionRatio: 1.5, // 过渡长度 = 最大线宽 * 1.5
	widthTransitionSegments: 5,
	iterations: 1,
	cornerRadius: 25.4, // 默认 25.4mm (1000mil)
	mergeShortSegments: true,
	unit: 'mil',
	debug: false,
};

const SETTINGS_CACHE_KEY = '_jlc_smooth_settings_cache';

/**
 * 获取最新设置
 */
export async function getSettings(): Promise<SmoothSettings> {
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
export function getCachedSettings(): SmoothSettings {
	return (eda as any)[SETTINGS_CACHE_KEY] || { ...DEFAULT_SETTINGS };
}

/**
 * 保存设置并更新缓存
 */
export async function saveSettings(settings: SmoothSettings): Promise<void> {
	await eda.sys_Storage.setExtensionAllUserConfigs(settings as any);
	(eda as any)[SETTINGS_CACHE_KEY] = { ...settings };
}
