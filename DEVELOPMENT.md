# 开发说明

`chrome/` 和 `edge/` 分别是两个浏览器的扩展源码，可在对应浏览器的扩展管理页面加载。运行以下命令需要 Node.js 22 或更新版本。

## 测试

```sh
node scripts/test-rule-sync.mjs --channel=chrome
node scripts/test-rule-sync.mjs --channel=edge
node scripts/test-intro-replay.mjs --channel=chrome
node scripts/test-intro-replay.mjs --channel=edge
```

浏览器测试会使用新的临时配置，不使用个人浏览器配置：

```sh
node scripts/e2e-test.mjs --channel=chrome
```

测试 Edge 时，将 `CHROME_BIN` 设为 Edge 可执行文件的绝对路径，并使用 `--channel=edge`。可以追加 `--filter=测试名称` 运行指定用例。

## 打包

```sh
node scripts/package.mjs
node scripts/package-edge.mjs
```

脚本校验各语言文案并打包运行文件，版本号取自对应 `manifest.json`。当前输出为：

- `chrome/dist/annoy-killer-chrome-1.2.3.zip`
- `edge/dist/annoy-killer-edge-1.2.3.zip`

商店文案、隐私说明和宣传素材分别保存在 `chrome/store/`、`edge/store/`。
