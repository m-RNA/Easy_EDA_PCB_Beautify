import { debugLog, logError, logWarn } from './logger';
import { getArcLineWidthMap, makeArcWidthKey } from './smooth';

const SNAPSHOT_STORAGE_KEY = 'jlc_eda_smooth_snapshots';

export interface RoutingSnapshot {
	id: number;
	name: string;
	timestamp: number;
	lines: any[];
	arcs: any[];
	// vias: any[]; // Vias removed to preserve network connectivity
}

/**
 * 获取所有快照
 */
export async function getSnapshots(): Promise<RoutingSnapshot[]> {
	try {
		const stored = await eda.sys_Storage.getExtensionUserConfig(SNAPSHOT_STORAGE_KEY);
		if (stored) {
			const snapshots = JSON.parse(stored);
			debugLog(`[Snapshot] Loaded ${snapshots.length} snapshots from storage`);
			// 打印前2个快照的基本信息
			snapshots.slice(0, 2).forEach((s: any, i: number) => {
				debugLog(`[Snapshot]   [${i}] id=${s.id}, name='${s.name}', lines=${s.lines?.length}, arcs=${s.arcs?.length}`);
				if (s.arcs?.length > 0) {
					debugLog(`[Snapshot]      First arc lineWidth: ${s.arcs[0].lineWidth}, arcAngle: ${s.arcs[0].arcAngle}`);
				}
			});
			return snapshots;
		}
	}
	catch (e: any) {
		logError(`Failed to load snapshots: ${e.message || e}`);
	}
	return [];
}

/**
 * 保存快照列表
 */
async function saveSnapshots(snapshots: RoutingSnapshot[]) {
	try {
		// 限制快照数量，例如最近 10 个
		if (snapshots.length > 10) {
			// 保留最新的 10 个
			snapshots.sort((a, b) => b.timestamp - a.timestamp);
			snapshots = snapshots.slice(0, 10);
		}
		await eda.sys_Storage.setExtensionUserConfig(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots));
	}
	catch (e: any) {
		logError(`Failed to save snapshots: ${e.message || e}`);
		if (eda.sys_Message) {
			eda.sys_Message.showToastMessage('快照保存失败，可能是数据过大');
		}
	}
}

/**
 * 创建当前布线状态的快照
 */
