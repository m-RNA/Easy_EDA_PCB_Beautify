import { getArcLineWidthMap, makeArcWidthKey } from './beautify';
import { debugLog, logError, logWarn } from './logger';
import { isClose } from './math';

const SNAPSHOT_STORAGE_KEY_V2 = 'jlc_eda_beautify_snapshots_v2';
// 内存缓存 key，挂载在 eda 对象上
const CACHE_KEY_V2 = '_jlc_beautify_snapshots_cache_v2';
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
		}
		catch (e) {
			logError(`UI callback failed: ${e}`, 'Snapshot');
		}
	}
}

export interface RoutingSnapshot {
	id: number;
	name: string;
	timestamp: number;
	pcbId?: string; // 仍然保留，以备不时之需
	lines: any[];
	arcs: any[];
	isManual?: boolean;
}

interface PcbSnapshotStorage {
	manual: RoutingSnapshot[];
	auto: RoutingSnapshot[];
}

interface SnapshotStorageV2 {
	[pcbId: string]: PcbSnapshotStorage;
}

export const SNAPSHOT_LIMIT = 20;

/**
 * 获取目前的快照存储结构 (完整)
 */
async function getStorageData(): Promise<SnapshotStorageV2> {
	// 1. 尝试从全局缓存读取
	const cached = (eda as any)[CACHE_KEY_V2] as SnapshotStorageV2;
	if (cached && typeof cached === 'object') {
		return cached;
	}

	// 2. 从 storage 读取
	try {
		const stored = await eda.sys_Storage.getExtensionUserConfig(SNAPSHOT_STORAGE_KEY_V2);
		if (stored) {
			const data = JSON.parse(stored);
			// 更新 cache
			(eda as any)[CACHE_KEY_V2] = data;
			return data;
		}
	}
	catch (e: any) {
		logError(`Failed to load snapshots v2: ${e.message || e}`);
	}

	// 3. 返回空对象
	const empty = {};
	(eda as any)[CACHE_KEY_V2] = empty;
	return empty;
}

/**
 * 保存完整的快照存储
 */
async function saveStorageData(data: SnapshotStorageV2) {
	try {
		// Update cache
		(eda as any)[CACHE_KEY_V2] = data;
		// Persist
		await eda.sys_Storage.setExtensionUserConfig(SNAPSHOT_STORAGE_KEY_V2, JSON.stringify(data));
	}
	catch (e: any) {
		logError(`Failed to save snapshots v2: ${e.message || e}`);
	}
}

/**
 * 获取指定 PCB 的快照列表
 * @param pcbId PCB UUID
 * @param type 'manual' | 'auto' | undefined (undefined returns all flattened)
 */
