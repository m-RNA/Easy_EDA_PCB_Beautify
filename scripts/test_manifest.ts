import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '..', 'extension.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pcbMenuItems = manifest.headerMenus?.pcb?.flatMap((menu: any) => menu.menuItems ?? []) ?? [];

assert.ok(pcbMenuItems.some((item: any) => item.id === 'WidthSelected'), '应保留“过渡线宽（选中）”菜单');
assert.ok(!pcbMenuItems.some((item: any) => item.id === 'WidthAll'), '不应显示“过渡线宽（全部）”菜单');
assert.ok(!pcbMenuItems.some((item: any) => item.registerFn === 'widthTransitionAll'), '菜单不应绑定 widthTransitionAll');

console.log('manifest menu tests passed');
