import type { CornerArcOverride } from './arcGeometry';
import type { CopperViolationInfo } from './drc';
import type { Point } from './math';
import { buildConcentricOverrides, computeCornerArcCandidate } from './arcGeometry';
import { mapWithConcurrency } from './asyncPool';
import { runDrcCheckAndParse } from './drc';
import { getSafeSelectedTracks } from './eda_utils';
import { debugLog, debugWarn, logError, logPerformance } from './logger';
import { dist, getAngleBetween, lerp } from './math';
import { buildNodeDegreeIndex, isProtectedRouteNode, isRouteJunction, loadBoardTopologySegments, loadElectricalAnchorIndex, makePointKey } from './routeTopology';
import { getSettings } from './settings';
import { createSnapshot, restoreSnapshot } from './snapshot';
import { addWidthTransitionsAll } from './widthTransition';

/**
 * 获取基于几何信息的圆弧线宽 Map（单一数据源）
 * 用圆弧的几何信息（坐标+网络+层）作为唯一标识，不依赖图元 ID
 * 解决 EDA 可能修改图元 ID 导致查找失败的问题
 * 重要：只由 beautifyRouting(commitOps) 写入，restoreSnapshot 只读不写
 */
export function getArcWidthByGeoMap(): Map<string, number> {
	if (!(eda as any)._arcWidthByGeoMap) {
		(eda as any)._arcWidthByGeoMap = new Map<string, number>();
	}
	return (eda as any)._arcWidthByGeoMap;
}

/**
 * 生成基于几何信息的 Map key
 * 使用 net + layer + 起终点坐标唯一标识一个圆弧
 * 不包含角度：避免 beautifyRouting 计算角度与 EDA getState_ArcAngle() 返回值的微小差异导致 key 不匹配
 * 使用 toFixed(1) 降低精度增加容差
 */
export function makeArcWidthGeoKey(
	net: string | number,
	layer: string | number,
	sx: number,
	sy: number,
	ex: number,
	ey: number,
): string {
	// 规范化起终点顺序：确保 (sx, sy) 在字典序上小于等于 (ex, ey)
	// 这样相同的几何圆弧（无论起点/终点如何标记）都会生成相同的 key
	let nsx = sx;
	let nsy = sy;
	let nex = ex;
	let ney = ey;

	if (nsx > nex || (nsx === nex && nsy > ney)) {
		// 交换起终点
		nsx = ex;
		nsy = ey;
		nex = sx;
		ney = sy;
	}

	return `${net}#${layer}#${nsx.toFixed(1)}#${nsy.toFixed(1)}#${nex.toFixed(1)}#${ney.toFixed(1)}`;
}

// 定义几何操作指令接口
interface PathOp {
	type: 'line' | 'arc';
	start: Point;
	end: Point;
	width: number;
	primitiveLock?: boolean;
	angle?: number;
	cornerIndex: number; // 关联的拐角索引，用于回滚定位
}

interface ProtectedNetGroup {
	key: string;
	name: string;
	type: 'differential' | 'equalLength';
	nets: string[];
}

interface PathContext {
	pathId: number; // 唯一标识
	points: Point[];
	orderedSegs: any[];
	net: string;
	layer: number;
	backupPrimitives: any[]; // 原始数据备份
	createdIds: string[]; // 当前生成的全部图元 ID
	createdLineIds: string[]; // 当前生成的 Line ID
	createdArcIds: string[]; // 当前生成的 Arc ID
	idToCornerMap: Map<string, number>; // ID -> 拐角索引映射
	badCorners: Set<number>; // DRC 或电气锚点要求强制保持直线的拐角
	cornerScales: Map<number, number>; // 拐角缩放因子
	protectedGroupKeys: string[];
	protectedCornerKeys: Map<number, string>;
	cornerOverrides: Map<number, CornerArcOverride | null>;
}

export interface BeautifyRoutingResult {
	completed: boolean;
	copperViolation?: CopperViolationInfo;
}

const CREATE_CONCURRENCY = 8;
const DELETE_BATCH_SIZE = 200;
const DELETE_FALLBACK_CONCURRENCY = 4;

async function deletePrimitiveIdsInChunks(
	primitiveIds: string[],
	deleteFn: (ids: string[]) => Promise<boolean>,
	label: string,
): Promise<void> {
	for (let start = 0; start < primitiveIds.length; start += DELETE_BATCH_SIZE) {
		const chunk = primitiveIds.slice(start, start + DELETE_BATCH_SIZE);
		try {
			const success = await deleteFn(chunk);
			if (success === false)
				throw new Error('批量删除返回失败');
		}
		catch (error: any) {
			debugWarn(`[BatchDelete] ${label} 批量删除失败，回退逐条删除: ${error?.message || error}`);
			let failedCount = 0;
			await mapWithConcurrency(chunk, DELETE_FALLBACK_CONCURRENCY, async (primitiveId) => {
				try {
					const success = await deleteFn([primitiveId]);
					if (success === false)
						failedCount++;
				}
				catch {
					failedCount++;
				}
			});
			if (failedCount > 0)
				throw new Error(`${label} 有 ${failedCount} 个图元删除失败`);
		}
	}
}

