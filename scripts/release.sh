#!/usr/bin/env bash

# 发布脚本：验证源码、构建 VSIX/TGZ、生成 SHA-256，并创建公开 GitHub Release。
set -euo pipefail

readonly REPOSITORY="pinyinjj/anti-quota-fork-staging"
readonly FORBIDDEN_GIT_OBJECTS=(
    "14fde1882c57e90b10761c3c67c838e9da20f434"
    "735d95ab4262678a707b51b428c9d0c52fa2e174"
    "59c4a2b96eb3f9ae289d3c1b292b37a91f7540bb"
    "4f9a1ddae140187670e998116e2f119597cc5b77"
    "c00cd1eb32dc724265b99b920e6316b4445d81c8"
)

fail() {
    printf '❌ %s\n' "$*" >&2
    exit 1
}

for required_command in git node npm npx gh curl; do
    command -v "$required_command" >/dev/null 2>&1 \
        || fail "缺少必需命令：$required_command"
done

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/.." && pwd)"
cd "$REPOSITORY_ROOT"

PACKAGE_NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
[[ "$PACKAGE_NAME" == "anti-quota" ]] || fail "package.json 的包名不是 anti-quota"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "Release 只允许稳定 SemVer 版本，当前为：$VERSION"

readonly TAG="v$VERSION"
readonly VSIX_FILE="anti-quota-$VERSION.vsix"
readonly TGZ_FILE="anti-quota-$VERSION.tgz"
readonly VSIX_SHA256_FILE="$VSIX_FILE.sha256"
readonly TGZ_SHA256_FILE="$TGZ_FILE.sha256"
readonly EXPECTED_RELEASE_ASSETS=(
    "$VSIX_FILE"
    "$VSIX_SHA256_FILE"
    "$TGZ_FILE"
    "$TGZ_SHA256_FILE"
)

RELEASE_VERIFY_DIRECTORIES=()
cleanup_release_verify_directories() {
    local directory
    for directory in "${RELEASE_VERIFY_DIRECTORIES[@]}"; do
        [[ -d "$directory" ]] || continue
        case "$(basename -- "$directory")" in
            anti-quota-release.*) rm -rf -- "$directory" ;;
        esac
    done
}
trap cleanup_release_verify_directories EXIT

