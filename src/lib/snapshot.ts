import { getArcWidthByGeoMap, makeArcWidthGeoKey } from './beautify';
import { debugLog, logError, logWarn } from './logger';
import { isClose } from './math';

const SNAPSHOT_STORAGE_KEY_V2 = 'jlc_eda_beautify_snapshots_v2';
const SNAPSHOT_STORAGE_KEY_V3_PREFIX = 'jlc_eda_beautify_snapshots_v3_';
const SNAPSHOT_STORAGE_KEY_V4 = 'jlc_eda_beautify_snapshots_v4';
// 内存缓存 key，挂载在 eda 对象上
const CACHE_KEY_V3_PREFIX = '_jlc_beautify_snapshots_cache_v3_';
const V3_KEYS_CLEANED_FLAG = '_jlc_beautify_snapshots_v3_keys_cleaned';
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

type SnapshotCloudStore = Record<string, PcbSnapshotStorage>;

function collectLegacyV3Keys(allConfigs: Record<string, any>): string[] {
	return Object.keys(allConfigs || {}).filter(k => k.startsWith(SNAPSHOT_STORAGE_KEY_V3_PREFIX));
}

async function cleanupLegacyV3Keys(allConfigs: Record<string, any>): Promise<Record<string, any>> {
	if ((eda as any)[V3_KEYS_CLEANED_FLAG])
		return allConfigs;

	const legacyKeys = collectLegacyV3Keys(allConfigs);
	if (legacyKeys.length === 0) {
		(eda as any)[V3_KEYS_CLEANED_FLAG] = true;
		return allConfigs;
	}

	const nextConfigs = { ...allConfigs };
	for (const key of legacyKeys)
		delete nextConfigs[key];

	const ok = await eda.sys_Storage.setExtensionAllUserConfigs(nextConfigs);
	if (ok) {
		for (const key of legacyKeys) {
			try {
				await eda.sys_Storage.deleteExtensionUserConfig(key);
			}
			catch {
				// ignore cleanup failure for legacy per-key config
			}
		}
		(eda as any)[V3_KEYS_CLEANED_FLAG] = true;
		debugLog(`Cleaned legacy snapshot keys: ${legacyKeys.length}`, 'Snapshot');
		return nextConfigs;
	}

	logWarn('Failed to cleanup legacy V3 keys from extension all-user-configs', 'Snapshot');
	return allConfigs;
}

export interface SnapshotStorageDiagnostic {
	currentPcbId: string | null;
	hasV4Root: boolean;
	v4PcbCount: number;
	v4CurrentManualCount: number;
	v4CurrentAutoCount: number;
	hasV3CurrentKey: boolean;
	storageKeysSample: string[];
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

	// 2. 优先从 V4（与扩展设置同一配置容器）读取，并尝试清理遗留 V3 键
	try {
		let allConfigs = await eda.sys_Storage.getExtensionAllUserConfigs() || {};
		allConfigs = await cleanupLegacyV3Keys(allConfigs);
		const cloudRoot = allConfigs ? allConfigs[SNAPSHOT_STORAGE_KEY_V4] : undefined;
		if (cloudRoot) {
			const allV4: SnapshotCloudStore = typeof cloudRoot === 'string' ? JSON.parse(cloudRoot) : cloudRoot;
			if (allV4 && allV4[pcbId]) {
				const data = allV4[pcbId];
				(eda as any)[cacheKey] = data;
				return data;
			}
		}
	}
	catch (e: any) {
		logError(`Failed to load snapshots v4 for ${pcbId}: ${e.message || e}`);
	}

	// 3. 回退从 V3 存储读取
	try {
		const stored = await eda.sys_Storage.getExtensionUserConfig(storageKey);
		if (stored) {
			const data = typeof stored === 'string' ? JSON.parse(stored) : stored;
			// 迁移到 V4 并删除当前 V3 键
			await savePcbStorageData(pcbId, data);
			try {
				await eda.sys_Storage.deleteExtensionUserConfig(storageKey);
			}
			catch {
				// ignore
			}

			// 更新 cache
			(eda as any)[cacheKey] = data;
			return data;
		}
	}
	catch (e: any) {
		logError(`Failed to load snapshots v3 for ${pcbId}: ${e.message || e}`);
	}

