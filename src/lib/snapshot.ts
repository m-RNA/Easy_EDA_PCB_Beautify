import { getArcLineWidthMap, makeArcWidthKey } from './beautify';
import { debugLog, logError, logWarn } from './logger';
import { isClose } from './math';

const SNAPSHOT_STORAGE_KEY = 'jlc_eda_beautify_snapshots';

// 内存缓存 key，挂载在 eda 对象上
const CACHE_KEY = '_jlc_beautify_snapshots_cache';
// 回调 key
const CALLBACK_KEY = '_jlc_beautify_snapshot_callback';
// 记录上一次撤销恢复到的快照ID
const LAST_RESTORED_KEY = '_jlc_beautify_last_restored_id';
// 撤销锁 Key
const UNDO_LOCK_KEY = '_jlc_beautify_undo_lock';

export function getLastRestoredId(): number | null {
	return (eda as any)[LAST_RESTORED_KEY] ?? null;
}

function setLastRestoredId(id: number | null) {
	(eda as any)[LAST_RESTORED_KEY] = id;
}

function isUndoing(): boolean {
	return !!(eda as any)[UNDO_LOCK_KEY];
}

function setUndoing(val: boolean) {
	(eda as any)[UNDO_LOCK_KEY] = val;
}

/**
 * 注册快照变化回调
 * 注意：回调存储在 eda 全局对象上，以支持跨上下文调用
 */
export function registerSnapshotChangeCallback(cb: () => void) {
	(eda as any)[CALLBACK_KEY] = cb;
}

/**
 * 通知设置界面快照列表已变化
 */
function notifySnapshotChange() {
	// 优先使用注册到 eda 全局对象的回调
	const registeredCallback = (eda as any)[CALLBACK_KEY];
	if (typeof registeredCallback === 'function') {
		try {
			registeredCallback();
			return;
		}
		catch (e) {
			logError(`UI callback failed: ${e}`, 'Snapshot');
		}
	}

	// Fallback to global property (兼容旧版)
	const callback = (eda as any)._onSnapshotChange;
	if (typeof callback === 'function') {
		try {
			callback();
		}
		catch (e) {
			logError(`Global callback failed: ${e}`, 'Snapshot');
		}
	}
}

export interface RoutingSnapshot {
	id: number;
	name: string;
	timestamp: number;
	lines: any[];
	arcs: any[];
	// vias: any[]; // Vias removed to preserve network connectivity
}

export const SNAPSHOT_LIMIT = 20;

/**
 * 获取所有快照
 */
export async function getSnapshots(): Promise<RoutingSnapshot[]> {
	// 优先返回 eda 全局对象上的缓存
	const cached = (eda as any)[CACHE_KEY];
	if (Array.isArray(cached)) {
		return [...cached];
	}

	try {
		const stored = await eda.sys_Storage.getExtensionUserConfig(SNAPSHOT_STORAGE_KEY);
		if (stored) {
			const snapshots = JSON.parse(stored);
			(eda as any)[CACHE_KEY] = snapshots;
			return snapshots;
		}
	}
	catch (e: any) {
		logError(`Failed to load snapshots: ${e.message || e}`);
	}

	(eda as any)[CACHE_KEY] = [];
	return [];
}

/**
 * 保存快照列表
 */
async function saveSnapshots(snapshots: RoutingSnapshot[]) {
	try {
		// 始终按时间倒序排列 (最新的在前)
		snapshots.sort((a, b) => b.timestamp - a.timestamp);

		// 限制快照数量
		if (snapshots.length > SNAPSHOT_LIMIT) {
			snapshots = snapshots.slice(0, SNAPSHOT_LIMIT);
		}

		// 更新全局缓存 (安全写入)
		try {
			if (typeof eda === 'object' && eda !== null) {
				(eda as any)[CACHE_KEY] = [...snapshots];
			}
		}
		catch (cacheErr) {
			logWarn(`Failed to update cache: ${cacheErr}`, 'Snapshot');
		}

		await eda.sys_Storage.setExtensionUserConfig(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots));
	}
	catch (e: any) {
		logError(`Failed to save snapshots: ${e.message || e}`);
	}
}

