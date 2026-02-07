import type { Point } from './math';
import { runDrcCheckAndParse } from './drc';
import { getSafeSelectedTracks } from './eda_utils';
import { debugLog, logError } from './logger';
import { dist, getAngleBetween, getLineIntersection, lerp } from './math';
import { getSettings } from './settings';
import { createSnapshot } from './snapshot';
import { addWidthTransitionsAll } from './widthTransition';

/**
 * 获取全局圆弧线宽 Map
 * 因为 JLC EDA API 的 getState_LineWidth() 返回的值可能不正确
 * 挂载到 eda 对象避免循环依赖问题
 * Key 格式: ${pcbId}_${arcId} 以区分不同 PCB
 */
export function getArcLineWidthMap(): Map<string, number> {
	if (!(eda as any)._arcLineWidthMap) {
		(eda as any)._arcLineWidthMap = new Map<string, number>();
	}
	return (eda as any)._arcLineWidthMap;
}

/**
 * 生成带 PCB ID 的 Map key
 * @param pcbId PCB 文档 ID
 * @param arcId 圆弧原语 ID
 */
export function makeArcWidthKey(pcbId: string, arcId: string): string {
	return `${pcbId}_${arcId}`;
}

// 定义几何操作指令接口
interface PathOp {
	type: 'line' | 'arc';
	start: Point;
	end: Point;
	width: number;
	angle?: number;
	cornerIndex: number; // 关联的拐角索引，用于回滚定位
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

		let isMerged = false;

		// --- 尝试合并过渡线段 (U型弯优化) ---
		try {
			// 如果当前索引未被禁用，且开启了合并
			if (settings.mergeTransitionSegments && i < points.length - 2 && scale === undefined) {
				// 如果下一个拐角也在黑名单里，则不进行合并操作，以免逻辑混乱
				if (!badCorners.has(i + 1)) {
					const pAfter = points[i + 2];
					if (pAfter) {
						const segLen = dist(pCorner, pNext);
						if (segLen < radius * 1.5) {
							const vIn = { x: pPrev.x - pCorner.x, y: pPrev.y - pCorner.y };
							const vMid = { x: pNext.x - pCorner.x, y: pNext.y - pCorner.y };
							const vOut = { x: pAfter.x - pNext.x, y: pAfter.y - pNext.y };
							const angle1 = getAngleBetween({ x: -vIn.x, y: -vIn.y }, { x: vMid.x, y: vMid.y });
							const angle2 = getAngleBetween({ x: vMid.x, y: vMid.y }, { x: vOut.x, y: vOut.y });

							if (angle1 * angle2 > 0 && Math.abs(angle1) > 1 && Math.abs(angle2) > 1) {
								const intersection = getLineIntersection(pPrev, pCorner, pNext, pAfter);
								if (intersection) {
									const dInt1 = dist(intersection, pCorner);
									const dInt2 = dist(intersection, pNext);
									if (dInt1 < segLen * 10 && dInt2 < segLen * 10) {
										const t_v1 = { x: pPrev.x - intersection.x, y: pPrev.y - intersection.y };
										const t_v2 = { x: pAfter.x - intersection.x, y: pAfter.y - intersection.y };
										const t_mag1 = Math.sqrt(t_v1.x ** 2 + t_v1.y ** 2);
										const t_mag2 = Math.sqrt(t_v2.x ** 2 + t_v2.y ** 2);
										const t_dot = (t_v1.x * t_v2.x + t_v1.y * t_v2.y) / (t_mag1 * t_mag2);
										const t_angleRad = Math.acos(Math.max(-1, Math.min(1, t_dot)));
										const t_tanVal = Math.tan(t_angleRad / 2);
										let t_d = 0;
										if (Math.abs(t_tanVal) > 0.0001)
											t_d = radius / t_tanVal;

										const t_maxAllowedRadius = Math.min(t_mag1 * 0.95, t_mag2 * 0.95);
										const t_actualD = Math.min(t_d, t_maxAllowedRadius);
										const t_effectiveRadius = t_actualD * Math.abs(t_tanVal);

										if (t_actualD > 0.05 && t_effectiveRadius >= (maxLineWidth / 2) - 0.05) {
											const pStart = lerp(intersection, pPrev, t_actualD / t_mag1);
											const pEnd = lerp(intersection, pAfter, t_actualD / t_mag2);
											// 1. 直线: current -> pStart
											if (dist(currentStart, pStart) > 0.001) {
												ops.push({
													type: 'line',
													start: currentStart,
													end: pStart,
													width: prevSegWidth,
													cornerIndex: i, // 归属当前拐角
												});
											}

											const t_sweptAngle = getAngleBetween(
												{ x: -t_v1.x, y: -t_v1.y },
												{ x: t_v2.x, y: t_v2.y },
											);

											const afterSegWidth = orderedSegs[i + 1]?.width ?? nextSegWidth;
											// 2. 合并大圆弧
											ops.push({
												type: 'arc',
												start: pStart,
												end: pEnd,
												width: afterSegWidth,
												angle: t_sweptAngle,
												cornerIndex: i, // 归属当前拐角(虽然跨越了i+1)
											});

											currentStart = pEnd;
											i++; // 跳过下一个点
											isMerged = true;
										}
									}
								}
							}
						}
					}
				}
			}
		}
		catch { }

