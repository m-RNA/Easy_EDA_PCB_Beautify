import assert from 'node:assert/strict';
import process from 'node:process';

async function main() {
	let enableDRC = true;
	let rebuildCopper = true;
	let experimentalFastRestore = false;
	let batchShouldFail = false;
	const events: string[] = [];
	const toastMessages: string[] = [];
	const pour = {
		getState_Layer: () => 1,
		rebuildCopperRegion: async () => {
			events.push('rebuild');
		},
	};
	(globalThis as any).eda = {
		pcb_Drc: {
			check: async () => {
				events.push('drc');
				return [];
			},
		},
		pcb_PrimitivePour: {
			getAll: async () => [pour],
			rebuildCopperRegions: async () => {
				events.push('batch-rebuild');
				if (batchShouldFail)
					throw new Error('expected batch failure');
				return [{}];
			},
		},
		sys_Log: { add: () => undefined },
		sys_Message: {
			showToastMessage: (message: string, type: string) => {
				toastMessages.push(`${type}:${message}`);
			},
		},
		sys_Storage: {
			getExtensionAllUserConfigs: async () => ({
				enableDRC,
				drcIgnoreCopperPour: true,
				rebuildCopperPourAfterBeautify: rebuildCopper,
				copperPourRebuildLimit: 30,
				experimentalFastRestore,
			}),
		},
	};

	const { finalizeRoutingOperation } = await import('../src/index');
	const { rebuildAllCopperPoursAfterRestoreIfEnabled } = await import('../src/lib/eda_utils');

	await finalizeRoutingOperation(
		{
			issueCount: 1,
			violatedLayers: new Set([1]),
		},
		'圆滑布线（全部）已完成',
	);
	assert.deepEqual(events, ['rebuild', 'drc'], '美化后应先完成覆铜重铺，再执行最终 DRC');
	assert.ok(
		toastMessages.includes('info:正在执行最终 DRC 检查...'),
		'运行最终 DRC 时应显示进度提示',
	);
	assert.equal(
		toastMessages.at(-1),
		'success:圆滑布线（全部）已完成',
		'真正的完成提示必须位于覆铜和最终 DRC 之后',
	);

	rebuildCopper = false;
	events.length = 0;
	toastMessages.length = 0;
	await finalizeRoutingOperation();
	assert.deepEqual(events, ['drc'], '即使未启用或未发生覆铜重铺，美化完成后也必须执行最终 DRC');
	assert.deepEqual(
		toastMessages,
		['info:正在执行最终 DRC 检查...'],
		'未提供顶层完成文案时只能显示 DRC 进度，不能产生伪完成提示',
	);

	rebuildCopper = true;
	enableDRC = false;
	events.length = 0;
	toastMessages.length = 0;
	await finalizeRoutingOperation(
		{
			issueCount: 1,
			violatedLayers: new Set([1]),
		},
		'过渡线宽（选中）已完成',
	);
	assert.deepEqual(events, ['rebuild'], '关闭 DRC 时仍应重铺覆铜，但不能运行最终 DRC');
	assert.equal(
		toastMessages.at(-1),
		'success:过渡线宽（选中）已完成',
		'关闭 DRC 时应在覆铜完成后显示最终完成提示',
	);

	enableDRC = true;
	events.length = 0;
	await rebuildAllCopperPoursAfterRestoreIfEnabled();
	assert.deepEqual(events, ['rebuild'], '普通快照恢复只负责重新覆铜，不应触发美化完成后的最终 DRC');

	experimentalFastRestore = true;
	events.length = 0;
	assert.equal(await rebuildAllCopperPoursAfterRestoreIfEnabled(), 1);
	assert.deepEqual(events, ['batch-rebuild'], 'Alpha 快照恢复应优先调用批量覆铜接口');

	batchShouldFail = true;
	events.length = 0;
	assert.equal(await rebuildAllCopperPoursAfterRestoreIfEnabled(), 1);
	assert.deepEqual(events, ['batch-rebuild', 'rebuild'], 'Alpha 批量覆铜失败后应回退逐块重铺');

	console.log('copper rebuild tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