	// 4. 尝试从 V2 迁移 (仅当 V3/V4 没有数据时)
	try {
		const v2Data = await eda.sys_Storage.getExtensionUserConfig(SNAPSHOT_STORAGE_KEY_V2);
		if (v2Data) {
			const allV2 = typeof v2Data === 'string' ? JSON.parse(v2Data) : v2Data;
			if (allV2 && allV2[pcbId]) {
				const migrated = allV2[pcbId];
				debugLog(`Migrating snapshots from V2 for PCB: ${pcbId}`);
				// 保存到 V4
				await savePcbStorageData(pcbId, migrated);
				return migrated;
			}
		}
	}
	catch (e: any) {
		logWarn(`Migration from V2 failed for ${pcbId}: ${e.message || e}`);
	}

	// 5. 返回空
	const empty = { manual: [], auto: [] };
	(eda as any)[cacheKey] = empty;
	return empty;
}

/**
 * 保存指定 PCB 的快照存储 (V4)
 */
async function savePcbStorageData(pcbId: string, data: PcbSnapshotStorage) {
	if (!pcbId)
		return;

	const cacheKey = `${CACHE_KEY_V3_PREFIX}${pcbId}`;

	try {
		// Update cache
		(eda as any)[cacheKey] = data;

		// Persist to V4 (extension all-user-configs), 与设置同一套云端配置通道
		let allConfigs = await eda.sys_Storage.getExtensionAllUserConfigs() || {};
		allConfigs = await cleanupLegacyV3Keys(allConfigs);
		const cloudRoot = allConfigs[SNAPSHOT_STORAGE_KEY_V4];
		const allV4: SnapshotCloudStore = cloudRoot
			? (typeof cloudRoot === 'string' ? JSON.parse(cloudRoot) : cloudRoot)
			: {};
		allV4[pcbId] = data;
		allConfigs[SNAPSHOT_STORAGE_KEY_V4] = allV4;
		const cloudOk = await eda.sys_Storage.setExtensionAllUserConfigs(allConfigs);
		if (!cloudOk) {
			logError(`Failed to persist snapshots v4 for ${pcbId} (API returned false)`, 'Snapshot');
		}
	}
	catch (e: any) {
		logError(`Failed to save snapshots v4 for ${pcbId}: ${e.message || e}`);
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

/**
 * 扩展内诊断：检查快照是否写入 ExtensionAllUserConfigs（V4）
 * 可在 settings iframe 中调用：
 * await eda.jlc_eda_beautify_snapshot.diagnoseSnapshotStorage()
 */
export async function diagnoseSnapshotStorage(): Promise<SnapshotStorageDiagnostic> {
	const currentPcb = await getCurrentPcbInfoSafe();
	const currentPcbId = currentPcb?.id || null;

	const allConfigs = await eda.sys_Storage.getExtensionAllUserConfigs() || {};
	const cloudRoot = allConfigs[SNAPSHOT_STORAGE_KEY_V4];
	const allV4: SnapshotCloudStore = cloudRoot
		? (typeof cloudRoot === 'string' ? JSON.parse(cloudRoot) : cloudRoot)
		: {};

	const currentV4 = currentPcbId ? allV4[currentPcbId] : undefined;
	const hasV3CurrentKey = currentPcbId
		? !!(await eda.sys_Storage.getExtensionUserConfig(`${SNAPSHOT_STORAGE_KEY_V3_PREFIX}${currentPcbId}`))
		: false;

	return {
		currentPcbId,
		hasV4Root: !!cloudRoot,
		v4PcbCount: Object.keys(allV4 || {}).length,
		v4CurrentManualCount: currentV4?.manual?.length || 0,
		v4CurrentAutoCount: currentV4?.auto?.length || 0,
		hasV3CurrentKey,
		storageKeysSample: Object.keys(allConfigs).slice(0, 20),
	};
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

/**
 * 几何排序键：忽略图元 ID，仅包含坐标、网络、层、线宽、角度
 * 用于在 undo/restore 后 ID 变化时仍能检测实际相同的布线状态
 */
function geometrySortKey(p: any): string {
	const net = p.n ?? p.net ?? '';
	const layer = p.l ?? p.layer ?? 0;
	const sx = (p.sX ?? p.sx ?? p.startX ?? 0).toFixed(3);
	const sy = (p.sY ?? p.sy ?? p.startY ?? 0).toFixed(3);
	const ex = (p.eX ?? p.ex ?? p.endX ?? 0).toFixed(3);
	const ey = (p.eY ?? p.ey ?? p.endY ?? 0).toFixed(3);
	const w = (p.w ?? p.lineWidth ?? 0).toFixed(3);
	const a = (p.a ?? p.arcAngle ?? 0).toFixed(3);
	return `${net}|${layer}|${sx}|${sy}|${ex}|${ey}|${w}|${a}`;
}

/**
 * 仅比较几何数据的快照一致性检查（忽略图元 ID）
 * 解决 undo/restore 循环后图元 ID 变化导致 isSnapshotDataIdentical 去重失败的问题
 */
function isSnapshotGeometryIdentical(a: RoutingSnapshot, b: RoutingSnapshot): boolean {
	if (a.lines.length !== b.lines.length || a.arcs.length !== b.arcs.length)
		return false;

	const linesA = a.lines.map(geometrySortKey).sort();
	const linesB = b.lines.map(geometrySortKey).sort();
	for (let i = 0; i < linesA.length; i++) {
		if (linesA[i] !== linesB[i])
			return false;
	}

	const arcsA = a.arcs.map(geometrySortKey).sort();
	const arcsB = b.arcs.map(geometrySortKey).sort();
	for (let i = 0; i < arcsA.length; i++) {
		if (arcsA[i] !== arcsB[i])
			return false;
	}

	return true;
}

// 辅助函数：提取图元数据 (使用短 Key 减少存储体积)
function extractPrimitiveData(items: any[], type: 'line' | 'arc') {
	// Line 类型：直接提取，getState_LineWidth 对 Line 返回正确
	if (type === 'line') {
		return items.map((p) => {
			const lineWidth = p.getState_LineWidth ? p.getState_LineWidth() : p.lineWidth;
			return {
				n: p.getState_Net ? p.getState_Net() : p.net,
				l: p.getState_Layer ? p.getState_Layer() : p.layer,
				i: p.getState_PrimitiveId ? p.getState_PrimitiveId() : p.primitiveId,
				sX: p.getState_StartX ? p.getState_StartX() : p.startX,
				sY: p.getState_StartY ? p.getState_StartY() : p.startY,
				eX: p.getState_EndX ? p.getState_EndX() : p.endX,
				eY: p.getState_EndY ? p.getState_EndY() : p.endY,
				w: lineWidth,
			};
		});
	}

	// Arc 类型：通过几何键查找正确宽度
	// getState_LineWidth() 对圆弧可能返回错误的 10mil 默认值
	// 查找优先级: 几何键 Map → API fallback
	const geoWidthMap = getArcWidthByGeoMap();

	return items.map((p) => {
		const net = p.getState_Net ? p.getState_Net() : p.net;
		const layer = p.getState_Layer ? p.getState_Layer() : p.layer;
		const arcId = p.getState_PrimitiveId ? p.getState_PrimitiveId() : p.primitiveId;
		const arcAngle = p.getState_ArcAngle ? p.getState_ArcAngle() : p.arcAngle;
		const sx = p.getState_StartX ? p.getState_StartX() : p.startX;
		const sy = p.getState_StartY ? p.getState_StartY() : p.startY;
		const ex = p.getState_EndX ? p.getState_EndX() : p.endX;
		const ey = p.getState_EndY ? p.getState_EndY() : p.endY;

		// 1. 几何键查找（唯一可信数据源，由 beautifyRouting 写入）
		let lineWidth: number | undefined;
		{
			const geoKey = makeArcWidthGeoKey(net, layer, sx, sy, ex, ey);
			lineWidth = geoWidthMap.get(geoKey);
		}

		// 2. 几何键未命中，回退到 API（对圆弧可能返回错误值）
		if (lineWidth === undefined) {
			if (p.getState_LineWidth) {
				lineWidth = p.getState_LineWidth();
			}
			else if (p.lineWidth !== undefined) {
				lineWidth = p.lineWidth;
			}
		}

		return {
			n: net,
			l: layer,
			i: arcId,
			sX: sx,
			sY: sy,
			eX: ex,
			eY: ey,
			a: arcAngle,
			w: lineWidth ?? 10,
		};
	});
}

/**
 * 通过端点连接关系修复圆弧线宽
 *
 * 原理：PCB 布线中，圆弧（圆角/圆滑）的线宽必须与其连接的导线一致。
 * 当 getState_LineWidth() 对圆弧返回错误的 10mil 默认值且几何键匹配失败时，
 * 可通过查找端点相连的导线或已知线宽的圆弧来推导正确线宽。
 * 支持多轮迭代处理 arc→arc→...→line 的链式连接。
 */
function resolveArcWidths(lines: any[], arcs: any[]): void {
	// 只处理线宽为 10（可疑默认值）的圆弧
	const suspicious = arcs.filter(a => (a.w ?? 10) === 10);
	if (suspicious.length === 0)
		return;

	// 端点坐标键（含 net+layer，精度 0.1（保留 1 位小数）用于模糊匹配）
	const ptKey = (x: number, y: number, net: any, layer: any) =>
		`${net}#${layer}#${Number(x).toFixed(1)}|${Number(y).toFixed(1)}`;

	// 构建端点 → 线宽映射（从导线获取可信线宽）
	const epWidth = new Map<string, number>();
	for (const l of lines) {
		const w = l.w ?? l.lineWidth ?? 10;
		const n = l.n ?? l.net;
		const ly = l.l ?? l.layer;
		const k1 = ptKey(l.sX ?? l.sx ?? l.startX, l.sY ?? l.sy ?? l.startY, n, ly);
		const k2 = ptKey(l.eX ?? l.ex ?? l.endX, l.eY ?? l.ey ?? l.endY, n, ly);
		// 非 10mil 的值优先
		if (w !== 10 || !epWidth.has(k1))
			epWidth.set(k1, w);
		if (w !== 10 || !epWidth.has(k2))
			epWidth.set(k2, w);
	}

	// 非可疑圆弧也加入端点映射（传播已知线宽）
	for (const a of arcs) {
		const w = a.w ?? 10;
		if (w === 10)
			continue;
		const n = a.n ?? a.net;
		const ly = a.l ?? a.layer;
		const k1 = ptKey(a.sX ?? a.sx ?? a.startX, a.sY ?? a.sy ?? a.startY, n, ly);
		const k2 = ptKey(a.eX ?? a.ex ?? a.endX, a.eY ?? a.ey ?? a.endY, n, ly);
		if (!epWidth.has(k1))
			epWidth.set(k1, w);
		if (!epWidth.has(k2))
			epWidth.set(k2, w);
	}

	// 多轮修复（处理 arc→arc→...→line 的链式连接）
	let changed = true;
	for (let pass = 0; pass < 10 && changed; pass++) {
		changed = false;
		for (const a of suspicious) {
			if ((a.w ?? 10) !== 10)
				continue; // 已修复
			const n = a.n ?? a.net;
			const ly = a.l ?? a.layer;
			const k1 = ptKey(a.sX ?? a.sx ?? a.startX, a.sY ?? a.sy ?? a.startY, n, ly);
			const k2 = ptKey(a.eX ?? a.ex ?? a.endX, a.eY ?? a.ey ?? a.endY, n, ly);
			const w1 = epWidth.get(k1);
			const w2 = epWidth.get(k2);
			const resolved = (w1 !== undefined && w1 !== 10)
				? w1
				: (w2 !== undefined && w2 !== 10)
						? w2
						: undefined;
			if (resolved !== undefined) {
				a.w = resolved;
				changed = true;
				// 传播：已修复圆弧的端点也可用于下一轮
				epWidth.set(k1, resolved);
				epWidth.set(k2, resolved);
			}
		}
	}
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
			lines: extractPrimitiveData(lines || [], 'line'),
			arcs: extractPrimitiveData(arcs || [], 'arc'),
		};

		// 修复圆弧线宽：通过端点连接关系从导线推导正确线宽
		// 解决 getState_LineWidth() 对圆弧返回 10mil 且 geo map key 不匹配的问题
		resolveArcWidths(snapshot.lines, snapshot.arcs);

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
			else if (idx === -1) {
				// 如果恢复点不在 auto 列表中（说明是从 manual 恢复的），则视为开始全新分支。
				// 保留旧 history，但新生成的快照会自然排在最前，形成新的 undo 点。
				debugLog('Operation follows a manual restore or missing auto point. Starting new sequence.', 'Snapshot');
			}
			// 重置指针
			setLastRestoredId(null);
		}

		// 决定存入哪个列表
		const targetList = isManual ? pcbStore.manual : pcbStore.auto;

		// 几何去重：仅对比目标列表中的最新一个快照
		// 之前版本扫描全列表会导致：(1) 恢复旧快照后因与历史匹配而无法创建新的 Before 记录 (2) 达到上限后因状态重复导致列表不再更新
		if (targetList.length > 0) {
			const latest = targetList[0];
			if (isSnapshotGeometryIdentical(latest, snapshot)) {
				debugLog(`Snapshot skipped: Geometry identical to latest "${latest.name}" (id: ${latest.id})`, 'Snapshot');
				if (isManual && eda.sys_Message) {
					eda.sys_Message.showToastMessage('当前布线状态与最新快照一致，无需重复创建', 'info' as any, 2);
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
			eda.sys_Message.showToastMessage(`创建快照失败: ${e.message}`, 'error' as any, 4);
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
			eda.sys_Message?.showToastMessage('未找到指定快照', 'warn' as any, 3);
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
						'!!! 警告：快照所属PCB与当前不一致 !!!\n\n可能会导致数据错乱，系统将尝试备份当前状态。是否继续？',
						'!!! 危险操作确认 !!!',
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
						'确定恢复快照？当前未保存的修改将丢失。',
						'恢复快照',
						undefined,
						undefined,
						(ok: boolean) => resolve(ok),
					);
				});
			}
		}

		if (!confirmed)
			return false;

		// 自动备份逻辑：将手动恢复视为一个独立操作，记录 Before/After
		const snapName = snapshot.name.replace(/^\[.*?\]\s*/, '');
		const isSpecialRestore = snapshot.isManual || isMismatch;

		if (isSpecialRestore) {
			const beforeName = `恢复 [${snapName}] Before`;
			await createSnapshot(beforeName, false);
		}

		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.showLoading();
		}

		// 恢复逻辑 (Diff)
		const currentLines = extractPrimitiveData(await eda.pcb_PrimitiveLine.getAll() || [], 'line');
		const currentArcs = extractPrimitiveData(await eda.pcb_PrimitiveArc.getAll() || [], 'arc');

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
				const lineWidth = l.w ?? l.lineWidth ?? 10;
				await eda.pcb_PrimitiveLine.create(
					l.n ?? l.net,
					l.l ?? l.layer,
					l.sX ?? l.sx ?? l.startX,
					l.sY ?? l.sy ?? l.startY,
					l.eX ?? l.ex ?? l.endX,
					l.eY ?? l.ey ?? l.endY,
					lineWidth,
				);
			}
			catch (e) { logWarn(`Line restore error: ${e}`); }
		}

		// 修复快照中圆弧线宽（通过连接关系从导线推导）
		// arcsToCreate 引用自 snapshot.arcs 对象，修改会同步生效
		resolveArcWidths(snapshot.lines, snapshot.arcs);

		// 创建圆弧
		for (const a of arcsToCreate) {
			try {
				const startX = a.sX ?? a.sx ?? a.startX;
				const angle = a.a ?? a.arcAngle;
				// 优先使用 geo map 中的正确宽度（由 beautifyRouting 写入）
				// 快照中的 w 可能因之前的 API Bug 而不正确
				let width = a.w ?? a.lineWidth ?? 10;
				const geoKey = makeArcWidthGeoKey(
					a.n ?? a.net,
					a.l ?? a.layer,
					startX,
					a.sY ?? a.sy ?? a.startY,
					a.eX ?? a.ex ?? a.endX,
					a.eY ?? a.ey ?? a.endY,
				);
				const geoWidth = getArcWidthByGeoMap().get(geoKey);
				if (geoWidth !== undefined) {
					width = geoWidth;
				}
				if (startX !== undefined && angle !== undefined) {
					await eda.pcb_PrimitiveArc.create(
						a.n ?? a.net,
						a.l ?? a.layer,
						startX,
						a.sY ?? a.sy ?? a.startY,
						a.eX ?? a.ex ?? a.endX,
						a.eY ?? a.ey ?? a.endY,
						angle,
						width,
					);
				}
			}
			catch (e) { logWarn(`Arc restore error: ${e}`); }
		}

		if (showToast && eda.sys_Message) {
			eda.sys_Message.showToastMessage(`恢复成功 (L:${linesToCreate.length - linesToDelete.length}, A:${arcsToCreate.length - arcsToDelete.length})`, 'success' as any, 2);
		}

		// 如果是特殊恢复（手动或跨PCB），创建 After 快照作为当前状态
		if (isSpecialRestore) {
			const afterName = `恢复 [${snapName}] After`;
			await createSnapshot(afterName, false);
		}

		// 记录恢复点：无论是手动还是自动，都记录其 ID 以便在 UI 显示“上次撤销至此”
		setLastRestoredId(snapshot.id);

		notifySnapshotChange();
		return true;
	}
	catch (e: any) {
		logError(`Restore failed: ${e.message || e}`, 'Snapshot');
		if (eda.sys_Message)
			eda.sys_Message.showToastMessage(`恢复快照失败: ${e.message}`, 'error' as any, 4);
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
			eda.sys_Message?.showToastMessage('无效的 PCB 状态', 'warn' as any, 3);
			return;
		}

		const pcbId = currentPcb.id;
		const pcbData = await getPcbStorageData(pcbId);

		// 如果没有自动快照
		if (!pcbData || !pcbData.auto || pcbData.auto.length === 0) {
			eda.sys_Message?.showToastMessage('没有可撤销的操作', 'info' as any, 2);
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

		// 补偿检查：
		// 1. 如果是从 manual 恢复的 (lastRestoredId 在 auto 中不存在)
		// 2. 或者是正常操作后第一次撤销 (lastRestoredId 为空)
		// 只要顶部是 "After" 快照（代表当前状态），就需要跳过它去恢复 "Before"
		if (startIndex === 0) {
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
				const msg = '已撤销';
				const dispName = targetSnapshot.name.replace(/^\[.*?\]\s*/, '');
				eda.sys_Message?.showToastMessage(`${msg}: ${dispName}`, 'info' as any, 2);
			}
		}
		else {
			eda.sys_Message?.showToastMessage('已到达撤销记录尽头', 'info' as any, 2);
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