function getCreatedPrimitiveId(result: any): string | null {
	if (typeof result === 'string')
		return result;
	if (result?.id)
		return result.id;
	if (result?.primitiveId)
		return result.primitiveId;
	if (typeof result?.getState_PrimitiveId === 'function')
		return result.getState_PrimitiveId();
	return null;
}

/**
 * 核心几何计算函数：根据路径点生成绘图指令
 * @param path 设置线段信息
 * @param path.points 线段点集合
 * @param path.orderedSegs 线段集合
 * @param settings 设置
 * @param badCorners 需要强制跳过（保持直角）的拐角索引集合
 */
function generatePathOps(
	path: { points: Point[]; orderedSegs: any[] },
	settings: any,
	badCorners: Set<number> = new Set(),
	cornerScales: Map<number, number> = new Map(),
	cornerOverrides: Map<number, CornerArcOverride | null> = new Map(),
): PathOp[] {
	const { points, orderedSegs } = path;
	const ops: PathOp[] = [];

	if (points.length < 3)
		return ops;

	// 半径不再是固定值，而是基于线宽的比率
	const ratio = settings.cornerRadiusRatio;

	let currentStart = points[0];

	// 遍历每一个拐角 (点 1 到 点 N-2)
	for (let i = 1; i < points.length - 1; i++) {
		const pPrev = points[i - 1];
		const pCorner = points[i];
		const pNext = points[i + 1];

		// 获取线宽
		const prevSegWidth = orderedSegs[i - 1]?.width ?? orderedSegs[0].width;
		const nextSegWidth = orderedSegs[i]?.width ?? prevSegWidth;

		// 动态计算当前拐角的理想半径：取较宽线宽 * 比率
		const maxLineWidth = Math.max(prevSegWidth, nextSegWidth);
		const baseRadius = maxLineWidth * ratio;

		// 如果该拐角被标记为“坏拐角”（DRC违规），强制跳过优化
		if (badCorners.has(i)) {
			ops.push({
				type: 'line',
				start: currentStart,
				end: pCorner,
				width: prevSegWidth,
				cornerIndex: i,
			});
			currentStart = pCorner;
			continue;
		}

		// 计算实际半径 (应用 DRC 缩放)
		// 如果 cornerScales 中没有值，默认为 1.0 (100% Base Radius)
		let radius = baseRadius;
		const scale = cornerScales.get(i);
		if (scale !== undefined) {
			radius = baseRadius * scale;
		}

		const override = cornerOverrides.get(i);
		if (override === null) {
			ops.push({
				type: 'line',
				start: currentStart,
				end: pCorner,
				width: prevSegWidth,
				cornerIndex: i,
			});
			currentStart = pCorner;
			continue;
		}
		if (override) {
			ops.push({
				type: 'line',
				start: currentStart,
				end: override.start,
				width: prevSegWidth,
				cornerIndex: i,
			});
			ops.push({
				type: 'arc',
				start: override.start,
				end: override.end,
				width: override.width,
				angle: override.angle,
				cornerIndex: i,
			});
			currentStart = override.end;
			continue;
		}

		// --- 普通圆角逻辑 ---
		{
			const v1 = { x: pPrev.x - pCorner.x, y: pPrev.y - pCorner.y };
			const v2 = { x: pNext.x - pCorner.x, y: pNext.y - pCorner.y };
			const mag1 = Math.sqrt(v1.x ** 2 + v1.y ** 2);
			const mag2 = Math.sqrt(v2.x ** 2 + v2.y ** 2);
			const dot = (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2);
			const safeDot = Math.max(-1, Math.min(1, dot));
			const angleRad = Math.acos(safeDot);
			const tanVal = Math.tan(angleRad / 2);

			let d = 0;
			if (Math.abs(tanVal) > 0.0001) {
				d = radius / tanVal;
			}

			// 限制切线长度
			const maxAllowedRadius = Math.min(mag1 * 0.45, mag2 * 0.45);
			const actualD = Math.min(d, maxAllowedRadius);
			let isSkipped = false;

			// 检查缩放: 如果计算出的切线长度严重小于预期(说明线段太短放不下这么大的圆角)
			// 除非 scale 已经被 DRC 调整过(小于1)，否则我们尽量尊重设置
			if (d > 0.001 && actualD < d * 0.95 && !settings.forceArc) {
				isSkipped = true;
			}
			// 检查线宽
			if (!isSkipped) {
				const effectiveRadius = actualD * Math.abs(tanVal);
				const maxLineWidth = Math.max(prevSegWidth, nextSegWidth);
				if (effectiveRadius < (maxLineWidth / 2) - 0.05) {
					isSkipped = true;
				}
			}

			if (actualD > 0.05 && !isSkipped) {
				const pStart = lerp(pCorner, pPrev, actualD / mag1);
				const pEnd = lerp(pCorner, pNext, actualD / mag2);

				// 1. 直线: current -> 切点1
				ops.push({
					type: 'line',
					start: currentStart,
					end: pStart,
					width: prevSegWidth,
					cornerIndex: i,
				});

				const sweptAngle = getAngleBetween(
					{ x: -v1.x, y: -v1.y },
					{ x: v2.x, y: v2.y },
				);

				// 2. 圆弧: 切点1 -> 切点2
				ops.push({
					type: 'arc',
					start: pStart,
					end: pEnd,
					width: nextSegWidth,
					angle: sweptAngle,
					cornerIndex: i,
				});

				currentStart = pEnd;
			}
			else {
				// 无法圆滑，保持原样：直线到拐点
				ops.push({
					type: 'line',
					start: currentStart,
					end: pCorner,
					width: prevSegWidth,
					cornerIndex: i,
				});
				currentStart = pCorner;
			}
		}
	}

	// 最后一段直线
	const lastSegWidth = orderedSegs[orderedSegs.length - 1]?.width ?? orderedSegs[0].width;
	ops.push({
		type: 'line',
		start: currentStart,
		end: points[points.length - 1],
		width: lastSegWidth,
		cornerIndex: points.length - 1, // 关联到终点或最后一个有效索引
	});

	return ops;
}

