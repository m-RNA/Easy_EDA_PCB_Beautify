import assert from 'node:assert/strict';
import process from 'node:process';
import { mapWithConcurrency } from '../src/lib/asyncPool';

async function main() {
	let active = 0;
	let maxActive = 0;
	const values = Array.from({ length: 12 }, (_, index) => index);
	const results = await mapWithConcurrency(values, 3, async (value) => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise(resolve => setTimeout(resolve, 2));
		active--;
		return value * 2;
	});

	assert.deepEqual(results, values.map(value => value * 2), '并发执行后应保持结果顺序');
	assert.ok(maxActive > 1, '任务应并发执行');
	assert.ok(maxActive <= 3, '任务并发数不应超过上限');

	const completed: number[] = [];
	await assert.rejects(
		mapWithConcurrency(values, 4, async (value) => {
			completed.push(value);
			if (value === 3)
				throw new Error('expected failure');
			return value;
		}),
		/expected failure/,
	);
	assert.equal(completed.length, values.length, '单个任务失败后仍应等待其他任务结束');

	console.log('async pool tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
