import type { Point } from './math';
import { debugLog } from './logger';
import { dist, getAngleBetween, lerp } from './math';
import { getSettings } from './settings';
import { addTeardrops } from './teardrop';

// 存储撤销栈
interface UndoState {
	createdIds: string[];
	deletedPrimitives: any[];
}

// 使用全局对象存储撤销栈，防止模块热重载导致丢失
const GLOBAL_UNDO_KEY = '__JLC_EDA_SMOOTH_UNDO_STACK__';

// @ts-expect-error globalThis is available
if (typeof (globalThis as any)[GLOBAL_UNDO_KEY] === 'undefined') {
	// @ts-expect-error globalThis is available
	(globalThis as any)[GLOBAL_UNDO_KEY] = [];
}
// @ts-expect-error globalThis is available
const undoStack = (globalThis as any)[GLOBAL_UNDO_KEY] as UndoState[];

/**
 * 撤销上一次平滑操作
 */
export async function undoLastOperation() {
	if (undoStack.length === 0) {
		if (eda.sys_Message && typeof eda.sys_Message.showToastMessage === 'function') {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('没有可撤销的操作'));
		}
		return;
	}

	const state = undoStack.pop();
	if (!state)
		return;

	if (eda.sys_LoadingAndProgressBar) {
		if (typeof eda.sys_LoadingAndProgressBar.showLoading === 'function') {
			eda.sys_LoadingAndProgressBar.showLoading();
		}
	}

	try {
		// 1. 删除本次操作创建的新对象
		if (state.createdIds.length > 0) {
			debugLog(`[Undo] 删除新创建的对象: ${state.createdIds.length} 个`);
			try {
				// 尝试逐个删除，确保兼容性
				for (const id of state.createdIds) {
					// 尝试删除 Line 或 Arc
					// 由于Arc创建后也是图元，通常可以通过ID删除
					// 如果 delete 接受数组，我们这里简单起见还是逐一删除，或者分批
					await eda.pcb_PrimitiveLine.delete([id]);
					// 某些情况下可能需要 pcb_PrimitiveArc.delete? 假设通用
				}
			}
			catch (e: any) {
				debugLog(`[Undo] 删除新对象失败: ${e.message}`);
			}
		}

		// 2. 恢复被删除的旧对象
		if (state.deletedPrimitives.length > 0) {
			debugLog(`[Undo] 恢复旧对象: ${state.deletedPrimitives.length} 个`);
			for (const prim of state.deletedPrimitives) {
				try {
					if (prim.type === 'Line' || prim.type === 'Track') {
						await eda.pcb_PrimitiveLine.create(
							prim.net,
							prim.layer,
							prim.startX,
							prim.startY,
							prim.endX,
							prim.endY,
							prim.lineWidth,
						);
					}
					// Polyline暂未特殊处理，前面代码里Polyline已经被转成Line片段了
				}
				catch (e: any) {
					debugLog(`[Undo] 恢复对象失败: ${e.message}`);
				}
			}
		}

		if (eda.sys_Message)
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('撤销成功'));
	}
	catch (e: any) {
		if (eda.sys_Dialog)
			eda.sys_Dialog.showInformationMessage(`撤销失败: ${e.message}`, 'Undo Error');
	}
	finally {
		if (eda.sys_LoadingAndProgressBar && typeof eda.sys_LoadingAndProgressBar.destroyLoading === 'function') {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}

/**
 * 圆滑布线核心逻辑 (基于圆弧)
 */
export async function smoothRouting() {
	const settings = await getSettings();
	let tracks: any[] = [];

	const selected = await eda.pcb_SelectControl.getAllSelectedPrimitives();

	if (settings.debug) {
		debugLog('[Smooth Debug] 获取选中对象:', selected);
		debugLog('[Smooth Debug] 选中对象数量:', selected ? selected.length : 0);
		if (selected && selected.length > 0) {
			debugLog('[Smooth Debug] 第一个对象类型:', typeof selected[0]);
		}
	}

	if (!selected || !Array.isArray(selected) || selected.length === 0) {
		// 未选中任何对象时，处理全局布线
		if (settings.debug) {
			debugLog('[Smooth Debug] 无选中对象，获取全部导线');
		}
		tracks = await eda.pcb_PrimitiveLine.getAll();
	}
	else {
		// 处理选中的对象
		let primitives: any[] = [];
		if (typeof selected[0] === 'string') {
			for (const id of selected as unknown as string[]) {
				const p = await eda.pcb_PrimitiveLine.get(id);
				if (p)
					primitives.push(p);
			}
		}
		else {
			primitives = selected;
		}

		// 过滤支持的类型：Track, Line, Polyline
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

				return type === 'Line' || type === 'Track' || type === 'Polyline';
			},
		);

		if (settings.debug) {
			debugLog(`[Smooth Debug] 过滤后得到 ${filtered.length} 个对象`);
		}

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

					if (settings.debug) {
						debugLog(`[Smooth Debug] Polyline包含 ${coords.length / 2} 个点`);
					}

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

			if (settings.debug) {
				debugLog(`[Smooth Debug] 处理组: net=${net}, layer=${layer}, 包含 ${group.length} 条导线`);
			}

			// 改进的路径提取逻辑：找到所有连续路径
			const segs = group.map(t => ({
				p1: { x: t.getState_StartX(), y: t.getState_StartY() },
				p2: { x: t.getState_EndX(), y: t.getState_EndY() },
				width: t.getState_LineWidth(),
				id: t.getState_PrimitiveId(),
				track: t,
			}));

			// 构建邻接表
			const connections = new Map<string, typeof segs[0][]>();
			for (const seg of segs) {
				const key1 = `${seg.p1.x},${seg.p1.y}`;
				const key2 = `${seg.p2.x},${seg.p2.y}`;
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
				width: number;
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
					const lastKey = `${points[points.length - 1].x},${points[points.length - 1].y}`;
					const lastConns = connections.get(lastKey) || [];
					for (const seg of lastConns) {
						if (used.has(seg.id))
							continue;
						const nextKey1 = `${seg.p1.x},${seg.p1.y}`;
						const nextKey2 = `${seg.p2.x},${seg.p2.y}`;
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

					// 尝试从起点扩展
					if (!extended) {
						const firstKey = `${points[0].x},${points[0].y}`;
						const firstConns = connections.get(firstKey) || [];
						for (const seg of firstConns) {
							if (used.has(seg.id))
								continue;
							const nextKey1 = `${seg.p1.x},${seg.p1.y}`;
							const nextKey2 = `${seg.p2.x},${seg.p2.y}`;
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

				if (points.length >= 3) {
					paths.push({
						points,
						orderedSegs,
						width: startSeg.width,
					});
				}
			}

			if (settings.debug) {
				debugLog(`[Smooth Debug] 提取到 ${paths.length} 条路径`);
			}

			// 处理每条路径
			for (const path of paths) {
				const { points, orderedSegs, width } = path;

				if (settings.debug) {
					debugLog(`[Smooth Debug] 路径包含 ${points.length} 个点`);
				}

				if (points.length >= 3) {
					processedPaths++;
					let radius = settings.cornerRadius;
					if (settings.unit === 'mil') {
						radius = radius * 0.0254;
					}

					// 生成新的几何结构
					const newPath: {
						type: 'line' | 'arc';
						start: Point;
						end: Point;
						angle?: number;
					}[] = [];
					let currentStart = points[0];

					for (let i = 1; i < points.length - 1; i++) {
						const pPrev = points[i - 1];
						const pCorner = points[i];
						const pNext = points[i + 1];

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

						// 如果线段太短，必须缩小半径以适应
						const maxAllowedRadius = Math.min(mag1 * 0.45, mag2 * 0.45);
						const actualD = Math.min(d, maxAllowedRadius);

						// 如果实际切线距离显著小于理论距离 (小于 90%)，说明发生了缩放
						if (d > 0.001 && actualD < d * 0.9) {
							clampedCorners++;
						}

						if (settings.debug) {
							debugLog(`[Smooth Debug] Corner ${i}: Pos(${pCorner.x.toFixed(3)},${pCorner.y.toFixed(3)}) Mag1=${mag1.toFixed(3)} Mag2=${mag2.toFixed(3)} Angle=${(angleRad * 180 / Math.PI).toFixed(1)}° Radius=${radius} d=${d.toFixed(3)} actualD=${actualD.toFixed(3)}`);
						}

						// 只有当计算出的切线距离有效且足够大时，才生成圆弧
						// 增加一个最小阈值，比如 0.05 (假设单位是mm，则很小；如果是mil，则极小)
						if (actualD > 0.05) {
							const pStart = lerp(pCorner, pPrev, actualD / mag1);
							const pEnd = lerp(pCorner, pNext, actualD / mag2);

							// 添加 [当前起点 -> 切点1] 的直线
							newPath.push({
								type: 'line',
								start: currentStart,
								end: pStart,
							});

							// 计算 Arc 角度
							// 使用有符号角度
							const sweptAngle = getAngleBetween(
								{ x: -v1.x, y: -v1.y },
								{ x: v2.x, y: v2.y },
							);

							// 添加圆弧
							newPath.push({
								type: 'arc',
								start: pStart,
								end: pEnd,
								angle: sweptAngle,
							});

							createdArcs++;
							currentStart = pEnd;
						}
						else {
							// 无法圆滑（半径太大或角度不合适），保留原拐角
							if (settings.debug) {
								debugLog(`[Smooth Debug] Corner ${i} 无法圆滑，保持直角连接`);
							}
							newPath.push({
								type: 'line',
								start: currentStart,
								end: pCorner,
							});
							currentStart = pCorner;
						}
					}
					newPath.push({
						type: 'line',
						start: currentStart,
						end: points[points.length - 1],
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
							lineWidth: width,
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
						if (settings.debug)
							debugLog(`[Smooth Debug] 删除 Polyline: ${pIds.join(', ')}`);
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
							debugLog(`[Smooth Debug] 删除 Polyline 失败: ${e.message}`);
						}
					}

					// 删除 Line (逐个删除以确保成功)
					if (lineIdsToDelete.size > 0) {
						const lIds = Array.from(lineIdsToDelete);
						if (settings.debug)
							debugLog(`[Smooth Debug] 正在删除 ${lIds.length} 条 Line: ${lIds.join(', ')}`);

						for (const lid of lIds) {
							try {
								// 尝试传递数组包含单个ID
								await eda.pcb_PrimitiveLine.delete([lid]);
							}
							catch (e: any) {
								debugLog(`[Smooth Debug] 删除 Line ${lid} 失败: ${e.message}`);
							}
						}
					}

					// 第二步：创建新对象 并记录ID
					// const createdIds: string[] = []; // Modified for batch undo

					for (const item of newPath) {
						if (item.type === 'line') {
							// 只有长度 > 0 才创建
							if (dist(item.start, item.end) > 0.001) {
								if (settings.debug) {
									debugLog(`[Smooth Debug] 创建 Line: (${item.start.x},${item.start.y}) -> (${item.end.x},${item.end.y}) width=${width}`);
								}
								const res = await eda.pcb_PrimitiveLine.create(
									net,
									layer as any,
									item.start.x,
									item.start.y,
									item.end.x,
									item.end.y,
									width,
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
								else if (settings.debug) {
									debugLog(`[Smooth Debug] 警告: 无法获取新创建 Line 的 ID, Undo 可能失效. Res: ${typeof res}`);
								}
							}
						}
						else {
							// Arc
							if (settings.debug) {
								debugLog(`[Smooth Debug] 创建 Arc: start=(${item.start.x.toFixed(3)},${item.start.y.toFixed(3)}) end=(${item.end.x.toFixed(3)},${item.end.y.toFixed(3)}) angle=${item.angle?.toFixed(1)} width=${width}`);
							}
							const res = await eda.pcb_PrimitiveArc.create(
								net,
								layer as any,
								item.start.x,
								item.start.y,
								item.end.x,
								item.end.y,
								item.angle!,
								width,
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
							else if (settings.debug) {
								debugLog(`[Smooth Debug] 警告: 无法获取新创建 Arc 的 ID, Undo 可能失效. Res: ${typeof res}`);
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
		if (allCreatedIds.length > 0 || allDeletedPrimitives.length > 0) {
			if (settings.debug)
				debugLog(`[Smooth Debug] 保存批量撤销状态: Created=${allCreatedIds.length}, Deleted=${allDeletedPrimitives.length}`);
			undoStack.push({
				createdIds: allCreatedIds,
				deletedPrimitives: allDeletedPrimitives,
			});
		}

		if (
			eda.sys_Message
			&& typeof eda.sys_Message.showToastMessage === 'function'
		) {
			if (createdArcs > 0) {
				eda.sys_Message.showToastMessage(
					`${eda.sys_I18n.text('圆弧优化完成')}: ${eda.sys_I18n.text('处理了')} ${processedPaths} ${eda.sys_I18n.text('条路径')}, ${eda.sys_I18n.text('创建了')} ${createdArcs} ${eda.sys_I18n.text('个圆弧')}`,
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

		if (settings.syncTeardrops) {
			await addTeardrops();
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
			eda.sys_Dialog.showInformationMessage(e.message, 'Smooth Error');
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
