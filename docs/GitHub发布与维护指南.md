# GitHub 发布与维护指南

本仓库的发布 / 维护速查。适用本机已配置**账号级 SSH 密钥**与 **gh CLI** 的环境。

---

## 1. 账号级 SSH 密钥（一次配置，所有仓库通用）

生成（ed25519，无密码，适合自动化推送）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_global -N "" -C "han-global-github-key"
```

`~/.ssh/config` 登记（直连 `github.com` 默认走这把钥匙）：

```
Host github.com
  HostName github.com
  IdentityFile ~/.ssh/github_global
  IdentitiesOnly yes
```

网页登记公钥：GitHub → 头像 → Settings → **Access** → **SSH and GPG keys** → New SSH key →
Key type 选 **Authentication Key** → 粘贴 `~/.ssh/github_global.pub` 全文 → Add key。

验证：

```bash
ssh -T git@github.com   # 应返回 Hi hex91! You've successfully authenticated ...
```

> 注意：SSH 密钥只能做 git 读写（clone / push / pull），**不能建 / 删 / 改名仓库**——
> 那属于仓库管理动作，必须走 gh CLI 或 classic PAT（见第 3、4 节）。

---

## 2. 仓库级独立部署密钥（可选，CI 用）

只想让单个仓库用一把专用密钥（例如 apk-info-tool 的自动推送）时：

1. 生成独立密钥 `ssh-keygen -t ed25519 -f ~/.ssh/<名字> -N ""`
2. 仓库 → Settings → **Deploy keys** → Add deploy key → **勾选 Allow write access**
3. `~/.ssh/config` 加一条 `Host <别名>` 指向该密钥（如本机已有的 `github-apk`）

---

## 3. gh CLI 安装与登录

- 安装：`winget install GitHub.cli`（或官网下载），装完**新开终端**生效
- 登录（浏览器授权，一次性）：

  ```bash
  gh auth login
  # 选 GitHub.com → Login with a web browser → 浏览器点 Authorize → Git protocol 选 SSH
  ```

- 验证：`gh auth status`（应显示 `Logged in to github.com account hex91`）

> 本机 gh 路径：`C:\Program Files\GitHub CLI\gh.exe`（若终端找不到 `gh` 命令，用完整路径调用）。

---

## 4. 常见 git 操作

```bash
git clone git@github.com:hex91/frida-persistent-module.git
git add -A && git commit -m "描述" && git push origin main
git pull origin main
```

仓库管理（需 gh，SSH 做不了）：

```bash
gh repo create frida-persistent-module --private        # 新建仓库
gh repo rename new-name --repo hex91/old-name           # 改名
# 删除仓库：仓库页 Settings → Delete（gh 默认无删库权限，建议网页操作）
```

---

## 5. 发布 Release（上传成品）

成品 zip 位于 `dist/frida_patched_server-17.5.2-android16.zip`。

```bash
gh release create v1.0.0 \
  "dist/frida_patched_server-17.5.2-android16.zip" \
  --repo hex91/frida-persistent-module \
  --title "frida-persistent-module v3 (frida-server 17.5.2-android16)" \
  --notes "KernelSU/Magisk 持久化模块：sijan2 补丁版 frida-server 17.5.2-android16，支持自定义端口与进程名。安装见 docs/frida持久化模块使用文档.md"
```

发布后到仓库 **Releases** 页面即可下载。要追加多个文件，在命令后继续跟路径即可。

---

## 6. 安全提示

- 全局 SSH 私钥 `~/.ssh/github_global` 等同账号完全访问权，**勿外泄**；
  一旦泄露，立即去 SSH and GPG keys 页面删除作废。
- classic PAT（含 `delete_repo`）权限更大，用完即删。
- 部署密钥（Deploy keys）仅对单个仓库有效，泄露影响面小，适合 CI 机器人。
