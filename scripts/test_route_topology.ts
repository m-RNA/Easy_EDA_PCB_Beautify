import assert from 'node:assert/strict';
import process from 'node:process';
import {
	buildAnchorIndex,
	buildNodeDegreeIndex,
	isProtectedRouteNode,
	loadBoardTopologySegments,
	loadElectricalAnchorIndex,
} from '../src/lib/routeTopology';

async function main() {
	const net = 'GND';
	const layer = 1;
	const corner = { x: 0, y: 0 };

	const ordinaryCorner = buildNodeDegreeIndex([
		{ net, layer, p1: { x: -10, y: 0 }, p2: corner },
		{ net, layer, p1: corner, p2: { x: 0, y: 10 } },
	]);
	assert.equal(
		isProtectedRouteNode(net, layer, corner, ordinaryCorner, new Set(), true),
		false,
		'普通二连接拐角应继续允许圆滑',
	);

	const padAnchors = buildAnchorIndex([{ net, layer, point: corner }]);
	assert.equal(
		isProtectedRouteNode(net, layer, corner, ordinaryCorner, padAnchors, true),
		true,
		'同网络同层焊盘中心应受保护',
	);
	assert.equal(
		isProtectedRouteNode(net, 2, corner, buildNodeDegreeIndex([
			{ net, layer: 2, p1: { x: -10, y: 0 }, p2: corner },
			{ net, layer: 2, p1: corner, p2: { x: 0, y: 10 } },
		]), padAnchors, true),
		false,
		'SMD 焊盘不应保护其他铜层',
	);
	assert.equal(
		isProtectedRouteNode('VCC', layer, corner, buildNodeDegreeIndex([
			{ net: 'VCC', layer, p1: { x: -10, y: 0 }, p2: corner },
			{ net: 'VCC', layer, p1: corner, p2: { x: 0, y: 10 } },
		]), padAnchors, true),
		false,
		'同坐标不同网络不应触发保护',
	);
	assert.equal(
		isProtectedRouteNode(net, layer, corner, ordinaryCorner, padAnchors, false),
		false,
		'关闭锚点保护后普通二连接焊盘节点应恢复旧行为',
	);

	const throughHoleAnchors = buildAnchorIndex([{ net, layer: '*', point: corner }]);
	assert.equal(
		isProtectedRouteNode(net, 32, corner, buildNodeDegreeIndex([
			{ net, layer: 32, p1: { x: -10, y: 0 }, p2: corner },
			{ net, layer: 32, p1: corner, p2: { x: 0, y: 10 } },
		]), throughHoleAnchors, true),
		true,
		'多层焊盘和过孔应保护所有铜层',
	);

	const tJunction = buildNodeDegreeIndex([
		{ net, layer, p1: { x: -10, y: 0 }, p2: corner },
		{ net, layer, p1: corner, p2: { x: 10, y: 0 } },
		{ net, layer, p1: corner, p2: { x: 0, y: 10 } },
	]);
	assert.equal(
		isProtectedRouteNode(net, layer, corner, tJunction, new Set(), false),
		true,
		'即使锚点开关关闭，整板三路 T 形节点也必须受保护',
	);

	const crossJunction = buildNodeDegreeIndex([
		{ net, layer, p1: { x: -10, y: 0 }, p2: corner },
		{ net, layer, p1: corner, p2: { x: 10, y: 0 } },
		{ net, layer, p1: corner, p2: { x: 0, y: 10 } },
		{ net, layer, p1: corner, p2: { x: 0, y: -10 } },
	]);
	assert.equal(
		isProtectedRouteNode(net, layer, corner, crossJunction, new Set(), true),
		true,
		'整板四路十字节点必须受保护',
	);

	const topologyResult = await loadBoardTopologySegments([
		{
			getState_Net: () => net,
			getState_Layer: () => layer,
			getState_StartX: () => -10,
			getState_StartY: () => 0,
			getState_EndX: () => 0,
			getState_EndY: () => 0,
		},
	], {
		pcb_PrimitiveArc: {
			getAll: async () => [{
				getState_Net: () => net,
				getState_Layer: () => layer,
				getState_StartX: () => 0,
				getState_StartY: () => 0,
				getState_EndX: () => 10,
				getState_EndY: () => 0,
			}],
		},
		pcb_PrimitivePolyline: {
			getAll: async () => [{
				getState_Net: () => net,
				getState_Layer: () => layer,
				getState_Polygon: () => ({ polygon: [0, 0, 0, 10] }),
			}],
		},
	});
	assert.equal(topologyResult.segments.length, 3, '整板拓扑应纳入直线、圆弧和折线段');
	assert.equal(
		isProtectedRouteNode(net, layer, corner, buildNodeDegreeIndex(topologyResult.segments), new Set(), true),
		true,
		'未选中的圆弧或折线支路也应参与分叉判定',
	);

	const anchorLoadResult = await loadElectricalAnchorIndex({
		pcb_PrimitivePad: {
			getAll: async () => {
				throw new Error('standalone pad unavailable');
			},
		},
		pcb_PrimitiveComponent: {
			getAll: async () => [
				{
					getAllPins: async () => [{ net, layer: 12, x: 5, y: 5 }],
				},
				{
					getAllPins: async () => {
						throw new Error('component pad unavailable');
					},
				},
			],
		},
		pcb_PrimitiveVia: {
			getAll: async () => [{ net, x: 0, y: 0 }],
		},
	});
	assert.ok(anchorLoadResult.warnings.length >= 2, '部分 API 读取失败应返回可诊断警告');
	assert.equal(
		isProtectedRouteNode(net, layer, corner, ordinaryCorner, anchorLoadResult.anchorKeys, true),
		true,
		'部分焊盘读取失败时仍应保留成功读取的过孔锚点',
	);

	console.log('route topology tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
