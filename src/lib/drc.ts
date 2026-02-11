import { debugLog, debugWarn } from './logger';
import { getSettings } from './settings';

// ============================================================
// DRC API 数据结构定义 (基于 eda.pcb_Drc.check(false, false, true) 的实际返回)
// ============================================================

/** Level 3: 单条 DRC 违规 */
interface DrcIssue {
	visible: boolean;
	errorType: string; // e.g. "Clearance Error"
	errorObjType: string; // e.g. "SMD Pad to Track", "Copper Region(Filled) to Track"
	ruleName: string; // e.g. "copperThickness1oz" (注意: 这是规则名，不能用来区分覆铜)
	ruleTypeName: string; // e.g. "Safe Spacing"
	layer: string; // e.g. "Top Layer", "Bottom Layer"
	globalIndex: string; // e.g. "err1783"
	parentId: string; // e.g. "DRCTab|_|Errors|_|Clearance Error|_|SMD Pad to Track"
	objs: string[]; // 违规对象 ID 列表 (主要 ID 来源)
	pos: { x: number; y: number };
	obj1: { typeName: string; suffix: string };
	obj2: { typeName: string; suffix: string };
	explanation: {
		str: string;
		param: Record<string, string>;
		errData: {
			globalIndex: string;
			position: { x: number; y: number };
			name: string;
			obj1: any; // 对象 1 ID (备用 ID 来源)
			obj1Type: string; // e.g. "Track", "Copper Region(Filled)"
			obj2: any; // 对象 2 ID (备用 ID 来源)
			obj2Type: string; // e.g. "SMD Pad", "Via"
			minDistance: number;
			clearance: number;
			errorType: string;
			layerIds: number[];
			obj1Suffix: string;
			obj2Suffix: string;
		};
	};
}

/** Level 2: DRC 子类别 (按对象类型组合分组) */
interface DrcSubCategory {
	name: string; // e.g. "SMD Pad to Track", "Copper Region(Filled) to Track"
	count: number;
	title: string[]; // e.g. ["SMD Pad", "to", "Track", "(2)"]
	visible: boolean;
	list: DrcIssue[];
}

/** Level 1: DRC 错误类别 */
interface DrcCategory {
	name: string; // e.g. "Clearance Error"
	count: number;
	title: string[]; // e.g. ["Clearance Error", "(14)"]
	visible: boolean;
	list: DrcSubCategory[];
}

// ============================================================
// 主函数
// ============================================================

/**
 * 运行 DRC 检查并解析结果
 * @returns 涉及违规的原语 ID 列表
 */
export async function runDrcCheckAndParse(): Promise<Set<string>> {
	const violatedIds = new Set<string>();
	try {
		const settings = await getSettings();
		if (!settings.enableDRC) {
			return violatedIds;
		}

		debugLog('[DRC] Starting global check...');
		const categories: DrcCategory[] = await eda.pcb_Drc.check(false, false, true);

		if (!Array.isArray(categories)) {
			console.warn('[DRC] Check returned non-array:', categories);
			return violatedIds;
		}

		debugLog(`[DRC] Found ${categories.length} categories`);

		// 过滤覆铜相关 issue
		let filtered = categories;
		if (settings.drcIgnoreCopperPour) {
			filtered = filterOutCopperPourIssues(categories);
			const origCount = categories.reduce((n, c) => n + (c.count || 0), 0);
			const filteredCount = filtered.reduce((n, c) => n + (c.count || 0), 0);
			const removed = origCount - filteredCount;
			if (removed > 0) {
				debugLog(`[DRC] Filtered out ${removed} copper pour related issues`);
			}
		}

		// 三层精确遍历提取违规 ID
		for (const category of filtered) {
			if (!Array.isArray(category.list))
				continue;
			for (const subCategory of category.list) {
				if (!Array.isArray(subCategory.list))
					continue;
				for (const issue of subCategory.list) {
					extractViolatedIds(issue, violatedIds);
				}
			}
		}

		debugLog(`[DRC] Extracted ${violatedIds.size} unique violated IDs.`);

		return violatedIds;
	}
	catch (e: any) {
		debugWarn('[DRC] runDrcCheckAndParse failed');
		console.warn('[DRC] runDrcCheckAndParse failed', e);
		return violatedIds;
	}
}

/** DRC 覆铜违规信息（按图层聚合） */
export interface CopperViolationInfo {
	/** 存在覆铜相关 DRC 违规的图层 ID 集合 */
	violatedLayers: Set<number>;
	/** 覆铜相关 DRC 问题总数 */
	issueCount: number;
}

