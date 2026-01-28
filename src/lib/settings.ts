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

export async function getSettings(): Promise<SmoothSettings> {
	try {
		const configs = await eda.sys_Storage.getExtensionAllUserConfigs();
		return { ...DEFAULT_SETTINGS, ...configs };
	}
	catch {
		return DEFAULT_SETTINGS;
	}
}

export async function saveSettings(settings: SmoothSettings): Promise<void> {
	await eda.sys_Storage.setExtensionAllUserConfigs(settings as any);
}
