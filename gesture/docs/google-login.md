# 本地 Google 登录与房间管理

首次在仓库根目录执行 `sh scripts/gesture.sh install`。之后从仓库根目录的两个终端启动房间服务与网站：

```sh
python3 web/scripts/serve.py --port 7870
```

```sh
sh scripts/gesture.sh dev
```

使用 `http://127.0.0.1:8800/`。网站右上角的“登录”进入 Google 登录页；首页向左拉动屏宽的 1/8 后松开，或点击“左拉开启”，即可进入“我的房间”，无需先登录。

## Google 客户端

在本地创建被 Git 忽略的 `gesture/.env.local`，按 [.env.example](../.env.example) 填写 `GOOGLE_CLIENT_ID`，然后重启 Vite。仓库不包含可直接使用的登录凭据；不需要将下载的完整凭证文件或 Client Secret 放入工程。

在自己的 Google Cloud 项目中创建 OAuth Web 客户端，把实际访问的网站地址加入已获授权的 JavaScript 来源。默认开发地址为：

- `http://127.0.0.1:8800`
- `http://localhost:8800`

更换开发端口时，也需更新对应的授权来源。Google 官方还建议为本地测试添加 `http://localhost`（不含端口）。若出现 `The given origin is not allowed for the given client ID`，请核对浏览器正在使用的地址、端口及所配置的 Client ID，并等待控制台配置生效。本轮真实 Google 账户登录仍待验证。

采用 Google Identity Services 按钮的 JavaScript 回调方式，不需要设置重定向 URI。若 Google Auth Platform 的受众仍为测试状态，应把要试用的 Google 账号添加为测试用户。浏览器与本地服务均须能连接 Google；网络连接失败时页面提供重试。

客户端只传递 Google 返回的 ID Token。服务器使用官方 `google-auth-library` 校验签名、受众、签发方与有效期，并核对会话 nonce、已验证邮箱；Google `sub` 用于账户归属。会话 Cookie 为 HttpOnly、SameSite=Lax，写接口同时检查本机 Origin 与 CSRF。Google ID Token 不写入磁盘或日志。账户登录有效期为 24 小时，之后重新登录。

参考：[获取 Web Client ID](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)、[服务端验证 ID Token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)。

## 房间与文件

- 默认只初始化一个书房示例。卧室保留为创建页面中的可下载 ZIP，用于导入与删除测试。
- 导入支持 ZIP，或同时选择 `Room.glb` 与 `room_objects.json`。两个文件需配套，GLB 需要自包含；压缩包最多 180 MB，拒绝路径穿越、外部资源、对象不匹配和无效清单。
- 每次导入生成独立房间 ID 和布局存储键，同一 ZIP 可用于多个房间。重命名不改变布局，删除从列表中移除，提示条可撤销。
- 房间目录、导入模型与本机会话保存在仓库旁的 `.roomcanvas-local/`，不属于前端静态目录，也不加入 Git。Vite 禁止直接读取这一目录；模型需通过检查所属会话的接口访问。
- 游客房间在登录时归入该 Google 账户；退出登录后不能从游客界面打开账户房间。当前实现只在这台电脑保存，不提供云同步；`localhost` 与 `127.0.0.1` 的浏览器 Cookie、布局存储不同，请固定使用一个地址。
- 已有书房布局保留原存储，首次需要时复制到新的实体存储。房间布局继续由原三维编辑器保存到浏览器，可从编辑器导出布局 JSON。
- 删除采用软删除以支持撤销，不自动永久清除模型文件。尚未增加回收站和容量管理。
- “照片生成房间”已接好选图与预览；整间房重建尚未接入此入口，生成按钮禁用，选择的房间照片不上传。它与编辑器中已接入的多照片物体重建独立。

本地 API 随 `npm run dev` 或 `npm run preview` 启动。单独托管 `dist/` 不包含 Node API；当前配置面向本机预览，尚未提供公网部署配置。
