import assert from 'node:assert/strict';
import process from 'node:process';

function makeLine(id: string) {
	return {
		isAsync: () => false,
		getState_Net: () => 'GND',
		getState_Layer: () => 1,
		getState_PrimitiveId: () => id,
		getState_StartX: () => 0,
		getState_StartY: () => 0,
		getState_EndX: () => 10,
		getState_EndY: () => 0,
		getState_LineWidth: () => 1,
	};
}

async function main() {
	(globalThis as any).eda = {
		sys_Log: { add: () => undefined },
	};
	const {
		applySnapshotFullRestore,
		applySnapshotStateDiff,
		canReuseIdenticalSnapshot,
		deleteStateDiffPrimitives,
		getSnapshotGeometryDiff,
		getSnapshotRestoreStrategy,
		isSnapshotHostNormalizedEquivalent,
		isSnapshotGeometryIdentical,
		verifySnapshotStateStable,
	} = await import('../src/lib/snapshot');

	const ids = Array.from({ length: 450 }, (_, index) => `line-${index}`);
	const liveIds = new Set(ids);
	const partialDeleteApi = {
		delete: async (chunk: string[]) => {
			const limit = chunk.length > 50 ? Math.ceil(chunk.length / 2) : chunk.length;
			for (const id of chunk.slice(0, limit))
				liveIds.delete(id);
			return true;
		},
		getAll: async () => Array.from(liveIds, makeLine),
	};

	const deleted = await deleteStateDiffPrimitives('line', partialDeleteApi, ids);
	assert.equal(deleted, ids.length, '分批重试后应删除全部目标图元');
	assert.equal(liveIds.size, 0, '宿主静默部分删除时不能留下图元');

	const undeletableIds = ['line-a', 'line-b'];
	const noOpDeleteApi = {
		delete: async () => true,
		getAll: async () => undeletableIds.map(makeLine),
	};
	await assert.rejects(
		deleteStateDiffPrimitives('line', noOpDeleteApi, undeletableIds),
		/仍有 2 个图元未删除/,
		'无法删除的图元必须使恢复失败',
	);

	const duplicateLiveIds = new Set(['target-line', 'extra-line-1', 'extra-line-2', 'extra-line-3']);
	const duplicateLineApi = {
		delete: async (chunk: string[]) => {
			for (const id of chunk)
				duplicateLiveIds.delete(id);
			return true;
		},
		getAll: async () => Array.from(duplicateLiveIds, makeLine),
		create: async () => makeLine('created-line'),
	};
	(globalThis as any).eda.pcb_PrimitiveLine = duplicateLineApi;
	(globalThis as any).eda.pcb_PrimitiveArc = {
		delete: async () => true,
		getAll: async () => [],
		create: async () => undefined,
	};
	const targetLine = {
		i: 'target-line',
		n: 'GND',
		l: 1,
		sX: 0,
		sY: 0,
		eX: 10,
		eY: 0,
		w: 1,
	};
	const quantizedTargetLine = {
		...targetLine,
		sX: 1242.131,
		sY: 589.711,
		eX: 1241.823,
		eY: 589.403,
	};
	const quantizedCurrentLine = {
		...quantizedTargetLine,
		sY: 589.712,
	};
	const quantizedTarget = { id: 10, name: 'quantized-target', timestamp: 10, lines: [quantizedTargetLine], arcs: [] };
	const quantizedCurrent = { id: 11, name: 'quantized-current', timestamp: 11, lines: [quantizedCurrentLine], arcs: [] };
	assert.equal(
		isSnapshotGeometryIdentical(quantizedTarget, quantizedCurrent),
		true,
		'同一 primitive ID 的 0.001 宿主量化漂移不应触发恢复',
	);
	const quantizedDiagnosticDiff = getSnapshotGeometryDiff(quantizedTarget, quantizedCurrent);
	assert.equal(quantizedDiagnosticDiff.extraLines.length, 1, '诊断日志仍应保留 3 位精度以暴露量化漂移');
	assert.equal(quantizedDiagnosticDiff.missingLines.length, 1, '诊断日志仍应显示漂移前后的几何差异');
	const recreatedQuantizedCurrent = {
		...quantizedCurrent,
		lines: [{ ...quantizedCurrentLine, i: 'recreated-line' }],
	};
	assert.equal(
		isSnapshotGeometryIdentical(quantizedTarget, recreatedQuantizedCurrent),
		true,
		'重建后 primitive ID 改变时也应按 0.002 容差识别同一几何图元',
	);
	const reversedQuantizedCurrent = {
		...quantizedCurrent,
		lines: [{
			...quantizedCurrentLine,
			i: 'reversed-line',
			sX: quantizedCurrentLine.eX,
			sY: quantizedCurrentLine.eY,
			eX: quantizedCurrentLine.sX,
			eY: quantizedCurrentLine.sY,
		}],
	};
	assert.equal(
		isSnapshotGeometryIdentical(quantizedTarget, reversedQuantizedCurrent),
		true,
		'导线起终点方向反转不应改变铜覆盖',
	);
	const splitTarget = {
		id: 12,
		name: 'split-target',
		timestamp: 12,
		lines: [
			{ ...targetLine, i: 'split-a', sX: 699.499, eX: 681.302 },
			{ ...targetLine, i: 'split-b', sX: 681.302, eX: 652.395 },
		],
		arcs: [],
	};
	const mergedCurrent = {
		id: 13,
		name: 'merged-current',
		timestamp: 13,
		lines: [{ ...targetLine, i: 'merged', sX: 652.395, eX: 699.499 }],
		arcs: [],
	};
	assert.equal(
		isSnapshotGeometryIdentical(splitTarget, mergedCurrent),
		false,
		'宿主合并存在轻微折角的相邻线段时必须判定恢复不完整',
	);
	assert.equal(
		isSnapshotHostNormalizedEquivalent(splitTarget, mergedCurrent),
		true,
		'全量恢复应接受宿主对等长共线导线的合并',
	);
	const currentWithGap = {
		...mergedCurrent,
		lines: [
			{ ...targetLine, i: 'gap-a', sX: 652.395, eX: 675 },
			{ ...targetLine, i: 'gap-b', sX: 678, eX: 699.499 },
		],
	};
	assert.equal(
		isSnapshotGeometryIdentical(splitTarget, currentWithGap),
		false,
		'共线但存在真实断口时必须判定恢复不完整',
	);
	assert.equal(
		isSnapshotHostNormalizedEquivalent(splitTarget, currentWithGap),
		false,
		'宿主规范化校验不能接受真实断口',
	);
	const snappedShortLineTarget = {
		id: 16,
		name: 'snapped-short-target',
		timestamp: 16,
		lines: [{ ...targetLine, i: 'snap-target', n: 'AVDD0P8_MIPI', sX: 1099, sY: 1514.401, eX: 1099, eY: 1513.25, w: 11 }],
		arcs: [],
	};
	const snappedShortLineActual = {
		...snappedShortLineTarget,
		lines: [{ ...snappedShortLineTarget.lines[0], i: 'snap-actual', sX: 1100, sY: 1514.25, eX: 1100, eY: 1513.25 }],
	};
	assert.equal(
		isSnapshotHostNormalizedEquivalent(snappedShortLineTarget, snappedShortLineActual),
		true,
		'全量恢复应接受线宽范围内的短导线宿主吸附',
	);
	assert.equal(
		isSnapshotHostNormalizedEquivalent(snappedShortLineTarget, { ...snappedShortLineActual, lines: [] }),
		false,
		'宿主规范化校验不能接受整条导线丢失',
	);
	const targetWithDegenerateLines = {
		...mergedCurrent,
		lines: [
			...mergedCurrent.lines,
			{ ...targetLine, i: 'zero-a', sX: 20, eX: 20 },
			{ ...targetLine, i: 'zero-b', sX: 30, eX: 30 },
			{ ...targetLine, i: 'zero-c', sX: 40, eX: 40 },
		],
	};
	assert.equal(
		isSnapshotGeometryIdentical(targetWithDegenerateLines, mergedCurrent),
		false,
		'完整撤销必须保留快照中的 primitive 数量',
	);

	assert.equal(getSnapshotRestoreStrategy({ ...quantizedTarget, name: 'Beautify (All) Before' }), 'full');
	assert.equal(getSnapshotRestoreStrategy({ ...quantizedTarget, name: 'Beautify (Selected) Before' }), 'incremental');
	assert.equal(getSnapshotRestoreStrategy({ ...quantizedTarget, restoreStrategy: 'full' }), 'full');
	const fullBefore = { ...quantizedTarget, name: 'Beautify (All) Before', restoreStrategy: 'full' as const };
	const selectedBefore = { ...quantizedTarget, name: 'Beautify (Selected) Before', restoreStrategy: 'incremental' as const };
	assert.equal(
		canReuseIdenticalSnapshot(fullBefore, selectedBefore),
		false,
		'选中操作不能复用几何相同的全量 Before 快照',
	);
	assert.equal(
		canReuseIdenticalSnapshot(selectedBefore, { ...selectedBefore }),
		true,
		'同一选中操作的相同 Before 快照仍可去重',
	);

	const fullRestoreEvents: string[] = [];
	const fullRestoreLiveIds = new Set(['current-a', 'current-b']);
	(globalThis as any).eda.pcb_PrimitiveLine = {
		delete: async (ids: string[]) => {
			fullRestoreEvents.push(`delete-lines:${ids.sort().join(',')}`);
			for (const id of ids)
				fullRestoreLiveIds.delete(id);
			return true;
		},
		getAll: async () => Array.from(fullRestoreLiveIds, makeLine),
		create: async () => {
			fullRestoreEvents.push('create-line');
			fullRestoreLiveIds.add('restored-line');
			return makeLine('restored-line');
		},
	};
	(globalThis as any).eda.pcb_PrimitiveArc = {
		delete: async (ids: string[]) => {
			fullRestoreEvents.push(`delete-arcs:${ids.join(',')}`);
			return true;
		},
		getAll: async () => [],
		create: async () => undefined,
	};
	await applySnapshotFullRestore(
		{ id: 14, name: 'full-target', timestamp: 14, lines: [targetLine], arcs: [] },
		{
			id: 15,
			name: 'full-current',
			timestamp: 15,
			lines: [
				{ ...targetLine, i: 'current-a' },
				{ ...targetLine, i: 'current-b' },
			],
			arcs: [],
		},
	);
	assert.deepEqual(fullRestoreEvents, ['delete-lines:current-a,current-b', 'create-line']);
	assert.deepEqual(Array.from(fullRestoreLiveIds), ['restored-line'], '全量恢复必须先清空当前导线再创建目标状态');

	let quantizedDeletes = 0;
	let quantizedCreates = 0;
	(globalThis as any).eda.pcb_PrimitiveLine = {
		delete: async () => {
			quantizedDeletes++;
			return true;
		},
		getAll: async () => [],
		create: async () => {
			quantizedCreates++;
			return makeLine('unexpected');
		},
	};
	const quantizedResult = await applySnapshotStateDiff(quantizedTarget, reversedQuantizedCurrent);
	assert.deepEqual(quantizedResult.lineRes, { created: 0, deleted: 0, kept: 1, failed: 0 });
	assert.equal(quantizedDeletes, 0, '量化漂移不能删除原导线');
	assert.equal(quantizedCreates, 0, '量化漂移不能重建原导线');

	(globalThis as any).eda.pcb_PrimitiveLine = duplicateLineApi;
	await applySnapshotStateDiff(
		{ id: 1, name: 'target', timestamp: 1, lines: [targetLine], arcs: [] },
		{
			id: 2,
			name: 'current',
			timestamp: 2,
			lines: Array.from(duplicateLiveIds, id => ({ ...targetLine, i: id })),
			arcs: [],
		},
	);
	assert.deepEqual(Array.from(duplicateLiveIds), ['target-line'], '几何收敛必须删除重建时额外产生的重复导线');

	const targetSnapshot = { id: 3, name: 'stable-target', timestamp: 3, pcbId: 'pcb-test', lines: [targetLine], arcs: [] };
	const delayedLiveIds = new Set(['target-line']);
	const delayedLineApi = {
		delete: async (chunk: string[]) => {
			for (const id of chunk)
				delayedLiveIds.delete(id);
			return true;
		},
		getAll: async () => Array.from(delayedLiveIds, makeLine),
		create: async () => makeLine('created-line'),
	};
	(globalThis as any).eda.pcb_PrimitiveLine = delayedLineApi;
	setTimeout(() => {
		delayedLiveIds.add('delayed-extra-1');
		delayedLiveIds.add('delayed-extra-2');
		delayedLiveIds.add('delayed-extra-3');
	}, 25);
	const delayedVerification = await verifySnapshotStateStable(targetSnapshot, 'pcb-test');
	assert.equal(delayedVerification.identical, false, '稳定性校验必须发现宿主延迟生成的额外导线');
	assert.equal(delayedVerification.state.lines.length, 4, '应读取到延迟出现的三条额外导线');
	await applySnapshotStateDiff(targetSnapshot, delayedVerification.state);
	const stableVerification = await verifySnapshotStateStable(targetSnapshot, 'pcb-test');
	assert.equal(stableVerification.identical, true, '删除延迟图元后应在稳定窗口内保持与快照一致');
	assert.deepEqual(Array.from(delayedLiveIds), ['target-line']);

	const duplicateDiff = getSnapshotGeometryDiff(
		targetSnapshot,
		{
			...targetSnapshot,
			lines: [
				targetLine,
				{ ...targetLine, i: 'duplicate-1' },
				{ ...targetLine, i: 'duplicate-2' },
				{ ...targetLine, i: 'duplicate-3' },
			],
		},
	);
	assert.equal(duplicateDiff.extraLines.reduce((count, item) => count + item.count, 0), 3);
	assert.equal(duplicateDiff.missingLines.length, 0, '重复创建应表现为只有 extra、没有 missing');

	console.log('snapshot restore tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
