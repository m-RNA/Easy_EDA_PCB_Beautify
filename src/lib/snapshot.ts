import { getArcLineWidthMap, makeArcWidthKey } from './beautify';
import { debugLog, logError, logWarn } from './logger';
import { isClose } from './math';

const SNAPSHOT_STORAGE_KEY_V2 = 'jlc_eda_beautify_snapshots_v2';
const SNAPSHOT_STORAGE_KEY_V3_PREFIX = 'jlc_eda_beautify_snapshots_v3_';
// 内存缓存 key，挂载在 eda 对象上
const CACHE_KEY_V3_PREFIX = '_jlc_beautify_snapshots_cache_v3_';
// 回调 key
const CALLBACK_KEY = '_jlc_beautify_snapshot_callback';
// 记录上一次撤销恢复到的快照ID
const LAST_RESTORED_KEY = '_jlc_beautify_last_restored_id';
// 撤销锁 Key
const UNDO_LOCK_KEY = '_jlc_beautify_undo_lock';

export interface RoutingSnapshot {
	id: number;
	name: string;
	timestamp: number;
	pcbId?: string;
	lines: any[];
	arcs: any[];
	isManual?: boolean;
}

interface PcbSnapshotStorage {
	manual: RoutingSnapshot[];
	auto: RoutingSnapshot[];
}

export const SNAPSHOT_LIMIT = 20;

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

/**
 * 获取指定 PCB 的快照存储 (V3)
 */
async function getPcbStorageData(pcbId: string): Promise<PcbSnapshotStorage> {
	if (!pcbId)
		return { manual: [], auto: [] };

	const cacheKey = `${CACHE_KEY_V3_PREFIX}${pcbId}`;
	const storageKey = `${SNAPSHOT_STORAGE_KEY_V3_PREFIX}${pcbId}`;

	// 1. 尝试从全局缓存读取
	const cached = (eda as any)[cacheKey] as PcbSnapshotStorage;
	if (cached && typeof cached === 'object') {
		return cached;
	}

	// 2. 从 V3 存储读取
	try {
		const stored = await eda.sys_Storage.getExtensionUserConfig(storageKey);
		if (stored) {
			const data = typeof stored === 'string' ? JSON.parse(stored) : stored;
			// 更新 cache
			(eda as any)[cacheKey] = data;
			return data;
		}
	}
	catch (e: any) {
		logError(`Failed to load snapshots v3 for ${pcbId}: ${e.message || e}`);
	}

	// 3. 尝试从 V2 迁移 (仅当 V3 没有数据时)
	try {
		const v2Data = await eda.sys_Storage.getExtensionUserConfig(SNAPSHOT_STORAGE_KEY_V2);
		if (v2Data) {
			const allV2 = typeof v2Data === 'string' ? JSON.parse(v2Data) : v2Data;
			if (allV2 && allV2[pcbId]) {
				const migrated = allV2[pcbId];
				debugLog(`Migrating snapshots from V2 for PCB: ${pcbId}`);
				// 保存到 V3
				await savePcbStorageData(pcbId, migrated);
				return migrated;
			}
		}
	}
	catch (e: any) {
		logWarn(`Migration from V2 failed for ${pcbId}: ${e.message || e}`);
	}

	// 4. 返回空
	const empty = { manual: [], auto: [] };
	(eda as any)[cacheKey] = empty;
	return empty;
}

/**
 * 保存指定 PCB 的快照存储 (V3)
 */
async function savePcbStorageData(pcbId: string, data: PcbSnapshotStorage) {
	if (!pcbId)
		return;

	const cacheKey = `${CACHE_KEY_V3_PREFIX}${pcbId}`;
	const storageKey = `${SNAPSHOT_STORAGE_KEY_V3_PREFIX}${pcbId}`;

	try {
		// Update cache
		(eda as any)[cacheKey] = data;
		// Persist
		const success = await eda.sys_Storage.setExtensionUserConfig(storageKey, JSON.stringify(data));
		if (!success) {
			logError(`Failed to persist snapshots for ${pcbId} (API returned false)`, 'Snapshot');
		}
	}
	catch (e: any) {
		logError(`Failed to save snapshots v3 for ${pcbId}: ${e.message || e}`);
	}
}