export async function createSnapshot(name: string = 'Auto Save'): Promise<RoutingSnapshot | null> {
	try {
		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.showLoading();
		}

		// 获取当前 PCB ID（用于区分多 PCB 工程）
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

		// 获取所有导线、圆弧
		// 注意：不保存过孔，以免恢复时丢失网络
		const lines = await eda.pcb_PrimitiveLine.getAll();
		const arcs = await eda.pcb_PrimitiveArc.getAll();
		// const vias = await eda.pcb_PrimitiveVia.getAll();

		// 提取必要数据以减小体积
		// 但是要能恢复，需保留所有创建所需的参数
		// 我们保存原始对象的数据结构，或者简化它
		// getAll 返回的是对象，我们需要序列化它
		// eda对象通常有 extract/getState 方法，或者就是 plain object?
		// 之前的代码中用 `getState_StartX()` 等，说明是 API 对象
		// 我们需要提取纯数据

		const extractData = (items: any[], type: 'line' | 'arc' | 'via') => {
			return items.map((p) => {
				const base = {
					net: p.getState_Net ? p.getState_Net() : p.net,
					layer: p.getState_Layer ? p.getState_Layer() : p.layer,
					id: p.getState_PrimitiveId ? p.getState_PrimitiveId() : p.primitiveId,
				};

				if (type === 'line') {
					const lineWidth = p.getState_LineWidth ? p.getState_LineWidth() : p.lineWidth;
					debugLog(`[Snapshot] Extracting line: lineWidth=${lineWidth}`);
					return {
						...base,
						startX: p.getState_StartX ? p.getState_StartX() : p.startX,
						startY: p.getState_StartY ? p.getState_StartY() : p.startY,
						endX: p.getState_EndX ? p.getState_EndX() : p.endX,
						endY: p.getState_EndY ? p.getState_EndY() : p.endY,
						lineWidth,
					};
				}
				else if (type === 'arc') {
					// Arc API actually supports getState_StartX/Y/EndX/Y/ArcAngle
					const arcAngle = p.getState_ArcAngle ? p.getState_ArcAngle() : p.arcAngle;
					const arcId = p.getState_PrimitiveId ? p.getState_PrimitiveId() : p.primitiveId;

					// 优先从全局 Map 获取线宽（因为 API 返回的值可能不正确）
					// 使用 pcbId_arcId 作为 key 以区分不同 PCB
					const arcWidthMap = getArcLineWidthMap();
					const mapKey = makeArcWidthKey(pcbId, arcId);
					let lineWidth = arcWidthMap.get(mapKey);

					debugLog(`[Snapshot] Arc key=${mapKey}, mapSize=${arcWidthMap.size}, lineWidth from map=${lineWidth}`);

					if (lineWidth === undefined) {
						// Map 中没有，尝试从 API 获取
						if (p.getState_LineWidth) {
							lineWidth = p.getState_LineWidth();
						}
						else if (p.lineWidth !== undefined) {
							lineWidth = p.lineWidth;
						}
					}

					return {
						...base,
						startX: p.getState_StartX ? p.getState_StartX() : p.startX,
						startY: p.getState_StartY ? p.getState_StartY() : p.startY,
						endX: p.getState_EndX ? p.getState_EndX() : p.endX,
						endY: p.getState_EndY ? p.getState_EndY() : p.endY,
						arcAngle,
						lineWidth: lineWidth ?? 0.254,
					};
				}
				else if (type === 'via') {
					return {
						...base,
						x: p.getState_X ? p.getState_X() : p.x,
						y: p.getState_Y ? p.getState_Y() : p.y,
						drill: p.getState_Drill ? p.getState_Drill() : p.drill,
						diameter: p.getState_Diameter ? p.getState_Diameter() : p.diameter,
						// vias usually have start/end layer too?
						// 简单起见假设是通孔或 API 能处理默认值
					};
				}
				return base;
			});
		};

		const snapshot: RoutingSnapshot = {
			id: Date.now(),
			name,
			timestamp: Date.now(),
			lines: extractData(lines || [], 'line'),
			arcs: extractData(arcs || [], 'arc'),
		};

		const snapshots = await getSnapshots();
		snapshots.push(snapshot);
		await saveSnapshots(snapshots);

		debugLog(`[Snapshot] Created snapshot '${name}' with ${snapshot.lines.length} lines, ${snapshot.arcs.length} arcs`);

		return snapshot;
	}
	catch (e: any) {
		logError(`[Snapshot] Create failed: ${e.message || e}`);
		if (eda.sys_Message)
			eda.sys_Message.showToastMessage(`创建快照失败: ${e.message}`);
		return null;
	}
	finally {
		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}

/**
 * 恢复快照
 */