async function loadProtectedNetGroups(settings: any): Promise<ProtectedNetGroup[]> {
	if (!settings.protectDifferentialAndEqualLength)
		return [];

	const groups: ProtectedNetGroup[] = [];
	try {
		const drcApi = eda.pcb_Drc as any;
		const differentialRaw = typeof drcApi.getAllDifferentialPairs === 'function'
			? await drcApi.getAllDifferentialPairs()
			: [];
		const differentialPairs = normalizeDifferentialPairs(differentialRaw);
		for (const pair of differentialPairs) {
			const nets = uniqueNets([pair.positiveNet, pair.negativeNet]);
			if (nets.length >= 2) {
				groups.push({
					key: `diff:${pair.name || nets.join('/')}`,
					name: pair.name || nets.join('/'),
					type: 'differential',
					nets,
				});
			}
		}

		const equalLengthGroups = typeof drcApi.getAllEqualLengthNetGroups === 'function'
			? await drcApi.getAllEqualLengthNetGroups()
			: [];
		if (Array.isArray(equalLengthGroups)) {
			for (const group of equalLengthGroups) {
				const nets = uniqueNets(group?.nets || []);
				if (nets.length >= 2) {
					groups.push({
						key: `eq:${group.name || nets.join('/')}`,
						name: group.name || nets.join('/'),
						type: 'equalLength',
						nets,
					});
				}
			}
		}
	}
	catch (e: any) {
		debugLog(`[ProtectedRoute] 读取差分/等长组失败，跳过保护: ${e.message || e}`);
	}

	return groups;
}

