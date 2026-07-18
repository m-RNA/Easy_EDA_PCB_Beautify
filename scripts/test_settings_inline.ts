import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { JSDOM, VirtualConsole } from 'jsdom';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate: () => boolean, message: string) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(message);
		await delay(10);
	}
}

async function main() {
	const settingsPath = path.resolve(process.cwd(), 'iframe/settings.html');
	const html = fs.readFileSync(settingsPath, 'utf8');
	for (const removedName of ['elMergeTransitionSegments', 'mergeTransitionSegments'])
		assert.equal(html.includes(removedName), false, `已移除的设置变量仍被引用: ${removedName}`);

	let storedSettings: Record<string, any> = {};
	let saveCalls = 0;
	let refreshCalls = 0;
	let diagnoseCalls = 0;
	const runtimeErrors: unknown[] = [];
	const defaults = {
		cornerRadiusRatio: 3,
		protectPadAndViaNodes: true,
		protectDifferentialAndEqualLength: true,
		syncWidthTransition: false,
		widthTransitionSegments: 3,
		widthTransitionRatio: 3,
		widthTransitionBalance: 50,
		debug: false,
		forceArc: true,
		enableDRC: true,
		drcIgnoreCopperPour: true,
		rebuildCopperPourAfterBeautify: true,
		cardOrder: ['card-transition', 'card-drc', 'card-shortcut', 'card-advanced', 'card-snapshot'],
		collapsedStates: { 'card-advanced': true },
		shortcutKeys: {},
	};
	const api = {
		dmt_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-test', name: 'PCB Test' }) },
		jlc_eda_beautify_getDefaultSettings: () => defaults,
		jlc_eda_beautify_refreshSettings: async () => {
			refreshCalls++;
		},
		jlc_eda_beautify_snapshot: {
			SNAPSHOT_LIMIT: 20,
			diagnoseSnapshotDiff: async () => {
				diagnoseCalls++;
				return { targetLines: 10, targetArcs: 1, actualLines: 13, actualArcs: 1 };
			},
			getLastRestoredId: () => null,
			getSnapshots: async (_pcbId: string, type: string) => type === 'manual'
				? [{ id: 1, name: '手动快照', timestamp: Date.now(), lines: [], arcs: [] }]
				: [],
			registerSnapshotChangeCallback: () => undefined,
		},
		sys_I18n: { text: (text: string) => text },
		sys_Message: { showToastMessage: () => undefined },
		sys_Dialog: { showInformationMessage: () => undefined },
		sys_Storage: {
			getExtensionAllUserConfigs: async () => ({ ...storedSettings }),
			setExtensionAllUserConfigs: async (settings: Record<string, any>) => {
				storedSettings = structuredClone(settings);
				saveCalls++;
				return true;
			},
			getExtensionUserConfig: async () => undefined,
			deleteExtensionUserConfig: async () => true,
		},
		sys_Window: { getCurrentTheme: async () => 'light' },
	};

	const virtualConsole = new VirtualConsole();
	virtualConsole.on('jsdomError', error => runtimeErrors.push(error));
	const dom = new JSDOM(html, {
		beforeParse(window) {
			(window as any).eda = api;
			window.addEventListener('error', event => runtimeErrors.push(event.error || event.message));
			window.addEventListener('unhandledrejection', event => runtimeErrors.push(event.reason));
		},
		runScripts: 'dangerously',
		url: 'https://pro.lceda.cn/settings-test',
		virtualConsole,
	});

	try {
		await waitFor(
			() => dom.window.document.readyState === 'complete' || dom.window.document.readyState === 'interactive',
			'设置页未完成加载',
		);
		await delay(30);
		assert.deepEqual(runtimeErrors, [], '设置页初始化不应产生运行时异常');

		const advancedCard = dom.window.document.getElementById('card-advanced');
		const advancedHeader = advancedCard?.querySelector('.card-header') as HTMLElement | null;
		assert.ok(advancedCard && advancedHeader, '高级设置卡片应存在');
		assert.equal(advancedCard.classList.contains('collapsed'), true, '高级设置默认应折叠');

		advancedHeader.click();
		assert.equal(advancedCard.classList.contains('collapsed'), false, '点击卡片标题应展开高级设置');
		await waitFor(() => saveCalls >= 1, '点击折叠卡片后未调用设置保存 API');
		assert.equal(storedSettings.collapsedStates?.['card-advanced'], false, '折叠状态应写入存储');

		const debugSwitch = dom.window.document.getElementById('debug') as HTMLInputElement | null;
		assert.ok(debugSwitch, '调试开关应存在');
		debugSwitch.checked = true;
		debugSwitch.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		await waitFor(() => storedSettings.debug === true && refreshCalls >= 1, '修改设置后未保存或未刷新运行时');

		await waitFor(() => !!dom.window.document.querySelector('.btn-diagnose'), '快照诊断按钮未渲染');
		const diagnoseButton = dom.window.document.querySelector('.btn-diagnose') as HTMLButtonElement;
		diagnoseButton.click();
		await waitFor(() => diagnoseCalls === 1, '点击诊断按钮后未调用只读诊断 API');
		assert.deepEqual(runtimeErrors, [], '点击和保存设置不应产生运行时异常');
	}
	finally {
		dom.window.close();
	}

	console.log('settings inline behavior tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