/**
 * 获取存在 DRC 问题的覆铜图层信息
 *
 * 核心思路变更：DRC 返回的对象 ID 属于内部 "Copper Region(Filled)"，
 * 与 pcb_PrimitivePour / pcb_PrimitivePoured 的 ID 空间完全不同，无法直接匹配。
 * 因此改为提取违规所在的**图层 ID**，再按图层重铺对应的 Pour 边界。
 */
export async function getViolatedCopperPours(): Promise<CopperViolationInfo> {
	const result: CopperViolationInfo = { violatedLayers: new Set(), issueCount: 0 };
	try {
		debugLog('[DRC] Checking for copper-related DRC issues...');
		const categories: DrcCategory[] = await eda.pcb_Drc.check(false, false, true);

		if (!Array.isArray(categories))
			return result;

		// 遍历所有类别，只关注覆铜相关的 issue
		for (const cat of categories) {
			for (const sub of cat.list || []) {
				const isCopperSub = sub.name?.includes('Copper Region') ?? false;
				for (const issue of sub.list || []) {
					const isCopperIssue = isCopperSub
						|| issue.errorObjType?.includes('Copper')
						|| issue.errorObjType?.includes('Region');

					if (!isCopperIssue) {
						// 也检查 errData 的 objType
						const errData = issue.explanation?.errData;
						if (!errData)
							continue;
						const hasCopper = errData.obj1Type?.includes('Copper')
							|| errData.obj1Type?.includes('Region')
							|| errData.obj2Type?.includes('Copper')
							|| errData.obj2Type?.includes('Region');
						if (!hasCopper)
							continue;
					}

					result.issueCount++;

					// 提取图层 ID
					const errData = issue.explanation?.errData;
					if (errData && Array.isArray(errData.layerIds)) {
						for (const lid of errData.layerIds) {
							if (typeof lid === 'number')
								result.violatedLayers.add(lid);
						}
					}
				}
			}
		}

		if (result.issueCount > 0) {
			debugLog(`[DRC] Found ${result.issueCount} copper-related issues on layers: [${Array.from(result.violatedLayers).join(', ')}]`);
		}
		return result;
	}
	catch (e: any) {
		debugWarn(`[DRC] getViolatedCopperPours failed: ${e.message}`);
		return result;
	}
}

// ============================================================
// ID 提取
// ============================================================

/**
 * 从单条 DRC issue 中提取违规对象 ID
 * 主路径: issue.objs[]
 * 备用:   issue.explanation.errData.obj1 / obj2
 */
function extractViolatedIds(issue: DrcIssue, ids: Set<string>): void {
	// 主路径: objs 数组
	if (Array.isArray(issue.objs)) {
		for (const id of issue.objs) {
			if (typeof id === 'string')
				ids.add(id);
		}
	}

	// 备用路径: errData 中的 obj1/obj2
	const errData = issue.explanation?.errData;
	if (errData) {
		if (typeof errData.obj1 === 'string')
			ids.add(errData.obj1);
		if (typeof errData.obj2 === 'string')
			ids.add(errData.obj2);
	}
}

// ============================================================
// 覆铜过滤
// ============================================================

/**
 * 判断 Level 2 子类别是否与覆铜区域相关
 * 已知 API 返回的覆铜对象类型名为 "Copper Region(Filled)"
 */
function isCopperPourSubCategory(sub: DrcSubCategory): boolean {
	return sub.name?.includes('Copper Region') ?? false;
}

/**
 * 判断 Level 3 issue 是否与覆铜区域相关
 */
function isCopperPourIssue(issue: DrcIssue): boolean {
	return issue.errorObjType?.includes('Copper Region') ?? false;
}

/**
 * 过滤掉覆铜相关的 DRC issue (三层精确结构)
 *
 * Level 1 (Category) → Level 2 (Sub-category) → Level 3 (Issue)
 * 在 Level 2 层过滤: 如果 sub-category name 含覆铜关键词，整组移除
 * 在 Level 3 层过滤: 逐条检查 errorObjType / obj typeName
 * 空的 sub-category 和 category 自动剪枝
 */
function filterOutCopperPourIssues(categories: DrcCategory[]): DrcCategory[] {
	return categories
		.map((category) => {
			const filteredSubs = category.list
				.filter(sub => !isCopperPourSubCategory(sub))
				.map((sub) => {
					const filteredIssues = sub.list.filter(issue => !isCopperPourIssue(issue));
					return { ...sub, list: filteredIssues, count: filteredIssues.length };
				})
				.filter(sub => sub.list.length > 0);

			const totalCount = filteredSubs.reduce((n, s) => n + s.count, 0);
			return { ...category, list: filteredSubs, count: totalCount };
		})
		.filter(category => category.list.length > 0);
}