release_notes() {
    cat <<EOF
## $VERSION 变更

- 重新打包发布 VS Code 扩展（VSIX）、独立 CLI（TGZ）及各自的 SHA-256 校验文件。
- 完善 Windows PowerShell / CMD 安装命令与本机 Google OAuth 配置说明。
- 补齐更新流程回归测试的服务身份夹具，避免测试读取本机正在运行的服务；生产保护逻辑不变。
- 安装包仍不内置 OAuth 客户端参数，不包含个人配置，也不自动迁移旧版参数。
- 已配置用户升级时保留本机配置与账号数据；新电脑或缺少配置时仍须单独完成下方配置。

本版未把任何本机 OAuth 配置恢复操作打入安装包。仓库继续保留 GitHub Fork 来源关联，
默认分支使用清理后的独立提交历史。

## Google OAuth 配置（升级前阅读）

在 \`%USERPROFILE%\\.anti-quota\\oauth-client.json\` 中保存以下 JSON，并替换占位符：

\`\`\`json
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
\`\`\`

也支持 Google 下载的 \`{"installed":{"client_id":"YOUR_CLIENT_ID","client_secret":"YOUR_CLIENT_SECRET"}}\` 格式。
文件与 \`accounts.json\` 同目录；设置 \`ANTI_QUOTA_DATA_DIR\` 时使用该数据目录。
同一用户的 CLI 后台服务和 VS Code 扩展共享此文件，每次 OAuth 操作重新读取。
升级不会覆盖已有 \`oauth-client.json\`；已配置用户无需重复填写，
但仅看到已绑定账号和缓存额度不代表 Token 刷新或账号切换可用。

也可同时设置 \`ANTI_QUOTA_GOOGLE_CLIENT_ID\` 和 \`ANTI_QUOTA_GOOGLE_CLIENT_SECRET\`
环境变量；必须成对且优先于文件，仅设置一个会报错。变量必须对实际执行请求的
服务或 VS Code 进程可见；后台服务建议使用共享文件。

缺少有效配置时，绑定和 Token 刷新会失败；程序没有内置回退，也不会复制旧版参数。
已有 refresh token 必须使用原签发 OAuth 客户端；换客户端需重新授权。
自行注册客户端不保证拥有 Antigravity 所需的 scopes 或 API 权限。
请勿共享或提交本机配置与账号凭据。

## 安装方式

### VS Code / Antigravity 扩展

下载 \`$VSIX_FILE\`，在 **PowerShell** 中运行：

\`\`\`powershell
code --install-extension "\$env:USERPROFILE\\Downloads\\$VSIX_FILE" --force
\`\`\`

如果使用 **CMD（命令提示符）**，改用：

\`\`\`bat
code --install-extension "%USERPROFILE%\\Downloads\\$VSIX_FILE" --force
\`\`\`

### CLI 与后台服务

下载 \`$TGZ_FILE\`，在 **PowerShell** 中运行：

\`\`\`powershell
npm install -g "\$env:USERPROFILE\\Downloads\\$TGZ_FILE"
& "\$env:APPDATA\\npm\\anti-quota.cmd" service install
\`\`\`

如果使用 **CMD（命令提示符）**，改用：

\`\`\`bat
npm install -g "%USERPROFILE%\\Downloads\\$TGZ_FILE"
"%APPDATA%\\npm\\anti-quota.cmd" service install
\`\`\`

第二条命令会请求管理员授权，安装真正的 Windows 系统服务。发布包已包含原生宿主。
请勿混用两种 shell 的环境变量写法；PowerShell 执行引号内的命令路径需要前面的 \`&\`。

两个安装包均附带对应的 \`.sha256\` 校验文件。CLI 自动更新只更新 CLI/后台服务，
不会自动安装 VSIX。VSIX 为兼容现有安装保留 \`fhyfhy17.anti-quota\` 扩展 ID，
但本仓库是非官方社区发行版。

可在 PowerShell 中手工核对下载文件：

\`\`\`powershell
Get-FileHash "\$env:USERPROFILE\\Downloads\\$VSIX_FILE" -Algorithm SHA256
Get-FileHash "\$env:USERPROFILE\\Downloads\\$TGZ_FILE" -Algorithm SHA256
\`\`\`
EOF
}
readonly RELEASE_NOTES="$(release_notes)"

remote_tag_commit() {
    git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}" \
        | awk -v direct_ref="refs/tags/$TAG" -v peeled_ref="refs/tags/$TAG^{}" '
            $2 == direct_ref { direct_hash = $1 }
            $2 == peeled_ref { peeled_hash = $1 }
            END {
                if (peeled_hash != "") print peeled_hash
                else if (direct_hash != "") print direct_hash
            }
        '
}

remote_annotated_tag_commit() {
    git ls-remote --tags origin "refs/tags/$TAG^{}" \
        | awk -v peeled_ref="refs/tags/$TAG^{}" '$2 == peeled_ref { print $1 }'
}

release_state() {
    local releases_json
    releases_json="$(gh release list \
        --repo "$REPOSITORY" \
        --limit 100 \
        --json tagName,isDraft,isImmutable,isPrerelease)" \
        || return 1
    node -e '
        const releases = JSON.parse(process.argv[1]);
        const tag = process.argv[2];
        const release = releases.find(candidate => candidate.tagName === tag);
        process.stdout.write(release
            ? (release.isPrerelease
                ? "prerelease"
                : (release.isDraft ? "draft" : (release.isImmutable ? "published-immutable" : "published")))
            : "missing");
    ' "$releases_json" "$TAG"
}

verify_authenticated_release_assets() {
    local release_json
    release_json="$(gh release view "$TAG" --repo "$REPOSITORY" --json assets)" \
        || return 1
    node -e '
        const release = JSON.parse(process.argv[1]);
        const expected = process.argv.slice(2).sort();
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const actual = assets.map(asset => asset.name).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            console.error(`Release 资产集合不正确。期望：${expected.join(", ")}；实际：${actual.join(", ") || "无"}`);
            process.exit(1);
        }
        if (assets.some(asset => !Number.isSafeInteger(asset.size) || asset.size <= 0)) {
            console.error("Release 中存在空文件或大小无效的资产。");
            process.exit(1);
        }
    ' "$release_json" "${EXPECTED_RELEASE_ASSETS[@]}"
}

verify_public_release() {
    local compare_local="$1"
    local verify_directory
    local metadata_file
    local asset
    verify_directory="$(mktemp -d "${TMPDIR:-/tmp}/anti-quota-release.XXXXXX")" \
        || return 1
    RELEASE_VERIFY_DIRECTORIES+=("$verify_directory")
    metadata_file="$verify_directory/release.json"

    curl \
        --disable \
        --fail \
        --location \
        --silent \
        --show-error \
        --proto '=https' \
        --proto-redir '=https' \
        --connect-timeout 15 \
        --max-time 120 \
        --max-filesize 4194304 \
        --user-agent "anti-quota-release/$VERSION" \
        --header 'Accept: application/vnd.github+json' \
        --output "$metadata_file" \
        "https://api.github.com/repos/$REPOSITORY/releases/tags/$TAG" \
        || return 1

    node - "$metadata_file" "$TAG" "${EXPECTED_RELEASE_ASSETS[@]}" <<'NODE' \
        || return 1
const fs = require('fs');
const [metadataFile, expectedTag, ...expectedNames] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
if (release.tag_name !== expectedTag || release.draft || release.prerelease) {
    throw new Error('公开 Release 的 tag、草稿或预发布状态不正确');
}
const assets = Array.isArray(release.assets) ? release.assets : [];
const actualNames = assets.map(asset => asset.name).sort();
const sortedExpectedNames = [...expectedNames].sort();
if (JSON.stringify(actualNames) !== JSON.stringify(sortedExpectedNames)) {
    throw new Error(`公开 Release 资产数量或名称不正确：${actualNames.join(', ') || '无'}`);
}
for (const asset of assets) {
    const maximumSize = asset.name.endsWith('.sha256') ? 4096 : 64 * 1024 * 1024;
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximumSize) {
        throw new Error(`公开 Release 资产大小不安全：${asset.name}`);
    }
}
NODE

    for asset in "${EXPECTED_RELEASE_ASSETS[@]}"; do
        curl \
            --disable \
            --fail \
            --location \
            --silent \
            --show-error \
            --proto '=https' \
            --proto-redir '=https' \
            --connect-timeout 15 \
            --max-time 180 \
            --max-filesize 67108864 \
            --user-agent "anti-quota-release/$VERSION" \
            --output "$verify_directory/$asset" \
            "https://github.com/$REPOSITORY/releases/download/$TAG/$asset" \
            || return 1
    done

    node - \
        "$metadata_file" \
        "$verify_directory" \
        "$compare_local" \
        "$VSIX_FILE" \
        "$VSIX_SHA256_FILE" \
        "$TGZ_FILE" \
        "$TGZ_SHA256_FILE" <<'NODE' \
        || return 1
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [
    metadataFile,
    downloadDirectory,
    compareLocal,
    vsixFile,
    vsixChecksumFile,
    tgzFile,
    tgzChecksumFile,
] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
const assetsByName = new Map(release.assets.map(asset => [asset.name, asset]));

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

for (const [packageFile, checksumFile] of [
    [vsixFile, vsixChecksumFile],
    [tgzFile, tgzChecksumFile],
]) {
    const packageName = path.basename(packageFile);
    const checksumName = path.basename(checksumFile);
    const downloadedPackage = path.join(downloadDirectory, packageName);
    const downloadedChecksum = path.join(downloadDirectory, checksumName);
    const checksumText = fs.readFileSync(downloadedChecksum, 'utf8');
    const checksumMatch = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/.exec(checksumText);
    if (!checksumMatch || checksumMatch[2] !== packageName) {
        throw new Error(`SHA-256 文件格式或目标名称不正确：${checksumName}`);
    }
    const downloadedDigest = digest(downloadedPackage);
    if (checksumMatch[1] !== downloadedDigest) {
        throw new Error(`公开下载的 SHA-256 不匹配：${packageName}`);
    }
    if (fs.statSync(downloadedPackage).size !== assetsByName.get(packageName).size
        || fs.statSync(downloadedChecksum).size !== assetsByName.get(checksumName).size) {
        throw new Error(`公开下载大小与 GitHub 元数据不一致：${packageName}`);
    }
    if (compareLocal === 'true') {
        if (downloadedDigest !== digest(packageFile)) {
            throw new Error(`公开下载内容与本地发布产物不一致：${packageName}`);
        }
        if (checksumText !== fs.readFileSync(checksumFile, 'utf8')) {
            throw new Error(`公开下载校验文件与本地发布产物不一致：${checksumName}`);
        }
    }
}
console.log('匿名下载校验通过：4 个资产的名称、数量和 SHA-256 均正确。');
NODE

    node tests/archive-privacy-regression.js \
        "$verify_directory/$VSIX_FILE" \
        "$verify_directory/$TGZ_FILE" \
        || return 1
}

upload_release_assets() {
    if ! gh release upload "$TAG" \
        "${EXPECTED_RELEASE_ASSETS[@]}" \
        --repo "$REPOSITORY" \
        --clobber; then
        fail "Release 资产上传未完成；当前 Tag/Release 状态已保留，重新运行脚本即可安全重试"
    fi
}

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN_URL" in
    https://github.com/pinyinjj/anti-quota-fork-staging|\
    https://github.com/pinyinjj/anti-quota-fork-staging.git|\
    git@github.com:pinyinjj/anti-quota-fork-staging.git|\
    ssh://git@github.com/pinyinjj/anti-quota-fork-staging.git)
        ;;
    *)
        fail "origin 必须指向 $REPOSITORY，当前为：${ORIGIN_URL:-未配置}"
        ;;
esac

[[ -z "$(git status --porcelain --untracked-files=normal)" ]] \
    || fail "工作区存在未提交改动，请先提交后再发布"

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD)" \
    || fail "当前为 detached HEAD，无法安全发布"
[[ "$CURRENT_BRANCH" == "master" ]] \
    || fail "Release 只允许从 master 分支发布，当前为：$CURRENT_BRANCH"
HEAD_COMMIT="$(git rev-parse HEAD)"
ROOT_COMMIT_COUNT="$(git rev-list --max-parents=0 --all | awk 'END { print NR }')"
[[ "$ROOT_COMMIT_COUNT" == "1" ]] \
    || fail "本地所有 refs 必须使用同一个清理后的根提交，不能导入旧 Git 历史"
for forbidden_object in "${FORBIDDEN_GIT_OBJECTS[@]}"; do
    if git cat-file -e "$forbidden_object" 2>/dev/null; then
        fail "检测到清理前的历史或诊断对象 $forbidden_object；发布仓库必须保留清理后的独立提交历史"
    fi
done
REMOTE_COMMIT="$(git ls-remote --heads origin "refs/heads/$CURRENT_BRANCH" | awk '{print $1}')"
[[ "$REMOTE_COMMIT" == "$HEAD_COMMIT" ]] \
    || fail "origin/$CURRENT_BRANCH 尚未包含当前提交，请先推送代码"

PUBLIC_REPOSITORY_JSON="$(gh api "repos/$REPOSITORY")" \
    || fail "无法读取公开仓库状态"
node -e '
    const publicRepository = JSON.parse(process.argv[1]);
    if (publicRepository.full_name.toLowerCase() !== "pinyinjj/anti-quota-fork-staging"
        || publicRepository.private !== false
        || publicRepository.fork !== true
        || publicRepository.parent?.full_name.toLowerCase() !== "fhyfhy17/anti-quota"
        || publicRepository.archived !== false) {
        throw new Error("公开仓库必须为指定上游的未归档公开 fork");
    }
' "$PUBLIC_REPOSITORY_JSON" \
    || fail "GitHub 仓库来源或发行状态不符合要求"

printf '🚀 发布 Anti Quota v%s...\n' "$VERSION"
printf '📥 按 package-lock.json 安装依赖（禁用生命周期脚本）...\n'
npm ci --ignore-scripts

printf '🔧 构建 Windows SCM 原生宿主...\n'
command -v powershell.exe >/dev/null 2>&1 \
    || fail "Windows 服务发行包必须在安装了 .NET Framework 的 Windows 上构建"
npm run build:windows-service

printf '🧪 运行测试...\n'
npm test

readonly OUTPUT_DIRECTORY="$REPOSITORY_ROOT/out"
[[ "$OUTPUT_DIRECTORY" == "$REPOSITORY_ROOT/out" ]] \
    || fail "构建输出目录校验失败，已拒绝清理"

printf '🧹 清理并重建 out/ 与本版本发布产物...\n'
rm -rf -- "$OUTPUT_DIRECTORY"
mkdir -p -- "$OUTPUT_DIRECTORY"
rm -f -- \
    "$VSIX_FILE" \
    "$TGZ_FILE" \
    "$VSIX_SHA256_FILE" \
    "$TGZ_SHA256_FILE"

printf '📦 从干净的 out/ 编译并打包 VSIX...\n'
npm run compile
npx --no-install vsce package --out "$VSIX_FILE"

printf '📦 打包 CLI...\n'
npm pack --silent >/dev/null

[[ -s "$VSIX_FILE" ]] || fail "找不到或生成了空文件：$VSIX_FILE"
[[ -s "$TGZ_FILE" ]] || fail "找不到或生成了空文件：$TGZ_FILE"

write_sha256() {
    local source_file="$1"
    local checksum_file="$2"
    node -e '
        const crypto = require("crypto");
        const fs = require("fs");
        const path = require("path");
        const file = process.argv[1];
        const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        process.stdout.write(`${digest}  ${path.basename(file)}\n`);
    ' "$source_file" > "$checksum_file"
}

printf '🔐 生成 SHA-256 校验文件...\n'
write_sha256 "$VSIX_FILE" "$VSIX_SHA256_FILE"
write_sha256 "$TGZ_FILE" "$TGZ_SHA256_FILE"
[[ -s "$VSIX_SHA256_FILE" ]] || fail "生成校验文件失败：$VSIX_SHA256_FILE"
[[ -s "$TGZ_SHA256_FILE" ]] || fail "生成校验文件失败：$TGZ_SHA256_FILE"

printf '🔍 扫描实际 VSIX/TGZ 发布归档中的隐私与敏感信息...\n'
node tests/archive-privacy-regression.js "$VSIX_FILE" "$TGZ_FILE"

REMOTE_TAG_COMMIT="$(remote_tag_commit)"
if git show-ref --verify --quiet "refs/tags/$TAG"; then
    TAG_COMMIT="$(git rev-list -n 1 "$TAG")"
    [[ "$TAG_COMMIT" == "$HEAD_COMMIT" ]] \
        || fail "本地 Tag $TAG 指向其他提交，已拒绝发布"
elif [[ -n "$REMOTE_TAG_COMMIT" ]]; then
    [[ "$REMOTE_TAG_COMMIT" == "$HEAD_COMMIT" ]] \
        || fail "远端 Tag $TAG 指向其他提交，已拒绝发布"
    [[ "$(remote_annotated_tag_commit)" == "$HEAD_COMMIT" ]] \
        || fail "远端 Tag $TAG 必须是指向当前提交的 annotated tag"
    printf '🏷️  远端 Tag %s 已核验，仅创建本地注解，不拉取历史...\n' "$TAG"
    git tag -a "$TAG" -m "Release $TAG"
else
    printf '🏷️  创建 Tag %s...\n' "$TAG"
    git tag -a "$TAG" -m "Release $TAG"
fi

[[ "$(git cat-file -t "$TAG")" == "tag" ]] \
    || fail "$TAG 必须是 annotated tag，已拒绝发布"

if [[ -z "$REMOTE_TAG_COMMIT" ]]; then
    if ! git push origin "refs/tags/$TAG"; then
        fail "Tag 推送未确认完成；可直接重新运行脚本，脚本会核对远端 Tag 后继续"
    fi
fi
REMOTE_TAG_COMMIT="$(remote_tag_commit)"
[[ "$REMOTE_TAG_COMMIT" == "$HEAD_COMMIT" ]] \
    || fail "远端 Tag $TAG 未指向当前提交，已拒绝创建 Release"
REMOTE_ANNOTATED_TAG_COMMIT="$(remote_annotated_tag_commit)"
[[ "$REMOTE_ANNOTATED_TAG_COMMIT" == "$HEAD_COMMIT" ]] \
    || fail "远端 Tag $TAG 不是指向当前提交的 annotated tag，已拒绝创建 Release"

RELEASE_STATE="$(release_state)" \
    || fail "无法确认 GitHub Release 状态，已拒绝继续"

case "$RELEASE_STATE" in
    missing)
        printf '📤 创建草稿 Release；上传中断后可直接重新运行脚本...\n'
        gh release create "$TAG" \
            --repo "$REPOSITORY" \
            --verify-tag \
            --draft \
            --title "Anti Quota $TAG" \
            --notes "$RELEASE_NOTES"
        RELEASE_STATE="draft"
        ;;
    draft)
        printf '♻️  发现已有草稿 Release，将继续上次未完成的上传...\n'
        gh release edit "$TAG" \
            --repo "$REPOSITORY" \
            --title "Anti Quota $TAG" \
            --notes "$RELEASE_NOTES"
        ;;
    published)
        printf '🔎 发现已发布的 Release，仅执行匿名验证，不自动覆盖公开资产...\n'
        verify_public_release false \
            || fail "已发布 Release 无法通过匿名完整性/隐私验证；可能是网络暂态错误，也可能是资产异常。为避免误覆盖公开资产，脚本不会自动改写，请排除网络问题后重试或提升版本重新发布"
        printf '✅ 已发布资产完整，无需覆盖上传。\n'
        ;;
    published-immutable)
        printf '🔎 发现不可变的已发布 Release，仅执行匿名验证...\n'
        verify_public_release false \
            || fail "不可变 Release 的匿名校验失败，资产无法覆盖；请先确认网络，确有损坏时提升版本重新发布"
        printf '✅ 不可变 Release 的四个资产完整，无需上传。\n'
        ;;
    *)
        fail "未知 Release 状态：$RELEASE_STATE"
        ;;
esac

if [[ "$RELEASE_STATE" == "draft" ]]; then
    printf '📦 上传四个 Release 资产...\n'
    upload_release_assets
    verify_authenticated_release_assets \
        || fail "草稿 Release 的资产名称、数量或大小不正确；草稿已保留，请清理后重试"
    printf '🌐 发布已完整上传的草稿 Release...\n'
    gh release edit "$TAG" --repo "$REPOSITORY" --draft=false
    verify_public_release true \
        || fail "发布后的匿名下载校验失败；可重新运行脚本继续验证或修复"
fi

printf '✅ 发布完成！\n'
printf '🔗 https://github.com/%s/releases/tag/%s\n' "$REPOSITORY" "$TAG"
