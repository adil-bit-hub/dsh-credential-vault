# dsh-credential-vault · 凭据管家

[![GitHub](https://img.shields.io/badge/GitHub-adil--bit--hub%2Fdsh--credential--vault-24292f?logo=github)](https://github.com/adil-bit-hub/dsh-credential-vault) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

DeepSeek Harness 的凭据管理插件。把网页系统、GitHub 账号、SSH 服务器和 HTTP/SOCKS 代理的登录信息集中保存，并给每条凭据写备注，说明它是做什么用的。凭据持久化在本机 Harness 的凭据存储里，**当前会话和之后的每个会话**都能通过 agent 工具直接取用。

仓库：**https://github.com/adil-bit-hub/dsh-credential-vault**

- **网页系统**：登录网址、账户、密码
- **GitHub**：用户名、Personal Access Token、提交邮箱（用于 clone / push / 仓库管理）
- **SSH 服务器**：主机、端口、登录用户，密码或私钥（含口令），支持用 `ssh_exec` 直接远程执行命令
- **代理**：HTTP / HTTPS / SOCKS5 / SOCKS5h / SOCKS4 / SOCKS4a，含可选用户名密码，支持用 `proxy_test` 测试连通性与出口 IP
- **备注**：每条凭据都能写用途，列表里可见，也会出现在后续会话的提示词概览中

## 安装

从 GitHub 直接装（非桌面托管的 profile）：

```powershell
dsh plugin --profile <profile> add git+https://github.com/adil-bit-hub/dsh-credential-vault.git
```

在 DSH 桌面端：

1. 打开 **设置 → 插件**；
2. 点 **添加插件** 右侧的箭头 → **安装第三方插件**；
3. 在输入框里填入下面任一来源，然后点 **安装**：

   ```text
   git+https://github.com/adil-bit-hub/dsh-credential-vault.git
   ```

   或把仓库 clone 到任意目录后，填入该目录的绝对路径。

4. 安装完成后选择 **立即启用**（或稍后在插件页打开 `dsh-credential-vault` 的开关）。

安装是加进当前 profile 的，对所有会话生效，重启后依然存在。也可以命令行安装本地目录（在 clone 下来的目录的上一级执行）：

```powershell
dsh plugin --profile <profile> add .\dsh-credential-vault
```

> 本包没有运行时依赖、没有构建步骤：`index.js` + `src/*` 是 Host 侧，`client.js` 是浏览器侧。

## 使用

### 设置页

**设置 → 凭据管家**：

- 右上角 **新增凭据**：选择类型后填写名称、登录信息和备注；代理类型可以只填主机和端口，协议、端口默认按 HTTP + 8080 / SOCKS + 1080 补全，也可以直接把 `socks5://user:pass@10.0.0.2:1080` 这样的完整地址粘贴到「代理主机」；
- 卡片上可以 **显示 / 隐藏** 密码或令牌、**复制账号**、**编辑**、**删除**（删除需要点两次确认）；代理卡片另有 **测试**（走一遍代理请求并显示耗时 / 出口 IP）和 **复制链接**（不含密码）；
- 支持按类型筛选（网页 / GitHub / SSH / 代理）和按名称 / 备注 / 网址 / 主机 / 账号搜索；
- 编辑时密钥输入框留空表示保持不变，点 **清除** 才会删除已保存的值。

### Agent 工具

| 工具 | 作用 |
| --- | --- |
| `credential_list` | 列出凭据的名称、类型、备注、网址 / 主机 / 账号 / 代理协议，永远不含明文 |
| `credential_get` | 读取一条凭据；默认掩码，`reveal: true` 才返回明文 |
| `credential_save` | 新建或更新凭据（便于让 agent 帮你保存刚拿到的令牌或代理） |
| `ssh_exec` | 用保存的 SSH 凭据在远程主机执行命令，密码 / 私钥不进入命令行和工具参数 |
| `proxy_test` | 用保存的代理请求一个目标网址，返回是否连通、HTTP 状态、耗时和出口 IP；失败时返回 `ok: false` 与原因 |

示例对话：

- “我们有哪些服务器凭据？” → `credential_list`
- “登录公司 OA 看一下待办” → `credential_get reveal=true` 后由浏览器工具填表
- “到生产服务器上重启一下 nginx” → `ssh_exec`（`id` + `systemctl restart nginx`）
- “这个 SOCKS 代理还能用吗？出口 IP 是多少？” → `proxy_test`
- “把这个 GitHub token 存成‘个人仓库管理’” → `credential_save`

### 环境变量与 GitHub

GitHub 类型保存的是用户名 + PAT。需要操作仓库时，可以直接用 `https://<用户名>:<token>@github.com/<owner>/<repo>.git` 形式的地址 `git clone`，或者把 token 交给 `gh` / `git` 的 credential helper。令牌只在你要求 `reveal=true` 时才会出现在工具结果里。

### 代理

代理条目保存「协议 + 主机 + 端口 + 可选用户名密码」，切换都在这一个类型里完成：

- **测试**：设置页代理卡片上的 **测试** 按钮，或 agent 的 `proxy_test`，默认经代理访问 `https://api.ipify.org?format=json`（可用 `proxyTestUrl` 改成自己的回显接口），返回耗时、HTTP 状态和出口 IP；
- **复制链接**：复制 `socks5://10.0.0.2:1080` 这种**不含密码**的地址；
- **给命令行或其它工具用**：需要时用 `credential_get reveal=true` 取用户名密码，再拼成 `curl -x http://user:pass@host:8080 https://example.com`、`git -c http.proxy=...` 或 `HTTPS_PROXY=...`；密码只在明确要求时才返回；
- **`socks5h` / `socks4a`**：目标域名交给代理解析，适合本机 DNS 解析不到内网主机、或不想暴露本地 DNS 的场景；普通的 `socks5` / `socks4` 在本机解析。
- **粘贴即用**：新增代理时把 `http://user:pass@10.0.0.2:8080` 整串贴进「代理主机」，保存时会自动拆分协议、端口和认证信息。

## 安全模型

- 明文保存在 Host 的凭据存储 `$DSH_HOME/.credentials.yaml` 的 `records` 下，记录键为 `dsh-credential-vault/<id>`。该文件由 Harness 以仅当前系统用户可读的权限创建并原子写入，插件自己不另外复制一份。
- **列表、搜索、提示词概览都只有元数据**；设置页的明文只在点击 **显示** 时按字段单独取回。
- 工具结果会写入会话记录：`credential_get` 传 `reveal=true` 之后，明文会出现在本次会话日志里。可用 `allowAgentReveal: false` 关闭 agent 读取明文的能力（此时 `ssh_exec` 仍可正常使用，因为密码不离开 Host）。
- `ssh_exec` 使用系统 OpenSSH 客户端。密码认证通过一次性的 `SSH_ASKPASS` 助手完成（Windows 上用 .NET Framework 的 `csc.exe` 编译一次，缓存到 `$DSH_HOME/storages/dsh-credential-vault/askpass.exe`），密码通过进程环境传递，不出现在命令行里。私钥写入临时目录（仅本用户可读），命令结束后删除。
- `proxy_test` 在 Host 进程内直接建立隧道（HTTP/HTTPS 用 `CONNECT` 或绝对地址请求，SOCKS5/SOCKS4 按 RFC 1928 / RFC 1929 在 TCP socket 上握手），代理密码只用于握手头和认证报文，不会出现在工具参数、URL 参数或命令里；返回里只有代理地址（不含密码）、耗时、状态码和出口 IP。
- 浏览器侧通过 Harness Connection 的准入检查（Host/Origin 栅栏 + 签名会话 cookie）访问 Host 的 `/credential-vault` 路由，只有已认证的本机页面能调用；未认证请求返回 401。
- 页面本身不缓存响应（`cache-control: no-store`），凭据明文只在你点 **显示** 时按字段返回。

## 自检

Host 侧逻辑带一个不联网、不碰真实凭据文件的自检：

```powershell
cd dsh-credential-vault
node test/self-test.mjs   # Host：校验、工具、SSH、代理隧道
node test/rpc-test.mjs    # 设置页路由：准入、端点、代理测试接口
node test/client-test.mjs # 设置页 UI：代理卡片、测试按钮、编辑器
npm test                  # 三个一起跑
```

覆盖校验、掩码/明文、更新时保持/清除密钥、工具权限开关、SSH 参数与临时私钥清理、损坏记录忽略，以及代理（默认端口、粘贴地址自动拆分、HTTP 代理 / SOCKS5 认证 / SOCKS5h / SOCKS4 / SOCKS4a 经本地假代理端到端测试、认证失败与 CONNECT 失败的错误返回）等。自检完全离线：假代理和目标站点都在测试进程内启动，不会访问外网。

## 配置

`cordis.patch.yml` 里的行配置（也可以在 profile 的用户 patch 层覆盖）：

```yaml
- id: credential-vault
  name: dsh-credential-vault
  config:
    promptSummary: true      # 在系统提示词里追加凭据概览（只有元数据）
    maxPromptEntries: 12     # 概览最多列多少条
    allowAgentReveal: true   # 允许 credential_get reveal=true 返回明文
    allowAgentWrite: true    # 允许 credential_save 新建/更新
    sshTimeoutMs: 60000      # ssh_exec 默认超时
    proxyTimeoutMs: 15000    # proxy_test 默认超时
    proxyTestUrl: https://api.ipify.org?format=json   # proxy_test 默认访问的目标
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 设置里没有「凭据管家」 | 插件页确认 `dsh-credential-vault` 已启用；切换页面或刷新一次 |
| 工具列表里没有 `credential_*` | 工具随插件行挂载，检查插件是否 active；新开会话生效 |
| `ssh_exec` 报 `ssh-unsupported` | 系统缺少 `csc.exe`，无法生成密码认证助手：改用密钥登录，或把公钥配到服务器 |
| `ssh_exec` 首次连接慢 / 主机校验 | 使用 `StrictHostKeyChecking=accept-new`，首次连接会写入 known_hosts |
| 密码认证失败 | 确认服务器允许 password 认证（`PasswordAuthentication yes`），密钥登录则确认私钥与服务器 `authorized_keys` 匹配 |
| 代理测试报 `连接代理 … 失败` | 代理没启动、端口不对或被防火墙拦住；先确认 `host:port` 从本机可达 |
| 代理测试报 `认证` | 用户名或密码不对，且 SOCKS5 代理要允许用户名密码认证方式 |
| 代理测试报 `TLS` | 到目标站点的 TLS 握手失败：测试 URL 不可达、证书不被信任或系统时间不准 |
| 代理测试成功但实际访问失败 | 代理只放行了部分端口/域名；内网域名解析不到本机时可改用 `socks5h` / `socks4a` |

## 结构

```text
dsh-credential-vault/
  package.json        # bundle patch + dsh.client 声明
  cordis.patch.yml    # 插入 credential-vault 行
  index.js            # Host 入口：Vault + 工具 + Settings 路由 + 提示词段
  src/vault.js        # 校验、凭据记录读写、掩码与概览
  src/tools.js        # credential_list / get / save / ssh_exec / proxy_test
  src/rpc.js          # 浏览器 ⇄ Host 的 /credential-vault 路由（含准入检查）
  src/ssh.js          # OpenSSH 调用与 askpass 助手
  src/proxy.js        # HTTP CONNECT / SOCKS5 / SOCKS4 隧道与连通性测试
  client.js           # 设置页 UI（React，无构建）
  locale/*.json       # 插件展示元信息
  test/self-test.mjs   # Host 侧自检（含假代理端到端）
  test/rpc-test.mjs    # /credential-vault 路由自检
  test/client-test.mjs # 设置页 UI 自检（最小 React 垫片）
  icon.svg
```