/**
 * 获取指定 PCB 的快照列表
 * @param pcbId PCB UUID
 * @param type 'manual' | 'auto' | undefined (undefined returns all flattened)
 */
export async function getSnapshots(pcbId: string, type?: 'manual' | 'auto'): Promise<RoutingSnapshot[]> {
	const pcbData = await getPcbStorageData(pcbId);

	if (type === 'manual')
		return [...pcbData.manual];
	if (type === 'auto')
		return [...pcbData.auto];

	// 如果没有指定类型，则合并（通常也不推荐这么用，除非是为了兼容旧接口）
	return [...(pcbData.manual || []), ...(pcbData.auto || [])].sort((a, b) => b.timestamp - a.timestamp);
}

// 辅助函数：比较 Line 是否一致
function isLineEqual(a: any, b: any) {
	if ((a.i || a.id) !== (b.i || b.id))
		return false; // ID must match
	if ((a.l ?? a.layer) !== (b.l ?? b.layer) || (a.n ?? a.net) !== (b.n ?? b.net))
		return false;
	if (!isClose(a.sX ?? a.sx ?? a.startX, b.sX ?? b.sx ?? b.startX))
		return false;
	if (!isClose(a.sY ?? a.sy ?? a.startY, b.sY ?? b.sy ?? b.startY))
		return false;
	if (!isClose(a.eX ?? a.ex ?? a.endX, b.eX ?? b.ex ?? b.endX))
		return false;
	if (!isClose(a.eY ?? a.ey ?? a.endY, b.eY ?? b.ey ?? b.endY))
		return false;
	if (!isClose(a.w ?? a.lineWidth, b.w ?? b.lineWidth))
		return false;
	return true;
}

// 辅助函数：比较 Arc 是否一致
function isArcEqual(a: any, b: any) {
	if ((a.i || a.id) !== (b.i || b.id))
		return false; // ID must match
	if ((a.l ?? a.layer) !== (b.l ?? b.layer) || (a.n ?? a.net) !== (b.n ?? b.net))
		return false;
	if (!isClose(a.sX ?? a.sx ?? a.startX, b.sX ?? b.sx ?? b.startX))
		return false;
	if (!isClose(a.sY ?? a.sy ?? a.startY, b.sY ?? b.sy ?? b.startY))
		return false;
	if (!isClose(a.eX ?? a.ex ?? a.endX, b.eX ?? b.ex ?? b.endX))
		return false;
	if (!isClose(a.eY ?? a.ey ?? a.endY, b.eY ?? b.ey ?? b.endY))
		return false;
	if (!isClose(a.a ?? a.arcAngle, b.a ?? b.arcAngle))
		return false;
	if (!isClose(a.w ?? a.lineWidth, b.w ?? b.lineWidth))
		return false;
	return true;
}

// 辅助函数：比较两个快照的数据是否完全一致 (忽略顺序)
function isSnapshotDataIdentical(snapshotA: RoutingSnapshot, snapshotB: RoutingSnapshot): boolean {
	if (snapshotA.lines.length !== snapshotB.lines.length)
		return false;
	if (snapshotA.arcs.length !== snapshotB.arcs.length)
		return false;

	// Sort by ID for stable comparison
	const sortById = (a: any, b: any) => ((a.i || a.id) > (b.i || b.id) ? 1 : -1);

	const linesA = [...snapshotA.lines].sort(sortById);
	const linesB = [...snapshotB.lines].sort(sortById);

	for (let i = 0; i < linesA.length; i++) {
		if (!isLineEqual(linesA[i], linesB[i]))
			return false;
	}

	const arcsA = [...snapshotA.arcs].sort(sortById);
	const arcsB = [...snapshotB.arcs].sort(sortById);

	for (let i = 0; i < arcsA.length; i++) {
		if (!isArcEqual(arcsA[i], arcsB[i]))
			return false;
	}

	return true;
}