export async function getSnapshots(pcbId: string, type?: 'manual' | 'auto'): Promise<RoutingSnapshot[]> {
	const data = await getStorageData();
	const pcbData = data[pcbId];

	if (!pcbData)
		return [];

	if (type === 'manual')
		return [...pcbData.manual];
	if (type === 'auto')
		return [...pcbData.auto];

	// 如果没有指定类型，则合并（通常也不推荐这么用，除非是为了兼容旧接口）
	return [...(pcbData.manual || []), ...(pcbData.auto || [])].sort((a, b) => b.timestamp - a.timestamp);
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
 * 辅助：获取当前 PCB 信息
 */
export async function getCurrentPcbInfoSafe() {
	try {
		const pcbInfo = await eda.dmt_Pcb.getCurrentPcbInfo();
		if (pcbInfo) {
			return { id: pcbInfo.uuid, name: pcbInfo.name || '' };
		}
		const boardInfo = await eda.dmt_Board.getCurrentBoardInfo();
		if (boardInfo && boardInfo.pcb) {
			return { id: boardInfo.pcb.uuid, name: boardInfo.pcb.name || boardInfo.name || '' };
		}
	}
	catch { /* ignore */ }
	return null;
}

/**
 * 创建当前布线状态的快照
 * @param name 快照名称
 * @param isManual 是否手动快照 (如果是手动，将存入 manual 表)
 */
export async function createSnapshot(name: string = 'Auto Save', isManual: boolean = false): Promise<RoutingSnapshot | null> {
	try {
		// 暂存撤销ID，不在此时立即重置，而是在后续逻辑中用于分支截断
		const lastRestoredId = getLastRestoredId();

		if (eda.sys_LoadingAndProgressBar) {
			// 如果已经是手动触发的(有进度条)，就不再显示进度提示，避免闪烁
		}

		const currentPcb = await getCurrentPcbInfoSafe();
		if (!currentPcb) {
			logWarn('Cannot create snapshot: No active PCB found.', 'Snapshot');
			return null;
		}

		const pcbId = currentPcb.id;
		const pcbName = currentPcb.name;

		// 自动附加 PCB 名称前缀
		let finalName = name;
		if (pcbName) {
			finalName = `[${pcbName}] ${name}`; // 保持原有命名习惯
		}

		// 获取所有导线、圆弧
		const lines = await eda.pcb_PrimitiveLine.getAll();
		const arcs = await eda.pcb_PrimitiveArc.getAll();

		const snapshot: RoutingSnapshot = {
			id: Date.now(),
			name: finalName,
			timestamp: Date.now(),
			pcbId,
			isManual,
			lines: extractPrimitiveData(lines || [], 'line', pcbId),
			arcs: extractPrimitiveData(arcs || [], 'arc', pcbId),
		};

		// 获取现有数据
		const data = await getStorageData();
		if (!data[pcbId]) {
			data[pcbId] = { manual: [], auto: [] };
		}
		const pcbStore = data[pcbId];

		// 历史分支管理：如果当前处于撤销状态，新操作将截断“未来”
		if (lastRestoredId !== null) {
			const idx = pcbStore.auto.findIndex(s => s.id === lastRestoredId);
			if (idx > 0) {
				// 删除比当前恢复点更新的所有自动快照
				pcbStore.auto.splice(0, idx);
				debugLog(`Snapshot history truncated: removed ${idx} newer items`, 'Snapshot');
			}
			// 重置指针
			setLastRestoredId(null);
		}

		// 决定存入哪个列表
		const targetList = isManual ? pcbStore.manual : pcbStore.auto;

		// Check duplicate against the latest one in the target list
		if (targetList.length > 0) {
			const latest = targetList[0];
			const isIdentical
				= latest.lines.length === snapshot.lines.length
					&& latest.arcs.length === snapshot.arcs.length
					&& latest.lines.every((l, i) => isLineEqual(l, snapshot.lines[i]))
					&& latest.arcs.every((a, i) => isArcEqual(a, snapshot.arcs[i]));

			if (isIdentical) {
				debugLog('Snapshot skipped: Identical to the latest one.', 'Snapshot');
				if (isManual && eda.sys_Message) {
					const msg = eda.sys_I18n ? eda.sys_I18n.text('当前布线状态与最新快照一致，无需重复创建') : 'Current state matches the latest snapshot.';
					eda.sys_Message.showToastMessage(msg);
				}
				if (eda.sys_LoadingAndProgressBar) {
					eda.sys_LoadingAndProgressBar.destroyLoading();
				}
				return null;
			}
		}

		// 插入头部
		targetList.unshift(snapshot);

		// Limit size
		if (targetList.length > SNAPSHOT_LIMIT) {
			targetList.length = SNAPSHOT_LIMIT; // Truncate
		}

		// 保存
		await saveStorageData(data);

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
 * 恢复快照
 */
export async function restoreSnapshot(snapshotId: number, showToast: boolean = true, requireConfirmation: boolean = false): Promise<boolean> {
	try {
		// 因为 restoreSnapshot 只给 ID，我们需要遍历查找
		const data = await getStorageData();
		let snapshot: RoutingSnapshot | undefined;
		// let foundInPcbId = ''; // unused

		// 暴力查找 ID
		for (const store of Object.values(data)) {
			snapshot = store.manual.find(s => s.id === snapshotId) || store.auto.find(s => s.id === snapshotId);
			if (snapshot) {
				break;
			}
		}

		if (!snapshot) {
			logError(`Snapshot not found with id: ${snapshotId}`, 'Snapshot');
			eda.sys_Message?.showToastMessage('未找到指定快照');
			return false;
		}

		const currentPcb = await getCurrentPcbInfoSafe();
		const currentPcbId = currentPcb?.id || 'unknown';

		// 1. 检查 PCB ID
		let confirmed = !requireConfirmation;
		let isMismatch = false;

		if (snapshot.pcbId && snapshot.pcbId !== currentPcbId) {
			isMismatch = true;
			// 如果 ID 不匹配，显示严重警告
			if (eda.sys_Dialog && typeof eda.sys_Dialog.showConfirmationMessage === 'function') {
				confirmed = await new Promise<boolean>((resolve) => {
					eda.sys_Dialog.showConfirmationMessage(
						eda.sys_I18n.text
							? eda.sys_I18n.text('!!! 警告：快照所属PCB与当前不一致 !!!\n\n可能会导致数据错乱，系统将尝试备份当前状态。是否继续？')
							: '!!! WARNING: PCB ID MISMATCH !!!\n\nSystem will try to backup. Continue?',
						eda.sys_I18n.text ? eda.sys_I18n.text('!!! 危险操作确认 !!!') : '!!! DANGER CONFIRMATION !!!',
						undefined,
						undefined,
						(ok: boolean) => resolve(ok),
					);
				});
			}
			else {
				confirmed = true;
			}
		}
		else if (requireConfirmation) {
			if (eda.sys_Dialog && typeof eda.sys_Dialog.showConfirmationMessage === 'function') {
				confirmed = await new Promise<boolean>((resolve) => {
					eda.sys_Dialog.showConfirmationMessage(
						eda.sys_I18n.text ? eda.sys_I18n.text('确定恢复快照？当前未保存的修改将丢失。') : 'Restore snapshot? Unsaved changes will be lost.',
						eda.sys_I18n.text ? eda.sys_I18n.text('恢复快照') : 'Restore Snapshot',
						undefined,
						undefined,
						(ok: boolean) => resolve(ok),
					);
				});
			}
		}

		if (!confirmed)
			return false;

		// Force backup if mismatch
		if (isMismatch) {
			await createSnapshot(eda.sys_I18n?.text ? eda.sys_I18n.text('强制恢复前备份') : 'Backup (Pre-Force Restore)', false);
		}

		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.showLoading();
		}

		// 恢复逻辑 (Diff)
		const currentLines = extractPrimitiveData(await eda.pcb_PrimitiveLine.getAll() || [], 'line', currentPcbId);
		const currentArcs = extractPrimitiveData(await eda.pcb_PrimitiveArc.getAll() || [], 'arc', currentPcbId);

		const currentLineMap = new Map(currentLines.map(l => [l.id, l]));
		const linesToDelete: string[] = [];
		const linesToCreate: any[] = [];

		for (const snapLine of snapshot.lines) {
			if (currentLineMap.has(snapLine.id)) {
				if (isLineEqual(snapLine, currentLineMap.get(snapLine.id))) {
					currentLineMap.delete(snapLine.id);
				}
				else {
					linesToDelete.push(snapLine.id);
					linesToCreate.push(snapLine);
					currentLineMap.delete(snapLine.id);
				}
			}
			else {
				linesToCreate.push(snapLine);
			}
		}
		for (const id of currentLineMap.keys()) linesToDelete.push(id);

		const currentArcMap = new Map(currentArcs.map(a => [a.id, a]));
		const arcsToDelete: string[] = [];
		const arcsToCreate: any[] = [];

		for (const snapArc of snapshot.arcs) {
			if (currentArcMap.has(snapArc.id)) {
				if (isArcEqual(snapArc, currentArcMap.get(snapArc.id))) {
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
		for (const id of currentArcMap.keys()) arcsToDelete.push(id);

		// Execute
		if (linesToDelete.length > 0)
			await eda.pcb_PrimitiveLine.delete(linesToDelete);
		if (arcsToDelete.length > 0)
			await eda.pcb_PrimitiveArc.delete(arcsToDelete);

		for (const l of linesToCreate) {
			try {
				await eda.pcb_PrimitiveLine.create(l.net, l.layer, l.startX, l.startY, l.endX, l.endY, l.lineWidth ?? 0.254);
			}
			catch (e) { logWarn(`Line restore error: ${e}`); }
		}

		for (const a of arcsToCreate) {
			try {
				if (a.startX !== undefined && a.arcAngle !== undefined) {
					await eda.pcb_PrimitiveArc.create(a.net, a.layer, a.startX, a.startY, a.endX, a.endY, a.arcAngle, a.lineWidth ?? 0.254);
				}
			}
			catch (e) { logWarn(`Arc restore error: ${e}`); }
		}

		if (showToast && eda.sys_Message) {
			eda.sys_Message.showToastMessage(`恢复成功 (L:${linesToCreate.length - linesToDelete.length}, A:${arcsToCreate.length - arcsToDelete.length})`);
		}

		setLastRestoredId(snapshot.id);
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
		if (eda.sys_LoadingAndProgressBar)
			eda.sys_LoadingAndProgressBar.destroyLoading();
	}
}

/**
 * 删除快照
 */
export async function deleteSnapshot(snapshotId: number) {
	const data = await getStorageData();
	// 全局删除
	for (const pcbId in data) {
		data[pcbId].manual = data[pcbId].manual.filter(s => s.id !== snapshotId);
		data[pcbId].auto = data[pcbId].auto.filter(s => s.id !== snapshotId);
	}
	await saveStorageData(data);
	notifySnapshotChange();
}

/**
 * 清空 (当前 PCB 的手动快照，或全部？)
 * Settings 界面只会请求清空其显示的列表
 */
export async function clearSnapshots() {
	const currentPcb = await getCurrentPcbInfoSafe();
	if (!currentPcb)
		return;

	const data = await getStorageData();
	if (data[currentPcb.id]) {
		data[currentPcb.id].manual = [];
		await saveStorageData(data);
		notifySnapshotChange();
	}
}

/**
 * 撤销上一次操作 (通过恢复快照)
 * 查找最新的快照并恢复
 */
export async function undoLastOperation() {
	if (isUndoing())
		return;
	setUndoing(true);

	if (eda.sys_LoadingAndProgressBar?.showLoading)
		eda.sys_LoadingAndProgressBar.showLoading();

	try {
		const currentPcb = await getCurrentPcbInfoSafe();
		if (!currentPcb) {
			eda.sys_Message?.showToastMessage('无效的 PCB 状态');
			return;
		}

		const data = await getStorageData();
		const pcbData = data[currentPcb.id];

		// 如果没有自动快照
		if (!pcbData || !pcbData.auto || pcbData.auto.length === 0) {
			eda.sys_Message?.showToastMessage(eda.sys_I18n ? eda.sys_I18n.text('没有可撤销的操作') : 'No undo history');
			return;
		}

		const autoSnapshots = pcbData.auto;

		// 寻找目标快照
		let targetSnapshot: RoutingSnapshot | undefined;
		const lastRestoredId = getLastRestoredId();
		let startIndex = 0;

		if (lastRestoredId !== null) {
			const idx = autoSnapshots.findIndex(s => s.id === lastRestoredId);
			if (idx !== -1) {
				startIndex = idx + 1; // 找更旧的一个
			}
		}

		// 过滤掉 "After" 类型的快照，因为撤销是要回到 "Before"
		for (let i = startIndex; i < autoSnapshots.length; i++) {
			const s = autoSnapshots[i];
			if (s.name && /\sAfter$/.test(s.name)) {
				continue;
			}
			targetSnapshot = s;
			break;
		}

		if (targetSnapshot) {
			const success = await restoreSnapshot(targetSnapshot.id, false, false);
			if (success) {
				const msg = eda.sys_I18n ? eda.sys_I18n.text('已撤销') : 'Undone';
				let dispName = targetSnapshot.name.replace(/^\[.*?\]\s*/, '');
				if (eda.sys_I18n && eda.sys_I18n.text(dispName) !== dispName) {
					dispName = eda.sys_I18n.text(dispName);
				}
				eda.sys_Message?.showToastMessage(`${msg}: ${dispName}`);
			}
		}
		else {
			eda.sys_Message?.showToastMessage(eda.sys_I18n ? eda.sys_I18n.text('已到达撤销记录尽头') : 'End of undo history');
		}
	}
	catch (e: any) {
		if (eda.sys_Dialog)
			eda.sys_Dialog.showInformationMessage(`撤销失败: ${e.message}`, 'Undo Error');
	}
	finally {
		setUndoing(false);
		if (eda.sys_LoadingAndProgressBar?.destroyLoading)
			eda.sys_LoadingAndProgressBar.destroyLoading();
	}
}
