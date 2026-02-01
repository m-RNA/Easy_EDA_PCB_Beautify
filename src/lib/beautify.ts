import type { Point } from './math';
import { getSafeSelectedTracks } from './eda_utils';
import { debugLog, debugWarn, logError } from './logger';
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

/**
 * 圆滑布线核心逻辑 (基于圆弧)
 */
/**
 * 平滑布线
 * @param scope 'selected' 只处理选中的导线, 'all' 处理所有导线
 */
export async function beautifyRouting(scope: 'selected' | 'all' = 'selected') {
	const settings = await getSettings();
	let tracks: any[] = [];

	if (scope === 'all') {
		// 处理所有导线
		debugLog('[Beautify] 处理所有导线');
		tracks = await eda.pcb_PrimitiveLine.getAll();
	}
	else {
		// 处理选中的导线
		// 使用 getAllSelectedPrimitives_PrimitiveId 获取选中的 ID 列表，更可靠
		const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();

		debugLog('[Beautify] 获取选中对象 ID:', selectedIds?.length || 0);

		if (!selectedIds || !Array.isArray(selectedIds) || selectedIds.length === 0) {
			// 未选中任何对象，提示用户
			eda.sys_Message?.showToastMessage(eda.sys_I18n ? eda.sys_I18n.text('请先选择要处理的导线') : '请先选择要处理的导线');
			if (eda.sys_LoadingAndProgressBar?.destroyLoading) {
				eda.sys_LoadingAndProgressBar.destroyLoading();
			}
			return;
		}

		// 通过 ID 列表获取导线对象
		// 使用安全获取函数处理混合选中
		const primitives = await getSafeSelectedTracks(selectedIds);

		debugLog(`[Beautify] 获取到 ${primitives.length} 个原始对象`);

		// 过滤支持的类型：Track, Line, Polyline 以及其他可能的线条类型
		// 同时包括没有网络的线条
		const supportedTypes = ['Line', 'Track', 'Polyline', 'Wire'];
		const filtered = primitives.filter(
			(p: any) => {
				if (!p)
					return false;
				let type = '';
				if (typeof p.getState_PrimitiveType === 'function') {
					type = p.getState_PrimitiveType();
				}
				else if (p.primitiveType) {
					type = p.primitiveType;
				}

				// 检查是否有线的基本属性 (StartX, EndX 等)
				const hasLineProps = (p.getState_StartX || p.startX !== undefined)
					&& (p.getState_EndX || p.endX !== undefined);

				return supportedTypes.includes(type) || hasLineProps;
			},
		);

		debugLog(`[Beautify] 过滤后得到 ${filtered.length} 个导线对象`);

		// 将Polyline转换为Line段
		for (const obj of filtered) {
			let type = '';
			if (typeof obj.getState_PrimitiveType === 'function') {
				type = obj.getState_PrimitiveType();
			}
			else if (obj.primitiveType) {
				type = obj.primitiveType;
			}

			if (type === 'Polyline') {
				// Polyline需要特殊处理：提取多边形点并转换为线段
				const polygon = obj.getState_Polygon ? obj.getState_Polygon() : (obj.polygon || null);
				if (polygon && polygon.polygon && Array.isArray(polygon.polygon)) {
					const coords = polygon.polygon.filter((v: any) => typeof v === 'number');
					const net = obj.getState_Net ? obj.getState_Net() : (obj.net || '');
					const layer = obj.getState_Layer ? obj.getState_Layer() : (obj.layer || 1);
					const lineWidth = obj.getState_LineWidth ? obj.getState_LineWidth() : (obj.lineWidth || 10);
					const primId = obj.getState_PrimitiveId ? obj.getState_PrimitiveId() : (obj.primitiveId || 'unknown');

					// 将Polyline的点转换为虚拟Track对象
					for (let i = 0; i < coords.length - 2; i += 2) {
						const x1 = coords[i];
						const y1 = coords[i + 1];
						const x2 = coords[i + 2];
						const y2 = coords[i + 3];

						tracks.push({
							getState_PrimitiveType: () => 'Line',
							getState_Net: () => net,
							getState_Layer: () => layer,
							getState_StartX: () => x1,
							getState_StartY: () => y1,
							getState_EndX: () => x2,
							getState_EndY: () => y2,
							getState_LineWidth: () => lineWidth,
							getState_PrimitiveId: () => `${primId}_seg${i / 2}`,
							_isPolylineSegment: true,
							_originalPolyline: obj,
						});
					}
				}
			}
			else {
				// Track 或 Line 直接添加
				tracks.push(obj);
			}
		}
	}

	if (tracks.length < 1) {
		if (
			eda.sys_Message
			&& typeof eda.sys_Message.showToastMessage === 'function'
		) {
			eda.sys_Message.showToastMessage(
				eda.sys_I18n.text('未找到可处理的导线'),
			);
		}
		return;
	}

	if (
		eda.sys_LoadingAndProgressBar
		&& typeof eda.sys_LoadingAndProgressBar.showLoading === 'function'
	) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	// 创建快照 (Undo 支持)
	try {
		const snapshotName = scope === 'all' ? 'Beautify (All)' : 'Beautify (Selected)';
		await createSnapshot(snapshotName);
	}
	catch (e: any) {
		logError(`Failed to create snapshot: ${e.message || e}`);
	}

	try {
		// 按网络和层分组
		const groups = new Map<string, any[]>();
		for (const track of tracks) {
			const net = track.getState_Net();
			const layer = track.getState_Layer();
			const key = `${net}#@#${layer}`;
			if (!groups.has(key))
				groups.set(key, []);
			groups.get(key)?.push(track);
		}

		let processedPaths = 0;
		let createdArcs = 0;
		let clampedCorners = 0;

		const allCreatedIds: string[] = [];
		const allDeletedPrimitives: any[] = [];

		for (const [key, group] of groups) {
			const [net, layer] = key.split('#@#');

			// 改进的路径提取逻辑：找到所有连续路径
			const segs = group.map(t => ({
				p1: { x: t.getState_StartX(), y: t.getState_StartY() },
				p2: { x: t.getState_EndX(), y: t.getState_EndY() },
				width: t.getState_LineWidth(),
				id: t.getState_PrimitiveId(),
				track: t,
			}));

			// 辅助函数：生成坐标键
			// 使用 3 位小数精度，与 widthTransition 保持一致，避免浮点数误差导致断连
			const pointKey = (p: { x: number; y: number }): string => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;

			// 构建邻接表
			const connections = new Map<string, typeof segs[0][]>();
			for (const seg of segs) {
				const key1 = pointKey(seg.p1);
				const key2 = pointKey(seg.p2);
				if (!connections.has(key1))
					connections.set(key1, []);
				if (!connections.has(key2))
					connections.set(key2, []);
				connections.get(key1)?.push(seg);
				connections.get(key2)?.push(seg);
			}

			// 提取所有连续路径
			const used = new Set<string>();
			interface PathData {
				points: Point[];
				orderedSegs: typeof segs[0][];
			}
			const paths: PathData[] = [];

			for (const startSeg of segs) {
				if (used.has(startSeg.id))
					continue;

				const points: Point[] = [startSeg.p1, startSeg.p2];
				const orderedSegs: typeof segs[0][] = [startSeg];
				used.add(startSeg.id);

				// 向两端扩展路径
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
					paths.push({
						points,
						orderedSegs,
					});
				}
			}

			// 处理每条路径
			for (const path of paths) {
				const { points, orderedSegs } = path;

				// 检查数据完整性
				if (!points || points.some(p => !p || typeof p.x !== 'number' || typeof p.y !== 'number')) {
					debugLog('[Beautify Error] Path contains invalid points, skipping');
					continue;
				}

				if (points.length >= 3) {
					processedPaths++;
					let radius = settings.cornerRadius;

					// JLC EDA API 的系统单位固定为 mil (SYS_Unit.getSystemDataUnit() -> MIL)
					// 因此所有坐标计算都必须基于 mil
					if (settings.unit === 'mm') {
						radius = eda.sys_Unit.mmToMil(radius); // mm -> mil
					}

					// 生成新的几何结构 - 每个元素包含自己的线宽
					const newPath: {
						type: 'line' | 'arc';
						start: Point;
						end: Point;
						angle?: number;
						width: number;
					}[] = [];
					let currentStart = points[0];

					for (let i = 1; i < points.length - 1; i++) {
						const pPrev = points[i - 1];
						const pCorner = points[i];
						const pNext = points[i + 1];

						// 获取前一线段和后一线段的线宽
						// orderedSegs[i-1] 是 点i-1 到 点i 的线段
						// orderedSegs[i] 是 点i 到 点i+1 的线段
						const prevSegWidth = orderedSegs[i - 1]?.width ?? orderedSegs[0].width;
						const nextSegWidth = orderedSegs[i]?.width ?? prevSegWidth;

						let isMerged = false;

						try {
							// 尝试合并短线段逻辑 (解决 U 型弯中间线段过短无法圆滑的问题)
							if (settings.mergeShortSegments && i < points.length - 2) {
								const pAfter = points[i + 2];
								// 额外检查 pAfter 是否存在
								if (pAfter) {
									const segLen = dist(pCorner, pNext);

									// 当中间线段长度小于圆角半径的 1.5 倍时尝试合并 (放宽条件，之前是 < radius)
									// 或者如果计算出的切线需求 distance 大于线段的一半，说明可能需要合并
									if (segLen < radius * 1.5) {
										const vIn = { x: pPrev.x - pCorner.x, y: pPrev.y - pCorner.y };
										const vMid = { x: pNext.x - pCorner.x, y: pNext.y - pCorner.y };
										const vOut = { x: pAfter.x - pNext.x, y: pAfter.y - pNext.y }; // 注意向量方向

										// 计算拐角方向
										// getAngleBetween 返回 v1 到 v2 的角度
										const angle1 = getAngleBetween({ x: -vIn.x, y: -vIn.y }, { x: vMid.x, y: vMid.y });
										// 修复：Angle2 也应该使用 "Forward Incoming" (vMid) 和 "Forward Outgoing" (vOut)
										const angle2 = getAngleBetween({ x: vMid.x, y: vMid.y }, { x: vOut.x, y: vOut.y });

										// 如果两个拐角同向 (乘积 > 0)，且角度不是极小
										// 放宽检测：允许轻微的S型如果角度很小？
										// 还是严格同向。
										if (angle1 * angle2 > 0 && Math.abs(angle1) > 1 && Math.abs(angle2) > 1) {
											// 计算两条长边的交点 (pPrev->pCorner 和 pNext->pAfter 的延长线交点)
											// 由于我们要用 pPrev 和 pAfter 作为远端点，这里传入延长线上的点即可
											const intersection = getLineIntersection(pPrev, pCorner, pNext, pAfter);

											if (intersection) {
												// 检查交点是否在合理范围内
												// 如果交点离 pCorner 或 pNext 极远，说明两线几乎平行，可能不适合硬合并
												const dInt1 = dist(intersection, pCorner);
												const dInt2 = dist(intersection, pNext);

												// 限制条件：交点距离不应超过线段长度的 10 倍，防止平行线产生的远交点
												if (dInt1 < segLen * 10 && dInt2 < segLen * 10) {
													// 找到了交点，尝试以交点为中心构建大圆弧
													const t_v1 = { x: pPrev.x - intersection.x, y: pPrev.y - intersection.y };
													const t_v2 = { x: pAfter.x - intersection.x, y: pAfter.y - intersection.y };
													const t_mag1 = Math.sqrt(t_v1.x ** 2 + t_v1.y ** 2);
													const t_mag2 = Math.sqrt(t_v2.x ** 2 + t_v2.y ** 2);

													// 计算夹角
													const t_dot = (t_v1.x * t_v2.x + t_v1.y * t_v2.y) / (t_mag1 * t_mag2);
													const t_safeDot = Math.max(-1, Math.min(1, t_dot));
													const t_angleRad = Math.acos(t_safeDot);

													// 计算几何限制半径 (防突起)
													// 我们只在半径非常大的情况下进行限制，
													// 并且限制条件不能太严格，否则会阻止切除短线段。
													// 策略：只有当 calculated radius 导致的 tangent distance
													// 使得圆弧过于 "远离" 桥接线段时才限制。
													// 实际上，t_maxAllowedRadius (限制在 leg length 95%) 已经是对 Bulge 最好的限制。
													// 之前的 t_limitRadius 基于 "distIM" (桥接线段深度) 是错误的，因为在合并时我们正是要消除这个深度。
													// 所以移除该限制。

													const t_tanVal = Math.tan(t_angleRad / 2);
													let t_d = 0;
													if (Math.abs(t_tanVal) > 0.0001) {
														t_d = radius / t_tanVal;
													}

													// 限制半径，防止吞噬掉太多的线段
													// t_mag1 和 t_mag2 是 交点到 pPrev/pAfter 的距离。
													// 如果圆弧太大，切点会超出 segs 的范围。
													const t_maxAllowedRadius = Math.min(t_mag1 * 0.95, t_mag2 * 0.95);
													const t_actualD = Math.min(t_d, t_maxAllowedRadius);

													let t_limitByWidth = false;

													// 用户要求：带线宽的检查
													// 如果合并后的圆弧有效半径小于线宽的一半，则不生成（防止自交/尖角）
													// t_actualD 是切线长度。Effective Radius = actualD * tan(theta/2)
													const t_effectiveRadius = t_actualD * Math.abs(t_tanVal);
													const t_maxLineWidth = Math.max(prevSegWidth, nextSegWidth); // 取较大线宽作为保守估计

													if (t_effectiveRadius < (t_maxLineWidth / 2) - 0.05) {
														t_limitByWidth = true;
														debugLog(`[Beautify Debug] Merge skipped on ${net}: Radius too small for width (Radius=${t_effectiveRadius.toFixed(2)}, Width=${t_maxLineWidth})`);
													}

													if (t_actualD > 0.05 && !t_limitByWidth) {
														const pStart = lerp(intersection, pPrev, t_actualD / t_mag1);
														const pEnd = lerp(intersection, pAfter, t_actualD / t_mag2);

														// 添加直线
														if (dist(currentStart, pStart) > 0.001) {
															newPath.push({
																type: 'line',
																start: currentStart,
																end: pStart,
																width: prevSegWidth,
															});
														}

														// 计算 Arc 角度
														const t_sweptAngle = getAngleBetween(
															{ x: -t_v1.x, y: -t_v1.y },
															{ x: t_v2.x, y: t_v2.y },
														);

														// 使用合并后的下一段线宽
														const afterSegWidth = orderedSegs[i + 1]?.width ?? nextSegWidth;

														newPath.push({
															type: 'arc',
															start: pStart,
															end: pEnd,
															angle: t_sweptAngle,
															width: afterSegWidth,
														});

														createdArcs++;
														currentStart = pEnd;

														// 成功合并，跳过下一个点
														i++;
														isMerged = true;

														// Log
														debugLog(`[Beautify] Merged short segment on ${net} at index ${i - 1}, segLen: ${segLen.toFixed(2)}, new radius usage: ${t_actualD.toFixed(2)}`);
													}
													else {
														debugLog(`[Beautify Info] Merge calc failed on ${net}. actualD too small (${t_actualD})`);
													}
												}
												else {
													debugLog(`[Beautify Debug] Merge skipped on ${net}: Intersection too far (dInt1=${dInt1.toFixed(2)}, dInt2=${dInt2.toFixed(2)}, limit=${(segLen * 10).toFixed(2)})`);
												}
											}
											else {
												debugLog(`[Beautify Debug] Merge skipped on ${net}: Lines Parallel or No Intersection`);
											}
										}
										else {
											debugLog(`[Beautify Debug] Merge skipped on ${net}: Angles not suitable for U-turn (angle1=${angle1.toFixed(1)}, angle2=${angle2.toFixed(1)})`);
										}
									}
								}
							}
						}
						catch (err: any) {
							logError(`[Beautify Error] Merge logic failed at index ${i} on ${net}: ${err.message}`);
							// fall through to normal logic
						}

						if (!isMerged) {
							// 计算导线之间的角度
							const v1 = {
								x: pPrev.x - pCorner.x,
								y: pPrev.y - pCorner.y,
							};
							const v2 = {
								x: pNext.x - pCorner.x,
								y: pNext.y - pCorner.y,
							};

							const mag1 = Math.sqrt(v1.x ** 2 + v1.y ** 2);
							const mag2 = Math.sqrt(v2.x ** 2 + v2.y ** 2);

							// 夹角计算
							const dot = (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2);
							// 限制 dot 范围防止数值误差
							const safeDot = Math.max(-1, Math.min(1, dot));
							const angleRad = Math.acos(safeDot);

							// 计算切点距离
							// d = R / tan(angle / 2)
							// 当角度接近 180度 (PI) 时，tan(PI/2) -> Inf, d -> 0
							// 当角度接近 0度 (0) 时，tan(0) -> 0, d -> Inf
							const tanVal = Math.tan(angleRad / 2);
							let d = 0;
							if (Math.abs(tanVal) > 0.0001) {
								d = radius / tanVal;
							}

							// 如果线段太短，必须缩小半径以适应 (max limit 45% of seg length)
							const maxAllowedRadius = Math.min(mag1 * 0.45, mag2 * 0.45);
							const actualD = Math.min(d, maxAllowedRadius);

							let isSkippedDueToClamp = false;

							// 1. 检查线段长度限制
							// 如果实际切线距离显著小于理论距离 (小于 95%)，说明发生了严重缩放
							// 用户要求：若线段太短使得一侧不能相切时，不生成圆弧，只打印警告
							// 新增 Force Arc 选项：如果开启，则强制生成（接受缩放后的半径），否则跳过
							if (d > 0.001 && actualD < d * 0.95) {
								if (settings.forceArc) {
									// 强制模式：仅记录调试日志，不跳过
									debugLog(`[Beautify Debug] Corner at (${pCorner.x.toFixed(2)}, ${pCorner.y.toFixed(2)}) clamped. Req: ${d.toFixed(2)}, Act: ${actualD.toFixed(2)}`);
								}
								else {
									clampedCorners++;
									isSkippedDueToClamp = true;
									// 使用 debugWarn 避免给用户不可靠的感觉
									debugWarn(`[Beautify Warning] Corner at (${pCorner.x.toFixed(2)}, ${pCorner.y.toFixed(2)}) [Net: ${net || 'No Net'}] skipped. Segment too short for radius. Req: ${d.toFixed(2)}, Act: ${actualD.toFixed(2)}`);
								}
							}

							// 2. 检查线宽限制 (线宽过大导致内圆弧半径为负或不相切)
							if (!isSkippedDueToClamp) {
								const effectiveRadius = actualD * Math.abs(tanVal);
								const maxLineWidth = Math.max(prevSegWidth, nextSegWidth);
								// 内侧半径 = 中心半径 - 线宽/2
								// 允许内侧半径为 0 (即尖角)，但不能为负
								// 必须保证 effectiveRadius >= maxLineWidth / 2
								// 使用一个微小的容差 (0.05) 以允许浮点数误差范围内的 "Radius == Width/2"
								if (effectiveRadius < (maxLineWidth / 2) - 0.05) {
									isSkippedDueToClamp = true;
									debugWarn(`[Beautify Warning] Corner at (${pCorner.x.toFixed(2)}, ${pCorner.y.toFixed(2)}) [Net: ${net || 'No Net'}] skipped. Radius too small for line width. Radius: ${effectiveRadius.toFixed(2)}, Width: ${maxLineWidth}`);
								}
							}

							// 只有当计算出的切线距离有效且足够大时，才生成圆弧
							if (actualD > 0.05 && !isSkippedDueToClamp) {
								const pStart = lerp(pCorner, pPrev, actualD / mag1);
								const pEnd = lerp(pCorner, pNext, actualD / mag2);

								// 添加 [当前起点 -> 切点1] 的直线，使用前一段的线宽
								newPath.push({
									type: 'line',
									start: currentStart,
									end: pStart,
									width: prevSegWidth,
								});

								// 计算 Arc 角度
								// 使用有符号角度
								const sweptAngle = getAngleBetween(
									{ x: -v1.x, y: -v1.y },
									{ x: v2.x, y: v2.y },
								);

								// 添加圆弧，使用后一段的线宽（与下一段线连接更自然）
								const arcWidth = nextSegWidth;
								newPath.push({
									type: 'arc',
									start: pStart,
									end: pEnd,
									angle: sweptAngle,
									width: arcWidth,
								});

								createdArcs++;
								currentStart = pEnd;
							}
							else {
								// 无法圆滑（半径太大或角度不合适），保留原拐角
								newPath.push({
									type: 'line',
									start: currentStart,
									end: pCorner,
									width: prevSegWidth,
								});
								currentStart = pCorner;

								// Log failure
								if (!isSkippedDueToClamp && eda.sys_Log && typeof eda.sys_Log.add === 'function') {
									eda.sys_Log.add(`[Beautify Info] Corner at (${pCorner.x.toFixed(2)}, ${pCorner.y.toFixed(2)}) skipped. Angle or Radius invalid. actualD=${actualD.toFixed(3)}`);
								}
							}
						}
					}

					// 最后一段直线，使用最后一个线段的线宽
					const lastSegWidth = orderedSegs[orderedSegs.length - 1]?.width ?? orderedSegs[0].width;
					newPath.push({
						type: 'line',
						start: currentStart,
						end: points[points.length - 1],
						width: lastSegWidth,
					});

					// 准备工作：计算所有需要删除的ID
					const polylineIdsToDelete = new Set<string>();
					const lineIdsToDelete = new Set<string>();
					const backupPrimitives: any[] = [];

					// 始终执行替换逻辑 (用户期望剪短原线)
					for (const seg of orderedSegs) {
						// 备份数据
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
							let originalId = '';
							if (typeof seg.track._originalPolyline.getState_PrimitiveId === 'function') {
								originalId = seg.track._originalPolyline.getState_PrimitiveId();
							}
							else if (seg.track._originalPolyline.primitiveId) {
								originalId = seg.track._originalPolyline.primitiveId;
							}
							if (originalId) {
								polylineIdsToDelete.add(originalId);
							}
						}
						else {
							// 是普通 Line / Track
							lineIdsToDelete.add(seg.id);
						}
					}

					// 第一步：先删除旧对象
					// 删除 Polyline
					if (polylineIdsToDelete.size > 0) {
						const pIds = Array.from(polylineIdsToDelete);
						try {
							const pcbApi = eda as any;
							if (pcbApi.pcb_PrimitivePolyline && typeof pcbApi.pcb_PrimitivePolyline.delete === 'function') {
								// 尝试逐个删除
								for (const pid of pIds) {
									await pcbApi.pcb_PrimitivePolyline.delete([pid]);
								}
							}
							else {
								for (const pid of pIds) {
									await eda.pcb_PrimitiveLine.delete([pid]);
								}
							}
						}
						catch (e: any) {
							debugLog(`[Beautify Debug] 删除 Polyline 失败: ${e.message}`);
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
							catch (e: any) {
								debugLog(`[Beautify Debug] 删除 Line ${lid} 失败: ${e.message}`);
							}
						}
					}

					// 第二步：创建新对象 并记录ID
					// const createdIds: string[] = []; // Modified for batch undo

					for (const item of newPath) {
						if (item.type === 'line') {
							// 只有长度 > 0 才创建
							if (dist(item.start, item.end) > 0.001) {
								const res = await eda.pcb_PrimitiveLine.create(
									net,
									layer as any,
									item.start.x,
									item.start.y,
									item.end.x,
									item.end.y,
									item.width,
								);

								// 尝试获取ID
								let newId: string | null = null;
								if (typeof res === 'string')
									newId = res;
								else if (res && typeof (res as any).id === 'string')
									newId = (res as any).id;
								else if (res && typeof (res as any).primitiveId === 'string')
									newId = (res as any).primitiveId;
								else if (res && typeof (res as any).getState_PrimitiveId === 'function')
									newId = (res as any).getState_PrimitiveId();

								if (newId) {
									allCreatedIds.push(newId);
								}
							}
						}
						else {
							// Arc
							const res = await eda.pcb_PrimitiveArc.create(
								net,
								layer as any,
								item.start.x,
								item.start.y,
								item.end.x,
								item.end.y,
								item.angle!,
								item.width,
							);

							// 尝试获取ID
							let newId: string | null = null;
							if (typeof res === 'string')
								newId = res;
							else if (res && typeof (res as any).id === 'string')
								newId = (res as any).id;
							else if (res && typeof (res as any).primitiveId === 'string')
								newId = (res as any).primitiveId;
							else if (res && typeof (res as any).getState_PrimitiveId === 'function')
								newId = (res as any).getState_PrimitiveId();

							if (newId) {
								allCreatedIds.push(newId);
								// 保存圆弧的正确线宽到全局 Map（带 PCB ID 区分）
								let pcbId = 'unknown';
								try {
									const boardInfo = await eda.dmt_Board.getCurrentBoardInfo();
									if (boardInfo && boardInfo.pcb && boardInfo.pcb.uuid) {
										pcbId = boardInfo.pcb.uuid;
									}
								}
								catch {
									// ignore
								}
								const mapKey = makeArcWidthKey(pcbId, newId);
								getArcLineWidthMap().set(mapKey, item.width);
							}
						}
					}

					// 收集删除的对象到全局列表
					if (backupPrimitives.length > 0) {
						allDeletedPrimitives.push(...backupPrimitives);
					}
				}
			}
		}

		// 批量保存到撤销栈
		// if (allCreatedIds.length > 0 || allDeletedPrimitives.length > 0) {
		// ... replaced by snapshot system
		// }

		if (
			eda.sys_Message
			&& typeof eda.sys_Message.showToastMessage === 'function'
		) {
			if (createdArcs > 0) {
				eda.sys_Message.showToastMessage(
					`${eda.sys_I18n.text('圆弧美化完成')}: ${eda.sys_I18n.text('处理了')} ${processedPaths} ${eda.sys_I18n.text('条路径')}, ${eda.sys_I18n.text('创建了')} ${createdArcs} ${eda.sys_I18n.text('个圆弧')}`,
				);

				if (clampedCorners > 0) {
					setTimeout(() => {
						if (eda.sys_Message) {
							eda.sys_Message.showToastMessage(
								`注意: 有 ${clampedCorners} 个拐角的半径因导线过短被自动缩小`,
							);
						}
					}, 2000); // 稍微延迟显示警告
				}
			}
			else {
				eda.sys_Message.showToastMessage(
					eda.sys_I18n.text('未找到可以圆滑的拐角（需要至少2条连续导线形成拐角）'),
				);
			}
		}

		if (settings.syncWidthTransition) {
			// 在 Beautify 流程中调用，不需要额外快照（Beautify 已创建）
			await addWidthTransitionsAll(false);
		}
	}
	catch (e: any) {
		if (eda.sys_Log && typeof eda.sys_Log.add === 'function') {
			eda.sys_Log.add(e.message);
		}
		if (
			eda.sys_Dialog
			&& typeof eda.sys_Dialog.showInformationMessage === 'function'
		) {
			eda.sys_Dialog.showInformationMessage(e.message, 'Beautify Error');
		}
	}
	finally {
		if (
			eda.sys_LoadingAndProgressBar
			&& typeof eda.sys_LoadingAndProgressBar.destroyLoading === 'function'
		) {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}