// 辅助函数：比较 Line 是否一致
function isLineEqual(a: any, b: any) {
	if (a.layer !== b.layer || a.net !== b.net)
		return false;
	if (!isClose(a.startX, b.startX))
		return false;
	if (!isClose(a.startY, b.startY))
		return false;
	if (!isClose(a.endX, b.endX))
		return false;
	if (!isClose(a.endY, b.endY))
		return false;
	if (!isClose(a.lineWidth, b.lineWidth))
		return false;
	return true;
}

// 辅助函数：比较 Arc 是否一致
function isArcEqual(a: any, b: any) {
	if (a.layer !== b.layer || a.net !== b.net)
		return false;
	if (!isClose(a.startX, b.startX))
		return false;
	if (!isClose(a.startY, b.startY))
		return false;
	if (!isClose(a.endX, b.endX))
		return false;
	if (!isClose(a.endY, b.endY))
		return false;
	if (!isClose(a.arcAngle, b.arcAngle))
		return false;
	if (!isClose(a.lineWidth, b.lineWidth))
		return false;
	return true;
}

// 辅助函数：提取图元数据
function extractPrimitiveData(items: any[], type: 'line' | 'arc', pcbId: string) {
	return items.map((p) => {
		const base = {
			net: p.getState_Net ? p.getState_Net() : p.net,
			layer: p.getState_Layer ? p.getState_Layer() : p.layer,
			id: p.getState_PrimitiveId ? p.getState_PrimitiveId() : p.primitiveId,
		};

		if (type === 'line') {
			const lineWidth = p.getState_LineWidth ? p.getState_LineWidth() : p.lineWidth;
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
			const arcAngle = p.getState_ArcAngle ? p.getState_ArcAngle() : p.arcAngle;
			const arcId = base.id;

			// Priority: Global Map -> API -> Property
			const arcWidthMap = getArcLineWidthMap();
			const mapKey = makeArcWidthKey(pcbId, arcId);
			let lineWidth = arcWidthMap.get(mapKey);

			if (lineWidth === undefined) {
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
		return base;
	});
}

/**
 * 创建当前布线状态的快照
 */
export async function createSnapshot(name: string = 'Auto Save'): Promise<RoutingSnapshot | null> {
	try {
		// 任何新的操作都应该重置撤销指针，因为历史分支改变了
		const lastId = getLastRestoredId();
		if (lastId !== null) {
			setLastRestoredId(null);
		}

		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.showLoading();
		}

		// 获取当前 PCB Info
		let pcbId = 'unknown';
		let pcbTitle = '';
		try {
			// 先尝试获取当前 PCB 信息
			const pcbInfo = await eda.dmt_Pcb.getCurrentPcbInfo();
			if (pcbInfo) {
				pcbTitle = pcbInfo.name;
				pcbId = pcbInfo.uuid;
			}
			else {
				// 获取板子信息作为备选
				const boardInfo = await eda.dmt_Board.getCurrentBoardInfo();
				if (boardInfo) {
					pcbTitle = boardInfo.pcb?.name || boardInfo.name;
					if (boardInfo.pcb) {
						pcbId = boardInfo.pcb.uuid;
					}
				}
			}
		}
		catch (e: any) {
			logWarn(`Failed to get board info: ${e.message || e}`, 'Snapshot');
		}

		// 自动附加 PCB 名称前缀
		let finalName = name;
		if (pcbTitle) {
			finalName = `[${pcbTitle}] ${name}`;
		}

		// 获取所有导线、圆弧
		const lines = await eda.pcb_PrimitiveLine.getAll();
		const arcs = await eda.pcb_PrimitiveArc.getAll();

		const snapshot: RoutingSnapshot = {
			id: Date.now(),
			name: finalName,
			timestamp: Date.now(),
			lines: extractPrimitiveData(lines || [], 'line', pcbId),
			arcs: extractPrimitiveData(arcs || [], 'arc', pcbId),
		};

		const snapshots = await getSnapshots();
		snapshots.push(snapshot);
		await saveSnapshots(snapshots);

		// 通知设置界面刷新
		notifySnapshotChange();

		return snapshot;
	}
	catch (e: any) {
		logError(`Create failed: ${e.message || e}`, 'Snapshot');
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
 * 恢复快照 (差分恢复)
 * 只修改变化的部分，避免全图重绘
 * @param snapshotId 快照 ID
 * @param showToast 是否显示详细的恢复结果提示 (Undo 操作时通常关闭，使用自定义提示)
 */
export async function restoreSnapshot(snapshotId: number, showToast: boolean = true): Promise<boolean> {
	try {
		const snapshots = await getSnapshots();

		const snapshot = snapshots.find(s => s.id === snapshotId);
		if (!snapshot) {
			logError(`Snapshot not found with id: ${snapshotId}`, 'Snapshot');
			eda.sys_Message?.showToastMessage('未找到指定快照');
			return false;
		}

		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.showLoading();
		}

		// 获取当前 PCB Info 用于数据提取
		let pcbId = 'unknown';
		try {
			const pcbInfo = await eda.dmt_Pcb.getCurrentPcbInfo();
			if (pcbInfo) {
				pcbId = pcbInfo.uuid;
			}
			else {
				const boardInfo = await eda.dmt_Board.getCurrentBoardInfo();
				if (boardInfo && boardInfo.pcb) {
					pcbId = boardInfo.pcb.uuid;
				}
			}
		}
		catch { /* ignore */ }

		// 1. 获取当前画板的所有 Line 和 Arc
		const currentLinesRaw = await eda.pcb_PrimitiveLine.getAll();
		const currentArcsRaw = await eda.pcb_PrimitiveArc.getAll();

		// 转换数据格式
		const currentLines = extractPrimitiveData(currentLinesRaw || [], 'line', pcbId);
		const currentArcs = extractPrimitiveData(currentArcsRaw || [], 'arc', pcbId);

		// 2. 比较差异: Line
		const currentLineMap = new Map(currentLines.map(l => [l.id, l]));
		const linesToDelete: string[] = [];
		const linesToCreate: any[] = [];

		for (const snapLine of snapshot.lines) {
			if (currentLineMap.has(snapLine.id)) {
				const current = currentLineMap.get(snapLine.id);
				// 比较属性
				if (isLineEqual(snapLine, current)) {
					// 完全一致，保留（从 Map 移除表示不需要删除）
					currentLineMap.delete(snapLine.id);
				}
				else {
					// 不一致（被修改过），需要删除旧的，创建新的
					linesToDelete.push(snapLine.id);
					linesToCreate.push(snapLine);
					currentLineMap.delete(snapLine.id);
				}
			}
			else {
				// Snapshot 中有，但当前画布没有 -> 需要创建
				linesToCreate.push(snapLine);
			}
		}

		// Current Map 中剩余的，是 Current 有但 Snapshot 没有的 -> 需要删除
		for (const id of currentLineMap.keys()) {
			linesToDelete.push(id);
		}

		// 3. 比较差异: Arc
		const currentArcMap = new Map(currentArcs.map(a => [a.id, a]));
		const arcsToDelete: string[] = [];
		const arcsToCreate: any[] = [];

		for (const snapArc of snapshot.arcs) {
			if (currentArcMap.has(snapArc.id)) {
				const current = currentArcMap.get(snapArc.id);
				if (isArcEqual(snapArc, current)) {
					currentArcMap.delete(snapArc.id);
				}
				else {
					arcsToDelete.push(snapArc.id);
					arcsToCreate.push(snapArc);
					currentArcMap.delete(snapArc.id);
				}
			}
			else {
				arcsToCreate.push(snapArc);
			}
		}

		for (const id of currentArcMap.keys()) {
			arcsToDelete.push(id);
		}

		debugLog(`Diff result:
          Line: Delete ${linesToDelete.length}, Create ${linesToCreate.length}
          Arc:  Delete ${arcsToDelete.length}, Create ${arcsToCreate.length}`, 'Snapshot');

		// 4. 执行操作
		// Delete
		if (linesToDelete.length > 0) {
			await eda.pcb_PrimitiveLine.delete(linesToDelete);
		}
		if (arcsToDelete.length > 0) {
			await eda.pcb_PrimitiveArc.delete(arcsToDelete);
		}

		// Create Lines
		for (const line of linesToCreate) {
			try {
				const lineWidth = line.lineWidth ?? 0.254;
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
				logWarn(`Failed to restore line: ${e}`);
			}
		}

		// Create Arcs
		for (const arc of arcsToCreate) {
			try {
				if (arc.startX !== undefined && arc.arcAngle !== undefined) {
					const lineWidth = arc.lineWidth ?? 0.254;
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
			}
			catch (e: any) {
				logWarn(`Failed to restore arc: ${e}`);
			}
		}

		if (showToast && eda.sys_Message)
			eda.sys_Message.showToastMessage(`布线已恢复 (Line: -${linesToDelete.length}/+${linesToCreate.length}, Arc: -${arcsToDelete.length}/+${arcsToCreate.length})`);

		// 更新最后一次恢复的 ID
		setLastRestoredId(snapshot.id);
		// 通知 UI
		notifySnapshotChange();

		return true;
	}
	catch (e: any) {
		logError(`Restore failed: ${e.message || e}`, 'Snapshot');
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
	notifySnapshotChange();
}

/**
 * 清空所有快照
 */
export async function clearSnapshots() {
	await saveSnapshots([]);
	notifySnapshotChange();
}

/**
 * 撤销上一次操作 (通过恢复快照)
 * 查找最新的快照并恢复，不会删除快照
 */
export async function undoLastOperation() {
	if (isUndoing())
		return;
	setUndoing(true);

	if (eda.sys_LoadingAndProgressBar?.showLoading) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	try {
		const snapshots = await getSnapshots();

		if (snapshots.length === 0) {
			eda.sys_Message?.showToastMessage('没有可撤销的操作');
			return;
		}

		let targetSnapshot: RoutingSnapshot | undefined;
		const lastRestoredId = getLastRestoredId();

		if (lastRestoredId === null) {
			// First step: try to restore the previous snapshot (Index 1)
			if (snapshots.length > 1) {
				targetSnapshot = snapshots[1];
			}
			else {
				// If only one snapshot exists, restore it (undoing un-snapshotted changes)
				targetSnapshot = snapshots[0];
			}
		}
		else {
			// Continuing from history
			const currentIndex = snapshots.findIndex(s => s.id === lastRestoredId);

			if (currentIndex === -1) {
				// ID not found, reset to latest
				targetSnapshot = snapshots[0];
			}
			else if (currentIndex + 1 < snapshots.length) {
				// Next older snapshot
				targetSnapshot = snapshots[currentIndex + 1];
			}
			else {
				eda.sys_Message?.showToastMessage('已经是最早的快照了');
				return;
			}
		}

		if (targetSnapshot) {
			const success = await restoreSnapshot(targetSnapshot.id, false);

			if (success) {
				const msg = eda.sys_I18n ? eda.sys_I18n.text('已撤销') : 'Undone';
				let dispName = targetSnapshot.name.replace(/^\[.*?\]\s*/, '');
				if (eda.sys_I18n && eda.sys_I18n.text(dispName) !== dispName) {
					dispName = eda.sys_I18n.text(dispName);
				}

				if (eda.sys_Message) {
					eda.sys_Message.showToastMessage(`${msg}: ${dispName}`);
				}
			}
		}
	}
	catch (e: any) {
		if (eda.sys_Dialog)
			eda.sys_Dialog.showInformationMessage(`撤销失败: ${e.message}`, 'Undo Error');
	}
	finally {
		setUndoing(false);
		if (eda.sys_LoadingAndProgressBar?.destroyLoading) {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}
