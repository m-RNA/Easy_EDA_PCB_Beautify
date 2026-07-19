import assert from 'node:assert/strict';
import process from 'node:process';

async function main() {
	(globalThis as any).eda = {
		sys_Log: { add: () => undefined },
	};
	const { advanceDrcCornerRepair, advanceDrcCornerRepairOnce } = await import('../src/lib/beautify');

	const badCorners = new Set<number>();
	const cornerScales = new Map<number, number>();
	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 1), 'scaled');
	assert.equal(cornerScales.get(1), 0.5);
	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 1), 'scaled');
	assert.equal(cornerScales.get(1), 0.25);
	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 1), 'scaled');
	assert.equal(cornerScales.get(1), 0.125);
	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 1), 'straight');
	assert.equal(badCorners.has(1), true);
	assert.equal(cornerScales.has(1), false);
	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 1), 'unchanged', '直角拐角不得重复重绘');

	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 2, true), 'straight', '最后一轮应直接保守回退为直角');
	assert.equal(advanceDrcCornerRepair(badCorners, cornerScales, 2), 'unchanged');

	const adjustedCorners = new Set<string>();
	const dedupBadCorners = new Set<number>();
	const dedupCornerScales = new Map<number, number>();
	assert.equal(advanceDrcCornerRepairOnce(adjustedCorners, '7:3', dedupBadCorners, dedupCornerScales, 3), 'scaled');
	assert.equal(dedupCornerScales.get(3), 0.5);
	assert.equal(advanceDrcCornerRepairOnce(adjustedCorners, '7:3', dedupBadCorners, dedupCornerScales, 3), 'unchanged');
	assert.equal(dedupCornerScales.get(3), 0.5, '同一圆角的直线和圆弧同时违规时，每轮只能调整一次');

	console.log('DRC repair convergence tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
