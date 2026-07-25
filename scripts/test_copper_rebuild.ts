import assert from 'node:assert/strict';
import process from 'node:process';

async function main() {
	let enableDRC = true;
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
				rebuildCopperPourAfterBeautify: true,
				copperPourRebuildLimit: 30,
			}),
		},
	};

	const {
		rebuildAllCopperPoursAfterRestoreIfEnabled,
		rebuildAllCopperPoursIfEnabled,
	} = await import('../src/lib/eda_utils');

	await rebuildAllCopperPoursIfEnabled({
		issueCount: 1,
		violatedLayers: new Set([1]),
	});
	assert.deepEqual(events, ['rebuild', 'drc'], '智能覆铜重铺完成后必须再执行一次 DRC');

	events.length = 0;
	await rebuildAllCopperPoursAfterRestoreIfEnabled();
	assert.deepEqual(events, ['rebuild', 'drc'], '恢复后的全量覆铜重铺完成后必须再执行一次 DRC');

	enableDRC = false;
	events.length = 0;
	await rebuildAllCopperPoursAfterRestoreIfEnabled();
	assert.deepEqual(events, ['rebuild'], '关闭 DRC 时仍应重铺覆铜，但不能强制运行 DRC');

	console.log('copper rebuild tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
