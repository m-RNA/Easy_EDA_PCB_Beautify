import assert from 'node:assert/strict';
import { buildConcentricOverrides, computeCornerArcCandidate } from '../src/lib/arcGeometry';
import { dist } from '../src/lib/math';

const settings = {
	cornerRadiusRatio: 3,
	forceArc: true,
};

function makeSegs(width = 10) {
	return [
		{ width },
		{ width },
	];
}

const inner = [
	{ x: -100, y: 0 },
	{ x: 0, y: 0 },
	{ x: 0, y: 100 },
];
const outer = [
	{ x: -100, y: -20 },
	{ x: 20, y: -20 },
	{ x: 20, y: 100 },
];

const innerCandidate = computeCornerArcCandidate(inner, makeSegs(), 1, settings);
assert.ok(innerCandidate, '普通圆角应生成候选圆弧');
assert.equal(Math.round(Math.abs(innerCandidate.angle)), 90);
assert.ok(dist(innerCandidate.start, inner[1]) > 0);

const outerCandidate = computeCornerArcCandidate(outer, makeSegs(), 1, settings);
assert.ok(outerCandidate, '平行差分线外侧圆角应生成候选圆弧');

const overrides = buildConcentricOverrides([innerCandidate, outerCandidate]);
assert.ok(overrides, '可匹配差分对拐角应生成同心圆弧覆盖参数');
assert.equal(overrides.length, 2);
assert.ok(dist(overrides[0].start, overrides[1].start) > 0, '两根线应保留不同切点');

const incompatible = computeCornerArcCandidate([
	{ x: -100, y: 100 },
	{ x: 0, y: 100 },
	{ x: 0, y: 0 },
], makeSegs(), 1, settings);
assert.ok(incompatible, '反向拐角仍可单独生成候选圆弧');
assert.equal(buildConcentricOverrides([innerCandidate, incompatible]), null, '无法可靠同心匹配时应保守失败');

console.log('arc geometry tests passed');