function normalizeDifferentialPairs(input: any): Array<{ name?: string; positiveNet?: string; negativeNet?: string }> {
	const pairs: Array<{ name?: string; positiveNet?: string; negativeNet?: string }> = [];
	const visit = (value: any) => {
		if (!value)
			return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== 'object')
			return;
		if (typeof value.positiveNet === 'string' && typeof value.negativeNet === 'string') {
			pairs.push(value);
			return;
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(input);
	return pairs;
}

function uniqueNets(nets: any[]): string[] {
	const result: string[] = [];
	for (const net of nets) {
		if (typeof net !== 'string' || !net)
			continue;
		if (!result.includes(net))
			result.push(net);
	}
	return result;
}

function buildNetToProtectedGroups(groups: ProtectedNetGroup[]): Map<string, ProtectedNetGroup[]> {
	const map = new Map<string, ProtectedNetGroup[]>();
	for (const group of groups) {
		for (const net of group.nets) {
			if (!map.has(net))
				map.set(net, []);
			map.get(net)!.push(group);
		}
	}
	return map;
}

function refreshProtectedCornerOverrides(activePaths: PathContext[], protectedGroups: ProtectedNetGroup[], settings: any) {
	for (const ctx of activePaths) {
		ctx.cornerOverrides.clear();
		ctx.protectedCornerKeys.clear();
	}
	if (!settings.protectDifferentialAndEqualLength || protectedGroups.length === 0)
		return;

	for (const group of protectedGroups) {
		const contexts = activePaths.filter(ctx => ctx.protectedGroupKeys.includes(group.key));
		const contextsByLayer = new Map<number, PathContext[]>();
		for (const ctx of contexts) {
			if (!contextsByLayer.has(ctx.layer))
				contextsByLayer.set(ctx.layer, []);
			contextsByLayer.get(ctx.layer)!.push(ctx);
		}

		for (const [layer, layerContexts] of contextsByLayer) {
			const groupNets = new Set(group.nets);
			const presentNets = new Set(layerContexts.map(ctx => ctx.net));
			const hasFullGroup = Array.from(groupNets).every(net => presentNets.has(net));
			if (!hasFullGroup) {
				for (const ctx of layerContexts)
					markAllProtectedCornersStraight(ctx, group.key, layer);
				continue;
			}

			const maxCornerCount = Math.max(...layerContexts.map(ctx => ctx.points.length - 2));
			for (let cornerIndex = 1; cornerIndex <= maxCornerCount; cornerIndex++) {
				const cornerKey = `${group.key}#${layer}#${cornerIndex}`;
				const candidates = [];
				let canProtect = true;
				for (const ctx of layerContexts) {
					if (cornerIndex >= ctx.points.length - 1) {
						canProtect = false;
						break;
					}
					ctx.protectedCornerKeys.set(cornerIndex, cornerKey);
					if (ctx.badCorners.has(cornerIndex)) {
						canProtect = false;
						break;
					}
					const candidate = computeCornerArcCandidate(
						ctx.points,
						ctx.orderedSegs,
						cornerIndex,
						{ ...settings, forceArc: false },
						ctx.cornerScales.get(cornerIndex),
					);
					if (!candidate) {
						canProtect = false;
						break;
					}
					candidates.push({ ctx, candidate });
				}

				if (!canProtect) {
					for (const ctx of layerContexts) {
						if (cornerIndex < ctx.points.length - 1)
							ctx.cornerOverrides.set(cornerIndex, null);
					}
					continue;
				}

				const overrides = buildConcentricOverrides(candidates.map(item => item.candidate));
				if (!overrides) {
					for (const { ctx } of candidates)
						ctx.cornerOverrides.set(cornerIndex, null);
					continue;
				}

				for (let i = 0; i < candidates.length; i++)
					candidates[i].ctx.cornerOverrides.set(cornerIndex, overrides[i]);
			}
		}
	}
}

function markAllProtectedCornersStraight(ctx: PathContext, groupKey: string, layer: number) {
	for (let cornerIndex = 1; cornerIndex < ctx.points.length - 1; cornerIndex++) {
		ctx.protectedCornerKeys.set(cornerIndex, `${groupKey}#${layer}#${cornerIndex}`);
		ctx.cornerOverrides.set(cornerIndex, null);
	}
}

function syncProtectedCornerRepair(
	activePaths: PathContext[],
	sourceCtx: PathContext,
	cornerIndex: number,
	apply: (ctx: PathContext, idx: number) => void,
): PathContext[] {
	const cornerKey = sourceCtx.protectedCornerKeys.get(cornerIndex);
	if (!cornerKey) {
		apply(sourceCtx, cornerIndex);
		return [sourceCtx];
	}

	const changed: PathContext[] = [];
	for (const ctx of activePaths) {
		for (const [idx, key] of ctx.protectedCornerKeys) {
			if (key === cornerKey) {
				apply(ctx, idx);
				changed.push(ctx);
			}
		}
	}
	return changed.length > 0 ? changed : [sourceCtx];
}

/**
 * 圆滑布线
 * @param scope 'selected' 只处理选中的导线, 'all' 处理所有导线
 */
export async function beautifyRouting(scope: 'selected' | 'all' = 'selected'): Promise<BeautifyRoutingResult> {
	const perfStartedAt = Date.now();
	let perfLastAt = perfStartedAt;
	const perfStages: string[] = [];
	let perfResult = 'failed';
	let perfDeletedLines = 0;
	let perfCreatedLines = 0;
	let perfCreatedArcs = 0;
	const markPerf = (label: string) => {
		const now = Date.now();
		perfStages.push(`${label}=${now - perfLastAt}ms`);
		perfLastAt = now;
	};

	const settings = await getSettings();
	markPerf('settings');
	let tracks: any[] = [];
	let rollbackSnapshotId: number | null = null;
	let lineCountBefore = 0;
	let latestCopperViolation: CopperViolationInfo | undefined;
	const routingResult: BeautifyRoutingResult = { completed: false };

	if (eda.sys_LoadingAndProgressBar?.showLoading) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	try {
		if (scope === 'all') {
			debugLog('处理所有导线');
			tracks = await eda.pcb_PrimitiveLine.getAll();
		}
		else {
			const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
			if (!selectedIds || selectedIds.length === 0) {
				eda.sys_Message?.showToastMessage('请先选择要处理的导线', 'warn' as any, 3);
				return routingResult;
			}
			const primitives = await getSafeSelectedTracks(selectedIds);

			// 过滤和 Polyline 处理
			const supportedTypes = ['Line', 'Track', 'Polyline', 'Wire'];
			const filtered = primitives.filter((p: any) => {
				if (!p)
					return false;
				const type = p.getState_PrimitiveType?.() || p.primitiveType || '';
				// 检查是否有线的基本属性 (StartX, EndX 等)
				const hasLineProps = (p.getState_StartX || p.startX !== undefined) && (p.getState_EndX || p.endX !== undefined);
				return supportedTypes.includes(type) || hasLineProps;
			});

			// 将Polyline转换为Line段
			for (const obj of filtered) {
				const type = obj.getState_PrimitiveType?.() || obj.primitiveType || '';
				if (type === 'Polyline') {
					// Polyline 展开逻辑 (保持原样)
					const polygon = obj.getState_Polygon ? obj.getState_Polygon() : (obj.polygon || null);
					if (polygon && polygon.polygon && Array.isArray(polygon.polygon)) {
						const coords = polygon.polygon.filter((v: any) => typeof v === 'number');
						const net = obj.getState_Net?.() || obj.net || '';
						const layer = obj.getState_Layer?.() || obj.layer || 1;
						const lineWidth = obj.getState_LineWidth?.() || obj.lineWidth || 10;
						const primId = obj.getState_PrimitiveId?.() || obj.primitiveId || 'unknown';
						// 将Polyline的点转换为虚拟Track对象
						for (let i = 0; i < coords.length - 2; i += 2) {
							tracks.push({
								getState_PrimitiveType: () => 'Line',
								getState_Net: () => net,
								getState_Layer: () => layer,
								getState_StartX: () => coords[i],
								getState_StartY: () => coords[i + 1],
								getState_EndX: () => coords[i + 2],
								getState_EndY: () => coords[i + 3],
								getState_LineWidth: () => lineWidth,
								getState_PrimitiveId: () => `${primId}_seg${i / 2}`,
								_isPolylineSegment: true,
								_originalPolyline: obj,
							});
						}
					}
				}
				else {
					tracks.push(obj);
				}
			}
		}

		if (tracks.length < 1) {
			perfResult = 'skipped-no-tracks';
			eda.sys_Message?.showToastMessage('未找到可处理的导线', 'info' as any, 2);
			return routingResult;
		}
		markPerf('load-tracks');

		// 节点保护必须基于整板真实拓扑，而不是仅基于当前选中的导线。
		// 否则只选中 T 形/十字节点中的两条支路时，会被误判为普通拐角。
		const topologyLines = scope === 'all'
			? tracks
			: await eda.pcb_PrimitiveLine.getAll();
		const topologyResult = await loadBoardTopologySegments(topologyLines || [], eda as any);
		const nodeDegreeIndex = buildNodeDegreeIndex(topologyResult.segments);
		for (const warning of topologyResult.warnings)
			debugWarn(`[RouteTopology] ${warning}`);

		let protectedAnchorKeys = new Set<string>();
		if (settings.protectPadAndViaNodes) {
			const anchorResult = await loadElectricalAnchorIndex(eda as any);
			protectedAnchorKeys = anchorResult.anchorKeys;
			if (anchorResult.warnings.length > 0) {
				for (const warning of new Set(anchorResult.warnings))
					debugWarn(`[RouteAnchor] ${warning}`);
				eda.sys_Message?.showToastMessage('部分焊盘或过孔读取失败，已按现有拓扑继续圆滑', 'warn' as any, 3);
			}
		}

		const protectedGroups = await loadProtectedNetGroups(settings);
		const netToProtectedGroups = buildNetToProtectedGroups(protectedGroups);
		if (protectedGroups.length > 0)
			debugLog(`[ProtectedRoute] 已读取 ${protectedGroups.length} 个差分/等长保护组`);
		markPerf('topology-and-protection');

		// 创建快照
		try {
			const name = scope === 'all' ? 'Beautify (All) Before' : 'Beautify (Selected) Before';
			const snapshot = await createSnapshot(name, false, true, scope === 'all' ? 'full' : 'incremental');
			if (!snapshot)
				throw new Error('无法创建圆滑前快照，已取消操作');
			rollbackSnapshotId = snapshot.id;
			lineCountBefore = snapshot.lines.length;
		}
		catch (e: any) {
			logError(`Failed to create snapshot: ${e.message || e}`);
			throw e;
		}
		markPerf('snapshot-before');

		// --- 路径提取逻辑 ---
		const groups = new Map<string, any[]>();
		for (const track of tracks) {
			const net = track.getState_Net();
			const layer = track.getState_Layer();
			const key = `${net}#@#${layer}`;
			if (!groups.has(key))
				groups.set(key, []);
			groups.get(key)?.push(track);
		}

		const activePaths: PathContext[] = [];
		const pendingLineIdsToDelete = new Set<string>();
		const pendingPolylineIdsToDelete = new Set<string>();
		let pathIdCounter = 0;

		// 1. 提取所有路径
		for (const [key, group] of groups) {
			const [net, layerStr] = key.split('#@#');
			const layer = Number(layerStr);

			const segs = group.map(t => ({
				p1: { x: t.getState_StartX(), y: t.getState_StartY() },
				p2: { x: t.getState_EndX(), y: t.getState_EndY() },
				width: t.getState_LineWidth(),
				id: t.getState_PrimitiveId(),
				primitiveLock: t.getState_PrimitiveLock?.() ?? false,
				track: t,
			}));

			const connections = new Map<string, typeof segs[0][]>();
			for (const seg of segs) {
				const k1 = makePointKey(seg.p1);
				const k2 = makePointKey(seg.p2);
				if (!connections.has(k1))
					connections.set(k1, []);
				if (!connections.has(k2))
					connections.set(k2, []);
				connections.get(k1)?.push(seg);
				connections.get(k2)?.push(seg);
			}

			// 提取所有连续路径
			const used = new Set<string>();
			const isPathBoundary = (point: Point) => isRouteJunction(net, layer, point, nodeDegreeIndex);

			for (const startSeg of segs) {
				if (used.has(startSeg.id))
					continue;

				const points: Point[] = [startSeg.p1, startSeg.p2];
				const orderedSegs: typeof segs[0][] = [startSeg];
				used.add(startSeg.id);

				// 双向扩展路径 (逻辑保持原样)
				let extended = true;
				while (extended) {
					extended = false;
					// 尝试从末端扩展
					const lastPoint = points[points.length - 1];
					const lastKey = makePointKey(lastPoint);
					const lastConns = connections.get(lastKey) || [];

					// 遇到整板真实分叉时停止扩展；焊盘/过孔作为路径内直角单独保护。
					if (lastConns.length <= 2 && !isPathBoundary(lastPoint)) {
						for (const seg of lastConns) {
							if (used.has(seg.id))
								continue;
							const nextKey1 = makePointKey(seg.p1);
							const nextKey2 = makePointKey(seg.p2);
							if (nextKey1 === lastKey) {
								points.push(seg.p2);
								orderedSegs.push(seg);
								used.add(seg.id);
								extended = true;
								break;
							}
							else if (nextKey2 === lastKey) {
								points.push(seg.p1);
								orderedSegs.push(seg);
								used.add(seg.id);
								extended = true;
								break;
							}
						}
					}

					// 尝试从起点扩展
					if (!extended) {
						const firstPoint = points[0];
						const firstKey = makePointKey(firstPoint);
						const firstConns = connections.get(firstKey) || [];

						// 起点同样使用整板拓扑判定。
						if (firstConns.length <= 2 && !isPathBoundary(firstPoint)) {
							for (const seg of firstConns) {
								if (used.has(seg.id))
									continue;
								const nextKey1 = makePointKey(seg.p1);
								const nextKey2 = makePointKey(seg.p2);
								if (nextKey1 === firstKey) {
									points.unshift(seg.p2);
									orderedSegs.unshift(seg);
									used.add(seg.id);
									extended = true;
									break;
								}
								else if (nextKey2 === firstKey) {
									points.unshift(seg.p1);
									orderedSegs.unshift(seg);
									used.add(seg.id);
									extended = true;
									break;
								}
							}
						}
					}
				}

				if (points.length >= 3) {
					const protectedAnchorCorners = new Set<number>();
					if (settings.protectPadAndViaNodes) {
						for (let index = 1; index < points.length - 1; index++) {
							if (isProtectedRouteNode(
								net,
								layer,
								points[index],
								nodeDegreeIndex,
								protectedAnchorKeys,
								true,
							)) {
								protectedAnchorCorners.add(index);
							}
						}
					}

					// 准备备份数据
					const backupPrimitives: any[] = [];

					for (const seg of orderedSegs) {
						backupPrimitives.push({
							type: 'Line',
							net,
							layer,
							startX: seg.p1.x,
							startY: seg.p1.y,
							endX: seg.p2.x,
							endY: seg.p2.y,
							lineWidth: seg.width,
						});
						if (seg.track._isPolylineSegment) {
							const orig = seg.track._originalPolyline;
							const origId = orig.getState_PrimitiveId?.() || orig.primitiveId;
							if (origId)
								pendingPolylineIdsToDelete.add(origId);
						}
						else {
							pendingLineIdsToDelete.add(seg.id);
						}
					}

					// 第二步：创建新对象 并记录ID
					activePaths.push({
						pathId: pathIdCounter++,
						points,
						orderedSegs,
						net,
						layer,
						backupPrimitives,
						createdIds: [],
						createdLineIds: [],
						createdArcIds: [],
						idToCornerMap: new Map(),
						badCorners: protectedAnchorCorners,
						cornerScales: new Map<number, number>(),
						protectedGroupKeys: (netToProtectedGroups.get(net) || []).map(group => group.key),
						protectedCornerKeys: new Map(),
						cornerOverrides: new Map(),
					});
				}
			}
		}
		markPerf('path-analysis');

		// 提取完路径后统一分块删除原图元，避免逐条调用 Worker。
		const pcbApi = eda as any;
		if (pendingPolylineIdsToDelete.size > 0) {
			const deletePolyline = typeof pcbApi.pcb_PrimitivePolyline?.delete === 'function'
				? (ids: string[]) => pcbApi.pcb_PrimitivePolyline.delete(ids)
				: (ids: string[]) => eda.pcb_PrimitiveLine.delete(ids);
			await deletePrimitiveIdsInChunks(
				Array.from(pendingPolylineIdsToDelete),
				deletePolyline,
				'Polyline',
			);
		}
		await deletePrimitiveIdsInChunks(
			Array.from(pendingLineIdsToDelete),
			ids => eda.pcb_PrimitiveLine.delete(ids),
			'Line',
		);
		perfDeletedLines += pendingLineIdsToDelete.size;
		markPerf('delete-originals');

		// 将所有路径的创建指令合并到同一个有限并发队列。
		const commitOps = async (jobs: Array<{ ops: PathOp[]; ctx: PathContext }>) => {
			for (const { ops, ctx } of jobs) {
				const lineOps = ops.filter(op => op.type === 'line');
				if (lineOps.length !== ctx.orderedSegs.length)
					throw new Error(`路径 ${ctx.pathId} 的直线与原路径段无法一一对应`);
				if (ops.some(op => dist(op.start, op.end) < 0.001))
					throw new Error(`路径 ${ctx.pathId} 生成了过短图元`);
				lineOps.forEach((op, index) => {
					op.primitiveLock = ctx.orderedSegs[index]?.primitiveLock ?? false;
				});
				ctx.createdIds = [];
				ctx.createdLineIds = [];
				ctx.createdArcIds = [];
				ctx.idToCornerMap.clear();
			}

			const pendingOps = jobs.flatMap(({ ops, ctx }) => ops.map(item => ({ item, ctx })));
			await mapWithConcurrency(pendingOps, CREATE_CONCURRENCY, async ({ item, ctx }) => {
				let result: any;
				if (item.type === 'line') {
					result = await eda.pcb_PrimitiveLine.create(
						ctx.net,
						ctx.layer as any,
						item.start.x,
						item.start.y,
						item.end.x,
						item.end.y,
						item.width,
						item.primitiveLock ?? false,
					);
				}
				else {
					result = await eda.pcb_PrimitiveArc.create(
						ctx.net,
						ctx.layer as any,
						item.start.x,
						item.start.y,
						item.end.x,
						item.end.y,
						item.angle!,
						item.width,
					);

					// 几何键存储（单一数据源，不依赖图元 ID）
					const geoKey = makeArcWidthGeoKey(ctx.net, ctx.layer, item.start.x, item.start.y, item.end.x, item.end.y);
					getArcWidthByGeoMap().set(geoKey, item.width);
				}

				const outputId = getCreatedPrimitiveId(result);
				if (!outputId)
					throw new Error(`路径 ${ctx.pathId} 的图元提交失败`);
				ctx.createdIds.push(outputId);
				ctx.idToCornerMap.set(outputId, item.cornerIndex);
				if (item.type === 'line') {
					ctx.createdLineIds.push(outputId);
					perfCreatedLines++;
				}
				else {
					ctx.createdArcIds.push(outputId);
					perfCreatedArcs++;
				}
			});
		};

		// 2. 第一次执行：生成所有路径 (Optimistic Pass)
		refreshProtectedCornerOverrides(activePaths, protectedGroups, settings);
		await commitOps(activePaths.map(ctx => ({
			ctx,
			ops: generatePathOps(
				{ points: ctx.points, orderedSegs: ctx.orderedSegs },
				settings,
				ctx.badCorners,
				ctx.cornerScales,
				ctx.cornerOverrides,
			),
		})));
		markPerf('initial-redraw');

		// 3. DRC 检查与二分法自动修复
		if (settings.enableDRC && activePaths.length > 0) {
			let drcAttempt = 0;
			const maxDrcRetries = settings.drcRetryCount || 4; // 默认4次 (1 -> 0.5 -> 0.25 -> 0.125 -> 0)

			while (drcAttempt <= maxDrcRetries) {
				const isFinalAttempt = drcAttempt === maxDrcRetries;
				eda.sys_Message?.showToastMessage(`DRC 检查中... (${drcAttempt + 1}/${maxDrcRetries + 1})`, 'info' as any, 1);

				// 运行全局检查
				const drcAnalysis = await runDrcCheckAndParse();
				const violatedIds = drcAnalysis.violatedIds;
				latestCopperViolation = drcAnalysis.valid ? drcAnalysis.copperViolation : undefined;
				markPerf(`drc-check-${drcAttempt + 1}`);

				if (violatedIds.size === 0) {
					debugLog('[DRC] 检查通过。');
					break;
				}

				debugLog(`[DRC] 发现 ${violatedIds.size} 个违规对象`);

				// 标记需要重绘的路径
				const pathsToRepair = new Set<PathContext>();
				let _repairedCorners = 0;

				for (const ctx of activePaths) {
					for (const id of ctx.createdIds) {
						if (violatedIds.has(id)) {
							const idx = ctx.idToCornerMap.get(id);
							if (idx !== undefined) {
								_repairedCorners++;

								const changed = syncProtectedCornerRepair(activePaths, ctx, idx, (repairCtx, repairIdx) => {
									const currentScale = repairCtx.cornerScales.get(repairIdx) ?? 1.0;
									const nextScale = currentScale * 0.5;

									if (isFinalAttempt || nextScale < 0.1) {
										repairCtx.badCorners.add(repairIdx);
										debugLog(`[DRC] Corner ${repairIdx} marked BAD (Straight)`);
									}
									else {
										repairCtx.cornerScales.set(repairIdx, nextScale);
										debugLog(`[DRC] Corner ${repairIdx} reducing scale to ${nextScale.toFixed(3)}`);
									}
								});
								for (const changedCtx of changed)
									pathsToRepair.add(changedCtx);
							}
						}
					}
				}

				if (pathsToRepair.size === 0) {
					debugLog('[DRC] 违规对象不属于本插件生成的内容，停止修复。');
					break;
				}

				// 重绘
				refreshProtectedCornerOverrides(activePaths, protectedGroups, settings);
				const repairJobs: Array<{ ops: PathOp[]; ctx: PathContext }> = [];
				const oldLineIds = Array.from(pathsToRepair).flatMap(ctx => ctx.createdLineIds);
				const oldArcIds = Array.from(pathsToRepair).flatMap(ctx => ctx.createdArcIds);
				await deletePrimitiveIdsInChunks(
					oldLineIds,
					ids => eda.pcb_PrimitiveLine.delete(ids),
					'Line',
				);
				await deletePrimitiveIdsInChunks(
					oldArcIds,
					ids => eda.pcb_PrimitiveArc.delete(ids),
					'Arc',
				);
				perfDeletedLines += oldLineIds.length;
				for (const ctx of pathsToRepair) {
					// 使用新参数生成
					repairJobs.push({
						ctx,
						ops: generatePathOps(
							{ points: ctx.points, orderedSegs: ctx.orderedSegs },
							settings,
							ctx.badCorners,
							ctx.cornerScales,
							ctx.cornerOverrides,
						),
					});
				}
				// 3. 重新绘制
				await commitOps(repairJobs);
				latestCopperViolation = undefined;
				markPerf(`drc-repair-${drcAttempt + 1}`);

				drcAttempt++;
			}

			if (drcAttempt > 0) {
				eda.sys_Message?.showToastMessage(`自动优化完成，执行了 ${drcAttempt} 轮调整`, 'info' as any, 2);
			}
		}

		// 防止宿主 API 静默保留已删除的原线，造成新旧导线重叠。
		// 全板导线数可能被宿主后台任务改变，只能作为诊断信息，不能据此回滚。
		const expectedLineCount = lineCountBefore
			- pendingLineIdsToDelete.size
			+ activePaths.reduce((count, ctx) => count + ctx.orderedSegs.length, 0);
		const verifiedLines = await eda.pcb_PrimitiveLine.getAll() || [];
		const staleOriginalIds = verifiedLines
			.map(line => line.getState_PrimitiveId?.())
			.filter((id): id is string => typeof id === 'string' && pendingLineIdsToDelete.has(id));
		if (staleOriginalIds.length > 0) {
			throw new Error(
				`圆滑结果校验失败：检测到 ${staleOriginalIds.length} 条原线残留`,
			);
		}
		if (verifiedLines.length !== expectedLineCount) {
			debugWarn(
				`[BeautifyVerify] 全板导线计数发生漂移：参考 ${expectedLineCount} 条，实际 ${verifiedLines.length} 条；未发现原线残留，继续完成`,
			);
		}
		markPerf('verify-output');

		// 结束
		if (settings.syncWidthTransition) {
			// 在 Beautify 流程中调用，不需要额外快照（Beautify 已创建）
			await addWidthTransitionsAll(false);
			latestCopperViolation = undefined;
			markPerf('width-transition');
		}

		try {
			const name = scope === 'all' ? 'Beautify (All) After' : 'Beautify (Selected) After';
			await createSnapshot(name);
		}
		catch { }
		markPerf('snapshot-after');

		perfResult = 'completed';
		routingResult.completed = true;
		routingResult.copperViolation = latestCopperViolation;
		eda.sys_Message?.showToastMessage('美化完成', 'success' as any, 2);
	}
	catch (e: any) {
		if (rollbackSnapshotId !== null) {
			try {
				const restored = await restoreSnapshot(rollbackSnapshotId, false, false);
				if (restored) {
					perfResult = 'failed-rolled-back';
					debugWarn('[Beautify] 操作失败，已恢复圆滑前快照');
				}
				else {
					debugWarn('[Beautify] 操作失败，圆滑前快照恢复未成功');
				}
			}
			catch (rollbackError: any) {
				logError(`Rollback failed: ${rollbackError?.message || rollbackError}`);
			}
		}
		logError(e.message);
		eda.sys_Message?.showToastMessage(`美化失败: ${e.message}`, 'error' as any, 4);
	}
	finally {
		logPerformance(
			`[Perf][Beautify:${scope}] result=${perfResult} tracks=${tracks.length} total=${Date.now() - perfStartedAt}ms line-deleted=${perfDeletedLines} line-created=${perfCreatedLines} arc-created=${perfCreatedArcs} ${perfStages.join(' ')}`,
		);
		eda.sys_LoadingAndProgressBar?.destroyLoading?.();
	}
	return routingResult;
}
