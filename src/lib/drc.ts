import { debugLog, debugWarn } from './logger';
import { getSettings } from './settings';

// Removed prepareDrcRules and cachedRules as per new strategy

// Removed checkArcClearance and helper getDistToPrim

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
		// check(strict, ui, verbose)
		const issues = await eda.pcb_Drc.check(false, false, true);

		if (!Array.isArray(issues)) {
			console.warn('[DRC] Check returned non-array:', issues);
			return violatedIds;
		}

		debugLog(`[DRC] Found ${issues.length} issues`);

		if (issues.length > 0) {
			const sampleKeys = Object.keys(issues[0]);
			debugLog(`[DRC Debug] First issue keys: ${JSON.stringify(sampleKeys)}`);
			try {
				// 强制转换为字符串以确保显示
				const issueStr = JSON.stringify(issues[0]);
				debugLog(`[DRC Debug] First issue JSON: ${issueStr}`);
			}
			catch {
				debugLog('[DRC Debug] Cannot stringify issue');
			}
		}

		// 改进的递归 ID 提取器，针对嵌套的 DRC 结果结构优化
		// 结构通常是: Category -> list[] -> SubCategory -> list[] -> Issue -> objs[]
		const extractIdsRecursive = (obj: any, foundIds: Set<string>, depth: number = 0) => {
			if (!obj || typeof obj !== 'object' || depth > 8) // 增加深度限制
				return;

			// 1. 明确的 ID 容器 (根据 log 结构)
			if (Array.isArray(obj.objs)) {
				for (const id of obj.objs) {
					if (typeof id === 'string')
						foundIds.add(id);
				}
			}

			// 2. 备用路径: explanation.errData
			if (obj.explanation && obj.explanation.errData) {
				const data = obj.explanation.errData;
				if (data.obj1 && typeof data.obj1 === 'string')
					foundIds.add(data.obj1);
				if (data.obj2 && typeof data.obj2 === 'string')
					foundIds.add(data.obj2);
			}

			// 3. 通用对象属性检查
			if (obj.id && typeof obj.id === 'string')
				foundIds.add(obj.id);
			if (obj.uuid && typeof obj.uuid === 'string')
				foundIds.add(obj.uuid);
			if (obj.primitiveId && typeof obj.primitiveId === 'string')
				foundIds.add(obj.primitiveId);
			if (obj.gId && typeof obj.gId === 'string')
				foundIds.add(obj.gId);

			// 4. 递归遍历 list 数组和其他属性
			if (Array.isArray(obj.list)) {
				for (const item of obj.list) {
					extractIdsRecursive(item, foundIds, depth + 1);
				}
			}
			else if (Array.isArray(obj)) {
				for (const item of obj) {
					extractIdsRecursive(item, foundIds, depth + 1);
				}
			}
			else {
				// 遍历对象属性，寻找可能的嵌套结构
				for (const key of Object.keys(obj)) {
					// 优化：已处理过的属性不再处理
					if (key === 'objs' || key === 'list' || key === 'explanation')
						continue;
					if (key === 'parent' || key === 'document' || key === 'owner')
						continue; // 避免循环

					const val = obj[key];
					if (typeof val === 'object') {
						extractIdsRecursive(val, foundIds, depth + 1);
					}
				}
			}
		};

		for (const issue of issues) {
			extractIdsRecursive(issue, violatedIds);
		}

		debugLog(`[DRC Debug] Extracted ${violatedIds.size} unique violated IDs.`);
		if (violatedIds.size > 0) {
			const sampleIds = Array.from(violatedIds).slice(0, 3);
			debugLog(`[DRC Debug] Sample IDs: ${JSON.stringify(sampleIds)}`);
		}

		return violatedIds;
	}
	catch (e: any) {
		debugWarn('[DRC] runDrcCheckAndParse failed');
		console.warn('[DRC] runDrcCheckAndParse failed', e);
		return violatedIds;
	}
}
