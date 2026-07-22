# AGENTS.md

本文件定义 `JLC_EDA_Smooth` 仓库的代理协作规则。嘉立创 EDA 运行时、DRC、覆铜、快照和快捷键等技术记录见 [`docs/DEVELOPER_NOTES.md`](docs/DEVELOPER_NOTES.md)。修改相关模块前应先阅读对应章节。

## 基本要求

- 面向用户的最终回复使用中文。
- 优先做范围明确、可验证的最小修改，避免顺手重构、全文件格式化、换行符或编码变更。
- 大型或高风险修改先确认目标、约束和预期结果；小型低风险修改可说明假设后直接进行。
- 不覆盖用户已有或无关的工作区修改。开始修改和提交前检查 `git status`、`git diff`。
- 独立功能、修复、文档、测试和维护工作应按目的拆分提交，不把可独立回退的内容混在一起。

## Windows 文本读取

仓库文本默认按 UTF-8 处理。PowerShell 读取中文文件时必须显式指定编码：

```powershell
Get-Content -Raw -Encoding UTF8 .\path\to\file.txt
```

不要仅凭 PowerShell 输出乱码就改写文件、转换编码或增删 BOM；应结合编辑器、`rg`、Git diff 或构建工具确认文件本身是否损坏。

## 项目结构与修改边界

- `src/`：扩展主进程和核心逻辑。
- `iframe/settings.html`：设置页。CSS 与 JavaScript 必须保持内联，避免扩展环境加载外部资源失败。
- `extension.json`：顶部菜单和扩展元数据的唯一来源。不要重新引入运行时动态菜单注入。
- `locales/`：界面与扩展清单翻译。新增用户可见文案时同步中英文。
- `scripts/test_*.ts`：轻量回归测试。
- `docs/DEVELOPER_NOTES.md`：宿主 API 与已验证运行时行为，不承担代理流程规则。

## 嘉立创 EDA 关键约束

- Worker 与 iframe 共享状态应锚定到扩展独立的 `eda` 对象，并使用唯一前缀；不要依赖模块级变量跨上下文共享。
- `PCB_PrimitiveLine.modify()` 不能假定为原位替换。生产路径应计算结果、删除原图元、创建新图元并校验。
- Selected 操作使用增量恢复，All 操作使用全量恢复；几何相同但操作范围或恢复策略不同的 Before 快照不能互相复用。
- DRC 结果只能按对象类型字段识别覆铜问题，不能通过 `ruleName` 中宽泛的 `copper` 关键字过滤。
- DRC 修复每轮对同一路径圆角最多推进一次，最后一次实际调整后还要再执行一次验证检查；API 调用失败不能视为通过。
- 当前生产默认值：DRC 最大调整 `30` 轮，自动重铺上限 `30` 块覆铜区域。设置页、后端回退值、迁移、测试和文档必须同步。
- 覆铜边界、生成填充和 DRC 内部对象属于不同 ID 空间。智能重铺按 DRC 层号筛选 Pour，不按对象 ID 强行关联。
- 快捷键运行时修饰键格式为 `Ctrl`、`Shift`、`Alt`，普通键和 F 键使用大写。不要将类型声明中的全大写修饰键直接传给运行时。
- 宿主 V3.2.148 不可靠支持 `Shift + F-key`，也不可靠区分基础键与其修饰键超集；默认使用已验证的 `F6`、`F9`、`Ctrl + Shift + Z`。
- 顶部菜单只保留“过渡线宽（选中）”；不要重新加入“过渡线宽（全部）”。底层 All 能力可继续保留。

## 设置页要求

- 修改设置字段时同步检查：默认设置、读取迁移、保存逻辑、输入范围、内联页面加载以及中英文文案。
- 设置卡片的折叠、排序、保存和按钮点击必须通过实际内联 HTML 测试验证，不能只做字符串检查。
- 删除设置项时同时清理 DOM 引用、加载与保存逻辑、翻译和测试，避免残留变量导致整个设置页保存失败。

## 测试与构建

根据修改范围运行对应检查；准备调试包或发布前执行完整门禁：

```powershell
npm test
npm run lint
npm run build
git diff --check
```

常用专项测试：

```powershell
npm run test:geometry
npm run test:topology
npm run test:drc-repair
npm run test:snapshot-restore
npm run test:settings-inline
npm run test:manifest
npm run test:shortcuts
```

构建后应检查 `.eext` 内的 `extension.json` 版本、必要文档/语言文件/图片，并确认未包含 `src/`、`scripts/`、`node_modules/`、TypeScript 源码或依赖锁文件。

## 版本与发布

- 调试包使用递增版本号，保留旧包，不能覆盖之前的测试版本。
- 仅用于调试包的 `extension.json` 版本号默认不提交；正式发布时再与发布文档一起提交。
- 正式发布前运行完整测试、Lint、生产依赖审计、构建和安装包内容检查。
- 发布后核对 GitHub/Gitee 的 `main`、标签和 GitHub Release 附件均指向同一提交；旧标签和旧安装包不得移动或覆盖。

## Git 提交

- 每个完整且可独立审查的目的创建一个提交，提交前检查 `git diff --cached`。
- 提交信息通常使用中文，格式：

```text
<type>: <简洁主题>

<修改内容和原因>
```

- 已推送、已共享或已发布的提交不得 amend。连续修正同一未推送提交时，确认没有后续提交和无关改动后才可 amend。
- 不在提交信息中写入个人信息、绝对本地路径、设备信息、账号、令牌、密钥或内部地址。
