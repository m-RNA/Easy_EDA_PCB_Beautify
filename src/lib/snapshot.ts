import { mapWithConcurrency } from './asyncPool';
import { getArcWidthByGeoMap, makeArcWidthGeoKey } from './beautify';
import { debugLog, logError, logInfo, logWarn } from './logger';
import { isClose } from './math';

const RESTORE_CREATE_CONCURRENCY = 8;
const RESTORE_CREATE_RETRIES = 3;
const RESTORE_DELETE_BATCH_SIZES = [200, 50, 1] as const;
const RESTORE_STABILITY_DELAYS = [100, 250, 500] as const;
const SNAPSHOT_GEOMETRY_EPSILON = 0.002;
const SNAPSHOT_GEOMETRY_BUCKET_SIZE = 0.01;
const SNAPSHOT_LINE_COVERAGE_EPSILON = 0.003;

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
	restoreStrategy?: 'full' | 'incremental';
}

export function getSnapshotRestoreStrategy(snapshot: RoutingSnapshot): 'full' | 'incremental' {
	if (snapshot.restoreStrategy)
		return snapshot.restoreStrategy;
	return /\(All\) Before$/.test(snapshot.name) ? 'full' : 'incremental';
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

function isLineGeometryEqual(a: any, b: any) {
	if (!a || !b)
		return false;
	if ((a.l ?? a.layer) !== (b.l ?? b.layer) || (a.n ?? a.net) !== (b.n ?? b.net))
		return false;
	if (!isClose(a.w ?? a.lineWidth, b.w ?? b.lineWidth, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	const lockA = a.k ?? a.primitiveLock;
	const lockB = b.k ?? b.primitiveLock;
	if (lockA !== undefined && lockB !== undefined && lockA !== lockB)
		return false;
	const forward = isClose(a.sX ?? a.sx ?? a.startX, b.sX ?? b.sx ?? b.startX, SNAPSHOT_GEOMETRY_EPSILON)
		&& isClose(a.sY ?? a.sy ?? a.startY, b.sY ?? b.sy ?? b.startY, SNAPSHOT_GEOMETRY_EPSILON)
		&& isClose(a.eX ?? a.ex ?? a.endX, b.eX ?? b.ex ?? b.endX, SNAPSHOT_GEOMETRY_EPSILON)
		&& isClose(a.eY ?? a.ey ?? a.endY, b.eY ?? b.ey ?? b.endY, SNAPSHOT_GEOMETRY_EPSILON);
	const reversed = isClose(a.sX ?? a.sx ?? a.startX, b.eX ?? b.ex ?? b.endX, SNAPSHOT_GEOMETRY_EPSILON)
		&& isClose(a.sY ?? a.sy ?? a.startY, b.eY ?? b.ey ?? b.endY, SNAPSHOT_GEOMETRY_EPSILON)
		&& isClose(a.eX ?? a.ex ?? a.endX, b.sX ?? b.sx ?? b.startX, SNAPSHOT_GEOMETRY_EPSILON)
		&& isClose(a.eY ?? a.ey ?? a.endY, b.sY ?? b.sy ?? b.startY, SNAPSHOT_GEOMETRY_EPSILON);
	return forward || reversed;
}

// 辅助函数：比较 Line 是否一致
function isLineEqual(a: any, b: any) {
	if (!a || !b || (a.i || a.id) !== (b.i || b.id))
		return false;
	return isLineGeometryEqual(a, b);
}

function isArcGeometryEqual(a: any, b: any) {
	if (!a || !b)
		return false;
	if ((a.l ?? a.layer) !== (b.l ?? b.layer) || (a.n ?? a.net) !== (b.n ?? b.net))
		return false;
	if (!isClose(a.sX ?? a.sx ?? a.startX, b.sX ?? b.sx ?? b.startX, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	if (!isClose(a.sY ?? a.sy ?? a.startY, b.sY ?? b.sy ?? b.startY, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	if (!isClose(a.eX ?? a.ex ?? a.endX, b.eX ?? b.ex ?? b.endX, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	if (!isClose(a.eY ?? a.ey ?? a.endY, b.eY ?? b.ey ?? b.endY, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	if (!isClose(a.a ?? a.arcAngle, b.a ?? b.arcAngle, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	if (!isClose(a.w ?? a.lineWidth, b.w ?? b.lineWidth, SNAPSHOT_GEOMETRY_EPSILON))
		return false;
	return true;
}

// 辅助函数：比较 Arc 是否一致
function isArcEqual(a: any, b: any) {
	if (!a || !b || (a.i || a.id) !== (b.i || b.id))
		return false;
	return isArcGeometryEqual(a, b);
}

function getPrimitiveCoordinate(p: any, key: 'sx' | 'sy' | 'ex' | 'ey'): number {
	if (key === 'sx')
		return p.sX ?? p.sx ?? p.startX ?? 0;
	if (key === 'sy')
		return p.sY ?? p.sy ?? p.startY ?? 0;
	if (key === 'ex')
		return p.eX ?? p.ex ?? p.endX ?? 0;
	return p.eY ?? p.ey ?? p.endY ?? 0;
}

function geometryBucketKey(type: 'line' | 'arc', p: any, offsets: [number, number, number, number] = [0, 0, 0, 0]): string {
	const net = p.n ?? p.net ?? '';
	const layer = p.l ?? p.layer ?? 0;
	let startX = getPrimitiveCoordinate(p, 'sx');
	let startY = getPrimitiveCoordinate(p, 'sy');
	let endX = getPrimitiveCoordinate(p, 'ex');
	let endY = getPrimitiveCoordinate(p, 'ey');
	if (type === 'line' && (startX > endX || (startX === endX && startY > endY))) {
		[startX, endX] = [endX, startX];
		[startY, endY] = [endY, startY];
	}
	const sx = Math.floor(startX / SNAPSHOT_GEOMETRY_BUCKET_SIZE) + offsets[0];
	const sy = Math.floor(startY / SNAPSHOT_GEOMETRY_BUCKET_SIZE) + offsets[1];
	const ex = Math.floor(endX / SNAPSHOT_GEOMETRY_BUCKET_SIZE) + offsets[2];
	const ey = Math.floor(endY / SNAPSHOT_GEOMETRY_BUCKET_SIZE) + offsets[3];
	return `${net}|${layer}|${sx}|${sy}|${ex}|${ey}`;
}

function buildRestoreGeometryBuckets(type: 'line' | 'arc', primitives: any[]) {
	const buckets = new Map<string, any[]>();
	for (const primitive of primitives) {
		const key = geometryBucketKey(type, primitive);
		const bucket = buckets.get(key) || [];
		bucket.push(primitive);
		buckets.set(key, bucket);
	}
	return buckets;
}

function takeRestoreGeometryMatch(type: 'line' | 'arc', target: any, buckets: Map<string, any[]>): any | undefined {
	const equals = type === 'line' ? isLineGeometryEqual : isArcGeometryEqual;
	for (let sx = -1; sx <= 1; sx++) {
		for (let sy = -1; sy <= 1; sy++) {
			for (let ex = -1; ex <= 1; ex++) {
				for (let ey = -1; ey <= 1; ey++) {
					const key = geometryBucketKey(type, target, [sx, sy, ex, ey]);
					const candidates = buckets.get(key);
					if (!candidates)
						continue;
					const index = candidates.findIndex(candidate => equals(target, candidate));
					if (index >= 0)
						return candidates.splice(index, 1)[0];
				}
			}
		}
	}
	return undefined;
}

function isPrimitiveGeometryMultisetEqual(type: 'line' | 'arc', target: any[], actual: any[]): boolean {
	if (target.length !== actual.length)
		return false;
	const buckets = buildRestoreGeometryBuckets(type, actual);
	return target.every(primitive => !!takeRestoreGeometryMatch(type, primitive, buckets));
}

function getLineAngleBucket(line: any): number {
	let angle = Math.atan2(
		getPrimitiveCoordinate(line, 'ey') - getPrimitiveCoordinate(line, 'sy'),
		getPrimitiveCoordinate(line, 'ex') - getPrimitiveCoordinate(line, 'sx'),
	) * 180 / Math.PI;
	while (angle < 0)
		angle += 180;
	while (angle >= 180)
		angle -= 180;
	return Math.round(angle) % 180;
}

function getLineCoverageBucketKey(line: any, angleBucket: number = getLineAngleBucket(line)): string {
	const net = line.n ?? line.net ?? '';
	const layer = line.l ?? line.layer ?? 0;
	return `${net}|${layer}|${(angleBucket + 180) % 180}`;
}

function buildLineCoverageIndex(lines: any[]) {
	const index = new Map<string, any[]>();
	for (const line of lines) {
		const key = getLineCoverageBucketKey(line);
		const bucket = index.get(key) || [];
		bucket.push(line);
		index.set(key, bucket);
	}
	return index;
}

function isLineCoveredByIndex(line: any, coverageIndex: Map<string, any[]>): boolean {
	const startX = getPrimitiveCoordinate(line, 'sx');
	const startY = getPrimitiveCoordinate(line, 'sy');
	const dx = getPrimitiveCoordinate(line, 'ex') - startX;
	const dy = getPrimitiveCoordinate(line, 'ey') - startY;
	const length = Math.hypot(dx, dy);
	if (length < SNAPSHOT_LINE_COVERAGE_EPSILON)
		return true; // 零长度/退化导线没有实际铜覆盖，宿主重建时可能直接丢弃。
	const ux = dx / length;
	const uy = dy / length;
	const angleBucket = getLineAngleBucket(line);
	const candidates: any[] = [];
	for (let offset = -1; offset <= 1; offset++) {
		const bucket = coverageIndex.get(getLineCoverageBucketKey(line, angleBucket + offset));
		if (bucket)
			candidates.push(...bucket);
	}

	const intervals: Array<[number, number]> = [];
	for (const candidate of candidates) {
		if (!isClose(line.w ?? line.lineWidth, candidate.w ?? candidate.lineWidth, SNAPSHOT_GEOMETRY_EPSILON))
			continue;
		const candidateStartX = getPrimitiveCoordinate(candidate, 'sx');
		const candidateStartY = getPrimitiveCoordinate(candidate, 'sy');
		const candidateEndX = getPrimitiveCoordinate(candidate, 'ex');
		const candidateEndY = getPrimitiveCoordinate(candidate, 'ey');
		const candidateDx = candidateEndX - candidateStartX;
		const candidateDy = candidateEndY - candidateStartY;
		const candidateLength = Math.hypot(candidateDx, candidateDy);
		if (candidateLength < SNAPSHOT_LINE_COVERAGE_EPSILON)
			continue;
		const directionCross = Math.abs(ux * candidateDy / candidateLength - uy * candidateDx / candidateLength);
		if (directionCross > 0.01)
			continue;
		const startDistance = Math.abs(-uy * (candidateStartX - startX) + ux * (candidateStartY - startY));
		const endDistance = Math.abs(-uy * (candidateEndX - startX) + ux * (candidateEndY - startY));
		if (startDistance > SNAPSHOT_LINE_COVERAGE_EPSILON || endDistance > SNAPSHOT_LINE_COVERAGE_EPSILON)
			continue;
		const startProjection = ux * (candidateStartX - startX) + uy * (candidateStartY - startY);
		const endProjection = ux * (candidateEndX - startX) + uy * (candidateEndY - startY);
		const intervalStart = Math.min(startProjection, endProjection);
		const intervalEnd = Math.max(startProjection, endProjection);
		if (intervalEnd >= -SNAPSHOT_LINE_COVERAGE_EPSILON && intervalStart <= length + SNAPSHOT_LINE_COVERAGE_EPSILON)
			intervals.push([intervalStart, intervalEnd]);
	}
	intervals.sort((a, b) => a[0] - b[0]);
	let coveredUntil = 0;
	for (const [intervalStart, intervalEnd] of intervals) {
		if (intervalStart > coveredUntil + SNAPSHOT_LINE_COVERAGE_EPSILON)
			break;
		coveredUntil = Math.max(coveredUntil, intervalEnd);
		if (coveredUntil >= length - SNAPSHOT_LINE_COVERAGE_EPSILON)
			return true;
	}
	return false;
}

function logLineCoverageDiagnostic(stage: string, target: any[], actual: any[]) {
	const targetIndex = buildLineCoverageIndex(target);
	const actualIndex = buildLineCoverageIndex(actual);
	const targetUncovered = target.filter(line => !isLineCoveredByIndex(line, actualIndex));
	const actualUncovered = actual.filter(line => !isLineCoveredByIndex(line, targetIndex));
	const getDegenerateCount = (lines: any[]) => lines.filter((line) => {
		return Math.hypot(
			getPrimitiveCoordinate(line, 'ex') - getPrimitiveCoordinate(line, 'sx'),
			getPrimitiveCoordinate(line, 'ey') - getPrimitiveCoordinate(line, 'sy'),
		) < SNAPSHOT_LINE_COVERAGE_EPSILON;
	}).length;
	logWarn(
		`[SnapshotCoverage] stage=${stage} length-totals-match=${hasEquivalentLineLengthTotals(target, actual)} target-degenerate=${getDegenerateCount(target)} actual-degenerate=${getDegenerateCount(actual)} target-uncovered=${targetUncovered.length} actual-uncovered=${actualUncovered.length} target-uncovered-sample=${JSON.stringify(targetUncovered.slice(0, 5).map(geometrySortKey))} actual-uncovered-sample=${JSON.stringify(actualUncovered.slice(0, 5).map(geometrySortKey))}`,
		'Snapshot',
	);
}

function getLineLengthTotals(lines: any[]) {
	const totals = new Map<string, { length: number; count: number }>();
	for (const line of lines) {
		const net = line.n ?? line.net ?? '';
		const layer = line.l ?? line.layer ?? 0;
		const width = (line.w ?? line.lineWidth ?? 0).toFixed(3);
		const key = `${net}|${layer}|${width}`;
		const total = totals.get(key) || { length: 0, count: 0 };
		total.length += Math.hypot(
			getPrimitiveCoordinate(line, 'ex') - getPrimitiveCoordinate(line, 'sx'),
			getPrimitiveCoordinate(line, 'ey') - getPrimitiveCoordinate(line, 'sy'),
		);
		total.count++;
		totals.set(key, total);
	}
	return totals;
}

function hasEquivalentLineLengthTotals(target: any[], actual: any[]): boolean {
	const targetTotals = getLineLengthTotals(target);
	const actualTotals = getLineLengthTotals(actual);
	const keys = new Set([...targetTotals.keys(), ...actualTotals.keys()]);
	for (const key of keys) {
		const targetTotal = targetTotals.get(key);
		const actualTotal = actualTotals.get(key);
		if (!targetTotal || !actualTotal)
			return false;
		const accumulatedTolerance = SNAPSHOT_LINE_COVERAGE_EPSILON * Math.max(targetTotal.count, actualTotal.count, 1);
		if (Math.abs(targetTotal.length - actualTotal.length) > accumulatedTolerance)
			return false;
	}
	return true;
}

interface HostNormalizedEvaluation {
	equivalent: boolean;
	reason: string;
}

function evaluateSnapshotHostNormalizedEquivalent(target: RoutingSnapshot, actual: RoutingSnapshot): HostNormalizedEvaluation {
	if (!isPrimitiveGeometryMultisetEqual('arc', target.arcs, actual.arcs))
		return { equivalent: false, reason: `arc-geometry-mismatch target=${target.arcs.length} actual=${actual.arcs.length}` };

	const maxLineCountDelta = Math.max(10, Math.ceil(target.lines.length * 0.01));
	const lineCountDelta = Math.abs(target.lines.length - actual.lines.length);
	if (lineCountDelta > maxLineCountDelta)
		return { equivalent: false, reason: `line-count-delta delta=${lineCountDelta} allowed=${maxLineCountDelta}` };

	const targetTotals = getLineLengthTotals(target.lines);
	const actualTotals = getLineLengthTotals(actual.lines);
	const keys = new Set([...targetTotals.keys(), ...actualTotals.keys()]);
	for (const key of keys) {
		const targetTotal = targetTotals.get(key);
		const actualTotal = actualTotals.get(key);
		if (!targetTotal || !actualTotal)
			return { equivalent: false, reason: `line-group-missing key="${key}" side=${targetTotal ? 'actual' : 'target'}` };
		const width = Number(key.slice(key.lastIndexOf('|') + 1)) || 0;
		const lengthDelta = Math.abs(targetTotal.length - actualTotal.length);
		const lengthTolerance = Math.max(
			SNAPSHOT_LINE_COVERAGE_EPSILON * Math.max(targetTotal.count, actualTotal.count, 1),
			Math.max(targetTotal.length, actualTotal.length) * 0.01,
			width * 2,
		);
		if (lengthDelta > lengthTolerance) {
			return {
				equivalent: false,
				reason: `line-length-delta key="${key}" target=${targetTotal.length.toFixed(3)} actual=${actualTotal.length.toFixed(3)} delta=${lengthDelta.toFixed(3)} allowed=${lengthTolerance.toFixed(3)}`,
			};
		}
	}

	const targetIndex = buildLineCoverageIndex(target.lines);
	const actualIndex = buildLineCoverageIndex(actual.lines);
	const targetUncovered = target.lines.filter(line => !isLineCoveredByIndex(line, actualIndex)).length;
	const actualUncovered = actual.lines.filter(line => !isLineCoveredByIndex(line, targetIndex)).length;
	const maxUncovered = Math.max(10, Math.ceil(target.lines.length * 0.002));
	if (targetUncovered > maxUncovered || actualUncovered > maxUncovered) {
		return {
			equivalent: false,
			reason: `uncovered-lines target=${targetUncovered} actual=${actualUncovered} allowed=${maxUncovered}`,
		};
	}
	return {
		equivalent: true,
		reason: `accepted line-count-delta=${lineCountDelta} uncovered=${targetUncovered}/${actualUncovered}`,
	};
}

export function isSnapshotHostNormalizedEquivalent(target: RoutingSnapshot, actual: RoutingSnapshot): boolean {
	return evaluateSnapshotHostNormalizedEquivalent(target, actual).equivalent;
}

/**
 * 几何排序键：忽略图元 ID，仅包含坐标、网络、层、线宽、角度
 * 仅用于高精度诊断输出，不参与恢复判断。
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

interface PrimitiveGeometryDiff {
	key: string;
	count: number;
	ids: string[];
}

export interface SnapshotGeometryDiff {
	extraLines: PrimitiveGeometryDiff[];
	missingLines: PrimitiveGeometryDiff[];
	extraArcs: PrimitiveGeometryDiff[];
	missingArcs: PrimitiveGeometryDiff[];
}

function buildGeometryBuckets(primitives: any[]) {
	const buckets = new Map<string, { count: number; ids: string[] }>();
	for (const primitive of primitives) {
		const key = geometrySortKey(primitive);
		const bucket = buckets.get(key) || { count: 0, ids: [] };
		bucket.count++;
		const id = primitive.i || primitive.id;
		if (typeof id === 'string' && bucket.ids.length < 5)
			bucket.ids.push(id);
		buckets.set(key, bucket);
	}
	return buckets;
}

function diffPrimitiveGeometry(target: any[], actual: any[]) {
	const targetBuckets = buildGeometryBuckets(target);
	const actualBuckets = buildGeometryBuckets(actual);
	const extra: PrimitiveGeometryDiff[] = [];
	const missing: PrimitiveGeometryDiff[] = [];
	const keys = new Set([...targetBuckets.keys(), ...actualBuckets.keys()]);
	for (const key of keys) {
		const targetBucket = targetBuckets.get(key) || { count: 0, ids: [] };
		const actualBucket = actualBuckets.get(key) || { count: 0, ids: [] };
		if (actualBucket.count > targetBucket.count) {
			extra.push({
				key,
				count: actualBucket.count - targetBucket.count,
				ids: actualBucket.ids,
			});
		}
		else if (targetBucket.count > actualBucket.count) {
			missing.push({
				key,
				count: targetBucket.count - actualBucket.count,
				ids: targetBucket.ids,
			});
		}
	}
	return { extra, missing };
}

export function getSnapshotGeometryDiff(target: RoutingSnapshot, actual: RoutingSnapshot): SnapshotGeometryDiff {
	const lineDiff = diffPrimitiveGeometry(target.lines, actual.lines);
	const arcDiff = diffPrimitiveGeometry(target.arcs, actual.arcs);
	return {
		extraLines: lineDiff.extra,
		missingLines: lineDiff.missing,
		extraArcs: arcDiff.extra,
		missingArcs: arcDiff.missing,
	};
}

function logSnapshotGeometryDiff(stage: string, target: RoutingSnapshot, actual: RoutingSnapshot) {
	const diff = getSnapshotGeometryDiff(target, actual);
	logWarn(
		`[SnapshotDiff] stage=${stage} extra-lines=${diff.extraLines.reduce((count, item) => count + item.count, 0)} missing-lines=${diff.missingLines.reduce((count, item) => count + item.count, 0)} extra-arcs=${diff.extraArcs.reduce((count, item) => count + item.count, 0)} missing-arcs=${diff.missingArcs.reduce((count, item) => count + item.count, 0)} extra-line-sample=${JSON.stringify(diff.extraLines.slice(0, 5))} missing-line-sample=${JSON.stringify(diff.missingLines.slice(0, 5))}`,
		'Snapshot',
	);
}

export async function diagnoseSnapshotDiff(snapshotId: number) {
	const currentPcb = await getCurrentPcbInfoSafe();
	if (!currentPcb)
		throw new Error('未找到当前 PCB');

	const pcbStore = await getPcbStorageData(currentPcb.id);
	const snapshot = pcbStore.manual.find(item => item.id === snapshotId)
		|| pcbStore.auto.find(item => item.id === snapshotId);
	if (!snapshot)
		throw new Error('未找到指定快照');

	const currentState = await readCurrentRoutingState(currentPcb.id);
	const diff = getSnapshotGeometryDiff(snapshot, currentState);
	logSnapshotGeometryDiff('manual-diagnostic', snapshot, currentState);
	return {
		targetLines: snapshot.lines.length,
		targetArcs: snapshot.arcs.length,
		actualLines: currentState.lines.length,
		actualArcs: currentState.arcs.length,
		diff,
	};
}

/**
 * 仅比较几何数据的快照一致性检查（忽略图元 ID）
 * 解决 undo/restore 循环后图元 ID 变化导致 isSnapshotDataIdentical 去重失败的问题
 */
export function isSnapshotGeometryIdentical(a: RoutingSnapshot, b: RoutingSnapshot): boolean {
	if (a.lines.length !== b.lines.length || a.arcs.length !== b.arcs.length)
		return false;

	// 宿主重新读取图元时会在保留 primitive ID 的同时产生约 0.001 的坐标量化漂移。
	// 优先按 ID 使用容差比较，避免把同一个图元误判为“缺失 + 新增”。
	const linesById = new Map(b.lines.map(line => [line.i || line.id, line]));
	const arcsById = new Map(b.arcs.map(arc => [arc.i || arc.id, arc]));
	const allLineIdsMatch = a.lines.every((line) => {
		const id = line.i || line.id;
		return typeof id === 'string' && isLineEqual(line, linesById.get(id));
	});
	const allArcIdsMatch = a.arcs.every((arc) => {
		const id = arc.i || arc.id;
		return typeof id === 'string' && isArcEqual(arc, arcsById.get(id));
	});
	if (allLineIdsMatch && allArcIdsMatch)
		return true;

	const arcsMatch = isPrimitiveGeometryMultisetEqual('arc', a.arcs, b.arcs);
	if (!arcsMatch)
		return false;
	return isPrimitiveGeometryMultisetEqual('line', a.lines, b.lines);
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
				k: p.getState_PrimitiveLock ? p.getState_PrimitiveLock() : (p.primitiveLock ?? false),
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
 * @param returnLatestIfIdentical 若状态与最新快照一致，是否返回该快照供内部回滚使用
 */
export async function createSnapshot(
	name: string = 'Auto Save',
	isManual: boolean = false,
	returnLatestIfIdentical: boolean = false,
	restoreStrategy?: 'full' | 'incremental',
): Promise<RoutingSnapshot | null> {
	const perfStartedAt = Date.now();
	let perfLastAt = perfStartedAt;
	const perfStages: string[] = [];
	let perfLineCount = 0;
	let perfArcCount = 0;
	let perfResult = 'failed';
	const markPerf = (label: string) => {
		const now = Date.now();
		perfStages.push(`${label}=${now - perfLastAt}ms`);
		perfLastAt = now;
	};

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
		perfLineCount = lines?.length || 0;
		perfArcCount = arcs?.length || 0;
		markPerf('read-primitives');

		const snapshot: RoutingSnapshot = {
			id: Date.now(),
			name: finalName,
			timestamp: Date.now(),
			pcbId,
			isManual,
			restoreStrategy,
			lines: extractPrimitiveData(lines || [], 'line'),
			arcs: extractPrimitiveData(arcs || [], 'arc'),
		};

		// 修复圆弧线宽：通过端点连接关系从导线推导正确线宽
		// 解决 getState_LineWidth() 对圆弧返回 10mil 且 geo map key 不匹配的问题
		resolveArcWidths(snapshot.lines, snapshot.arcs);
		markPerf('serialize');

		// 获取现有数据
		const pcbStore = await getPcbStorageData(pcbId);
		markPerf('load-history');

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
				perfResult = 'identical';
				return returnLatestIfIdentical ? latest : null;
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
		markPerf('persist');

		// 通知设置界面刷新
		notifySnapshotChange();

		perfResult = 'created';
		return snapshot;
	}
	catch (e: any) {
		logError(`Create failed: ${e.message || e}`, 'Snapshot');
		if (eda.sys_Message)
			eda.sys_Message.showToastMessage(`创建快照失败: ${e.message}`, 'error' as any, 4);
		return null;
	}
	finally {
		logInfo(
			`[Perf][Snapshot] result=${perfResult} type=${isManual ? 'manual' : 'auto'} name="${name}" lines=${perfLineCount} arcs=${perfArcCount} total=${Date.now() - perfStartedAt}ms ${perfStages.join(' ')}`,
			'Performance',
		);
		if (eda.sys_LoadingAndProgressBar) {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}

/**
 * 核心引擎：对比并应用差异
 * 将快照状态与当前 PCB 状态进行对比，执行增删改操作
 */
export async function deleteStateDiffPrimitives(
	type: 'line' | 'arc',
	api: any,
	primitiveIds: string[],
): Promise<number> {
	const requestedIds = Array.from(new Set(primitiveIds.filter(id => typeof id === 'string' && id.length > 0)));
	let pendingIds = requestedIds;

	for (const batchSize of RESTORE_DELETE_BATCH_SIZES) {
		for (let start = 0; start < pendingIds.length; start += batchSize) {
			const chunk = pendingIds.slice(start, start + batchSize);
			try {
				const result = await api.delete(chunk);
				if (result === false)
					logWarn(`${type} restore delete returned false for ${chunk.length} primitives`, 'Snapshot');
			}
			catch (e) {
				logWarn(`${type} restore delete error: ${e}`, 'Snapshot');
			}
		}

		const livePrimitives = extractPrimitiveData(await api.getAll() || [], type);
		const liveIds = new Set(livePrimitives.map((p: any) => p.i || p.id));
		pendingIds = pendingIds.filter(id => liveIds.has(id));
		if (pendingIds.length === 0)
			return requestedIds.length;

		logWarn(
			`${type} restore delete incomplete after batch size ${batchSize}: ${pendingIds.length} primitives remain`,
			'Snapshot',
		);
	}

	throw new Error(`${type} 恢复删除失败：仍有 ${pendingIds.length} 个图元未删除`);
}

async function applyStateDiff(type: 'line' | 'arc', snapPrims: any[], currentPrims: any[]) {
	const api = type === 'line' ? eda.pcb_PrimitiveLine : eda.pcb_PrimitiveArc;
	if (!api)
		return { created: 0, deleted: 0, kept: 0 };

	const currentPrimsMap = new Map(currentPrims.map(p => [p.i || p.id, p]));
	const matchedOnPcbIds = new Set<string>();
	const snapRemaining: any[] = [];

	// 1. 第一轮：尝试精确 ID 匹配
	for (const snap of snapPrims) {
		const id = snap.i || snap.id;
		const current = currentPrimsMap.get(id);
		if (current) {
			const isEqual = type === 'line' ? isLineEqual(snap, current) : isArcEqual(snap, current);
			if (isEqual) {
				matchedOnPcbIds.add(id);
				currentPrimsMap.delete(id);
				continue;
			}
		}
		snapRemaining.push(snap);
	}

	// 2. 第二轮：模糊几何匹配 (解决 ID 变更但内容相同的场景)
	if (snapRemaining.length > 0 && currentPrimsMap.size > 0) {
		const geoMap = buildRestoreGeometryBuckets(type, Array.from(currentPrimsMap.values()));

		const finalSnapRemaining: any[] = [];
		for (const snap of snapRemaining) {
			const match = takeRestoreGeometryMatch(type, snap, geoMap);
			if (match) {
				matchedOnPcbIds.add(match.i || match.id);
				currentPrimsMap.delete(match.i || match.id);
			}
			else {
				finalSnapRemaining.push(snap);
			}
		}
		snapRemaining.splice(0, snapRemaining.length, ...finalSnapRemaining);
	}

	// 3. 执行删除：没被匹配上的当前图元
	const finalToDelete = Array.from(currentPrimsMap.keys()).filter((id): id is string => typeof id === 'string');
	const deletedCount = finalToDelete.length > 0
		? await deleteStateDiffPrimitives(type, api, finalToDelete)
		: 0;

	// 4. 执行创建：有限并发重建，并对 API 返回 undefined/异常的图元降并发重试。
	// 大型 PCB 逐条等待非常慢；同时旧实现把失败也计为成功，可能留下不完整恢复状态。
	let pendingCreates = [...snapRemaining];
	let createdCount = 0;
	for (let attempt = 0; attempt < RESTORE_CREATE_RETRIES && pendingCreates.length > 0; attempt++) {
		const concurrency = Math.max(1, RESTORE_CREATE_CONCURRENCY >> attempt);
		const results = await mapWithConcurrency(pendingCreates, concurrency, async (p) => {
			try {
				let result: any;
				if (type === 'line') {
					result = await (api as any).create(
						p.n ?? p.net,
						p.l ?? p.layer,
						p.sX ?? p.sx ?? p.startX,
						p.sY ?? p.sy ?? p.startY,
						p.eX ?? p.ex ?? p.endX,
						p.eY ?? p.ey ?? p.endY,
						p.w ?? p.lineWidth ?? 10,
						p.k ?? p.primitiveLock ?? false,
					);
				}
				else {
					const net = p.n ?? p.net;
					const layer = p.l ?? p.layer;
					const startX = p.sX ?? p.sx ?? p.startX;
					const startY = p.sY ?? p.sy ?? p.startY;
					const endX = p.eX ?? p.ex ?? p.endX;
					const endY = p.eY ?? p.ey ?? p.endY;
					const angle = p.a ?? p.arcAngle;
					const width = p.w ?? p.lineWidth ?? 10;
					result = await api.create(net, layer, startX, startY, endX, endY, angle, width);
					if (result)
						getArcWidthByGeoMap().set(makeArcWidthGeoKey(net, layer, startX, startY, endX, endY), width);
				}
				return !!result;
			}
			catch (e) {
				logWarn(`${type} recreate error: ${e}`);
				return false;
			}
		});

		createdCount += results.filter(Boolean).length;
		pendingCreates = pendingCreates.filter((_p, index) => !results[index]);
		if (pendingCreates.length > 0 && attempt + 1 < RESTORE_CREATE_RETRIES)
			await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
	}
	if (pendingCreates.length > 0)
		throw new Error(`${type} 恢复创建失败：仍有 ${pendingCreates.length} 个图元未创建`);

	return {
		created: createdCount,
		deleted: deletedCount,
		kept: matchedOnPcbIds.size,
		failed: 0,
	};
}

async function readCurrentRoutingState(pcbId: string): Promise<RoutingSnapshot> {
	const state: RoutingSnapshot = {
		id: 0,
		name: 'Restore Verification',
		timestamp: Date.now(),
		pcbId,
		lines: extractPrimitiveData(await eda.pcb_PrimitiveLine.getAll() || [], 'line'),
		arcs: extractPrimitiveData(await eda.pcb_PrimitiveArc.getAll() || [], 'arc'),
	};
	resolveArcWidths(state.lines, state.arcs);
	return state;
}

export async function verifySnapshotStateStable(snapshot: RoutingSnapshot, pcbId: string) {
	let state = await readCurrentRoutingState(pcbId);
	if (!isSnapshotGeometryIdentical(snapshot, state))
		return { identical: false, state };

	for (const delayMilliseconds of RESTORE_STABILITY_DELAYS) {
		await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
		state = await readCurrentRoutingState(pcbId);
		if (!isSnapshotGeometryIdentical(snapshot, state))
			return { identical: false, state };
	}
	return { identical: true, state };
}

async function verifyHostNormalizedStateStable(snapshot: RoutingSnapshot, pcbId: string, initialState: RoutingSnapshot) {
	let state = initialState;
	let evaluation = evaluateSnapshotHostNormalizedEquivalent(snapshot, state);
	if (!evaluation.equivalent)
		return { ...evaluation, state };
	for (const delayMilliseconds of RESTORE_STABILITY_DELAYS) {
		await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
		state = await readCurrentRoutingState(pcbId);
		evaluation = evaluateSnapshotHostNormalizedEquivalent(snapshot, state);
		if (!evaluation.equivalent)
			return { ...evaluation, state };
	}
	return { ...evaluation, state };
}

export async function applySnapshotStateDiff(snapshot: RoutingSnapshot, currentState: RoutingSnapshot) {
	const lineRes = await applyStateDiff('line', snapshot.lines, currentState.lines);
	resolveArcWidths(snapshot.lines, snapshot.arcs);
	const arcRes = await applyStateDiff('arc', snapshot.arcs, currentState.arcs);
	return { lineRes, arcRes };
}

export async function applySnapshotFullRestore(snapshot: RoutingSnapshot, currentState: RoutingSnapshot) {
	const arcIds = currentState.arcs.map(arc => arc.i || arc.id).filter((id): id is string => typeof id === 'string');
	const lineIds = currentState.lines.map(line => line.i || line.id).filter((id): id is string => typeof id === 'string');
	if (arcIds.length > 0)
		await deleteStateDiffPrimitives('arc', eda.pcb_PrimitiveArc, arcIds);
	if (lineIds.length > 0)
		await deleteStateDiffPrimitives('line', eda.pcb_PrimitiveLine, lineIds);
	const emptyState: RoutingSnapshot = {
		id: 0,
		name: 'Empty Full Restore State',
		timestamp: Date.now(),
		pcbId: currentState.pcbId,
		lines: [],
		arcs: [],
	};
	const result = await applySnapshotStateDiff(snapshot, emptyState);
	return {
		lineRes: { ...result.lineRes, deleted: lineIds.length },
		arcRes: { ...result.arcRes, deleted: arcIds.length },
	};
}

/**
 * 恢复快照
 */
export async function restoreSnapshot(snapshotId: number, showToast: boolean = true, requireConfirmation: boolean = false): Promise<boolean> {
	try {
		const currentPcb = await getCurrentPcbInfoSafe();
		if (!currentPcb)
			return false;

		const pcbStore = await getPcbStorageData(currentPcb.id);
		let snapshot = pcbStore.manual.find(s => s.id === snapshotId) || pcbStore.auto.find(s => s.id === snapshotId);

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
			eda.sys_Message?.showToastMessage('未找到指定快照', 'warn' as any, 3);
			return false;
		}

		let confirmed = !requireConfirmation;
		const isMismatch = snapshot.pcbId && snapshot.pcbId !== currentPcb.id;

		if (isMismatch && eda.sys_Dialog) {
			confirmed = await new Promise(r => eda.sys_Dialog.showConfirmationMessage('!!! 警告：快照所属PCB不一致 !!!\n可能会影响当前设计，是否确认恢复？', '危险确认', undefined, undefined, r));
		}
		else if (requireConfirmation && eda.sys_Dialog) {
			confirmed = await new Promise(r => eda.sys_Dialog.showConfirmationMessage('确定恢复快照？当前未保存的修改将丢失。', '确认恢复', undefined, undefined, r));
		}

		if (!confirmed)
			return false;

		// 触发 Before 备份（手动恢复或跨 PCB 恢复时）
		if (snapshot.isManual || isMismatch) {
			const snapName = snapshot.name.replace(/^\[.*?\]\s*/, '');
			await createSnapshot(`恢复 [${snapName}] 之前`, false);
		}

		if (eda.sys_LoadingAndProgressBar)
			eda.sys_LoadingAndProgressBar.showLoading();

		const currentState = await readCurrentRoutingState(currentPcb.id);
		const restoreStrategy = getSnapshotRestoreStrategy(snapshot);
		logInfo(
			`[SnapshotRestore] strategy=${restoreStrategy} target=${snapshot.lines.length}/${snapshot.arcs.length} current=${currentState.lines.length}/${currentState.arcs.length}`,
			'Performance',
		);
		const initialResult = restoreStrategy === 'full'
			? await applySnapshotFullRestore(snapshot, currentState)
			: await applySnapshotStateDiff(snapshot, currentState);
		const lineRes = initialResult.lineRes;
		const arcRes = initialResult.arcRes;
		const restoreMode = restoreStrategy;

		// 恢复策略在第一次执行前就由快照范围决定；失败时只诊断，不再自动执行第二轮变更。
		const verification = await verifySnapshotStateStable(snapshot, currentPcb.id);
		let verifiedState = verification.state;
		let normalizedEquivalent = false;
		let normalizedReason = '';
		if (!verification.identical && restoreStrategy === 'full') {
			const normalizedVerification = await verifyHostNormalizedStateStable(snapshot, currentPcb.id, verifiedState);
			normalizedEquivalent = normalizedVerification.equivalent;
			normalizedReason = normalizedVerification.reason;
			verifiedState = normalizedVerification.state;
		}
		if (!verification.identical && !normalizedEquivalent) {
			if (restoreStrategy === 'full')
				logWarn(`[SnapshotNormalized] rejected reason=${normalizedReason}`, 'Snapshot');
			logSnapshotGeometryDiff('failed', snapshot, verifiedState);
			logLineCoverageDiagnostic('failed', snapshot.lines, verifiedState.lines);
			throw new Error(
				`恢复后校验失败：目标 ${snapshot.lines.length} 条导线/${snapshot.arcs.length} 条圆弧，实际 ${verifiedState.lines.length} 条导线/${verifiedState.arcs.length} 条圆弧`,
			);
		}
		if (normalizedEquivalent) {
			logWarn(
				`[SnapshotRestore] result=verified-normalized mode=${restoreMode} target=${snapshot.lines.length}/${snapshot.arcs.length} actual=${verifiedState.lines.length}/${verifiedState.arcs.length}`,
				'Snapshot',
			);
		}
		logInfo(
			`[SnapshotRestore] result=${normalizedEquivalent ? 'verified-normalized' : 'verified'} mode=${restoreMode} lines-created=${lineRes.created} lines-deleted=${lineRes.deleted} arcs-created=${arcRes.created} arcs-deleted=${arcRes.deleted}`,
			'Performance',
		);

		if (showToast && eda.sys_Message) {
			const totalKept = lineRes.kept + arcRes.kept;
			const totalChanged = lineRes.created + arcRes.created + lineRes.deleted + arcRes.deleted;
			if (totalChanged === 0) {
				eda.sys_Message.showToastMessage('当前状态与快照完全一致', 'info' as any, 2);
			}
			else {
				eda.sys_Message.showToastMessage(`恢复成功：保持 ${totalKept}，更新 ${lineRes.created + arcRes.created} 处`, 'success' as any, 2);
			}
		}

		// 如果是手动或跨 PCB，恢复后存个 After
		if (snapshot.isManual || isMismatch) {
			const snapName = snapshot.name.replace(/^\[.*?\]\s*/, '');
			await createSnapshot(`恢复 [${snapName}] 之后`, false);
		}

		setLastRestoredId(snapshot.id);
		notifySnapshotChange();
		return true;
	}
	catch (e: any) {
		logError(`Restore failed: ${e.message || e}`);
		eda.sys_Message?.showToastMessage(`恢复失败: ${e.message || e}`, 'error' as any, 4);
		return false;
	}
	finally {
		eda.sys_LoadingAndProgressBar?.destroyLoading();
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
 * 撤销上一次操作 (复用 restoreSnapshot)
 */
export async function undoLastOperation() {
	if (isUndoing())
		return;
	setUndoing(true);

	try {
		const currentPcb = await getCurrentPcbInfoSafe();
		if (!currentPcb)
			return;

		const pcbData = await getPcbStorageData(currentPcb.id);
		const autoSnaps = pcbData.auto || [];

		if (autoSnaps.length === 0) {
			eda.sys_Message?.showToastMessage('没有可撤销的操作', 'info' as any, 2);
			return;
		}

		const lastId = getLastRestoredId();
		let targetIdx = 0;

		if (lastId !== null) {
			const idx = autoSnaps.findIndex(s => s.id === lastId);
			if (idx !== -1)
				targetIdx = idx + 1;
		}

		// 如果处于 "After" 状态（刚做完一次操作或刚恢复完），跳过 After 直达 Before
		if (targetIdx === 0 && autoSnaps[0].name.endsWith('After')) {
			targetIdx = 1;
		}

		if (targetIdx < autoSnaps.length) {
			const target = autoSnaps[targetIdx];
			const ok = await restoreSnapshot(target.id, false, false);
			if (ok) {
				const dispName = target.name.replace(/^\[.*?\]\s*/, '');
				eda.sys_Message?.showToastMessage(`已撤销至: ${dispName}`, 'info' as any, 2);
			}
		}
		else {
			eda.sys_Message?.showToastMessage('已到达撤销记录尽头', 'info' as any, 2);
		}
	}
	finally {
		setUndoing(false);
	}
}
