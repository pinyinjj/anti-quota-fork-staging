# Anti Quota - Antigravity 多账号配额管理

🚀 Antigravity 多账号与配额管理工具，同时提供 VS Code 扩展和独立的本机服务/CLI。

> 本项目是 [fhyfhy17/anti-quota](https://github.com/fhyfhy17/anti-quota) 的非官方社区衍生版。
> 仓库保留 GitHub Fork 来源关联；当前默认分支采用清理后的独立提交历史，项目来源、原作者版权和 MIT License 均予以保留。

## 📌 项目来源与发行定位

- 本项目基于 [fhyfhy17/anti-quota](https://github.com/fhyfhy17/anti-quota) `v2.15.0`
  （commit [`9196680`](https://github.com/fhyfhy17/anti-quota/commit/9196680)）继续开发。
- 本仓库通过 GitHub Fork 创建，页面保留 `forked from` 来源标记。
  当前默认分支采用经过审计和清理的独立提交历史，没有导入本地旧提交或上游诊断样本。
  GitHub Fork 网络仍与上游关联；上游历史中的第三方邮箱、用户路径及诊断样本仍可能通过网络访问。
- 这是社区维护的非官方发行版，不代表上游作者。原项目归属与 MIT License 均予以保留。
- 为兼容已经安装的旧版扩展，VS Code 清单暂时保留扩展 ID
  `fhyfhy17.anti-quota`。这只是兼容选择，不表示上游官方发行；同 ID 的更高版本可能覆盖本版。

---

## ✨ 核心功能

### 🔐 多账号管理

- **添加账号**: 支持 refresh_token 导入和 Google OAuth 授权
- **批量导入**: 一次性导入多个账号（支持 JSON 数组或换行分隔）
- **自动导入**: 首次启动自动导入 Antigravity/Cursor/Windsurf 当前登录账号

### ⚡ 账号切换

- 点击账号右侧 **蓝色闪电 ⚡** 即可切换账号
- **桌面版 Antigravity**：采用“关闭 → 注入数据库 → 重启”方式
- **新版 agy CLI**：同步更新 Windows Credential Manager 与 `~/.gemini/antigravity-cli/antigravity-oauth-token`
- 切换前自动刷新 OAuth Token；配额请求遇到 401 时自动刷新并重试一次
- 剩余用量优先读取 `retrieveUserQuotaSummary` 真实共享配额桶，避免显示过期的假 100%
- 5 小时与周额度独立保存；账号卡片额外显示 Gemini 周额度
- agy CLI 切换前必须退出所有 `agy` 会话；切换完成后再启动的新会话会使用目标账号

### 🤖 自动切换（亮点功能）

- 当前账号配额低于设定阈值时，自动切换到配额更高的账号
- 可分模型配置阈值（默认 0% 关闭，需在设置中开启）

### 📊 实时监控

- 状态栏显示三大模型（Claude、Gemini Pro、Gemini Flash）配额
- 自动刷新（可配置间隔）

### 🕒 一键触发 Claude 倒计时

- 一键触发所有 Claude 模型（100% 满额状态）的 5 小时恢复倒计时
- 统一所有账号的恢复时间，确保在 5 小时后所有账号同时可用
- 通过侧边栏顶部的 **时钟图标 🕒** 操作，支持实时进度查看 (x/y)

---

## 📸 功能展示

### 侧边栏账号管理

- 账号卡片列表，显示模型配额和恢复倒计时
- 一键切换、刷新、禁用、删除账号
- 批量导入/导出账号
- 🕒 一键触发所有 Claude 倒计时（统一恢复时间）
- 设置页面：分模型配置自动切换阈值

### 状态栏

```
🟢 Claude: 85%  🟡 G Pro: 35%  🟢 G Flash: 92%
```

---

## 🚀 快速开始

### Windows 发布包安装

先安装 [Node.js 18.17.0 或更高版本](https://nodejs.org/)，再从
[GitHub Releases](https://github.com/pinyinjj/anti-quota-fork-staging/releases/latest)
下载需要的安装包到 Windows“下载”文件夹。

在 **PowerShell** 中安装 VS Code 插件：

```powershell
code --install-extension "$env:USERPROFILE\Downloads\anti-quota-1.2.2.vsix" --force
```

在 **PowerShell** 中安装独立 CLI 和 Windows 系统服务（第二条命令需要接受管理员授权）：

```powershell
npm install -g "$env:USERPROFILE\Downloads\anti-quota-1.2.2.tgz"
& "$env:APPDATA\npm\anti-quota.cmd" service install
```

如果使用 **CMD（命令提示符）**，请改用以下命令，不要与 PowerShell 写法混用：

```bat
code --install-extension "%USERPROFILE%\Downloads\anti-quota-1.2.2.vsix" --force
npm install -g "%USERPROFILE%\Downloads\anti-quota-1.2.2.tgz"
"%APPDATA%\npm\anti-quota.cmd" service install
```

PowerShell 的环境变量写作 `$env:USERPROFILE`、`$env:APPDATA`；执行引号中的命令路径
时需要前面的 `&`。`%USERPROFILE%`、`%APPDATA%` 只用于 CMD。

关闭并重新打开终端，然后运行：

```bat
anti
```

如果提示找不到 `anti`，可在当前 CMD 临时补充 PATH：

```bat
set "PATH=%PATH%;%APPDATA%\npm;%LOCALAPPDATA%\agy\bin"
anti
```

### Google OAuth 本机配置（1.2.1 起必需）

本发行版不再内置 Google OAuth 客户端参数。使用绑定账号或刷新 Token 功能前，
必须提供自己有权使用的 OAuth 客户端配置；程序不会回退到旧版内置值，也不会自动
把旧值写入本机配置文件。

安装包不包含个人 OAuth 配置，也不会自动迁移旧参数。升级会保留已有本机
`oauth-client.json`；已配置的用户无需重复填写。新电脑或缺少此文件时仍须单独配置，
仅能看到已绑定账号和缓存额度不代表 Token 刷新或账号切换可用。

推荐在 `%USERPROFILE%\.anti-quota\oauth-client.json` 中保存以下 JSON，
将占位符替换为实际客户端参数：

```json
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
```

也支持 Google 下载的桌面客户端 JSON 格式：

```json
{
  "installed": {
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  }
}
```

配置文件与 `accounts.json` 位于同一目录；默认是 `~/.anti-quota/`。
若运行进程设置了 `ANTI_QUOTA_DATA_DIR`，则从该数据目录读取。
同一 Windows 用户下的 CLI 后台服务和 VS Code 扩展共享此文件，每次 OAuth 操作
都会重新读取，无需把配置写入 Program Files 的服务安装副本。

也可以同时设置 `ANTI_QUOTA_GOOGLE_CLIENT_ID` 和
`ANTI_QUOTA_GOOGLE_CLIENT_SECRET` 环境变量。它们必须成对提供，并优先于配置文件；
仅设置其中一个会报错。环境变量必须对实际执行 OAuth 请求的服务或 VS Code 进程
可见，仅在当前终端设置不会传递给已经运行的进程，因此后台服务场景建议使用共享文件。

缺少或损坏配置时，Google OAuth 绑定和 Token 刷新会明确失败；需要刷新 Token 的
配额查询或账号切换也会失败。已有 `refresh_token` 必须配合最初签发它的同一 OAuth
客户端使用，不能直接换成新客户端继续刷新；换客户端时需重新授权。
自行注册 Google OAuth 客户端并不保证获得 Antigravity 所需的 scopes 或 API 权限，
仍须由 Google 授予相应访问权限。

请保护配置文件的本机访问权限，不要共享或提交 `oauth-client.json`、账号 Token 及其备份。

### 独立 CLI（不依赖 VS Code）

从源码安装 CLI：

```bash
npm run cli:install
npm run build:windows-service             # Windows 源码安装需先构建原生宿主
anti-quota service install
```

Windows 上 `service install` 注册真正的 SCM 服务，可在 `services.msc` 中看到
`Anti Quota (...)`，启动类型为“自动”；不再创建启动文件夹里的 VBS。
发布包已包含原生宿主，无需自行安装编译器。仅安装 VSIX 不会安装独立 CLI/系统服务。
服务和 VS Code 扩展共享 `~/.anti-quota/accounts.json`，不会把 OAuth Token 返回到 CLI 输出。

### Windows 系统服务

系统启动时运行受保护的 LocalSystem 守护宿主；注册用户登录后，宿主以该用户的身份
启动账号代理。未登录时等待登录，不使用 SYSTEM 的 Credential Manager，也不保存
Windows 登录密码。原生宿主、Node.js 和代理程序副本位于
`%ProgramFiles%\Anti Quota\<用户标识>\`，普通用户不能修改这些运行文件。

```bat
anti service install      # 管理员授权：安装/升级系统服务，迁移旧 VBS，然后启动
anti service status       # 显示 Windows 服务状态、版本和用户代理状态
anti service stop         # 安全停止代理及系统宿主，本次不自动重启
anti service start        # 不需重新安装，恢复服务及用户代理
anti service uninstall    # 管理员授权：移除系统服务，保留账号及凭据
anti service logs         # 显示用户代理日志位置
```

宿主的启动故障同时记入 Windows“事件查看器 → Windows 日志 → 应用程序”。
停止会立即取消等待中的 Google 授权及排队请求；已经开始的凭据提交必须完成才退出，
不会为了更新强杀提交进程。旧代理状态无法确认时拒绝启动第二个实例。
正常主动停止与异常崩溃区分处理，避免手动停止后被守护程序反复拉起。
系统关机仍受 Windows 自身关机时限约束，不能承诺无限等待。

常用命令：

```bash
anti                                    # 打开交互式账号与配额菜单
anti-quota bind                         # 浏览器绑定 Google 账号
anti-quota import                       # 导入当前 Antigravity/agy 账号
anti-quota list --refresh               # 刷新并显示所有配额
anti-quota current                      # 查看 agy 当前账号
anti-quota switch 2                     # 按列表序号快速切换
anti-quota switch user                  # 按邮箱前缀快速切换
anti-quota recommend gemini --refresh   # 推荐周额度最高的可用账号
anti-quota recommend gemini --switch    # 推荐并立即切换
anti-quota network                      # 检查 Google 网络与代理路由
anti version                            # 查看 CLI 与运行中服务的版本
anti version --json                     # 以 JSON 输出版本信息
anti update --check                     # 只检查是否有新版
anti update                             # 下载、校验并安装较新的 CLI/服务
anti update --force                     # 强制重新安装 latest Release
```

直接运行 `anti`、`anti-quota` 或 `aq` 都会进入交互菜单，可用方向键选择账号，
回车切换，并通过 `R/G/B/I` 刷新、推荐、绑定或导入。所有子命令也可以使用
`aq`。切换会更新 agy 的 OAuth 文件和 Windows
Credential Manager；切换前必须先退出所有 `agy` 会话，完成后再启动 `agy`。需要脚本化处理时，
可给查询和操作命令添加 `--json` 获取不含 Token 的结构化输出。

### CLI 自动更新

`anti version`、`anti --version` 和 `anti -V` 可查看当前 CLI 版本；该命令不会为了
查询版本而启动后台服务。服务已经运行时，输出还会包含服务版本，便于发现 CLI 与服务版本
不一致。

```bash
anti update --check   # 仅查询 GitHub Release，不下载、不安装，也不停止服务
anti update           # 有更高版本时下载、校验并安装
anti update --force   # 即使已经是最新版，也重新安装 latest Release
```

更新器从公开的 [GitHub Releases](https://github.com/pinyinjj/anti-quota-fork-staging/releases/latest)
获取 TGZ 及其 SHA-256 文件，校验通过后才调用 npm 安装。自动更新范围仅包括全局安装的
CLI 及其后台服务，**不会安装或更新 VS Code/Antigravity 中的 VSIX 扩展**；VSIX 仍需从
Release 下载后用 `code --install-extension ... --force` 单独安装。Git 开发工作区和
`npm link` 安装不会被自动覆盖。

安装了 Windows 服务时，自动更新会先确认原宿主和用户代理退出，再通过管理员授权
更新 Program Files 中的受保护副本；不会绕过系统服务启动另一份 npm 代理，也不会
自动降级覆盖较新的服务。若取消管理员授权，命令会明确报告未完成，之后可运行
`anti service install` 完成迁移。

安装前会先把当前 CLI 打成临时回滚包；安装或版本自检失败时会自动恢复旧版本。极端情况下
如果自动回滚也失败，Anti Quota 会保留回滚 TGZ，并在 `~/.anti-quota/unsafe-install.json`
写入持久阻断标记，禁止后台服务、自启和交互菜单启动未验证的安装。此时按错误信息中的
`backupPath` 手动执行 `npm install -g "<backupPath>"`，再运行 `anti update --force` 完成
验证并清除标记；恢复完成前不要手动删除该标记或 `update.lock`。

### 代理网络

Anti Quota 会依次检测 `ANTI_QUOTA_PROXY`、标准
`HTTPS_PROXY/HTTP_PROXY/ALL_PROXY` 环境变量，以及 Windows 当前用户的系统代理
（包括系统已解析的 PAC/WPAD 结果）。HTTP、HTTPS 和 SOCKS 代理均受支持。

如果自动检测失败，可在 Windows CMD 中持久设置代理：

```bat
setx ANTI_QUOTA_PROXY "http://127.0.0.1:7890"
```

关闭并重新打开 CMD，再重启服务并检查网络：

```bat
anti service stop
anti service start
anti network
```

若需要 SOCKS5，可将地址写成 `socks5://127.0.0.1:7891`。代理用户名和密码不会
显示在日志或诊断输出中。

### 首次使用

插件会自动检测并导入当前 Antigravity/Cursor/Windsurf 编辑器中的账号。
当桌面版数据库不存在时，也会检测新版 agy CLI 的官方令牌文件。

### 添加更多账号

#### 方式一：Refresh Token

1. 点击侧边栏 "+ Token" 标签
2. 粘贴 refresh_token（支持多个，换行分隔）
3. 点击"添加账号"

#### 方式二：Google OAuth

1. 点击侧边栏 "🔐 OAuth" 标签
2. 点击"开始 Google 授权"
3. 在浏览器完成授权，自动添加账号

---

## 🧪 开发与打包（VSIX）

改完代码后建议先更新 `package.json` 的 `version`，再打包，避免 IDE 因版本相同继续加载旧逻辑：

```bash
npm run package
```

生成 `anti-quota-<version>.vsix` 后，在 Antigravity / VS Code：

1. 打开命令面板 `Cmd+Shift+P`
2. 执行 `Extensions: Install from VSIX...`
3. 选择 `anti-quota-<version>.vsix`

---

## ⚙️ 配置选项

在 VS Code 设置中搜索 `antiQuota`：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `refreshInterval` | 10 | 配额刷新间隔（秒） |
| `enabled` | true | 是否启用自动刷新 |
| `autoSwitch.enabled` | true | 是否启用自动切换 |
| `autoSwitch.thresholds.claude` | 0 | Claude 自动切换阈值（%），0 表示关闭 |
| `autoSwitch.thresholds.gemini-pro` | 0 | Gemini Pro 自动切换阈值（%） |
| `autoSwitch.thresholds.gemini-flash` | 0 | Gemini Flash 自动切换阈值（%） |
| `autoSwitch.checkInterval` | 30 | 自动切换检查间隔（秒） |

---

## 📋 命令

### CLI 命令

| 命令 | 说明 |
|------|------|
| `anti-quota bind` | 使用 Google OAuth 绑定账号 |
| `anti-quota import` | 导入当前 Antigravity/agy 账号 |
| `anti-quota list [--refresh]` | 显示账号和配额 |
| `anti-quota current` | 显示当前 agy 账号 |
| `anti-quota refresh [all\|账号]` | 刷新全部或指定账号配额 |
| `anti-quota switch <账号>` | 按序号、邮箱或 ID 切换 agy 账号 |
| `anti-quota recommend [模型] [--switch]` | 推荐或直接切换至最佳账号 |
| `anti version [--json]` | 显示 CLI 与运行中服务的版本 |
| `anti update --check` | 只检查最新公开 Release |
| `anti update [--force]` | 校验并安装 CLI/服务更新；不更新 VSIX |
| `anti-quota service start\|stop\|status` | 管理后台服务 |
| `anti-quota service install\|uninstall` | 安装或移除 Windows 系统服务（需管理员授权） |

### VS Code 命令

| 命令 | 说明 |
|------|------|
| `Anti Quota: 刷新当前账号配额` | 手动刷新当前账号配额 |
| `Anti Quota: 刷新所有账号配额` | 刷新所有账号配额 |
| `Anti Quota: 显示配额详情` | 打开配额详情面板 |
| `Anti Quota: 打开账号管理` | 打开侧边栏账号管理 |
| `Anti Quota: 添加账号` | 快速添加账号 |
| `Anti Quota: 切换账号` | 切换到其他账号 |
| `Anti Quota: 开关自动切换` | 切换自动切换功能 |
| `Anti Quota: 显示日志` | 查看插件运行日志 |

---

## 🎨 配额颜色说明

| 颜色 | 百分比 | 状态 |
|------|--------|------|
| 🟢 绿色 | >= 50% | 健康 |
| 🟡 黄色 | 30% - 50% | 注意 |
| 🟠 橙色 | 10% - 30% | 警告 |
| 🔴 红色 | < 10% | 危险 |

---

## 💾 数据与网络边界

- Anti Quota 不包含由本项目维护者运营的遥测或账号中转服务。
- OAuth 登录、用户信息、令牌刷新和配额查询会向 Google 发出必要请求；版本检查和自动更新
  会访问本项目的公开 GitHub API 与 Release 资产。
- 账号资料和 OAuth Token 以**明文 JSON**保存在 `~/.anti-quota/accounts.json`、
  `accounts.latest.json` 及 `backups/` 历史备份中，不是由 Windows Credential Manager
  加密保管。请依靠操作系统用户权限保护 `~/.anti-quota/`，不要共享这些文件或将其提交到
  版本库。
- 在 Windows 上切换新版 agy CLI 时，Anti Quota 会把当前所选账号的凭据同步到 Windows
  Credential Manager 和 agy 的 OAuth 文件；这只影响 agy 当前凭据，不会改变上述
  `accounts.json` 及备份仍为本地明文存储的事实。
- CLI 的普通输出和 `--json` 输出不会返回 OAuth Token。

---

---

## 📄 License

MIT。保留上游项目的著作权与许可声明；本仓库是非官方社区发行版。

---
