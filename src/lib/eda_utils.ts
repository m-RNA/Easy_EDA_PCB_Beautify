import { getViolatedCopperPours } from './drc';
import { debugLog, debugWarn, logError } from './logger';
import { getSettings } from './settings';

/**
 * 安全地获取选中的导线对象
 * 处理了混合选中（如 Track + Arc）导致 API 崩溃的情况
 * @param selectedIds 选中的图元 ID 列表
 */
export async function getSafeSelectedTracks(selectedIds: string[]): Promise<any[]> {
	let lineObjects: any = null;

	// 过滤非法 ID
	const validIds = selectedIds.filter(id => id && typeof id === 'string');

	if (validIds.length > 0) {
		try {
			// 尝试批量获取
			lineObjects = await eda.pcb_PrimitiveLine.get(validIds);
		}
		catch (err: any) {
			debugLog(`[SafeGet] standard get() failed, trying getAll() fallback: ${err.message}`);
			// Fallback: 降级为获取所有线并在内存中过滤
			try {
				const allLines = await eda.pcb_PrimitiveLine.getAll();
				if (Array.isArray(allLines)) {
					const idSet = new Set(validIds);
					lineObjects = allLines.filter((line: any) => {
						let pid = '';
						if (typeof line.getState_PrimitiveId === 'function')
							pid = line.getState_PrimitiveId();
						else if (line.primitiveId)
							pid = line.primitiveId;

						return pid && idSet.has(pid);
					});
					debugLog(`[SafeGet] Fallback recovered ${lineObjects.length} lines`);
				}
			}
			catch (e2: any) {
				logError(`[SafeGet Error] Fallback getAll() also failed: ${e2.message}`);
			}
		}
	}

	// 确保返回的是数组，并过滤掉 null/undefined
	let selectedTracks: any[] = [];
	if (lineObjects) {
		if (Array.isArray(lineObjects)) {
			selectedTracks = lineObjects.filter((p: any) => p !== null && p !== undefined);
		}
		else {
			selectedTracks = [lineObjects];
		}
	}

	return selectedTracks;
}

/**
 * 重铺所有覆铜区域
 * 遍历 PCB 中所有 Pour 边框，逐个调用 rebuildCopperRegion()
 * 注意: rebuildCopperRegion 是未公开 API，通过 runtime 验证可用
 * @returns 成功重铺的数量，失败时返回 -1
 */
export async function rebuildAllCopperPours(): Promise<number> {
	try {
		const pours = await eda.pcb_PrimitivePour.getAll();
		if (!pours || pours.length === 0) {
			debugLog('[CopperPour] No pours found, skipping rebuild');
			return 0;
		}

		let rebuilt = 0;
		for (const pour of pours) {
			try {
				await (pour as any).rebuildCopperRegion();
				rebuilt++;
			}
			catch (e: any) {
				debugWarn(`[CopperPour] Failed to rebuild pour: ${e.message || e}`);
			}
		}

		debugLog(`[CopperPour] Rebuilt ${rebuilt}/${pours.length} copper pours`);
		return rebuilt;
	}
	catch (e: any) {
		debugWarn(`[CopperPour] Rebuild all failed: ${e.message || e}`);
		return -1;
	}
}

/**
 * 智能重铺：仅重铺存在 DRC 问题的覆铜区域
 *
 * 核心策略: DRC 返回的 "Copper Region(Filled)" 对象 ID 与 pcb_PrimitivePour
 * / pcb_PrimitivePoured 的 ID 空间完全不同,无法直接匹配。
 * 因此采用 **图层过滤** 方案: 从 DRC 违规中提取涉及的图层 ID,
 * 仅对这些图层上的 Pour 执行 rebuildCopperRegion()。
 *
 * @returns 成功重铺的数量, 0=无违规, -1=执行异常
 */
export async function rebuildViolatedCopperPours(): Promise<number> {
	try {
		const violation = await getViolatedCopperPours();

		// 没有覆铜相关的 DRC 问题
		if (violation.issueCount === 0) {
			debugLog('[CopperPour] No copper-related DRC issues, skipping rebuild');
			return 0;
		}

		const allPours = await eda.pcb_PrimitivePour.getAll();
		if (!allPours || allPours.length === 0) {
			debugLog('[CopperPour] No pours found on board');
			return 0;
		}

		// 如果无法从 DRC 中提取到图层信息，兜底重铺所有
		if (violation.violatedLayers.size === 0) {
			debugLog(`[CopperPour] ${violation.issueCount} copper issues found but no layer info extracted. Rebuilding all ${allPours.length} pours.`);
			let rebuilt = 0;
			for (const pour of allPours) {
				try {
					await (pour as any).rebuildCopperRegion();
					rebuilt++;
				}
				catch { }
			}
			return rebuilt;
		}

		// 按图层过滤: 仅重铺 DRC 违规涉及的图层上的覆铜
		const poursToRebuild: typeof allPours = [];
		for (const pour of allPours) {
			const layer = pour.getState_Layer ? pour.getState_Layer() : (pour as any).layer;
			if (typeof layer === 'number' && violation.violatedLayers.has(layer)) {
				poursToRebuild.push(pour);
			}
		}

		debugLog(`[CopperPour] Smart Rebuild: ${violation.issueCount} DRC issues on layers [${Array.from(violation.violatedLayers).join(', ')}] → rebuilding ${poursToRebuild.length}/${allPours.length} pours`);

		let successCount = 0;
		for (const pour of poursToRebuild) {
			try {
				if ((pour as any).rebuildCopperRegion) {
					await (pour as any).rebuildCopperRegion();
					successCount++;
				}
			}
			catch (e: any) {
				const pid = pour.getState_PrimitiveId ? pour.getState_PrimitiveId() : '?';
				debugWarn(`[CopperPour] Failed to rebuild pour ${pid}: ${e.message || e}`);
			}
		}

		return successCount;
	}
	catch (e: any) {
		debugWarn(`[SmartCopper] Smart rebuild failed: ${e.message || e}`);
		return -1;
	}
}

/**
 * 根据设置判断是否重铺覆铜，若启用则显示提示并执行重铺
 * 统一入口，供 beautify / widthTransition 等流程复用
 * @returns 成功重铺的数量，未启用时返回 -2，失败时返回 -1
 */
export async function rebuildAllCopperPoursIfEnabled(): Promise<number> {
	const settings = await getSettings();
	if (!settings.rebuildCopperPourAfterBeautify) {
		return -2;
	}

	// 智能重铺: 仅重铺 DRC 违规涉及的图层上的覆铜
	const smartCount = await rebuildViolatedCopperPours();
	if (smartCount >= 0) {
		// 0=无违规, >0=局部重铺成功
		return smartCount;
	}

	// smartCount < 0: 执行异常，回退到全量重铺
	debugLog('[CopperPour] Smart rebuild failed, falling back to full rebuild.');
	eda.sys_Message?.showToastMessage('正在全量重铺覆铜...');
	return rebuildAllCopperPours();
}