// 辅助函数：提取图元数据 (使用短 Key 减少存储体积)
function extractPrimitiveData(items: any[], type: 'line' | 'arc', pcbId: string) {
	return items.map((p) => {
		const base = {
			n: p.getState_Net ? p.getState_Net() : p.net,
			l: p.getState_Layer ? p.getState_Layer() : p.layer,
			i: p.getState_PrimitiveId ? p.getState_PrimitiveId() : p.primitiveId,
		};

		if (type === 'line') {
			const lineWidth = p.getState_LineWidth ? p.getState_LineWidth() : p.lineWidth;
			return {
				...base,
				sX: p.getState_StartX ? p.getState_StartX() : p.startX,
				sY: p.getState_StartY ? p.getState_StartY() : p.startY,
				eX: p.getState_EndX ? p.getState_EndX() : p.endX,
				eY: p.getState_EndY ? p.getState_EndY() : p.endY,
				w: lineWidth,
			};
		}
		else if (type === 'arc') {
			const arcAngle = p.getState_ArcAngle ? p.getState_ArcAngle() : p.arcAngle;
			const arcId = base.i;

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
				sX: p.getState_StartX ? p.getState_StartX() : p.startX,
				sY: p.getState_StartY ? p.getState_StartY() : p.startY,
				eX: p.getState_EndX ? p.getState_EndX() : p.endX,
				eY: p.getState_EndY ? p.getState_EndY() : p.endY,
				a: arcAngle,
				w: lineWidth ?? 0.254,
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
		const pcbStore = await getPcbStorageData(pcbId);

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
			const isIdentical = isSnapshotDataIdentical(latest, snapshot);

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
		await savePcbStorageData(pcbId, pcbStore);

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
		const currentPcb = await getCurrentPcbInfoSafe();
		if (!currentPcb) {
			logWarn('Cannot restore snapshot: No active PCB found.', 'Snapshot');
			return false;
		}
		const currentPcbId = currentPcb.id;

		// 因为 restoreSnapshot 只给 ID，优先从当前 PCB 查找
		const pcbStore = await getPcbStorageData(currentPcbId);
		let snapshot = pcbStore.manual.find(s => s.id === snapshotId) || pcbStore.auto.find(s => s.id === snapshotId);

		// 如果当前 PCB 没找到，尝试在迁移过来的数据或其它 PCB 中找（通过 V2 兜底）
		if (!snapshot) {
			const v2Data = await eda.sys_Storage.getExtensionUserConfig(SNAPSHOT_STORAGE_KEY_V2);
			if (v2Data) {
				const allV2 = typeof v2Data === 'string' ? JSON.parse(v2Data) : v2Data;
				for (const store of Object.values(allV2) as any[]) {
					snapshot = store.manual.find((s: any) => s.id === snapshotId) || store.auto.find((s: any) => s.id === snapshotId);
					if (snapshot)
						break;
				}
			}
		}

		if (!snapshot) {
			logError(`Snapshot not found with id: ${snapshotId}`, 'Snapshot');
			eda.sys_Message?.showToastMessage('未找到指定快照');
			return false;
		}

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

		const currentLineMap = new Map(currentLines.map((l: any) => [l.i || l.id, l]));
		const linesToDelete: string[] = [];
		const linesToCreate: any[] = [];

		for (const snapLine of snapshot.lines) {
			const snapId = snapLine.i || snapLine.id;
			if (currentLineMap.has(snapId)) {
				if (isLineEqual(snapLine, currentLineMap.get(snapId))) {
					currentLineMap.delete(snapId);
				}
				else {
					linesToDelete.push(snapId);
					linesToCreate.push(snapLine);
					currentLineMap.delete(snapId);
				}
			}
			else {
				linesToCreate.push(snapLine);
			}
		}
		for (const id of currentLineMap.keys()) linesToDelete.push(id as string);

		const currentArcMap = new Map(currentArcs.map((a: any) => [a.i || a.id, a]));
		const arcsToDelete: string[] = [];
		const arcsToCreate: any[] = [];

		for (const snapArc of snapshot.arcs) {
			const snapId = snapArc.i || snapArc.id;
			if (currentArcMap.has(snapId)) {
				if (isArcEqual(snapArc, currentArcMap.get(snapId))) {
					currentArcMap.delete(snapId);
				}
				else {
					arcsToDelete.push(snapId);
					arcsToCreate.push(snapArc);
					currentArcMap.delete(snapId);
				}
			}
			else {
				arcsToCreate.push(snapArc);
			}
		}
		for (const id of currentArcMap.keys()) arcsToDelete.push(id as string);

		// Execute
		if (linesToDelete.length > 0)
			await eda.pcb_PrimitiveLine.delete(linesToDelete);
		if (arcsToDelete.length > 0)
			await eda.pcb_PrimitiveArc.delete(arcsToDelete);

		for (const l of linesToCreate) {
			try {
				await eda.pcb_PrimitiveLine.create(
					l.n ?? l.net,
					l.l ?? l.layer,
					l.sX ?? l.sx ?? l.startX,
					l.sY ?? l.sy ?? l.startY,
					l.eX ?? l.ex ?? l.endX,
					l.eY ?? l.ey ?? l.endY,
					l.w ?? l.lineWidth ?? 0.254,
				);
			}
			catch (e) { logWarn(`Line restore error: ${e}`); }
		}

		for (const a of arcsToCreate) {
			try {
				const startX = a.sX ?? a.sx ?? a.startX;
				const angle = a.a ?? a.arcAngle;
				if (startX !== undefined && angle !== undefined) {
					await eda.pcb_PrimitiveArc.create(
						a.n ?? a.net,
						a.l ?? a.layer,
						startX,
						a.sY ?? a.sy ?? a.startY,
						a.eX ?? a.ex ?? a.endX,
						a.eY ?? a.ey ?? a.endY,
						angle,
						a.w ?? a.lineWidth ?? 0.254,
					);
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
	const currentPcb = await getCurrentPcbInfoSafe();
	if (!currentPcb)
		return;

	const pcbId = currentPcb.id;
	const pcbData = await getPcbStorageData(pcbId);

	pcbData.manual = pcbData.manual.filter(s => s.id !== snapshotId);
	pcbData.auto = pcbData.auto.filter(s => s.id !== snapshotId);

	await savePcbStorageData(pcbId, pcbData);
	notifySnapshotChange();
}

/**
 * 清空 (当前 PCB 的手动快照)
 */
export async function clearSnapshots() {
	const currentPcb = await getCurrentPcbInfoSafe();
	if (!currentPcb)
		return;

	const pcbId = currentPcb.id;
	const pcbData = await getPcbStorageData(pcbId);

	pcbData.manual = [];
	await savePcbStorageData(pcbId, pcbData);
	notifySnapshotChange();
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

		const pcbId = currentPcb.id;
		const pcbData = await getPcbStorageData(pcbId);

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
		else {
			// 如果是第一次撤销，且最新的快照是 "After" 类型的（通常代表当前状态），
			// 则跳过它，直接撤销到它的前一个状态。
			if (autoSnapshots.length > 0 && autoSnapshots[0].name && /\sAfter$/.test(autoSnapshots[0].name)) {
				startIndex = 1;
			}
		}

		if (startIndex < autoSnapshots.length) {
			targetSnapshot = autoSnapshots[startIndex];
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