export async function restoreSnapshot(snapshotId: number): Promise<boolean> {
	try {
		// 输出日志以便调试
		debugLog(`[Snapshot] Restoring snapshot with id: ${snapshotId}`);
		const snapshots = await getSnapshots();
		debugLog(`[Snapshot] Found ${snapshots.length} snapshots, ids: ${snapshots.map(s => s.id).join(', ')}`);

		const snapshot = snapshots.find(s => s.id === snapshotId);
		if (!snapshot) {
			logError(`[Snapshot] Snapshot not found with id: ${snapshotId}`);
			eda.sys_Message?.showToastMessage('未找到指定快照');
			return false;
		}

		debugLog(`[Snapshot] Found snapshot: name='${snapshot.name}', timestamp=${snapshot.timestamp}, lines=${snapshot.lines.length}, arcs=${snapshot.arcs.length}`);
		// 打印前 3 个圆弧的线宽
		if (snapshot.arcs.length > 0) {
			const sample = snapshot.arcs.slice(0, 3).map(a => `lineWidth=${a.lineWidth}`).join(', ');
			debugLog(`[Snapshot] Sample arc widths: ${sample}`);
		}

		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.showLoading();
		}

		// 1. 清除当前布线 (Line, Arc, Via)
		// 这一步比较危险，所以通常需要用户确认。但在 restoreSnapshot 函数内部我们假设已确认。
		debugLog('[Snapshot] Clearing current routing...');

		// 删除所有 Line
		const currentLines = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
		if (currentLines && currentLines.length > 0) {
			// 分批删除以防 ID 列表过大? API 能处理吗？
			// 假设能。
			await eda.pcb_PrimitiveLine.delete(currentLines);
		}

		// 删除所有 Arc
		const currentArcs = await eda.pcb_PrimitiveArc.getAllPrimitiveId();
		if (currentArcs && currentArcs.length > 0) {
			await eda.pcb_PrimitiveArc.delete(currentArcs);
		}

		// 删除所有 Via
		/*
		const currentVias = await eda.pcb_PrimitiveVia.getAllPrimitiveId();
		if (currentVias && currentVias.length > 0) {
			 await eda.pcb_PrimitiveVia.delete(currentVias);
		}
		*/
		// 2. 恢复快照中的对象
		debugLog('[Snapshot] Restoring objects...');

		// 恢复 Line
		for (const line of snapshot.lines) {
			try {
				// 确保 lineWidth 有值
				const lineWidth = line.lineWidth ?? 0.254;
				debugLog(`[Snapshot] Restoring line: (${line.startX},${line.startY})->(${line.endX},${line.endY}), lineWidth=${lineWidth}`);
				await eda.pcb_PrimitiveLine.create(
					line.net,
					line.layer,
					line.startX,
					line.startY,
					line.endX,
					line.endY,
					lineWidth,
				);
			}
			catch (e: any) {
				logWarn(`Failed to restore line: ${e.message || e}`);
			}
		}

		// 恢复 Arc
		// eda.pcb_PrimitiveArc.create(net, layer, startX, startY, endX, endY, arcAngle, lineWidth)
		for (const arc of snapshot.arcs) {
			try {
				// Arc 需要 startX/Y, endX/Y, arcAngle
				if (arc.startX !== undefined && arc.arcAngle !== undefined) {
					// 确保 lineWidth 有值，如果没有则使用默认值 0.254 (10mil)
					const lineWidth = arc.lineWidth ?? 0.254;
					debugLog(`[Snapshot] Restoring arc: startX=${arc.startX}, startY=${arc.startY}, arcAngle=${arc.arcAngle}, lineWidth=${lineWidth}`);
					await eda.pcb_PrimitiveArc.create(
						arc.net,
						arc.layer,
						arc.startX,
						arc.startY,
						arc.endX,
						arc.endY,
						arc.arcAngle,
						lineWidth,
					);
				}
				else {
					logWarn(`Cannot restore arc: missing required properties (startX/Y, endX/Y, or arcAngle)`);
				}
			}
			catch (e: any) {
				logWarn(`Failed to restore arc: ${e.message || e}`);
			}
		}

		if (eda.sys_Message)
			eda.sys_Message.showToastMessage('布线已恢复');
		return true;
	}
	catch (e: any) {
		logError(`[Snapshot] Restore failed: ${e.message || e}`);
		if (eda.sys_Message)
			eda.sys_Message.showToastMessage(`恢复快照失败: ${e.message}`);
		return false;
	}
	finally {
		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}

/**
 * 删除快照
 */
export async function deleteSnapshot(snapshotId: number) {
	let snapshots = await getSnapshots();
	snapshots = snapshots.filter(s => s.id !== snapshotId);
	await saveSnapshots(snapshots);
}

/**
 * 清空所有快照
 */
export async function clearSnapshots() {
	await saveSnapshots([]);
}
