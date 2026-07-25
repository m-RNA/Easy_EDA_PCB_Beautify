import assert from 'node:assert/strict';
import process from 'node:process';

async function main() {
	let enableDRC = true;
	let rebuildCopper = true;
	const events: string[] = [];
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
		},
		sys_Log: { add: () => undefined },
		sys_Message: { showToastMessage: () => undefined },
		sys_Storage: {
			getExtensionAllUserConfigs: async () => ({
				enableDRC,
				drcIgnoreCopperPour: true,
				rebuildCopperPourAfterBeautify: rebuildCopper,
				copperPourRebuildLimit: 30,
			}),
		},
	};

	const { finalizeRoutingOperation } = await import('../src/index');
	const { rebuildAllCopperPoursAfterRestoreIfEnabled } = await import('../src/lib/eda_utils');

	await finalizeRoutingOperation({
		issueCount: 1,
		violatedLayers: new Set([1]),
	});
	assert.deepEqual(events, ['rebuild', 'drc'], '美化后应先完成覆铜重铺，再执行最终 DRC');

	rebuildCopper = false;
	events.length = 0;
	await finalizeRoutingOperation();
	assert.deepEqual(events, ['drc'], '即使未启用或未发生覆铜重铺，美化完成后也必须执行最终 DRC');

	rebuildCopper = true;
	enableDRC = false;
	events.length = 0;
	await finalizeRoutingOperation({
		issueCount: 1,
		violatedLayers: new Set([1]),
	});
	assert.deepEqual(events, ['rebuild'], '关闭 DRC 时仍应重铺覆铜，但不能运行最终 DRC');

	enableDRC = true;
	events.length = 0;
	await rebuildAllCopperPoursAfterRestoreIfEnabled();
	assert.deepEqual(events, ['rebuild'], '普通快照恢复只负责重新覆铜，不应触发美化完成后的最终 DRC');

	console.log('copper rebuild tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
