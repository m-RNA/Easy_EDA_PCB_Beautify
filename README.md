# 熔化PCB - 圆滑布线 & 线宽过渡

嘉立创EDA专业版扩展 —— 将直角走线转换为平滑圆弧，支持平滑线宽过渡。

![效果预览](./images/preview.gif)

> ⚠️ 插件开发中，建议操作前备份工程，遇到问题欢迎反馈。

## ✨ 功能

| 功能 | 说明 |
| ------ | ------ |
| 圆滑布线 | 直角拐角 → 平滑圆弧，可调节半径 |
| 线宽过渡 | 不同线宽间平滑渐变，基于贝塞尔曲线 |
| 快照管理 | 一键备份/恢复布线状态 |
| 撤销支持 | 操作前自动备份，随时回退 |

## 📖 使用

**菜单位置：** PCB编辑器 → 熔化PCB

- **圆滑布线（选中/全部）** - 处理走线拐角(基于圆弧走线)
- **过渡线宽（选中/全部）** - 生成线宽渐变(基于贝塞尔曲线)
- **设置** - 配置半径、过渡参数等

## 🚀 开发

### 克隆仓库

```bash
git clone --recursive https://github.com/m-RNA/Easy_EDA_Smooth.git
cd Easy_EDA_Smooth
```

### 已克隆？拉取子模块

```bash
git submodule update --init --recursive
```

> ⚠️ **注意：** 子模块已锁定到兼容的特定版本，请勿使用 `--remote` 参数更新，否则可能导致编译失败。

### 安装 & 构建

```bash
npm install
npm run build
```

构建产物：`dist/` 目录下的 `.eext` 扩展包

### 开发注意事项

详见 [DEVELOPER_NOTES.md](./DEVELOPER_NOTES.md)

## 📁 结构

```txt
src/
├── index.ts              # 入口 & 菜单注册
└── lib/
    ├── smooth.ts         # 圆滑布线核心
    ├── widthTransition.ts # 线宽过渡
    ├── snapshot.ts       # 快照管理
    └── settings.ts       # 配置
iframe/
└── settings.html         # 设置界面
pro-api-sdk/              # Git子模块 (EDA API SDK)
```

## 📜 License

[Apache-2.0](./LICENSE)
