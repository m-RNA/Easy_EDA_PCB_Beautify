export interface SmoothSettings {
	replaceOriginal: boolean;
	syncWidthTransition: boolean; // 平滑时同步处理线宽过渡
	smoothRatio: number;
	widthTransitionRatio: number; // 线宽过渡长度系数
	widthTransitionSegments: number; // 线宽过渡分段数
	iterations: number;
	cornerRadius: number;
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
	unit: 'mil',
	debug: false,
};

let _cachedSettings: SmoothSettings = { ...DEFAULT_SETTINGS };

/**
 * 获取最新设置
 */
export async function getSettings(): Promise<SmoothSettings> {
	try {
		const configs = await eda.sys_Storage.getExtensionAllUserConfigs();
		_cachedSettings = { ...DEFAULT_SETTINGS, ...configs };
		return _cachedSettings;
	}
	catch {
		return _cachedSettings;
	}
}

/**
 * 同步获取缓存的设置 (不需要 await)
 */
export function getCachedSettings(): SmoothSettings {
	return _cachedSettings;
}

/**
 * 保存设置并更新缓存
 */
export async function saveSettings(settings: SmoothSettings): Promise<void> {
	await eda.sys_Storage.setExtensionAllUserConfigs(settings as any);
	_cachedSettings = { ...settings };
}