		// --- 普通圆角逻辑 ---
		if (!isMerged) {
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

/**
 * 圆滑布线
 * @param scope 'selected' 只处理选中的导线, 'all' 处理所有导线
 */
export async function beautifyRouting(scope: 'selected' | 'all' = 'selected') {
	const settings = await getSettings();
	let tracks: any[] = [];

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
				eda.sys_Message?.showToastMessage(eda.sys_I18n.text('请先选择要处理的导线'));
				return;
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
			eda.sys_Message?.showToastMessage(eda.sys_I18n.text('未找到可处理的导线'));
			return;
		}

		// 创建快照
		try {
			const name = scope === 'all' ? 'Beautify (All) Before' : 'Beautify (Selected) Before';
			await createSnapshot(name);
		}
		catch (e: any) {
			logError(`Failed to create snapshot: ${e.message || e}`);
		}

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

		// 定义处理上下文接口
		interface PathContext {
			pathId: number; // 唯一标识
			points: Point[];
			orderedSegs: any[];
			net: string;
			layer: number;
			backupPrimitives: any[]; // 原始数据备份
			createdIds: string[]; // 当前生成的ID
			idToCornerMap: Map<string, number>; // ID -> 拐角索引映射
			badCorners: Set<number>; // 已知的坏拐角
			cornerScales: Map<number, number>; // 拐角缩放因子
		}

		const activePaths: PathContext[] = [];
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
				track: t,
			}));

			// 辅助函数：生成坐标键
			// 使用 3 位小数精度，与 widthTransition 保持一致，避免浮点数误差导致断连
			const pointKey = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
			const connections = new Map<string, typeof segs[0][]>();
			for (const seg of segs) {
				const k1 = pointKey(seg.p1);
				const k2 = pointKey(seg.p2);
				if (!connections.has(k1))
					connections.set(k1, []);
				if (!connections.has(k2))
					connections.set(k2, []);
				connections.get(k1)?.push(seg);
				connections.get(k2)?.push(seg);
			}

			// 提取所有连续路径
			const used = new Set<string>();

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
					const lastKey = pointKey(points[points.length - 1]);
					const lastConns = connections.get(lastKey) || [];

					// 遇到分叉点（连接数 > 2）停止扩展
					if (lastConns.length <= 2) {
						for (const seg of lastConns) {
							if (used.has(seg.id))
								continue;
							const nextKey1 = pointKey(seg.p1);
							const nextKey2 = pointKey(seg.p2);
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
						const firstKey = pointKey(points[0]);
						const firstConns = connections.get(firstKey) || [];

						// 遇到分叉点（连接数 > 2）停止扩展
						if (firstConns.length <= 2) {
							for (const seg of firstConns) {
								if (used.has(seg.id))
									continue;
								const nextKey1 = pointKey(seg.p1);
								const nextKey2 = pointKey(seg.p2);
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
					// 准备备份数据
					const backupPrimitives: any[] = [];
					// 准备工作：计算所有需要删除的ID
					const polylineIdsToDelete = new Set<string>();
					const lineIdsToDelete = new Set<string>();

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
								polylineIdsToDelete.add(origId);
						}
						else {
							// 是普通 Line / Track
							lineIdsToDelete.add(seg.id);
						}
					}

					// 删除旧线
					if (polylineIdsToDelete.size > 0) {
						const pIds = Array.from(polylineIdsToDelete);
						try {
							const pcbApi = eda as any;
							if (pcbApi.pcb_PrimitivePolyline?.delete) {
								// 尝试逐个删除
								for (const pid of pIds) await pcbApi.pcb_PrimitivePolyline.delete([pid]);
							}
							else {
								await eda.pcb_PrimitiveLine.delete(pIds);
							}
						}
						catch {
							// ignore
						}
					}
					// 删除 Line (逐个删除以确保成功)
					if (lineIdsToDelete.size > 0) {
						const lIds = Array.from(lineIdsToDelete);
						for (const lid of lIds) {
							try {
								// 尝试传递数组包含单个ID
								await eda.pcb_PrimitiveLine.delete([lid]);
							}
							catch {
								// ignore
							}
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
						idToCornerMap: new Map(),
						badCorners: new Set<number>(),
						cornerScales: new Map<number, number>(),
					});
				}
			}
		}

		// 辅助函数：根据指令创建图元
		const commitOps = async (ops: PathOp[], ctx: PathContext) => {
			let createdArcsCount = 0;
			const pcbId = (await eda.dmt_Board.getCurrentBoardInfo())?.pcb?.uuid || 'unknown';
			for (const item of ops) {
				if (dist(item.start, item.end) < 0.001)
					continue;

				let newId: string | null = null;
				if (item.type === 'line') {
					const res = await eda.pcb_PrimitiveLine.create(
						ctx.net,
						ctx.layer as any,
						item.start.x,
						item.start.y,
						item.end.x,
						item.end.y,
						item.width,
					);
					// 兼容不同的返回值结构
					if (typeof res === 'string')
						newId = res;
					else if (res && (res as any).id)
						newId = (res as any).id;
					else if (res && (res as any).primitiveId)
						newId = (res as any).primitiveId;
					else if (res && (res as any).getState_PrimitiveId)
						newId = (res as any).getState_PrimitiveId();
				}
				else {
					// Arc
					const res = await eda.pcb_PrimitiveArc.create(
						ctx.net,
						ctx.layer as any,
						item.start.x,
						item.start.y,
						item.end.x,
						item.end.y,
						item.angle!,
						item.width,
					);
					if (typeof res === 'string')
						newId = res;
					else if (res && (res as any).id)
						newId = (res as any).id;
					else if (res && (res as any).primitiveId)
						newId = (res as any).primitiveId;
					else if (res && (res as any).getState_PrimitiveId)
						newId = (res as any).getState_PrimitiveId();

					if (newId) {
						const mapKey = makeArcWidthKey(pcbId, newId);
						getArcLineWidthMap().set(mapKey, item.width);
						createdArcsCount++;
					}
				}

				if (newId) {
					ctx.createdIds.push(newId);
					ctx.idToCornerMap.set(newId, item.cornerIndex);
				}
			}
			return createdArcsCount;
		};

		// 2. 第一次执行：生成所有路径 (Optimistic Pass)
		for (const ctx of activePaths) {
			const ops = generatePathOps(
				{ points: ctx.points, orderedSegs: ctx.orderedSegs },
				settings,
				ctx.badCorners,
				ctx.cornerScales,
			);
			await commitOps(ops, ctx);
		}

		// 3. DRC 检查与二分法自动修复
		if (settings.enableDRC && activePaths.length > 0) {
			let drcAttempt = 0;
			const maxDrcRetries = settings.drcRetryCount || 4; // 默认4次 (1 -> 0.5 -> 0.25 -> 0.125 -> 0)

			while (drcAttempt <= maxDrcRetries) {
				const isFinalAttempt = drcAttempt === maxDrcRetries;
				eda.sys_Message?.showToastMessage(`DRC 检查中... (优化轮次 ${drcAttempt + 1}/${maxDrcRetries + 1})`);

				// 运行全局检查
				const violatedIds = await runDrcCheckAndParse();

				if (violatedIds.size === 0) {
					debugLog('[DRC] 检查通过。');
					break;
				}

				debugLog(`[DRC] 发现 ${violatedIds.size} 个违规对象`);

				// 标记需要重绘的路径
				const pathsToRepair = new Set<PathContext>();
				let _repairedCorners = 0;

				for (const ctx of activePaths) {
					let needsUpdate = false;
					for (const id of ctx.createdIds) {
						if (violatedIds.has(id)) {
							const idx = ctx.idToCornerMap.get(id);
							if (idx !== undefined) {
								needsUpdate = true;
								_repairedCorners++;

								// 二分法/折半缩小策略
								// 默认初始 scale 为 1.0 (即使用 settings.cornerRadiusRatio)
								// 每次违规，我们将 scale 减半
								const currentScale = ctx.cornerScales.get(idx) ?? 1.0;
								const nextScale = currentScale * 0.5;

								if (isFinalAttempt || nextScale < 0.1) {
									// 尝试次数耗尽或比例过小，放弃治疗，回滚为直角
									ctx.badCorners.add(idx);
									debugLog(`[DRC] Corner ${idx} marked BAD (Straight)`);
								}
								else {
									// 尝试更小的半径
									ctx.cornerScales.set(idx, nextScale);
									debugLog(`[DRC] Corner ${idx} reducing scale to ${nextScale.toFixed(3)}`);
								}
							}
						}
					}
					if (needsUpdate) {
						pathsToRepair.add(ctx);
					}
				}

				if (pathsToRepair.size === 0) {
					debugLog('[DRC] 违规对象不属于本插件生成的内容，停止修复。');
					break;
				}

				// 重绘
				for (const ctx of pathsToRepair) {
					// 删除旧图元
					if (ctx.createdIds.length > 0) {
						try {
							await eda.pcb_PrimitiveLine.delete(ctx.createdIds);
							await eda.pcb_PrimitiveArc.delete(ctx.createdIds); // 虽然ID是一样的，但为了保险
						}
						catch { }
						ctx.createdIds = []; // 清空记录
						ctx.idToCornerMap.clear();
					}

					// 使用新参数生成
					const ops = generatePathOps(
						{ points: ctx.points, orderedSegs: ctx.orderedSegs },
						settings,
						ctx.badCorners,
						ctx.cornerScales,
					);
					// 3. 重新绘制
					await commitOps(ops, ctx);
				}

				drcAttempt++;
			}

			if (drcAttempt > 0) {
				eda.sys_Message?.showToastMessage(`自动优化完成，执行了 ${drcAttempt} 轮调整`);
			}
		}

		// 结束
		if (settings.syncWidthTransition) {
			// 在 Beautify 流程中调用，不需要额外快照（Beautify 已创建）
			await addWidthTransitionsAll(false);
		}

		try {
			const name = scope === 'all' ? 'Beautify (All) After' : 'Beautify (Selected) After';
			await createSnapshot(name);
		}
		catch { }

		eda.sys_Message?.showToastMessage('美化完成');
	}
	catch (e: any) {
		logError(e.message);
		eda.sys_Message?.showToastMessage(`Error: ${e.message}`);
	}
	finally {
		eda.sys_LoadingAndProgressBar?.destroyLoading?.();
	}
}
